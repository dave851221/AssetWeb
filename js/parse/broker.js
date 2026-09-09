// The broker sheets (fubon / sinopac / ibkr).
//
// **These are multi-block documents, not tables.** Every row index shifts when
// a year is added, when a broker is disabled, when a dividend block comes back
// empty, or when a footnote appears - so nothing here may be addressed by row
// number. The only stable landmarks are the section titles in column A, so the
// parser scans for those and reads the row after each one as that block's
// header.
//
// Live layout of `fubon` on 2026-09-08, to show why: r3 balance, r7 holdings,
// r19 realized-2026, r39 dividend-2026, r56 realized-2025, r66 dividend-2025,
// r85 realized-2024, r105 dividend-2024. Add a broker or a year and every one
// of those numbers moves.
//
// Two more layout traps handled below:
//   - The 小計 label sits in a *different column per block* (E for holdings and
//     dividends, F for realized), so a subtotal row is detected by the label
//     appearing anywhere in the row, not at a fixed offset.
//   - Merged italic footnotes trail the dividend blocks. They look like data
//     rows: a long string in column A and nothing else.
//
// Everything here stays in the broker's own currency. Only `summary` and
// `history` convert, and they bury the rate in a label string - so conversion
// is done in model.js instead, from history's numeric rate column.

import { str, num, frac, ymd, stamp, isDash, isBlankRow, colOf, colOfAny } from "./cells.js";

/** @typedef {import('../types.js').Grid} Grid */
/** @typedef {import('../types.js').Broker} Broker */
/** @typedef {import('../types.js').Currency} Currency */
/** @typedef {import('../types.js').Holding} Holding */
/** @typedef {import('../types.js').Realized} Realized */
/** @typedef {import('../types.js').Dividend} Dividend */
/** @typedef {import('../types.js').Balance} Balance */

/**
 * @typedef {object} SheetTotals
 * @property {Broker} broker
 * @property {string} block        which block the 小計 closed
 * @property {number|null} year    for the per-year blocks
 * @property {string} field        which quantity it totals
 * @property {number} total        what the sheet itself says
 */

/**
 * @typedef {object} BrokerSheet
 * @property {Balance|null} balance
 * @property {Holding[]}    holdings
 * @property {Realized[]}   realized
 * @property {Dividend[]}   dividends
 * @property {SheetTotals[]} totals   the 小計 rows, for the parse to check itself
 * @property {string|null}  updatedAt
 */

const SUBTOTAL = "小計";

// 交割戶餘額 on the Taiwan sheets, 帳戶餘額 (USD) on IBKR's.
const RE_BALANCE = /^(交割戶餘額|帳戶餘額)/;
const RE_HOLDINGS = /^持股庫存/;
// Full-width parentheses and a katakana middle dot, exactly as writer.py emits
// them: 「已實現損益（2026 年・幣別 TWD）」. Kept loose around the separators so
// a spacing change upstream does not silently drop a whole year's block.
const RE_REALIZED = /^已實現損益[（(]\s*(\d{4})\s*年.*?([A-Z]{3})\s*[）)]/;
const RE_DIVIDEND = /^除權息收入[（(]\s*(\d{4})\s*年.*?([A-Z]{3})\s*[）)]/;

/** Any section title, used to stop a block that runs straight into the next. */
const isSectionTitle = (a) =>
  RE_BALANCE.test(a) || RE_HOLDINGS.test(a) || RE_REALIZED.test(a) || RE_DIVIDEND.test(a);

/** True for the yellow-filled 小計 row that closes a block. */
const isSubtotalRow = (row) => row.some((c) => str(c) === SUBTOTAL);

/**
 * The column whose header starts with `prefix`, or -1.
 *
 * Needed because the money columns carry their currency in the header:
 * 市值(TWD) on the Taiwan sheets, 市值(USD) on IBKR's. Matching the prefix
 * keeps one code path for both instead of listing every combination.
 */
function colStarting(headers, prefix) {
  const want = prefix.replace(/\s/g, "");
  return headers.findIndex((h) => str(h).replace(/\s/g, "").startsWith(want));
}

/**
 * Rows belonging to the block whose title is at `titleRow`.
 *
 * The header is the row straight after the title; data starts after that and
 * runs until a blank row, a subtotal row, or the next section title - whichever
 * comes first. Footnote rows are excluded by the blank/subtotal stop, since
 * they only ever appear after a subtotal.
 */
function blockRows(grid, titleRow) {
  const headers = (grid[titleRow + 1] || []).map(str);
  /** @type {Grid} */
  const rows = [];
  /** @type {Grid[number]|null} */
  let subtotal = null;
  for (let r = titleRow + 2; r < grid.length; r++) {
    const row = grid[r];
    if (isSubtotalRow(row)) { subtotal = row; break; }
    if (isBlankRow(row)) break;
    if (isSectionTitle(str(row[0]))) break;
    rows.push(row);
  }
  // The subtotal is returned rather than discarded: it is the sheet's own sum
  // of the very rows above it, computed by Excel and not by this parser, so
  // comparing the two is an independent check that never goes stale. selftest
  // asserts it. The values sit in the same columns as the data, so a caller
  // reads them with the same column indices it already resolved.
  return { headers, rows, subtotal };
}

