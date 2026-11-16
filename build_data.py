"""Turn the scraped FotMob CSVs (raw/<dashboard_league>/matches_*.csv) into data/players.js for the dashboard.

Usage: python build_data.py
The dashboard aggregates in the browser (so it can filter by date), so this writes one compact row
per player per match. Written as a script rather than JSON so index.html also works when opened from disk.
"""
import json
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
CONFIG = json.loads((HERE / "leagues.json").read_text(encoding="utf-8"))
LEAGUE = CONFIG["dashboard_league"]  # the dashboard shows one league for now
SEASONS = CONFIG["leagues"][LEAGUE]["seasons"]  # history seasons are for the model only, not shown
RAW = HERE / "raw" / LEAGUE
OUT = HERE / "data" / "players.js"

# CSV column -> short key used in the dashboard. Summed over the selected date range.
COUNT_COLS = {
    "Goals": "goals",
    "Assists": "assists",
    "Expected goals (xG)": "xg",
    "xG Non-penalty": "npxg",
    "Expected assists (xA)": "xa",
    "Total shots": "shots",
    "Shots on target": "sot",
    "Chances created": "chances",
    "Big chances created": "bigchances",
    "Touches": "touches",
    "Touches in opposition box": "boxtouches",
    "Passes into final third": "final3rd",
    "Accurate passes": "passes",
    "Accurate passes total": "passes_att",
    "Accurate long balls": "longballs",
    "Accurate long balls total": "longballs_att",
    "Accurate crosses": "crosses",
    "Accurate crosses total": "crosses_att",
    "Successful dribbles": "dribbles",
    "Successful dribbles total": "dribbles_att",
    "Tackles": "tackles",
    "Interceptions": "interceptions",
    "Recoveries": "recoveries",
    "Clearances": "clearances",
    "Blocks": "blocks",
    "Duels won": "duels",
    "Duels lost": "duels_lost",
    "Aerial duels won": "aerials",
    "Aerial duels won total": "aerials_att",
    "Dispossessed": "dispossessed",
    "Fouls committed": "fouls",
    "Was fouled": "fouled",
    "Saves": "saves",
    "Goals conceded": "conceded",
    "xGOT faced": "xgot_faced",
    "Goals prevented": "prevented",
}


def role(position_id, formation):
    """Map FotMob's formation slot id to a role.

    The id reads as <line><lane>: 11 is the keeper, line 3 the back line, up to 10-11 for the front line;
    lane runs 1-9 across the pitch, so lanes 1-2 and 8-9 are the flanks.
    """
    if pd.isna(position_id):
        return ""  # substitutes have no formation slot; the dashboard falls back to FotMob's broad position
    pid = int(position_id)
    line, lane = divmod(pid, 10)  # e.g. 105 -> line 10, lane 5 (centre forward)
    wide = lane <= 2 or lane >= 8
    back_three = str(formation).startswith("3")
    if pid == 11:
        return "GK"
    if line <= 4:
        return "FB" if wide else "CB"  # back four: 32/38 full backs, 34/36 centre backs; back three: all CB
    if line == 5:
        return "FB" if wide else "CM"  # wing-backs in a back five, or a holding midfielder
    if line <= 9:
        if wide:
            return "FB" if back_three else "W"  # wide midfielders in a back three are wing-backs
        if line == 8 and lane in (3, 7):
            return "W"  # the wide attacking midfielders of a 4-2-3-1
        # Central players in the band of four of a 4-1-4-1 or 3-1-4-2 are central midfielders
        if line >= 8 and str(formation).split("-")[-2:-1] != ["4"]:
            return "AM"
        return "CM"
    return "W" if lane <= 3 or lane >= 7 else "ST"  # front line: 103/107 wingers, 104-106 strikers


def main():
    files = [RAW / f"matches_{s}.csv" for s in SEASONS if (RAW / f"matches_{s}.csv").exists()]
    df = pd.concat([pd.read_csv(f, low_memory=False) for f in files], ignore_index=True)
    df = df[df["Minutes played"].fillna(0) > 0].copy()  # unused substitutes have a row but no minutes
    df = df.sort_values(["date", "match_id"])            # the dashboard relies on rows being in date order
    df[list(COUNT_COLS)] = df[list(COUNT_COLS)].fillna(0)  # a missing stat in a match means it didn't happen
    df["role"] = [role(p, f) for p, f in zip(df["position_id"], df["formation"])]

    # 'team' and 'home'/'away' spell some clubs differently, so take the opponent from the other team in the match
    teams_per_match = df.groupby("match_id")["team"].unique()
    df["opponent"] = [
        next((t for t in teams_per_match[m] if t != team), "?")
        for m, team in zip(df["match_id"], df["team"])
    ]

    # Teams and players are stored once and referenced by index in every row, which keeps the file small
    teams = sorted(set(df["team"]) | set(df["opponent"]))
    team_idx = {t: i for i, t in enumerate(teams)}
    player_ids = list(dict.fromkeys(df["player_id"]))  # unique ids in order of first appearance
    player_idx = {p: i for i, p in enumerate(player_ids)}
    latest_name = df.groupby("player_id")["player"].last()  # FotMob sometimes changes the spelling over time

    # Rows as arrays with one shared header ('cols') instead of objects with keys: about 3x smaller
    cols =["player", "date", "team", "opp", "min", "rating", "value", "gk", "role", "usual", *COUNT_COLS.values()]
    rows = [
        [
            player_idx[pid], date, team_idx[team], team_idx[opp], int(minutes),
            None if pd.isna(rating) else round(rating, 2),
            None if pd.isna(value) else int(value),
            int(bool(gk)), rl, None if pd.isna(usual) else int(usual),
            *(round(float(v), 2) if v % 1 else int(v) for v in stats),  # whole numbers without ".0"
        ]
        for pid, date, team, opp, minutes, rating, value, gk, rl, usual, *stats in df[
            ["player_id", "date", "team", "opponent", "Minutes played", "FotMob rating", "market_value",
             "goalkeeper", "role", "usual_position", *COUNT_COLS]
        ].itertuples(index=False)
    ]

    # Season presets for the dashboard's Season filter; start/end are the first and last match dates
    seasons = [
        {"id": s, "label": s[:5] + s[-2:],  # "2025-2026" -> "2025-26"
         "start": g["date"].min(), "end": g["date"].max(), "matches": g["match_id"].nunique()}
        for s, g in df.groupby("season")
    ]
    data = {
        "meta": {"league": "Eredivisie", "seasons": seasons},
        "teams": teams,
        "players": [{"id": int(p), "name": latest_name[p]} for p in player_ids],
        "cols": cols,
        "rows": rows,
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text("window.DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(f"{len(rows)} rows, {len(player_ids)} players, seasons {[s['id'] for s in seasons]} -> {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
