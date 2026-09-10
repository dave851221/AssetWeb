// The chart system: one ECharts theme, a handful of option builders, and the
// mount/dispose plumbing.
//
// Every mark spec lives here rather than in the views, so "thin marks, hairline
// grid, 2px lines, 4px rounded data-ends, a 2px surface gap between stacked
// segments" is true by construction instead of by remembering.
//
// ## Rules this file enforces
//
// - **One y-axis, never two.** A second scale invents a correlation the data
//   does not contain, so a measure on a different scale gets its own chart. The
//   USD/TWD rate is the case in point: it is a separate small chart beside the
//   asset curve, not a right-hand axis on it.
// - **Categorical hues in fixed slot order, never cycled.** Colour follows the
//   entity - a broker keeps its hue across every chart and every filter, so
//   hiding a series never repaints the survivors. Past 8, fold into "其他".
// - **Text never wears the data colour.** Axis labels, values and legends use
//   the ink tokens; identity comes from the coloured mark beside the text. The
//   one exception is a label set inside a filled segment, where the fill's
//   luminance picks white or ink.
// - **Gain/loss colour is 紅漲綠跌 - and never the only channel.** Red-vs-green
//   is the classic colour-vision failure (validated: CVD ΔE 4.4, below the
//   floor), so every chart that uses it also encodes the sign by *position* -
//   bars grow from a zero baseline, up or down, left or right - and carries a
//   signed direct label. Hue is the third, redundant channel. Inverting to the
//   Western convention was rejected: the reader's instinct comes from Taiwanese
//   broker apps, and AssetSync's own Excel already colours gains red.
// - **A legend whenever there are two or more series**, so identity is never
//   colour-alone. One series gets none - the card title already names it.

import { el, money, signedMoney, pct, signedPct, int, shares, isNum } from "./util.js";

/** @typedef {import('./util.js').Card} Card */

const ec = () => {
  const lib = /** @type {any} */ (window).echarts;
  if (!lib) throw new Error("圖表程式庫沒有載入（vendor/echarts.min.js）");
  return lib;
};

// ------------------------------------------------------------------ tokens ---

/**
 * Design tokens, read from the stylesheet so css/app.css stays the single
 * source of truth for colour.
 */
let TOKENS = null;
function tokens() {
  if (TOKENS) return TOKENS;
  const s = getComputedStyle(document.documentElement);
  const v = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
  TOKENS = {
    surface: v("--surface-1", "#fcfcfb"),
    ink: v("--text-1", "#0b0b0b"),
    ink2: v("--text-2", "#52514e"),
    muted: v("--text-muted", "#898781"),
    grid: v("--grid", "#e1e0d9"),
    axis: v("--axis", "#c3c2b7"),
    up: v("--up", "#d03b3b"),
    down: v("--down", "#0f9d58"),
    // Categorical slots in the validated order. Worst adjacent CVD ΔE 9.1,
    // worst adjacent normal-vision ΔE 19.6 - both clear of the gates.
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--series-${i}`, "#2a78d6")),
    // One-hue sequential ramp, light to dark, for magnitude.
    seq: [100, 250, 400, 550].map((i) => v(`--seq-${i}`, "#3987e5")),
  };
  return TOKENS;
}

/** The fixed hue for a categorical slot. Never cycled: past 8, fold to 其他. */
export const slot = (i) => tokens().series[Math.min(i, 7)];

/** Gain red, loss green - always alongside position and a signed label. */
const pnlColor = (v) => (v >= 0 ? tokens().up : tokens().down);

const FONT = 'system-ui, -apple-system, "Segoe UI", "Noto Sans TC", sans-serif';

/** Axis-tick scale for TWD: a seven-figure sum reads better as 萬 than as digits. */
export function compact(v) {
  if (!Number.isFinite(v)) return "";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(a >= 1e9 ? 0 : 1)}億`;
  if (a >= 1e4) return `${sign}${(a / 1e4).toFixed(a >= 1e6 ? 0 : 1)}萬`;
  return sign + Math.round(a).toLocaleString("zh-TW");
}

// ------------------------------------------------------------------- mount ---

/**
 * Put a chart in a card.
 *
 * Init is deferred one frame on purpose: a view builds its whole tree before
 * boot.js appends it, so at build time the container is not in the document and
 * has no size - ECharts would measure 0×0 and stay that way. By the next frame
 * layout has happened.
 *
 * The returned holder exposes `dispose()`, which is what boot.js calls before
 * emptying `<main>`. Dropping the DOM node releases neither the canvas nor the
 * resize observer, so ten tab switches would leak ten charts.
 *
 * @param {Card} card
 * @param {any} option
 * @param {{class?: string, onclick?: (params: any) => void, height?: number}} [opts]
 */
export function mount(card, option, opts = {}) {
  const host = el("div", {
    class: opts.class || "chart",
    // An explicit height wins over the class, for charts whose natural size
    // depends on how many rows the data has.
    style: opts.height ? `height:${Math.round(opts.height)}px` : null,
  });
  const holder = {
    chart: /** @type {any} */ (null),
    raf: 0,
    ro: /** @type {ResizeObserver|null} */ (null),
    dispose() {
      if (this.raf) cancelAnimationFrame(this.raf);
      if (this.ro) this.ro.disconnect();
      if (this.chart) this.chart.dispose();
      this.chart = null;
    },
  };
  card.charts.push(holder);
  holder.raf = requestAnimationFrame(() => {
    holder.raf = 0;
    holder.chart = ec().init(host, null, { renderer: "canvas" });
    holder.chart.setOption(option);
    if (opts.onclick) holder.chart.on("click", opts.onclick);
    holder.ro = new ResizeObserver(() => holder.chart?.resize());
    holder.ro.observe(host);
  });
  return host;
}

/**
 * Dispose every chart owned by the cards under `root`.
 *
 * Used by the shell before it empties `<main>`, and by views that repaint a
 * section in place when a filter changes - both need the same guarantee, and a
 * missed one leaks a canvas plus a ResizeObserver.
 *
 * @param {ParentNode} root
 */
export function disposeIn(root) {
  for (const node of root.querySelectorAll(".card")) {
    const charts = /** @type {any} */ (node).charts;
    if (!Array.isArray(charts)) continue;
    for (const holder of charts) {
      try { holder.dispose(); } catch { /* already gone */ }
    }
    charts.length = 0;
  }
}

// ------------------------------------------------------------------- theme ---

/** Shared chrome. Grid/axis recede; the data is the only loud thing. */
function base(t) {
  return {
    animationDuration: 320,
    textStyle: { fontFamily: FONT, color: t.ink2 },
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      backgroundColor: t.surface,
      borderColor: t.grid,
      borderWidth: 1,
      padding: [8, 10],
      // Values lead and labels follow: the reader already knows the series and
      // wants the number, so the number gets the ink.
      textStyle: { color: t.ink, fontSize: 12.5, fontFamily: FONT },
      extraCssText: "box-shadow:0 8px 24px rgba(11,11,11,.10);border-radius:8px;",
    },
  };
}

const axisLine = (t) => ({ lineStyle: { color: t.axis, width: 1 } });
const splitLine = (t) => ({ lineStyle: { color: t.grid, width: 1, type: "solid" } });