/** `富邦證券  |  更新時間：2026-09-08 18:18:04` in A1. */
function readUpdatedAt(grid) {
  const title = str(grid[0]?.[0]);
  const m = /更新時間[：:]\s*(.+)$/.exec(title);
  return m ? stamp(m[1].trim()) : null;
}

/**
 * @param {Grid} grid
 * @param {Broker} broker
 * @param {number} titleRow
 * @returns {Balance|null}
 */
function readBalance(grid, broker, titleRow) {
  const { headers, rows } = blockRows(grid, titleRow);
  if (!rows.length) return null;
  const row = rows[0];
  const iCur = colOf(headers, "幣別");
  // 交割戶餘額 (TW) / 現金餘額 (IBKR); 待交割淨額 (TW) / 帳戶淨值 (IBKR).
  const iBal = colOfAny(headers, ["交割戶餘額", "現金餘額"]);
  const iPend = colOf(headers, "待交割淨額");
  const iEquity = colOf(headers, "帳戶淨值");
  const currency = /** @type {Currency} */ (
    (iCur >= 0 ? str(row[iCur]).toUpperCase() : "") === "USD" ? "USD" : "TWD"
  );
  return {
    broker,
    currency,
    balance: iBal >= 0 ? num(row[iBal]) : null,
    // A dash here means nothing is pending, which is information - but it is
    // not the number 0 for anything that averages or plots it.
    pending: iPend >= 0 ? num(row[iPend]) : null,
    equity: iEquity >= 0 ? num(row[iEquity]) : null,
    updatedAt: readUpdatedAt(grid),
  };
}

/**
 * @param {Grid} grid
 * @param {Broker} broker
 * @param {number} titleRow
 * @param {Currency} fallbackCurrency
 * @returns {{holdings: Holding[], totals: {marketValue: number|null, unrealizedPnl: number|null}|null}}
 */
function readHoldings(grid, broker, titleRow, fallbackCurrency) {
  const { headers, rows, subtotal } = blockRows(grid, titleRow);
  const iSym = colOf(headers, "股票代號");
  const iName = colOf(headers, "股票名稱");
  // IBKR's holdings block says 數量; the Taiwan sheets say 持股數量.
  const iQty = colOfAny(headers, ["持股數量", "數量"]);
  const iCost = colStarting(headers, "成本均價");
  const iPrice = colStarting(headers, "目前股價");
  const iValue = colStarting(headers, "市值");
  const iPnl = colStarting(headers, "未實現損益");
  const iRoi = colOf(headers, "報酬率");
  const currency = /** @type {Currency} */ (
    colStarting(headers, "市值(USD)") >= 0 || str(headers[iValue]).includes("USD")
      ? "USD"
      : fallbackCurrency
  );

  /** @type {Holding[]} */
  const out = [];
  const totals = subtotal
    ? {
        marketValue: iValue >= 0 ? num(subtotal[iValue]) : null,
        unrealizedPnl: iPnl >= 0 ? num(subtotal[iPnl]) : null,
      }
    : null;
  for (const row of rows) {
    const symbol = str(row[iSym]);
    if (!symbol) continue;
    const qty = num(row[iQty]);
    if (qty === null) continue;
    const name = iName >= 0 ? str(row[iName]) : "";
    const price = iPrice >= 0 ? num(row[iPrice]) : null;
    out.push({
      broker,
      symbol,
      name,
      qty,
      avgCost: iCost >= 0 ? num(row[iCost]) : null,
      price,
      marketValue: iValue >= 0 ? num(row[iValue]) : null,
      unrealizedPnl: iPnl >= 0 ? num(row[iPnl]) : null,
      roi: iRoi >= 0 ? frac(row[iRoi]) : null,
      currency,
      // A delisted holding keeps its row with a blank name and a price of 0
      // (live: 2443, cost 4.6, ROI -100%). `summary` drops these, which is why
      // its totals do not tie back to the broker sheets - so they are kept
      // here and flagged instead, and the views can say so.
      delisted: name === "" && (price === 0 || price === null),
    });
  }
  return { holdings: out, totals };
}

/**
 * @param {Grid} grid
 * @param {Broker} broker
 * @param {number} titleRow
 * @param {number} year
 * @param {Currency} currency
 * @returns {{realized: Realized[], total: number|null}}
 */
