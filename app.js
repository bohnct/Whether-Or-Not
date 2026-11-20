/* My Weather — Environment Canada PWA
 * Data:     api.weather.gc.ca (city page forecasts, SWOB observations, PROGNOS model forecasts)
 * Radar:    geo.weather.gc.ca (MSC GeoMet WMS, 1 km North American composite)
 */
"use strict";

const EC_API = "https://api.weather.gc.ca/collections";
const GEOMET = "https://geo.weather.gc.ca/geomet";
const BASEMAP = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/{style}/MapServer/tile/{z}/{y}/{x}";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ============================================================
 * Settings (persisted in localStorage)
 * ============================================================ */
const DEFAULTS = {
  theme: "auto",        // auto | day | night
  tempUnit: "C",        // C | F
  windUnit: "kmh",      // kmh | mph
  startLoc: "current",  // current | home
  home: null,           // [name, province, lat, lon]
  saved: [],            // more [name, province, lat, lon] places
  radarType: "auto",    // auto | rain | snow
  mapMode: "radar",     // radar | pressure
  radarOpacity: 0.8,
  radarSpeed: 500,
  showLabels: true,
};

const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("settings") || "{}") };
const saveSettings = () => localStorage.setItem("settings", JSON.stringify(settings));

const state = {
  loc: settings.startLoc, // which location is active
  city: null,             // [name, province, lat, lon] being shown
  wx: null,               // normalized forecast data
  view: "now",
};

/* ============================================================
 * Helpers
 * ============================================================ */
const en = (v) => (v && typeof v === "object" && "en" in v ? v.en : v);
const num = (v) => (v == null || v === "" || isNaN(+en(v)) ? null : +en(v));

const temp = (c) => (c == null ? "--" : Math.round(settings.tempUnit === "F" ? c * 9 / 5 + 32 : c));
const wind = (k) => (k == null ? "--" : Math.round(settings.windUnit === "mph" ? k * 0.621371 : k));
const windUnit = () => (settings.windUnit === "mph" ? "mph" : "km/h");

const fmtHour = (d) => d.toLocaleTimeString([], { hour: "numeric" });
const fmtTime = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function toast(msg, ms = 3000) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

function nearestCity(lat, lon) {
  let best = null, bestD = Infinity;
  for (const c of EC_CITIES) {
    const d = distanceKm(lat, lon, c[2], c[3]);
    if (d < bestD) { best = c; bestD = d; }
  }
  return best;
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not supported"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve([p.coords.latitude, p.coords.longitude]),
      reject,
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 10 * 60 * 1000 }
    );
  });
}

/* ============================================================
 * Environment Canada data
 *  - City page:  official current conditions, 24 h hourly + 7-day periods
 *  - SWOB:       station observations (history)
 *  - PROGNOS:    EC model point forecasts (RDPS 3.5 days, GDPS 7 days)
 * ============================================================ */
