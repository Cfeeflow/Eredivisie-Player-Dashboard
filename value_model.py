"""Value rating: which outfield players perform like they're worth more than their market value?

Usage: python value_model.py [--source transfermarkt]
Reads raw/<league>/matches_*.csv (history seasons for last-season features only) and the player pages in
raw/players/, writes data/ratings.js and prints the model checks.

How it works
1. One row per player per season (all seasons pooled), outfield players with enough minutes. Per-90 stats and
   rating are shrunk towards the role average, more so for players with fewer minutes.
2. Predict log(market value) from performance and context. Every prediction is out-of-fold: the model that
   predicts a player never saw any of his seasons (folds are split by player, repeated with different splits).
3. A linear (ridge) model, a random forest and gradient boosting are compared on the same features. A tree
   model only replaces the linear one when it is clearly better by out-of-fold R². The chosen model gets a
   linear calibration so predictions aren't compressed towards the average price.
4. Gap = expected value / actual value. A: gap >= 2, B: gap >= 1.25; both also need a FotMob rating at or
   above the median for his role and age 27 or younger. C: the rest. Set with a backtest: these grades are the
   ones that predicted a player's value rising in the year after the season.
5. Reasons: each feature is set to the role median and the change in expected value is that feature's effect.
6. Checks: the backtest, a forward test (train on earlier seasons only) and a growth model that predicts the
   value change directly, compared with a baseline of age and gap.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import RidgeCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from build_data import role  # same formation-slot -> role mapping as the dashboard, so positions agree

HERE = Path(__file__).parent
OUT = HERE / "data" / "ratings.js"
CONFIG = json.loads((HERE / "leagues.json").read_text(encoding="utf-8"))
LEAGUE = CONFIG["dashboard_league"]  # one model per league; for now the dashboard's league
RAW = HERE / "raw"

# ---------- settings ----------

# Grades, set with the backtest (does a grade predict the player's value rising the next season?):
# - A gap only means something for players rated at or above the median for their position; below it, players
#   with a gap of 1.25 or more rose as often as a C (31%).
# - Age is decisive: good players with a gap rose in 58-59% of cases up to 27, but only 21% after 27. An older
#   player's low price reflects the few seasons he has left, so the market is right.
# - Gap size: A needs ×2, B ×1.25.
# These were chosen on the backtest itself, so its numbers flatter them. rule_check() is the honest version:
# rules chosen on one season, tested on the other. There, A rose 72% (n=18) and B 50% (n=34), against 45% for
# everyone passing the age and rating filters: A adds a lot, B a little.
A_GAP, B_GAP = 2.0, 1.25
MAX_AGE = 27
MIN_PCT = 50  # FotMob rating percentile within his role and season
# Rule options tried by rule_check(): for each season with a known outcome, the best rules on the other seasons
# are chosen from these and applied to that season, so the reported result is out-of-sample.
RULE_GRID = {"b_gap": [1.1, 1.25, 1.5], "max_age": [23, 25, 27, 29, 99], "min_pct": [0, 50], "a_gap": [1.5, 2.0, 2.5, 3.0]}
# Market value source: "scisports" (FotMob's player pages, scrape.py) or "transfermarkt" (transfermarkt.py).
# Can be overridden on the command line: python value_model.py --source transfermarkt
# SciSports, because its gap predicts the later value change: backtest correlation +0.16, against +0.05 with
# Transfermarkt (whose values follow transfers that have happened and change only twice a year), although
# Transfermarkt prices are explained slightly better (R² 0.86 vs 0.83).
VALUE_SOURCE = "scisports"
# The value nearest to the season's last match is used, if one exists within this many days. SciSports values
# are monthly in recent years; Transfermarkt updates a league about twice a year (around December and May), and
# for the season in progress its latest value is the one from the summer.
VALUE_WINDOW_DAYS = {"scisports": 45, "transfermarkt": 180}
# Only when a player has no value history: the lineup values from the matches, and then at least this many,
# because FotMob stores none for many matches before 2025-26
MIN_VALUE_OBS = 3
# The backtest and the growth model look at the value this many days after the season's end
HORIZON_DAYS = 365
# Tree models can't extrapolate beyond the prices they have seen, so they only replace the linear model when
# their out-of-fold R² is at least this much higher. Smaller differences are within noise between runs.
TREE_MARGIN = 0.02
# Shrinkage weight in minutes: a player's own per-90 numbers count for minutes / (minutes + 450), the rest comes
# from the role average. 450 gave the best out-of-fold R² of the weights tested (0, 450, 900, 1800, 3600).
SHRINK_MINUTES = 450
# Features that are averages over matches and therefore noisy for players with few minutes
SHRUNK = ["rating", "npxg90", "xa90", "final3rd90", "dribbles90", "def90", "aerials90", "passes90", "pass_pct",
          "touches90", "dispossessed90", "fouled90", "recoveries90", "longballs90"]
# Candidate features, tested with feature_test.py against the backtest; only those that helped are in FEATURES.
# Tested November 2026: none changed the backtest correlation by more than 0.003, overall or for central
# midfielders, so none was added. What makes a midfielder valuable (positioning, press resistance) isn't in
# FotMob's stats.
CANDIDATES = {
    "touches90": "Touches per 90",
    "dispossessed90": "Times dispossessed per 90",
    "fouled90": "Fouls won per 90",
    "recoveries90": "Recoveries per 90",
    "longballs90": "Accurate long balls per 90",
    "caps_before": "International caps before this season",
    "height": "Height",
    # Playing time was a feature until November 2026. It explains prices (the market pays for regulars) but says
    # how much a player plays, not how well. Without it, R² fell from 0.83 to 0.81, but out-of-sample A picks
    # rose 72% instead of 65% and B 50% instead of 38%, with the gap's link to the later change unchanged.
    "min_share": "Share of minutes played",
    "prev_min_share": "Last season's share of minutes",
}
# Cross-validation: 5 folds, repeated 5 times with different random splits, predictions averaged.
# Repeating smooths out the luck of any single split.
REPEATS, FOLDS = 5, 5
ROLES = ["CB", "FB", "CM", "AM", "W", "ST"]
USUAL_ROLE = {1: "CB", 2: "CM", 3: "ST"}  # FotMob's broad position, for players who never started a match

# Model features: name -> label shown in the reasons. Role and season dummies are added in design().
# Kept short on purpose: with under 1,000 rows, every extra feature adds noise to the estimates.
FEATURES = {
    "age": "Age",                                       # the biggest single driver of market value
    "team_ppg": "Team points per game",                 # players at successful clubs carry a premium
    "rating": "FotMob rating",                          # FotMob's overall match rating, averaged
    "npxg90": "Non-penalty xG per 90",                  # scoring threat, without penalties (which depend on role)
    "xa90": "xA per 90",                                # chance creation
    "final3rd90": "Passes into final third per 90",     # ball progression by passing
    "dribbles90": "Successful dribbles per 90",         # ball progression by carrying
    "def90": "Tackles + interceptions per 90",          # ball winning
    "aerials90": "Aerial duels won per 90",
    "passes90": "Accurate passes per 90",               # involvement
    "pass_pct": "Pass accuracy",
    "dutch": "Dutch nationality",                       # homegrown players are priced differently
    "team_value": "Teammates' average market value",    # club reputation beyond results
    "prev_rating": "Last season's FotMob rating",       # market value reflects a track record, not one season
    "has_prev": "Played in the Eredivisie last season",
}
# Context features: shown in the reasons, but they say nothing about how well he plays, so the one-line
# summary ("High npxG and xA for a winger") never uses them
CONTEXT = {"age", "team_ppg", "dutch", "team_value", "has_prev"}


# ---------- data ----------

def load_matches():
    """All match rows of the league. History seasons (leagues.json) only supply last-season features; they aren't graded."""
    league = CONFIG["leagues"][LEAGUE]
    files = [RAW / LEAGUE / f"matches_{s}.csv" for s in league["history"] + league["seasons"]]
    df = pd.concat([pd.read_csv(f, low_memory=False) for f in files if f.exists()], ignore_index=True)
    history = set(league["history"])
    df = df[df["Minutes played"].fillna(0) > 0].copy()  # unused substitutes have a row but no minutes
    df = df.sort_values(["date", "match_id"])            # chronological, so .iloc[-1] is the latest value
    df["role"] = [role(p, f) for p, f in zip(df["position_id"], df["formation"])]
    return df, history