function readRealized(grid, broker, titleRow, year, currency) {
  const { headers, rows, subtotal } = blockRows(grid, titleRow);
  const iSym = colOf(headers, "股票代號");
  const iName = colOf(headers, "股票名稱");
  const iQty = colOf(headers, "賣出數量");
  const iProceeds = colStarting(headers, "賣出金額");
  const iCost = colStarting(headers, "成本金額");
  const iFeeTax = colStarting(headers, "手續費+稅");
  const iPnl = colStarting(headers, "已實現損益");
  const iRoi = colOf(headers, "報酬率");

  /** @type {Realized[]} */
  const out = [];
  const total = subtotal && iPnl >= 0 ? num(subtotal[iPnl]) : null;
  for (const row of rows) {
    const symbol = str(row[iSym]);
    if (!symbol) continue;
    const pnlCell = iPnl >= 0 ? row[iPnl] : null;
    // The P&L column holds a sentence - 「請填入 cost_override.json」 - while a
    // FIFO cost is unresolved, with the row filled amber in Excel. `num()`
    // already turns that into null; this is what tells the difference between
    // "unresolved" and "genuinely blank".
    const pending = /cost_override/i.test(str(pnlCell));
    out.push({
      broker,
      year,
      symbol,
      name: iName >= 0 ? str(row[iName]) : "",
      qty: iQty >= 0 ? num(row[iQty]) : null,
      proceeds: iProceeds >= 0 ? num(row[iProceeds]) : null,
      cost: iCost >= 0 ? num(row[iCost]) : null,
      feeTax: iFeeTax >= 0 ? num(row[iFeeTax]) : null,
      pnl: num(pnlCell),
      roi: iRoi >= 0 ? frac(row[iRoi]) : null,
      currency,
      pending,
    });
  }
  return { realized: out, total };
}

/**
 * @param {Grid} grid
 * @param {Broker} broker
 * @param {number} titleRow
 * @param {number} year
 * @param {Currency} currency
 * @returns {{dividends: Dividend[], total: number|null}}
 */
function readDividends(grid, broker, titleRow, year, currency) {
  const { headers, rows, subtotal } = blockRows(grid, titleRow);
  const iSym = colOf(headers, "股票代號");
  const iName = colOf(headers, "股票名稱");
  const iDate = colOf(headers, "除權息日");
  const iQty = colOf(headers, "持股數量");
  const iPer = colOf(headers, "每股配息");
  const iCash = colStarting(headers, "配息收入");
  const iPerK = colOf(headers, "每仟股配股");
  const iShares = colOf(headers, "配股股數");

  /** @type {Dividend[]} */
  const out = [];
  const total = subtotal && iCash >= 0 ? num(subtotal[iCash]) : null;
  for (const row of rows) {
    const symbol = str(row[iSym]);
    if (!symbol) continue;
    out.push({
      broker,
      year,
      symbol,
      name: iName >= 0 ? str(row[iName]) : "",
      exDate: iDate >= 0 ? ymd(row[iDate]) : null,
      qty: iQty >= 0 ? num(row[iQty]) : null,
      perShare: iPer >= 0 ? num(row[iPer]) : null,
      // Cash only, by design upstream: a stock dividend is reported as a share
      // count with no monetary value so that summing this column can never
      // double-count. Views must not add 配股 in as income.
      cash: iCash >= 0 ? num(row[iCash]) : null,
      perThousand: iPerK >= 0 ? num(row[iPerK]) : null,
      shares: iShares >= 0 ? num(row[iShares]) : null,
      currency,
    });
  }
  return { dividends: out, total };
}

/**
 * Parse one broker sheet by scanning column A for its section titles.
 *
 * @param {Grid} grid
 * @param {Broker} broker
 * @param {Currency} fallbackCurrency
 * @param {string[]} warnings
 * @returns {BrokerSheet}
 */
export function parseBrokerSheet(grid, broker, fallbackCurrency, warnings) {
  /** @type {BrokerSheet} */
  const out = {
    balance: null, holdings: [], realized: [], dividends: [], totals: [],
    updatedAt: readUpdatedAt(grid),
  };
  if (!grid.length) return out;

  /** @param {string} block @param {string} field @param {number|null} total @param {number|null} year */
  const addTotal = (block, field, total, year = null) => {
    if (total === null) return;
    out.totals.push({ broker, block, year, field, total });
  };

  let sawAnySection = false;
  for (let r = 0; r < grid.length; r++) {
    const a = str(grid[r][0]);
    if (!a) continue;

    if (RE_BALANCE.test(a)) {
      sawAnySection = true;
      out.balance = readBalance(grid, broker, r);
      continue;
    }
    if (RE_HOLDINGS.test(a)) {
      sawAnySection = true;
      const { holdings, totals } = readHoldings(
        grid, broker, r, fallbackCurrency);
      out.holdings.push(...holdings);
      addTotal("holdings", "marketValue", totals?.marketValue ?? null);
      addTotal("holdings", "unrealizedPnl", totals?.unrealizedPnl ?? null);
      continue;
    }
    let m = RE_REALIZED.exec(a);
    if (m) {
      sawAnySection = true;
      const year = Number(m[1]);
      const { realized, total } = readRealized(
        grid, broker, r, year, /** @type {Currency} */ (m[2]));
      out.realized.push(...realized);
      addTotal("realized", "pnl", total, year);
      continue;
    }
    m = RE_DIVIDEND.exec(a);
    if (m) {
      sawAnySection = true;
      const year = Number(m[1]);
      const { dividends, total } = readDividends(
        grid, broker, r, year, /** @type {Currency} */ (m[2]));
      out.dividends.push(...dividends);
      addTotal("dividends", "cash", total, year);
    }
  }

  if (!sawAnySection) {
    warnings.push(`${broker} 分頁找不到任何區塊標題，可能格式已變更`);
  }
  return out;
}

