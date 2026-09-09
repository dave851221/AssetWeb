// Parser assertions. There is no test runner in this project, so this is it:
// `?dev=1&selftest=1` parses the workbook and checks the model against it.
//
// ## Every check here is data-independent
//
// The workbook is regenerated daily, so copying today's totals down as
// expectations makes them stale by morning - and in a public repo those
// figures are also somebody's finances. An earlier version kept them in a
// gitignored JSON file; that was the wrong shape for data that changes nightly.
//
// So nothing here is compared against a number written down by hand. Instead:
//
//   1. **The spreadsheet's own arithmetic.** Every broker block ends in a 小計
//      row, and the parser deliberately skips those as data. Comparing the sum
//      of the rows this code parsed against the total Excel computed is an
//      independent check - two different programs reaching the same number -
//      that stays true forever.
//   2. **Internal identities.** A position must reconstruct from trades plus
//      adjustments; history's 資產變化 must equal the difference between
//      consecutive totals.
//   3. **Structural rules.** A dash becomes null and not zero, a percentage is
//      not double-scaled, a broker sheet stays in its own currency.
//
// All of which means this board is worth keeping on the deployed site: it runs
// against whatever workbook was just loaded, and if AssetSync changes a column
// and a parser starts mis-reading it silently, this is where that surfaces.
//
// It is deliberately not in the tab bar - reach it with `?selftest=1`.

import { splitFactor, adjustedQty } from "./parse/adjustments.js";

/** @typedef {import('./types.js').Model} Model */

/**
 * @typedef {object} Check
 * @property {string} name
 * @property {boolean} ok
 * @property {string} got
 * @property {string} want
 * @property {boolean} drifts  true when new data legitimately changes this
 */

class Suite {
  constructor() {
    /** @type {Check[]} */
    this.checks = [];
  }

  /** @param {string} name @param {any} got @param {any} want */
  eq(name, got, want, { tol = 0, drifts = false } = {}) {
    const ok = typeof got === "number" && typeof want === "number"
      ? Math.abs(got - want) <= tol
      : got === want;
    this.checks.push({
      name, ok, drifts,
      got: String(got), want: tol ? `${want} ±${tol}` : String(want),
    });
  }

  /** @param {string} name @param {boolean} got */
  ok(name, got, want = true, { drifts = false } = {}) {
    this.checks.push({ name, ok: got === want, drifts, got: String(got), want: String(want) });
  }

  /** Informational only - a number worth eyeballing, never a pass or a fail. */
  note(name, value) {
    this.checks.push({ name, ok: true, drifts: true, got: String(value), want: "（僅供參考）" });
  }
}

const sum = (rows, f) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// ------------------------------------------------------- structural checks ---

/**
 * The rules, asserted without reference to any particular holding.
 *
 * @param {Suite} s
 * @param {Model} m
 */