/** A value axis. Hairline grid, muted ticks, compacted numbers. */
function valueAxis(t, { name = "", fmt = compact } = {}) {
  return {
    type: "value",
    name,
    nameTextStyle: { color: t.muted, fontSize: 11, align: "left" },
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: t.muted, fontSize: 11, formatter: fmt },
    splitLine: splitLine(t),
  };
}

/**
 * A category axis.
 *
 * @param {any} t
 * @param {(string|number)[]} data
 * @param {{rotate?: number, fmt?: ((v: any) => string)|null}} [opts]
 */
function catAxis(t, data, { rotate = 0, fmt = null } = {}) {
  return {
    type: "category",
    data,
    axisLine: axisLine(t),
    axisTick: { show: false },
    axisLabel: { color: t.muted, fontSize: 11, rotate, ...(fmt ? { formatter: fmt } : {}) },
    splitLine: { show: false },
  };
}

/** A legend. Present whenever there are two or more series. */
function legend(t, { top = 0, right = 0 } = {}) {
  return {
    top, right,
    icon: "roundRect",
    itemWidth: 10, itemHeight: 10, itemGap: 14,
    textStyle: { color: t.ink2, fontSize: 12 },
  };
}

/** Crosshair tooltip: readers aim at a date, never at a 2px line. */
const axisPointer = (t) => ({
  type: "line",
  lineStyle: { color: t.axis, width: 1 },
  label: { show: false },
});

// --------------------------------------------------------------- builders ---

/**
 * A single-series time line with a wash fill.
 *
 * One series, so no legend - the card title names it. The value is direct
 * labelled at the end point only; labelling every point is chaos.
 *
 * @param {{days: string[], values: (number|null)[], label: string,
 *          color?: string, fmt?: (v: number) => string,
 *          endFmt?: (v: number) => string, endLabel?: boolean,
 *          baseline?: 'zero'|'data'}} spec
 */
export function timeLine({
  days, values, label, color, fmt = (v) => money(v), endFmt = compact,
  endLabel = true, baseline = "data",
}) {
  const t = tokens();
  const hue = color || slot(0);
  // A balance that never goes near zero wastes most of a zero-based plot: net
  // worth between 5.4M and 7.3M drawn from 0 puts the whole series in the top
  // eighth of the card and hides the shape the reader came for. So the axis is
  // fitted to the data - and the area fill goes with it, because a fill claims
  // magnitude measured from the baseline, while a bare line only claims
  // position. The axis labels stay visible so the truncation is never implicit.
  const fitted = baseline === "data";
  const nums = values.filter(isNum);
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.02 || 1;
  // Explicit bounds mean ECharts stops picking round tick values, so the
  // padded ends are rounded here instead - otherwise the axis is labelled with
  // whatever the padding arithmetic produced, which is a computation showing
  // through the interface.
  const step = Math.pow(10, Math.floor(Math.log10(hi - lo || Math.abs(hi) || 1)) - 1);
  const niceLo = Math.floor((lo - pad) / step) * step;

  return {
    ...base(t),
    tooltip: {
      ...base(t).tooltip,
      trigger: "axis",
      axisPointer: axisPointer(t),
      formatter: (ps) => {
        const p = ps[0];
        return `<div style="color:${t.muted};font-size:11.5px">${p.axisValue}</div>`
          + `<div style="font-weight:650;font-size:14px">${fmt(p.value)}</div>`
          + `<div style="color:${t.ink2};font-size:11.5px">${label}</div>`;
      },
    },
    grid: { left: 8, right: endLabel ? 76 : 16, top: 16, bottom: 8, containLabel: true },
    xAxis: catAxis(t, days, { fmt: (d) => String(d).slice(5) }),
    yAxis: fitted
      // Only the floor is pinned. Pinning the ceiling too made ECharts print
      // the exact maximum as an extra tick right on top of the round one.
      ? { ...valueAxis(t), min: niceLo, scale: true }
      : valueAxis(t),
    series: [{
      type: "line",
      name: label,
      data: values,
      smooth: false,
      showSymbol: false,
      lineStyle: { width: 2, color: hue, cap: "round", join: "round" },
      itemStyle: { color: hue },
      // A wash, never a saturated block - and only when the baseline is zero,
      // since that is the only case where the filled area means anything.
      ...(fitted ? {} : { areaStyle: { color: hue, opacity: 0.1 } }),
      endLabel: endLabel ? {
        show: true, color: t.ink, fontSize: 12, fontWeight: 600,
        // Its own formatter, short enough to fit in the right margin: the
        // tooltip carries the full-precision value. compact() suits money;
        // a rate passes its own, since "32" is useless where 31.5382 is meant.
        formatter: (p) => endFmt(p.value),
      } : { show: false },
    }],
  };
}

/**
 * Stacked areas: part-to-whole over time.
 *
 * `percent` only switches the axis and tooltip to percentages - the caller
 * normalises the values, because ECharts does not normalise a stacked line
 * series and a half-normalised chart is worse than none.
 *
 * @param {{days: string[], series: {name: string, values: (number|null)[]}[],
 *          percent?: boolean}} spec
 */
export function stackedArea({ days, series, percent = false }) {
  const t = tokens();
  return {
    ...base(t),
    tooltip: {
      ...base(t).tooltip,
      trigger: "axis",
      axisPointer: axisPointer(t),
      // One tooltip lists every series at that x, so the pointer never has to
      // land on a particular band to get a value.
      formatter: (ps) => {
        const head = `<div style="color:${t.muted};font-size:11.5px">${ps[0].axisValue}</div>`;
        const rows = ps.filter((p) => p.value !== null && p.value !== undefined).map((p) =>
          `<div style="display:flex;gap:12px;justify-content:space-between">`
          + `<span style="color:${t.ink2}">`
          + `<span style="display:inline-block;width:10px;height:2px;background:${p.color};`
          + `vertical-align:middle;margin-right:6px"></span>${p.seriesName}</span>`
          + `<b>${percent ? pct(p.value / 100, 1) : compact(p.value)}</b></div>`).join("");
        return head + rows;
      },
    },
    legend: legend(t),
    grid: { left: 8, right: 16, top: 34, bottom: 8, containLabel: true },
    xAxis: catAxis(t, days, { fmt: (d) => String(d).slice(5) }),
    yAxis: percent
      ? { ...valueAxis(t, { fmt: (v) => `${v}%` }), min: 0, max: 100, interval: 25 }
      : valueAxis(t),
    series: series.map((s, i) => ({
      type: "line",
      name: s.name,
      data: s.values,
      stack: "total",
      showSymbol: false,
      lineStyle: { width: 0 },
      // A stack of washes would be muddy where they overlap; opaque bands with
      // a surface hairline between them read as separate areas.
      areaStyle: { color: slot(i), opacity: 0.85 },
      itemStyle: { color: slot(i) },
      emphasis: { focus: "series" },
    })),
  };
}

/**
 * Columns that grow up or down from a zero baseline - daily change, and
 * anything else whose sign is the point.
 *
 * The sign is carried by direction first; hue is redundant reinforcement.
 *
 * @param {{days: string[], values: (number|null)[], label: string}} spec
 */
