// The parser's report card.
//
// Stands in for a test runner: the expectations in selftest.js were read by
// hand out of the workbook - mostly from subtotal rows the parser skips - so a
// green board means the model agrees with the spreadsheet, not merely with
// itself.
//
// Nothing here is compared against a figure written down by hand: the workbook
// is regenerated nightly, so a hand-copied expectation would be stale by
// morning. Every check is either the spreadsheet's own 小計 against this
// parser's sum, an internal identity, or a structural rule - see selftest.js.
//
// Which is why it is worth shipping: it runs against whatever workbook was
// just loaded. It is kept out of the tab bar and reached with `?selftest=1`.

import { runSelfTest } from "../selftest.js";
import { el, card, table, int, chip } from "../util.js";
import { tile } from "./parts.js";

/** @typedef {import('../types.js').Model} Model */

/** @param {Model} m @param {any} [_arg] */
export function render(m, _arg) {
  const { checks, passed, failed } = runSelfTest(m);
  const grid = el("div", { class: "grid" });

  const head = card("自我測試", {
    note: "全部檢查都不依賴手抄的期望值：對照的是試算表自己算的小計、"
      + "資料內部的恆等式，以及不隨資料變動的結構規則。"
      + "所以每天更新的試算表也照樣適用。「僅供參考」的列不判定成敗。",
    warn: failed > 0,
  });
  head.append(el("div", { class: "tile-row" }, [
    tile({
      label: "通過", value: int(passed), sub: `共 ${checks.length} 項`,
      tone: failed === 0 ? "up" : "",
    }),
    tile({
      label: "失敗", value: int(failed),
      sub: failed === 0 ? "全部通過" : "見下方紅色列",
      tone: failed ? "down" : "",
    }),
    tile({
      label: "解析警告", value: int(m.meta.warnings.length),
      sub: m.meta.warnings.length ? "見下方清單" : "無",
      tone: m.meta.warnings.length ? "down" : "",
    }),
    tile({
      label: "對照的分頁小計", value: int(m.sheetTotals.length),
      sub: "由 Excel 算、parser 跳過的數字",
    }),
  ]));
  grid.append(head);

  if (m.meta.warnings.length) {
    const warn = card("解析警告", {
      note: "以下欄位或分頁與預期不符。資料仍會顯示，但相關數字可能不完整。",
      warn: true,
    });
    warn.append(el("ul", { class: "warn-list" },
      m.meta.warnings.map((w) => el("li", { text: w }))));
    grid.append(warn);
  }

  const body = card("檢查項目");
  body.append(table([
    {
      key: "ok", label: "", sortable: true,
      fmt: (v, r) => (r.want === "（僅供參考）"
        ? chip("參考", "")
        : chip(v ? "通過" : "失敗", v ? "pass" : "fail")),
      value: (r) => (r.want === "（僅供參考）" ? 2 : r.ok ? 1 : 0),
    },
    { key: "name", label: "項目", align: "left" },
    { key: "got", label: "實際值", align: "left" },
    { key: "want", label: "預期值", align: "left" },
    {
      key: "drifts", label: "備註", align: "left",
      fmt: (v) => (v ? "會隨資料變動" : ""),
    },
  ], checks, {
    // Failures first: that is the only thing anyone opens this page to see.
    sortKey: "ok", sortDir: "asc", scroll: false,
  }));
  grid.append(body);

  return grid;
}