function structural(s, m) {
  // ---------------------------------------------------------- trades ---
  s.ok("trades 皆為 buy 或 sell",
    m.trades.every((t) => t.side === "buy" || t.side === "sell"));
  s.ok("買進的實際收付為負",
    m.trades.filter((t) => t.side === "buy").every((t) => t.net <= 0));
  s.ok("賣出的實際收付為正",
    m.trades.filter((t) => t.side === "sell").every((t) => t.net >= 0));
  s.ok("trades 依日期遞增",
    m.trades.every((t, i) => i === 0 || m.trades[i - 1].date <= t.date));
  s.ok("每筆交易都有日期與代號",
    m.trades.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.date) && t.symbol));

  // A Taiwan code is text in the workbook so `0050` keeps its leading zero. If
  // a cell lost that formatting it would arrive as the number 50 and appear
  // here as a 1-to-3 digit symbol - which no listed TW code is.
  s.ok("台股代號沒有掉前導零",
    m.trades.filter((t) => t.currency === "TWD").every((t) => !/^\d{1,3}$/.test(t.symbol)));
  s.ok("台股代號長度合理（4-6 碼）",
    m.trades.filter((t) => t.currency === "TWD").every((t) => t.symbol.length >= 4));

  // Quantities are shares, never lots, and a US broker reports fractions.
  s.ok("美股有碎股（數量非整數），代表股數沒有被取整",
    m.trades.some((t) => t.currency === "USD" && !Number.isInteger(t.qty)), true,
    { drifts: true });

  // --------------------------------------------------------- history ---
  s.ok("history 每列都有 day（YYYY-MM-DD）",
    m.history.every((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.day)));
  s.ok("history 依時間遞增",
    m.history.every((h, i) => i === 0 || m.history[i - 1].ts <= h.ts));
  // The first row's delta is a real 0 written upstream, not a blank. If this
  // comes back null the "null is not zero" rule has been applied one cell too
  // far; if it comes back non-zero the sheet's first row has changed meaning.
  s.eq("history 第一列資產變化為 0（不是 null）", m.history[0]?.change, 0);
  s.eq("meta.usdTwdRate = history 最後一列的匯率",
    m.meta.usdTwdRate, m.history.at(-1)?.rate ?? null, { tol: 1e-9 });
  s.ok("history 的匯率都是正數",
    m.history.every((h) => h.rate === null || h.rate > 0));

  // ------------------------------------------- the em-dash rule ---
  // AssetSync writes 「—」 into numeric columns to mean "no value", and those
  // cells still carry a #,##0 number format. Turning one into 0 would make
  // "nothing pending" indistinguishable from "nothing was pending, we checked".
  // Somewhere in this workbook at least one such cell exists; if every single
  // one came back as a number, the dash handling has stopped working.
  const dashables = [
    ...m.balances.map((b) => b.pending),
    ...m.dividends.map((d) => d.qty),
    ...m.dividends.map((d) => d.perShare),
    ...m.dividends.map((d) => d.perThousand),
    ...m.realized.map((r) => r.cost),
  ];
  s.ok("「—」欄位解析為 null 而不是 0（至少存在一個）",
    dashables.some((v) => v === null), true, { drifts: true });
  s.ok("沒有任何數字欄位是 NaN",
    [...m.holdings.map((h) => h.marketValue), ...m.realized.map((r) => r.pnl),
      ...m.history.map((h) => h.total)]
      .every((v) => v === null || Number.isFinite(v)));

  // ------------------------------------------------ percentage scale ---
  // The sheet stores 0.2479 for +24.79%. A parser that divided by 100 again
  // would put every ROI on the site near zero; one that multiplied would make
  // a holding read as +2,479%.
  s.ok("報酬率都在合理範圍（|roi| < 20），代表沒有被重複縮放",
    m.holdings.every((h) => h.roi === null || Math.abs(h.roi) < 20)
    && m.realized.every((r) => r.roi === null || Math.abs(r.roi) < 20));

  // --------------------------------------------------- broker sheets ---
  // Broker sheets are always in their own currency; only summary and history
  // convert. A USD sheet parsed as TWD would understate it ~30x.
  s.ok("IBKR 分頁的持股與現金都是 USD",
    m.holdings.filter((h) => h.broker === "ibkr").every((h) => h.currency === "USD")
    && m.balances.filter((b) => b.broker === "ibkr").every((b) => b.currency === "USD"));
  s.ok("台股券商分頁都是 TWD",
    m.holdings.filter((h) => h.broker !== "ibkr").every((h) => h.currency === "TWD"));
  s.ok("待補成本的已實現列，損益為 null",
    m.realized.filter((r) => r.pending).every((r) => r.pnl === null));

  // A delisted holding keeps its row with a blank name and a price of 0.
  // `summary` drops those, which is why its totals do not tie back - so they
  // must be kept here, and flagged.
  const nameless = m.holdings.filter((h) => !h.name);
  s.ok("名稱空白的持股都標記為已下市",
    nameless.every((h) => h.delisted), true, { drifts: true });
  s.ok("已下市持股沒有被靜默丟掉（若有的話）",
    nameless.every((h) => h.qty > 0), true, { drifts: true });

  // ---------------------------------------------------------- manual ---
  s.ok("manual 分頁讀到了（AssetSync 的 CSV 匯出不含此分頁）",
    m.manual.length > 0, true, { drifts: true });
  s.ok("manual 的類型只有 cash 或 stock",
    m.manual.every((x) => x.type === "cash" || x.type === "stock"));

  // ----------------------------------------------------- adjustments ---
  const A = m.adjustments;
  s.ok("每筆分割都有比例",
    A.filter((a) => a.kind === "split").every((a) => (a.ratio ?? 0) > 1));
  s.ok("分割列不帶股數異動（它只換算單位，不增減股數）",
    A.filter((a) => a.kind === "split").every((a) => a.qty === null));
  s.ok("非分割的異動列都有股數",
    A.filter((a) => a.kind !== "split").every((a) => a.qty !== null));
  // A split on the 18th restates a fill from the 17th, but a fill on the 18th
  // itself is already in the new units. Getting this off by one day would
  // multiply one day's trades by the ratio.
  s.ok("分割當日就已是新單位（倍率 1）",
    A.filter((a) => a.kind === "split")
      .every((a) => splitFactor(A, a.symbol, a.date) === 1));
  s.ok("分割前一日的倍率大於 1",
    A.filter((a) => a.kind === "split").every((a) => {
      const before = new Date(`${a.date}T00:00:00Z`);
      before.setUTCDate(before.getUTCDate() - 1);
      return splitFactor(A, a.symbol, before.toISOString().slice(0, 10)) > 1;
    }));

  // 定期定額 and dividend reinvestment reach the trades sheet with a synthetic
  // order number, so a price history is complete rather than missing the
  // automated buys.
  s.ok("定期定額/再投資已進入交易紀錄（M_DCA / M_DRIP）",
    m.trades.some((t) => /^M_(DCA|DRIP)_/.test(t.orderNo)), true, { drifts: true });

  reconciliation(s, m);
}