const HOUR = 3600e3, DAY = 24 * HOUR;

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Environment Canada returned ${res.status}`);
  return res.json();
}

async function fetchCityPage(city) {
  const [name, , lat, lon] = city;
  const d = 0.03;
  const { features = [] } = await getJSON(`${EC_API}/citypageweather-realtime/items?f=json&lang=en&bbox=${lon - d},${lat - d},${lon + d},${lat + d}`);
  const f = features.find((x) => en(x.properties.name) === name) || features[0];
  if (!f) throw new Error("No forecast found for this location");
  return normalize(f.properties);
}

/** Hourly observations from the forecast's reporting station. */
async function fetchObservations(stationCode, from) {
  if (!stationCode) return [];
  const code = stationCode.toUpperCase();
  // Airports (Yxx) are indexed by ICAO id, automatic stations by Transport Canada id
  const filter = code.startsWith("Y") ? `icao_stn_id-value=C${code}` : `tc_id-value=${code}`;
  const props = ["date_tm-value", "air_temp", "rel_hum", "mslp",
    "avg_wnd_spd_10m_pst10mts", "avg_wnd_dir_10m_pst10mts", "avg_wnd_spd_10m_pst2mts", "avg_wnd_dir_10m_pst2mts",
    "max_wnd_gst_spd_10m_pst10mts", "pcpn_amt_pst1hr", "pcpn_amt_pst6hrs"].join(",");
  const { features = [] } = await getJSON(`${EC_API}/swob-realtime/items?f=json&${filter}` +
    `&datetime=${new Date(from).toISOString().slice(0, 19)}Z/..&sortby=date_tm-value&limit=10000&skipGeometry=true&properties=${props}`);

  return features.map(({ properties: p }) => ({
    t: Date.parse(p["date_tm-value"]),
    temp: p.air_temp, rh: p.rel_hum, mslp: p.mslp,
    ws: p.avg_wnd_spd_10m_pst10mts ?? p.avg_wnd_spd_10m_pst2mts,
    wd: p.avg_wnd_dir_10m_pst10mts ?? p.avg_wnd_dir_10m_pst2mts,
    gust: p.max_wnd_gst_spd_10m_pst10mts,
    p1: p.pcpn_amt_pst1hr, p6: p.pcpn_amt_pst6hrs,
  })).filter((o) => new Date(o.t).getUTCMinutes() % 10 === 0); // thin 1-minute stations to 10-minute steps
}

/** Latest complete PROGNOS run for the nearest forecast station. */
async function fetchModel(lat, lon) {
  const base = (m) => `${EC_API}/prognos-${m}-realtime/items?f=json`;
  const iso = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

  async function nearestStation(m, ref) {
    for (const d of [1.5, 5]) {
      const { features = [] } = await getJSON(`${base(m)}&limit=500&reference_datetime=${ref}` +
        `&bbox=${lon - d * 1.5},${lat - d},${lon + d * 1.5},${lat + d}&forecast_leadtime=PT000H&variable=AirTemp&properties=ade_id`);
      if (!features.length) continue;
      const dist = (f) => distanceKm(lat, lon, f.geometry.coordinates[1], f.geometry.coordinates[0]);
      return features.reduce((a, b) => (dist(b) < dist(a) ? b : a)).properties.ade_id;
    }
    return null;
  }

  async function series(m, ref, station, minPoints) {
    const { features = [] } = await getJSON(`${base(m)}&skipGeometry=true&limit=2000&ade_id=${station}` +
      `&reference_datetime=${ref}&properties=forecast_datetime,forecast_value,variable`);
    if (features.filter((f) => f.properties.variable === "AirTemp").length < minPoints) return null;
    const out = {};
    for (const { properties: p } of features) (out[p.variable] ||= []).push([Date.parse(p.forecast_datetime), p.forecast_value]);
    Object.values(out).forEach((s) => s.sort((a, b) => a[0] - b[0]));
    return out;
  }

  // Newest run first; a run that's still arriving is incomplete, so step back to the previous one
  async function bestRun(m, stepHours, minPoints, station) {
    const { features } = await getJSON(`${base(m)}&skipGeometry=true&limit=1&sortby=-reference_datetime&properties=reference_datetime`);
    const latest = Date.parse(features[0].properties.reference_datetime);
    for (let i = 0; i < 3; i++) {
      const ref = iso(latest - i * stepHours * HOUR);
      const st = station || (await nearestStation(m, ref));
      const out = st && (await series(m, ref, st, minPoints));
      if (out) return { station: st, ...out };
    }
    return null;
  }

  const rdps = await bestRun("rdps", 6, 70);
  if (!rdps) return null;
  const gdps = await bestRun("gdps", 12, 100, rdps.station).catch(() => null);
  const K = (s) => (s || []).map(([t, v]) => [t, v - 273.15]);
  return {
    station: rdps.station,
    temp: K(rdps.AirTemp), dew: K(rdps.DewPoint), wind: rdps.WindSpeed || [], dir: rdps.WindDir || [],
    tempLong: K(gdps?.AirTemp),
  };
}

/**
 * Expected rain (mm) and snow (cm) from now on, from EC's global model (GDPS) at this location:
 * [[time, rain so far, snow so far], ...]. Snow is liquid equivalent; 1 mm is about 1 cm of snow.
 */
async function fetchExpected(lat, lon) {
  const d = 0.1, base = `${GEOMET}?service=WMS&version=1.3.0&request=GetFeatureInfo&crs=EPSG:4326` +
    `&bbox=${lat - d},${lon - d},${lat + d},${lon + d}&width=3&height=3&i=1&j=1&info_format=application/json`;
  const RAIN = "GDPS_15km_Rain-Accum", SNOW = "GDPS_15km_Snow-Accum";

  // The latest model run, so every value below comes from the same forecast
  const caps = await (await fetch(`${GEOMET}?service=WMS&version=1.3.0&request=GetCapabilities&layer=${RAIN}`)).text();
  const ref = new DOMParser().parseFromString(caps, "text/xml").querySelector('Dimension[name="reference_time"]').getAttribute("default");
  const run = Date.parse(ref);

  // The server returns no feature where the accumulation is zero
  const point = async (layer, t) => {
    const url = `${base}&layers=${layer}&query_layers=${layer}&time=${wmsTime(t)}&dim_reference_time=${ref}`;
    return (await getJSON(url)).features?.[0]?.properties.value ?? 0;
  };
  const start = Math.floor(Date.now() / HOUR) * HOUR;
  const [startRain, startSnow] = await Promise.all([point(RAIN, start), point(SNOW, start)]);

  // Every 3 h for a day, every 6 h for the next two, then every 12 h out to a week
  const h0 = Math.round((start - run) / HOUR), hours = [];
  for (let h = Math.ceil((h0 + 1) / 3) * 3; h <= h0 + 168 && h <= 240; h += 3) {
    const ahead = h - h0;
    if (ahead <= 24 || (ahead <= 72 && h % 6 === 0) || h % 12 === 0) hours.push(h);
  }
  const values = new Array(hours.length);
  let next = 0;
  const worker = async () => {
    while (next < hours.length) {
      const i = next++, t = run + hours[i] * HOUR;
      const [r, s] = await Promise.all([point(RAIN, t), point(SNOW, t)]).catch(() => []);
      if (r != null) values[i] = [t, r, s];
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  const out = [[Date.now(), 0, 0]];
  for (const v of values.filter(Boolean)) {
    const [, r0, s0] = out[out.length - 1];
    out.push([v[0], Math.max(r0, v[1] - startRain), Math.max(s0, v[2] - startSnow)]);
  }
  return out;
}

/** The expected amounts for a city, reusing a recent download. */
async function loadExpected(city) {
  const key = `exp:${city[0]}`, saved = JSON.parse(localStorage.getItem(key) || "null");
  if (saved && Date.now() - saved.at < HOUR) return saved.list;
  const list = await fetchExpected(city[2], city[3]);
  localStorage.setItem(key, JSON.stringify({ at: Date.now(), list }));
  return list;
}

function normalize(p) {
  const cc = p.currentConditions || {};
  const hourly = (p.hourlyForecastGroup?.hourlyForecasts || []).map((h) => ({
    t: Date.parse(h.timestamp),
    temp: num(h.temperature?.value),
    icon: num(h.iconCode?.value),
    cond: en(h.condition),
    pop: num(h.lop?.value) || 0,
    wind: num(h.wind?.speed?.value),
    gust: num(h.wind?.gust?.value),
    feels: num(h.windChill?.value) ?? num(h.humidex?.value),
    dir: compassDeg(en(h.wind?.direction?.value)),
  }));

  return {
    name: en(p.name),
    region: en(p.region),
    updated: Date.parse(p.lastUpdated),
    current: {
      temp: num(cc.temperature?.value),
      cond: en(cc.condition) || hourly[0]?.cond || "",
      icon: num(cc.iconCode?.value) ?? hourly[0]?.icon,
      feels: num(cc.windChill?.value) ?? num(cc.humidex?.value),
      humidity: num(cc.relativeHumidity?.value),
      dewpoint: num(cc.dewpoint?.value),
      wind: num(cc.wind?.speed?.value),
      gust: num(cc.wind?.gust?.value),
      dir: en(cc.wind?.direction?.value),
      pressure: num(cc.pressure?.value),
      tendency: en(cc.pressure?.tendency),
      station: en(cc.station?.value),
      stationCode: en(cc.station?.code),
    },
    hourly,
    periods: (p.forecastGroup?.forecasts || []).map((f) => {
      const value = en(f.period?.value) || "";
      const night = /night/i.test(value);
      const text = en(f.textSummary) || "";
      return {
        label: en(f.period?.textForecastName),
        night,
        span: periodSpan(value),
        icon: num(f.abbreviatedForecast?.icon?.value),
        summary: en(f.abbreviatedForecast?.textSummary),
        text,
        temp: num(f.temperatures?.temperature?.[0]?.value),
        pop: +(text.match(/(\d+)\s*percent/i)?.[1] || 0),
        kind: precipKind(text),
        uv: num(f.uv?.index),
        uvCategory: en(f.uv?.category),
        wind: num(f.winds?.periods?.[0]?.speed?.value),
        dir: num(f.winds?.periods?.[0]?.bearing?.value),
        gust: Math.max(0, ...(f.winds?.periods || []).map((w) => num(w.gust?.value) || 0)) || null,
      };
    }),
    warnings: (p.warnings || []).filter((w) => en(w.type) !== "ended").map((w) => ({
      type: en(w.type), level: en(w.alertColourLevel), title: en(w.description), url: en(w.url),
      expires: Date.parse(en(w.expiryTime)) || null,
    })),
    sunrise: p.riseSet?.sunrise ? Date.parse(en(p.riseSet.sunrise)) : null,
    sunset: p.riseSet?.sunset ? Date.parse(en(p.riseSet.sunset)) : null,
  };
}

/** "Friday" / "Friday night" → [start, end] in local time (day 6 am–6 pm, night 6 pm–6 am). */
function periodSpan(value) {
  const night = /night/i.test(value);
  const name = value.replace(/\s*night$/i, "").toLowerCase();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // Start from yesterday: "Thursday night" is still current at 2 am Friday
  for (let k = -1; k < 8; k++) {
    const d = new Date(today); d.setDate(d.getDate() + k);
    if (d.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase() !== name) continue;
    const start = +d + (night ? 18 : 6) * HOUR;
    if (start + 12 * HOUR > Date.now()) return [start, start + 12 * HOUR];
  }
  return null;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compassDeg = (s) => (COMPASS.includes(s) ? COMPASS.indexOf(s) * 22.5 : null);
const degCompass = (d) => (d == null ? "" : COMPASS[Math.round(d / 22.5) % 16]);

function precipKind(text) {
  const t = (text || "").toLowerCase();
  const snow = /snow|flurr/.test(t), rain = /rain|shower|drizzle/.test(t);
  if (/freezing|ice pellet/.test(t) || (snow && rain)) return "mix";
  return snow ? "snow" : "rain";
}

const relHumidity = (T, Td) =>
  Math.min(100, 100 * Math.exp((17.625 * Td) / (243.04 + Td)) / Math.exp((17.625 * T) / (243.04 + T)));

/**
 * Environment Canada's wind chill (cold) and humidex (heat) formulas. Wind chill is valid up to
 * 10 °C; it fades out between 10 and 20 °C so the line has no sudden jumps.
 */
function feelsLike(T, wind, rh) {
  if (T >= 20) return rh == null ? T : Math.max(T, T + (5 / 9) * (6.112 * 10 ** ((7.5 * T) / (237.7 + T)) * (rh / 100) - 10));
  if (wind < 5) return T;
  const v = wind ** 0.16, chill = Math.min(T, 13.12 + 0.6215 * T - 11.37 * v + 0.3965 * T * v);
  return T <= 10 ? chill : chill + ((T - 10) / 10) * (T - chill);
}

/** Append points from `next` that fall after the end of `series`. */
const extend = (series, next) => {
  const end = series.length ? series[series.length - 1][0] : -Infinity;
  return series.concat(next.filter((p) => p[0] > end));
};

/**
 * Nudge the model temperatures (after the official hourly forecast ends) so each day's peak
 * matches EC's official high and each night's dip matches the official low. The correction is
 * blended smoothly between those anchor points, so the model's hour-to-hour shape is kept.
 */
function anchorToOfficial(pts, periods, officialEnd) {
  const fixed = periods.filter((p) => p.span && p.temp != null);
  let out = pts;
  for (let pass = 0; pass < 3; pass++) { // repeat: shifting the curve can move where the peak falls
    const anchors = [[officialEnd, 0]];    // no correction where the official hourly forecast ends
    for (const p of fixed) {
      const inPeriod = out.filter(([t]) => t >= p.span[0] && t < p.span[1] && t > officialEnd);
      if (inPeriod.length < 3) continue;
      const ext = inPeriod.reduce((a, b) => ((p.night ? b[1] < a[1] : b[1] > a[1]) ? b : a));
      anchors.push([ext[0], p.temp - ext[1]]);
    }
    anchors.sort((a, b) => a[0] - b[0]);
    out = out.map(([t, v]) => (t <= officialEnd ? [t, v] : [t, v + offsetAt(anchors, t)]));
  }
  return out;
}

/** Linear interpolation between anchors; holds the last value past the end. */
function offsetAt(anchors, t) {
  const i = anchors.findIndex(([at]) => at >= t);
  if (i === -1) return anchors[anchors.length - 1][1];
  if (i === 0) return anchors[0][1];
  const [t0, v0] = anchors[i - 1], [t1, v1] = anchors[i];
  return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0 || 1);
}

/** Merge observations, the official forecast and model output into chart series. */
function buildSeries(wx, obs = [], model = null) {
  const now = Date.now();
  const lastObs = obs.length ? obs[obs.length - 1].t : now;
  const pick = (k) => obs.filter((o) => o[k] != null).map((o) => [o.t, o[k]]);
  const after = (pts) => pts.filter((p) => p[0] > lastObs);

  // Temperature: official hourly → RDPS → GDPS
  let tempFc = after(wx.hourly.filter((h) => h.temp != null).map((h) => [h.t, h.temp]));
  const officialEnd = tempFc.length ? tempFc[tempFc.length - 1][0] : now;
  if (model) {
    tempFc = extend(extend(tempFc, after(model.temp)), after(model.tempLong));
    tempFc = anchorToOfficial(tempFc, wx.periods, officialEnd);
  }

  // Wind: official hourly → RDPS → forecast periods
  let windFc = after(wx.hourly.filter((h) => h.wind != null).map((h) => [h.t, h.wind]));
  let dirFc = wx.hourly.filter((h) => h.dir != null).map((h) => [h.t, h.dir]);
  if (model) { windFc = extend(windFc, after(model.wind)); dirFc = extend(dirFc, model.dir); }
  const periodWind = wx.periods.filter((p) => p.span && p.wind != null).map((p) => [(p.span[0] + p.span[1]) / 2, p.wind]);
  windFc = extend(windFc, periodWind);

  // Gusts: a gust is only reported when the wind is gusty, otherwise the gust line follows the wind
  const gustObs = obs.filter((o) => o.ws != null).map((o) => [o.t, Math.max(o.ws, o.gust ?? 0)]);
  const gustFc = windFc.map(([t, v]) => {
    const h = wx.hourly.find((x) => x.t === t);
    const p = !h && wx.periods.find((x) => x.span && t >= x.span[0] && t < x.span[1]);
    return [t, Math.max(v, (h ? h.gust : p?.gust) ?? 0)];
  });

  // Humidity forecast from model temperature + dew point
  const humFc = model ? after(model.dew.map(([t, td]) => {
    const T = Charts.valueAt(model.temp, t);
    return T == null ? null : [t, relHumidity(T, td)];
  }).filter(Boolean)) : [];

  // Feels like: EC's official hourly value where given, otherwise calculated the same way
  const feelsObs = obs.filter((o) => o.temp != null).map((o) => [o.t, feelsLike(o.temp, o.ws ?? 0, o.rh)]);
  const feelsFc = tempFc.map(([t, T]) => [t, wx.hourly.find((h) => h.t === t)?.feels
    ?? feelsLike(T, Charts.valueAt(windFc, t) ?? 0, Charts.valueAt(humFc, t))]);

  // Precipitation: observed amounts (1 h if reported, otherwise 6 h) and forecast chance
  const hourlyAmounts = obs.filter((o) => o.p1 != null);
  const obsBars = hourlyAmounts.length
    ? hourlyAmounts.filter((o) => new Date(o.t).getUTCMinutes() === 0).map((o) => [o.t - HOUR, o.t, o.p1])
    : obs.filter((o) => o.p6 != null).map((o) => [o.t - 6 * HOUR, o.t, o.p6]);
  const chance = wx.hourly.map((h) => [h.t, h.t + HOUR, h.pop, precipKind(h.cond)]);
  const hourlyEnd = chance.length ? chance[chance.length - 1][1] : now;
  for (const p of wx.periods) {
    if (!p.span || p.span[1] <= hourlyEnd) continue;
    chance.push([Math.max(p.span[0], hourlyEnd), p.span[1], p.pop, p.kind]);
  }

  // Official highs (day period, 6 am–6 pm) and lows (night period, 6 pm–6 am)
  const marks = wx.periods.filter((p) => p.span && p.temp != null)
    .map((p) => ({ t0: p.span[0], t1: p.span[1], v: p.temp, hi: !p.night }));

  return {
    temp: { obs: pick("temp"), fc: tempFc, marks, feelsObs, feelsFc },
    precip: { obs: obsBars, chance },
    wind: { obs: pick("ws"), fc: windFc, gustObs, gustFc, dirs: [...pick("wd"), ...after(dirFc)] },
    humidity: { obs: pick("rh"), fc: humFc },
    pressure: { obs: obs.filter((o) => o.mslp != null).map((o) => [o.t, o.mslp / 10]) },
  };
}

/* ============================================================
 * Weather icons (EC icon codes 0–48 → line-art SVG)
 * ============================================================ */
const ICON_KIND = {
  clear: [0, 30], partly: [1, 2, 4, 5, 21, 22, 31, 32, 34, 35], cloudy: [3, 10, 33],
  showers: [6, 36], mixShowers: [7, 37], flurries: [8, 38], rain: [11, 12, 13, 28],
  mix: [14, 15, 27], snow: [16, 17, 18, 25, 26, 40], thunder: [9, 19, 39, 46, 47],
  fog: [23, 24, 44, 45], wind: [41, 42, 43, 48],
};
const kindOf = (code) => Object.keys(ICON_KIND).find((k) => ICON_KIND[k].includes(code)) || "cloudy";

function sunSvg(cx, cy, r) {
  let rays = "";
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4, c = Math.cos(a), s = Math.sin(a);
    rays += `M${cx + c * (r + 4)} ${cy + s * (r + 4)}L${cx + c * (r + 8)} ${cy + s * (r + 8)}`;
  }
  return `<g class="sun"><circle class="sun-core" cx="${cx}" cy="${cy}" r="${r}"/><path d="${rays}"/></g>`;
}
const moonSvg = (cx, cy, r) =>
  `<path class="moon" d="M${cx + r * 0.6} ${cy - r * 0.9}A${r} ${r} 0 1 0 ${cx + r} ${cy + r * 0.3}A${r * 0.8} ${r * 0.8} 0 0 1 ${cx + r * 0.6} ${cy - r * 0.9}z"/>`;
const cloudSvg = (dy = 0) =>
  `<path class="cloud" transform="translate(0 ${dy})" d="M19 48h27a9.5 9.5 0 0 0 .8-19 13 13 0 0 0-25-3.5A11 11 0 0 0 19 48z"/>`;
const drops = (xs) => `<path class="rain" d="${xs.map((x) => `M${x} 49l-3 7`).join("")}"/>`;
const flakes = (xs) =>
  `<path class="snow" d="${xs.map((x) => `M${x} 49v8M${x - 3.5} 51l7 4M${x - 3.5} 55l7-4`).join("")}"/>`;

function icon(code) {
  const night = code >= 30 && code <= 39;
  const sky = (cx, cy, r) => (night ? moonSvg(cx, cy, r) : sunSvg(cx, cy, r));
  let body;
  switch (kindOf(code)) {
    case "clear": body = night ? moonSvg(30, 32, 16) : sunSvg(32, 32, 12); break;
    case "partly": body = sky(24, 22, 9) + cloudSvg(4); break;
    case "cloudy": body = cloudSvg(2); break;
    case "showers": body = sky(24, 18, 8) + cloudSvg(-4) + drops([26, 36]); break;
    case "mixShowers": body = sky(24, 18, 8) + cloudSvg(-4) + drops([25]) + flakes([38]); break;
    case "flurries": body = sky(24, 18, 8) + cloudSvg(-4) + flakes([26, 39]); break;
    case "rain": body = cloudSvg(-4) + drops([22, 31, 40]); break;
    case "mix": body = cloudSvg(-4) + drops([23, 41]) + flakes([32]); break;
    case "snow": body = cloudSvg(-4) + flakes([22, 32, 42]); break;
    case "thunder": body = cloudSvg(-4) + `<path class="bolt" d="M33 44l-6 9h6l-3 8 9-11h-6l3-6z"/>`; break;
    case "fog": body = cloudSvg(-6) + `<path class="fog" d="M14 50h36M18 56h28"/>`; break;
    case "wind": body = `<path class="fog" d="M8 26h30a6 6 0 1 0-6-6M8 36h42a6 6 0 1 1-6 6M8 46h22"/>`; break;
  }
  return `<svg class="wx" viewBox="0 0 64 64">${body}</svg>`;
}

/* ============================================================
 * Charts
 * ============================================================ */
const WINDOWS = {            // [hours back, hours ahead]
  today: [24, 24],
  week: [48, 168],
};

const toTemp = (c) => (settings.tempUnit === "F" ? c * 9 / 5 + 32 : c);
const toWind = (k) => (settings.windUnit === "mph" ? k * 0.621371 : k);
const mapV = (pts, f) => (pts || []).map(([t, v]) => [t, f(v)]);
/** Value at time t across observed + forecast (bridges the gap around NOW). */
const valueAt = (s, t) => Charts.valueAt(extend(s.obs || [], s.fc || []), t);

/** Chart definitions: how to draw each panel and what its readout says. */
const CHARTS = [
  {
    key: "temp", title: "Temperature", key2: "Feels",
    opts: (s, win) => ({
      obs: mapV(s.obs, toTemp), fc: mapV(s.fc, toTemp), fmt: (v) => `${Math.round(v)}°`,
      alt: { obs: mapV(s.feelsObs, toTemp), fc: mapV(s.feelsFc, toTemp) },
      marks: (s.marks || []).map((m) => ({ ...m, v: toTemp(m.v) })),
    }),
    read: (s, t, past) => {
      const v = valueAt(s, t);
      if (v == null) return "--";
      const f = valueAt({ obs: s.feelsObs, fc: s.feelsFc }, t);
      return `${temp(v)}°${f != null && Math.abs(f - v) >= 1 ? ` · feels ${temp(f)}°` : ""}`;
    },
  },
  {
    key: "precip", title: "Precipitation",
    opts: (s) => ({ precip: s }),
    read: (s, t, past, view) => {
      const text = ([rain, snow]) => [rain >= 0.1 ? `${Charts.amount(rain)} mm` : "", snow >= 0.1 ? `${Charts.amount(snow)} cm` : ""]
        .filter(Boolean).join(" + ") || "None";
      if (view.cursor != null && past) {               // measured from the start of the chart to here
        const mm = s.obs.reduce((sum, [a, b, v]) => sum + (v * Math.max(0, Math.min(b, t) - Math.max(a, view.from))) / (b - a), 0);
        return `${Charts.amount(mm)} mm`;
      }
      if (!s.expected?.length) {                       // amounts still loading: show the chance
        const b = s.chance.find((x) => x[1] > t);
        return b ? `${b[2]}% chance` : "--";
      }
      if (view.cursor != null) return text(Charts.expectedAt(s.expected, t));
      return { value: text(Charts.expectedAt(s.expected, view.to)), label: view.to - view.now > 2 * DAY ? "Next 7 days" : "Next 24 h" };
    },
  },
  {
    key: "wind", title: "Wind", key2: "Gusts",
    opts: (s) => ({
      obs: mapV(s.obs, toWind), fc: mapV(s.fc, toWind), dirs: s.dirs, min: 0,
      alt: { obs: mapV(s.gustObs, toWind), fc: mapV(s.gustFc, toWind) },
    }),
    read: (s, t, past) => {
      const v = valueAt(s, t);
      if (v == null) return "--";
      const dir = s.dirs.length ? s.dirs.reduce((a, b) => (Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a)) : null;
      const g = valueAt({ obs: s.gustObs, fc: s.gustFc }, t);
      const gust = g != null && g - v >= 5 ? ` · G${wind(g)}` : "";
      return `${degCompass(dir?.[1])} ${wind(v)} ${windUnit()}${gust}`.trim();
    },
  },
  {
    key: "humidity", title: "Humidity",
    // Humidity sensors can drop out on their own: show that as a gap rather than bridging it
    opts: (s) => ({ obs: s.obs, fc: s.fc, min: 0, max: 100, fmt: (v) => `${Math.round(v)}%`, maxGap: 2.5 * HOUR }),
    read: (s, t, past) => {
      const v = Charts.valueAt(extend(s.obs, s.fc), t, 2.5 * HOUR);
      return v == null ? "--" : `${Math.round(v)}%`;
    },
  },
  {
    key: "pressure", title: "Pressure",
    opts: (s) => ({ obs: s.obs, fc: [], fmt: (v) => v.toFixed(1) }),
    read: (s, t) => {
      const v = Charts.valueAt(s.obs, t) ?? s.obs[s.obs.length - 1]?.[1];
      return v == null ? "--" : `${v.toFixed(1)} kPa`;
    },
  },
];

function buildChartCards() {
  for (const box of $$(".charts")) {
    box.innerHTML = `
      <div class="sky-card card"><span class="chart-title">Conditions</span><div class="sky"></div></div>` +
      CHARTS.map((c) => `
      <div class="chart card" data-key="${c.key}">
        <div class="chart-head">
          <span class="chart-title">${c.title}${c.key2 ? `<i class="k-alt"></i><span>${c.key2}</span>` : ""}</span>
          <span class="chart-read"><b>--</b><small>Now</small></span>
        </div>
        <canvas></canvas>
      </div>`).join("");

    // Scrub: drag (touch) or hover (mouse) moves a cursor across every chart in the tab
    box.addEventListener("pointermove", (e) => {
      const canvas = e.target.closest("canvas");
      if (!canvas || (e.pointerType !== "mouse" && !e.buttons && e.pressure === 0)) return;
      const r = canvas.getBoundingClientRect();
      const [back, ahead] = WINDOWS[box.dataset.window];
      const now = Date.now();
      const { left, right } = Charts.GUTTER;
      const f = Math.min(1, Math.max(0, (e.clientX - r.left - left) / (r.width - left - right)));
      state.cursor = now - back * HOUR + f * (back + ahead) * HOUR;
      drawCharts();
    });
    const clear = () => { state.cursor = null; drawCharts(); };
    box.addEventListener("pointerleave", clear);
    box.addEventListener("pointerup", (e) => e.pointerType !== "mouse" && clear());
    box.addEventListener("pointercancel", clear);
  }
}

function drawCharts() {
  const box = $(`#view-${state.view} .charts`);
  if (!box || !state.series) return;
  const [back, ahead] = WINDOWS[box.dataset.window];
  const now = Date.now();
  const cursor = state.cursor;
  const t = cursor ?? now;
  const past = t <= now;
  const label = cursor == null || Math.abs(cursor - now) < 15 * 60e3 ? "Now"
    : new Date(cursor).toLocaleString([], { weekday: "short", hour: "numeric", minute: back > 6 ? undefined : "2-digit" });

  for (const def of CHARTS) {
    const card = box.querySelector(`[data-key="${def.key}"]`);
    const s = state.series[def.key];
    Charts.draw(card.querySelector("canvas"), {
      from: now - back * HOUR, to: now + ahead * HOUR, now, cursor,
      ...def.opts(s, box.dataset.window),
    });
    const read = def.read(s, t, past, { cursor, now, from: now - back * HOUR, to: now + ahead * HOUR });
    card.querySelector(".chart-read b").textContent = read.value ?? read;
    card.querySelector(".chart-read small").textContent = read.label ?? label;
  }
}