def team_points(df):
    """Points per game per (season, team), from the goals each team's keepers conceded.

    The score column can't be used directly: it uses different team names ('NEC Nijmegen' vs 'N.E.C.').
    """
    conceded = df[df["goalkeeper"]].groupby(["season", "match_id", "team"])["Goals conceded"].sum().reset_index()
    pts = []
    for (season, match_id), g in conceded.groupby(["season", "match_id"]):
        if len(g) != 2:  # a keeper row missing for one side: skip the match rather than guess
            continue
        (t1, c1), (t2, c2) = g[["team", "Goals conceded"]].values
        # A team's goals are what the other team's keeper conceded
        p1 = 3 if c2 > c1 else 1 if c1 == c2 else 0
        p2 = 3 if c1 > c2 else 1 if c1 == c2 else 0
        pts += [(season, t1, p1), (season, t2, p2)]
    pts = pd.DataFrame(pts, columns=["season", "team", "pts"])
    return pts.groupby(["season", "team"]).agg(team_ppg=("pts", "mean"), team_games=("pts", "size"))


def player_seasons(df, history=()):
    """One row per outfield player per season with all model features, filtered to the rows we can grade."""
    ppg = team_points(df)
    rows = []
    for (season, pid), g in df.groupby(["season", "player_id"]):
        if g["goalkeeper"].mean() > 0.5:  # keepers: too few to train a model on
            continue
        values = g["market_value"].dropna()
        minutes = g["Minutes played"].sum()
        team = g.groupby("team")["Minutes played"].sum().idxmax()  # after a transfer: the club he played most for
        # Role = the formation slot he played most minutes in; bench-only players fall back to the broad position
        roles = g[g["role"] != ""].groupby("role")["Minutes played"].sum()
        usual = g["usual_position"].dropna()
        r = roles.idxmax() if len(roles) else USUAL_ROLE.get(int(usual.mode()[0]) if len(usual) else 2, "CM")
        if r == "GK":
            continue
        # Season totals; a missing stat in a match means it didn't happen, so it counts as 0
        s = g.fillna({c: 0 for c in g.columns if g[c].dtype.kind == "f"}).sum(numeric_only=True)
        p90 = lambda col: s[col] / minutes * 90
        team_info = ppg.loc[(season, team)] if (season, team) in ppg.index else None
        rows.append({
            "season": season, "player_id": pid, "name": g["player"].iloc[-1], "team": team, "role": r,
            "minutes": minutes,
            "value": values.iloc[-1] if len(values) else np.nan,  # latest value of the season: closest to the end
            "value_obs": len(values),
            "age": g["age"].dropna().iloc[-1] if g["age"].notna().any() else np.nan,
            "dutch": float((g["country"].dropna() == "NED").any()),
            "team_ppg": team_info["team_ppg"] if team_info is not None else np.nan,
            "min_share": minutes / (team_info["team_games"] * 90) if team_info is not None else np.nan,
            "rating": g["FotMob rating"].mean(),
            "npxg90": p90("xG Non-penalty"),
            "xa90": p90("Expected assists (xA)"),
            "final3rd90": p90("Passes into final third"),
            "dribbles90": p90("Successful dribbles"),
            "def90": (s["Tackles"] + s["Interceptions"]) / minutes * 90,
            "aerials90": p90("Aerial duels won"),
            "passes90": p90("Accurate passes"),
            "pass_pct": s["Accurate passes"] / s["Accurate passes total"] * 100 if s["Accurate passes total"] else np.nan,
            # Candidates aimed at midfielders, kept only if they improve the backtest (see CANDIDATES)
            "touches90": p90("Touches"),
            "dispossessed90": p90("Dispossessed"),   # losing the ball: lower is better
            "fouled90": p90("Was fouled"),
            "recoveries90": p90("Recoveries"),
            "longballs90": p90("Accurate long balls"),
        })
    ps = pd.DataFrame(rows)
    ps["min_share"] = ps["min_share"].clip(upper=1)  # a mid-season transfer can push it just over 100%
    ps["end_date"] = pd.to_datetime(ps["season"].map(df.groupby("season")["date"].max()))
    ps = add_player_pages(ps)
    ps = shrink(ps)

    # Club reputation: average log market value of his teammates that season, excluding himself.
    # Excluding him matters: otherwise his own price would leak into a feature that predicts his price.
    log_value = np.log(ps["value"])
    by_team = log_value.groupby([ps["season"], ps["team"]])
    others = by_team.transform("count") - log_value.notna()
    ps["team_value"] = ((by_team.transform("sum") - log_value.fillna(0)) / others).where(others > 0)

    # Last season: rating and share of minutes in the previous season, if he played in the Eredivisie.
    # Only performance is carried over, never last season's market value: the model would just copy it.
    seasons = sorted(ps["season"].unique())
    next_season = dict(zip(seasons[:-1], seasons[1:]))
    prev = ps[["season", "player_id", "rating", "min_share"]].rename(columns={"rating": "prev_rating", "min_share": "prev_min_share"})
    prev["season"] = prev["season"].map(next_season)  # relabel each row as "last season" of the next one
    ps = ps.merge(prev.dropna(subset=["season"]), on=["season", "player_id"], how="left")
    ps["has_prev"] = ps["prev_rating"].notna().astype(float)  # tells the model a missing value means "new"

    # Rows to train and grade: a reliable market value, a known age, and enough minutes to trust per-90
    # numbers (30% of the most anyone played that season, at least 450). History seasons only feed 'prev'.
    max_min = ps.groupby("season")["minutes"].transform("max")
    reliable_value = ps["value_from_history"] | (ps["value_obs"] >= MIN_VALUE_OBS)
    keep = (reliable_value & ps["value"].notna() & ps["age"].notna() & (ps["minutes"] >= np.maximum(450, 0.3 * max_min))
            & ~ps["season"].isin(history))
    return ps[keep].reset_index(drop=True)


