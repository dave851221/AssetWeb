// 資產走勢 - what the daily snapshots say, over a chosen window.
//
// The range control sits in one row above everything and scopes every chart and
// stat below it, so the numbers always agree with each other.
//
// Two honesty constraints shape this view:
//
//  1. **The curve is a balance history, not performance.** Deposits and
//     withdrawals are recorded nowhere in the workbook, so a rise here may be
//     the market or may be a transfer. Every framing on this page says
//     "變化", never "報酬" - the return figure lives on 總覽, computed from
//     the broker sheets' own P&L.
//  2. **The exchange rate gets its own chart.** Putting it on a second y-axis
//     beside the asset curve would let the reader see a correlation whose
//     strength is an artifact of where the two scales happen to line up.

import { el, card, clear, money, signedMoney, pct, signedPct, isNum, DASH } from "../util.js";
import { derive, inRange, maxDrawdown, RANGES } from "../model.js";
import {
  timeLine, stackedArea, divergingColumns, disposeIn, slot, compact,
} from "../charts.js";
import { tile, tileRow, chartCard, rangeRow, footnote } from "./parts.js";

/** @typedef {import('../types.js').Model} Model */
/** @typedef {import('../types.js').HistoryRow} HistoryRow */

/** The per-broker day series, skipping any broker that never reported. */
function brokerSeries(rows) {
  const defs = /** @type {const} */ ([
    ["富邦", (h) => h.fubon.total],
    ["永豐", (h) => h.sinopac.total],
    ["IBKR", (h) => h.ibkr.total],
    ["手動項目", (h) => sumNullable(h.manualCash, h.manualStock)],
  ]);
  return defs
    .map(([name, get]) => ({ name, values: rows.map(get) }))
    // A broker that was disabled writes nothing at all, so an all-null series
    // is absence, not a flat line at zero. Dropping it also keeps the colour
    // slots stable for the brokers that are present.
    .filter((s) => s.values.some((v) => isNum(v)));
}

