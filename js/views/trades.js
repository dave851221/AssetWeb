// 交易明細 - every order, searchable, with a per-stock read-out.
//
// "Look up one stock and see every price I bought and sold at" - as a table, as
// stat tiles, and as a candlestick chart with each order marked at the price it
// filled at, which is the view an actual review needs.
//
// The candles come from an external API, so that card is the one thing here
// that can fail. It degrades in place: a dot plot of the same fills, drawn from
// data already in the workbook, plus a sentence saying what could not be
// loaded. Nothing about the page depends on the network succeeding.
//
// The per-stock summary only appears once the filter narrows to a single
// symbol. Averaged across every stock those numbers would be meaningless, and a
// meaningless number in a stat tile is worse than an empty panel.

import {
  el, card, table, money, priceText, signedMoney, pct, signedPct, isNum, chip,
  clear, navigate, shares, DASH,
} from "../util.js";
import { derive } from "../model.js";
import { splitFactor, adjustedQty } from "../parse/adjustments.js";
import { pricePoints, candles, disposeIn, mount, compact } from "../charts.js";
import {
  daily, sma, findBreaks, corporateActions, shareFactor, alignTrades,
  MarketError, getToken, setToken,
} from "../market.js";
import { tile, tileRow, footnote, retile } from "./parts.js";

/** @typedef {import('../types.js').Model} Model */
/** @typedef {import('../types.js').Trade} Trade */

const tone = (v) => (isNum(v) && v !== 0 ? (v > 0 ? "up" : "down") : "");
const shareText = (v) => (isNum(v) ? v.toLocaleString("zh-TW", { maximumFractionDigits: 4 }) : DASH);

/**
 * @param {Model} m
 * @param {string} [arg] a symbol to open on, from a chart click elsewhere
 */
export function render(m, arg) {
  const d = derive(m);
  const root = el("div", {});
  let query = typeof arg === "string" ? arg : "";

  const controls = el("div", { class: "filter-row" });
  const body = el("div", { class: "grid" });
  root.append(controls, body);

  // Every symbol that appears in a trade, for the datalist.
  const symbols = [...new Map(m.trades.map((t) => [t.symbol, t.name])).entries()]
    .sort((a, b) => a[0].localeCompare(b[0]));

  const input = /** @type {HTMLInputElement} */ (el("input", {
    type: "search",
    placeholder: "輸入代號或名稱，例如 2330 或 台積電",
    value: query,
    list: "symbol-list",
    oninput: (ev) => {
      query = /** @type {HTMLInputElement} */ (ev.target).value.trim();
      paint();
    },
  }));
  controls.append(
    el("label", {}, [el("span", { text: "查詢個股" }), input]),
    el("datalist", { id: "symbol-list" },
      symbols.map(([sym, name]) => el("option", { value: sym, label: name || sym }))),
    el("button", {
      class: "btn", text: "清除",
      onclick: () => { query = ""; input.value = ""; paint(); },
    }),
  );

  function paint() {
    disposeIn(body);
    clear(body);

    const q = query.toLowerCase();
    const rows = q
      ? m.trades.filter((t) =>
          t.symbol.toLowerCase().includes(q) || (t.name || "").toLowerCase().includes(q))
      : m.trades;

    // One symbol matched: the summary is meaningful, so show it.
    const matched = [...new Set(rows.map((t) => t.symbol))];
    if (matched.length === 1) body.append(...symbolCards(m, d, matched[0], rows));
    else if (rows.length) body.append(overallCard(rows, d));

    const tradesCard = card(
      matched.length === 1 ? `${matched[0]} 交易紀錄` : "交易紀錄",
      {
        span: "span-12",
        note: q && !rows.length
          ? undefined
          : "富邦的手續費與交易稅是按標準費率估算的，永豐與 IBKR 是實際扣款金額。",
      },
    );
    tradesCard.append(table([
      { key: "date", label: "日期", align: "left" },
      {
        key: "side", label: "買賣", align: "left",
        fmt: (v) => chip(v === "buy" ? "買" : "賣", v === "buy" ? "buy" : "sell"),
        value: (r) => r.side,
      },
      { key: "symbol", label: "代號", align: "left" },
      { key: "name", label: "名稱", align: "left", fmt: (v) => v || DASH },
      { key: "broker", label: "券商", align: "left", fmt: (_v, r) => brokerLabel(d, r.broker) },
      { key: "qty", label: "股數", fmt: (v) => shareText(v) },
      { key: "price", label: "成交均價", fmt: (v, r) => priceText(v, r.currency) },
      { key: "amount", label: "成交金額", fmt: (v, r) => money(v, r.currency) },
      { key: "fee", label: "手續費", fmt: (v, r) => money(v, r.currency) },
      { key: "tax", label: "交易稅", fmt: (v, r) => money(v, r.currency) },
      {
        key: "net", label: "實際收付", fmt: (v, r) => signedMoney(v, r.currency),
        cls: (r) => tone(r.net),
      },
    ], rows, {
      sortKey: "date", sortDir: "desc", scroll: true,
      empty: q ? `找不到「${query}」的交易紀錄` : "沒有交易紀錄",
    }));
    body.append(tradesCard);
  }

  paint();
  return root;
}