def value_near(values, ps, when):
    """For each row of ps: the value-history entry nearest to `when` (a date per row), within VALUE_WINDOW_DAYS."""
    left = pd.DataFrame({"row": range(len(ps)), "player_id": ps["player_id"].values, "date": pd.to_datetime(when).values})
    hit = pd.merge_asof(left.sort_values("date"), values.sort_values("date"), on="date", by="player_id",
                        direction="nearest", tolerance=pd.Timedelta(days=VALUE_WINDOW_DAYS[VALUE_SOURCE]))
    return hit.sort_values("row").set_index("row")


def add_player_pages(ps):
    """Market value at season end, value a year later, international caps and height, from the player pages.

    The value history covers every player wherever he played, so the backtest can follow players sold abroad.
    Contract end is not used: the page only shows the current contract, which says nothing about earlier seasons.
    """
    folder = RAW / "players"
    ps["value_from_history"] = False
    ps["next_value"] = np.nan
    ps["caps_before"] = np.nan
    ps["height"] = np.nan
    if not (folder / "values.csv").exists():
        return ps
    if VALUE_SOURCE == "transfermarkt":
        values = pd.read_csv(folder / "values_tm.csv", parse_dates=["date"])
        values["lower"] = values["upper"] = np.nan  # Transfermarkt gives no range
    else:
        values = pd.read_csv(folder / "values.csv", parse_dates=["date"])
    values = values[["player_id", "date", "value", "lower", "upper"]]

    at_end = value_near(values, ps, ps["end_date"])
    ps["value_from_history"] = at_end["value"].notna().values
    # History first: complete and consistent over time. The lineup value (SciSports) only fills gaps, and
    # never with Transfermarkt as the source: mixing the two scales would make the gap partly a source effect.
    fallback = ps["value"] if VALUE_SOURCE == "scisports" else np.nan
    ps["value"] = np.where(ps["value_from_history"], at_end["value"].values, fallback)
    ps["value_lower"], ps["value_upper"] = at_end["lower"].values, at_end["upper"].values
    later = ps["end_date"] + pd.Timedelta(days=HORIZON_DAYS)
    ps["next_value"] = np.where(later <= values["date"].max(), value_near(values, ps, later)["value"].values, np.nan)

    caps = pd.read_csv(folder / "caps.csv") if (folder / "caps.csv").exists() else pd.DataFrame(columns=["player_id", "season", "caps"])
    # Season names are "2025" or "2024/2025"; count the ones that ended before this club season started,
    # so the feature never uses caps he won later
    caps["end_year"] = caps["season"].astype(str).str[-4:].astype(int)
    start_year = ps["season"].str[:4].astype(int)
    by_player = caps.groupby("player_id")
    ps["caps_before"] = [by_player.get_group(p).query("end_year < @y")["caps"].sum() if p in by_player.groups else 0
                         for p, y in zip(ps["player_id"], start_year)]
    ps["caps_before"] = np.log1p(ps["caps_before"])  # 0, 5 and 50 caps: the first few matter most

    if (folder / "info.csv").exists():
        info = pd.read_csv(folder / "info.csv").set_index("player_id")
        ps["height"] = ps["player_id"].map(info["height"])
    return ps


