"""Scrape FotMob player stats for every finished match of an Eredivisie season.

Usage:
    python scrape.py 2026-2027 [2025-2026 ...]     only fetch matches that aren't in the CSV yet
    python scrape.py 2026-2027 --reparse           rebuild the CSV from cached match JSON (no downloads,
                                                   except matches that were never cached)
    python scrape.py 2022-2023 --history           write to raw_history/ (last-season features only)

Writes raw/fotmob_player_stats_<season>.csv, one row per player per match.
Every downloaded match page is also saved as cache/<season>/<match_id>.json.gz, so adding a new field to the
CSV later means re-parsing local files instead of downloading the season again.

Every FotMob page embeds its data as JSON in a <script id="__NEXT_DATA__"> tag, so plain requests is enough.
"""
import gzip
import json
import re
import sys
import time
from pathlib import Path

import pandas as pd
import requests

LEAGUE_ID = 57              # 57 = Eredivisie
LEAGUE_SLUG = "eredivisie"
DELAY = 1                   # seconds between downloads, be polite
RETRIES = 3                 # extra attempts after a failed download
HERE = Path(__file__).parent
CACHE_DIR = HERE / "cache"  # not in git: about 30 MB per season

# A normal browser User-Agent: FotMob serves the full page to browsers, and requests' default UA can be refused
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}
# One session for all requests: reuses the connection instead of a new HTTPS handshake per match
SESSION = requests.Session()
SESSION.headers.update(HEADERS)


def get_page_data(url):
    """Download a FotMob page and return the JSON embedded in __NEXT_DATA__, retrying on failures."""
    for attempt in range(RETRIES + 1):
        try:
            response = SESSION.get(url, timeout=30)
            response.raise_for_status()  # stop on 4xx/5xx instead of parsing an error page
            # FotMob is a Next.js site: all data the page shows is embedded as one JSON blob, so no browser is needed
            match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', response.text, re.S)
            return json.loads(match.group(1))["props"]["pageProps"]
        except Exception as e:
            if attempt == RETRIES:
                raise
            wait = 2 ** (attempt + 1)  # 2, 4, 8 seconds: gives a busy server or a dropped connection time to recover
            print(f"   attempt {attempt + 1} failed ({e}), retrying in {wait}s", flush=True)
            time.sleep(wait)


def get_fixtures(season):
    """All matches of a season as a DataFrame. Always downloaded fresh: scores and 'finished' change weekly."""
    url = f"https://www.fotmob.com/leagues/{LEAGUE_ID}/fixtures/{LEAGUE_SLUG}?season={season}"
    matches = get_page_data(url)["fixtures"]["allMatches"]
    return pd.DataFrame([{
        "match_id": int(m["id"]),  # FotMob sends ids as text; the CSV reads them back as numbers
        "round": m["round"],
        "date": m["status"]["utcTime"][:10],  # "2025-08-09T18:45:00Z" -> "2025-08-09"
        "home": m["home"]["name"],
        "away": m["away"]["name"],
        "score": m["status"].get("scoreStr"),
        "finished": m["status"]["finished"],
    } for m in matches])


def get_match_content(season, match_id):
    """The match page's 'content' JSON: from the cache if we have it, otherwise downloaded and cached.

    Returns (content, downloaded) so the caller only waits between real downloads.
    """
    path = CACHE_DIR / season / f"{match_id}.json.gz"
    if path.exists():
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f), False
    content = get_page_data(f"https://www.fotmob.com/match/{match_id}")["content"]
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as f:  # gzip: the JSON compresses about 10x
        json.dump(content, f)
    return content, True


def parse_player_stats(match_id, content):
    """One row per player who played in the match.

    Fraction stats like "Ground duels won 4/6" become two columns:
    "Ground duels won" (4) and "Ground duels won total" (6).
    """
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
                # Only stored for starters: build_data.py needs the formation to read the slot correctly
                "formation": team.get("formation") if "positionId" in p else None,
                "age": p.get("age"),
                "country": p.get("countryCode"),  # three letters, e.g. "NED"
            }

    rows = []
    # playerStats only lists players who actually played; unused substitutes are absent
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
                if stat.get("type") == "boolean":  # yes/no flags like "Captain" aren't stats
                    continue
                row[name] = stat.get("value")
                if "total" in stat:
                    row[f"{name} total"] = stat["total"]
        rows.append(row)
    return rows


def scrape_season(season, out_dir=HERE / "raw", reparse=False):
    out = out_dir / f"fotmob_player_stats_{season}.csv"
    fixtures = get_fixtures(season)
    finished = fixtures[fixtures["finished"]]  # future matches have no player stats yet

    # Incremental: keep the rows we already have and only process matches that are missing.
    # With --reparse every match is parsed again (from the cache), e.g. after adding a field.
    existing = pd.read_csv(out, low_memory=False) if out.exists() and not reparse else None
    done = set(existing["match_id"]) if existing is not None else set()
    to_do = finished[~finished["match_id"].isin(done)]
    print(f"{season}: {len(finished)} finished matches, {len(done)} already in the CSV, processing {len(to_do)}", flush=True)
    if to_do.empty:
        return

    all_rows, downloads = [], 0
    for i, match in enumerate(to_do.itertuples(), start=1):
        try:
            content, downloaded = get_match_content(season, match.match_id)
            all_rows.extend(parse_player_stats(match.match_id, content))
            if downloaded:
                downloads += 1
                print(f"[{i}/{len(to_do)}] Round {match.round}: {match.home} - {match.away}", flush=True)
                time.sleep(DELAY)  # only wait after real downloads; cached matches are instant
        except Exception as e:
            # One broken match page shouldn't lose the whole season; failures are printed so they can be re-run
            print(f"[{i}/{len(to_do)}] {match.home} - {match.away} failed: {e}", flush=True)

    new = to_do.merge(pd.DataFrame(all_rows), on="match_id")  # add round, date and score to every row
    new.insert(0, "season", season)
    players = pd.concat([existing, new], ignore_index=True) if existing is not None else new
    players = players.sort_values(["date", "match_id"], kind="stable")
    out_dir.mkdir(exist_ok=True)
    players.to_csv(out, index=False, encoding="utf-8-sig")  # utf-8-sig so Excel shows names like Perišić correctly
    print(f"{len(new)} new rows ({downloads} downloads), {len(players)} total -> {out}", flush=True)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out_dir = HERE / ("raw_history" if "--history" in sys.argv else "raw")
    for season in args or ["2026-2027"]:
        scrape_season(season, out_dir=out_dir, reparse="--reparse" in sys.argv)
