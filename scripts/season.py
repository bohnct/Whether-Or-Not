"""Build data/season.json: growing-season rainfall and hail reports around Rhein, SK.

Rainfall: Environment Canada's Regional Deterministic Precipitation Analysis (RDPA), a 10 km
daily analysis that blends radar with rain gauges (archive from Oct 2012), read as raw values
from MSC GeoMet's coverage service on a 12 x 12 grid (~9 km cells) over a ~110 km box.

Hail: Integrated Canadian Hail Database 2005-2022 (Brunet & Brimelow, ECCC / Northern Hail
Project), CC BY 4.0, https://doi.org/10.5281/zenodo.8015925

Run nightly by .github/workflows/season.yml. Safe to re-run: it only fetches days it doesn't
have yet. Standard library only.
"""
import csv
import datetime as dt
import io
import json
import os
import time as time_module
import urllib.request
from concurrent.futures import ThreadPoolExecutor

CENTRE = (51.35, -102.20)                                   # Rhein, SK
BOX = {"lat0": 50.85, "lat1": 51.85, "lon0": -103.0, "lon1": -101.4}
SIZE = 12                                                    # cells per side
SEASON = ((5, 1), (9, 30))                                   # May 1 - Sep 30
FIRST_YEAR = 2013                                            # first full season in the archive
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "season.json")

WCS = ("https://geo.weather.gc.ca/geomet?service=WCS&version=2.0.1&request=GetCoverage"
       "&coverageId=RDPA.24F_PR&subsettingCrs=EPSG:4326&outputCrs=EPSG:4326&format=image/x-aaigrid"
       "&subset=lat({lat0},{lat1})&subset=lon({lon0},{lon1})&scalesize=lon({n}),lat({n})&time={time}")
HAIL_CSV = "https://zenodo.org/api/records/8015925/files/integrated_canadian_hail_db.csv/content"


def season_days(year):
    start = dt.date(year, *SEASON[0])
    return [start + dt.timedelta(d) for d in range((dt.date(year, *SEASON[1]) - start).days + 1)]


def fetch_day(day):
    """Rainfall for one day as a flat list (north-west first), or None if not available yet.
    The analysis valid at 12 UTC the next morning covers 6 am to 6 am local (CST)."""
    time = f"{day + dt.timedelta(1)}T12:00:00Z"
    url = WCS.format(n=SIZE, time=time, **BOX)
    text = ""
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                text = r.read().decode("utf8", "replace")
            break
        except OSError:
            time_module.sleep(2 * (attempt + 1))
    lines = text[text.find("ncols"):].splitlines() if "ncols" in text else []
    values = []
    for line in lines[6:]:
        if line.startswith("--"):            # end of the multipart response
            break
        values += [round(max(float(v), 0), 1) for v in line.split()]
    return values if len(values) == SIZE * SIZE else None


def fetch_hail():
    """Hail reports within the box (plus a margin), oldest first."""
    with urllib.request.urlopen(HAIL_CSV, timeout=120) as r:
        rows = csv.DictReader(io.StringIO(r.read().decode("utf8")))
        out = []
        for row in rows:
            lat, lon = float(row["Latitude"]), float(row["Longitude"])
            if BOX["lat0"] - 0.3 <= lat <= BOX["lat1"] + 0.3 and BOX["lon0"] - 0.4 <= lon <= BOX["lon1"] + 0.4:
                when = dt.datetime.strptime(row["Start Time"], "%m/%d/%Y %H:%M")
                out.append([when.strftime("%Y-%m-%dT%H:%MZ"), lat, lon, float(row["Hail Diameter (mm)"] or 0), row["Reference Object"]])
    return sorted(out)


def save(data):
    """Write the file, changing the timestamp only when the data itself changed."""
    old = json.load(open(OUT)) if os.path.exists(OUT) else {}
    if {k: v for k, v in old.items() if k != "updated"} == {k: v for k, v in data.items() if k != "updated"}:
        return
    data["updated"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print("wrote", OUT, os.path.getsize(OUT), "bytes")


def main():
    data = json.load(open(OUT)) if os.path.exists(OUT) else {}
    years = data.setdefault("years", {})
    data.update({
        "area": {**BOX, "size": SIZE, "centre": list(CENTRE), "name": "Rhein, SK"},
        "season": {"start": "%02d-%02d" % SEASON[0], "end": "%02d-%02d" % SEASON[1]},
        "sources": {
            "rain": "Environment and Climate Change Canada, Regional Deterministic Precipitation Analysis (RDPA)",
            "hail": "Integrated Canadian Hail Database 2005-2022, Brunet & Brimelow (ECCC / Northern Hail Project), CC BY 4.0",
        },
    })
    data.setdefault("hail", [])
    yesterday = dt.date.today() - dt.timedelta(1)
    last_year = yesterday.year if yesterday >= dt.date(yesterday.year, *SEASON[0]) else yesterday.year - 1

    for year in range(FIRST_YEAR, last_year + 1):
        y = years.setdefault(str(year), {})
        days = [d for d in season_days(year) if d <= yesterday]
        cells = y.get("cells") or [None] * len(season_days(year))   # per-day cell values
        if y.get("complete"):
            continue
        todo = [i for i, d in enumerate(days) if cells[i] is None]
        if todo:
            print(f"{year}: fetching {len(todo)} days")
            with ThreadPoolExecutor(8) as pool:
                for i, values in zip(todo, pool.map(fetch_day, [days[i] for i in todo])):
                    cells[i] = values
        got = [c for c in cells if c is not None]
        if not got:                                   # nothing available (e.g. network down)
            del years[str(year)]
            continue
        y["days"] = len(got)
        y["total"] = [round(sum(c[k] for c in got), 1) for k in range(SIZE * SIZE)]
        y["dailyMean"] = [None if c is None else round(sum(c) / len(c), 2) for c in cells[:len(days)]]
        # A finished season with only a few days missing from EC's archive counts as complete
        missing = len(season_days(year)) - len(got)
        y["complete"] = missing == 0 or (year < last_year and missing <= 5)
        y["missing"] = missing
        # Keep per-cell daily values only while a season is still filling in, and for the latest
        # season (the app draws a tapped cell's day-by-day chart from it)
        y["cells"] = cells if (not y["complete"] or year == last_year) else None
        if y["cells"] is None:
            del y["cells"]
        save(data)                                    # keep progress if a later season fails

    for year, y in years.items():                     # drop daily cells from older seasons
        if int(year) != last_year and y.get("complete"):
            y.pop("cells", None)

    if not data["hail"]:
        try:
            data["hail"] = fetch_hail()
        except OSError as e:
            print("hail download failed, will retry next run:", e)
    save(data)


if __name__ == "__main__":
    main()
