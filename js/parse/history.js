// The `history` sheet - the only real time series in the workbook.
//
// Header on row 1, data from row 2, append-only, no footer. One row per
// calendar day; a same-day rerun overwrites the last row rather than appending.
//
// Two things to know before touching it:
//
//   - **The header rewrites itself upstream.** When AssetSync gains a column it
//     rewrites the whole header row and back-fills the new column for every
//     historical row. So every column here is located by its header text; a
//     fixed index would silently shift the day a broker is added.
//   - **Sparse columns are normal.** A broker that was disabled on a given run
//     writes nothing for its three columns, and the manual columns are blank
//     when zero. Those are nulls, not zeros, and a stacked chart has to skip
//     an all-null series rather than draw a flat line at the bottom.
//
// The IBKR columns are already converted to TWD by AssetSync using that row's
// own `USD/TWD匯率`, which is why the rate is worth keeping per row: it is the
// only per-day exchange rate anywhere in this data.

import { str, num, ymd, stamp, colOf } from "./cells.js";

/** @typedef {import('../types.js').Grid} Grid */
/** @typedef {import('../types.js').HistoryRow} HistoryRow */
/** @typedef {import('../types.js').HistorySlice} HistorySlice */

/**
 * Parse the `history` sheet.
 *
 * @param {Grid} grid
 * @param {string[]} warnings
 * @returns {HistoryRow[]}
 */
export function parseHistory(grid, warnings) {
  if (!grid.length) return [];
  const head = grid[0].map(str);

  const iTs = colOf(head, "時間戳記");
  const iTotal = colOf(head, "台幣總資產");
  if (iTs < 0 || iTotal < 0) {
    warnings.push("history：找不到「時間戳記」或「台幣總資產」欄，走勢圖將是空的");
    return [];
  }
  const iRate = colOf(head, "USD/TWD匯率");
  const iManualCash = colOf(head, "手動現金");
  const iManualStock = colOf(head, "手動持股");
  const iChange = colOf(head, "資產變化");

  // The three per-broker triples. IBKR's carry a (TWD) suffix because the
  // values are converted; the Taiwan ones do not.
  const slices = /** @type {const} */ ([
    ["fubon", "富邦現金", "富邦持股", "富邦小計"],
    ["sinopac", "永豐現金", "永豐持股", "永豐小計"],
    ["ibkr", "IBKR現金(TWD)", "IBKR持股(TWD)", "IBKR小計(TWD)"],
  ]).map(([key, cash, stock, total]) => ({
    key,
    iCash: colOf(head, cash),
    iStock: colOf(head, stock),
    iTotal: colOf(head, total),
  }));

  /** @param {Grid[number]} row @param {{iCash:number,iStock:number,iTotal:number}} s */
  const slice = (row, s) => /** @type {HistorySlice} */ ({
    cash: s.iCash >= 0 ? num(row[s.iCash]) : null,
    stock: s.iStock >= 0 ? num(row[s.iStock]) : null,
    total: s.iTotal >= 0 ? num(row[s.iTotal]) : null,
  });

  /** @type {HistoryRow[]} */
  const out = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const ts = stamp(row[iTs]);
    const total = num(row[iTotal]);
    // A row without both a timestamp and a total is not a snapshot - it is a
    // blank tail row or something hand-typed.
    if (!ts || total === null) continue;

    const by = Object.fromEntries(slices.map((s) => [s.key, slice(row, s)]));
    out.push({
      ts,
      day: /** @type {string} */ (ymd(row[iTs]) ?? ts.slice(0, 10)),
      fubon: by.fubon,
      sinopac: by.sinopac,
      ibkr: by.ibkr,
      rate: iRate >= 0 ? num(row[iRate]) : null,
      manualCash: iManualCash >= 0 ? num(row[iManualCash]) : null,
      manualStock: iManualStock >= 0 ? num(row[iManualStock]) : null,
      total,
      change: iChange >= 0 ? num(row[iChange]) : null,
    });
  }

  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out;
}
