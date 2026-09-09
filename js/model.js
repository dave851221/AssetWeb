// Everything the views need that is not literally in the workbook.
//
// The parsers keep each broker sheet in its own currency, because that is how
// the sheet stores it. This is where conversion happens, using the numeric rate
// from history's last row - `summary` also converts, but it buries the rate in
// a label string (`IBKR (×31.54)`), so it is not a usable source.
//
// ## What cannot be computed from this data, and why
//
// A dashboard like this wants to split asset growth into "money I put in" and
// "money the market made me". **That is not possible here, and attempting it
// would produce a confident wrong number.**
//
// The trades sheet records cash movements *inside* a brokerage account: buying
// NT$100k of stock moves NT$100k from the settlement balance into holdings, and
// total assets do not change. So the trades' net cash flow is not external
// contribution. Actual deposits and withdrawals are recorded nowhere in the
// workbook, and the daily total in `history` is
//
//     Δtotal = market moves + dividends received + external transfers
//
// with no way to separate the third term. The same gap rules out a
// money-weighted return (IRR/XIRR), which needs exactly those external flows.
//
// What *is* sound is the return the broker sheets state directly:
//
//     總報酬 = 未實現損益 + 已實現損益 + 除權息收入
//
// so that is the headline number, and the asset curve is presented as what it
// is - a balance history that includes deposits - rather than as performance.

import { BROKERS } from "./config.js";

/** @typedef {import('./types.js').Model} Model */
/** @typedef {import('./types.js').Holding} Holding */
/** @typedef {import('./types.js').Currency} Currency */
/** @typedef {import('./types.js').Broker} Broker */

/** Brokers in a fixed order, so a colour never moves between charts. */
const BROKER_ORDER = /** @type {Broker[]} */ (["fubon", "sinopac", "ibkr", "manual"]);

export const brokerLabel = (b) => BROKERS[b]?.label ?? b;

/**
 * Convert to TWD at the workbook's latest spot rate.
 *
 * @param {number|null|undefined} v
 * @param {Currency} currency
 * @param {number} rate
 */
export const twd = (v, currency, rate) =>
  v === null || v === undefined ? null : currency === "USD" ? v * rate : v;

const sumOf = (rows, f) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);

/**
 * @typedef {Holding & {
 *   valueTwd: number, pnlTwd: number, costTwd: number, weight: number,
 *   market: 'TW'|'US'
 * }} HoldingTwd
 */

/**
 * @typedef {object} Derived
 * @property {number} rate
 * @property {HoldingTwd[]} holdings         one row per (broker, symbol)
 * @property {any[]} bySymbol                merged across brokers, value descending
 * @property {{broker: Broker, label: string, cash: number, stock: number, total: number, pending: number|null, updatedAt: string|null}[]} brokers
 * @property {{key: string, label: string, value: number}[]} allocation
 * @property {object} totals
 * @property {{year: number, realized: number, dividends: number, total: number,
 *            fee: number, tax: number, turnover: number, trades: number}[]} byYear
 * @property {{symbol: string, name: string, cash: number, cost: number, yieldPct: number|null}[]} dividendBySymbol
 * @property {import('./types.js').HistoryRow[]} history
 */

/**
 * @param {Model} m
 * @returns {Derived}
 */