export function divergingColumns({ days, values, label }) {
  const t = tokens();
  return {
    ...base(t),
    tooltip: {
      ...base(t).tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: "rgba(11,11,11,.04)" } },
      formatter: (ps) => {
        const p = ps[0];
        return `<div style="color:${t.muted};font-size:11.5px">${p.axisValue}</div>`
          + `<div style="font-weight:650;font-size:14px">${signedMoney(p.value)}</div>`
          + `<div style="color:${t.ink2};font-size:11.5px">${label}</div>`;
      },
    },
    xAxis: catAxis(t, days, { fmt: (d) => String(d).slice(5) }),
    yAxis: valueAxis(t),
    series: [{
      type: "bar",
      name: label,
      data: values.map((v) => ({
        value: v,
        itemStyle: {
          color: pnlColor(v ?? 0),
          // Rounded at the data end, square at the baseline - and the end
          // flips with the sign.
          borderRadius: (v ?? 0) >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3],
        },
      })),
      barMaxWidth: 24,
    }],
  };
}

/**
 * The pixel height a horizontal bar chart needs for `n` rows.
 *
 * Below roughly 22px per row ECharts starts hiding category labels, and a bar
 * whose name is hidden is a bar nobody can identify. So the chart grows with
 * the data instead of squeezing it.
 */
export const barRows = (n, { top = 40, min = 200 } = {}) =>
  Math.max(min, n * 22 + top);

/**
 * Horizontal bars, one hue - "compare magnitude, low to high".
 *
 * A single series with no natural ordering gets one colour, not a value ramp:
 * a ramp double-encodes bar length as lightness and spends the only free
 * channel on information the bar already shows.
 *
 * @param {{names: string[], values: number[], label: string,
 *          fmt?: (v: number) => string, sub?: string[]}} spec
 */
export function hbar({ names, values, label, fmt = (v) => money(v), sub }) {
  const t = tokens();
  return {
    ...base(t),
    tooltip: {
      ...base(t).tooltip,
      trigger: "item",
      formatter: (p) => `<div style="color:${t.muted};font-size:11.5px">${p.name}</div>`
        + `<div style="font-weight:650;font-size:14px">${fmt(p.value)}</div>`
        + (sub ? `<div style="color:${t.ink2};font-size:11.5px">${sub[p.dataIndex] ?? ""}</div>` : ""),
    },
    grid: { left: 8, right: 76, top: 8, bottom: 8, containLabel: true },
    xAxis: { ...valueAxis(t), splitLine: splitLine(t) },
    yAxis: {
      ...catAxis(t, names),
      inverse: true,
      // interval 0 = never skip a label. The host is sized by barRows() so
      // they all fit; letting ECharts thin them out would leave unnamed bars.
      axisLabel: { color: t.ink2, fontSize: 12, interval: 0 },
    },
    series: [{
      type: "bar",
      name: label,
      data: values,
      barMaxWidth: 20,
      itemStyle: { color: slot(0), borderRadius: [0, 4, 4, 0] },
      // Value at the tip: the axis carries the rest.
      label: {
        show: true, position: "right", color: t.ink2, fontSize: 11.5,
        formatter: (p) => compact(p.value),
      },
    }],
  };
}

/**
 * Horizontal stacked bars - part-to-whole per row.
 *
 * Horizontal because the row names are words, not dates: a vertical stack
 * would have to rotate them.
 *
 * @param {{names: string[], series: {name: string, values: number[]}[],
 *          fmt?: (v: number) => string}} spec
 */
export function stackedHBar({ names, series, fmt = (v) => money(v) }) {
  const t = tokens();
  return {
    ...base(t),
    tooltip: {
      ...base(t).tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: "rgba(11,11,11,.04)" } },
      formatter: (ps) => {
        const head = `<div style="color:${t.muted};font-size:11.5px">${ps[0].axisValue}</div>`;
        const rows = ps.map((p) =>
          `<div style="display:flex;gap:12px;justify-content:space-between">`
          + `<span style="color:${t.ink2}">`
          + `<span style="display:inline-block;width:10px;height:2px;background:${p.color};`
          + `vertical-align:middle;margin-right:6px"></span>${p.seriesName}</span>`
          + `<b>${fmt(p.value)}</b></div>`).join("");
        const sum = ps.reduce((a, p) => a + (p.value || 0), 0);
        return head + rows
          + `<div style="border-top:1px solid ${t.grid};margin-top:4px;padding-top:4px;`
          + `display:flex;gap:12px;justify-content:space-between">`
          + `<span style="color:${t.ink2}">合計</span><b>${fmt(sum)}</b></div>`;
      },
    },
    legend: legend(t),
    grid: { left: 8, right: 64, top: 34, bottom: 8, containLabel: true },
    xAxis: valueAxis(t),
    yAxis: {
      ...catAxis(t, names),
      inverse: true,
      axisLabel: { color: t.ink2, fontSize: 12 },
    },
    series: series.map((s, i) => ({
      type: "bar",
      name: s.name,
      data: s.values,
      stack: "total",
      barMaxWidth: 22,
      itemStyle: { color: slot(i), borderColor: t.surface, borderWidth: 1 },
      emphasis: { focus: "series" },
      // Only the last segment is labelled, with the row total at the tip -
      // interior segments have no free end, so the legend and tooltip carry
      // them rather than a clipped inline label.
      ...(i === series.length - 1 ? {
        label: {
          show: true, position: "right", color: t.ink2, fontSize: 11.5,
          formatter: (p) => compact(
            series.reduce((a, ss) => a + (ss.values[p.dataIndex] || 0), 0)),
        },
      } : {}),
    })),
  };
}

/**
 * Diverging horizontal bars - gains right, losses left, from a centre zero.
 *
 * @param {{names: string[], values: number[], label: string,
 *          sub?: string[], fmt?: (v: number) => string}} spec
 */
export function divergingBars({ names, values, label, sub, fmt = (v) => signedMoney(v) }) {
  const t = tokens();
  return {
    ...base(t),
    tooltip: {
      ...base(t).tooltip,
      trigger: "item",
      formatter: (p) => `<div style="color:${t.muted};font-size:11.5px">${p.name}</div>`
        + `<div style="font-weight:650;font-size:14px">${fmt(p.value)}</div>`
        + (sub ? `<div style="color:${t.ink2};font-size:11.5px">${sub[p.dataIndex] ?? ""}</div>` : ""),
    },
    // A gutter on both sides beyond what containLabel reserves. The value label
    // sits OUTSIDE the bar end, and containLabel only accounts for the axis's
    // own labels - so the longest bar in either direction ran its label into
    // the category names on the left.
    grid: { left: 52, right: 52, top: 8, bottom: 8, containLabel: true },
    xAxis: {
      ...valueAxis(t),
      // The zero line is the reference the whole chart is read against, so it
      // is darker than the grid.
      splitLine: splitLine(t),
    },
    yAxis: {
      ...catAxis(t, names),
      inverse: true,
      axisLine: { show: true, lineStyle: { color: t.axis } },
      axisLabel: { color: t.ink2, fontSize: 12, interval: 0 },
    },
    series: [{
      type: "bar",
      name: label,
      data: values.map((v) => ({
        value: v,
        itemStyle: {
          color: pnlColor(v),
          borderRadius: v >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4],
        },
        // Outward from the bar end, which for a loss means to the left. Set per
        // datum because a rect's reported width is always positive, so the sign
        // cannot be recovered from the layout.
        label: { position: v >= 0 ? "right" : "left" },
      })),
      barMaxWidth: 18,
      label: {
        show: true, color: t.ink2, fontSize: 11.5,
        formatter: (p) => compact(p.value),
      },
    }],
  };
}

