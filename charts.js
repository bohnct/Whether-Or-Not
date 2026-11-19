/* Time-series charts drawn on <canvas>.
 * Every chart shares one time window, a NOW line and a scrub cursor.
 * Flat style: observed in the text colour, forecast in the chart's accent (CSS --c on the card).
 * Points are [timeMs, value]; bars are [startMs, endMs, value, kind].
 */
"use strict";

const Charts = (() => {
  const HOUR = 3600e3, DAY = 24 * HOUR;

  /* ---------- Helpers ---------- */
  function niceStep(range, count) {
    const raw = range / count, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  }

  /** Theme colours as seen by this canvas (so each chart picks up its own --c accent). */
  function colors(el) {
    const css = getComputedStyle(el);
    const v = (n) => css.getPropertyValue(n).trim();
    return {
      text: v("--text"), muted: v("--muted"), line: v("--line"), bg: v("--bg"), font: v("--font"),
      accent: v("--c") || v("--text"), snow: v("--c-snow"), mix: v("--c-mix"),
    };
  }

  const alpha = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  };

  /** Linear interpolation of a value at time t in a sorted point series. */
  function valueAt(pts, t) {
    if (!pts?.length || t < pts[0][0] || t > pts[pts.length - 1][0]) return null;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i][0] >= t) {
        const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
        if (t1 - t0 > 7 * HOUR) return null; // don't bridge big gaps
        return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0 || 1);
      }
    }
    return pts[pts.length - 1][1];
  }
  const barAt = (bars, t) => bars?.find((b) => t >= b[0] && t < b[1]) || null;

  /** Time-axis labels suited to the window length. */
  function ticks(from, to) {
    const span = to - from, out = [];
    if (span > 20 * DAY) { // months, labelled mid-month
      const d = new Date(from); d.setDate(1); d.setHours(0, 0, 0, 0);
      for (; +d <= to; d.setMonth(d.getMonth() + 1)) {
        const next = new Date(d); next.setMonth(d.getMonth() + 1);
        out.push({ t: +d, major: true, label: d.toLocaleDateString([], { month: "short" }), at: (Math.max(+d, from) + Math.min(+next, to)) / 2 });
      }
      return out;
    }
    const step = span <= 14 * HOUR ? 2 * HOUR : span <= 50 * HOUR ? 6 * HOUR : DAY;
    const start = new Date(from); start.setMinutes(0, 0, 0);
    if (step === DAY) start.setHours(0);
    for (let t = +start; t <= to; t += HOUR) {
      const d = new Date(t);
      if (step === DAY) {
        if (d.getHours() !== 0) continue;
        out.push({ t, major: true, label: d.toLocaleDateString([], { weekday: "short" }), at: t + DAY / 2 });
      } else if (d.getHours() % (step / HOUR) === 0) {
        const midnight = d.getHours() === 0;
        out.push({
          t, major: midnight, at: t,
          label: midnight ? d.toLocaleDateString([], { weekday: "short" }) : d.toLocaleTimeString([], { hour: "numeric" }),
        });
      }
    }
    return out;
  }

  /* ---------- Drawing ---------- */
  /**
   * opts: { from, to, now, cursor,
   *         obs: [[t,v]], fc: [[t,v]], dirs: [[t,deg]],
   *         alt: { obs, fc }  (second, dashed line — e.g. wind gusts),
   *         marks: [{ t0, t1, v, hi }]  (official high / low, drawn over the period it applies to),
   *         precip: { obs: [[t0,t1,mm]], chance: [[t0,t1,pct,kind]], amounts: [[t0,t1,label]] },
   *         min, max, fmt: (v)=>string, maxGap: ms (longest step still joined by a line) }
   */
  function draw(canvas, o) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W) return;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const c = colors(canvas);
    ctx.font = `11px ${c.font}`;

    const top = o.dirs ? 26 : 14, bottom = H - 20, left = 0, right = W;
    const x = (t) => left + ((t - o.from) / (o.to - o.from)) * (right - left);

    // --- Y scale
    const marks = (o.marks || []).filter((m) => m.t1 > o.from && m.t0 < o.to);
    const vals = [...(o.obs || []), ...(o.fc || []), ...(o.alt?.obs || []), ...(o.alt?.fc || [])]
      .filter((p) => p[0] >= o.from && p[0] <= o.to).map((p) => p[1])
      .concat(marks.map((m) => m.v));
    let lo = o.min ?? Math.min(...vals), hi = o.max ?? Math.max(...vals);
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (hi - lo < 4 && o.min == null) { const m = (hi + lo) / 2; lo = m - 2; hi = m + 2; }
    const step = niceStep(hi - lo, 3);
    if (o.min == null) lo = Math.floor(lo / step) * step;
    if (o.max == null) hi = Math.ceil(hi / step) * step;
    // Leave room above / below for the high / low labels
    const yTop = top + (marks.length ? 14 : 0), yBot = bottom - (marks.length ? 14 : 0);
    const y = (v) => yBot - ((v - lo) / (hi - lo || 1)) * (yBot - yTop);

    // --- Grid + y labels
    ctx.strokeStyle = c.line; ctx.lineWidth = 1; ctx.fillStyle = c.muted; ctx.textAlign = "left";
    if (!o.precip) {
      for (let v = lo; v <= hi + 1e-9; v += step) {
        ctx.beginPath(); ctx.moveTo(left, Math.round(y(v)) + 0.5); ctx.lineTo(right, Math.round(y(v)) + 0.5); ctx.stroke();
        ctx.fillText(o.fmt ? o.fmt(v) : Math.round(v), 4, y(v) - 4);
      }
    }

    // --- X ticks
    ctx.textAlign = "center";
    for (const t of ticks(o.from, o.to)) {
      if (t.major) {
        ctx.strokeStyle = c.line; ctx.beginPath(); ctx.moveTo(x(t.t) + 0.5, top - 6); ctx.lineTo(x(t.t) + 0.5, bottom); ctx.stroke();
      }
      const lx = x(t.at);
      if (lx < 14 || lx > W - 14) continue;
      ctx.fillStyle = t.major ? c.text : c.muted;
      ctx.fillText(t.label, lx, H - 5);
    }

    // --- Precipitation: observed amount (left of NOW, mm/h) and chance (right of NOW, %) as step lines
    const nowX = x(o.now);
    const clip = (fromX, toX, fn) => { ctx.save(); ctx.beginPath(); ctx.rect(fromX, 0, toX - fromX, H); ctx.clip(); fn(); ctx.restore(); };
    if (o.precip) drawPrecip(ctx, o, { x, top, bottom, W, nowX, clip, c });

    // --- Official highs (day periods) and lows (night periods): dashed lines over the hours they apply to
    const markLines = [];
    ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    for (const m of marks) {
      const x0 = Math.max(x(m.t0), 0), x1 = Math.min(x(m.t1), W), yy = Math.round(y(m.v)) + 0.5;
      ctx.strokeStyle = alpha(c.accent, m.hi ? 0.9 : 0.5);
      ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
      markLines.push({ ...m, x0, x1, yy });
    }
    ctx.setLineDash([]);

    // --- Lines
    const path = (pts) => {
      ctx.beginPath();
      pts.forEach(([t, v], i) => {
        const gap = i && t - pts[i - 1][0] > (o.maxGap ?? 7 * HOUR);
        i && !gap ? ctx.lineTo(x(t), y(v)) : ctx.moveTo(x(t), y(v));
      });
    };
    const inWin = (pts) => (pts || []).filter((p, i, a) =>
      (p[0] >= o.from && p[0] <= o.to) || (a[i + 1] && a[i + 1][0] >= o.from && p[0] < o.from) || (a[i - 1] && a[i - 1][0] <= o.to && p[0] > o.to));

    /** Observed points, then forecast points after the last observation. */
    const join = (a, b) => {
      const obs = inWin(a), fc = inWin(b);
      const last = obs.length ? obs[obs.length - 1][0] : -Infinity;
      return [...obs, ...fc.filter((p) => p[0] > last)];
    };
    const line = join(o.obs, o.fc);

    // Second line (dashed), drawn underneath the main line
    const alt = o.alt ? join(o.alt.obs, o.alt.fc) : [];
    if (alt.length) {
      ctx.setLineDash([4, 3]); ctx.lineWidth = 1.4; ctx.lineJoin = "round";
      clip(nowX, W, () => { path(alt); ctx.strokeStyle = c.accent; ctx.stroke(); });
      clip(0, nowX, () => { path(alt); ctx.strokeStyle = c.muted; ctx.stroke(); });
      ctx.setLineDash([]);
    }

    if (line.length) {
      // Forecast (right of NOW): accent line over a faint fill
      clip(nowX, W, () => {
        const g = ctx.createLinearGradient(0, top, 0, bottom);
        g.addColorStop(0, alpha(c.accent, 0.16)); g.addColorStop(1, alpha(c.accent, 0));
        path(line); ctx.lineTo(x(line[line.length - 1][0]), bottom); ctx.lineTo(x(line[0][0]), bottom); ctx.closePath();
        ctx.fillStyle = g; ctx.fill();
        path(line); ctx.strokeStyle = c.accent; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
      });
      // Observed (left of NOW): plain line in the text colour
      clip(0, nowX, () => {
        path(line); ctx.strokeStyle = c.text; ctx.lineWidth = 1.8; ctx.lineJoin = "round"; ctx.stroke();
      });
    }

    // --- High / low labels, centred on their period (haloed so the line never hides them)
    ctx.font = `600 10px ${c.font}`; ctx.lineWidth = 3; ctx.lineJoin = "round";
    ctx.strokeStyle = c.bg;
    for (const m of markLines) {
      const lx = (Math.max(m.x0, m.t0 < o.now ? nowX + 14 : 0) + m.x1) / 2;
      if (m.x1 - m.x0 < 16 || lx > W - 10) continue;
      const ly = m.hi ? m.yy - 5 : m.yy + 12;
      ctx.strokeText(o.fmt(m.v), lx, ly);
      ctx.fillStyle = m.hi ? c.accent : c.muted; ctx.fillText(o.fmt(m.v), lx, ly);
    }
    ctx.font = `11px ${c.font}`;

    // --- Wind direction arrows (point the way the wind blows)
    if (o.dirs?.length) {
      ctx.strokeStyle = c.muted; ctx.lineWidth = 1.4;
      const every = Math.max(28, W / 14);
      for (let px = every / 2; px < W; px += every) {
        const t = o.from + (px / W) * (o.to - o.from);
        const near = o.dirs.reduce((a, b) => (Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a));
        if (Math.abs(near[0] - t) > 3 * HOUR) continue;
        const r = ((near[1] + 180) * Math.PI) / 180;
        ctx.save(); ctx.translate(px, 11); ctx.rotate(r);
        ctx.beginPath(); ctx.moveTo(0, 5); ctx.lineTo(0, -5); ctx.moveTo(-3, -1.5); ctx.lineTo(0, -5); ctx.lineTo(3, -1.5); ctx.stroke();
        ctx.restore();
      }
    }

    // --- NOW line
    const nx = Math.round(x(o.now)) + 0.5;
    if (nx > 0 && nx < W) {
      ctx.strokeStyle = c.text; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(nx, top - 6); ctx.lineTo(nx, bottom); ctx.stroke();
    }

    // --- Scrub cursor
    if (o.cursor != null && o.cursor >= o.from && o.cursor <= o.to) {
      const cx = Math.round(x(o.cursor)) + 0.5;
      ctx.strokeStyle = c.text; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(cx, top - 6); ctx.lineTo(cx, bottom); ctx.stroke(); ctx.setLineDash([]);
      const v = valueAt(line, o.cursor);
      if (v != null && !o.precip) {
        ctx.fillStyle = c.bg; ctx.strokeStyle = c.text; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, y(v), 3.5, 0, 7); ctx.fill(); ctx.stroke();
      }
    }
  }

  /** Step line through [t0, t1, value] segments; gaps fall back to zero. */
  function stepPoints(segs, from, to, f) {
    const pts = [];
    let t = from;
    for (const [a, b, ...rest] of [...segs].sort((p, q) => p[0] - q[0])) {
      if (b <= from || a >= to) continue;
      const v = f(a, b, ...rest), s = Math.max(a, from), e = Math.min(b, to);
      if (s > t) pts.push([t, 0], [s, 0]);
      pts.push([s, v], [e, v]);
      t = e;
    }
    if (t < to) pts.push([t, 0], [to, 0]);
    return pts;
  }

  function drawPrecip(ctx, o, { x, top, bottom, W, nowX, clip, c }) {
    const p = o.precip;
    const rate = (a, b, mm) => mm / ((b - a) / HOUR);
    const obsPts = stepPoints(p.obs || [], o.from, o.now, rate);
    const mmMax = Math.max(1, Math.ceil(Math.max(...obsPts.map((q) => q[1]))));
    const yMm = (v) => bottom - (v / mmMax) * (bottom - top);
    const yPct = (v) => bottom - (v / 100) * (bottom - top);

    // Grid + axis labels: mm/h on the left (past), % on the right (future)
    ctx.strokeStyle = c.line; ctx.lineWidth = 1; ctx.fillStyle = c.muted; ctx.font = `11px ${c.font}`;
    for (const f of [0, 0.5, 1]) {
      const yy = Math.round(bottom - f * (bottom - top)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W, yy); ctx.stroke();
      if (f === 0) continue;
      if (nowX > 60) { ctx.textAlign = "left"; ctx.fillText(`${+(mmMax * f).toFixed(1)} mm/h`, 4, yy - 4); }
      if (W - nowX > 50) { ctx.textAlign = "right"; ctx.fillText(`${100 * f}%`, W - 4, yy - 4); }
    }
    ctx.textAlign = "center";

    const area = (pts, yf, col, a0) => {
      ctx.beginPath(); pts.forEach(([t, v], i) => (i ? ctx.lineTo(x(t), yf(v)) : ctx.moveTo(x(t), yf(v))));
      const line = new Path2D(); pts.forEach(([t, v], i) => (i ? line.lineTo(x(t), yf(v)) : line.moveTo(x(t), yf(v))));
      ctx.lineTo(x(pts[pts.length - 1][0]), bottom); ctx.lineTo(x(pts[0][0]), bottom); ctx.closePath();
      const g = ctx.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, alpha(col, a0)); g.addColorStop(1, alpha(col, 0));
      ctx.fillStyle = g; ctx.fill();
      return line;
    };

    // Past: observed amount
    if (obsPts.length) clip(0, nowX, () => {
      const line = area(obsPts, yMm, c.text, 0.12);
      ctx.strokeStyle = c.text; ctx.lineWidth = 1.8; ctx.lineJoin = "round"; ctx.stroke(line);
    });

    // Future: chance, coloured by precipitation type
    const chance = (p.chance || []).filter((s) => s[1] > o.now);
    if (chance.length && chance[0][0] > o.now) chance[0] = [o.now, ...chance[0].slice(1)];
    const pts = stepPoints(chance, o.now, o.to, (a, b, pct) => pct);
    if (pts.length) clip(nowX, W, () => {
      const line = area(pts, yPct, c.accent, 0.16);
      ctx.lineWidth = 2; ctx.lineJoin = "round";
      // Each period drawn once in its precipitation-type colour
      let end = nowX;
      for (const [a, b, pct, kind] of chance) {
        const col = !pct || kind === "rain" ? c.accent : kind === "snow" ? c.snow : c.mix;
        const x0 = Math.max(x(a), end), x1 = Math.min(x(b), W);
        if (x1 <= x0) continue;
        clip(x0, x1, () => { ctx.strokeStyle = col; ctx.stroke(line); });
        end = x1;
      }
      if (end < W) clip(end, W, () => { ctx.strokeStyle = c.accent; ctx.stroke(line); });
    });

    // Forecast amounts EC gives in the text forecast (e.g. "5–10 mm")
    ctx.font = `600 10px ${c.font}`;
    for (const [a, b, label] of p.amounts || []) {
      const x0 = Math.max(x(a), nowX + 4), x1 = Math.min(x(b), W);
      if (x1 - x0 < ctx.measureText(label).width + 6) continue;
      ctx.fillStyle = c.text; ctx.fillText(label, (x0 + x1) / 2, top - 2);
    }
    ctx.font = `11px ${c.font}`;
  }

  return { draw, valueAt, barAt, HOUR, DAY };
})();