/**
 * The read-out for one stock: what was paid, what was sold, what is left.
 *
 * Buy and sell averages are share-weighted, which is the only average that
 * means anything here - a plain mean over orders would let a 100-share trade
 * count as much as a 10,000-share one.
 */
function symbolCards(m, d, symbol, rows) {
  const buys = rows.filter((t) => t.side === "buy");
  const sells = rows.filter((t) => t.side === "sell");
  const name = rows.find((t) => t.name)?.name || symbol;
  const currency = rows[0]?.currency ?? "TWD";

  const buyQty = sum(buys, (t) => t.qty);
  const sellQty = sum(sells, (t) => t.qty);
  const buyAmount = sum(buys, (t) => t.amount);
  const sellAmount = sum(sells, (t) => t.amount);

  const held = d.holdings.filter((h) => h.symbol === symbol);
  const heldQty = sum(held, (h) => h.qty);
  const heldValue = sum(held, (h) => h.valueTwd);
  const heldPnl = sum(held, (h) => h.pnlTwd);
  const price = held.find((h) => isNum(h.price))?.price ?? null;

  // Share-weighted across accounts, not the first one that happens to have a
  // number. The same ETF can sit at two brokers with different bases and very
  // different share counts, and taking either alone misstates the merged
  // position - by a lot, when one account holds most of it.
  const costed = held.filter((h) => isNum(h.avgCost) && h.qty);
  const avgCost = costed.length
    ? sum(costed, (h) => h.qty * (h.avgCost ?? 0)) / sum(costed, (h) => h.qty)
    : null;

  const realized = m.realized.filter((r) => r.symbol === symbol);
  const realizedPnl = sum(realized, (r) => toTwd(r.pnl, r.currency, d.rate));
  const dividends = sum(
    m.dividends.filter((x) => x.symbol === symbol), (x) => toTwd(x.cash, x.currency, d.rate));

  // Deliberately blank until the corporate-action check lands. The formula is
  // 累計金額 ÷ 累計股數, and the numerator is fine - money is a split
  // invariant - but the denominator is not: the sheet records each fill's
  // share count in that day's units, so a split inside the window sums two
  // different units. Showing the unadjusted figure first and correcting it a
  // moment later would just be a wrong number with a short lifespan.
  const buyAvgTile = tile({
    label: "歷史買入均價", value: DASH, sub: "確認股票分割中…",
  });
  const sellAvgTile = tile({
    label: "歷史賣出均價",
    value: DASH, sub: sellQty ? "確認股票分割中…" : "尚未賣出",
  });

  const cards = [];

  const stats = el("section", { class: "card span-12 flush" }, tileRow([
    tile({
      label: "目前持有", value: shareText(heldQty),
      sub: heldQty ? `市值 ${money(heldValue)}` : "已全部賣出",
    }),
    tile({
      label: "目前成本均價", value: priceText(avgCost, currency),
      sub: costed.length > 1 ? `${costed.length} 家券商股數加權` : "券商的 FIFO 成本",
    }),
    tile({
      label: "現價", value: priceText(price, currency),
      // The one comparison a decision actually rests on: is the market above
      // or below what the shares still held cost?
      deltaText: isNum(price) && isNum(avgCost) && avgCost
        ? `較成本均價 ${signedPct((price - avgCost) / avgCost)}`
        : undefined,
      tone: isNum(price) && isNum(avgCost) ? (price >= avgCost ? "up" : "down") : "",
    }),
    // Money is a split invariant, so these two are always right.
    tile({
      label: "累計買入", value: money(buyAmount, currency),
      sub: `${buys.length} 筆 · ${shareText(buyQty)} 股`,
    }),
    tile({
      label: "累計賣出", value: sellQty ? money(sellAmount, currency) : DASH,
      sub: sellQty ? `${sells.length} 筆 · ${shareText(sellQty)} 股` : "尚未賣出",
    }),
    // Total money over total shares - the only correct way to average a price,
    // never a mean of the price column. But the DENOMINATOR is the catch: the
    // sheet records each fill's share count in that day's units, so a split
    // inside the window sums two different units and the average comes out
    // wrong however carefully the numerator is weighted. Whether that happened
    // is decided by the price series, which arrives with the chart below - so
    // these two tiles are withdrawn by `onBreaks` when it does.
    buyAvgTile,
    sellAvgTile,
    tile({
      label: "未實現損益", value: heldQty ? signedMoney(heldPnl) : DASH,
      tone: heldQty ? (heldPnl >= 0 ? "up" : "down") : "",
    }),
    tile({
      label: "已實現 + 除權息", value: signedMoney(realizedPnl + dividends),
      tone: realizedPnl + dividends >= 0 ? "up" : "down",
      sub: `已實現 ${compact(realizedPnl)} · 配息 ${compact(dividends)}`,
    }),
  ]));
  cards.push(stats);

  // Buys minus sells does not have to equal what is held, and the workbook now
  // says exactly why: the `adjustments` sheet lists every share movement that
  // is not a trade. So this names them rather than offering a list of possible
  // causes and leaving the reader to guess which applied.
  const myAdj = m.adjustments.filter((a) => a.symbol === symbol);
  const netAdjusted = sum(buys, (t) => t.qty * splitFactor(m.adjustments, symbol, t.date))
    - sum(sells, (t) => t.qty * splitFactor(m.adjustments, symbol, t.date));
  const adjQty = sum(myAdj, (a) => adjustedQty(m.adjustments, a));
  const notes = [];

  if (heldQty && Math.abs(netAdjusted + adjQty - heldQty) > 0.01) {
    // The identity should close exactly. If it does not, something is missing
    // upstream - say so plainly rather than papering over it.
    notes.push(
      `交易紀錄還原後是 ${shareText(netAdjusted)} 股、非交易異動 ${shareText(adjQty)} 股，`
      + `合計 ${shareText(netAdjusted + adjQty)} 股，但券商庫存是 ${shareText(heldQty)} 股。`
      + "差額無法由試算表現有資料解釋，可能有未記錄的股數異動。",
    );
  } else if (adjQty) {
    const detail = myAdj
      .filter((a) => a.qty !== null)
      .map((a) => `${a.date} ${a.kindLabel} ${adjustedQty(m.adjustments, a) >= 0 ? "+" : ""}`
        + `${shareText(adjustedQty(m.adjustments, a))} 股`)
      .join("、");
    notes.push(
      `交易紀錄的淨股數是 ${shareText(netAdjusted)} 股，目前持有 ${shareText(heldQty)} 股，`
      + `差額 ${shareText(adjQty)} 股來自：${detail}。`
      + "（這些都不是買賣，所以不在交易紀錄裡，也不影響買入均價。）",
    );
    // The sheet's own explanation is usually the most informative thing on the
    // page - it says where the shares came from and how the count was derived.
    for (const a of myAdj) {
      // Splits are covered by their own paragraph below, in more useful terms.
      if (a.kind !== "split" && a.note) notes.push(`${a.date} ${a.kindLabel}：${a.note}`);
    }
  }

  const splitsHere = myAdj.filter((a) => a.kind === "split");
  if (splitsHere.length) {
    notes.push(
      `這檔在 ${splitsHere.map((a) => `${a.date}（1 拆 ${a.ratio}）`).join("、")}有股票分割。`
      + "分割前的交易列是用當時的股數記錄的，所以計算均價時已先乘上比例還原成今日單位；"
      + "K 線圖上的價格則保持原始價，標記直接落在成交價上。",
    );
  }

  if (notes.length) {
    const noteCard = card("數字對不上？這是原因", { span: "span-12", warn: true });
    for (const text of notes) noteCard.append(el("p", { class: "card-note", text }));
    cards.push(noteCard);
  }

  // ------------------------------------------------------- the review chart ---

  /**
   * Fill in the two per-share averages once the share history is known.
   *
   * The formula is 累計金額 ÷ 累計股數 and the numerator was never the problem -
   * money is a split invariant. The denominator is: the sheet records each
   * fill's quantity in that day's units, so every quantity is scaled into
   * today's units before the division. All this needs is the multiplier, and
   * the sources for it are ranked below.
   *
   * @param {{actions: any[], authoritative: boolean}} ca FinMind's split data
   * @param {Map<string, number>} factorByKey per-fill multiplier from alignment
   */
  const settleAverages = (ca, factorByKey) => {
    const key = (o) => `${o.date}|${o.orderNo}|${o.price}`;

    /**
     * Three sources for the share multiplier, and exactly one is used per
     * symbol so that a split known to two of them is never applied twice:
     *
     *  1. **The workbook's own `adjustments` sheet.** AssetSync records the
     *     ratio it actually used, and it covers US symbols too - which is why
     *     IBKR's 4:1 no longer has to be inferred from anything.
     *  2. **Taiwan's official split reference prices** from FinMind, whose
     *     before/after quotient is exact (00631L: 443.15/20.14 = 22.003).
     *     Needed because AssetSync only tracks the splits its own FIFO
     *     required, and a position closed before its split - 00631L - is
     *     absent from the sheet.
     *  3. **Per-fill alignment** against that day's high/low, the only option
     *     left for a US symbol the sheet does not cover.
     */
    const sheetSplits = m.adjustments.some((a) => a.kind === "split" && a.symbol === symbol);
    const source = sheetSplits
      ? "試算表的 adjustments 分頁"
      : ca.authoritative ? "官方分割資料" : "比對當日行情推得";
    const factorOf = (o) => {
      if (sheetSplits) return splitFactor(m.adjustments, symbol, o.date);
      if (ca.authoritative) return shareFactor(o.date, ca.actions);
      return factorByKey.get(key(o)) ?? 1;
    };

    const show = (node, rows, amount, note) => {
      if (!rows.length) return;
      let qty = 0;
      for (const o of rows) {
        const f = factorOf(o);
        // null means a capital reduction stands in the way, and its share
        // ratio is not recoverable from a reference price that also absorbs
        // cash returned to shareholders.
        if (f === null) {
          retile(node, { value: DASH, sub: "股數單位無法還原（減資）" });
          return;
        }
        qty += o.qty * f;
      }
      if (!qty) return;
      retile(node, { value: priceText(amount / qty, currency), sub: note });
    };

    const restated = buys.concat(sells).some((o) => factorOf(o) !== 1);
    const note = restated
      ? `已還原成今日股數（${source}）`
      : "累計金額 ÷ 累計股數";
    show(buyAvgTile, buys, buyAmount, note);
    show(sellAvgTile, sells, sellAmount, note);
  };

  cards.push(candleCard({
    name, symbol, buys, sells, avgCost, price, currency, settleAverages,
  }));

  if (realized.length) {
    const rCard = card(`${name} 已實現損益`, { span: "span-12" });
    rCard.append(table([
      { key: "year", label: "年度" },
      { key: "qty", label: "賣出數量", fmt: (v) => shareText(v) },
      { key: "proceeds", label: "賣出金額", fmt: (v, r) => money(v, r.currency) },
      { key: "cost", label: "成本", fmt: (v, r) => money(v, r.currency) },
      { key: "feeTax", label: "費用+稅", fmt: (v, r) => money(v, r.currency) },
      {
        key: "pnl", label: "已實現損益",
        fmt: (v, r) => (r.pending ? chip("成本待補", "flag") : signedMoney(v, r.currency)),
        cls: (r) => tone(r.pnl),
      },
      { key: "roi", label: "報酬率", fmt: (v) => signedPct(v), cls: (r) => tone(r.roi) },
    ], realized, { sortKey: "year" }));
    rCard.append(footnote("試算表把已實現損益按「每檔每年」彙總，所以沒有逐筆配對。"));
    cards.push(rCard);
  }

  return cards;
}


