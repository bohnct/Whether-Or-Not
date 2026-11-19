"""Build the growing-season rainfall data used by the Season map.

Source: Environment Canada's Regional Deterministic Precipitation Analysis (RDPA), a 10 km daily
analysis blending radar with rain gauges (archive from Oct 2012), read from MSC GeoMet.

The app must show any location in about a second, so season totals are calculated here ahead of
time and stored in two binary files that the app reads a small slice of (HTTP Range requests):

  data/rain.json          description of the grid, the years and the files below
  data/rain-archive.bin   finished seasons
  data/rain-current.bin   the latest season, updated nightly

Both .bin files are little-endian uint16 values split into tiles of 16 x 16 cells (north-west
first). One tile-season record is 16 x 16 cell totals (0.1 mm) followed by the tile's mean rainfall
for each day of the season (0.01 mm, 65535 = day missing). The archive stores each tile's records
for all years side by side, oldest first.

Run nightly by .github/workflows/season.yml. Safe to re-run: it only fetches days it doesn't have.
Standard library only.
"""
import array
import datetime as dt
import json
import os
import sys
import tempfile
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

GRID = {"lat0": 42.4, "lat1": 60.0, "lon0": -140.0, "lon1": -51.2, "rows": 176, "cols": 592, "tile": 16}
SEASON = ((5, 1), (9, 30))        # May 1 - Sep 30
FIRST_YEAR = 2013                 # first full season in the archive
MISSING = 65535

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
META, ARCHIVE, CURRENT = (os.path.join(DATA, f) for f in ("rain.json", "rain-archive.bin", "rain-current.bin"))
BUILD = os.path.join(tempfile.gettempdir(), "rain-build")   # finished years, so a backfill can resume

WCS = ("https://geo.weather.gc.ca/geomet?service=WCS&version=2.0.1&request=GetCoverage"
       "&coverageId=RDPA.24F_PR&subsettingCrs=EPSG:4326&outputCrs=EPSG:4326&format=image/x-aaigrid"
       "&subset=lat({lat0},{lat1})&subset=lon({lon0},{lon1})&scalesize=lon({cols}),lat({rows})&time={time}")