def shrink(ps):
    """Pull per-90 stats and rating towards the season's role average, so 600 good minutes count for less
    than 2,500. The unshrunk value is kept as <feature>_raw for display."""
    w = ps["minutes"] / (ps["minutes"] + SHRINK_MINUTES)  # 0.5 at 450 minutes, 0.86 at 2,700
    for f in SHRUNK:
        ps[f + "_raw"] = ps[f]
        mean = ps.groupby(["season", "role"])[f].transform("mean")
        ps[f] = w * ps[f] + (1 - w) * mean
    return ps


def design(ps, feats):
    """Feature matrix: the features plus one-hot role and season columns."""
    X = ps[feats].copy()
    # One model with position as a feature, not one model per position: per position there'd be ~100 rows
    for r in ROLES:
        X[f"role_{r}"] = (ps["role"] == r).astype(float)
    for s in sorted(ps["season"].unique())[1:]:
        X[f"season_{s}"] = (ps["season"] == s).astype(float)  # absorbs market-wide price shifts between seasons
    return X


# ---------- model ----------

def models():
    """Candidate models. Settings are deliberately conservative (shallow trees, big leaves) for a small dataset."""
    return {
        # Ridge: linear regression with a penalty against large coefficients; RidgeCV picks the penalty strength
        "Linear (ridge)": lambda: make_pipeline(StandardScaler(), RidgeCV(alphas=np.logspace(-2, 3, 30))),
        # Random forest: averages many deep trees; min_samples_leaf=5 stops it memorising single players
        "Random forest": lambda: RandomForestRegressor(n_estimators=400, min_samples_leaf=5, max_features=0.4, n_jobs=-1, random_state=0),
        # Gradient boosting: small trees built one after another, each correcting the previous ones' errors.
        # Depth 3 is the middle of the settings tested (all of depth 2-4 scored 0.74-0.75), not the single best,
        # so the choice isn't tuned to this particular data.
        "Gradient boosting": lambda: HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05, max_iter=300, min_samples_leaf=15,
                                                                   l2_regularization=1.0, random_state=0),
    }