/**
 * The candlestick review card, which loads its own data.
 *
 * Built and returned synchronously with a loading state, then filled in when
 * the fetch lands - the view cannot be async, because the shell appends what
 * render() returns straight away.
 *
 * Every failure path ends in the same place: the dot plot of the same orders,
 * drawn from the workbook alone. A chart that cannot reach the internet is
 * still allowed to show what the spreadsheet knows.
 */
function candleCard({ name, symbol, buys, sells, avgCost, price, currency, settleAverages }) {
  const market = currency === "USD" ? "US" : "TW";
  const node = card(`${name} K線覆盤`, {
    span: "span-12",
    note: "每個三角形是一筆成交，畫在當天 K 棒上「實際成交的那個價位」——"
      + "紅色向上是買進、綠色向下是賣出，大小是股數。"
      + "重點不是「那天有沒有交易」，而是「在那天的振幅裡買在哪個位置」。"
      + "可以用下方的縮放軸拉開區間。",
  });

  const host = el("div", { class: "chart-load" },
    el("div", { class: "loading", text: "載入歷史股價…" }));
  node.append(host);

  // Sixty days of run-up before the first order, so the first buy has context
  // rather than sitting on the left edge.
  const first = [...buys, ...sells].reduce((a, o) => (o.date < a ? o.date : a),
    [...buys, ...sells][0]?.date ?? "");
  const from = first ? shiftDays(first, -60) : shiftDays(today(), -365);

  Promise.all([
    daily(symbol, market, { from, to: today() }),
    // Never lets the chart fail: an unavailable action list only costs the
    // exact ratio on the label and sends the averages down the cautious path.
    corporateActions(symbol, market).catch(() => ({ actions: [], authoritative: false })),
  ])
    .then(([{ rows, source, cached }, ca]) => {
      // The view may have been torn down while the request was in flight.
      if (!node.isConnected) return;
      const ma = [5, 20, 60]
        // A 60-day average over 40 bars is a line of nulls.
        .filter((n) => rows.length >= n)
        .map((n) => ({ n, values: sma(rows, n) }));
      const priceBreaks = findBreaks(rows);
      // Put every fill into the price series' own units before anything is
      // plotted. Taiwan needs no conversion; every US symbol with a split does.
      const all = [...buys, ...sells];
      const { aligned, converted, unmatched } = alignTrades(rows, all);
      const byKey = new Map(aligned.map((o) => [`${o.date}|${o.orderNo}|${o.price}`, o]));
      const withPlot = (rows_) => rows_.map((o) =>
        byKey.get(`${o.date}|${o.orderNo}|${o.price}`) ?? { ...o, plotPrice: o.price, factor: 1 });
      const factorByKey = new Map(aligned.map((o) => [`${o.date}|${o.orderNo}|${o.price}`, o.factor]));
      if (settleAverages) settleAverages(ca, factorByKey);

      // With the official ratio the line can say what happened; without it, it
      // can only say where.
      const marks = ca.authoritative
        ? ca.actions.map((a) => ({
            date: a.date,
            label: a.factor ? `1 拆 ${round1(a.factor)}` : "減資",
          }))
        : priceBreaks.map((b) => ({ date: b.date, label: "價格不連續" }));

      host.remove();
      node.append(mount(node, candles({
        rows, buys: withPlot(buys), sells: withPlot(sells),
        ma, avgCost, currency, marks,
      }), { class: "chart candles" }));
      node.append(footnote(
        `股價來源：${source}${cached ? "（本機快取）" : ""}。`
        + (converted
          ? "這檔的行情是還原價，與交易紀錄的原始成交價單位不同，"
            + "買賣標記已按當日行情區間換算後才畫上去（tooltip 顯示的仍是實際成交價）。"
          : "價格與交易紀錄同樣是當時的原始價格，標記直接畫在成交價上。")
        + (unmatched
          ? `　有 ${unmatched} 筆成交落在當日行情區間外（零股交易的價格可能落在盤中區間之外），`
            + "已按原價標示。"
          : "")
        + (marks.length
          ? `　${ca.authoritative
              ? `官方分割/減資資料 ${marks.length} 筆`
              : `偵測到 ${marks.length} 處價格不連續（單日超過 35%，必為分割或減資）`}，已在圖上標線。`
          : ""),
      ));
    })
    .catch((err) => {
      if (!node.isConnected) return;
      host.remove();
      node.append(fallbackChart(node, { symbol, buys, sells, avgCost, price, currency }, err));
    });

  return node;
}

