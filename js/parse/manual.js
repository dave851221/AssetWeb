// The `manual` sheet - the only sheet AssetSync reads back as *input* rather
// than writing. Hand-maintained: bank deposits, and the 富邦美股複委託 holdings
// that have no API to sync from.
//
// Header on row 1, data from row 2. Four columns, one of which (類型) is an
// Excel dropdown with two options.
//
// Note this sheet is deliberately excluded from AssetSync's CSV export, so it
// only exists in the xlsx - which is one of the reasons this app reads the
// workbook rather than the CSVs.

import { str, num, colOf } from "./cells.js";

/** @typedef {import('../types.js').Grid} Grid */
/** @typedef {import('../types.js').ManualItem} ManualItem */

/** The one value that means "this is a holding". Everything else is cash. */
const STOCK_TYPE = "持股市值";

/**
 * Parse the `manual` sheet.
 *
 * @param {Grid} grid
 * @returns {ManualItem[]}
 */
export function parseManual(grid) {
  if (!grid.length) return [];
  const head = grid[0].map(str);
  const iItem = colOf(head, "項目");
  const iAmount = colOf(head, "金額");
  const iType = colOf(head, "類型");
  const iNote = colOf(head, "備註");
  if (iItem < 0 || iAmount < 0) return [];

  /** @type {ManualItem[]} */
  const out = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const item = str(row[iItem]);
    const amount = num(row[iAmount]);
    if (!item || amount === null) continue;
    // A zero row carries nothing for a dashboard, and AssetSync seeds the
    // sheet with 「(範例) 銀行存款 / 0」 that would otherwise show up as a real
    // asset line. This is the one place a zero is dropped rather than kept.
    if (amount === 0) continue;

    out.push({
      item,
      amount,
      // Classified exactly as AssetSync does it: a test against the one stock
      // value, not a lookup of two. An older sheet has no 類型 column at all
      // (it was inserted during a migration), and everything in it was cash.
      type: iType >= 0 && str(row[iType]) === STOCK_TYPE ? "stock" : "cash",
      note: iNote >= 0 ? str(row[iNote]) : "",
    });
  }
  return out;
}
