# Eredivisie player stats

An interactive dashboard of Eredivisie player statistics, built from FotMob match data. It runs as a static page: open `index.html` in a browser, or host the folder on GitHub Pages.

## What's in it

- **Filters** for season or a custom date range, position (broad or detailed), team and minimum minutes. Stats show per 90 or as totals. **Find player** in the same bar opens a player's profile.
- **Explorer**: a scatter plot of two metrics, split at the median into four quadrants. Preset views each answer one question (finishing, shot selection, chance creation, defensive style and more), and picking your own X axis suggests Y metrics that pair well with it.
- **Value rating**: grades outfield players A (very undervalued), B (undervalued) or C (fairly valued or expensive) by comparing their market value with what a model expects from their performance. Every grade comes with the reasons behind it. The list of undervalued players can be narrowed by grade and maximum age.
- **Top 15** for any metric.
- **Player profile** with percentiles against the same position, the same line or all outfield players, and the FotMob rating for every match. **Compare with player** puts a second player next to him in every part of the profile.
- **Table** of all players in the current filter, sortable by any column. Players who played for more than one club in the selected period are marked ⇄.

The ⓘ buttons, the percentile tooltips and the table headers explain each metric. All settings, including the open player, are stored in the URL, so a link opens the same view, and the browser's Back button returns to the previous player.

## Updating the data

```bash
pip install pandas requests
python scrape.py 2026-2027        # fetch matches that aren't in raw/ yet
python build_data.py              # rebuild data/players.js from everything in raw/
pip install scikit-learn
python value_model.py             # retrain the value model, write data/ratings.js
```

The scraper is incremental: it only downloads matches that aren't in the season's CSV yet, so a weekly update takes seconds. Every downloaded match page is saved compressed in `cache/` (about 3 MB per 100 matches, not in git). To add a new field to the CSVs, change `parse_player_stats` in `scrape.py` and run `python scrape.py <season> --reparse`, which rebuilds the CSV from the cache without downloading anything. Failed downloads are retried three times, after 2, 4 and 8 seconds.

A full season from scratch takes 10-15 minutes, because the scraper waits one second between downloads. `python scrape.py 2022-2023 --history` writes to `raw_history/`, which the value model reads for last-season features but the dashboard doesn't show.

## Positions

FotMob records the formation slot each starter played in. `build_data.py` maps those slots to seven roles: goalkeeper, centre back, full back (including wing-backs), central midfielder, attacking midfielder, winger and striker. A player's role is the one they played the most minutes in during the selected period. Players who only came off the bench get FotMob's broad position (defender, midfielder or forward).

## Value rating

`value_model.py` predicts each outfield player's log market value from 17 features plus position:

- **This season:** age, share of minutes, team points per game, FotMob rating, Dutch nationality, and eight per-90 or accuracy stats.
- **Club reputation:** the average market value of his teammates that season, excluding himself.
- **Last season:** FotMob rating and share of minutes in the previous Eredivisie season, plus a flag for players without one. 2022-23 is scraped for this purpose only.

Adding club reputation and last season raised the out-of-fold R² from 0.72 to 0.81. It trains on one row per player per season, pooling every season in `raw/`.

- **Shrinkage.** Per-90 stats and the FotMob rating are pulled towards the position average for that season. A player's own numbers count for minutes / (minutes + 450), so half at 450 minutes and about 86% over a full season. Of the weights tested (0, 450, 900, 1,800 and 3,600 minutes), 450 gave the best out-of-fold R².
- **Out-of-fold predictions.** Players are split into five folds, and each player's value comes from a model trained without any of his seasons. The split is repeated five times and averaged.
- **Data checks.** FotMob stores no market value for many matches before 2025-26, so a player-season needs at least three value observations, and an age. That leaves 871 player-seasons across 2023-24 to 2026-27.
- **Three models.** Ridge regression, a random forest and gradient boosting are all evaluated. A tree model only replaces the ridge regression if its out-of-fold R² is at least 0.02 higher, because tree models can't extrapolate beyond the prices they have seen (the forest's calibration slope is 1.11: its predictions are squeezed towards the average price). On the current data the ridge regression is used: R² 0.81 and a typical error of ×1.54, against 0.82 for gradient boosting and 0.79 for the forest. The chosen model gets a linear calibration.
- **Grades.** A needs an expected value at least 2× the actual value, a FotMob rating at or above the median for the position, and an age of 30 or younger. B needs at least 1.5×. Both thresholds sit above the model's typical error, so a grade isn't triggered by noise alone. Players over 30 who meet the other A conditions get a B with a note: their low price mostly reflects how few seasons they have left, which makes them poor resale buys.
- **Price bias.** The script prints the grade mix per band of expected value and per band of actual price. Cheap players still get more A and B grades, partly through regression to the mean: the gap correlates with actual price at −√(1 − R²).
- **Reasons.** For each feature, the script sets it to the median for the player's position and records how much the expected value drops. The largest effects become the explanation shown in the dashboard.

Contract length, injury history and international reputation are not in the data, and they explain part of every gap.

## Files

| File | Purpose |
|---|---|
| `index.html`, `style.css`, `app.js` | The dashboard |
| `data/players.js` | One row per player per match, generated by `build_data.py` |
| `raw/` | Scraped CSVs, one per season |
| `raw_history/` | Older seasons, used only for the model's last-season features |
| `scrape.py` | FotMob scraper |
| `build_data.py` | Turns the raw CSVs into `data/players.js` |
| `value_model.py` | Trains the value model and writes `data/ratings.js` |
