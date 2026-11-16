"""Which candidate features improve the value model? Adds each one in CANDIDATES to the current FEATURES and
reports R², the backtest, central midfielders separately, and the growth model.

Usage: python feature_test.py [--source transfermarkt]
A feature earns its place by improving the backtest (does the gap predict the later value change?), not only R².
"""
import sys

import numpy as np

import value_model as vm

sys.stdout.reconfigure(encoding="utf-8")
vm.REPEATS = 3  # fewer repeats: enough to compare, about 3x faster
if "--source" in sys.argv:  # python feature_test.py --source transfermarkt
    vm.VALUE_SOURCE = sys.argv[sys.argv.index("--source") + 1]

df, history = vm.load_matches()
ps = vm.player_seasons(df, history)
y = np.log(ps["value"].values)
groups = ps["player_id"].values
change = np.log(ps["next_value"] / ps["value"]).values
known = ~np.isnan(change)
cm = known & (ps["role"] == "CM").values
print(f"{len(ps)} player-seasons, {known.sum()} with a known value {vm.HORIZON_DAYS} days later\n")


def evaluate(name, feats):
    X = vm.design(ps, feats)
    pred, _ = vm.oof_predict(vm.models()["Linear (ridge)"], X, y, groups, feats, ps["role"])
    _, _, cal = vm.calibrate(pred, y)
    gap = cal - y
    stats = vm_growth(X, gap)
    print(f"{name:42} R² {vm.r2(y, cal):.3f}   backtest corr {np.corrcoef(gap[known], change[known])[0, 1]:+.3f}"
          f"   CM {np.corrcoef(gap[cm], change[cm])[0, 1]:+.3f}   growth model corr {stats['corr']:+.3f}")


def vm_growth(X, gap):
    out = sys.stdout
    sys.stdout = open("nul" if sys.platform == "win32" else "/dev/null", "w")  # growth_model prints; keep this table clean
    try:
        return vm.growth_model(ps, X, gap)
    finally:
        sys.stdout.close()
        sys.stdout = out


base = list(vm.FEATURES)
evaluate("current features", base)
for f, label in vm.CANDIDATES.items():
    if ps[f].notna().any():
        evaluate(f"+ {label}", base + [f])
    else:
        print(f"+ {label}: no data yet")