/* ============================================================
 * Rendering
 * ============================================================ */
/** Weather symbols along the top of Today (every 3 hours) and Week (each day). */
function renderSky() {
  const wx = state.wx, now = Date.now();
  const column = (label, code, t) => `<div><span>${label}</span>${icon(code)}<b>${t == null ? "" : `${temp(t)}°`}</b></div>`;
  const hours = wx.hourly.filter((h) => h.t > now - HOUR).filter((_, i) => i % 3 === 0).slice(0, 8);
  $("#view-today .sky").innerHTML = hours.map((h, i) => column(i ? fmtHour(new Date(h.t)) : "Now", h.icon, h.temp)).join("");
  const days = wx.periods.filter((p, i) => p.span && (!p.night || i === 0)).slice(0, 7);
  $("#view-week .sky").innerHTML = days.map((p) => column(
    p.night ? "Tonight" : new Date(p.span[0]).toLocaleDateString([], { weekday: "short" }), p.icon, p.temp)).join("");
}

/* ---------- SaskAlert: Saskatchewan's public alerts (drinking water, emergencies, …) ---------- */
// SaskAlert's own website reads this public list; it is small and open to other web apps.
const SASKALERT = "https://emergencyalert.saskatchewan.ca";

/** Is [lat, lon] inside a polygon given as "lat,lon lat,lon …"? */
function insidePolygon([lat, lon], text) {
  const pts = text.trim().split(/\s+/).map((p) => p.split(",").map(Number));
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ai, oi] = pts[i], [aj, oj] = pts[j];
    if (ai > lat !== aj > lat && lon < ((oj - oi) * (lat - ai)) / (aj - ai) + oi) inside = !inside;
  }
  return inside;
}

