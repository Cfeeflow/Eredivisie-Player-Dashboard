# Eredivisie player stats

An interactive dashboard of Eredivisie player statistics, built from FotMob match data. It runs as a static page: open `index.html` in a browser, or host the folder on GitHub Pages, or: https://cfeeflow.github.io/Eredivisie-Player-Dashboard/

## What's in it

- **Filters** for season or a custom date range, position (broad or detailed), team and minimum minutes. Stats show per 90 or as totals. **Find player** in the same bar opens a player's profile.
- **Explorer**: a scatter plot of two metrics, split at the median into four quadrants. Preset views each answer one question (finishing, shot selection, chance creation, defensive style and more), and picking your own X axis suggests Y metrics that pair well with it.
- **Value rating**: grades outfield players A (very undervalued), B (undervalued) or C (fairly valued or expensive) by comparing their market value with what a model expects from their performance. Every grade comes with the reasons behind it. The list of undervalued players can be narrowed by grade and maximum age.
- **Top 15** for any metric.
- **Player profile** with percentiles against the same position, the same line or all outfield players, and the FotMob rating for every match. **Compare with player** puts a second player next to him in every part of the profile.
- **Table** of all players in the current filter, sortable by any column. Players who played for more than one club in the selected period are marked ⇄.

The ⓘ buttons, the percentile tooltips and the table headers explain each metric. All settings, including the open player, are stored in the URL, so a link opens the same view, and the browser's Back button returns to the previous player.

## Getting the data

The scraped match data isn't in this repository: FotMob's terms don't allow redistributing it. `data/players.js` and `data/ratings.js`, which the dashboard reads, are included, so the page works without scraping. To rebuild them:

```bash
pip install pandas requests scikit-learn
python scrape.py              # matches and player pages for the leagues switched on in leagues.json
python transfermarkt.py       # Transfermarkt values, matched to the scraped players
python build_data.py          # data/players.js for the dashboard
python value_model.py         # retrain the value model, write data/ratings.js
```

`leagues.json` lists the leagues the scraper knows. Set `"scrape": true` to include one; `seasons` are shown in the dashboard and graded by the model, `history` seasons only feed the model's last-season features. The dashboard and the model use `dashboard_league`. Each league gets its own folder, `raw/<league>/`, with a `matches_<season>.csv` and an `unavailable_<season>.csv` (injured and suspended players) per season. Player pages go to `raw/players/` and are shared between leagues, so a player who played in two leagues is stored once.

Every save merges with the existing file and drops duplicates on a key: match and player for matches, player for player info, player and date for the value history. Running the scraper twice, or for two leagues with the same player, never creates double rows.

Useful options: `--league eredivisie` or `--season 2026-2027` to limit a run, `--no-players` or `--players-only`, and `--reparse` to rebuild the CSVs from the cache after changing what the parser extracts. The scraper is incremental: it only downloads matches that aren't in the CSV yet and player pages older than 30 days, so a weekly update takes a few minutes. Downloaded pages are kept compressed in `cache/`. Failed downloads are retried after 2, 4 and 8 seconds. A full season from scratch takes 10-15 minutes, and the player pages for one league about an hour.