/**
 * Part-to-whole at a glance. Donut, ≤6 segments, direct-labelled with share.
 *
 * Not for comparing close values - that is what the bar chart is for.
 *
 * @param {{items: {label: string, value: number}[], total?: number,
 *          centerLabel?: string, centerValue?: string}} spec
 */
export function donut({ items, centerLabel, centerValue }) {
  const t = tokens();
  const total = items.reduce((a, i) => a + i.value, 0);
  return {
    ...base(t),
    tooltip: {
      ...base(t).tooltip,
      trigger: "item",
      formatter: (p) => `<div style="color:${t.muted};font-size:11.5px">${p.name}</div>`
        + `<div style="font-weight:650;font-size:14px">${money(p.value)}</div>`
        + `<div style="color:${t.ink2};font-size:11.5px">${pct(p.value / total, 1)}</div>`,
    },
    legend: {
      ...legend(t),
      orient: "vertical", left: 0, top: "center",
      itemGap: 12,
      formatter: (name) => {
        const it = items.find((i) => i.label === name);
        return it ? `${name}　${compact(it.value)}　${pct(it.value / total, 1)}` : name;
      },
    },
    // The centre of a donut is free space that would otherwise be wasted; the
    // total belongs there, so the ring and the number are read together.
    graphic: centerValue ? [{
      type: "group",
      left: "62%", top: "middle",
      children: [
        { type: "text", left: "center", top: -18,
          style: { text: centerLabel || "", fill: t.muted, font: `11.5px ${FONT}`, textAlign: "center" } },
        { type: "text", left: "center", top: 0,
          style: { text: centerValue, fill: t.ink, font: `600 18px ${FONT}`, textAlign: "center" } },
      ],
    }] : [],
    series: [{
      type: "pie",
      radius: ["52%", "76%"],
      center: ["62%", "50%"],
      avoidLabelOverlap: true,
      // A 2px surface gap does the separating; no stroke around the mark.
      itemStyle: { borderColor: t.surface, borderWidth: 2 },
      // No slice labels. With four slices the legend beside the ring already
      // carries name, value and share, so labels only restated it - and the
      // leader lines for the two small slices collided with each other at the
      // top of the donut. The ring keeps the shape; the legend keeps the words.
      label: { show: false },
      labelLine: { show: false },
      data: items.map((i, n) => ({
        name: i.label, value: i.value, itemStyle: { color: slot(n) },
      })),
    }],
  };
}

/**
 * Grouped or stacked columns by year.
 *
 * @param {{years: (string|number)[], series: {name: string, values: number[]}[],
 *          stack?: boolean, fmt?: (v: number) => string}} spec
 */
export function yearColumns({ years, series, stack = true, fmt = (v) => signedMoney(v) }) {
  const t = tokens();
  return {
    ...base(t),
    tooltip: {
      ...base(t).tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: "rgba(11,11,11,.04)" } },
      formatter: (ps) => {
        const head = `<div style="color:${t.muted};font-size:11.5px">${ps[0].axisValue} 年</div>`;
        const rows = ps.map((p) =>
          `<div style="display:flex;gap:12px;justify-content:space-between">`
          + `<span style="color:${t.ink2}">`
          + `<span style="display:inline-block;width:10px;height:2px;background:${p.color};`
          + `vertical-align:middle;margin-right:6px"></span>${p.seriesName}</span>`
          + `<b>${fmt(p.value)}</b></div>`).join("");
        const sum = ps.reduce((a, p) => a + (p.value || 0), 0);
        return head + rows + (ps.length > 1
          ? `<div style="border-top:1px solid ${t.grid};margin-top:4px;padding-top:4px;`
            + `display:flex;gap:12px;justify-content:space-between">`
            + `<span style="color:${t.ink2}">合計</span><b>${fmt(sum)}</b></div>`
          : "");
      },
    },
    legend: series.length > 1 ? legend(t) : undefined,
    grid: { left: 8, right: 16, top: series.length > 1 ? 34 : 16, bottom: 8, containLabel: true },
    xAxis: catAxis(t, years.map(String)),
    yAxis: valueAxis(t),
    series: series.map((s, i) => ({
      type: "bar",
      name: s.name,
      data: s.values,
      ...(stack ? { stack: "total" } : {}),
      barMaxWidth: 32,
      itemStyle: {
        color: slot(i),
        // The surface hairline is the gap between stacked segments.
        ...(stack ? { borderColor: t.surface, borderWidth: 1 } : { borderRadius: [3, 3, 0, 0] }),
      },
      emphasis: { focus: "series" },
    })),
  };
}

/**
 * Treemap: area is market value, colour is the broker that holds it.
 *
 * Colour is categorical on purpose. Mapping colour to return would put a
 * red-green ramp on the one channel with nothing to back it up, and that ramp
 * is exactly the colour-vision failure case. Return gets its own diverging bar
 * chart, where position carries the sign.
 *
 * @param {{groups: {name: string, children: {name: string, short?: string,
 *          value: number, sub: string}[]}[]}} spec
 */
export function treemap({ groups }) {
  const t = tokens();
  const total = groups.reduce((a, g) => a + g.children.reduce((b, c) => b + c.value, 0), 0);
  return {
    ...base(t),
    tooltip: {
      ...base(t).tooltip,
      formatter: (p) => `<div style="color:${t.muted};font-size:11.5px">${p.name}</div>`
        + `<div style="font-weight:650;font-size:14px">${money(p.value)}</div>`
        + `<div style="color:${t.ink2};font-size:11.5px">`
        + `${pct(p.value / total, 1)}${p.data?.sub ? " · " + p.data.sub : ""}</div>`,
    },
    series: [{
      type: "treemap",
      roam: false,
      nodeClick: false,
      breadcrumb: { show: false },
      top: 0, left: 0, right: 0, bottom: 0,
      // The surface gap again: 2px of background between tiles.
      itemStyle: { borderColor: t.surface, borderWidth: 2, gapWidth: 2 },
      label: {
        show: true, color: "#fff", fontSize: 12, fontFamily: FONT,
        // The ticker, not the name: a tile is only as wide as its value, and a
        // long fund name truncates to "VANGUARD S&P 500 E...". A clipped label
        // is worse than none. The full name is in the tooltip.
        overflow: "truncate",
        formatter: (p) => (p.data.short || p.name),
      },
      upperLabel: { show: false },
      levels: [
        { itemStyle: { borderWidth: 0, gapWidth: 2 } },
        { itemStyle: { borderColor: t.surface, borderWidth: 2, gapWidth: 2 } },
      ],
      data: groups.map((g, i) => ({
        name: g.name,
        itemStyle: { color: slot(i) },
        children: g.children.map((c) => ({
          name: c.name, value: c.value, sub: c.sub, short: c.short || c.name,
          itemStyle: { color: slot(i) },
        })),
      })),
    }],
  };
}

