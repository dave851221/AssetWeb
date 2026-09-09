// 持股 - the cross-broker view the spreadsheet cannot give you.
//
// AssetSync keeps one sheet per broker, each in its own currency, so "how much
// of 2330 do I actually hold, and across which accounts" needs three sheets and
// a calculator. Everything here is already merged and already in TWD.
//
// Four forms, each with one job:
//
//   - **Treemap** - allocation. Area is market value, colour is the broker.
//     Colour is deliberately *not* mapped to return: that would put a red-green
//     ramp on the one channel with nothing to back it up, and red-vs-green is
//     the colour-vision failure case. Return gets its own chart below.
//   - **Diverging bars** - who is making and losing money. Position carries the
//     sign, the label carries the number, hue is redundant reinforcement.
//   - **Bubble scatter** - risk. A big bubble far to the left is a large
//     position that is losing, which is the thing a table never shows you.
//   - **Table** - the relief layer. Every value above is here without hovering.

import {
  el, card, table, money, priceText, signedMoney, pct, signedPct, isNum, chip, DASH,
} from "../util.js";
import { derive } from "../model.js";
import { treemap, divergingBars, bubble, htmlLegend, barRows, mount } from "../charts.js";
import { tile, tileRow, chartCard, barCell, shareCell, footnote } from "./parts.js";

/** @typedef {import('../types.js').Model} Model */

const tone = (v) => (isNum(v) && v !== 0 ? (v > 0 ? "up" : "down") : "");
const shareText = (v) => (isNum(v) ? v.toLocaleString("zh-TW", { maximumFractionDigits: 4 }) : DASH);