/** null + null stays null; null + 5 is 5. Absence must not become zero. */
function sumNullable(...vals) {
  const present = vals.filter(isNum);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

const cashOf = (h) => sumNullable(h.fubon.cash, h.sinopac.cash, h.ibkr.cash, h.manualCash);
const stockOf = (h) => sumNullable(h.fubon.stock, h.sinopac.stock, h.ibkr.stock, h.manualStock);

/** @param {Model} m @param {any} [_arg] */
export function render(m, _arg) {
  const d = derive(m);
  const root = el("div", {});
  let key = "ALL";

  const filters = el("div", {});
  const body = el("div", { class: "grid" });
  root.append(filters, body);

  function setRange(next) {
    key = next;
    paint();
  }

  function paint() {
    clear(filters);
    filters.append(rangeRow(key, setRange));
    // Charts hold a canvas and a ResizeObserver each; repainting without this
    // leaks one of each per filter click.
    disposeIn(body);
    clear(body);

    const rows = inRange(d.history, key);
    if (rows.length < 2) {
      const empty = card("資產走勢", {
        note: `這個期間只有 ${rows.length} 筆快照，畫不出走勢。`
          + `資料範圍是 ${d.history[0]?.day ?? DASH} 至 ${d.history.at(-1)?.day ?? DASH}。`,
      });
      body.append(empty);
      return;
    }

    const days = rows.map((r) => r.day);
    const totals = rows.map((r) => r.total);
    const first = rows[0], last = rows[rows.length - 1];
    const change = last.total - first.total;
    const peak = Math.max(...totals);
    const trough = Math.min(...totals);
    const dd = maxDrawdown(rows);

    // ----------------------------------------------------------- the stats ---
    body.append(el("section", { class: "card span-12 flush" }, tileRow([
      tile({
        label: "期間變化", value: signedMoney(change),
        tone: change >= 0 ? "up" : "down",
        deltaText: first.total ? signedPct(change / first.total) : undefined,
        sub: `${first.day} → ${last.day}`,
      }),
      tile({ label: "期間最高", value: money(peak) }),
      tile({ label: "期間最低", value: money(trough) }),
      tile({
        label: "最大回撤", value: pct(dd.pct, 2),
        tone: dd.pct < 0 ? "down" : "",
        sub: dd.peakDay ? `${dd.peakDay} → ${dd.troughDay}` : "沒有回撤",
      }),
    ])));

    // ----------------------------------------------------------- the curve ---
    body.append(chartCard("台幣總資產", timeLine({
      days, values: totals, label: "台幣總資產",
      // Fitted axis: this series never approaches zero, and drawn from zero the
      // whole curve would sit in the top eighth of the card.
      baseline: "data",
    }), {
      span: "span-12",
      chartClass: "chart tall",
      note: "這是帳戶餘額的歷史，不是報酬：存入與提出沒有記錄，"
        + "所以上升可能來自市場，也可能來自轉入。報酬看「總覽」。",
    }));

    // --------------------------------------------------------- by broker ---
    const bySeries = brokerSeries(rows);
    if (bySeries.length > 1) {
      body.append(chartCard("各券商小計", stackedArea({ days, series: bySeries }), {
        span: "half",
        note: "IBKR 的金額是用當天匯率換算成台幣後寫入的。",
      }));
    }

    // ------------------------------------------------------ cash vs stock ---
    // Normalised here rather than in the builder: ECharts does not normalise a
    // stacked line series, and a half-normalised chart is worse than none.
    const cashPct = [], stockPct = [];
    for (const r of rows) {
      const c = cashOf(r) ?? 0;
      const s = stockOf(r) ?? 0;
      const t = c + s;
      cashPct.push(t ? (c / t) * 100 : null);
      stockPct.push(t ? (s / t) * 100 : null);
    }
    body.append(chartCard("現金與持股佔比", stackedArea({
      days, percent: true,
      series: [
        { name: "現金/待交割", values: cashPct },
        { name: "持股市值", values: stockPct },
      ],
    }), { span: "half" }));

    // ------------------------------------------------------- daily change ---
    body.append(chartCard("每日變化", divergingColumns({
      days,
      values: rows.map((r) => r.change),
      label: "較前一次同步",
    }), {
      span: "span-12",
      chartClass: "chart short",
      note: "同一天重跑同步會覆寫該列，所以每個日期只有一筆。",
    }));

    // ---------------------------------------------------------- fx rate ---
    const rates = rows.map((r) => r.rate);
    if (rates.some(isNum)) {
      const rateCard = chartCard("USD / TWD 匯率", timeLine({
        days, values: rates, label: "USD/TWD",
        // A rate is read to four decimals, not compacted into 萬.
        fmt: (v) => v.toFixed(4),
        endFmt: (v) => v.toFixed(4),
        color: slot(1),
      }), { span: "half", chartClass: "chart short" });
      rateCard.append(footnote(
        "刻意獨立成一張圖，不疊在資產曲線的第二個 Y 軸上——"
        + "兩條不同尺度的線放在一起，看起來的相關性只取決於兩個軸怎麼對齊。",
      ));
      body.append(rateCard);
    }

    // -------------------------------------------------------- the table ---
    // Relief for every chart above: no value is reachable only by hovering.
    const tableCard = card("每日明細", { span: "half" });
    tableCard.append(historyTable(rows));
    body.append(tableCard);
  }

  paint();
  return root;
}

/** A compact, newest-first read-out of the same rows the charts plot. */
function historyTable(rows) {
  const head = ["日期", "總資產", "變化", "現金", "持股", "匯率"];
  const table = el("table", { class: "data" });
  table.append(el("thead", {}, el("tr", {}, head.map((h, i) =>
    el("th", { class: i === 0 ? "text" : "", text: h })))));
  const body = el("tbody");
  for (const r of [...rows].reverse()) {
    const change = r.change;
    body.append(el("tr", {}, [
      el("td", { class: "text", text: r.day }),
      el("td", { text: money(r.total) }),
      el("td", {
        class: isNum(change) && change !== 0 ? (change > 0 ? "up" : "down") : "",
        text: signedMoney(change),
      }),
      el("td", { text: compact(cashOf(r) ?? NaN) || DASH }),
      el("td", { text: compact(stockOf(r) ?? NaN) || DASH }),
      el("td", { class: "dim", text: isNum(r.rate) ? r.rate.toFixed(4) : DASH }),
    ]));
  }
  table.append(body);
  return el("div", { class: "table-wrap scroll-y" }, table);
}

export { RANGES };
