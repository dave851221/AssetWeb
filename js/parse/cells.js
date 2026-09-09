// Cell-level type discipline. Every quirk of this workbook that can silently
// produce a wrong number is handled here, once, so the sheet parsers can stay
// about layout.
//
// The workbook is written by openpyxl and then recalculated by Excel, which
// leaves a few traps:
//
//   - A blank cell means "not applicable", never 0.
//   - An em dash (U+2014) is a deliberate "no value" marker, and it sits in
//     cells that still carry a #,##0 number format.
//   - A numeric column can contain a whole sentence: 已實現損益 holds
//     「請填入 cost_override.json」 while a FIFO cost is unresolved.
//   - Percentages are already fractions (0.2479 = +24.79%) under a custom
//     +0.00%;-0.00%;0.00% format. Dividing by 100 again is the classic bug.
//   - Dates are inconsistent: trades and 除權息日 are strings, history's
//     timestamp is a real datetime.

/**
 * Strings the workbook uses to mean "there is no value here".
 *
 * The em dash is the one AssetSync writes. The others are here because a
 * hand-maintained sheet such as `manual` may pick up an ASCII or full-width
 * dash instead, and in a numeric column any of them means the same thing.
 */
const NO_VALUE = new Set(["—", "–", "－", "-", "--", "N/A", "n/a"]);

/** Trimmed text. Null, undefined and blanks all collapse to the empty string. */
export function str(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

/** True for a cell holding one of the "no value" dash markers. */
export const isDash = (v) => NO_VALUE.has(str(v));

/**
 * A number, or null.
 *
 * Returns null - never NaN and never 0 - for blanks, dash markers, and prose
 * such as 「請填入 cost_override.json」. Commas and stray whitespace are
 * stripped so a value pasted in as text still parses, and a trailing % is
 * honoured for the same reason (a hand-typed "5%" means 0.05).
 */
export function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined || v === true || v === false) return null;
  if (v instanceof Date) return null;
  const t = str(v).replace(/[,\s]/g, "");
  if (t === "" || NO_VALUE.has(t)) return null;
  if (/^-?\d*\.?\d+%$/.test(t)) return parseFloat(t) / 100;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * A percentage cell, as a fraction.
 *
 * Deliberately identical to `num`: the value in the sheet is *already* a
 * fraction. This exists so a call site reads as "I know this column is a
 * percentage and I know not to divide it" rather than looking like an omission.
 */
export const frac = num;

/** A number that must not be null - blanks and dashes become 0. For gross
 *  amounts on a trade row, where the sheet always writes a real figure and a
 *  missing one would break every downstream sum. */
export const num0 = (v) => num(v) ?? 0;

const pad = (n) => String(n).padStart(2, "0");

/** Excel's day 0 is 1899-12-30 (its 1900 leap-year bug is baked into that). */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

/**
 * `YYYY-MM-DD`, or null.
 *
 * Handles all three shapes this workbook produces: an ISO-ish string
 * (`2026-01-05`, `2026/01/05`, `20260105`), a real Date (history's timestamp,
 * because SheetJS is asked for `cellDates`), and a bare Excel serial number in
 * case a hand-edited cell lost its date format.
 */
export function ymd(v) {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  if (typeof v === "number") {
    // A plausible serial only. Small integers are far more likely to be a
    // quantity that landed in the wrong column than a date in 1900.
    if (v < 1000 || v > 100000) return null;
    const d = new Date(EXCEL_EPOCH_MS + Math.floor(v) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const t = str(v);
  if (!t || isDash(t)) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/**
 * A local-time ISO timestamp, or null. Used for the run timestamps, which are
 * wall-clock values with no zone - so they are kept as written rather than
 * shifted into UTC, where an 18:18 run would read as the previous day in some
 * renderings.
 */
export function stamp(v) {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return `${ymd(v)}T${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
  }
  const t = str(v);
  if (!t) return null;
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t);
  if (m) {
    return `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4])}:${m[5]}:${m[6] || "00"}`;
  }
  const d = ymd(t);
  return d ? `${d}T00:00:00` : null;
}

/** The 4-digit year at the front of a value: `2026(Ongoing)` gives 2026. */
export function year(v) {
  const m = /^(\d{4})/.exec(str(v));
  return m ? Number(m[1]) : null;
}

/** True when every cell in the row is blank. Terminates a broker-sheet block. */
export const isBlankRow = (row) => !row || row.every((c) => str(c) === "");

/**
 * Where a header label sits in a header row, or -1.
 *
 * Matches on the trimmed label but tolerates the inconsistent spacing in these
 * headers (`市值 (TWD)` on one sheet, `市值(TWD)` on another) by comparing with
 * all whitespace removed.
 */
export function colOf(headers, label) {
  const want = label.replace(/\s/g, "");
  return headers.findIndex((h) => str(h).replace(/\s/g, "") === want);
}

/**
 * The column index for the first label that is present, or -1.
 *
 * The broker sheets disagree on a few names for the same thing - IBKR's
 * holdings block says 數量 where the Taiwan brokers say 持股數量 - so callers
 * pass every spelling they know.
 */
export function colOfAny(headers, labels) {
  for (const label of labels) {
    const i = colOf(headers, label);
    if (i >= 0) return i;
  }
  return -1;
}
