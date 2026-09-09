// xlsx bytes in, normalised model out.
//
// This is the only module that knows SheetJS exists. It turns each sheet into a
// dense grid of raw cell values and hands those to the per-sheet parsers, so
// everything downstream deals in plain arrays and never in a spreadsheet API.
//
// Why the workbook rather than AssetSync's CSV export: the CSVs lose every
// type (dates and numbers arrive as strings), and `manual` is deliberately not
// exported at all. Reading the xlsx keeps both.

import { SHEETS, REQUIRED_SHEETS, BROKERS } from "../config.js";
import { str, num, stamp } from "./cells.js";
import { parseTrades } from "./trades.js";
import { parseBrokerSheet } from "./broker.js";
import { parseHistory } from "./history.js";
import { parseManual } from "./manual.js";
import { parseAdjustments } from "./adjustments.js";

/** @typedef {import('../types.js').Model} Model */
/** @typedef {import('../types.js').Grid} Grid */
/** @typedef {import('../types.js').Broker} Broker */
/** @typedef {import('../types.js').Currency} Currency */

/** The file opened fine but is not an AssetSync workbook. Recoverable: the
 *  user picked the wrong file and can pick again. */
export class WorkbookShapeError extends Error {}

/** SheetJS, loaded as a global by the vendored script in index.html. */
function sheetjs() {
  const lib = /** @type {any} */ (window).XLSX;
  if (!lib) throw new Error("試算表解析程式庫沒有載入（vendor/xlsx.full.min.js）");
  return lib;
}

/**
 * Every sheet as a rectangular grid.
 *
 * `blankrows: true` matters: the broker sheets use a blank row to end a block,
 * so dropping empty rows would run two blocks together. `defval: null` gives a
 * blank cell the value the whole model expects - null, not the empty string
 * and certainly not 0. Rows are then padded to the widest row so that
 * `grid[r][c]` is safe for any c the header row defines.
 *
 * @param {ArrayBuffer} buf
 * @returns {{ sheets: Map<string, Grid>, names: string[] }}
 */
function toGrids(buf) {
  const XLSX = sheetjs();
  // cellDates makes history's 時間戳記 a real Date instead of a serial number.
  // cellFormula/cellHTML/cellStyles stay off: the formula sheets were already
  // recalculated by Excel upstream, so the cached values are what we want, and
  // asking for the rest only costs memory.
  const wb = XLSX.read(new Uint8Array(buf), { type: "array", cellDates: true });
  /** @type {Map<string, Grid>} */
  const sheets = new Map();
  for (const name of wb.SheetNames) {
    /** @type {Grid} */
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1, raw: true, defval: null, blankrows: true,
    });
    const width = grid.reduce((w, row) => Math.max(w, row ? row.length : 0), 0);
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r] || (grid[r] = []);
      while (row.length < width) row.push(null);
    }
    sheets.set(name, grid);
  }
  return { sheets, names: wb.SheetNames.slice() };
}

/** `更新時間：2026-09-08 18:18:04`, wherever it appears in a sheet's first row. */
function updatedAtFrom(grid) {
  for (const cell of (grid?.[0] || [])) {
    const m = /更新時間[：:]\s*(.+)$/.exec(str(cell));
    if (m) return stamp(m[1].trim());
  }
  return null;
}

/**
 * Parse an AssetSync workbook.
 *
 * @param {ArrayBuffer} buf
 * @param {string} fileName
 * @returns {Model}
 */
export function parseWorkbook(buf, fileName) {
  const { sheets, names } = toGrids(buf);

  // A cheap shape probe first, so "you picked the wrong file" becomes a
  // sentence and a re-pick button instead of an empty dashboard.
  const missing = REQUIRED_SHEETS.filter((n) => !sheets.has(n));
  if (missing.length) {
    throw new WorkbookShapeError(`缺少分頁：${missing.join("、")}`);
  }

  /** @type {string[]} */
  const warnings = [];
  /** @type {Grid} */
  const empty = [];
  const grid = (name) => sheets.get(name) ?? empty;

  const trades = parseTrades(sheets, SHEETS.TRADES_PREFIX, warnings);
  if (!trades.length) warnings.push("找不到任何 trades_YYYY 分頁的交易紀錄");

  const brokerSheets = /** @type {const} */ ([
    [SHEETS.FUBON, "fubon"],
    [SHEETS.SINOPAC, "sinopac"],
    [SHEETS.IBKR, "ibkr"],
  ]);

  const holdings = [];
  const realized = [];
  const dividends = [];
  const balances = [];
  // The 小計 rows off every broker block. The parser skips them as data and
  // keeps them here instead, so the self-test can compare its own sums against
  // what Excel computed - a check that needs no external expectations and
  // never goes stale as the workbook is updated.
  const sheetTotals = [];
  for (const [sheetName, broker] of brokerSheets) {
    // A broker that has never been enabled simply has no sheet. That is not a
    // problem worth a warning - only a sheet that exists and cannot be read is.
    if (!sheets.has(sheetName)) continue;
    const parsed = parseBrokerSheet(
      grid(sheetName),
      /** @type {Broker} */ (broker),
      /** @type {Currency} */ (BROKERS[broker].currency),
      warnings,
    );
    holdings.push(...parsed.holdings);
    realized.push(...parsed.realized);
    dividends.push(...parsed.dividends);
    sheetTotals.push(...parsed.totals);
    if (parsed.balance) balances.push(parsed.balance);
  }

  const history = parseHistory(grid(SHEETS.HISTORY), warnings);
  const manual = parseManual(grid(SHEETS.MANUAL));
  // Not required: an older workbook predates this sheet, and everything still
  // works without it - only the share reconciliation goes back to being
  // unexplained and split factors fall back to inference.
  const adjustments = sheets.has(SHEETS.ADJUSTMENTS)
    ? parseAdjustments(grid(SHEETS.ADJUSTMENTS), warnings)
    : [];

  const last = history.at(-1);
  if (!history.length) warnings.push("history 分頁沒有可用的快照，資產走勢會是空的");
  if (last && last.rate === null) warnings.push("history 最後一列沒有匯率，美股部位無法換算台幣");

  return {
    meta: {
      fileName,
      fetchedAt: new Date().toISOString(),
      // AssetSync stamps its run time into the first row of summary and of
      // every broker sheet. summary is the whole-workbook one; a broker sheet's
      // own stamp can be older, because a disabled broker keeps a stale sheet.
      updatedAt: updatedAtFrom(grid(SHEETS.SUMMARY))
        ?? balances.map((b) => b.updatedAt).filter(Boolean).sort().at(-1)
        ?? last?.ts
        ?? null,
      usdTwdRate: last?.rate ?? null,
      sheetNames: names,
      warnings,
    },
    trades,
    holdings,
    realized,
    dividends,
    balances,
    history,
    manual,
    adjustments,
    sheetTotals,
  };
}

