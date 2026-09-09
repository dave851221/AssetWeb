// Formatting, DOM helpers and the sortable table every view uses. Together
// these are a ~250-line stand-in for a component framework, which is what makes
// the no-build setup tenable.
//
// One rule runs through all of it: **null is not zero.** A blank in this data
// means "not applicable" (a broker disabled that day) or "unresolved" (a FIFO
// cost waiting on cost_override.json) - never zero. Everything renders as 「—」,
// and nothing here coerces null into a number.

export const DASH = "—";

/**
 * A type predicate, not just a boolean: it is what lets every formatter below
 * narrow `number|null` to `number` after one guard.
 *
 * @type {(v: unknown) => v is number}
 */
export const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** The message out of anything a catch block can be handed. */
export const errText = (err) => (err instanceof Error ? err.message : String(err));

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {any} [children] a node, a string, or an array of either; null and
 *   false entries are skipped so `cond && node` reads naturally at call sites
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of Array.isArray(children) ? children : [children]) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

// ------------------------------------------------------------- numbers ---

export function int(v) {
  return isNum(v) ? v.toLocaleString("zh-TW", { maximumFractionDigits: 0 }) : DASH;
}

export function num(v, digits = 2) {
  const d = asDigits(digits, 2);
  return isNum(v) ? v.toLocaleString("zh-TW", {
    minimumFractionDigits: d, maximumFractionDigits: d,
  }) : DASH;
}

/**
 * Share counts. IBKR positions are fractional (0.4741 shares of VOO) while
 * Taiwan ones are whole, so trailing zeros are trimmed rather than padded -
 * "1,000" and "0.4741" both read correctly.
 */
export function shares(v) {
  if (!isNum(v)) return DASH;
  return v.toLocaleString("zh-TW", { maximumFractionDigits: 4 });
}

/** Totals run to seven or eight figures, where 萬 reads and digits do not. */
export function big(v) {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(2) + "億";
  if (a >= 1e4) return (v / 1e4).toFixed(1) + "萬";
  return int(v);
}

const SYMBOL = { TWD: "NT$", USD: "US$" };

/**
 * Guards for the second parameter of every formatter below.
 *
 * `table()` calls a column formatter as `fmt(value, row)`, so writing
 * `fmt: money` - which looks perfectly reasonable - passes the whole row where
 * a currency or a digit count belongs. That used to render "undefined" into a
 * money cell and silently round percentages to zero decimals. Call sites wrap
 * their formatters properly; these keep a future slip from producing a wrong
 * number rather than an obvious one.
 */
const asCurrency = (c) => (c === "USD" ? "USD" : "TWD");
const asDigits = (d, fallback) => (typeof d === "number" && d >= 0 && d <= 20 ? d : fallback);

/**
 * @param {number|null|undefined} v
 * @param {'TWD'|'USD'} [currency]
 */
export function money(v, currency = "TWD") {
  if (!isNum(v)) return DASH;
  const cur = asCurrency(currency);
  const sign = v < 0 ? "-" : "";
  const body = Math.abs(v).toLocaleString("zh-TW", {
    maximumFractionDigits: cur === "USD" ? 2 : 0,
    minimumFractionDigits: cur === "USD" ? 2 : 0,
  });
  return `${sign}${SYMBOL[cur]}${body}`;
}

/**
 * A gain or loss, where the sign is the point. Zero gets no sign.
 *
 * @param {number|null|undefined} v
 * @param {'TWD'|'USD'} [currency]
 */
export function signedMoney(v, currency = "TWD") {
  if (!isNum(v)) return DASH;
  return (v > 0 ? "+" : "") + money(v, currency);
}

/**
 * A per-share price.
 *
 * Distinct from `money()` because that rounds TWD to whole dollars - correct
 * for an amount, wrong for a price. 0050's 87.57 cost basis rendered as NT$88,
 * and a NT$7.25 bond ETF as NT$7.
 *
 * @param {number|null|undefined} v
 * @param {'TWD'|'USD'} [currency]
 */