/** What the card shows when prices cannot be fetched. */
function fallbackChart(node, { symbol, buys, sells, avgCost, price, currency }, err) {
  const wrap = el("div", {});
  const rateLimited = err instanceof MarketError && err.kind === "rate-limit";
  wrap.append(el("p", {
    class: "card-note warn",
    text: `抓不到歷史股價（${err instanceof Error ? err.message : String(err)}），`
      + "以下改用交易紀錄自己畫的成交價點圖。",
  }));
  if (rateLimited) wrap.append(tokenRow(symbol));
  wrap.append(mount(node, pricePoints({ buys, sells, costAvg: avgCost, price, currency }),
    { class: "chart tall" }));
  return wrap;
}

/**
 * The escape hatch for a spent anonymous quota.
 *
 * Offered only when that is actually what happened - a token box on a working
 * page is clutter, and on a network error it would be a red herring.
 */
function tokenRow(symbol) {
  const input = /** @type {HTMLInputElement} */ (el("input", {
    type: "text", placeholder: "貼上 FinMind token（存在瀏覽器，不會進 repo）",
    value: getToken(),
  }));
  return el("div", { class: "filter-row" }, [
    el("label", {}, [el("span", { text: "FinMind token" }), input]),
    el("button", {
      class: "btn", text: "儲存並重試",
      // Re-enter the same stock rather than the bare tab, so a retry lands
      // back where the user was.
      onclick: () => { setToken(input.value.trim()); navigate("trades", symbol); },
    }),
  ]);
}