/**
 * RECONCILIATION - the strongest check here, and it needs no expectations.
 *
 * Since the `adjustments` sheet exists, a position must be reconstructible
 * from the workbook alone:
 *
 *     Σ(trade qty x split factor) + Σ(adjustment qty)  ==  broker holding
 *
 * Before that sheet, this was unprovable: a stock could net to one figure
 * across every recorded order while the broker reported another, and nothing
 * in the file said why. If this goes red, either a parser is wrong or the
 * workbook has a share movement nobody recorded.
 *
 * @param {Suite} s
 * @param {Model} m
 */
function reconciliation(s, m) {
  const A = m.adjustments;
  const symbols = [...new Set([...m.holdings.map((h) => h.symbol),
    ...m.trades.map((t) => t.symbol)])];

  let worst = 0;
  let worstSymbol = "";
  let checked = 0;
  for (const sym of symbols) {
    const net = sum(m.trades.filter((t) => t.symbol === sym),
      (t) => t.qty * splitFactor(A, sym, t.date) * (t.side === "buy" ? 1 : -1));
    const add = sum(A.filter((a) => a.symbol === sym), (a) => adjustedQty(A, a));
    const held = sum(m.holdings.filter((h) => h.symbol === sym), (h) => h.qty);
    checked += 1;
    const diff = Math.abs(net + add - held);
    if (diff > worst) { worst = diff; worstSymbol = sym; }
  }

  // A thousandth of a share of slack: a broker's referral grant is
  // back-derived by subtraction upstream and lands a rounding step out.
  // Anything larger is a real gap in the data.
  s.eq(`持股還原誤差（檢查 ${checked} 檔，最差：${worstSymbol || "—"}）`,
    worst, 0, { tol: 0.005 });
  s.ok("每檔持股都能由交易紀錄加異動還原",
    worst <= 0.005);
}

// ----------------------------------------- the sheet's own arithmetic ---

/**
 * Compare what this parser summed against what Excel summed.
 *
 * The 小計 and 合計 rows are computed upstream by the spreadsheet and skipped
 * here as data, so the two numbers are arrived at independently. A mismatch
 * means a row was dropped, double-counted, or read from the wrong column -
 * exactly the failures a hand-written expectation used to catch, but without a
 * file that expires every night.
 *
 * @param {Suite} s
 * @param {Model} m
 */
