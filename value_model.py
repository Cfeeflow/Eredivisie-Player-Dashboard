"""Value rating: which outfield players perform like they're worth more than their market value?

Usage: python value_model.py
Reads raw/*.csv, writes data/ratings.js and prints the model checks.

How it works
1. One row per player per season (both seasons pooled), outfield players with enough minutes.
2. Predict log(market value) from performance and context. Every prediction is out-of-fold: the model that
   predicts a player never saw any of his seasons (folds are split by player, repeated with different splits).
3. Random forest vs a linear (ridge) baseline on the same features; the better one by out-of-fold R² is used,
   after a linear calibration so predictions aren't compressed towards the average price.
4. Gap = expected value / actual value. A: gap >= 2 and FotMob rating at or above the median for his role.
   B: gap >= 1.5. C: the rest.
5. Reasons: each feature is set to the role median and the change in expected value is that feature's effect.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import RidgeCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from build_data import role

HERE = Path(__file__).parent
OUT = HERE / "data" / "ratings.js"

A_GAP, B_GAP = 2.0, 1.5  # A must clear the typical model error (about ×1.7)
REPEATS, FOLDS = 5, 5
ROLES = ["CB", "FB", "CM", "AM", "W", "ST"]
USUAL_ROLE = {1: "CB", 2: "CM", 3: "ST"}  # fallback for players without a starting slot

# Model features: name -> label shown in the reasons. Role dummies are added on top.
FEATURES = {
    "age": "Age",
    "min_share": "Share of minutes played",
    "team_ppg": "Team points per game",
    "rating": "FotMob rating",
    "npxg90": "Non-penalty xG per 90",
    "xa90": "xA per 90",
    "final3rd90": "Passes into final third per 90",
    "dribbles90": "Successful dribbles per 90",
    "def90": "Tackles + interceptions per 90",
    "aerials90": "Aerial duels won per 90",
    "passes90": "Accurate passes per 90",
    "pass_pct": "Pass accuracy",
    "dutch": "Dutch nationality",
}
# Context features: shown in reasons, but they say nothing about how well he plays
CONTEXT = {"age", "team_ppg", "dutch"}


def load_matches():
    df = pd.concat([pd.read_csv(f, low_memory=False) for f in sorted((HERE / "raw").glob("*.csv"))], ignore_index=True)
    df = df[df["Minutes played"].fillna(0) > 0].copy()
    df = df.sort_values(["date", "match_id"])
    df["role"] = [role(p, f) for p, f in zip(df["position_id"], df["formation"])]
    return df


def team_points(df):
    """Points per game per (season, team), from the goals each team's keepers conceded."""
    conceded = df[df["goalkeeper"]].groupby(["season", "match_id", "team"])["Goals conceded"].sum().reset_index()
    pts = []
    for (season, match_id), g in conceded.groupby(["season", "match_id"]):
        if len(g) != 2:
            continue
        (t1, c1), (t2, c2) = g[["team", "Goals conceded"]].values
        # A team's goals are what the other team's keeper conceded
        p1 = 3 if c2 > c1 else 1 if c1 == c2 else 0
        p2 = 3 if c1 > c2 else 1 if c1 == c2 else 0
        pts += [(season, t1, p1), (season, t2, p2)]
    pts = pd.DataFrame(pts, columns=["season", "team", "pts"])
    return pts.groupby(["season", "team"]).agg(team_ppg=("pts", "mean"), team_games=("pts", "size"))