/** @param {Model} m @param {any} [_arg] */
export function render(m, _arg) {
  const d = derive(m);
  const grid = el("div", { class: "grid" });
  const t = d.totals;
  // Delisted rows carry a market value of 0 and a -100% return. They belong in
  // the table and in the loss totals, but a zero-area treemap tile and a
  // -100% bubble would only distort the two charts that plot magnitude.
  const live = d.holdings.filter((h) => h.valueTwd > 0);

  // ------------------------------------------------------------- the stats ---
  const biggest = live[0];
  grid.append(el("section", { class: "card span-12 flush" }, tileRow([
    tile({ label: "持股市值", value: money(t.stock), sub: `${d.holdings.length} 檔` }),
    tile({
      label: "未實現損益", value: signedMoney(t.unrealized),
      tone: t.unrealized >= 0 ? "up" : "down",
      deltaText: t.unrealizedCost > 0 ? signedPct(t.unrealized / t.unrealizedCost) : undefined,
      sub: "市值加權報酬率",
    }),
    tile({
      label: "獲利 / 虧損", value: `${t.winners} / ${t.losers}`,
      sub: t.delisted ? `另有 ${t.delisted} 檔已下市` : undefined,
    }),
    tile({
      label: "最大單一持股", value: biggest ? pct(biggest.weight, 1) : DASH,
      sub: biggest ? `${biggest.name || biggest.symbol}　${money(biggest.valueTwd)}` : undefined,
    }),
    tile({
      label: "台股 / 美股", value: splitLabel(live),
      sub: "手動項目未計入（沒有個股明細）",
    }),
  ])));

  // ------------------------------------------------------------- treemap ---
  const groups = groupByBroker(d, live);
  if (groups.length) {
    const tmCard = card("配置全景", {
      span: "span-12",
      note: "面積是市值，顏色是持有它的券商。報酬率刻意不用顏色表示——"
        + "紅綠漸層是色盲最容易誤讀的組合，而且顏色是這張圖唯一的通道。"
        + "報酬率請看下一張圖，那裡由位置表示正負。",
    });
    // A treemap is a single ECharts series, so it has no series names for a
    // built-in legend - identity has to come from real HTML beside it.
    tmCard.append(htmlLegend(groups.map((g) => g.name)));
    tmCard.append(mount(tmCard, treemap({ groups }), { class: "chart tall" }));
    grid.append(tmCard);
  }

  // ------------------------------------------------------ diverging bars ---
  // Merged by symbol: a stock held at two brokers is one position, and two
  // bars for it would both clutter the ranking and split its real P&L.
  const ranked = d.bySymbol.filter((h) => h.valueTwd > 0)
    .sort((a, b) => b.pnlTwd - a.pnlTwd);
  grid.append(chartCard("未實現損益排行", divergingBars({
    names: ranked.map((h) => h.name || h.symbol),
    values: ranked.map((h) => h.pnlTwd),
    label: "未實現損益 (TWD)",
    sub: ranked.map((h) => `${h.symbol}　${signedPct(h.roi)}　市值 ${money(h.valueTwd)}`
      + (h.brokers.length > 1 ? `　（${h.brokers.length} 家券商合計）` : "")),
  }), {
    span: "half",
    height: barRows(ranked.length, { min: 380 }),
    note: "正負由左右方向表示，金額直接標在棒子末端，顏色只是輔助。"
      + "同一檔在多家券商的部位已合併。",
  }));

  // -------------------------------------------------------------- bubble ---
  const bubbleGroups = groupByBroker(d, live.filter((h) => isNum(h.roi)))
    .map((g) => ({
      name: g.name,
      points: g.children.map((c) => ({
        x: c.roi, y: c.cost, r: c.value, name: c.name, sub: c.sub,
      })),
    }));
  if (bubbleGroups.length) {
    grid.append(chartCard("部位大小 vs 報酬率", bubble({
      // Scatter is an all-pairs form: any two bubbles can end up adjacent, and
      // only the first three categorical slots clear the colour gates for that.
      // Three brokers is exactly the budget; a fourth would have to fold.
      groups: bubbleGroups.slice(0, 3),
    }), {
      span: "half",
      chartClass: "chart tall",
      note: "泡泡大小是市值。左下角是小賠的小部位；左上角是「賠錢又押得重」，"
        + "那是這張圖真正要抓的風險點。"
        + "這裡按券商分色，所以同一檔股票在兩家券商會是兩個泡泡。",
    }));
  }

  // --------------------------------------------------------------- table ---
  const maxValue = Math.max(...d.holdings.map((h) => h.valueTwd), 1);
  const maxPnl = Math.max(...d.holdings.map((h) => Math.abs(h.pnlTwd)), 1);
  const tableCard = card("全部持股", {
    span: "span-12",
    note: t.delisted
      ? `含 ${t.delisted} 檔已下市（名稱空白、股價 0、報酬率 −100%）。`
        + "試算表的 summary 會把這些列丟掉，所以它的總市值與這裡對不上。"
      : undefined,
  });
  tableCard.append(table([
    { key: "symbol", label: "代號", align: "left" },
    {
      key: "name", label: "名稱", align: "left",
      fmt: (v, r) => (r.delisted
        ? el("span", { class: "cell-flag" }, [v || "(空白)", chip("已下市", "flag")])
        : v || DASH),
    },
    { key: "broker", label: "券商", align: "left", fmt: (_v, r) => brokerLabel(d, r.broker) },
    { key: "qty", label: "股數", fmt: (v) => shareText(v) },
    { key: "avgCost", label: "成本均價", fmt: (v, r) => priceText(v, r.currency) },
    { key: "price", label: "現價", fmt: (v, r) => priceText(v, r.currency) },
    { key: "costTwd", label: "成本 (TWD)", fmt: (v) => money(v) },
    { key: "valueTwd", label: "市值 (TWD)", fmt: (v) => barCell(v, maxValue, (x) => money(x)) },
    {
      key: "pnlTwd", label: "未實現損益 (TWD)",
      fmt: (v) => barCell(v, maxPnl, (x) => signedMoney(x)),
    },
    { key: "roi", label: "報酬率", fmt: (v) => signedPct(v), cls: (r) => tone(r.roi) },
    { key: "weight", label: "佔持股", fmt: (v) => shareCell(v) },
  ], d.holdings, { sortKey: "valueTwd", scroll: true }));
  tableCard.append(footnote(
    "券商分頁一律是原幣；「(TWD)」的欄位由本站以最新匯率換算，"
    + `目前用 ${d.rate ? d.rate.toFixed(4) : DASH}。`,
  ));
  grid.append(tableCard);

  return grid;
}

/** Holdings grouped by broker, in the fixed broker order so hues never move. */
function groupByBroker(d, holdings) {
  return d.brokers
    .map((b) => ({
      name: b.label,
      children: holdings
        .filter((h) => h.broker === b.broker)
        .map((h) => ({
          name: h.name || h.symbol,
          // What the treemap prints inside the tile - always fits, unlike a
          // fund's full name.
          short: h.symbol,
          value: h.valueTwd,
          cost: h.costTwd,
          roi: h.roi ?? 0,
          sub: `${h.symbol}　${signedPct(h.roi)}`,
        })),
    }))
    .filter((g) => g.children.length);
}

const brokerLabel = (d, broker) =>
  d.brokers.find((b) => b.broker === broker)?.label ?? broker;

function splitLabel(live) {
  const tw = live.filter((h) => h.market === "TW").reduce((a, h) => a + h.valueTwd, 0);
  const us = live.filter((h) => h.market === "US").reduce((a, h) => a + h.valueTwd, 0);
  const total = tw + us;
  return total ? `${pct(tw / total, 0)} / ${pct(us / total, 0)}` : DASH;
}