`transfermarkt.py` downloads the open [transfermarkt-datasets](https://github.com/dcaribou/transfermarkt-datasets) (CC0) rather than scraping transfermarkt.com. FotMob and Transfermarkt use different player ids, so players are matched on date of birth plus a similar name, or an identical name born in the same year when the two sites disagree on the birthday. Over 99% of players match. The dataset's updates were paused in mid-2026; its last values are from June 2026.

## Positions

FotMob records the formation slot each starter played in. `build_data.py` maps those slots to seven roles: goalkeeper, centre back, full back (including wing-backs), central midfielder, attacking midfielder, winger and striker. A player's role is the one they played the most minutes in during the selected period. Players who only came off the bench get FotMob's broad position (defender, midfielder or forward).

## Value rating

`value_model.py` predicts each outfield player's log market value from 15 features plus position:

- **This season:** age, team points per game, FotMob rating, Dutch nationality, and eight per-90 or accuracy stats.
- **Club reputation:** the average market value of his teammates that season, excluding himself.
- **Last season:** FotMob rating in the previous Eredivisie season, plus a flag for players without one. 2022-23 is scraped for this purpose only.

Playing time is deliberately left out. It explains prices, because the market pays for regulars, but it says how much a player plays, not how well. Without it, R² fell from 0.83 to 0.81, while the out-of-sample backtest below improved (A 72% instead of 65%, B 50% instead of 38%).

Adding club reputation and last season raised the out-of-fold R² from 0.72 to 0.81. It trains on one row per player per season, pooling the league's seasons.

- **Shrinkage.** Per-90 stats and the FotMob rating are pulled towards the position average for that season. A player's own numbers count for minutes / (minutes + 450), so half at 450 minutes and about 86% over a full season. Of the weights tested (0, 450, 900, 1,800 and 3,600 minutes), 450 gave the best out-of-fold R².
- **Out-of-fold predictions.** Players are split into five folds, and each player's value comes from a model trained without any of his seasons. The split is repeated five times and averaged.
- **Market values.** Each player-season uses the value nearest to the season's last match, from the value history on the player's FotMob page (SciSports estimates, monthly in recent years). A player-season also needs an age and enough minutes, which leaves 921 player-seasons across 2023-24 to 2026-27.
- **Three models.** Ridge regression, a random forest and gradient boosting are all evaluated. A tree model only replaces the ridge regression if its out-of-fold R² is at least 0.02 higher, because tree models can't extrapolate beyond the prices they have seen (the forest's calibration slope is 1.11: its predictions are squeezed towards the average price). On the current data the ridge regression is used: R² 0.81 and a typical error of ×1.51, against 0.82 for gradient boosting and 0.79 for the forest. The chosen model gets a linear calibration.
- **Grades.** A needs an expected value at least 2× the actual value, B at least 1.25×. Both also need a FotMob rating at or above the median for the position and an age of 27 or younger. Older players who meet the other conditions get a C with a note.
- **Backtest.** R² only measures how well the model explains today's prices. The real question is whether an "undervalued" player's price goes up afterwards, so the script compares each graded player's value with his value 365 days later. The value history follows players wherever they go, including those sold abroad or relegated. The grade rules come from this test: a gap predicted nothing for players rated below their position's median or older than 27. Because the rules were chosen on the same seasons, the script also runs an out-of-sample check: for each season with a known outcome, it picks the best rules on the other season and applies them to this one. Out-of-sample, 72% of A players rose in value (95% range 49-88%, n=18), 50% of B players (34-66%, n=34) and 27% of C players. All players who pass the same age and rating filters, whatever their gap, rose 45% of the time. A is clearly better than that baseline; B only slightly. In-sample, 89% of A players rose, which shows how much tuning rules on the test data flatters them.
- **Price.** Expensive players rose in value more often in general (43% of C players in the most expensive third, against 17% in the cheapest). Within the cheapest third, every A/B player rose (n=11); within the most expensive third, A/B players did no better than C (44% against 43%). The model helps most for cheaper players. With price and age held constant, the gap correlates +0.23 with the later value change.
- **Forward test.** Trained only on earlier seasons and tested on the next, the model reaches R² 0.76-0.81. For 2024-25, the first season with a known outcome, the gap correlates +0.25 with the later value change.
- **Growth model.** A second model predicts the value change directly from the features, the gap and the current value. It did no better than age and gap alone (correlation +0.36 against +0.37), so the grades keep the simpler rules.
- **Transfermarkt.** `python value_model.py --source transfermarkt` uses Transfermarkt values instead. Transfermarkt prices are explained slightly better (R² 0.86), but the gap predicts their later change much worse (backtest correlation +0.05, against +0.16 for SciSports). Transfermarkt values follow transfers that have already happened and change about twice a year, so there's less for the model to anticipate.
- **Extra features.** `feature_test.py` tests candidate features against the backtest: touches, times dispossessed, fouls won, recoveries and long balls (aimed at central midfielders), international caps before the season, and height. None changed the backtest by more than 0.003, so none was added. Playing time is tested the same way, as a candidate.
- **Position.** Four position-aware variants were tested against the backtest: stats relative to the position average, separate weights per position line, only position-relevant stats, and gradient boosting. None of them improved the backtest, because position is already a feature: the model learns that centre backs rarely dribble. The gap predicts least for central midfielders (correlation +0.1, against +0.5 for strikers), probably because what makes them valuable (positioning, press resistance) isn't in FotMob's stats.
- **Price bias.** The script prints the grade mix per band of expected value and per band of actual price. Cheap players still get more A and B grades, partly through regression to the mean: the gap correlates with actual price at −√(1 − R²).
- **Reasons.** For each feature, the script sets it to the median for the player's position and records how much the expected value drops. The largest effects become the explanation shown in the dashboard.

Contract length and injury history are not in the model, and they explain part of every gap. FotMob's player page shows only the current contract, which says nothing about earlier seasons, and its injury lists are too incomplete to use.

## Files

| File | Purpose |
|---|---|
| `index.html`, `style.css`, `app.js` | The dashboard |
| `data/players.js` | One row per player per match, generated by `build_data.py` |
| `data/ratings.js` | Value grades and reasons, generated by `value_model.py` |
| `leagues.json` | Which leagues and seasons to scrape |
| `scrape.py` | FotMob scraper: matches and player pages, into `raw/` (not in git) |
| `transfermarkt.py` | Transfermarkt values from transfermarkt-datasets, matched to FotMob players |
| `build_data.py` | Turns the raw CSVs into `data/players.js` |
| `value_model.py` | Trains the value model and writes `data/ratings.js` |
| `feature_test.py` | Tests candidate features against the backtest |