const today = () => new Date().toISOString().slice(0, 10);

/** 4.0002 reads as 4, 22.0035 as 22 - the ratio is always a whole number. */
const round1 = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : v.toFixed(2));

function shiftDays(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Aggregate stats when the filter is wide - counts and turnover, not averages. */
function overallCard(rows, d) {
  const buys = rows.filter((t) => t.side === "buy");
  const sells = rows.filter((t) => t.side === "sell");
  const turnover = sum(rows, (t) => toTwd(t.amount, t.currency, d.rate));
  const cost = sum(rows, (t) => toTwd(t.fee + t.tax, t.currency, d.rate));
  const symbols = new Set(rows.map((t) => t.symbol)).size;
  const first = rows.reduce((a, t) => (t.date < a ? t.date : a), rows[0].date);
  const last = rows.reduce((a, t) => (t.date > a ? t.date : a), rows[0].date);

  return el("section", { class: "card span-12 flush" }, tileRow([
    tile({ label: "交易筆數", value: rows.length.toLocaleString("zh-TW"),
      sub: `${buys.length} 買 · ${sells.length} 賣` }),
    tile({ label: "涉及檔數", value: String(symbols) }),
    tile({ label: "累計成交額", value: money(turnover) }),
    tile({ label: "累計交易成本", value: money(cost),
      deltaText: turnover ? pct(cost / turnover, 3) : undefined }),
    tile({ label: "期間", value: last, sub: `自 ${first}` }),
  ]));
}

const sum = (rows, f) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
const toTwd = (v, currency, rate) =>
  v === null || v === undefined ? 0 : currency === "USD" ? v * rate : v;
const brokerLabel = (d, broker) =>
  d.brokers.find((b) => b.broker === broker)?.label ?? broker;
