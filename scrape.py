"""Scrape FotMob player stats for every finished match of an Eredivisie season.

Usage: python scrape.py 2026-2027 [2025-2026 ...]
Writes raw/fotmob_player_stats_<season>.csv, one row per player per match.

Every FotMob page embeds its data as JSON in a <script id="__NEXT_DATA__"> tag, so plain requests is enough.
"""
import json
import re
import sys
import time
from pathlib import Path

import pandas as pd
import requests

LEAGUE_ID = 57              # 57 = Eredivisie
LEAGUE_SLUG = "eredivisie"
DELAY = 1                   # seconds between requests, be polite
OUT_DIR = Path(__file__).parent / "raw"

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}


def get_page_data(url):
    """Download a FotMob page and return the JSON embedded in __NEXT_DATA__."""
    response = requests.get(url, headers=HEADERS, timeout=30)
    response.raise_for_status()
    match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', response.text, re.S)
    return json.loads(match.group(1))["props"]["pageProps"]


def get_fixtures(season):
    """All matches of a season as a DataFrame."""
    url = f"https://www.fotmob.com/leagues/{LEAGUE_ID}/fixtures/{LEAGUE_SLUG}?season={season}"
    matches = get_page_data(url)["fixtures"]["allMatches"]
    return pd.DataFrame([{
        "match_id": m["id"],
        "round": m["round"],
        "date": m["status"]["utcTime"][:10],
        "home": m["home"]["name"],
        "away": m["away"]["name"],
        "score": m["status"].get("scoreStr"),
        "finished": m["status"]["finished"],
    } for m in matches])


def get_player_stats(match_id):
    """One row per player who played in the match.

    Fraction stats like "Ground duels won 4/6" become two columns:
    "Ground duels won" (4) and "Ground duels won total" (6).
    """
    content = get_page_data(f"https://www.fotmob.com/match/{match_id}")["content"]

    # Market value and position from the lineups. position_id (the formation slot) only exists for starters;
    # usual_position (0 GK, 1 DEF, 2 MID, 3 FWD) exists for everyone.
    lineup_info = {}
    lineup = content.get("lineup") or {}
    for side in ("homeTeam", "awayTeam"):
        team = lineup.get(side) or {}
        for p in (team.get("starters") or []) + (team.get("subs") or []):
            lineup_info[p["id"]] = {
                "market_value": p.get("marketValue"),
                "position_id": p.get("positionId"),
                "usual_position": p.get("usualPlayingPositionId"),
                "formation": team.get("formation") if "positionId" in p else None,
                "age": p.get("age"),
                "country": p.get("countryCode"),
            }

    rows = []
    for player in (content.get("playerStats") or {}).values():
        info = lineup_info.get(player["id"], {})
        row = {
            "match_id": match_id,
            "player": player["name"],
            "player_id": player["id"],
            "team": player["teamName"],
            "goalkeeper": player["isGoalkeeper"],
            "market_value": info.get("market_value"),
            "position_id": info.get("position_id"),
            "usual_position": info.get("usual_position"),
            "formation": info.get("formation"),
            "age": info.get("age"),
            "country": info.get("country"),
        }
        for section in player["stats"]:
            for name, entry in section["stats"].items():
                stat = entry.get("stat") or {}
                if stat.get("type") == "boolean":
                    continue
                row[name] = stat.get("value")
                if "total" in stat:
                    row[f"{name} total"] = stat["total"]
        rows.append(row)
    return rows


def scrape_season(season):
    fixtures = get_fixtures(season)
    to_scrape = fixtures[fixtures["finished"]]
    print(f"{season}: {len(fixtures)} matches, scraping {len(to_scrape)} finished", flush=True)

    all_rows = []
    for i, match in enumerate(to_scrape.itertuples(), start=1):
        print(f"[{i}/{len(to_scrape)}] Round {match.round}: {match.home} - {match.away}", flush=True)
        try:
            all_rows.extend(get_player_stats(match.match_id))
        except Exception as e:
            print(f"   failed: {e}", flush=True)
        time.sleep(DELAY)

    players = to_scrape.merge(pd.DataFrame(all_rows), on="match_id")
    players.insert(0, "season", season)
    OUT_DIR.mkdir(exist_ok=True)
    out = OUT_DIR / f"fotmob_player_stats_{season}.csv"
    players.to_csv(out, index=False, encoding="utf-8-sig")
    print(f"{players.shape[0]} rows -> {out}", flush=True)


if __name__ == "__main__":
    for season in sys.argv[1:] or ["2026-2027"]:
        scrape_season(season)