export function derive(m) {
  // No rate means no USD conversion is possible. 1 would silently understate
  // the IBKR account by ~97%, so the views check `rate` and say so instead.
  const rate = m.meta.usdTwdRate ?? 0;

  // ------------------------------------------------------------ holdings ---
  const withTwd = m.holdings.map((h) => {
    const valueTwd = twd(h.marketValue, h.currency, rate) ?? 0;
    const pnlTwd = twd(h.unrealizedPnl, h.currency, rate) ?? 0;
    return {
      ...h,
      valueTwd,
      pnlTwd,
      // Cost is back-derived, exactly as the broker sheets do it: they store
      // market value and P&L, never the cost basis.
      costTwd: valueTwd - pnlTwd,
      weight: 0,
      market: /** @type {'TW'|'US'} */ (h.currency === "USD" ? "US" : "TW"),
    };
  });
  const stockTotal = sumOf(withTwd, (h) => h.valueTwd);
  for (const h of withTwd) h.weight = stockTotal ? h.valueTwd / stockTotal : 0;
  withTwd.sort((a, b) => b.valueTwd - a.valueTwd);

  // --------------------------------------------------- merged by symbol ---
  // The same stock can be held at more than one broker (0050 sits at both
  // 富邦 and 永豐), which is two rows above. For a ranking that is one
  // position, so it is merged here - otherwise a top-10 list shows the same
  // holding twice and understates its real weight.
  /** @type {Map<string, any>} */
  const symbolMap = new Map();
  for (const h of withTwd) {
    const cur = symbolMap.get(h.symbol) ?? {
      symbol: h.symbol, name: h.name, market: h.market, currency: h.currency,
      qty: 0, valueTwd: 0, pnlTwd: 0, costTwd: 0, weight: 0,
      brokers: /** @type {Broker[]} */ ([]), delisted: true,
    };
    cur.qty += h.qty;
    cur.valueTwd += h.valueTwd;
    cur.pnlTwd += h.pnlTwd;
    cur.costTwd += h.costTwd;
    cur.brokers.push(h.broker);
    if (h.name && !cur.name) cur.name = h.name;
    // Only fully delisted when every account's copy of it is.
    cur.delisted = cur.delisted && h.delisted;
    symbolMap.set(h.symbol, cur);
  }
  const bySymbol = [...symbolMap.values()].map((r) => ({
    ...r,
    weight: stockTotal ? r.valueTwd / stockTotal : 0,
    // Recomputed from the merged cost, not averaged from the parts: a mean of
    // two brokers' return percentages would ignore how much sits at each.
    roi: r.costTwd > 0 ? r.pnlTwd / r.costTwd : null,
  })).sort((a, b) => b.valueTwd - a.valueTwd);

  // ------------------------------------------------------------- brokers ---
  const manualCash = sumOf(m.manual.filter((x) => x.type === "cash"), (x) => x.amount);
  const manualStock = sumOf(m.manual.filter((x) => x.type === "stock"), (x) => x.amount);

  const brokers = BROKER_ORDER.map((broker) => {
    if (broker === "manual") {
      return {
        broker, label: brokerLabel(broker),
        cash: manualCash, stock: manualStock,
        total: manualCash + manualStock,
        pending: null, updatedAt: null,
      };
    }
    const bal = m.balances.find((b) => b.broker === broker);
    // Cash as the account holds it: settled balance plus the T+2 net that has
    // not settled yet. This is what `history` calls 富邦現金, and it is why
    // that column never matches the broker sheet's 交割戶餘額 on its own.
    const cash = bal
      ? (twd(bal.balance, bal.currency, rate) ?? 0) + (twd(bal.pending, bal.currency, rate) ?? 0)
      : 0;
    const stock = sumOf(withTwd.filter((h) => h.broker === broker), (h) => h.valueTwd);
    return {
      broker, label: brokerLabel(broker), cash, stock, total: cash + stock,
      pending: bal ? twd(bal.pending, bal.currency, rate) : null,
      updatedAt: bal?.updatedAt ?? null,
    };
  }).filter((b) => b.total !== 0);

  const cashTotal = sumOf(brokers, (b) => b.cash);

  // ---------------------------------------------------------- allocation ---
  // Deliberately not `summary`'s three buckets. There, 台股持股 silently
  // includes the manual items - which today hold US sub-brokerage positions -
  // so its TW/US split is wrong by construction. Keeping 手動 as its own class
  // is honest and still adds to the same total.
  const allocation = [
    { key: "cash", label: "現金/待交割", value: cashTotal },
    { key: "tw", label: "台股持股", value: sumOf(withTwd.filter((h) => h.market === "TW"), (h) => h.valueTwd) },
    { key: "us", label: "美股持股", value: sumOf(withTwd.filter((h) => h.market === "US"), (h) => h.valueTwd) },
    { key: "manual", label: "手動持股", value: manualStock },
  ].filter((a) => a.value > 0);

  // -------------------------------------------------------------- totals ---
  const unrealized = sumOf(withTwd, (h) => h.pnlTwd);
  const realizedAll = sumOf(m.realized, (r) => twd(r.pnl, r.currency, rate));
  const dividendsAll = sumOf(m.dividends, (d) => twd(d.cash, d.currency, rate));
  const total = cashTotal + stockTotal + manualStock;

  const thisYear = new Date().getFullYear();
  const realizedYtd = sumOf(
    m.realized.filter((r) => r.year === thisYear), (r) => twd(r.pnl, r.currency, rate));
  const dividendsYtd = sumOf(
    m.dividends.filter((d) => d.year === thisYear), (d) => twd(d.cash, d.currency, rate));

  const totals = {
    cash: cashTotal,
    stock: stockTotal + manualStock,
    total,
    cashPct: total ? cashTotal / total : 0,
    stockPct: total ? (stockTotal + manualStock) / total : 0,
    unrealized,
    unrealizedCost: sumOf(withTwd, (h) => h.costTwd),
    realizedAll,
    dividendsAll,
    realizedYtd,
    dividendsYtd,
    // The one honest performance figure available here: what the broker sheets
    // say has been made, realized and not. See this file's header for why a
    // time- or money-weighted return is not on the table.
    totalReturn: unrealized + realizedAll + dividendsAll,
    year: thisYear,
    winners: withTwd.filter((h) => h.pnlTwd > 0).length,
    losers: withTwd.filter((h) => h.pnlTwd < 0).length,
    delisted: withTwd.filter((h) => h.delisted).length,
    pending: m.realized.filter((r) => r.pending).length,
  };

  // -------------------------------------------------------------- by year ---
  const years = new Set([
    ...m.realized.map((r) => r.year),
    ...m.dividends.map((d) => d.year),
    ...m.trades.map((t) => t.year),
  ]);
  const byYear = [...years].sort((a, b) => a - b).map((year) => {
    const rs = m.realized.filter((r) => r.year === year);
    const ds = m.dividends.filter((d) => d.year === year);
    const ts = m.trades.filter((t) => t.year === year);
    const realized = sumOf(rs, (r) => twd(r.pnl, r.currency, rate));
    const dividends = sumOf(ds, (d) => twd(d.cash, d.currency, rate));
    return {
      year, realized, dividends, total: realized + dividends,
      fee: sumOf(ts, (t) => twd(t.fee, t.currency, rate)),
      tax: sumOf(ts, (t) => twd(t.tax, t.currency, rate)),
      turnover: sumOf(ts, (t) => twd(t.amount, t.currency, rate)),
      trades: ts.length,
    };
  });

  // --------------------------------------------- dividends per symbol ---
  /** @type {Map<string, {symbol: string, name: string, cash: number}>} */
  const divMap = new Map();
  for (const d of m.dividends) {
    const cur = divMap.get(d.symbol) ?? { symbol: d.symbol, name: d.name, cash: 0 };
    cur.cash += twd(d.cash, d.currency, rate) ?? 0;
    if (!cur.name && d.name) cur.name = d.name;
    divMap.set(d.symbol, cur);
  }
  const dividendBySymbol = [...divMap.values()].map((row) => {
    const held = withTwd.find((h) => h.symbol === row.symbol);
    const cost = held?.costTwd ?? 0;
    return { ...row, cost, yieldPct: cost > 0 ? row.cash / cost : null };
  }).sort((a, b) => b.cash - a.cash);

  return {
    rate,
    holdings: withTwd,
    bySymbol,
    brokers,
    allocation,
    totals,
    byYear,
    dividendBySymbol,
    history: m.history,
  };
}