/**
 * Bubble scatter: return against cost, sized by market value.
 *
 * This is an all-pairs form (any two bubbles can end up adjacent), so it is
 * capped at the three categorical slots that validate all-pairs. Three brokers
 * is exactly the budget.
 *
 * @param {{groups: {name: string, points: {x: number, y: number, r: number, name: string, sub: string}[]}[]}} spec
 */
export function bubble({ groups }) {
  const t = tokens();
  const maxR = Math.max(1, ...groups.flatMap((g) => g.points.map((p) => p.r)));
  return {
    ...base(t),
    tooltip: {
      ...base(t).tooltip,
      trigger: "item",
      formatter: (p) => `<div style="color:${t.muted};font-size:11.5px">${p.data.name}</div>`
        + `<div style="font-weight:650;font-size:14px">${signedPct(p.data.x)}</div>`
        + `<div style="color:${t.ink2};font-size:11.5px">`
        + `成本 ${compact(p.data.y)}　市值 ${compact(p.data.r)}</div>`
        + `<div style="color:${t.ink2};font-size:11.5px">${p.data.sub}</div>`,
    },
    legend: legend(t),
    grid: { left: 8, right: 24, top: 34, bottom: 26, containLabel: true },
    xAxis: {
      ...valueAxis(t, { fmt: (v) => `${(v * 100).toFixed(0)}%` }),
      name: "報酬率",
      // "end" (the default) puts the name past the last tick, where it gets
      // clipped by the grid edge.
      nameLocation: "middle",
      nameGap: 26,
      nameTextStyle: { color: t.muted, fontSize: 11 },
      // Zero return is the line the whole chart is read against.
      splitLine: splitLine(t),
    },
    yAxis: {
      ...valueAxis(t),
      name: "持有成本 (TWD)",
      nameLocation: "end",
      nameGap: 12,
      nameTextStyle: { color: t.muted, fontSize: 11, align: "left" },
    },
    series: groups.map((g, i) => ({
      type: "scatter",
      name: g.name,
      data: g.points.map((p) => ({ value: [p.x, p.y, p.r], ...p })),
      symbolSize: (d) => 10 + 34 * Math.sqrt((d[2] ?? 0) / maxR),
      // A 2px surface ring keeps overlapping bubbles legible.
      itemStyle: { color: slot(i), opacity: 0.75, borderColor: t.surface, borderWidth: 2 },
      emphasis: { itemStyle: { opacity: 1 } },
    })),
  };
}

/**
 * Categorical columns - one series, one hue. The histogram form.
 *
 * A distribution is a count per bucket, and a count has no sign, no ranking and
 * no second dimension - so it gets one colour and nothing else. Where the
 * buckets straddle zero (a return, a premium over the average cost), `divider`
 * puts a rule between the last negative bucket and the first positive one: the
 * sign is then carried by POSITION along the axis, which is the requirement
 * red-vs-green cannot meet on its own. Bucket labels print their own signs too.
 *
 * Vertical rather than horizontal because the buckets are ordered - a
 * distribution read left to right is the convention every reader already has.
 *
 * `rotate` defaults to slanting the labels once there are enough buckets that
 * horizontal ones would collide. It is never allowed to *drop* a label: a bar
 * whose bucket is unnamed cannot be read at all, which is why `interval: 0` is
 * forced here rather than left to ECharts' thinning heuristic.
 *
 * @param {{names: string[], values: number[], label: string,
 *          fmt?: (v: number) => string, color?: string, rotate?: number|null,
 *          divider?: number|null, dividerLabel?: string, sub?: string[],
 *          yName?: string}} spec
 */
export function columns({
  names, values, label, fmt = (v) => int(v), color, rotate = null,
  divider = null, dividerLabel = "", sub, yName = "",
}) {
  const t = tokens();
  const hue = color || slot(0);
  const tilt = rotate ?? (names.length > 7 ? 30 : 0);
  /** @type {any[]} */
  const lines = [];
  if (divider !== null) {
    lines.push({
      // Between two categories, not on one: the boundary is the zero point,
      // and drawing it through a bucket would claim that bucket is the zero.
      xAxis: divider + 0.5,
      lineStyle: { type: "dashed", width: 1.5, color: t.axis },
      label: {
        formatter: dividerLabel, color: t.ink2, fontSize: 11,
        // Above the plot, horizontal. Left to itself ECharts rotates a label
        // to follow its line, which for a vertical rule prints the words
        // sideways down the middle of the bars.
        position: "end", rotate: 0, distance: 6,
        align: "center", verticalAlign: "bottom",
      },
    });
  }

  return {
    ...base(t),
    tooltip: {
      ...base(t).tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: "rgba(11,11,11,.04)" } },
      formatter: (ps) => {
        const p = ps[0];
        return `<div style="color:${t.muted};font-size:11.5px">${p.axisValue}</div>`
          + `<div style="font-weight:650;font-size:14px">${fmt(p.value)}</div>`
          + `<div style="color:${t.ink2};font-size:11.5px">`
          + `${sub?.[p.dataIndex] ?? label}</div>`;
      },
    },
    grid: {
      left: 8, right: 16,
      // The divider's label sits above the plot, so it needs the room.
      top: divider !== null ? 40 : 26,
      bottom: 8, containLabel: true,
    },
    xAxis: {
      ...catAxis(t, names, { rotate: tilt }),
      // interval 0 = never skip a label. A histogram with half its buckets
      // unnamed is a row of anonymous bars; the card is sized (and on a phone
      // wrapped in .chart-scroll) so that they all fit.
      axisLabel: { color: t.muted, fontSize: 11, rotate: tilt, interval: 0 },
    },
    yAxis: valueAxis(t, { name: yName, fmt: (v) => compact(v) }),
    series: [{
      type: "bar",
      name: label,
      data: values,
      barMaxWidth: 44,
      itemStyle: { color: hue, borderRadius: [3, 3, 0, 0] },
      // Direct labels: a histogram is read for its shape first and its counts
      // second, and the counts are short enough to sit on top of every bar.
      label: {
        show: true, position: "top", color: t.ink2, fontSize: 11,
        formatter: (p) => (p.value ? fmt(p.value) : ""),
      },
      ...(lines.length ? { markLine: { symbol: "none", silent: true, data: lines } } : {}),
    }],
  };
}

/**
 * A general scatter of two measures, grouped into at most three categories.
 *
 * The three-colour cap is not stylistic. A scatter is an all-pairs form - any
 * two marks can end up adjacent - and only the first three categorical slots
 * clear the colour-vision gate for every pair. A fourth group has to fold into
 * "其他" before it gets here.
 *
 * `zeroLine` darkens y = 0 where the y measure has a sign, so the split between
 * winners and losers is a position on the plot and not a hue.
 *
 * @param {{groups: {name: string, points: {x: number, y: number, r?: number,
 *            name: string, sub?: string}[]}[],
 *          xName?: string, yName?: string,
 *          xFmt?: (v: number) => string, yFmt?: (v: number) => string,
 *          zeroLine?: boolean, xLabelFmt?: (v: number) => string,
 *          yLabelFmt?: (v: number) => string}} spec
 */