def player_seasons(df):
    ppg = team_points(df)
    rows = []
    for (season, pid), g in df.groupby(["season", "player_id"]):
        if g["goalkeeper"].mean() > 0.5:
            continue
        values = g["market_value"].dropna()
        if values.empty:
            continue
        minutes = g["Minutes played"].sum()
        team = g.groupby("team")["Minutes played"].sum().idxmax()
        roles = g[g["role"] != ""].groupby("role")["Minutes played"].sum()
        usual = g["usual_position"].dropna()
        r = roles.idxmax() if len(roles) else USUAL_ROLE.get(int(usual.mode()[0]) if len(usual) else 2, "CM")
        if r == "GK":
            continue
        s = g.fillna({c: 0 for c in g.columns if g[c].dtype.kind == "f"}).sum(numeric_only=True)
        p90 = lambda col: s[col] / minutes * 90
        team_info = ppg.loc[(season, team)] if (season, team) in ppg.index else None
        rows.append({
            "season": season, "player_id": pid, "name": g["player"].iloc[-1], "team": team, "role": r,
            "minutes": minutes, "value": values.iloc[-1],
            "age": g["age"].dropna().iloc[-1] if "age" in g and g["age"].notna().any() else np.nan,
            "dutch": float((g["country"].dropna() == "NED").any()) if "country" in g else np.nan,
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
    # Enough minutes to trust per-90 numbers: 30% of the most anyone played that season, at least 450
    max_min = ps.groupby("season")["minutes"].transform("max")
    ps = ps[ps["minutes"] >= np.maximum(450, 0.3 * max_min)].reset_index(drop=True)
    ps["min_share"] = ps["min_share"].clip(upper=1)
    return ps


def design(ps, feats):
    X = ps[feats].copy()
    for r in ROLES:
        X[f"role_{r}"] = (ps["role"] == r).astype(float)
    latest = ps["season"].max()
    X["season_latest"] = (ps["season"] == latest).astype(float)  # absorbs a market-wide price shift
    return X


def models():
    return {
        "Random forest": lambda: RandomForestRegressor(n_estimators=400, min_samples_leaf=5, max_features=0.4, n_jobs=-1, random_state=0),
        "Linear (ridge)": lambda: make_pipeline(StandardScaler(), RidgeCV(alphas=np.logspace(-2, 3, 30))),
    }


def oof_predict(make, X, y, groups, feats, roles, explain=False):
    """Out-of-fold predictions averaged over repeated, player-grouped K-fold splits.

    With explain=True also returns per-feature effects: prediction minus the prediction with that
    feature set to the training-fold median for the player's role (in log space).
    """
    pred = np.zeros(len(y))
    effects = np.zeros((len(y), len(feats)))
    players = np.unique(groups)
    for rep in range(REPEATS):
        rng = np.random.default_rng(rep)
        fold_of = dict(zip(rng.permutation(players), np.arange(len(players)) % FOLDS))
        folds = np.array([fold_of[g] for g in groups])
        for k in range(FOLDS):
            train, test = folds != k, folds == k
            Xtr = X[train].fillna(X[train].median())
            Xte = X[test].fillna(X[train].median())
            model = make().fit(Xtr, y[train])
            base = model.predict(Xte)
            pred[test] += base / REPEATS
            if explain:
                medians = Xtr.groupby(roles[train].values)[feats].median()
                for j, f in enumerate(feats):
                    Xalt = Xte.copy()
                    Xalt[f] = medians.loc[roles[test].values, f].values
                    effects[test, j] += (base - model.predict(Xalt)) / REPEATS
    return pred, effects


def calibrate(pred, y):
    """Linear fit of actual on predicted. Slope > 1 means predictions are squeezed towards the mean."""
    slope, intercept = np.polyfit(pred, y, 1)
    return slope, intercept, intercept + slope * pred


def r2(y, p):
    return 1 - ((y - p) ** 2).sum() / ((y - y.mean()) ** 2).sum()


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # player names and ² on a Windows console
    ps = player_seasons(load_matches())
    feats = [f for f in FEATURES if ps[f].notna().any()]
    missing = [f for f in FEATURES if f not in feats]
    X = design(ps, feats)
    y = np.log(ps["value"].values)
    groups = ps["player_id"].values
    print(f"{len(ps)} player-seasons ({ps['season'].value_counts().sort_index().to_dict()}), {X.shape[1]} features")
    if missing:
        print(f"  not available in the data, skipped: {missing}")

    # Compare both models on out-of-fold predictions
    results = {}
    for name, make in models().items():
        pred, _ = oof_predict(make, X, y, groups, feats, ps["role"])
        slope, intercept, cal = calibrate(pred, y)
        results[name] = {"make": make, "slope": slope, "intercept": intercept,
                         "r2_raw": r2(y, pred), "r2": r2(y, cal), "mae_factor": float(np.exp(np.abs(y - cal).mean()))}
    print("\nOut-of-fold performance (log market value)")
    print(f"  {'model':16} {'R² raw':>7} {'R² calibrated':>14} {'calib. slope':>13} {'typical error':>14}")
    for name, r in results.items():
        print(f"  {name:16} {r['r2_raw']:7.2f} {r['r2']:14.2f} {r['slope']:13.2f} {'×' + format(r['mae_factor'], '.2f'):>14}")
    best = max(results, key=lambda n: results[n]["r2"])
    r = results[best]
    print(f"  -> using {best}")

    pred, effects = oof_predict(r["make"], X, y, groups, feats, ps["role"], explain=True)
    cal = r["intercept"] + r["slope"] * pred
    effects *= r["slope"]  # the calibration scales effects in log space too
    ps["expected"] = np.exp(cal)
    ps["gap"] = ps["expected"] / ps["value"]
    ps["rating_pct"] = ps.groupby(["season", "role"])["rating"].rank(pct=True) * 100
    ps["grade"] = np.where((ps["gap"] >= A_GAP) & (ps["rating_pct"] >= 50), "A", np.where(ps["gap"] >= B_GAP, "B", "C"))

    # Price-bias checks: grades should not simply follow price
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

    # Reasons: the biggest effects on expected value, in euros
    out_rows = []
    for i, p in ps.iterrows():
        pct_in_role = {f: float((ps.loc[(ps["season"] == p["season"]) & (ps["role"] == p["role"]), f] < p[f]).mean() * 100) for f in feats}
        reasons = []
        for j in np.argsort(-np.abs(effects[i])):
            eff_eur = p["expected"] - p["expected"] / np.exp(effects[i, j])
            if abs(eff_eur) < 0.03 * p["expected"]:
                continue
            reasons.append({"feature": feats[j], "label": FEATURES[feats[j]], "value": None if pd.isna(p[feats[j]]) else round(float(p[feats[j]]), 3),
                            "pct": round(pct_in_role[feats[j]]), "effect": round(float(eff_eur)), "context": feats[j] in CONTEXT})
            if len(reasons) == 4:
                break
        out_rows.append({"id": int(p["player_id"]), "season": p["season"], "role": p["role"], "grade": p["grade"],
                         "value": int(p["value"]), "expected": int(round(p["expected"], -3)), "gap": round(float(p["gap"]), 2),
                         "rating_pct": round(float(p["rating_pct"])), "reasons": reasons})

    meta = {
        "model": best, "r2": round(r["r2"], 2), "mae_factor": round(r["mae_factor"], 2),
        "comparison": {n: {"r2": round(v["r2"], 2), "slope": round(v["slope"], 2)} for n, v in results.items()},
        "n": len(ps), "features": [FEATURES[f] for f in feats], "a_gap": A_GAP, "b_gap": B_GAP,
        "a_share_by_price": {str(k): round(float(by_band.loc[k].get("A", 0)), 1) for k in by_band.index},
        "a_share_by_expected": {str(k): round(float(by_expected.loc[k].get("A", 0)), 1) for k in by_expected.index},
    }
    OUT.write_text("window.RATINGS = " + json.dumps({"meta": meta, "rows": out_rows}, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(f"\n-> {OUT}")

    top = ps[ps["grade"] == "A"].sort_values("gap", ascending=False).head(10)
    print("\nTop A grades:")
    print(top[["season", "name", "team", "role", "age", "value", "expected", "gap", "rating_pct"]].to_string(index=False))


if __name__ == "__main__":
    main()