def oof_predict(make, X, y, groups, feats, roles, explain=False):
    """Out-of-fold predictions averaged over repeated, player-grouped K-fold splits.

    Players (not rows) are assigned to folds, so the model that predicts a player never saw any of his
    seasons. Otherwise his other season would leak in and the gaps would shrink towards zero.

    With explain=True also returns per-feature effects: prediction minus the prediction with that
    feature set to the training-fold median for the player's role (in log space).
    """
    pred = np.zeros(len(y))
    effects = np.zeros((len(y), len(feats)))
    players = np.unique(groups)
    for rep in range(REPEATS):
        rng = np.random.default_rng(rep)  # fixed seeds: the same run gives the same grades
        fold_of = dict(zip(rng.permutation(players), np.arange(len(players)) % FOLDS))
        folds = np.array([fold_of[g] for g in groups])
        for k in range(FOLDS):
            train, test = folds != k, folds == k
            # Missing values (e.g. last season for newcomers) get the training median; computed on the
            # training fold only, so nothing about the test players leaks in
            Xtr = X[train].fillna(X[train].median())
            Xte = X[test].fillna(X[train].median())
            model = make().fit(Xtr, y[train])
            base = model.predict(Xte)
            pred[test] += base / REPEATS
            if explain:
                # "What if this player were average for his position on this feature?" works for any model
                medians = Xtr.groupby(roles[train].values)[feats].median()
                for j, f in enumerate(feats):
                    Xalt = Xte.copy()
                    Xalt[f] = medians.loc[roles[test].values, f].values
                    effects[test, j] += (base - model.predict(Xalt)) / REPEATS
    return pred, effects


def calibrate(pred, y):
    """Linear fit of actual on predicted. Slope > 1 means predictions are squeezed towards the mean
    (typical for tree models); applying the fit stretches them back out."""
    slope, intercept = np.polyfit(pred, y, 1)
    return slope, intercept, intercept + slope * pred


def r2(y, p):
    """Share of the variance in log value that the predictions explain (1 = perfect, 0 = no better than the mean)."""
    return 1 - ((y - p) ** 2).sum() / ((y - y.mean()) ** 2).sum()


def grades(ps, a_gap=A_GAP, b_gap=B_GAP, max_age=MAX_AGE, min_pct=MIN_PCT):
    """A/B/C per row: a gap of at least a_gap (A) or b_gap (B), plus a good enough rating and young enough."""
    ok = (ps["rating_pct"] >= min_pct) & (ps["age"] <= max_age)
    return np.where((ps["gap"] >= a_gap) & ok, "A", np.where((ps["gap"] >= b_gap) & ok, "B", "C"))


def wilson(k, n, z=1.96):
    """95% range for a share of k out of n. Honest about small groups: 9 of 10 is 60-98%, not "90%"."""
    p, d = k / n, 1 + z * z / n
    centre, half = (p + z * z / (2 * n)) / d, z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return centre - half, centre + half


def rose_stats(change):
    """n, % that rose, its 95% range, and the median change factor, for a group of log value changes."""
    n, k = len(change), int((change > 0).sum())
    if n == 0:
        return {"n": 0}
    lo, hi = wilson(k, n)
    return {"n": n, "rose": round(100 * k / n), "lo": round(100 * lo), "hi": round(100 * hi),
            "median": round(float(np.exp(np.median(change))), 2)}


def fmt_rose(st):
    if not st["n"]:
        return "n=  0"
    return f"n={st['n']:3}  rose {st['rose']:3}%  (95% range {st['lo']}-{st['hi']}%)  median ×{st['median']}"


def backtest(ps):
    """Does the grade predict the market? Compare each player's value at the end of the season with his value
    HORIZON_DAYS later, per grade. R² only says how well we explain today's prices; this checks whether an
    'undervalued' player's price actually went up afterwards.

    The rules were chosen on these same seasons, so these numbers are in-sample; rule_check() gives the
    out-of-sample version. Two comparisons keep it fair:
    - Baseline: players who pass the same age and rating filters, whatever their gap. If B barely beats it, the
      filters do the work, not the model.
    - Price bands: expensive players rose more often in general, so grades are also compared within a band.
    The later value comes from the player pages, so players sold abroad or relegated are followed too.
    """
    k = ps.dropna(subset=["next_value"]).copy()
    k["change"] = np.log(k["next_value"] / k["value"])  # log change: 0.69 = doubled
    print(f"\nBacktest, in-sample: value change over the {HORIZON_DAYS} days after the season ({len(k)} player-seasons, "
          f"seasons {', '.join(sorted(k['season'].unique()))})")
    out = {}
    for g in ["A", "B", "C"]:
        out[g] = rose_stats(k.loc[k["grade"] == g, "change"])
        print(f"  {g}: {fmt_rose(out[g])}")
    filters = (k["rating_pct"] >= MIN_PCT) & (k["age"] <= MAX_AGE)
    out["baseline"] = rose_stats(k.loc[filters, "change"])
    print(f"  baseline (rating and age filters, any gap): {fmt_rose(out['baseline'])}")

    # Per price third: does a gap still help when comparing players of a similar price?
    k["band"] = pd.qcut(k["value"], 3, labels=["cheap", "mid", "expensive"])
    out["by_price"] = {}
    print("  per price third, A/B vs C:")
    for band, g in k.groupby("band", observed=True):
        ab, c = rose_stats(g.loc[g["grade"] != "C", "change"]), rose_stats(g.loc[g["grade"] == "C", "change"])
        out["by_price"][band] = {"ab": ab, "c": c}
        print(f"    {band:9} A/B {ab.get('rose')}% (n={ab['n']})   C {c.get('rose')}% (n={c['n']})")

    # Gap vs later change with price and age held constant: correlate what's left of both after regressing on them
    Z = np.c_[np.ones(len(k)), np.log(k["value"]), k["age"]]
    resid = lambda v: v - Z @ np.linalg.lstsq(Z, v, rcond=None)[0]
    out["partial_corr"] = round(float(np.corrcoef(resid(np.log(k["gap"].values)), resid(k["change"].values))[0, 1]), 2)
    print(f"  corr(gap, later change) with price and age held constant: {out['partial_corr']:+.2f}")
    return out