export function scatterXY({
  groups, xName = "", yName = "",
  xFmt = (v) => String(v), yFmt = (v) => String(v),
  xLabelFmt, yLabelFmt, zeroLine = false,
}) {
  const t = tokens();
  const maxR = Math.max(1, ...groups.flatMap((g) => g.points.map((p) => p.r ?? 0)));
  const sized = maxR > 1;

  return {
    ...base(t),
    tooltip: {
      ...base(t).tooltip,
      trigger: "item",
      formatter: (p) => `<div style="color:${t.muted};font-size:11.5px">${p.data.name}</div>`
        + `<div style="font-weight:650;font-size:14px">${yFmt(p.data.y)}</div>`
        + `<div style="color:${t.ink2};font-size:11.5px">${xName}　${xFmt(p.data.x)}</div>`
        + (p.data.sub ? `<div style="color:${t.ink2};font-size:11.5px">${p.data.sub}</div>` : ""),
    },
    // Top-LEFT, unlike the other builders. A scatter is one of the charts that
    // gets a floor width and scrolls on a phone, and a right-anchored legend
    // would start off-screen there - identity has to be visible before the
    // reader thinks to swipe. The y-axis name takes the line below it.
    legend: groups.length > 1 ? { ...legend(t), right: undefined, left: 0 } : undefined,
    grid: { left: 8, right: 24, top: groups.length > 1 ? 50 : 16, bottom: 28, containLabel: true },
    xAxis: {
      ...valueAxis(t, { fmt: xLabelFmt ?? ((v) => compact(v)) }),
      name: xName,
      nameLocation: "middle",
      nameGap: 26,
      nameTextStyle: { color: t.muted, fontSize: 11 },
      splitLine: splitLine(t),
      scale: true,
    },
    yAxis: {
      ...valueAxis(t, { fmt: yLabelFmt ?? ((v) => compact(v)) }),
      name: yName,
      nameLocation: "end",
      nameGap: 12,
      nameTextStyle: { color: t.muted, fontSize: 11, align: "left" },
      scale: true,
    },
    series: [
      ...groups.slice(0, 3).map((g, i) => ({
        type: "scatter",
        name: g.name,
        data: g.points.map((p) => ({ value: [p.x, p.y, p.r ?? 0], ...p })),
        symbolSize: sized
          ? (d) => 8 + 26 * Math.sqrt((d?.[2] ?? 0) / maxR)
          : 11,
        // A surface ring keeps overlapping marks legible.
        itemStyle: { color: slot(i), opacity: 0.75, borderColor: t.surface, borderWidth: 1.5 },
        emphasis: { itemStyle: { opacity: 1 } },
        // The zero rule rides on the first series so it is drawn once.
        ...(i === 0 && zeroLine ? {
          markLine: {
            symbol: "none", silent: true,
            data: [{ yAxis: 0, lineStyle: { type: "solid", width: 1.25, color: t.axis } }],
            label: { show: false },
          },
        } : {}),
      })),
    ],
  };
}

/**
 * A heatmap over two categorical axes, with a sequential ramp for magnitude.
 *
 * One hue, light to dark: the value has a natural low-to-high order and no
 * sign, which is exactly what a single-hue ramp encodes and what a categorical
 * palette would destroy. The `visualMap` bar under the plot is the legend -
 * a heatmap is one series, so ECharts has no series names to build one from.
 *
 * Cells carry no printed value at these densities; the tooltip does. A number
 * inside every tile of a twelve-by-seven grid is unreadable at card width and
 * would have to wear the fill colour to fit, which the type rules forbid.
 *
 * @param {{xNames: string[], yNames: string[],
 *          cells: [number, number, number][], label: string,
 *          fmt?: (v: number) => string, max?: number}} spec
 */
export function heatmap({ xNames, yNames, cells, label, fmt = (v) => int(v), max }) {
  const t = tokens();
  const top = max ?? Math.max(1, ...cells.map((c) => c[2]));
  return {
    ...base(t),
    tooltip: {
      ...base(t).tooltip,
      trigger: "item",
      formatter: (p) => `<div style="color:${t.muted};font-size:11.5px">`
        + `${yNames[p.data[1]]}　${xNames[p.data[0]]}</div>`
        + `<div style="font-weight:650;font-size:14px">${fmt(p.data[2])}</div>`
        + `<div style="color:${t.ink2};font-size:11.5px">${label}</div>`,
    },
    grid: { left: 8, right: 16, top: 12, bottom: 46, containLabel: true },
    xAxis: {
      ...catAxis(t, xNames),
      splitArea: { show: false },
      axisLabel: { color: t.muted, fontSize: 11, interval: 0 },
    },
    yAxis: {
      ...catAxis(t, yNames),
      axisLabel: { color: t.ink2, fontSize: 12, interval: 0 },
      axisLine: { show: false },
    },
    visualMap: {
      min: 0, max: top,
      calculable: false,
      orient: "horizontal",
      // Left, not centred: this chart gets a floor width and scrolls on a
      // phone, and the visual map IS the legend - it has to be on screen
      // before the reader swipes, or the shading means nothing.
      left: 8, bottom: 4,
      itemWidth: 12, itemHeight: 110,
      textStyle: { color: t.muted, fontSize: 11 },
      text: [fmt(top), "0"],
      inRange: { color: [t.surface, ...t.seq] },
    },
    series: [{
      type: "heatmap",
      name: label,
      data: cells,
      // The surface gap again, so the grid reads as tiles rather than a wash.
      itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 3 },
      emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 2 } },
    }],
  };
}

/**
 * A legend as HTML, for the forms ECharts cannot legend itself.
 *
 * A treemap is a single series, so ECharts has no series names to build a
 * legend from - but identity must never rest on colour alone, so the card
 * carries one of these instead.
 *
 * @param {string[]} names
 */
export function htmlLegend(names) {
  return el("div", { class: "legend" }, names.map((name, i) =>
    el("span", { class: "key" }, [
      el("span", { class: "swatch", style: `background:${slot(i)}` }),
      el("span", { text: name }),
    ])));
}

/**
 * Fill prices over time, as dots - one per order.
 *
 * **Dots, not columns, on purpose.** A price axis for this has to start above
 * zero or the whole spread between fills collapses into one solid block - and a
 * bar chart on a truncated axis overstates every difference, because a bar's
 * length is read as its value. A dot only claims a position, so a non-zero axis
 * is honest for it.
 *
 * Buys and sells are two series, so the legend carries the side and colour is
 * never the only channel. Dot area follows share count, which is what makes a
 * 10,000-share fill read louder than a 100-share one.
 *
 * @param {{buys: any[], sells: any[], costAvg: number|null, price: number|null,
 *          currency: 'TWD'|'USD'}} spec
 */