ROWS, COLS, TILE = GRID["rows"], GRID["cols"], GRID["tile"]
TILES = (ROWS // TILE) * (COLS // TILE)
CELLS = TILE * TILE
DAYS = (dt.date(2001, *SEASON[1]) - dt.date(2001, *SEASON[0])).days + 1
RECORD = CELLS + DAYS             # uint16 values per tile-season

# Where each grid cell's total is stored within a season's record array
TILE_OF = [(r // TILE) * (COLS // TILE) + c // TILE for r in range(ROWS) for c in range(COLS)]
SLOT_OF = [TILE_OF[r * COLS + c] * RECORD + (r % TILE) * TILE + c % TILE for r in range(ROWS) for c in range(COLS)]


def season_days(year):
    start = dt.date(year, *SEASON[0])
    return [start + dt.timedelta(d) for d in range(DAYS)]


def empty_record():
    rec = array.array("H", [0]) * (TILES * RECORD)
    for t in range(TILES):
        for d in range(DAYS):
            rec[t * RECORD + CELLS + d] = MISSING
    return rec


def fetch_day(day):
    """One day's rainfall for the whole grid (north-west first), or None if unavailable.
    The analysis valid at 12 UTC the next morning covers roughly 6 am to 6 am on the Prairies."""
    url = WCS.format(time=f"{day + dt.timedelta(1)}T12:00:00Z", **GRID)
    text = ""
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                text = r.read().decode("ascii", "replace")
            break
        except OSError:
            time.sleep(3 * (attempt + 1))
    values = array.array("f")
    for line in text[text.find("ncols"):].splitlines() if "ncols" in text else []:
        if line.startswith("--"):           # end of the multipart response
            break
        if line[:1].isalpha():              # header line
            continue
        values.extend(max(float(v), 0) for v in line.split())
    return values if len(values) == ROWS * COLS else None


def add_day(rec, index, values):
    """Add one day to a season record."""
    sums = [0.0] * TILES
    for k, v in enumerate(values):
        sums[TILE_OF[k]] += v
        slot = SLOT_OF[k]
        rec[slot] = min(rec[slot] + round(v * 10), MISSING - 1)
    for t, s in enumerate(sums):
        rec[t * RECORD + CELLS + index] = min(round(s / CELLS * 100), MISSING - 1)


def fill(rec, year, last_day):
    """Fetch and add every day of the season that the record doesn't have yet."""
    days = season_days(year)
    todo = [i for i in range(DAYS) if days[i] <= last_day and rec[CELLS + i] == MISSING]
    if todo:
        print(f"{year}: fetching {len(todo)} days", flush=True)
        with ThreadPoolExecutor(8) as pool:
            for i, values in zip(todo, pool.map(fetch_day, [days[i] for i in todo])):
                if values is not None:
                    add_day(rec, i, values)
    return len(todo)


def missing_days(rec):
    return sum(rec[CELLS + i] == MISSING for i in range(DAYS))


def finished_year(year):
    """A complete past season, built once and kept in the build folder."""
    path = os.path.join(BUILD, f"{year}.bin")
    rec = array.array("H")
    if os.path.exists(path):
        with open(path, "rb") as f:
            rec.frombytes(f.read())
        return rec
    rec = empty_record()
    fill(rec, year, dt.date(year, *SEASON[1]))
    if missing_days(rec) > 5:
        sys.exit(f"{year}: {missing_days(rec)} days could not be downloaded; run again later")
    os.makedirs(BUILD, exist_ok=True)
    with open(path, "wb") as f:
        rec.tofile(f)
    return rec


def read(path):
    rec = array.array("H")
    with open(path, "rb") as f:
        rec.frombytes(f.read())
    return rec


def main():
    meta = json.load(open(META)) if os.path.exists(META) else {}
    yesterday = dt.date.today() - dt.timedelta(1)
    latest = yesterday.year if yesterday >= dt.date(yesterday.year, *SEASON[0]) else yesterday.year - 1
    years = list(range(FIRST_YEAR, latest))
    current_year = meta.get("current", {}).get("year")

    # Finished seasons: reuse what the archive has, and only build what's new
    if meta.get("years") != years:
        old_years = meta.get("years", [])
        old = read(ARCHIVE) if old_years else None
        records = {}
        for y in years:
            if y in old_years:
                n = old_years.index(y)
                records[y] = array.array("H", (old[t * len(old_years) * RECORD + n * RECORD + j]
                                               for t in range(TILES) for j in range(RECORD)))
            elif y == current_year:
                records[y] = read(CURRENT)
                fill(records[y], y, dt.date(y, *SEASON[1]))
            else:
                records[y] = finished_year(y)
        merged = array.array("H")
        for t in range(TILES):
            for y in years:
                merged.extend(records[y][t * RECORD:(t + 1) * RECORD])
        os.makedirs(DATA, exist_ok=True)
        with open(ARCHIVE, "wb") as f:
            merged.tofile(f)
        meta["years"] = years
        changed = True
    else:
        changed = False

    # Latest season
    rec = read(CURRENT) if current_year == latest else empty_record()
    changed |= current_year != latest
    before = missing_days(rec)
    fill(rec, latest, yesterday)
    changed |= missing_days(rec) != before

    if changed:
        with open(CURRENT, "wb") as f:
            rec.tofile(f)
        meta.update({
            "grid": GRID,
            "season": {"start": "%02d-%02d" % SEASON[0], "end": "%02d-%02d" % SEASON[1], "days": DAYS},
            "current": {"year": latest, "days": DAYS - missing_days(rec)},
            "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
            "source": "Environment and Climate Change Canada, Regional Deterministic Precipitation Analysis (RDPA)",
        })
        with open(META, "w") as f:
            json.dump(meta, f, separators=(",", ":"))
        print("updated", meta["current"], flush=True)
    else:
        print("no new data", flush=True)


if __name__ == "__main__":
    main()