export function priceText(v, currency = "TWD") {
  if (!isNum(v)) return DASH;
  const cur = asCurrency(currency);
  const sign = v < 0 ? "-" : "";
  return `${sign}${SYMBOL[cur]}${Math.abs(v).toLocaleString("zh-TW", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
}

/** Percentages arrive as fractions - 0.2479 is +24.79%. Never divide again. */
export function pct(v, digits = 1) {
  return isNum(v) ? (v * 100).toFixed(asDigits(digits, 1)) + "%" : DASH;
}

export function signedPct(v, digits = 2) {
  if (!isNum(v)) return DASH;
  return (v > 0 ? "+" : "") + (v * 100).toFixed(asDigits(digits, 2)) + "%";
}

const pad = (n) => String(n).padStart(2, "0");

export function dateTime(iso) {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ago(iso) {
  if (!iso) return DASH;
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 90) return "剛剛";
  if (secs < 3600) return `${Math.round(secs / 60)} 分鐘前`;
  if (secs < 86400) return `${Math.round(secs / 3600)} 小時前`;
  return `${Math.round(secs / 86400)} 天前`;
}

// -------------------------------------------------------------- tables ---

/**
 * A sortable table. `columns` entries:
 *   {key, label, fmt?, align?, cls?, sortable?, title?, value?}
 * `value` extracts the sort key when it differs from what is displayed.
 * Rows keep their given order until a header is clicked.
 */
export function table(columns, rows, opts = {}) {
  const state = { key: opts.sortKey ?? null, dir: opts.sortDir ?? "desc" };
  const wrap = el("div", { class: "table-wrap" + (opts.scroll ? " scroll-y" : "") });
  const tbl = el("table", { class: "data" });
  const thead = el("thead");
  const tbody = el("tbody");
  tbl.append(thead, tbody);
  wrap.append(tbl);

  const val = (col, row) => (col.value ? col.value(row) : row[col.key]);

  function head() {
    clear(thead);
    const tr = el("tr");
    for (const col of columns) {
      const sortable = col.sortable !== false;
      const mark = state.key === col.key ? (state.dir === "asc" ? " ▲" : " ▼") : "";
      tr.append(el("th", {
        class: [col.align === "left" ? "text" : "", sortable ? "sortable" : ""].join(" ").trim(),
        title: col.title || "",
        text: col.label + mark,
        onclick: sortable ? () => {
          if (state.key === col.key) state.dir = state.dir === "asc" ? "desc" : "asc";
          else { state.key = col.key; state.dir = "desc"; }
          head(); body();
        } : null,
      }));
    }
    thead.append(tr);
  }

  function body() {
    clear(tbody);
    const data = rows.slice();
    const col = state.key ? columns.find((c) => c.key === state.key) : null;
    if (col) {
      data.sort((a, b) => {
        const x = val(col, a), y = val(col, b);
        // Missing values sort last whichever way the column is pointing: a
        // blank is "unknown", and unknowns do not belong at the top of a
        // ranking of best or worst performers.
        const xn = x === null || x === undefined, yn = y === null || y === undefined;
        if (xn && yn) return 0;
        if (xn) return 1;
        if (yn) return -1;
        const cmp = typeof x === "string" || typeof y === "string"
          ? String(x).localeCompare(String(y), "zh-Hant")
          : x - y;
        return state.dir === "asc" ? cmp : -cmp;
      });
    }
    if (!data.length) {
      tbody.append(el("tr", {}, el("td", { colspan: columns.length, class: "text" },
        el("div", { class: "empty", text: opts.empty || "沒有資料" }))));
      return;
    }
    for (const row of data) {
      const tr = el("tr");
      for (const col of columns) {
        const shown = col.fmt ? col.fmt(row[col.key], row) : row[col.key];
        const cls = [col.align === "left" ? "text" : "", col.cls ? col.cls(row) : ""]
          .join(" ").trim();
        tr.append(shown && shown.nodeType
          ? el("td", { class: cls }, shown)
          : el("td", { class: cls + (shown === DASH ? " dim" : "") },
              shown === null || shown === undefined ? DASH : String(shown)));
      }
      tbody.append(tr);
    }
  }

  head(); body();
  return wrap;
}

// --------------------------------------------------------------- chrome ---

/**
 * A card, with two extras hung off the element.
 *
 * `tools` is a slot in the header so a view can drop filters or an export
 * button beside the title. `charts` is the list of ECharts instances this card
 * owns - boot.js walks it and disposes them before the container is emptied,
 * because dropping the DOM node releases neither the canvas nor the resize
 * listener.
 *
 * @typedef {HTMLElement & {tools: HTMLElement, charts: any[]}} Card
 */

/** @returns {Card} */
export function card(title, opts = {}) {
  const node = /** @type {Card} */ (
    el("section", { class: "card" + (opts.span ? " " + opts.span : "") }));
  const head = el("div", { class: "card-head" }, el("h2", { text: title }));
  const tools = el("div", { class: "tools" });
  head.append(tools);
  node.append(head);
  if (opts.note) {
    node.append(el("p", { class: "card-note" + (opts.warn ? " warn" : ""), text: opts.note }));
  }
  node.tools = tools;
  node.charts = [];
  return node;
}

export function stat(label, value, sub, kind) {
  return el("div", { class: "stat" }, [
    el("div", { class: "label", text: label }),
    el("div", { class: "value" + (kind ? " " + kind : ""), text: value }),
    sub ? el("div", { class: "sub", text: sub }) : null,
  ]);
}

export function chip(text, kind) {
  return el("span", { class: "chip" + (kind ? " " + kind : ""), text });
}

/** Ask the shell to switch tabs. An event, so views need not import boot.js. */
export function navigate(tab, arg) {
  document.dispatchEvent(new CustomEvent("nav", { detail: { tab, arg } }));
}

// ----------------------------------------------------------------- data ---

/** @template T,K @param {T[]} rows @param {(row: T) => K} keyFn @returns {Map<K, T[]>} */
export function groupBy(rows, keyFn) {
  /** @type {Map<K, T[]>} */
  const out = new Map();
  for (const row of rows) {
    const k = keyFn(row);
    if (!out.has(k)) out.set(k, []);
    /** @type {T[]} */ (out.get(k)).push(row);
  }
  return out;
}

/** Sums the values that exist. An all-null group sums to 0, which is why
 *  callers that need to tell "no data" from "net zero" check length first. */
export const sum = (rows, f) => rows.reduce((a, r) => a + (f(r) || 0), 0);
export const mean = (rows, f) => (rows.length ? sum(rows, f) / rows.length : null);

export function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