export function pricePoints({ buys, sells, costAvg, price, currency }) {
  const t = tokens();
  const all = [...buys, ...sells];
  const maxQty = Math.max(1, ...all.map((o) => o.qty));

  /** @type {any[]} */
  const lines = [];
  if (Number.isFinite(costAvg)) {
    lines.push({
      yAxis: costAvg,
      lineStyle: { type: "dashed", width: 1.5, color: t.axis },
      label: {
        formatter: `成本均價 ${money(costAvg, currency)}`,
        position: "insideStartTop", color: t.ink2, fontSize: 11,
      },
    });
  }
  if (Number.isFinite(price) && (price ?? 0) > 0) {
    lines.push({
      yAxis: price,
      lineStyle: { type: "solid", width: 1.5, color: t.ink2 },
      label: {
        formatter: `目前 ${money(price, currency)}`,
        position: "insideEndTop", color: t.ink, fontSize: 11, fontWeight: 600,
      },
    });
  }

  // Data and reference lines together define the range.
  const marks = [costAvg, price].filter((v) => Number.isFinite(v) && (v ?? 0) > 0);
  const scale = [...all.map((o) => o.price), ...marks];
  const refLo = Math.min(...scale);
  const refHi = Math.max(...scale);
  const refPad = (refHi - refLo) * 0.08 || refHi * 0.05 || 1;
  const refStep = Math.pow(10, Math.floor(Math.log10(refHi - refLo || refHi || 1)) - 1);
  const axisLo = Math.max(0, Math.floor((refLo - refPad) / refStep) * refStep);
  const axisHi = Math.ceil((refHi + refPad) / refStep) * refStep;

  const mk = (rows, color, name) => ({
    type: "scatter",
    name,
    data: rows.map((o) => ({ value: [o.date, o.price, o.qty], order: o })),
    symbolSize: (d) => 9 + 17 * Math.sqrt((d?.[2] ?? 0) / maxQty),
    // A 2px surface ring keeps overlapping fills legible.
    itemStyle: { color, opacity: 0.85, borderColor: t.surface, borderWidth: 2 },
    emphasis: { itemStyle: { opacity: 1 } },
    ...(name === "買進" && lines.length ? { markLine: { symbol: "none", data: lines } } : {}),
  });

  return {
    ...base(t),
    tooltip: {
      ...base(t).tooltip,
      trigger: "item",
      formatter: (p) => {
        const o = p.data.order;
        return `<div style="color:${t.muted};font-size:11.5px">${o.date}　`
          + `${o.side === "buy" ? "買進" : "賣出"}</div>`
          + `<div style="font-weight:650;font-size:14px">${money(o.price, o.currency)}</div>`
          + `<div style="color:${t.ink2};font-size:11.5px">`
          + `${shares(o.qty)} 股　${money(o.amount, o.currency)}</div>`;
      },
    },
    legend: legend(t),
    grid: { left: 8, right: 24, top: 34, bottom: 8, containLabel: true },
    xAxis: {
      // A time axis, not a category one: the gaps between orders are part of
      // the story, and a category axis would space them evenly.
      type: "time",
      axisLine: axisLine(t),
      axisTick: { show: false },
      axisLabel: { color: t.muted, fontSize: 11 },
      splitLine: { show: false },
    },
    yAxis: {
      ...valueAxis(t, { fmt: (v) => (currency === "USD" ? v.toFixed(2) : String(v)) }),
      // The reference lines have to be inside the axis or they are silently
      // clipped - and the one that matters most is the current price, which is
      // exactly the value most likely to sit outside the range of past fills.
      min: axisLo,
      max: axisHi,
      scale: true,
    },
    series: [mk(buys, t.up, "買進"), mk(sells, t.down, "賣出")],
  };
}

/**
 * A candlestick review chart: price, volume, moving averages, and every order
 * marked at the price it actually filled at.
 *
 * ## Why two panels rather than two y-axes
 *
 * Price and volume are different scales, and a second y-axis on one plot would
 * invent a relationship between them. So they are two stacked grids sharing
 * one x-axis - small multiples, which is the sanctioned answer.
 *
 * ## Where the markers sit
 *
 * At the fill price, inside the day's candle - not floated above or below the
 * bar. That placement answers the question the chart exists for: not "did I
 * trade that day" but "where in that day's range did I get filled". Buys are
 * red triangles pointing up, sells green triangles pointing down: the shape is
 * the channel that survives colour blindness, and the legend names both.
 *
 * Volume is a single neutral hue on purpose. Direction is already carried by
 * the candle bodies, and colouring volume red/green too would spend the
 * red/green pairing a third time on this one chart.
 *
 * @param {{
 *   rows: [string, number, number, number, number, number][],
 *   buys: any[], sells: any[],
 *   ma: {n: number, values: (number|null)[]}[],
 *   avgCost: number|null, currency: 'TWD'|'USD',
 *   marks?: {date: string, label: string}[],
 * }} spec
 */