// ----------------------------------------------------------------- history ---

/** Range presets, in days. `null` means everything there is. */
export const RANGES = /** @type {const} */ ([
  ["1M", "近 1 個月", 30],
  ["3M", "近 3 個月", 90],
  ["6M", "近 6 個月", 180],
  ["YTD", "今年以來", null],
  ["ALL", "全部", null],
]);

/**
 * The history rows inside a range preset.
 *
 * @param {import('./types.js').HistoryRow[]} history
 * @param {string} key
 */
export function inRange(history, key) {
  if (!history.length || key === "ALL") return history;
  if (key === "YTD") {
    const jan1 = `${new Date().getFullYear()}-01-01`;
    return history.filter((h) => h.day >= jan1);
  }
  const days = RANGES.find(([k]) => k === key)?.[2];
  if (!days) return history;
  const last = new Date(`${history[history.length - 1].day}T00:00:00`);
  last.setDate(last.getDate() - days);
  const from = last.toISOString().slice(0, 10);
  return history.filter((h) => h.day >= from);
}

/**
 * Largest peak-to-trough drop in the total, as a fraction.
 *
 * Honest caveat for the caller to surface: this total includes deposits and
 * withdrawals, so a drawdown here is not purely a market loss - a large
 * withdrawal reads exactly like one. It is still the right shape for "how far
 * below its own high has this balance been".
 *
 * @param {import('./types.js').HistoryRow[]} rows
 */
export function maxDrawdown(rows) {
  let peak = -Infinity, worst = 0, peakDay = null, troughDay = null, atPeak = null;
  for (const r of rows) {
    if (r.total > peak) { peak = r.total; atPeak = r.day; }
    const dd = peak > 0 ? (r.total - peak) / peak : 0;
    if (dd < worst) { worst = dd; peakDay = atPeak; troughDay = r.day; }
  }
  return { pct: worst, peakDay, troughDay };
}

/**
 * Change in total across a window ending at the last row.
 *
 * Anchored on the row nearest `days` ago rather than on a row index, because
 * history has a row per calendar day the sync ran - and it does not run every
 * single day.
 *
 * @param {import('./types.js').HistoryRow[]} rows
 * @param {number} days
 */
export function changeOver(rows, days) {
  if (rows.length < 2) return null;
  const last = rows[rows.length - 1];
  const cutoff = new Date(`${last.day}T00:00:00`);
  cutoff.setDate(cutoff.getDate() - days);
  const key = cutoff.toISOString().slice(0, 10);
  // The last row at or before the cutoff; if the range does not reach back
  // that far, the oldest row we have - and the caller labels it accordingly.
  let base = rows[0];
  for (const r of rows) {
    if (r.day <= key) base = r; else break;
  }
  if (base === last) return null;
  return {
    from: base.day, to: last.day,
    abs: last.total - base.total,
    pct: base.total ? (last.total - base.total) / base.total : null,
  };
}
