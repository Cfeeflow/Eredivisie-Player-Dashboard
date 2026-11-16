"""Scrape FotMob: player stats per match for the leagues in leagues.json, plus every player's profile page.

Usage:
    python scrape.py                          every league with "scrape": true in leagues.json, then player pages
    python scrape.py --league belgium         only this league (its seasons and history seasons)
    python scrape.py --season 2026-2027       only this season of the selected leagues
    python scrape.py --reparse                rebuild the CSVs from cached match pages (downloads only what's missing)
    python scrape.py --no-players             skip the player pages
    python scrape.py --players-only           only the player pages
    python scrape.py --refresh-players        re-download every player page (default: new ones and those > 30 days old)

Output (all CSVs are de-duplicated on every save, so re-running never creates doubles):
    raw/<league>/matches_<season>.csv       one row per player per match         key: match_id + player_id
    raw/players/info.csv                    one row per player                   key: player_id
    raw/players/values.csv                  market value history                 key: player_id + date
    raw/players/caps.csv                    senior international caps per season key: player_id + season
Downloaded pages are cached in cache/ (not in git), so adding a field later means re-parsing, not re-downloading.

Every FotMob page embeds its data as JSON in a <script id="__NEXT_DATA__"> tag, so plain requests is enough.
"""
import argparse
import gzip
import json
import re
import sys
import time
from datetime import date, datetime
from pathlib import Path

import pandas as pd
import requests

HERE = Path(__file__).parent
RAW = HERE / "raw"
CACHE_DIR = HERE / "cache"
CONFIG = json.loads((HERE / "leagues.json").read_text(encoding="utf-8"))
DELAY = 1                   # seconds between downloads, be polite
RETRIES = 3                 # extra attempts after a failed download
PLAYER_MAX_AGE_DAYS = 30    # player pages older than this are fetched again (values and clubs change)

# A normal browser User-Agent: FotMob serves the full page to browsers, and requests' default UA can be refused
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}
# One session for all requests: reuses the connection instead of a new HTTPS handshake per page
SESSION = requests.Session()
SESSION.headers.update(HEADERS)


# ---------- downloading ----------

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


def cached(path, url, extract, refresh=False):
    """JSON from the cache if present (and refresh is False), otherwise downloaded, extracted and cached.

    Returns (data, downloaded) so the caller only waits between real downloads.
    """
    if path.exists() and not refresh:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f), False
    data = extract(get_page_data(url))
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as f:  # gzip: the JSON compresses about 10x
        json.dump(data, f)
    return data, True


def save(df, path, key):
    """Merge new rows into an existing CSV, keeping one row per key (the newest), so nothing is ever doubled."""
    if path.exists():
        df = pd.concat([pd.read_csv(path, low_memory=False), df], ignore_index=True)
    df = df.drop_duplicates(subset=key, keep="last")
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False, encoding="utf-8-sig")  # utf-8-sig so Excel shows names like Perišić correctly
    return df


# ---------- matches ----------

def get_fixtures(league_id, season):
    """All matches of a season as a DataFrame. Always downloaded fresh: scores and 'finished' change weekly."""
    url = f"https://www.fotmob.com/leagues/{league_id}/fixtures/x?season={season}"  # the name part of the URL is ignored
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
            **info,
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


def scrape_season(league_key, league_id, season, reparse=False):
    out = RAW / league_key / f"matches_{season}.csv"
    fixtures = get_fixtures(league_id, season)
    finished = fixtures[fixtures["finished"]]  # future matches have no player stats yet

    # Incremental: only matches that aren't in the CSV yet. With --reparse every match is parsed again (from the
    # cache where possible), e.g. after adding a field.
    done = set() if reparse or not out.exists() else set(pd.read_csv(out, usecols=["match_id"])["match_id"])
    to_do = finished[~finished["match_id"].isin(done)]
    print(f"{league_key} {season}: {len(finished)} finished matches, {len(done)} already in the CSV, processing {len(to_do)}", flush=True)
    if to_do.empty:
        return

    rows, downloads = [], 0
    for i, match in enumerate(to_do.itertuples(), start=1):
        try:
            content, downloaded = cached(CACHE_DIR / league_key / season / f"{match.match_id}.json.gz",
                                         f"https://www.fotmob.com/match/{match.match_id}", lambda d: d["content"])
            rows.extend(parse_player_stats(match.match_id, content))
            if downloaded:
                downloads += 1
                print(f"[{i}/{len(to_do)}] Round {match.round}: {match.home} - {match.away}", flush=True)
                time.sleep(DELAY)  # only wait after real downloads; cached matches are instant
        except Exception as e:
            # One broken match page shouldn't lose the whole season; failures are printed so they can be re-run
            print(f"[{i}/{len(to_do)}] {match.home} - {match.away} failed: {e}", flush=True)

    new = to_do.merge(pd.DataFrame(rows), on="match_id")  # add round, date and score to every row
    new.insert(0, "season", season)
    new.insert(0, "league", league_key)
    players = save(new, out, ["match_id", "player_id"]).sort_values(["date", "match_id"], kind="stable")
    players.to_csv(out, index=False, encoding="utf-8-sig")
    print(f"{len(new)} new rows ({downloads} downloads), {len(players)} total -> {out}", flush=True)