export function candles({ rows, buys, sells, ma, avgCost, currency, marks = [] }) {
  const t = tokens();
  const days = rows.map((r) => r[0]);
  // ECharts wants [open, close, low, high] - not OHLC order.
  const ohlc = rows.map((r) => [r[1], r[4], r[3], r[2]]);
  const volume = rows.map((r) => r[5]);
  const price = (v) => money(v, currency);
  const maxQty = Math.max(1, ...[...buys, ...sells].map((o) => o.qty));

  /** @type {Map<string, any[]>} */
  const byDate = new Map();
  for (const o of [...buys, ...sells]) {
    if (!byDate.has(o.date)) byDate.set(o.date, []);
    /** @type {any[]} */ (byDate.get(o.date)).push(o);
  }

  /** @type {any[]} */
  const costLine = [];
  if (Number.isFinite(avgCost) && (avgCost ?? 0) > 0) {
    costLine.push({
      yAxis: avgCost,
      lineStyle: { type: "dashed", width: 1.5, color: t.ink2 },
      label: {
        formatter: `成本均價 ${price(avgCost)}`,
        position: "insideStartTop", color: t.ink2, fontSize: 11,
      },
    });
  }
  // A vertical rule wherever the share count was restated, so the step in the
  // series does not read as a crash. The caller supplies the wording: for
  // Taiwan it has the official ratio and says "1 拆 22"; for US symbols no such
  // dataset exists and it can only say "價格不連續", because the observed jump
  // is the split factor and that day's own price move multiplied together and
  // the two cannot be separated (00631L's 443.15 -> 19.26 is -4.4% off a 1:22
  // reference and -0.04% off a 1:23 one - both legal daily moves; the quotient
  // says 23, the actual split was 22).
  const breakLines = marks.map((b) => ({
    xAxis: b.date,
    lineStyle: { type: "dotted", width: 1.5, color: t.series[6] },
    label: {
      formatter: b.label,
      color: t.series[6], fontSize: 10, position: "insideEndBottom", rotate: 90,
    },
  }));

  const marker = (rows_, color, name, rotate) => ({
    type: "scatter",
    name,
    xAxisIndex: 0, yAxisIndex: 0,
    // plotPrice is the fill converted into the price series' own units, which
    // differs from the recorded price whenever the series is split-adjusted
    // (every US symbol). The tooltip still reports what was actually paid.
    data: rows_.map((o) => ({ value: [o.date, o.plotPrice ?? o.price, o.qty], order: o })),
    symbol: "triangle",
    symbolRotate: rotate,
    symbolSize: (d) => 14 + 16 * Math.sqrt(((d && d[2]) || 0) / maxQty),
    // A surface ring keeps a marker legible where it lands on top of a candle
    // of its own colour.
    itemStyle: { color, borderColor: t.surface, borderWidth: 2 },
    emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 2 } },
    z: 12,
    ...(name === "買進" && (costLine.length || breakLines.length)
      ? { markLine: { symbol: "none", silent: true, data: [...costLine, ...breakLines] } }
      : {}),
  });

  // Open on the most recent stretch: a two-year series compressed into one
  // card is a smear, and the zoom slider carries the rest.
  const zoomStart = rows.length > 160 ? 100 - (160 / rows.length) * 100 : 0;

  return {
    ...base(t),
    animation: false,
    legend: {
      ...legend(t),
      top: 0, right: 0,
      data: ["K線", ...ma.map((m) => `MA${m.n}`), "買進", "賣出"],
    },
    axisPointer: { link: [{ xAxisIndex: "all" }], label: { show: false } },
    tooltip: {
      ...base(t).tooltip,
      trigger: "axis",
      axisPointer: { type: "cross", crossStyle: { color: t.axis }, label: { show: false } },
      formatter: (ps) => {
        const day = ps[0]?.axisValue;
        const i = days.indexOf(day);
        if (i < 0) return "";
        const [, o, h, l, c, v] = rows[i];
        const prev = i > 0 ? rows[i - 1][4] : null;
        const chg = prev ? (c - prev) / prev : null;
        const row = (k, val) =>
          `<div style="display:flex;gap:14px;justify-content:space-between">`
          + `<span style="color:${t.ink2}">${k}</span><b>${val}</b></div>`;
        let out = `<div style="color:${t.muted};font-size:11.5px">${day}</div>`
          + `<div style="font-weight:650;font-size:14px">${price(c)}`
          + (chg === null ? "" : `<span style="font-size:12px;color:${chg >= 0 ? t.up : t.down}">`
            + `　${signedPct(chg)}</span>`)
          + `</div>`
          + row("開", price(o)) + row("高", price(h)) + row("低", price(l))
          + row("量", int(v));
        for (const order of byDate.get(day) || []) {
          out += `<div style="border-top:1px solid ${t.grid};margin-top:4px;padding-top:4px;`
            + `display:flex;gap:14px;justify-content:space-between">`
            + `<span style="color:${order.side === "buy" ? t.up : t.down}">`
            + `${order.side === "buy" ? "買進" : "賣出"} ${shares(order.qty)} 股</span>`
            + `<b>${price(order.price)}</b></div>`
            + (order.factor && order.factor !== 1
              ? `<div style="color:${t.muted};font-size:11px">`
                + `（此檔行情為還原價，圖上位置已換算 ÷${order.factor}）</div>`
              : "");
        }
        return out;
      },
    },
    // Two grids, one shared x. The price panel gets the room; volume is
    // context, so it gets a strip.
    grid: [
      { left: 8, right: 16, top: 30, height: "62%", containLabel: true },
      { left: 8, right: 16, bottom: 58, height: "14%", containLabel: true },
    ],
    xAxis: [
      {
        type: "category", data: days, gridIndex: 0,
        axisLine: axisLine(t), axisTick: { show: false },
        axisLabel: { color: t.muted, fontSize: 11 },
        splitLine: { show: false },
        axisPointer: { label: { show: false } },
      },
      {
        type: "category", data: days, gridIndex: 1,
        axisLine: axisLine(t), axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: { show: false },
      },
    ],
    yAxis: [
      {
        // A price axis never starts at zero: the spread between fills is the
        // whole subject, and candles claim a range, not a length from a base.
        ...valueAxis(t, { fmt: (v) => (currency === "USD" ? v.toFixed(2) : String(v)) }),
        gridIndex: 0, scale: true,
      },
      {
        ...valueAxis(t, { fmt: (v) => compact(v) }),
        gridIndex: 1, splitNumber: 2,
        name: "成交量", nameLocation: "end", nameGap: 8,
        nameTextStyle: { color: t.muted, fontSize: 10, align: "left" },
      },
    ],
    dataZoom: [
      { type: "inside", xAxisIndex: [0, 1], start: zoomStart, end: 100 },
      {
        type: "slider", xAxisIndex: [0, 1], start: zoomStart, end: 100,
        bottom: 8, height: 22,
        borderColor: t.grid, fillerColor: "rgba(42,120,214,.10)",
        handleStyle: { color: t.surface, borderColor: t.axis },
        dataBackground: {
          lineStyle: { color: t.axis }, areaStyle: { color: t.grid },
        },
        textStyle: { color: t.muted, fontSize: 10 },
      },
    ],
    series: [
      {
        type: "candlestick", name: "K線", data: ohlc,
        xAxisIndex: 0, yAxisIndex: 0,
        itemStyle: {
          // 紅漲綠跌: ECharts calls the rising body `color`, the falling one
          // `color0`. Direction is also readable from the body's position
          // against its neighbours, and the tooltip prints a signed change.
          color: t.up, color0: t.down,
          borderColor: t.up, borderColor0: t.down, borderWidth: 1,
        },
        barMaxWidth: 12,
      },
      ...ma.map((m, i) => ({
        type: "line", name: `MA${m.n}`, data: m.values,
        xAxisIndex: 0, yAxisIndex: 0,
        smooth: false, showSymbol: false,
        // Thin, so they read as context under the candles rather than as data
        // of their own.
        lineStyle: { width: 1.25, color: slot([0, 1, 6][i] ?? i) },
        itemStyle: { color: slot([0, 1, 6][i] ?? i) },
        z: 4,
      })),
      marker(buys, t.up, "買進", 0),
      marker(sells, t.down, "賣出", 180),
      {
        type: "bar", name: "成交量", data: volume,
        xAxisIndex: 1, yAxisIndex: 1,
        itemStyle: { color: t.seq[1] },
        barMaxWidth: 12,
      },
    ],
  };
}

/**
 * A sparkline for a stat tile: no axes, no labels, no tooltip - the number
 * beside it is the value, and this only carries the shape.
 *
 * @param {{values: number[], color?: string}} spec
 */
export function sparkline({ values, color }) {
  const t = tokens();
  const hue = color || slot(0);
  return {
    animation: false,
    grid: { left: 1, right: 1, top: 3, bottom: 1 },
    xAxis: { type: "category", show: false, data: values.map((_, i) => i), boundaryGap: false },
    yAxis: { type: "value", show: false, min: "dataMin", max: "dataMax" },
    series: [{
      type: "line", data: values, showSymbol: false, smooth: false,
      lineStyle: { width: 1.5, color: hue },
      areaStyle: { color: hue, opacity: 0.12 },
      silent: true,
    }],
    textStyle: { fontFamily: FONT, color: t.muted },
  };
}

export { int, shares, money, signedMoney, pct, signedPct };