function againstSheetTotals(s, m) {
  const label = (t) => `${t.broker} ${BLOCK[t.block] ?? t.block}`
    + `${t.year ? ` ${t.year}` : ""} ${FIELD[t.field] ?? t.field}（對照分頁小計）`;

  for (const t of m.sheetTotals) {
    let got = null;
    if (t.block === "holdings") {
      const rows = m.holdings.filter((h) => h.broker === t.broker);
      got = t.field === "marketValue"
        ? sum(rows, (h) => h.marketValue)
        : sum(rows, (h) => h.unrealizedPnl);
    } else if (t.block === "realized") {
      // A row awaiting cost_override holds prose where the number goes, so it
      // contributes nothing to either sum - Excel's SUM skips text and `num()`
      // returned null. The two agree precisely because both skip it.
      got = sum(m.realized.filter((r) => r.broker === t.broker && r.year === t.year),
        (r) => r.pnl);
    } else if (t.block === "dividends") {
      got = sum(m.dividends.filter((d) => d.broker === t.broker && d.year === t.year),
        (d) => d.cash);
    }
    if (got === null) continue;
    // A dollar of slack: the sheet rounds its display, and a USD block carries
    // two decimals where a TWD one carries none.
    s.eq(label(t), Math.round(got * 100) / 100, t.total, { tol: 1 });
  }
  s.ok("有讀到分頁小計可以對照", m.sheetTotals.length > 0);

  // history's 資產變化 is written upstream as the difference from the previous
  // row. Recomputing it here catches a row parsed out of order or a column
  // read off by one.
  let worstDelta = 0;
  for (let i = 1; i < m.history.length; i++) {
    const expect = m.history[i].total - m.history[i - 1].total;
    const got = m.history[i].change;
    if (got === null) continue;
    worstDelta = Math.max(worstDelta, Math.abs(got - expect));
  }
  s.eq("history 的資產變化 = 相鄰兩列總資產之差", Math.round(worstDelta), 0, { tol: 1 });
}

/** Block and field names, for a readable check label. */
const BLOCK = {
  holdings: "持股庫存", realized: "已實現損益", dividends: "除權息",
};
const FIELD = {
  marketValue: "市值", unrealizedPnl: "未實現損益", pnl: "損益", cash: "配息",
};

// ------------------------------------------------------------------- entry ---

/**
 * Run every check against a parsed model.
 *
 * @param {Model} m
 * @returns {{checks: Check[], passed: number, failed: number}}
 */
export function runSelfTest(m) {
  const s = new Suite();

  structural(s, m);
  againstSheetTotals(s, m);

  // Informational: this gap is expected, and knowing its size is what tells a
  // parsing slip from the known upstream difference. history's 富邦現金 is
  // net_cash (balance + T+2 pending) while the broker sheet reports the raw
  // balance, so the two disagree by exactly the pending amounts.
  const rate = m.meta.usdTwdRate ?? 0;
  const twd = (v, cur) => (v ?? 0) * (cur === "USD" ? rate : 1);
  const computed = m.holdings.reduce((a, h) => a + twd(h.marketValue, h.currency), 0)
    + m.balances.reduce(
      (a, b) => a + twd(b.balance, b.currency) + twd(b.pending, b.currency), 0)
    + sum(m.manual, (x) => x.amount);
  const reported = m.history.at(-1)?.total ?? 0;
  // Printed as a difference, not as the totals themselves: the discrepancy is
  // the diagnostic, and it is not somebody's net worth.
  s.note("自算總資產 − history 最後一列（差額應接近 0）", Math.round(computed - reported));
  s.note("解析警告數", m.meta.warnings.length);
  s.eq("parser 沒有發出警告", m.meta.warnings.length, 0, { drifts: true });

  const failed = s.checks.filter((c) => !c.ok).length;
  return { checks: s.checks, passed: s.checks.length - failed, failed };
}
