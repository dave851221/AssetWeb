// The `trades_<year>` sheets - the cleanest tables in the workbook, and the
// only place every individual order is recorded.
//
// Header on row 1, data from row 2, no total row, no merges, all literal
// values. 13 columns, defined once in AssetSync's writer.py as TRADE_HEADERS.

import { str, num, num0, ymd, colOf } from "./cells.js";

/** @typedef {import('../types.js').Trade} Trade */
/** @typedef {import('../types.js').Grid} Grid */
/** @typedef {import('../types.js').Broker} Broker */
/** @typedef {import('../types.js').Currency} Currency */

const COLS = {
  date: "日期",
  broker: "券商",
  symbol: "股票代號",
  name: "股票名稱",
  side: "買賣",
  qty: "數量",
  price: "成交均價",
  amount: "成交金額",
  fee: "手續費",
  tax: "交易稅",
  net: "實際收付",
  orderNo: "委託號碼",
  currency: "幣別",
};

const KNOWN_BROKERS = new Set(["fubon", "sinopac", "ibkr"]);

/**
 * A ticker as the sheet means it.
 *
 * Taiwan codes are text in the workbook so `0050` keeps its leading zero, but
 * a hand-edited cell can lose that formatting and arrive as the number 50. Any
 * numeric TW code is padded back to four digits; US tickers are alphabetic and
 * never take this path.
 */
function symbolOf(cell, currency) {
  if (typeof cell === "number" && currency === "TWD") {
    return String(cell).padStart(4, "0");
  }
  return str(cell).toUpperCase();
}

/**
 * Parse one `trades_<year>` sheet.
 *
 * @param {Grid} grid
 * @param {string} sheetName
 * @param {string[]} warnings
 * @returns {Trade[]}
 */
function parseTradesSheet(grid, sheetName, warnings) {
  if (!grid.length) return [];
  const head = grid[0].map(str);
  /** @type {Record<string, number>} */
  const at = {};
  for (const [key, label] of Object.entries(COLS)) {
    at[key] = colOf(head, label);
  }
  // Only these five make a row meaningful. The rest can be missing (an older
  // workbook, a column renamed) without the sheet becoming unreadable.
  for (const key of ["date", "broker", "symbol", "side", "qty"]) {
    if (at[key] < 0) {
      warnings.push(`${sheetName}：找不到「${COLS[key]}」欄，整張跳過`);
      return [];
    }
  }

  /** @type {Trade[]} */
  const out = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const date = ymd(row[at.date]);
    if (!date) continue;                 // blank row, or a stray note

    const sideRaw = str(row[at.side]);
    const qty = num(row[at.qty]);
    if (qty === null) continue;

    const currency = /** @type {Currency} */ (
      str(row[at.currency]).toUpperCase() === "USD" ? "USD" : "TWD"
    );
    const brokerRaw = str(row[at.broker]).toLowerCase();
    if (!KNOWN_BROKERS.has(brokerRaw)) {
      warnings.push(`${sheetName} 第 ${r + 1} 列：不認識的券商「${brokerRaw}」`);
      continue;
    }

    out.push({
      date,
      year: Number(date.slice(0, 4)),
      broker: /** @type {Broker} */ (brokerRaw),
      symbol: symbolOf(row[at.symbol], currency),
      name: at.name >= 0 ? str(row[at.name]) : "",
      // 買 / 賣 are the only two values AssetSync writes. Anything else is
      // treated as a sell rather than guessed at, and flagged - a buy silently
      // recorded as a sell would corrupt every cost basis downstream.
      side: sideRaw === "買" ? "buy" : "sell",
      qty,
      price: num0(row[at.price]),
      amount: num0(row[at.amount]),
      fee: num0(row[at.fee]),
      tax: num0(row[at.tax]),
      net: num0(row[at.net]),
      orderNo: at.orderNo >= 0 ? str(row[at.orderNo]) : "",
      currency,
      market: currency === "USD" ? "US" : "TW",
    });

    if (sideRaw !== "買" && sideRaw !== "賣") {
      warnings.push(`${sheetName} 第 ${r + 1} 列：買賣欄是「${sideRaw}」，已當作賣出`);
    }
  }
  return out;
}

/**
 * Every trade in the workbook, oldest first.
 *
 * Sheets are found by prefix, never by a hard-coded year list: AssetSync
 * creates `trades_<year>` on demand, so trades_2027 appears by itself in
 * January.
 *
 * Deduplication is on `(broker, date, orderNo)` and not on the order number
 * alone. Fubon's five-character 委託書號 is **reissued every trading day**, so
 * `oQ954` on two different dates is two different orders - keying on the order
 * number alone would quietly delete real trades. Sinopac and IBKR ids are
 * globally unique, so they are unaffected either way.
 *
 * @param {Map<string, Grid>} sheets
 * @param {string} prefix
 * @param {string[]} warnings
 * @returns {Trade[]}
 */
export function parseTrades(sheets, prefix, warnings) {
  const names = [...sheets.keys()].filter((n) => n.startsWith(prefix)).sort();
  /** @type {Trade[]} */
  const all = [];
  for (const name of names) {
    all.push(...parseTradesSheet(/** @type {Grid} */ (sheets.get(name)), name, warnings));
  }

  const seen = new Set();
  /** @type {Trade[]} */
  const out = [];
  for (const t of all) {
    // An empty order number cannot identify anything, so those rows are kept
    // as-is rather than collapsing into one.
    const key = t.orderNo ? `${t.broker}|${t.date}|${t.orderNo}` : null;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(t);
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}