def choose_rules(sel):
    """The rules from RULE_GRID that worked best on sel: first the B rules (gap, age, rating) whose A/B picks
    rose most often (at least 20 picks), then the A gap whose A picks rose most often (at least 5)."""
    rose = lambda picks, min_n: (sel.loc[picks, "change"] > 0).mean() if picks.sum() >= min_n else -1
    best = max(({"b_gap": b, "max_age": age, "min_pct": pct}
                for b in RULE_GRID["b_gap"] for age in RULE_GRID["max_age"] for pct in RULE_GRID["min_pct"]),
               key=lambda r: rose((sel["gap"] >= r["b_gap"]) & (sel["age"] <= r["max_age"]) & (sel["rating_pct"] >= r["min_pct"]), 20))
    ok = (sel["age"] <= best["max_age"]) & (sel["rating_pct"] >= best["min_pct"])
    a = max(RULE_GRID["a_gap"], key=lambda a: rose(ok & (sel["gap"] >= a), 5))
    return {**best, "a_gap": max(a, best["b_gap"])}


def rule_check(ps):
    """Out-of-sample check of the grade rules: for each season with a known outcome, choose the rules on the
    OTHER seasons only, then grade this season with them. With rules tuned on the data they're judged on,
    9 of 10 A players rising says little; this shows how rules do on a season they never saw.
    """
    k = ps.dropna(subset=["next_value"]).copy()
    k["change"] = np.log(k["next_value"] / k["value"])
    seasons = sorted(k["season"].unique())
    if len(seasons) < 2:
        return None
    print("\nRule check, out-of-sample (rules chosen on the other seasons):")
    graded, chosen = [], {}
    for t in seasons:
        rules = choose_rules(k[k["season"] != t])
        test = k[k["season"] == t].copy()
        test["grade"] = grades(test, **rules)
        test["baseline"] = (test["age"] <= rules["max_age"]) & (test["rating_pct"] >= rules["min_pct"])
        graded.append(test)
        chosen[t] = rules
        print(f"  {t}: A gap {rules['a_gap']}, B gap {rules['b_gap']}, age <= {rules['max_age']}, "
              f"rating pct >= {rules['min_pct']}  (chosen on {', '.join(s for s in seasons if s != t)})")
    g = pd.concat(graded)
    out = {"rules": chosen}
    for grade in ["A", "B", "C"]:
        out[grade] = rose_stats(g.loc[g["grade"] == grade, "change"])
        print(f"  {grade}: {fmt_rose(out[grade])}")
    out["baseline"] = rose_stats(g.loc[g["baseline"], "change"])
    print(f"  baseline (same filters, any gap): {fmt_rose(out['baseline'])}")
    return out


def forward_test(ps, X, y, make):
    """Train on earlier seasons only, predict the next one: how the model would actually be used.

    The normal cross-validation mixes seasons; this checks the model also works on a season it has never seen
    anything of. For each season: R² of the predicted log value, and whether its gap predicted the later value.
    """
    seasons = sorted(ps["season"].unique())
    change = np.log(ps["next_value"] / ps["value"]).values
    print("\nForward test (train on earlier seasons, predict the next)")
    out = {}
    for t in seasons[1:]:
        train, test = (ps["season"] < t).values, (ps["season"] == t).values
        Xtr = X[train].fillna(X[train].median())
        model = make().fit(Xtr, y[train])
        pred = model.predict(X[test].fillna(X[train].median()))
        slope, intercept = np.polyfit(model.predict(Xtr), y[train], 1)  # calibration from training data only
        gap = intercept + slope * pred - y[test]
        known = ~np.isnan(change[test])
        corr = np.corrcoef(gap[known], change[test][known])[0, 1] if known.sum() > 20 else np.nan
        out[t] = {"r2": round(float(r2(y[test], intercept + slope * pred)), 2), "backtest_corr": None if np.isnan(corr) else round(float(corr), 2)}
        print(f"  {t}: trained on {train.sum()} rows, R² {out[t]['r2']:.2f}"
              + (f", gap vs later value change: corr {corr:+.2f} (n={known.sum()})" if not np.isnan(corr) else ", later value not known yet"))
    return out