/** Outline of a SaskAlert area (census subdivision); boundaries don't change, so keep them. */
async function areaOutlines(geocode) {
  const key = `skarea:${geocode}`, saved = localStorage.getItem(key);
  if (saved) return JSON.parse(saved);
  const { polygon } = await getJSON(`${SASKALERT}/mobile-areas/v2/${geocode}.json`);
  const outlines = [].concat(polygon || []);
  localStorage.setItem(key, JSON.stringify(outlines));
  return outlines;
}

/** Active SaskAlert alerts whose area contains this location. */
async function fetchSaskAlerts(where) {
  const { entries = [] } = await getJSON(`${SASKALERT}/sapublic/feed.json`);
  const found = [];
  for (const e of entries) {
    if (e.state !== "active") continue;
    if (/environment|eccc/i.test(`${e.sender} ${e.author_en}`)) continue; // EC weather alerts: shown from EC directly
    const geocodes = (e.area || []).flatMap((a) => a.geocode || []);
    const outlines = (await Promise.all(geocodes.map((g) => areaOutlines(g).catch(() => [])))).flat();
    if (!outlines.some((o) => insidePolygon(where, o))) continue;
    found.push({ event: e.event_en, level: e.level, code: e.code, url: e.html_link });
  }
  return found;
}

function loadSaskAlerts() {
  const city = state.city;
  const where = state.loc === "current" && state.lastPos ? state.lastPos : [city[2], city[3]];
  fetchSaskAlerts(where).then((list) => {
    if (state.city !== city) return;
    state.skAlerts = list;
    renderAlerts();
  }).catch(() => {});                                  // SaskAlert unreachable: show the weather alerts alone
}

