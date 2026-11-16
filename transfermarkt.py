"""Transfermarkt market values for the scraped players, as an alternative to FotMob's (SciSports) values.

Usage: python transfermarkt.py [--refresh]
Source: the open transfermarkt-datasets project (github.com/dcaribou/transfermarkt-datasets, CC0 licence),
downloaded as a file instead of scraping transfermarkt.com, whose terms forbid scraping.
Players are matched on date of birth plus their name (FotMob and Transfermarkt use different ids); see match().
Writes raw/players/transfermarkt_ids.csv (one row per FotMob player, matched or not) and
raw/players/values_tm.csv (value history per FotMob player id, same layout as values.csv).
"""
import argparse
import json
import sys
import time
import unicodedata
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
CACHE = HERE / "cache" / "transfermarkt"
PLAYERS = HERE / "raw" / "players"
BASE_URL = "https://pub-e682421888d945d684bcae8890b0ec20.r2.dev/data/"
REFRESH_DAYS = 7  # the dataset is updated at most weekly
# Among players born on the same day, a whole-name similarity (0-1) of at least this is a match on its own.
# Unrelated names still reach 0.5-0.6 ("Jason Çeka" / "João Félix"), so below 0.8 the names must share words.
STRONG_NAME = 0.8

# Letters that unicodedata can't split into a base letter plus accent
SPECIAL = str.maketrans({"ø": "o", "ł": "l", "đ": "d", "ß": "ss", "ı": "i", "æ": "ae", "œ": "oe", "þ": "th"})


def download(name, refresh):
    """Download <name>.csv.gz once, and again when it's older than REFRESH_DAYS or --refresh is given."""
    path = CACHE / f"{name}.csv.gz"
    if refresh or not path.exists() or time.time() - path.stat().st_mtime > REFRESH_DAYS * 86400:
        CACHE.mkdir(parents=True, exist_ok=True)
        print(f"downloading {name}")
        urllib.request.urlretrieve(BASE_URL + path.name, path)
    return pd.read_csv(path)


def tokens(name):
    """'Gonçalo Ramos' -> ['goncalo', 'ramos']: lower case, accents removed, punctuation as spaces."""
    s = unicodedata.normalize("NFKD", str(name).lower().translate(SPECIAL))
    s = "".join(c if c.isalpha() else " " for c in s if not unicodedata.combining(c))
    return s.split()


def similarity(a, b):
    """(whole-name similarity 0-1, number of words both names share)."""
    ta, tb = tokens(a), tokens(b)
    return SequenceMatcher(None, " ".join(ta), " ".join(tb)).ratio(), len(set(ta) & set(tb))


def match(fotmob, tm, in_league):
    """One row per FotMob player and the Transfermarkt player he matches, if any.

    Born the same day, plus one of: a very similar name (>= STRONG_NAME); two or more shared words ("Mads Bech" /
    "Mads Bech Sørensen"); or one shared word and a Transfermarkt history in one of the scraped leagues
    (in_league), which separates "Weslley Pinto" / "Weslley Patati" (Ajax) from "Daniël van Vianen" / "Daniel
    Edelman" (MLS). The sites sometimes disagree on the birthday by a day or more (Limnios: 27 vs 28 May 1998), so
    an identical name born the same year also matches, if only one Transfermarkt player has that name and year.
    """
    by_birth = tm.groupby("birth_date")
    # (normalised name, birth year) -> players: a lookup, not a comparison with everyone born that year
    by_name_year = tm.groupby([tm["name"].map(lambda n: " ".join(tokens(n))), tm["birth_date"].str[:4]])
    rows = []
    for pid, name, birth in fotmob[["player_id", "name", "birth_date"]].itertuples(index=False):
        best = (None, None, 0.0, None)
        if pd.notna(birth) and birth in by_birth.groups:
            for tm_id, tm_name in by_birth.get_group(birth)[["player_id", "name"]].itertuples(index=False):
                whole, shared = similarity(name, tm_name)
                ok = whole >= STRONG_NAME or shared >= 2 or (shared == 1 and tm_id in in_league)
                if ok and whole > best[2]:
                    best = (tm_id, tm_name, whole, "birthday")
        key = (" ".join(tokens(name)), str(birth)[:4])
        if best[0] is None and key in by_name_year.groups:
            same = by_name_year.get_group(key)
            if len(same) == 1:  # two players with the same name and birth year: too uncertain
                best = (same["player_id"].iloc[0], same["name"].iloc[0], 1.0, "birth year")
        rows.append({"player_id": pid, "name": name, "tm_id": best[0], "tm_name": best[1],
                     "score": round(best[2], 2), "matched_on": best[3]})
    ids = pd.DataFrame(rows)
    ids["tm_id"] = ids["tm_id"].astype("Int64")
    # Two FotMob ids for one Transfermarkt player would copy one value history twice: keep the best match only
    dup = ids["tm_id"].notna() & ids.sort_values("score", ascending=False).duplicated("tm_id").reindex(ids.index)
    ids.loc[dup, ["tm_id", "tm_name", "matched_on"]] = None
    return ids


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--refresh", action="store_true", help="download the dataset again even if it's recent")
    args = parser.parse_args()

    fotmob = pd.read_csv(PLAYERS / "info.csv")  # from scrape.py: names and dates of birth
    tm = download("players", args.refresh)
    tm["birth_date"] = tm["date_of_birth"].str[:10]
    vals = download("player_valuations", args.refresh)
    leagues = json.loads((HERE / "leagues.json").read_text(encoding="utf-8"))["leagues"].values()
    codes = {lg["transfermarkt"] for lg in leagues if lg["scrape"]}
    in_league = set(vals.loc[vals["player_club_domestic_competition_id"].isin(codes), "player_id"])
    ids = match(fotmob, tm, in_league)
    ids.to_csv(PLAYERS / "transfermarkt_ids.csv", index=False)

    vals = vals.merge(ids.dropna(subset=["tm_id"])[["player_id", "tm_id"]], left_on="player_id", right_on="tm_id",
                      suffixes=("_tm", ""))
    out = vals.rename(columns={"market_value_in_eur": "value", "current_club_name": "team"})
    out = out[["player_id", "date", "value", "team"]].drop_duplicates(["player_id", "date"], keep="last")
    out.sort_values(["player_id", "date"]).to_csv(PLAYERS / "values_tm.csv", index=False)

    n, hit = len(ids), ids["tm_id"].notna().sum()
    no_birth = fotmob["birth_date"].isna().sum()
    print(f"matched {hit}/{n} players ({hit / n:.0%}); {no_birth} without a date of birth on FotMob")
    print(f"{len(out)} values, {out['date'].min()} to {out['date'].max()}")
    weak = ids[(ids["score"] < STRONG_NAME) & ids["tm_id"].notna()].sort_values("score")
    if len(weak):
        print("\nweakest accepted matches (check these):")
        print(weak.head(15)[["name", "tm_name", "score"]].to_string(index=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