def growth_model(ps, X, log_gap):
    """A second model that predicts the value change over the next HORIZON_DAYS directly, learned from what
    actually happened to earlier players. The value model asks "what should he cost today?"; this one asks
    "will his price go up?", which is the question the grades are meant to answer.

    Inputs: the value model's features, its gap, and his current value. Linear, because only a few hundred
    rows have a known outcome. Returns the evaluation, out-of-fold on the rows whose outcome is known.
    """
    has = ps["next_value"].notna().values
    target = np.log(ps["next_value"] / ps["value"]).values
    Xg = X.copy()
    Xg["log_gap"], Xg["log_value"] = log_gap, np.log(ps["value"].values)
    make = models()["Linear (ridge)"]
    groups = ps["player_id"].values
    pred, _ = oof_predict(make, Xg[has], target[has], groups[has], [], ps["role"][has])
    # Baseline: age and the gap alone, i.e. what the A/B/C rules use
    base_X = pd.DataFrame({"age": ps["age"], "age2": ps["age"] ** 2, "log_gap": log_gap})[has]
    base, _ = oof_predict(make, base_X, target[has], groups[has], [], ps["role"][has])
    t = target[has]
    top = lambda p: t[p >= np.quantile(p, 0.8)]  # the 20% the model is most positive about
    stats = {
        "n": int(has.sum()),
        "corr": round(float(np.corrcoef(pred, t)[0, 1]), 2), "corr_baseline": round(float(np.corrcoef(base, t)[0, 1]), 2),
        "top_rose": round(float((top(pred) > 0).mean()) * 100), "top_rose_baseline": round(float((top(base) > 0).mean()) * 100),
        "all_rose": round(float((t > 0).mean()) * 100),
    }
    print(f"\nGrowth model ({stats['n']} player-seasons with a known value {HORIZON_DAYS} days later)")
    print(f"  corr(predicted, actual change): {stats['corr']:+.2f}   baseline (age + gap only): {stats['corr_baseline']:+.2f}")
    print(f"  top 20% by prediction rose: {stats['top_rose']}%   baseline top 20%: {stats['top_rose_baseline']}%   everyone: {stats['all_rose']}%")
    return stats


def choose_model(results):
    """The linear model, unless the best tree model beats it by at least TREE_MARGIN R²."""
    tree = max((n for n in results if n != "Linear (ridge)"), key=lambda n: results[n]["r2"])
    return tree if results[tree]["r2"] >= results["Linear (ridge)"]["r2"] + TREE_MARGIN else "Linear (ridge)"


# ---------- main ----------