/**
 * Alerts across the top of every page, coloured by EC's level: red, orange or yellow;
 * special weather statements in blue. Tapping one opens EC's full alert.
 */
function renderAlerts() {
  const now = Date.now();
  const alerts = (state.wx?.warnings || []).filter((w) => !w.expires || w.expires > now);
  $("#alerts").innerHTML = alerts.map((w) => {
    // "YELLOW WARNING - WIND" → "Wind warning"
    const m = (w.title || "").match(/^(?:yellow|orange|red)\s+(warning|watch|advisory)\s*-\s*(.+)$/i);
    const title = (m ? `${m[2]} ${m[1]}` : w.title || "").toLowerCase().replace(/^./, (c) => c.toUpperCase());
    const level = w.level || { warning: "red", watch: "yellow", advisory: "yellow" }[w.type] || "blue";
    const until = w.expires ? `until ${new Date(w.expires).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "";
    return `<a class="alert ${level}" href="${w.url}" target="_blank" rel="noopener"><b>${title}</b><span>${until}</span></a>`;
  }).join("") + (state.skAlerts || []).map((a) => {
    // Drinking water in water-blue; critical alerts red; tests grey; other advisories orange
    const test = a.level === "test" || a.code === "testmessage";
    const colour = test ? "grey" : a.level === "critical" ? "red" : a.code === "drinkingwate" ? "water" : "orange";
    const kind = test ? "" : a.level === "critical" ? " alert" : ` ${a.level}`;
    const title = `${a.event}${kind}`.toLowerCase().replace(/^./, (c) => c.toUpperCase());
    return `<a class="alert ${colour}" href="${a.url}" target="_blank" rel="noopener"><b>${title}</b><span>SaskAlert</span></a>`;
  }).join("");
  fitTopBar();
}

/** The top bar grows with alerts; everything below is laid out from its height. */
function fitTopBar() {
  document.documentElement.style.setProperty("--top-h", `${$(".topbar").offsetHeight}px`);
}

/** The Now page: one small square per current value. */
function renderTiles() {
  const wx = state.wx, c = wx.current, s = state.series, now = Date.now();
  const deg = (v) => (v == null ? "--" : `${temp(v)}°`);
  const time = (t) => (t ? fmtTime(new Date(t)) : "--");

  const feels = (s?.temp.feelsObs && valueAt({ obs: s.temp.feelsObs, fc: s.temp.feelsFc }, now))
    ?? c.feels ?? (c.temp != null ? feelsLike(c.temp, c.wind ?? 0, c.humidity) : null);
  const high = wx.periods.find((p) => !p.night), low = wx.periods.find((p) => p.night);
  const uv = wx.periods.find((p) => p.uv != null);
  const chance = s?.precip.chance?.find((b) => b[1] > now);
  // Rain (mm) and snow (cm) expected over the next 24 hours
  const expected = s?.precip.expected?.length ? Charts.expectedAt(s.precip.expected, now + DAY) : null;
  const rainSnow = expected
    ? `${Charts.amount(expected[0])}<small>mm</small> ${Charts.amount(expected[1])}<small>cm</small>` : "--";

  // One row per kind of data
  const tiles = [
    ["temp", "Feels like", deg(feels), ""],
    ["temp", "High / Low", `${deg(high?.temp)} / ${deg(low?.temp)}`, high?.label || ""],
    ["hum", "Dew point", deg(c.dewpoint), ""],

    ["precip", "Precip", chance ? `${chance[2]}%` : "--", chance?.[2] ? chance[3].replace(/^./, (m) => m.toUpperCase()) : "Next hour"],
    ["precip", "Rain / Snow", rainSnow, "Next 24 h", "pair"],
    ["hum", "Humidity", c.humidity == null ? "--" : `${Math.round(c.humidity)}%`, ""],

    ["wind", "Wind", c.wind == null ? "--" : `${wind(c.wind)}`, [c.dir, windUnit()].filter(Boolean).join(" · ")],
    ["wind", "Gusts", c.gust ? `${wind(c.gust)}` : "None", c.gust ? windUnit() : ""],
    ["pres", "Pressure", c.pressure == null ? "--" : c.pressure.toFixed(1), ["kPa", c.tendency].filter(Boolean).join(" · ")],

    ["sun", "UV index", uv ? `${uv.uv}` : "--", (uv?.uvCategory || uv?.label || "").replace(/^./, (m) => m.toUpperCase())],
    ["sun", "Sunrise", time(wx.sunrise), ""],
    ["sun", "Sunset", time(wx.sunset), ""],
  ];
  $("#nowTiles").innerHTML = tiles.map(([kind, label, value, note, style = ""]) => `
    <div class="tile card" data-kind="${kind}">
      <span class="tile-label">${label}</span>
      <b class="tile-value ${style}">${value}</b>
      <span class="tile-note">${note}</span>
    </div>`).join("");
}

function render() {
  const wx = state.wx;
  if (!wx) return;
  const c = wx.current;

  $("#placeName").textContent = wx.name;
  const label = { home: "Home", current: "Near you", city: "Saved" }[state.loc];
  $("#locTitle").textContent = wx.name;
  $("#locDesc").textContent = [label, wx.region || state.city[1]].filter(Boolean).join(" · ");

  renderAlerts();

  // Now: current conditions and value tiles
  $("#nowIcon").innerHTML = icon(c.icon);
  $("#nowTemp").textContent = temp(c.temp ?? wx.hourly[0]?.temp);
  $("#nowCond").textContent = c.cond;
  renderTiles();

  // The official text forecast for the next two periods
  renderSky();
  $("#nowText").innerHTML = wx.periods.slice(0, 2).map((p) => `<p><b>${p.label}</b> ${p.text}</p>`).join("");

  drawCharts();
  applyTheme();
}

/* ============================================================
 * Loading data for the active location
 * ============================================================ */
async function load() {
  try {
    if (state.loc === "home") {
      if (!settings.home) return openLocations();
      state.city = settings.home;
    } else if (state.loc === "city") {
      state.city = state.picked;
    } else {
      const [lat, lon] = await getPosition();
      state.lastPos = [lat, lon];
      state.city = nearestCity(lat, lon);
    }

    // Show the last saved data instantly, then refresh
    const cacheKey = `wx:${state.city[0]}`;
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (cached) Object.assign(state, cached), render();

    state.wx = await fetchCityPage(state.city);
    state.series = buildSeries(state.wx);
    state.fetchedAt = Date.now();
    render();
    loadSaskAlerts();

    // History and model data arrive a moment later
    const maxBack = Math.max(...Object.values(WINDOWS).map((w) => w[0]));
    const [obs, model] = await Promise.all([
      fetchObservations(state.wx.current.stationCode, Date.now() - maxBack * HOUR).catch(() => []),
      fetchModel(state.city[2], state.city[3]).catch(() => null),
    ]);
    state.modelStation = model?.station;
    state.series = buildSeries(state.wx, obs, model);
    const save = () => localStorage.setItem(cacheKey, JSON.stringify({ wx: state.wx, series: state.series, modelStation: state.modelStation }));
    save();
    render();

    // Expected rain and snow take a few more seconds; the charts fill in when they arrive
    const city = state.city;
    loadExpected(city).then((list) => {
      if (state.city !== city) return;
      state.series.precip.expected = list;
      save();
      renderTiles();
      drawCharts();
    }).catch(() => {});
    if (radar.map) radar.centre();
  } catch (err) {
    console.error(err);
    if (state.loc === "current" && err.code) {
      if (settings.home) { toast("Location unavailable — showing Home"); setLoc("home"); return; }
      toast("Location unavailable — choose a place");
      openLocations();
    } else {
      toast(state.wx ? "Offline — showing last saved data" : err.message);
    }
  }
}

function setLoc(loc, city) {
  state.loc = loc;
  state.skAlerts = [];
  state.picked = city || state.picked;
  closeLocations();
  load();
}

/* ---------- Location picker (opened by tapping the place name) ---------- */
function locationRow(attrs, title, note, on) {
  return `<li><button ${attrs}${on ? ' class="on"' : ""}><b>${title}</b><span>${note}</span></button></li>`;
}

function openLocations() {
  $("#locList").innerHTML =
    locationRow('data-loc="current"', "Current location", "Use this device's GPS", state.loc === "current") +
    locationRow('data-loc="home"', "Home", settings.home ? `${settings.home[0]}, ${settings.home[1]}` : "Choose one in Settings", state.loc === "home") +
    settings.saved.map((c, i) => locationRow(`data-i="${i}"`, c[0], c[1], state.loc === "city" && state.picked?.[0] === c[0])).join("") +
    locationRow('data-loc="manage"', "Edit saved locations", "", false);
  $("#locSheet").hidden = false;
}

function closeLocations() { $("#locSheet").hidden = true; }

function bindLocations() {
  $("#placeBtn").addEventListener("click", () => ($("#locSheet").hidden ? openLocations() : closeLocations()));
  $("#locSheet").addEventListener("click", (e) => {
    if (e.target.id === "locSheet") return closeLocations();
    const row = e.target.closest("button");
    if (!row) return;
    if (row.dataset.i) return setLoc("city", settings.saved[row.dataset.i]);
    if (row.dataset.loc === "manage" || (row.dataset.loc === "home" && !settings.home)) { closeLocations(); return showView("settings"); }
    setLoc(row.dataset.loc);
  });
}

/* ============================================================
 * Map tab: radar or pressure (MSC GeoMet WMS on an Esri canvas basemap)
 * ============================================================ */
const RADAR = {
  rain: {
    layer: "RADAR_1KM_RRAI", style: "Radar-Rain_14colors", unit: "mm/h",
    ticks: ["0.1", "1", "4", "12", "24", "50", "100", "200"],
  },
  snow: {
    layer: "RADAR_1KM_RSNO", style: "Radar-Snow_14colors", unit: "cm/h",
    ticks: ["0.1", "0.2", "0.5", "1", "2", "4", "7.5", "20"],
  },
};
// Environment Canada's standard 14-colour precipitation scale (low → high)
const RADAR_RAMP = ["#99ccff", "#0099ff", "#00ff66", "#00cc00", "#009900", "#006600",
  "#ffff33", "#ffcc00", "#ff9900", "#ff6600", "#ff0000", "#ff0099", "#9933cc", "#660099"];

// EC regional model (RDPS): sea-level pressure isobars and high / low centres, hourly out to 84 h
const PRESSURE = {
  // EC's coloured isobars: blue for low pressure through green and yellow to orange for high
  isobars: "RDPS_10km_Pressure_MSL-Contour", isobarStyle: "SeaLevelPressure_4mb_Color",
  centres: "RDPS_10km_HighLowPressure_MSL",
  centreStyle: () => (document.documentElement.dataset.theme === "night" ? "HighLowPressure_White" : "HighLowPressure_Black"),
  stepHours: 6,
};

const wmsTime = (t) => `${new Date(t).toISOString().slice(0, 19)}Z`;

/** Read a GeoMet layer's available time range: [start, end] in ms. */
async function layerTimes(layer) {
  const xml = await (await fetch(`${GEOMET}?service=WMS&version=1.3.0&request=GetCapabilities&layer=${layer}`)).text();
  const dim = new DOMParser().parseFromString(xml, "text/xml").querySelector('Dimension[name="time"]').textContent;
  const [start, end] = dim.split("/");
  return [Date.parse(start), Date.parse(end)];
}

const radar = {
  map: null, base: null, labels: null, frames: [], times: [], index: 0, timer: null, refreshTimer: null,
  mode: settings.mapMode === "pressure" ? "pressure" : "radar",

  init() {
    this.map = L.map("map", { zoomControl: false, attributionControl: true, minZoom: 3, maxZoom: 12 });
    this.map.createPane("labels").style.zIndex = 650;
    this.map.getPane("labels").style.pointerEvents = "none";

    const opts = { maxZoom: 16, maxNativeZoom: 16 };
    this.base = L.tileLayer(BASEMAP, { ...opts, style: "World_Dark_Gray_Base",
      attribution: "Esri, HERE, Garmin, © OpenStreetMap · ECCC" }).addTo(this.map);
    this.labels = L.tileLayer(BASEMAP, { ...opts, style: "World_Dark_Gray_Reference", pane: "labels" });
    this.coverage = L.tileLayer.wms(GEOMET, {
      layers: "RADAR_COVERAGE_RRAI.INV", styles: "Radar-Coverage_Inv-DarkGray",
      format: "image/png", transparent: true, version: "1.3.0", tileSize: 512, opacity: 0.35,
    });
    // High / low centres are placed relative to the requested image, so fetch one image for
    // the whole view (tiles would each get their own H / L at their edges)
    this.centres = L.layerGroup();
    this.map.on("moveend", () => this.updateCentres());
    this.marker = L.marker([0, 0], { icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [16, 16] }) }).addTo(this.map);

    this.applyTheme();
    this.setLabels(settings.showLabels);
    this.centre(true);
    this.type = this.defaultType();
    this.setMode(this.mode);
  },

  defaultType() {
    if (settings.radarType !== "auto") return settings.radarType;
    const t = state.wx?.current.temp ?? state.wx?.hourly[0]?.temp;
    return t != null && t <= 0 ? "snow" : "rain";
  },

  centre(initial = false) {
    if (!state.city) { this.map.setView([56, -96], 4); return; }
    const ll = state.loc === "current" && state.lastPos ? state.lastPos : [state.city[2], state.city[3]];
    this.marker.setLatLng(ll);
    // Animating a hidden (zero-size) map produces NaN coordinates, so jump instead
    if (initial || state.view !== "radar") this.map.setView(ll, initial ? 7 : this.map.getZoom());
    else this.map.flyTo(ll, Math.max(this.map.getZoom(), 7), { duration: 0.8 });
  },

  applyTheme() {
    if (!this.map) return;
    const shade = document.documentElement.dataset.theme === "night" ? "Dark" : "Light";
    this.base.setUrl(BASEMAP.replace("{style}", `World_${shade}_Gray_Base`));
    this.labels.setUrl(BASEMAP.replace("{style}", `World_${shade}_Gray_Reference`));
    this.updateCentres();
  },

  setLabels(on) {
    on ? this.labels.addTo(this.map) : this.labels.remove();
    $("#labelsBtn").setAttribute("aria-pressed", on);
  },

  /** Switch between precipitation radar and the pressure (isobar + high / low) map. */
  setMode(mode) {
    this.mode = mode;
    settings.mapMode = mode;
    saveSettings();
    $$("#mapMode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    $("#radarType").hidden = mode !== "radar";
    mode === "radar" ? this.coverage.addTo(this.map) : this.coverage.remove();
    mode === "pressure" ? this.centres.addTo(this.map) : this.centres.remove();
    this.setType(this.type);
  },

  async setType(type) {
    this.type = type;
    $$("#radarType button").forEach((b) => b.classList.toggle("on", b.dataset.type === type));
    this.renderLegend();
    await this.loadFrames();
  },

  renderLegend() {
    const legend = $("#legend");
    legend.className = this.mode === "pressure" ? "legend pressure" : "legend";
    if (this.mode === "pressure") {
      legend.innerHTML = `
        <div><b class="hi">H</b>High</div>
        <div><b class="lo">L</b>Low</div>
        <div><i class="iso"></i>Isobars</div>
        <div class="unit">Low to high</div>`;
      return;
    }
    const cfg = RADAR[this.type];
    legend.innerHTML = `
      <div class="ramp" style="background:linear-gradient(to top, ${RADAR_RAMP.join(",")})"></div>
      <div class="ticks">${[...cfg.ticks].reverse().map((t) => `<span>${t}</span>`).join("")}</div>
      <div class="unit">${cfg.unit}</div>`;
  },

  /** Radar: the last ~2 h every 12 min. Pressure: now → end of the model run every 6 h. */
  async loadFrames() {
    const pressure = this.mode === "pressure";
    const layer = pressure ? PRESSURE.isobars : RADAR[this.type].layer;
    let start, end;
    try {
      [start, end] = await layerTimes(layer);
    } catch {
      end = Math.floor(Date.now() / 360000) * 360000 - 360000; // fall back to the last 6-min slot
      start = end - 3 * HOUR;
    }

    this.stop();
    this.frames.forEach((f) => f.remove());
    if (pressure) {
      const first = Math.max(start, Math.floor(Date.now() / HOUR) * HOUR);
      this.times = [];
      for (let t = first; t <= end; t += PRESSURE.stepHours * HOUR) this.times.push(t);
    } else {
      this.times = Array.from({ length: 11 }, (_, i) => end - (10 - i) * 12 * 60000);
    }
    this.frames = this.times.map((t) => L.tileLayer.wms(GEOMET, {
      layers: layer, styles: pressure ? PRESSURE.isobarStyle : RADAR[this.type].style,
      format: "image/png", transparent: true, version: "1.3.0", tileSize: 512, opacity: 0, time: wmsTime(t),
      updateWhenZooming: false, // load tiles once the zoom settles, not at every step
      className: pressure ? "isobars" : "",
    }));
    // Frames are added to the map on demand in show(): every frame on the map is a full-screen
    // layer, and holding them all at once uses enough memory to crash mobile browsers.

    $("#frameSlider").max = this.frames.length - 1;
    this.show(pressure ? 0 : this.frames.length - 1); // pressure starts at now, radar at the latest scan
  },

  show(i) {
    this.frames[this.index]?.setOpacity(0);
    this.index = i;
    // Keep only the visible frame and the next one (preloaded for playback) on the map
    const next = (i + 1) % this.frames.length;
    this.frames.forEach((f, k) => (k === i || k === next ? f.addTo(this.map) : f.remove()));
    this.frames[i]?.setOpacity(this.mode === "pressure" ? 0.95 : settings.radarOpacity);
    $("#frameSlider").value = i;
    const t = this.times[i];
    $("#frameTime").textContent = !t ? "--:--" : this.mode === "pressure"
      ? new Date(t).toLocaleString([], { weekday: "short", hour: "numeric" })
      : fmtTime(new Date(t));
    this.updateCentres();
  },

  /**
   * One image of the high / low centres for the current view and frame time.
   * The new image is loaded alongside the old one and only replaces it once it has arrived,
   * so the symbols never jump to the wrong place while you pan or zoom.
   */
  updateCentres() {
    if (!this.map || this.mode !== "pressure" || !this.times[this.index]) return;
    const b = this.map.getBounds(), size = this.map.getSize();
    const sw = this.map.options.crs.project(b.getSouthWest()), ne = this.map.options.crs.project(b.getNorthEast());
    const url = `${GEOMET}?service=WMS&version=1.3.0&request=GetMap&layers=${PRESSURE.centres}&styles=${PRESSURE.centreStyle()}` +
      `&crs=EPSG:3857&bbox=${sw.x},${sw.y},${ne.x},${ne.y}&width=${size.x}&height=${size.y}` +
      `&format=image/png&transparent=true&time=${wmsTime(this.times[this.index])}`;
    const img = L.imageOverlay(url, b, { interactive: false });
    img.seq = this.centresSeq = (this.centresSeq || 0) + 1;
    img.once("load", () => {
      // Drop older images; if a newer one already arrived, drop this one instead
      if (img.seq < (this.centresShown || 0)) return this.centres.removeLayer(img);
      this.centresShown = img.seq;
      this.centres.eachLayer((old) => old.seq < img.seq && this.centres.removeLayer(old));
    });
    img.once("error", () => this.centres.removeLayer(img));
    this.centres.addLayer(img);
  },

  play() {
    $(".player").classList.add("playing");
    const step = () => {
      const next = (this.index + 1) % this.frames.length;
      this.show(next);
      // Pause on the last frame a little longer
      const hold = next === this.frames.length - 1 ? 3 : 1;
      this.timer = setTimeout(step, settings.radarSpeed * hold * (this.mode === "pressure" ? 2 : 1));
    };
    step();
  },

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    $(".player").classList.remove("playing");
  },

  onShow() {
    if (!this.map) this.init();
    setTimeout(() => this.map.invalidateSize(), 50);
    clearInterval(this.refreshTimer);
    // New radar scans arrive every 6 min (the pressure model only every 6 h, so leave it be)
    this.refreshTimer = setInterval(() => this.mode === "radar" && this.loadFrames(), 6 * 60000);
  },

  onHide() {
    this.stop();
    clearInterval(this.refreshTimer);
  },
};

/* ============================================================
 * Theme
 * ============================================================ */
function currentTheme() {
  if (settings.theme !== "auto") return settings.theme;
  const now = new Date(), wx = state.wx;
  if (wx?.sunrise && wx?.sunset) {
    // Sunrise/sunset are for today; compare by time of day
    const mins = (d) => new Date(d).getHours() * 60 + new Date(d).getMinutes();
    return mins(now) >= mins(wx.sunrise) && mins(now) < mins(wx.sunset) ? "day" : "night";
  }
  return now.getHours() >= 7 && now.getHours() < 19 ? "day" : "night";
}

function applyTheme() {
  const theme = currentTheme();
  if (document.documentElement.dataset.theme === theme) return;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === "night" ? "#000000" : "#ffffff";
  radar.applyTheme();
  drawCharts();
}

/* ============================================================
 * Navigation
 * ============================================================ */
function showView(view) {
  if (state.view === "radar" && view !== "radar") radar.onHide();
  state.view = view;
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  $$(".tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  const chartView = view in WINDOWS;
  document.body.classList.toggle("map-open", view === "radar");
  closeLocations();
  state.cursor = null;
  if (view === "radar") radar.onShow();
  if (chartView) requestAnimationFrame(drawCharts);
  if (view === "settings") syncSettingsForm();
  window.scrollTo(0, 0);
}

/* ============================================================
 * Settings page
 * ============================================================ */
function syncSettingsForm() {
  $("#setTheme").value = settings.theme;
  $("#setTemp").value = settings.tempUnit;
  $("#setWind").value = settings.windUnit;
  $("#setStartLoc").value = settings.startLoc;
  $("#setRadarType").value = settings.radarType;
  $("#setOpacity").value = settings.radarOpacity;
  $("#setSpeed").value = settings.radarSpeed;
  $("#setLabels").checked = settings.showLabels;
  $("#homeLabel").textContent = settings.home ? `${settings.home[0]}, ${settings.home[1]}` : "Not set";
  renderSaved();
}

/* ---------- Saved locations ---------- */
function renderSaved() {
  $("#savedList").innerHTML = settings.saved.map((c, i) =>
    `<li><span>${c[0]} <small>${c[1]}</small></span><button data-i="${i}" aria-label="Remove ${c[0]}">✕</button></li>`).join("")
    || '<li class="muted small">None yet. Add places to switch to them from the location menu.</li>';
}

function bindSaved() {
  let results = [];
  $("#saveSearch").addEventListener("input", (e) => {
    results = searchCities(e.target.value);
    $("#saveResults").innerHTML = results.map((c, i) => `<li data-i="${i}">${c[0]}<span>${c[1]}</span></li>`).join("");
  });
  $("#saveResults").addEventListener("click", (e) => {
    const city = results[e.target.closest("li")?.dataset.i];
    if (!city) return;
    if (!settings.saved.some((c) => c[0] === city[0] && c[1] === city[1])) settings.saved.push(city);
    saveSettings();
    $("#saveSearch").value = ""; $("#saveResults").innerHTML = "";
    renderSaved();
    toast(`Saved ${city[0]}`);
  });
  $("#savedList").addEventListener("click", (e) => {
    const i = e.target.closest("button")?.dataset.i;
    if (i == null) return;
    settings.saved.splice(+i, 1);
    saveSettings();
    renderSaved();
  });
}

function setHome(city) {
  settings.home = city;
  saveSettings();
  syncSettingsForm();
  $("#citySearch").value = "";
  $("#cityResults").innerHTML = "";
  toast(`Home set to ${city[0]}`);
  if (state.loc === "home") load();
}

const fold = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function searchCities(q) {
  q = fold(q.trim());
  if (q.length < 2) return [];
  const starts = [], contains = [];
  for (const c of EC_CITIES) {
    const n = fold(c[0]);
    if (n.startsWith(q)) starts.push(c);
    else if (n.includes(q)) contains.push(c);
  }
  starts.sort((a, b) => a[0].length - b[0].length); // closest match first
  return [...starts, ...contains].slice(0, 8);
}

function bindSettings() {
  const bind = (id, key, parse = (v) => v, after) =>
    $(id).addEventListener("change", (e) => {
      settings[key] = parse(e.target.type === "checkbox" ? e.target.checked : e.target.value);
      saveSettings();
      after?.();
    });

  bind("#setTheme", "theme", String, applyTheme);
  bind("#setTemp", "tempUnit", String, render);
  bind("#setWind", "windUnit", String, render);
  bind("#setStartLoc", "startLoc");
  bind("#setRadarType", "radarType", String, () => radar.map && radar.setType(radar.defaultType()));
  bind("#setOpacity", "radarOpacity", Number, () => radar.map && radar.show(radar.index));
  bind("#setSpeed", "radarSpeed", Number);
  bind("#setLabels", "showLabels", Boolean, () => radar.map && radar.setLabels(settings.showLabels));

  let results = [];
  $("#citySearch").addEventListener("input", (e) => {
    results = searchCities(e.target.value);
    $("#cityResults").innerHTML = results.map((c, i) => `<li class="card" data-i="${i}">${c[0]}<span>${c[1]}</span></li>`).join("");
  });
  $("#cityResults").addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (li) setHome(results[li.dataset.i]);
  });
}

/* ============================================================
 * Wire up
 * ============================================================ */
function init() {
  applyTheme();
  bindSettings();
  buildChartCards();

  $$(".tabbar button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  bindLocations();
  bindSaved();

  // Radar controls
  $$("#mapMode button").forEach((b) => b.addEventListener("click", () => radar.setMode(b.dataset.mode)));
  $$("#radarType button").forEach((b) => b.addEventListener("click", () => radar.setType(b.dataset.type)));
  $("#labelsBtn").addEventListener("click", () => {
    settings.showLabels = !settings.showLabels;
    saveSettings();
    radar.setLabels(settings.showLabels);
  });
  $("#locateBtn").addEventListener("click", () => radar.centre());
  $("#playBtn").addEventListener("click", () => (radar.timer ? radar.stop() : radar.play()));
  $("#frameSlider").addEventListener("input", (e) => { radar.stop(); radar.show(+e.target.value); });

  window.addEventListener("resize", () => { fitTopBar(); drawCharts(); });
  setInterval(drawCharts, 60e3); // keep the NOW line moving

  // Refresh when the app comes back to the foreground after 10+ minutes
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    applyTheme();
    if (Date.now() - (state.fetchedAt || 0) > 10 * 60000) load();
  });

  showView("now");
  setLoc(state.loc);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
}

init();
