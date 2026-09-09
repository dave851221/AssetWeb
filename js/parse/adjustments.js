// The `adjustments` sheet - every share-count change that is not a trade.
//
// This is what makes the workbook self-contained. Before it existed, a position
// could not be reconstructed from `trades_YYYY` alone - a stock with an
// employee share plan nets to one figure across every recorded order while the
// broker reports another, and nothing in the file said why. Now it does, and
// the identity closes:
//
//     Σ(trade qty x split factor) + Σ(adjustment qty)  ==  broker holding
//
// `selftest.js` asserts it over every symbol, and it needs no expectations
// file to do so.
//
// ## Layout
//
// Row 1 is a paragraph of prose in the merged first cell, so the header is not
// on row 1 and is found by scanning column A for 日期 rather than assumed.
//
// ## The three kinds
//
//   股票分割   a split. Carries 分割比例 and no quantity: it restates the units
//              of every earlier row rather than adding shares.
//   股數補登   shares that arrived outside the brokerage feed - an ESOP transfer
//              from a trust account, a broker's referral grant. May carry a
//              per-share cost, in which case it is also a FIFO buy.
//   配股       a stock dividend, at zero cost by definition.
//
// ## 股數單位 decides whether a split applies to the row itself
//
// 今日 means the quantity is already stated in today's units, so later splits
// must NOT be applied to it again - AssetSync has already done that. 當日 means
// it is in the units of its own date and later splits still apply. Getting this
// backwards would multiply a top-up by four.

import { str, num, ymd, colOf } from "./cells.js";

/** @typedef {import('../types.js').Grid} Grid */
/** @typedef {import('../types.js').Adjustment} Adjustment */

const KIND = {
  股票分割: "split",
  股數補登: "topup",
  配股: "stock-dividend",
};

/**
 * Parse the `adjustments` sheet.
 *
 * @param {Grid} grid
 * @param {string[]} warnings
 * @returns {Adjustment[]}
 */
export function parseAdjustments(grid, warnings) {
  if (!grid.length) return [];

  // The header is wherever 日期 is, not row 1 - row 1 holds an explanatory
  // paragraph, and the number of prose rows above the table may well change.
  const headRow = grid.findIndex((row) => str(row?.[0]) === "日期");
  if (headRow < 0) {
    warnings.push("adjustments：找不到表頭（第一欄應該有「日期」），整張跳過");
    return [];
  }
  const head = grid[headRow].map(str);
  const at = {
    date: colOf(head, "日期"),
    scope: colOf(head, "適用範圍"),
    symbol: colOf(head, "股票代號"),
    name: colOf(head, "股票名稱"),
    kind: colOf(head, "類型"),
    qty: colOf(head, "股數異動"),
    units: colOf(head, "股數單位"),
    ratio: colOf(head, "分割比例"),
    cost: colOf(head, "每股成本"),
    note: colOf(head, "說明"),
  };
  if (at.date < 0 || at.symbol < 0 || at.kind < 0) {
    warnings.push("adjustments：缺少「日期」「股票代號」或「類型」欄，整張跳過");
    return [];
  }

  /** @type {Adjustment[]} */
  const out = [];
  for (let r = headRow + 1; r < grid.length; r++) {
    const row = grid[r];
    const date = ymd(row[at.date]);
    const symbol = str(row[at.symbol]);
    if (!date || !symbol) continue;

    const label = str(row[at.kind]);
    const kind = /** @type {Adjustment['kind']} */ (KIND[label]);
    if (!kind) {
      // An unknown kind must not be silently treated as one of the known ones:
      // guessing wrong here corrupts every share count downstream.
      warnings.push(`adjustments 第 ${r + 1} 列：不認識的類型「${label}」，已跳過`);
      continue;
    }

    const ratio = at.ratio >= 0 ? num(row[at.ratio]) : null;
    if (kind === "split" && (ratio === null || ratio <= 0)) {
      warnings.push(`adjustments 第 ${r + 1} 列：${symbol} 的分割沒有比例，已跳過`);
      continue;
    }

    out.push({
      date,
      symbol,
      name: at.name >= 0 ? str(row[at.name]) : "",
      scope: at.scope >= 0 ? str(row[at.scope]) : "",
      kind,
      kindLabel: label,
      qty: at.qty >= 0 ? num(row[at.qty]) : null,
      // Anything other than an explicit 當日 is treated as already-current,
      // which is the safe direction: applying a split factor that AssetSync
      // has already applied would quadruple the row.
      unitsAsOfDate: at.units >= 0 && str(row[at.units]) === "當日",
      ratio: kind === "split" ? ratio : null,
      costPerShare: at.cost >= 0 ? num(row[at.cost]) : null,
      note: at.note >= 0 ? str(row[at.note]) : "",
    });
  }

  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/**
 * How many of today's shares one share of `symbol` held on `day` has become.
 *
 * Only splits strictly after `day` count: a split on the 18th restates a fill
 * from the 17th, but a fill on the 18th itself is already quoted in the new
 * units.
 *
 * @param {Adjustment[]} adjustments
 * @param {string} symbol
 * @param {string} day
 * @returns {number}
 */
export function splitFactor(adjustments, symbol, day) {
  let f = 1;
  for (const a of adjustments) {
    if (a.kind !== "split" || a.symbol !== symbol) continue;
    if (a.date <= day) continue;
    f *= /** @type {number} */ (a.ratio);
  }
  return f;
}

/**
 * An adjustment's quantity in today's share units.
 *
 * @param {Adjustment[]} adjustments
 * @param {Adjustment} a
 * @returns {number}
 */
export function adjustedQty(adjustments, a) {
  if (a.qty === null) return 0;
  return a.unitsAsOfDate ? a.qty * splitFactor(adjustments, a.symbol, a.date) : a.qty;
}
