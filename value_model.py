"""Value rating: which outfield players perform like they're worth more than their market value?

Usage: python value_model.py
Reads raw/*.csv (and raw_history/*.csv for last-season features), writes data/ratings.js and prints the
model checks.

How it works
1. One row per player per season (all seasons pooled), outfield players with enough minutes. Per-90 stats and
   rating are shrunk towards the role average, more so for players with fewer minutes.
2. Predict log(market value) from performance and context. Every prediction is out-of-fold: the model that
   predicts a player never saw any of his seasons (folds are split by player, repeated with different splits).
3. A linear (ridge) model, a random forest and gradient boosting are compared on the same features. A tree
   model only replaces the linear one when it is clearly better by out-of-fold R². The chosen model gets a
   linear calibration so predictions aren't compressed towards the average price.
4. Gap = expected value / actual value. A: gap >= 2, FotMob rating at or above the median for his role and
   age 30 or younger (an older player's low price reflects a short career left, not a mistake by the market).
   B: gap >= 1.5. C: the rest.
5. Reasons: each feature is set to the role median and the change in expected value is that feature's effect.
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

# ---------- settings ----------

# Grade thresholds on expected / actual value. The model's typical error is about ×1.7, so A (×2) needs a gap
# clearly bigger than ordinary model noise; B (×1.5) is "probably undervalued".
A_GAP, B_GAP = 2.0, 1.5
# An older player's low price mostly reflects how few seasons he has left (no resale value), which the market
# prices correctly for a buyer who wants to sell on later. So A is reserved for players this age or younger.
A_MAX_AGE = 30
# FotMob stores no market value for many matches before 2025-26. A season's value needs at least this many
# observations, so one stray number can't drive a grade.
MIN_VALUE_OBS = 3
# Tree models can't extrapolate beyond the prices they have seen, so they only replace the linear model when
# their out-of-fold R² is at least this much higher. Smaller differences are within noise between runs.
TREE_MARGIN = 0.02
# Shrinkage weight in minutes: a player's own per-90 numbers count for minutes / (minutes + 450), the rest comes
# from the role average. 450 gave the best out-of-fold R² of the weights tested (0, 450, 900, 1800, 3600).
SHRINK_MINUTES = 450
# Features that are averages over matches and therefore noisy for players with few minutes
SHRUNK = ["rating", "npxg90", "xa90", "final3rd90", "dribbles90", "def90", "aerials90", "passes90", "pass_pct"]
# Cross-validation: 5 folds, repeated 5 times with different random splits, predictions averaged.
# Repeating smooths out the luck of any single split.
REPEATS, FOLDS = 5, 5
ROLES = ["CB", "FB", "CM", "AM", "W", "ST"]
USUAL_ROLE = {1: "CB", 2: "CM", 3: "ST"}  # FotMob's broad position, for players who never started a match

# Model features: name -> label shown in the reasons. Role and season dummies are added in design().
# Kept short on purpose: with under 1,000 rows, every extra feature adds noise to the estimates.
FEATURES = {
    "age": "Age",                                       # the biggest single driver of market value
    "min_share": "Share of minutes played",             # how much the coach trusts him
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
    "prev_min_share": "Last season's share of minutes",
    "has_prev": "Played in the Eredivisie last season",
}
# Context features: shown in the reasons, but they say nothing about how well he plays, so the one-line
# summary ("High npxG and xA for a winger") never uses them
CONTEXT = {"age", "team_ppg", "dutch", "team_value", "has_prev"}


# ---------- data ----------

def load_matches():
    """All match rows. Seasons in raw_history/ only supply last-season features; they aren't graded."""
    files = sorted((HERE / "raw").glob("*.csv")) + sorted((HERE / "raw_history").glob("*.csv"))
    frames = {f: pd.read_csv(f, low_memory=False) for f in files}
    df = pd.concat(frames.values(), ignore_index=True)
    history = {s for f, d in frames.items() if f.parent.name == "raw_history" for s in d["season"].unique()}
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
        })
    ps = pd.DataFrame(rows)
    ps["min_share"] = ps["min_share"].clip(upper=1)  # a mid-season transfer can push it just over 100%
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
    keep = ((ps["value_obs"] >= MIN_VALUE_OBS) & ps["age"].notna() & (ps["minutes"] >= np.maximum(450, 0.3 * max_min))
            & ~ps["season"].isin(history))
    return ps[keep].reset_index(drop=True)


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


def choose_model(results):
    """The linear model, unless the best tree model beats it by at least TREE_MARGIN R²."""
    tree = max((n for n in results if n != "Linear (ridge)"), key=lambda n: results[n]["r2"])
    return tree if results[tree]["r2"] >= results["Linear (ridge)"]["r2"] + TREE_MARGIN else "Linear (ridge)"


# ---------- main ----------

def main():
    sys.stdout.reconfigure(encoding="utf-8")  # player names and ² on a Windows console
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
    a_level = (ps["gap"] >= A_GAP) & (ps["rating_pct"] >= 50)
    ps["too_old"] = a_level & (ps["age"] > A_MAX_AGE)  # would be A on performance, capped at B by age
    ps["grade"] = np.where(a_level & ~ps["too_old"], "A", np.where(ps["gap"] >= B_GAP, "B", "C"))

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
        "a_gap": A_GAP, "b_gap": B_GAP, "a_max_age": A_MAX_AGE, "shrink_minutes": SHRINK_MINUTES,
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
    print(f"\nCapped at B for age > {A_MAX_AGE}: {len(old)} ({', '.join(old['name'] + ' ' + old['season'].str[2:4] + '-' + old['season'].str[-2:])})")


if __name__ == "__main__":
    main()
