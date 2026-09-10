// 總覽 - the view that answers "where do I stand" without scrolling.
//
// The lead is a hero figure, not a chart: a single current value with a trend
// is a stat tile's job, and a one-bar bar chart of net worth would say less
// than the number itself. Charts start where comparison starts.

import { el, card, money, signedMoney, pct, signedPct, isNum, DASH } from "../util.js";
import { derive, changeOver } from "../model.js";
import { donut, donutLegend, stackedHBar, hbar, divergingBars, compact, mount } from "../charts.js";
import { hero, tile, tileRow, chartCard, chartName, footnote } from "./parts.js";

/** @typedef {import('../types.js').Model} Model */

/** @param {Model} m @param {any} [_arg] */
export function render(m, _arg) {
  const d = derive(m);
  const grid = el("div", { class: "grid" });
  const t = d.totals;

  // ------------------------------------------------------------- the lead ---
  const lead = card("", { span: "span-12 flush" });
  const spark = d.history.slice(-45).map((h) => h.total);
  const last = d.history.at(-1);
  lead.append(hero({
    host: lead,
    label: "台幣總資產",
    value: money(t.total),
    delta: last && isNum(last.change) && last.change !== 0
      ? { abs: last.change, pct: t.total - last.change ? last.change / (t.total - last.change) : null,
          since: "較前一次同步" }
      : null,
    sub: last ? `資料截至 ${last.day}` : undefined,
    spark,
  }));
  grid.append(lead);

  // Without a rate the IBKR account cannot be valued in TWD at all, and
  // silently treating USD as TWD would understate it by ~97%.
  if (!d.rate && d.holdings.some((h) => h.currency === "USD")) {
    const warn = card("缺少匯率", {
      note: "history 最後一列沒有匯率，美股部位無法換算，以下台幣金額都少算了美股。",
      warn: true,
    });
    grid.append(warn);
  }

  // ------------------------------------------------------------- the tiles ---
  const w1 = changeOver(d.history, 7);
  const w4 = changeOver(d.history, 30);
  grid.append(el("section", { class: "card span-12 flush" }, tileRow([
    tile({
      label: "現金 / 待交割", value: money(t.cash),
      deltaText: `佔 ${pct(t.cashPct, 1)}`,
    }),
    tile({
      label: "持股市值", value: money(t.stock),
      deltaText: `佔 ${pct(t.stockPct, 1)}`,
    }),
    tile({
      label: "未實現損益", value: signedMoney(t.unrealized),
      tone: t.unrealized >= 0 ? "up" : "down",
      deltaText: t.unrealizedCost > 0 ? signedPct(t.unrealized / t.unrealizedCost) : undefined,
      sub: `${t.winners} 檔獲利 · ${t.losers} 檔虧損`,
    }),
    tile({
      label: "近 7 天變化", value: w1 ? signedMoney(w1.abs) : DASH,
      tone: w1 ? (w1.abs >= 0 ? "up" : "down") : "",
      deltaText: w1 && isNum(w1.pct) ? signedPct(w1.pct) : undefined,
    }),
    tile({
      label: "近 30 天變化", value: w4 ? signedMoney(w4.abs) : DASH,
      tone: w4 ? (w4.abs >= 0 ? "up" : "down") : "",
      deltaText: w4 && isNum(w4.pct) ? signedPct(w4.pct) : undefined,
    }),
  ])));

  // -------------------------------------------------------- total return ---
  // The one honest performance number in this data, and the thing `summary`
  // never adds up: what the broker sheets say has been made, realized and not.
  // Short labels: the bar chart caps its category column, and "（累計）" on two
  // of three rows is redundant once the footnote says so.
  const parts = [
    { name: "未實現損益", value: t.unrealized },
    { name: "已實現損益", value: t.realizedAll },
    { name: "除權息收入", value: t.dividendsAll },
  ];
  const returnCard = card("總報酬", { span: "half" });
  returnCard.append(el("div", { class: "big-line" }, [
    el("span", {
      class: "big-value " + (t.totalReturn >= 0 ? "up" : "down"),
      text: signedMoney(t.totalReturn),
    }),
    el("span", { class: "big-note", text: "未實現 + 已實現 + 除權息" }),
  ]));
  returnCard.append(mount(returnCard, divergingBars({
    names: parts.map((p) => p.name),
    values: parts.map((p) => p.value),
    label: "金額",
  }), { class: "chart short" }));
  returnCard.append(footnote(
    "已實現與除權息是資料起點以來的累計值。美元部位用最新匯率換算，非成交當日匯率。",
  ));
  grid.append(returnCard);

  // --------------------------------------------------------- allocation ---
  const allocItems = d.allocation.map((a) => ({ label: a.label, value: a.value }));
  const allocCard = chartCard("資產配置", donut({
    items: allocItems,
    centerLabel: "總資產",
    centerValue: compact(t.total),
  }), {
    span: "half",
    chartClass: "chart short",
    note: "手動項目單獨成一類：它裝的是美股複委託，併進台股會讓台美佔比失真。",
  });
  // The legend lives in HTML under the ring, so three fields per row can wrap
  // instead of being laid across the donut at phone widths.
  allocCard.append(donutLegend(allocItems));
  grid.append(allocCard);

  // ------------------------------------------------------------- brokers ---
  grid.append(chartCard("各券商資產", stackedHBar({
    names: d.brokers.map((b) => b.label),
    series: [
      { name: "現金/待交割", values: d.brokers.map((b) => b.cash) },
      { name: "持股市值", values: d.brokers.map((b) => b.stock) },
    ],
  }), {
    span: "half",
    chartClass: "chart short",
    note: "現金含尚未交割的 T+2 淨額，與券商分頁的「交割戶餘額」不同。",
  }));

  // -------------------------------------------------------- top holdings ---
  // Merged across brokers: 0050 is held at both 富邦 and 永豐, and listing it
  // twice would both clutter the ranking and understate its real weight.
  const top = d.bySymbol.filter((h) => h.valueTwd > 0).slice(0, 10);
  grid.append(chartCard("前 10 大持股", hbar({
    // Tickers for US holdings: their legal names are long enough to set the
    // left gutter for every row and squeeze the bars into what is left.
    names: top.map(chartName),
    values: top.map((h) => h.valueTwd),
    label: "市值 (TWD)",
    sub: top.map((h) => `${h.symbol}　佔持股 ${pct(h.weight, 1)}　${signedPct(h.roi)}`
      + (h.brokers.length > 1 ? `　（${h.brokers.length} 家券商合計）` : "")),
  }), {
    span: "half", chartClass: "chart short",
    note: "同一檔在多家券商的部位已合併。美股顯示代號。",
  }));

  return grid;
}