# ---------- player pages ----------

def parse_player(pid, d):
    """Player page -> (info row, value-history rows, caps rows)."""
    info_items = {x.get("translationKey"): x for x in d.get("playerInformation") or []}
    num = lambda key: ((info_items.get(key) or {}).get("value") or {}).get("numberValue")
    team = d.get("primaryTeam") or {}
    league = d.get("mainLeague") or {}
    info = {
        "player_id": pid, "name": d.get("name"),
        "birth_date": ((d.get("birthDate") or {}).get("utcTime") or "")[:10] or None,
        "height": num("height_sentencecase"),
        "foot": ((info_items.get("preferred_foot") or {}).get("value") or {}).get("key"),
        "country": (info_items.get("country_sentencecase") or {}).get("countryCode"),
        "position": (((d.get("positionDescription") or {}).get("primaryPosition")) or {}).get("label"),
        "market_value": num("transfer_value"),
        # The current contract only: it says nothing about the contract a player had in earlier seasons
        "contract_end": ((d.get("contractEnd") or {}).get("utcTime") or "")[:10] or None,
        "team": team.get("teamName"), "team_id": team.get("teamId"), "on_loan": team.get("onLoan"),
        "league": league.get("leagueName"), "league_id": league.get("leagueId"),
        "fetched": date.today().isoformat(),
    }
    # Market value history (source: SciSports): twice a year early on, monthly in recent seasons
    values = [{"player_id": pid, "date": v["date"][:10], "value": v.get("value"), "lower": v.get("lowerBound"),
               "upper": v.get("upperBound"), "team": v.get("teamName"), "team_id": v.get("teamId")}
              for v in ((d.get("marketValues") or {}).get("values") or [])]
    # Senior national team appearances per season (season names are like "2026" or "2025/2026")
    national = (((d.get("careerHistory") or {}).get("careerItems") or {}).get("national team") or {}).get("seasonEntries") or []
    caps = [{"player_id": pid, "season": s.get("seasonName"), "caps": int(s.get("appearances") or 0)} for s in national]
    return info, values, caps


def scrape_players(refresh=False):
    """Player pages for every player in any scraped league, fetched once per player id (no doubles across leagues)."""
    ids = set()
    for f in RAW.glob("*/matches_*.csv"):
        ids |= set(pd.read_csv(f, usecols=["player_id"])["player_id"])
    info_path = RAW / "players" / "info.csv"
    fetched = pd.read_csv(info_path).set_index("player_id")["fetched"] if info_path.exists() else pd.Series(dtype=str)
    stale = lambda pid: refresh or pid not in fetched.index or (datetime.now() - datetime.fromisoformat(fetched[pid])).days > PLAYER_MAX_AGE_DAYS
    to_do = sorted(pid for pid in ids if stale(pid))
    print(f"players: {len(ids)} in the data, fetching {len(to_do)} pages", flush=True)

    infos, values, caps = [], [], []
    for i, pid in enumerate(to_do, start=1):
        try:
            d, downloaded = cached(CACHE_DIR / "players" / f"{pid}.json.gz", f"https://www.fotmob.com/players/{pid}/x",
                                   lambda page: page["data"], refresh=True)
            info, v, c = parse_player(pid, d)
            infos.append(info), values.extend(v), caps.extend(c)
            print(f"[{i}/{len(to_do)}] {info['name']}", flush=True)
            time.sleep(DELAY)
        except Exception as e:
            print(f"[{i}/{len(to_do)}] player {pid} failed: {e}", flush=True)
        if i % 100 == 0 or i == len(to_do):  # save in batches, so an interrupted run keeps its progress
            if infos:
                save(pd.DataFrame(infos), info_path, ["player_id"])
            if values:
                save(pd.DataFrame(values), RAW / "players" / "values.csv", ["player_id", "date"])
            if caps:
                save(pd.DataFrame(caps), RAW / "players" / "caps.csv", ["player_id", "season"])
            infos, values, caps = [], [], []


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # names like Perišić or Doğan, also when the output goes to a log file
    ap = argparse.ArgumentParser(description="Scrape FotMob for the leagues in leagues.json")
    ap.add_argument("--league", help="only this league (a key from leagues.json)")
    ap.add_argument("--season", help="only this season, e.g. 2026-2027")
    ap.add_argument("--reparse", action="store_true", help="rebuild the CSVs from cached match pages")
    ap.add_argument("--no-players", action="store_true", help="skip the player pages")
    ap.add_argument("--players-only", action="store_true", help="only fetch player pages")
    ap.add_argument("--refresh-players", action="store_true", help="re-download every player page")
    args = ap.parse_args()

    if not args.players_only:
        for key, league in CONFIG["leagues"].items():
            if (args.league and key != args.league) or (not args.league and not league["scrape"]):
                continue
            for season in league["history"] + league["seasons"]:
                if not args.season or season == args.season:
                    scrape_season(key, league["id"], season, reparse=args.reparse)
    if not args.no_players:
        scrape_players(refresh=args.refresh_players)