def main():
    global VALUE_SOURCE
    sys.stdout.reconfigure(encoding="utf-8")  # player names and ² on a Windows console
    if "--source" in sys.argv:
        VALUE_SOURCE = sys.argv[sys.argv.index("--source") + 1]
    print(f"market values: {VALUE_SOURCE}")
    ps = player_seasons(*load_matches())
    feats = [f for f in FEATURES if ps[f].notna().any()]
    missing = [f for f in FEATURES if f not in feats]
    X = design(ps, feats)
    # Predict log(value): values run from €100k to €30M+, and on the raw scale the most expensive players
    # would dominate the errors. On the log scale, being off by ×2 costs the same for every player.
    y = np.log(ps["value"].values)
    groups = ps["player_id"].values
    print(f"{len(ps)} player-seasons ({ps['season'].value_counts().sort_index().to_dict()}), {X.shape[1]} features")
    if missing:
        print(f"  not available in the data, skipped: {missing}")

    # Compare the candidates on out-of-fold predictions
    results = {}
    for name, make in models().items():
        pred, _ = oof_predict(make, X, y, groups, feats, ps["role"])
        slope, intercept, cal = calibrate(pred, y)
        results[name] = {"make": make, "slope": slope, "intercept": intercept,
                         "r2_raw": r2(y, pred), "r2": r2(y, cal),
                         # Typical error as a factor: ×1.7 means the prediction is usually within 1.7× of the real value
                         "mae_factor": float(np.exp(np.abs(y - cal).mean()))}
    print("\nOut-of-fold performance (log market value)")
    print(f"  {'model':18} {'R² raw':>7} {'R² calibrated':>14} {'calib. slope':>13} {'typical error':>14}")
    for name, r in results.items():
        print(f"  {name:18} {r['r2_raw']:7.2f} {r['r2']:14.2f} {r['slope']:13.2f} {'×' + format(r['mae_factor'], '.2f'):>14}")
    best = choose_model(results)
    r = results[best]
    print(f"  -> using {best}")

    # Final run of the chosen model, now also computing the per-feature effects for the reasons
    pred, effects = oof_predict(r["make"], X, y, groups, feats, ps["role"], explain=True)
    cal = r["intercept"] + r["slope"] * pred
    effects *= r["slope"]  # the calibration scales effects in log space too
    ps["expected"] = np.exp(cal)
    ps["gap"] = ps["expected"] / ps["value"]  # > 1: the model thinks he's worth more than his price
    # "Good player" check for A: rating percentile within his own position and season
    ps["rating_pct"] = ps.groupby(["season", "role"])["rating"].rank(pct=True) * 100
    ps["grade"] = grades(ps)
    # Would be A or B on performance, but too old for the value to rise: shown as C with a note
    ps["too_old"] = (ps["gap"] >= B_GAP) & (ps["rating_pct"] >= MIN_PCT) & (ps["age"] > MAX_AGE)

    # Price-bias checks: grades should not simply follow price.
    # By expected value: should be roughly flat (calibration makes the gap independent of the prediction).
    # By actual price: always skews to cheap players for any imperfect model (regression to the mean); the
    # skew shrinks as R² rises, so this is the number to watch when changing the model.
    bands = ["lowest third", "middle third", "highest third"]
    ps["price_band"] = pd.qcut(ps["value"], 3, labels=bands)
    ps["expected_band"] = pd.qcut(ps["expected"], 3, labels=bands)
    by_band = ps.groupby("price_band", observed=True)["grade"].value_counts(normalize=True).unstack().fillna(0) * 100
    by_expected = ps.groupby("expected_band", observed=True)["grade"].value_counts(normalize=True).unstack().fillna(0) * 100
    corr_actual = np.corrcoef(np.log(ps["gap"]), y)[0, 1]
    corr_expected = np.corrcoef(np.log(ps["gap"]), cal)[0, 1]
    print("\nPrice-bias checks")
    print(f"  corr(gap, expected value) = {corr_expected:+.2f}   (calibrated: should be ~0)")
    print(f"  corr(gap, actual value)   = {corr_actual:+.2f}   (mechanically -sqrt(1 - R²) = {-np.sqrt(1 - r['r2']):+.2f}: regression to the mean)")
    print("  grade share (%) per band of EXPECTED value - should be roughly flat:")
    print("    " + by_expected.round(0).to_string().replace("\n", "\n    "))
    print("  grade share (%) per band of ACTUAL price - skews to cheap players, less so as R² rises:")
    print("    " + by_band.round(0).to_string().replace("\n", "\n    "))
    print("\n  grades:", ps["grade"].value_counts().sort_index().to_dict())
    bt = backtest(ps)
    bt["out_of_sample"] = rule_check(ps)
    fwd = forward_test(ps, X, y, r["make"])
    # Evaluated only: it didn't beat the baseline of age and gap (correlation +0.37 for both), so the grades keep
    # the A/B/C rules
    growth_stats = growth_model(ps, X, cal - y)

    # Reasons: the four biggest effects on expected value, in euros
    out_rows = []
    shown = {f: f + "_raw" if f in SHRUNK else f for f in feats}  # reasons show the player's actual numbers
    for i, p in ps.iterrows():
        peers = ps[(ps["season"] == p["season"]) & (ps["role"] == p["role"])]  # for "top 8% of full backs"
        reasons = []
        for j in np.argsort(-np.abs(effects[i])):  # biggest effect first, positive or negative
            # Effect in log space -> euros: expected value minus expected value without this feature's effect
            eff_eur = p["expected"] - p["expected"] / np.exp(effects[i, j])
            if abs(eff_eur) < 0.03 * p["expected"]:  # skip effects under 3%: not worth explaining
                continue
            col = shown[feats[j]]
            reasons.append({"feature": feats[j], "label": FEATURES[feats[j]], "value": None if pd.isna(p[col]) else round(float(p[col]), 3),
                            "pct": round(float((peers[col] < p[col]).mean() * 100)), "effect": round(float(eff_eur)), "context": feats[j] in CONTEXT})
            if len(reasons) == 4:
                break
        out_rows.append({"id": int(p["player_id"]), "season": p["season"], "role": p["role"], "grade": p["grade"],
                         "value": int(p["value"]), "expected": int(round(p["expected"], -3)), "gap": round(float(p["gap"]), 2),
                         "rating_pct": round(float(p["rating_pct"])), "age": None if pd.isna(p["age"]) else int(p["age"]),
                         "minutes": int(p["minutes"]), "too_old": bool(p["too_old"]), "reasons": reasons})

    # Everything the dashboard's "How the rating works" section needs to describe this run
    meta = {
        "model": best, "r2": round(r["r2"], 2), "mae_factor": round(r["mae_factor"], 2),
        "comparison": {n: {"r2": round(v["r2"], 2), "slope": round(v["slope"], 2)} for n, v in results.items()},
        "n": len(ps), "seasons": sorted(ps["season"].unique().tolist()), "features": [FEATURES[f] for f in feats],
        "value_source": VALUE_SOURCE, "a_gap": A_GAP, "b_gap": B_GAP, "max_age": MAX_AGE, "shrink_minutes": SHRINK_MINUTES, "backtest": bt,
        "forward": fwd, "growth": growth_stats, "horizon_days": HORIZON_DAYS,
        "a_share_by_price": {str(k): round(float(by_band.loc[k].get("A", 0)), 1) for k in by_band.index},
        "a_share_by_expected": {str(k): round(float(by_expected.loc[k].get("A", 0)), 1) for k in by_expected.index},
    }
    # Written as a script, not JSON, so index.html also works when opened straight from disk
    OUT.write_text("window.RATINGS = " + json.dumps({"meta": meta, "rows": out_rows}, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(f"\n-> {OUT}")

    top = ps[ps["grade"] == "A"].sort_values("gap", ascending=False).head(10)
    print("\nTop A grades:")
    print(top[["season", "name", "team", "role", "age", "minutes", "value", "expected", "gap", "rating_pct"]].to_string(index=False))
    old = ps[ps["too_old"]]
    print(f"\nGap and rating good enough for A/B, but older than {MAX_AGE} (graded C): {len(old)}")


if __name__ == "__main__":
    main()
