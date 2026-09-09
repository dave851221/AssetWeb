// 損益 - realized profit, dividend income, and what the trading cost.
//
// The workbook aggregates realized P&L per (symbol, year), not per trade, so
// the finest grain available here is a year. Rebuilding it per trade means
// recomputing FIFO from the trades sheet, which is a later phase - nothing on
// this page pretends to a resolution it does not have.
//
// Dividend income is cash only. A stock dividend is recorded upstream as a
// share count with no monetary value, deliberately, so that summing the cash
// column can never double-count - and so nothing here adds 配股 in as income.

import {
  el, card, table, money, signedMoney, pct, signedPct, isNum, chip, groupBy, DASH,
} from "../util.js";
import { derive } from "../model.js";
import { yearColumns, timeLine, divergingBars, barRows, mount } from "../charts.js";
import { tile, tileRow, chartCard, barCell, footnote } from "./parts.js";

/** @typedef {import('../types.js').Model} Model */

const tone = (v) => (isNum(v) && v !== 0 ? (v > 0 ? "up" : "down") : "");

/** @param {Model} m @param {any} [_arg] */
export function render(m, _arg) {
  const d = derive(m);
  const grid = el("div", { class: "grid" });
  const t = d.totals;
  const years = d.byYear;

  const costAll = years.reduce((a, y) => a + y.fee + y.tax, 0);
  const turnoverAll = years.reduce((a, y) => a + y.turnover, 0);

  // ------------------------------------------------------------- the stats ---
  grid.append(el("section", { class: "card span-12 flush" }, tileRow([
    tile({
      label: "已實現損益（累計）", value: signedMoney(t.realizedAll),
      tone: t.realizedAll >= 0 ? "up" : "down",
      sub: "2024 年起",
    }),
    tile({
      label: "除權息收入（累計）", value: money(t.dividendsAll),
      sub: "只含現金，不含配股",
    }),
    tile({
      label: `${t.year} 年已實現`, value: signedMoney(t.realizedYtd),
      tone: t.realizedYtd >= 0 ? "up" : "down",
    }),
    tile({
      label: `${t.year} 年除權息`, value: money(t.dividendsYtd),
    }),
    tile({
      label: "交易成本（累計）", value: money(costAll),
      deltaText: turnoverAll ? `佔成交額 ${pct(costAll / turnoverAll, 3)}` : undefined,
      sub: "手續費 + 交易稅",
    }),
  ])));

  if (t.pending) {
    grid.append(card("有成本待補的賣出", {
      span: "span-12",
      note: `${t.pending} 筆賣出的 FIFO 成本尚未解出，AssetSync 在該欄寫了`
        + "「請填入 cost_override.json」。這些筆的損益不計入上面的累計值，"
        + "所以實際數字會比顯示的更高或更低。",
      warn: true,
    }));
  }

  // ------------------------------------------------------- yearly columns ---
  if (years.length) {
    grid.append(chartCard("年度損益", yearColumns({
      years: years.map((y) => y.year),
      series: [
        { name: "已實現損益", values: years.map((y) => y.realized) },
        { name: "除權息收入", values: years.map((y) => y.dividends) },
      ],
    }), {
      span: "half",
      note: "堆疊起來就是那一年的實現總收益。未實現損益不在這裡——"
        + "它沒有年度歸屬，只有現在這一刻的值。",
    }));

    // Cumulative, at the only grain the data supports.
    let run = 0;
    const cum = years.map((y) => (run += y.total));
    grid.append(chartCard("累積實現收益", timeLine({
      days: years.map((y) => String(y.year)),
      values: cum,
      label: "累積已實現 + 除權息",
    }), {
      span: "half",
      note: "以年為單位：試算表的已實現損益是「每檔每年」彙總的，沒有逐筆日期。",
    }));
  }

  // ------------------------------------------------------ by symbol bars ---
  const bySymbol = [...groupBy(m.realized, (r) => r.symbol)]
    .map(([symbol, rows]) => ({
      symbol,
      name: rows.find((r) => r.name)?.name || symbol,
      pnl: rows.reduce((a, r) => a + (r.pnl === null ? 0 : convert(r, d.rate)), 0),
      qty: rows.reduce((a, r) => a + (r.qty ?? 0), 0),
      years: [...new Set(rows.map((r) => r.year))].sort(),
      pending: rows.some((r) => r.pending),
    }))
    .filter((r) => r.pnl !== 0)
    .sort((a, b) => b.pnl - a.pnl);

  if (bySymbol.length) {
    grid.append(chartCard("個股歷年已實現損益", divergingBars({
      names: bySymbol.map((r) => r.name),
      values: bySymbol.map((r) => r.pnl),
      label: "已實現損益 (TWD)",
      sub: bySymbol.map((r) => `${r.symbol}　${r.years.join("、")} 年　賣出 ${r.qty} 股`),
    }), {
      span: "span-12",
      height: barRows(bySymbol.length),
    }));
  }

  // ---------------------------------------------------------- trade costs ---
  if (years.length) {
    grid.append(chartCard("交易成本", yearColumns({
      years: years.map((y) => y.year),
      series: [
        { name: "手續費", values: years.map((y) => y.fee) },
        { name: "交易稅", values: years.map((y) => y.tax) },
      ],
      fmt: (v) => money(v),
    }), {
      span: "half",
      note: "富邦的手續費與交易稅是按標準費率估算的（0.1425%、NT$20 下限），"
        + "永豐與 IBKR 是實際扣款金額——試算表沒有標記哪個是哪個，這裡也無法分辨。",
    }));

    const costCard = card("各年度明細", { span: "half" });
    const maxTurnover = Math.max(...years.map((y) => y.turnover), 1);
    costCard.append(table([
      { key: "year", label: "年度", align: "left" },
      { key: "trades", label: "交易筆數" },
      { key: "turnover", label: "成交額", fmt: (v) => barCell(v, maxTurnover, (x) => money(x)) },
      { key: "fee", label: "手續費", fmt: (v) => money(v) },
      { key: "tax", label: "交易稅", fmt: (v) => money(v) },
      {
        key: "costRate", label: "成本佔比",
        value: (r) => (r.turnover ? (r.fee + r.tax) / r.turnover : null),
        fmt: (_v, r) => (r.turnover ? pct((r.fee + r.tax) / r.turnover, 3) : DASH),
      },
      { key: "realized", label: "已實現", fmt: (v) => signedMoney(v), cls: (r) => tone(r.realized) },
    ], years, { sortKey: "year" }));
    grid.append(costCard);
  }

  // ------------------------------------------------------------ dividends ---
  const divs = d.dividendBySymbol.filter((r) => r.cash > 0);
  if (divs.length) {
    const divCard = card("除權息", { span: "half" });
    const maxCash = Math.max(...divs.map((r) => r.cash), 1);
    divCard.append(table([
      { key: "symbol", label: "代號", align: "left" },
      { key: "name", label: "名稱", align: "left" },
      { key: "cash", label: "累計配息", fmt: (v) => barCell(v, maxCash, (x) => money(x)) },
      { key: "cost", label: "目前持有成本", fmt: (v) => (v > 0 ? money(v) : DASH) },
      {
        key: "yieldPct", label: "配息 ÷ 成本", fmt: (v) => pct(v, 2),
        title: "以目前持有成本為分母的累計配息比率，不是年化殖利率",
      },
    ], divs, { sortKey: "cash", scroll: true }));
    divCard.append(footnote(
      "「配息 ÷ 成本」是累計金額除以目前成本，不是年化殖利率："
      + "分子橫跨數年，分母只是現在的部位，已經賣掉的部分不在分母裡。",
    ));
    grid.append(divCard);
  }

  // ------------------------------------------------------- realized table ---
  const realizedRows = m.realized.map((r) => ({
    ...r,
    pnlTwd: r.pnl === null ? null : convert(r, d.rate),
  }));
  const realizedCard = card("已實現損益明細", { span: "span-12" });
  realizedCard.append(table([
    { key: "year", label: "年度" },
    { key: "symbol", label: "代號", align: "left" },
    { key: "name", label: "名稱", align: "left" },
    { key: "qty", label: "賣出數量", fmt: (v) => (isNum(v) ? v.toLocaleString("zh-TW") : DASH) },
    { key: "proceeds", label: "賣出金額", fmt: (v, r) => money(v, r.currency) },
    { key: "cost", label: "成本", fmt: (v, r) => money(v, r.currency) },
    { key: "feeTax", label: "費用+稅", fmt: (v, r) => money(v, r.currency) },
    {
      key: "pnlTwd", label: "損益 (TWD)",
      fmt: (v, r) => (r.pending ? chip("成本待補", "flag") : signedMoney(v)),
      cls: (r) => tone(r.pnlTwd),
    },
    { key: "roi", label: "報酬率", fmt: (v) => signedPct(v), cls: (r) => tone(r.roi) },
  ], realizedRows, { sortKey: "year", scroll: true }));
  grid.append(realizedCard);

  return grid;
}

/** A realized row's P&L in TWD. */
const convert = (r, rate) => (r.currency === "USD" ? (r.pnl ?? 0) * rate : (r.pnl ?? 0));

export { mount };
