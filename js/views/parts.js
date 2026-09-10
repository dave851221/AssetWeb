// Shared view pieces: the figures, the filter row, and the table cells that
// carry a bar.
//
// These are the "is it even a chart?" answers. A single current value with a
// trend is a stat tile, not a one-bar bar chart; the number a view leads with
// is a hero figure, and there is exactly one per view.

import { el, card, money, signedMoney, pct, signedPct, isNum, DASH } from "../util.js";
import { mount, sparkline, compact } from "../charts.js";
import { RANGES } from "../model.js";

/**
 * The one number a view leads with. >=48px, in the same sans as everything
 * else, with its delta and an optional sparkline beside it.
 *
 * Proportional figures, not tabular: at display sizes `tabular-nums` gives
 * every digit the width of a zero and the number reads loose.
 *
 * @param {{label: string, value: string, delta?: {abs: number, pct: number|null, since: string}|null,
 *          sub?: string, spark?: number[], host?: import('../util.js').Card}} spec
 */
export function hero({ label, value, delta, sub, spark, host }) {
  const kids = [
    el("div", { class: "hero-label", text: label }),
    el("div", { class: "hero-value", text: value }),
  ];
  if (delta) {
    kids.push(el("div", { class: "hero-delta" }, [
      el("span", {
        class: "delta " + (delta.abs >= 0 ? "up" : "down"),
        // The arrow is the secondary channel: the direction never rests on
        // colour alone.
        text: `${delta.abs >= 0 ? "▲" : "▼"} ${signedMoney(delta.abs)}`
          + (isNum(delta.pct) ? `　${signedPct(delta.pct)}` : ""),
      }),
      el("span", { class: "delta-since", text: delta.since }),
    ]));
  }
  if (sub) kids.push(el("div", { class: "hero-sub", text: sub }));

  const left = el("div", { class: "hero-text" }, kids);
  const node = el("div", { class: "hero" }, left);
  if (spark && spark.length > 1 && host) {
    node.append(el("div", { class: "hero-spark" },
      mount(host, sparkline({ values: spark }), { class: "spark" })));
  }
  return node;
}

/**
 * A stat tile: label, value, optional delta and sub-line.
 *
 * @param {{label: string, value: string, delta?: number|null, deltaText?: string,
 *          sub?: string, tone?: ''|'up'|'down'}} spec
 */
export function tile({ label, value, delta, deltaText, sub, tone = "" }) {
  return el("div", { class: "tile" }, [
    el("div", { class: "tile-label", text: label }),
    el("div", { class: "tile-value " + tone, text: value }),
    isNum(delta) || deltaText
      ? el("div", { class: "tile-delta " + (isNum(delta) ? (delta >= 0 ? "up" : "down") : "") },
          deltaText ?? signedMoney(/** @type {number} */ (delta)))
      : null,
    sub ? el("div", { class: "tile-sub", text: sub }) : null,
  ]);
}

export const tileRow = (tiles) => el("div", { class: "tile-row" }, tiles);

/**
 * Rewrite a tile after the fact.
 *
 * For the figures that only become knowable once an async check lands - a
 * per-share average is only meaningful if no stock split falls inside the
 * window, and that is decided by the price series, which arrives later.
 *
 * @param {HTMLElement} node a node returned by tile()
 * @param {{value?: string, sub?: string, tone?: string}} patch
 */
export function retile(node, { value, sub, tone }) {
  const v = node.querySelector(".tile-value");
  const s = node.querySelector(".tile-sub");
  if (v && value !== undefined) {
    v.textContent = value;
    v.className = "tile-value " + (tone ?? "");
  }
  if (sub !== undefined) {
    if (s) s.textContent = sub;
    else node.append(el("div", { class: "tile-sub", text: sub }));
  }
}

/**
 * The range filter: one row, above the content it scopes.
 *
 * Presets as a segmented control rather than a calendar - nobody fights a date
 * grid for "last 30 days". Selection is marked by fill *and* `aria-pressed`,
 * so it is not colour-alone.
 *
 * @param {string} current
 * @param {(key: string) => void} onChange
 */
export function rangeRow(current, onChange) {
  return el("div", { class: "filter-row" }, [
    el("div", { class: "segmented", role: "group", "aria-label": "期間" },
      RANGES.map(([key, label]) => el("button", {
        class: "seg" + (key === current ? " on" : ""),
        "aria-pressed": String(key === current),
        text: label,
        onclick: () => onChange(key),
      }))),
  ]);
}

/**
 * A table cell that is part number, part bar.
 *
 * The bar is a share of the row's own maximum, so a column of them reads as a
 * ranking without needing a separate chart. One hue, because the number beside
 * it already carries magnitude - this is reinforcement, not a value ramp.
 *
 * @param {number|null} v
 * @param {number} max
 * @param {(v: number|null) => string} fmt
 */
export function barCell(v, max, fmt = (x) => money(x)) {
  if (!isNum(v)) return el("span", { class: "dim", text: DASH });
  const w = max > 0 ? Math.max(1, Math.round((Math.abs(v) / max) * 100)) : 0;
  return el("div", { class: "bar-cell" }, [
    el("span", { class: "bar-num", text: fmt(v) }),
    el("span", { class: "bar-track" },
      el("span", { class: "bar-fill" + (v < 0 ? " down" : ""), style: `width:${w}%` })),
  ]);
}

/**
 * A share cell: a percentage and a proportional track.
 *
 * @param {number|null} v fraction
 */
export function shareCell(v) {
  if (!isNum(v)) return el("span", { class: "dim", text: DASH });
  return el("div", { class: "bar-cell" }, [
    el("span", { class: "bar-num", text: pct(v, 1) }),
    el("span", { class: "bar-track" },
      el("span", { class: "bar-fill", style: `width:${Math.round(v * 100)}%` })),
  ]);
}

/**
 * A card whose body is one chart.
 *
 * `scroll` wraps the canvas in a box that scrolls sideways on a phone. A chart
 * squeezed into a 340px viewport is not a smaller chart - ECharts starts hiding
 * category labels and the marks collapse into each other - so anything with
 * more than a handful of categories asks for it. The wrapper does nothing at
 * desktop widths; the floor width only applies under the phone breakpoint, and
 * it is the same rule the tables already follow.
 *
 * @param {string} title
 * @param {any} option ECharts option, from a builder in charts.js
 * @param {{span?: string, note?: string, warn?: boolean, chartClass?: string,
 *          legend?: HTMLElement, height?: number, scroll?: boolean}} [opts]
 */
export function chartCard(
  title, option, { span, note, warn, chartClass, legend, height, scroll } = {},
) {
  const node = card(title, { span, note, warn });
  if (legend) node.append(legend);
  const host = mount(node, option, { class: chartClass || "chart", height });
  node.append(scroll ? el("div", { class: "chart-scroll" }, host) : host);
  return node;
}

/** Small print under a chart - the caveats that keep a number honest. */
export const footnote = (text) => el("p", { class: "footnote", text });

export { compact };
