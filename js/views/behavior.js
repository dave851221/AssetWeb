// 行為分析 - what the trading record says about how it was traded.
//
// Everything on this page rests on `fifo.js`, which rebuilds the individual
// buy-sell pairs the workbook never stores: AssetSync aggregates realized P&L
// per (broker, year, symbol), and no behavioural question survives that grain.
// The self-test board checks those pairs back against the sheet's own totals,
// so a number here that disagrees with 損益 is a failure that gets caught
// rather than a discrepancy the reader has to find.
//
// ## What this page deliberately does not do
//
// No IRR, no XIRR, no "growth split into contributions and returns". The
// trades sheet records cash moving *inside* a brokerage account, and real
// deposits and withdrawals are not in the workbook at all - see model.js's
// header. Every figure here is about the trades themselves, which is a
// question the data can actually answer.
//
// ## Share units, everywhere
//
// A share before a split is not a share after one. `fifo.js` restates every
// quantity into today's units before matching, which is what makes
// `qty x today's price` a legitimate what-if further down this file. Amounts
// need no restatement - money is a split invariant - so anything expressed in
// dollars is safe by construction and anything expressed in shares is not.
//
// ## The three price-fed cards
//
// 買點品質, 賣出之後呢 and vs 0050 need historical quotes, so they load from
// FinMind and fill in when they land. They share ONE fetch pass over the
// symbols that were actually traded, and everything goes through `daily()`,
// which caches per symbol in localStorage and only tops up the missing tail -
// the free tier is small enough that a re-fetch per visit would spend it.
//
// Each of them degrades on its own: a symbol whose prices cannot be fetched is
// dropped from that card and counted in its footnote, never silently averaged
// away.
//
// ## Every chart fits its card
//
// Nothing here scrolls sideways. Distributions are horizontal bars rather than
// columns for exactly that reason - nine bucket labels along a bottom axis need
// about 500px before they stop colliding, and the alternatives at phone width
// are all worse than turning the chart on its side and letting it grow down.

import {
  el, card, table, money, priceText, signedMoney, pct, signedPct, isNum, int,
  clear, groupBy, navigate, DASH,
} from "../util.js";
import { derive, twd } from "../model.js";
import {
  match as fifoMatch, stats as fifoStats, histogram, addOns, sellFollowUps,
} from "../fifo.js";
import { splitFactor } from "../parse/adjustments.js";
import {
  distribution, scatterXY, heatmap, divergingBars, barRows, disposeIn, mount, compact,
} from "../charts.js";
import {
  daily, alignTrades, findBreaks, corporateActions, shareFactor,
  MarketError, getToken, setToken,
} from "../market.js";
import { tile, tileRow, chartCard, chartName, footnote } from "./parts.js";

/** @typedef {import('../types.js').Model} Model */
/** @typedef {import('../types.js').Trade} Trade */
/** @typedef {import('../fifo.js').FifoPair} FifoPair */

const tone = (v) => (isNum(v) && v !== 0 ? (v > 0 ? "up" : "down") : "");
const shareText = (v) => (isNum(v) ? v.toLocaleString("zh-TW", { maximumFractionDigits: 4 }) : DASH);
const days = (v) => (isNum(v) ? `${int(Math.round(v))} 天` : DASH);

const today = () => new Date().toISOString().slice(0, 10);
function shiftDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The benchmark. Taiwan's broadest, cheapest index ETF - the honest "do nothing" option. */
const BENCH = "0050";

// Bucket edges and their labels, defined together so an edge can never drift
// away from the label that describes it.
const ROI_EDGES = [-0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2, 0.5];
const ROI_LABELS = ["< −20%", "−20~−10%", "−10~−5%", "−5~0%",
  "0~+5%", "+5~+10%", "+10~+20%", "+20~+50%", "≥ +50%"];
/** Index of the last losing bucket - where the zero rule goes. */
const ROI_DIVIDER = 3;

const DAY_EDGES = [7, 30, 90, 180, 365, 730];
const DAY_LABELS = ["< 1 週", "1 週~1 個月", "1~3 個月", "3~6 個月",
  "6~12 個月", "1~2 年", "≥ 2 年"];

const PREMIUM_EDGES = [-0.2, -0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1, 0.2];
const PREMIUM_LABELS = ["< −20%", "−20~−10%", "−10~−5%", "−5~−2%", "−2~0%",
  "0~+2%", "+2~+5%", "+5~+10%", "+10~+20%", "≥ +20%"];
const PREMIUM_DIVIDER = 4;

const PCTL_LABELS = ["0–10%", "10–20%", "20–30%", "30–40%", "40–50%",
  "50–60%", "60–70%", "70–80%", "80–90%", "90–100%"];

const WEEKDAYS = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"];
/** Bare numbers on the axis - twelve "1 月".."12 月" need ~320px on their own. */
const MONTHS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
const MONTHS_FULL = MONTHS.map((n) => `${n} 月`);

/**
 * @param {Model} m
 * @param {any} [_arg]
 */
export function render(m, _arg) {
  const d = derive(m);
  const result = fifoMatch(m);
  const grid = el("div", { class: "grid" });
  const pairs = result.pairs;

  if (!pairs.length) {
    grid.append(card("行為分析", {
      span: "span-12",
      note: "還沒有任何完成的買賣配對。這一頁的數字都來自「買進後又賣出」的成對紀錄。",
    }));
    return grid;
  }

  const st = fifoStats(pairs, d.rate);
  const pnlTwd = (p) => twd(p.pnl, p.currency, d.rate) ?? 0;

  // ------------------------------------------------------------- the stats ---
  grid.append(el("section", { class: "card span-12 flush" }, tileRow([
    tile({
      label: "勝率", value: pct(st.winRate, 1),
      sub: `${int(st.wins)} 賺 / ${int(st.losses)} 賠`
        + (st.flat ? ` / ${int(st.flat)} 平` : ""),
      tone: (st.winRate ?? 0) >= 0.5 ? "up" : "down",
    }),
    tile({
      label: "盈虧比", value: isNum(st.payoff) ? st.payoff.toFixed(2) : DASH,
      sub: `平均賺 ${compact(st.avgWin ?? 0)} · 平均賠 ${compact(st.avgLoss ?? 0)}`,
    }),
    tile({
      label: "獲利因子", value: isNum(st.profitFactor) ? st.profitFactor.toFixed(2) : DASH,
      sub: "總獲利 ÷ 總虧損",
    }),
    tile({
      label: "每筆期望值", value: signedMoney(st.expectancy),
      tone: (st.expectancy ?? 0) >= 0 ? "up" : "down",
      sub: `${int(st.count)} 筆配對平均`,
    }),
    tile({
      label: "持有天數中位數", value: days(st.medianDays),
      sub: `平均 ${days(st.meanDays)}`,
    }),
    tile({
      label: "配對總損益", value: signedMoney(st.net),
      tone: st.net >= 0 ? "up" : "down",
      sub: "不含手續費之外的成本",
    }),
  ])));

  grid.append(card("這些數字怎麼來的", {
    span: "span-12",
    note: "損益分頁只有「每檔每年」的彙總，所以這裡用交易紀錄重跑了一次 FIFO，"
      + "每個券商、每檔各自排隊，先買的先賣掉，股數已還原成今日單位。"
      + "配對損益只看價差，不含股息。",
  }));

  if (result.uncovered.length) {
    const detail = result.uncovered
      .map((u) => `${u.symbol}${u.name ? `（${u.name}）` : ""} ${shareText(u.qty)} 股`)
      .join("、");
    grid.append(card("有股數配不到買進成本", {
      span: "span-12",
      warn: true,
      note: `${detail} 是員工持股、券商贈股之類補登進來的，來源資料沒有每股成本。`
        + "本站不會替它們編一個（填 0 會把整筆賣出金額算成獲利），所以這些股數"
        + "不在下面任何一張圖裡，這幾檔的勝率與損益會偏低。",
    }));
  }

  // ----------------------------------------------------- return histogram ---
  const rated = pairs.filter((p) => isNum(p.roi));
  const zeroCost = pairs.length - rated.length;
  const roiCounts = histogram(rated.map((p) => /** @type {number} */ (p.roi)), ROI_EDGES);
  grid.append(chartCard("每筆配對的報酬率分布", distribution({
    names: ROI_LABELS,
    values: roiCounts,
    label: "配對筆數",
    divider: ROI_DIVIDER,
    dividerLabel: "兩平",
    fmt: (v) => `${int(v)} 筆`,
    sub: ROI_LABELS.map(() => "配對筆數"),
  }), {
    span: "half",
    height: barRows(ROI_LABELS.length, { top: 24, min: 220 }),
    note: "虛線以上全是賠錢出場的。報酬率不是年化——抱兩年賺 20% 和抱兩週賺 20% "
      + "在這裡長得一樣，時間看下一張圖。"
      + (zeroCost ? `另有 ${zeroCost} 筆零成本配股未計入。` : ""),
  }));

  // ------------------------------------------------------ holding-day bars ---
  const dayCounts = histogram(pairs.map((p) => p.days), DAY_EDGES);
  grid.append(chartCard("持有天數分布", distribution({
    names: DAY_LABELS,
    values: dayCounts,
    label: "配對筆數",
    fmt: (v) => `${int(v)} 筆`,
    sub: DAY_LABELS.map(() => "配對筆數"),
  }), {
    span: "half",
    height: barRows(DAY_LABELS.length, { top: 24, min: 220 }),
    note: "從買進那批到把它賣掉隔了幾個日曆天，看實際上做的是短線還是長線。"
      + "分批買進時先賣掉的是最早那批，所以最上面的短天期不一定是當沖。",
  }));

  // ------------------------------------------------------- days vs return ---
  // Grouped by broker, in the model's fixed broker order so a hue never moves
  // between this chart and any other. Three is the hard cap for a scatter:
  // it is an all-pairs form and only the first three slots clear the gate.
  const scatterGroups = d.brokers
    .map((b) => ({
      name: b.label,
      points: rated
        .filter((p) => p.broker === b.broker)
        .map((p) => ({
          x: p.days,
          y: /** @type {number} */ (p.roi),
          r: Math.abs(twd(p.cost, p.currency, d.rate) ?? 0),
          name: `${p.name || p.symbol}　${p.buyDate} → ${p.sellDate}`,
          sub: `${shareText(p.qty)} 股　${signedMoney(pnlTwd(p))}`
            + `　買 ${priceText(p.buyPrice, p.currency)} → 賣 ${priceText(p.sellPrice, p.currency)}`,
        })),
    }))
    .filter((g) => g.points.length);

  if (scatterGroups.length) {
    grid.append(chartCard("持有天數 vs 報酬率", scatterXY({
      groups: scatterGroups.slice(0, 3),
      xName: "持有天數",
      yName: "報酬率",
      xFmt: (v) => `${int(v)} 天`,
      yFmt: (v) => signedPct(v),
      xLabelFmt: (v) => int(v),
      yLabelFmt: (v) => `${(v * 100).toFixed(0)}%`,
      zeroLine: true,
    }), {
      span: "span-12",
      chartClass: "chart tall",
      note: "每個點是一筆配對，大小是投入成本。水平線以下是賠錢出場的。"
        + "如果賺錢的點擠在左邊、賠錢的點拖在右邊，那就是「賺了就跑、賠了就凹」。"
        + "顏色只分券商。",
    }));
  }

  // -------------------------------------------------------- adding to a position ---
  const buys = addOns(m);
  const withAvg = buys.filter((b) => isNum(b.premium));
  if (withAvg.length) {
    const prems = withAvg.map((b) => /** @type {number} */ (b.premium));
    const premCounts = histogram(prems, PREMIUM_EDGES);
    const below = prems.filter((v) => v < 0).length;
    const sorted = prems.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    const premCard = chartCard("加碼行為：越跌越買，還是追高？", distribution({
      names: PREMIUM_LABELS,
      values: premCounts,
      label: "加碼筆數",
      divider: PREMIUM_DIVIDER,
      dividerLabel: "均價",
      fmt: (v) => `${int(v)} 筆`,
      sub: PREMIUM_LABELS.map(() => "加碼筆數"),
    }), {
      span: "half",
      height: barRows(PREMIUM_LABELS.length, { top: 24, min: 240 }),
      note: "已經有部位之後再買進時，價格比當時的持有均價高多少或低多少。"
        + "虛線以上是買在均價之下（攤平），以下是追高。"
        + `第一次建倉的 ${buys.length - withAvg.length} 筆沒有可比的均價，未計入。`,
    });
    premCard.append(footnote(
      `${withAvg.length} 筆加碼有 ${below} 筆（${pct(below / withAvg.length, 0)}）買在均價之下，`
      + `溢價中位數 ${signedPct(median, 1)}。偏向攤平不代表比較好，只是說明習慣。`,
    ));
    grid.append(premCard);
  }

  // ------------------------------------------------------------- heat map ---
  grid.append(tradingHeatmap(m));

  // ----------------------------------------------------- price-fed section ---
  const priceHost = el("div", { class: "subgrid" });
  grid.append(priceHost);
  priceCards(m, d, result, priceHost);

  // ----------------------------------------------------------- pairs table ---
  const pairsCard = card("FIFO 配對明細", {
    span: "span-12",
    note: "股數與單價已還原成今日單位，所以跨過分割的那幾筆，單價會跟交易明細頁上的"
      + "原始成交價不同（金額則完全相同）。需要用到股數的圖會自己比對行情，"
      + "把單位確認不了的標的排除並在圖下標名。",
  });
  const pairRows = pairs.map((p) => ({
    ...p,
    brokerLabel: d.brokers.find((b) => b.broker === p.broker)?.label ?? p.broker,
    pnlTwd: pnlTwd(p),
  }));
  pairsCard.append(table([
    { key: "sellDate", label: "賣出日", align: "left" },
    { key: "buyDate", label: "買進日", align: "left" },
    { key: "days", label: "持有天數", fmt: (v) => int(v) },
    { key: "symbol", label: "代號", align: "left" },
    { key: "name", label: "名稱", align: "left", fmt: (v) => v || DASH },
    { key: "brokerLabel", label: "券商", align: "left" },
    { key: "qty", label: "股數", fmt: (v) => shareText(v) },
    { key: "buyPrice", label: "買進單價", fmt: (v, r) => priceText(v, r.currency) },
    { key: "sellPrice", label: "賣出單價", fmt: (v, r) => priceText(v, r.currency) },
    {
      key: "pnlTwd", label: "損益 (TWD)", fmt: (v) => signedMoney(v),
      cls: (r) => tone(r.pnlTwd),
    },
    { key: "roi", label: "報酬率", fmt: (v) => signedPct(v), cls: (r) => tone(r.roi) },
  ], pairRows, { sortKey: "sellDate", sortDir: "desc", scroll: true }));
  pairsCard.append(footnote(
    "「損益 (TWD)」的美股部位用最新匯率換算，所以含有匯率變動；原幣別的單價則沒有。",
  ));
  grid.append(pairsCard);

  return grid;
}

// ------------------------------------------------------------- heat map ---

/**
 * When trades happen: month of the year against day of the week.
 *
 * Counts, not amounts. The question is habit - "do I trade on Mondays", "does
 * every February look like this" - and one large order would drown a month's
 * worth of small ones if the cell carried money.
 *
 * Weekdays with no trades at all are dropped rather than drawn empty: two
 * blank rows for the weekend say nothing except that the market was shut.
 *
 * @param {Model} m
 */
function tradingHeatmap(m) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  const usedDays = new Set();
  for (const t of m.trades) {
    const dt = new Date(`${t.date}T00:00:00Z`);
    if (Number.isNaN(dt.getTime())) continue;
    // getUTCDay is 0 = Sunday; the row order here is Monday first.
    const wd = (dt.getUTCDay() + 6) % 7;
    const mo = dt.getUTCMonth();
    usedDays.add(wd);
    const k = `${mo}|${wd}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const rows = [...usedDays].sort((a, b) => a - b);
  /** @type {[number, number, number][]} */
  const cells = [];
  for (let mo = 0; mo < 12; mo++) {
    rows.forEach((wd, y) => {
      cells.push([mo, y, counts.get(`${mo}|${wd}`) ?? 0]);
    });
  }

  const busiest = cells.reduce((a, c) => (c[2] > a[2] ? c : a), cells[0] ?? [0, 0, 0]);
  const node = chartCard("交易時間習慣", heatmap({
    xNames: MONTHS,
    xFull: MONTHS_FULL,
    yNames: rows.map((wd) => WEEKDAYS[wd]),
    cells,
    label: "交易筆數",
    fmt: (v) => `${int(v)} 筆`,
  }), {
    span: "half",
    height: Math.max(240, rows.length * 34 + 110),
    note: "橫軸是月份、直軸是星期，深淺是成交筆數。"
      + "用筆數不用金額——這張圖問的是習慣，一筆大單會把整個月的小單淹掉。",
  });
  node.append(footnote(
    `最密集的是 ${MONTHS_FULL[busiest[0]]}的${WEEKDAYS[rows[busiest[1]]] ?? ""}，`
    + `共 ${busiest[2]} 筆。同一天的多筆成交分別計算，所以數字比「有幾天在交易」多。`,
  ));
  return node;
}

// -------------------------------------------------------- price-fed cards ---

/**
 * The three cards that need quotes, sharing one fetch pass.
 *
 * Built asynchronously into `host` because the shell appends what `render()`
 * returns immediately - a view cannot be async. Failure is per symbol, never
 * per card: a symbol whose series will not load drops out and is counted, so
 * an average is never quietly computed over a different set than the one the
 * heading claims.
 *
 * @param {Model} m
 * @param {import('../model.js').Derived} d
 * @param {import('../fifo.js').FifoResult} result
 * @param {HTMLElement} host
 */
function priceCards(m, d, result, host) {
  const symbols = [...new Map(m.trades.map((t) => [t.symbol, t])).entries()]
    .map(([symbol, t]) => ({
      symbol,
      market: /** @type {'TW'|'US'} */ (t.currency === "USD" ? "US" : "TW"),
      currency: t.currency,
    }));

  const loading = card("需要歷史股價的分析", {
    span: "span-12",
    note: `下面三張圖需要歷史股價，正在取 ${symbols.length} 檔的日線。`
      + "第一次會慢一點，之後幾小時內都走本機快取。",
  });
  const progress = el("div", { class: "loading", text: `已載入 0 / ${symbols.length} 檔…` });
  loading.append(progress);
  host.append(loading);

  /** Earliest trade per symbol, so each fetch asks for the range it needs and no more. */
  const firstOf = new Map();
  for (const t of m.trades) {
    const cur = firstOf.get(t.symbol);
    if (!cur || t.date < cur) firstOf.set(t.symbol, t.date);
  }
  // The benchmark has to reach back to the earliest TWD purchase, which may
  // predate the first time 0050 itself was traded.
  const firstTw = m.trades
    .filter((t) => t.currency === "TWD")
    .reduce((a, t) => (t.date < a ? t.date : a), today());

  /** @type {Map<string, import('../market.js').Bar[]>} */
  const series = new Map();
  /** @type {string[]} */
  const failed = [];
  let done = 0;
  // This board asks for every traded symbol at once, so it is the screen most
  // likely to run the anonymous tier out. Worth telling apart from a network
  // failure, because only one of the two has a fix the reader can apply.
  let rateLimited = false;

  const fetchOne = async ({ symbol, market }) => {
    const from = shiftDays(
      symbol === BENCH ? minDate(firstOf.get(symbol) ?? firstTw, firstTw) : firstOf.get(symbol),
      -60);
    try {
      const { rows } = await daily(symbol, market, { from, to: today() });
      if (rows.length) series.set(symbol, rows);
      else failed.push(symbol);
    } catch (err) {
      // One symbol's quota or outage must not cost the whole board.
      failed.push(symbol);
      if (err instanceof MarketError && err.kind === "rate-limit") rateLimited = true;
    }
    done += 1;
    if (progress.isConnected) progress.textContent = `已載入 ${done} / ${symbols.length} 檔…`;
  };

  // Four at a time: enough to keep the wait short, gentle enough that a free
  // tier is not hit with forty simultaneous requests.
  const queue = symbols.slice();
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await fetchOne(next);
  });

  Promise.all(workers)
    .then(() => corporateActions(BENCH, "TW").catch(() => ({ actions: [], authoritative: false })))
    .then((benchActions) => {
      if (!host.isConnected) return;
      disposeIn(host);
      clear(host);
      if (!series.size) {
        const dead = card("需要歷史股價的分析", {
          span: "span-12", warn: true,
          note: rateLimited
            ? "FinMind 的免費額度用完了，一檔股價都抓不到。買點品質、賣飛試算與"
              + " 0050 對照都需要歷史股價，所以這三張圖沒有畫出來。"
              + "本頁其他數字完全來自試算表，不受影響。"
            : "一檔股價都抓不到（網路不通，或行情服務暫時無法回應）。"
              + "買點品質、賣飛試算與 0050 對照都需要歷史股價，所以這三張圖沒有畫出來。"
              + "本頁其他數字完全來自試算表，不受影響。",
        });
        dead.append(rateLimited ? tokenRow() : retryRow());
        host.append(dead);
        return;
      }
      // Partial failure still gets the escape hatch: this board wants forty
      // series, so it can spend the anonymous quota half way through and leave
      // three cards averaging over whatever happened to arrive first.
      if (rateLimited) {
        const partial = card("有些股價沒抓到", {
          span: "span-12", warn: true,
          note: `FinMind 的免費額度在載入途中用完了，${failed.length} 檔沒有抓到。`
            + "下面三張圖只算了抓得到的那些，各自的註腳有列出缺哪幾檔。"
            + "貼上自己的 FinMind token 可以提高上限，token 只存在這台瀏覽器、不會進 repo。",
        });
        partial.append(tokenRow());
        host.append(partial);
      }
      const units = unitTrust(m, symbols, series);
      host.append(buyQualityCard(m, series, units, failed));
      host.append(soldTooEarlyCard(m, d, sellFollowUps(m), series, units, failed));
      host.append(benchmarkCard(m, d, series, units, benchActions, failed));
    })
    .catch((err) => {
      if (!host.isConnected) return;
      disposeIn(host);
      clear(host);
      host.append(card("需要歷史股價的分析", {
        span: "span-12", warn: true,
        note: `載入歷史股價時出錯：${err instanceof Error ? err.message : String(err)}。`
          + "本頁其他數字完全來自試算表，不受影響。",
      }));
    });
}

const minDate = (a, b) => (a && b ? (a < b ? a : b) : (a || b));

/**
 * The escape hatch for a spent anonymous quota, as 交易明細 offers it.
 *
 * Only shown when that is actually what happened. A token box on a working
 * page is clutter, and on a network outage it is a red herring - which is why
 * `rateLimited` is tracked separately from "this symbol did not load".
 */
function tokenRow() {
  const input = /** @type {HTMLInputElement} */ (el("input", {
    type: "text", placeholder: "貼上 FinMind token（存在瀏覽器，不會進 repo）",
    value: getToken(),
  }));
  return el("div", { class: "filter-row" }, [
    el("label", {}, [el("span", { text: "FinMind token" }), input]),
    el("button", {
      class: "btn btn-primary", text: "儲存並重試",
      onclick: () => { setToken(input.value.trim()); navigate("behavior"); },
    }),
  ]);
}

/** Just the retry, for the failures a token cannot fix. */
const retryRow = () => el("div", { class: "filter-row" },
  el("button", { class: "btn", text: "重試", onclick: () => navigate("behavior") }));

/**
 * Which symbols' share counts can be restated into today's units with confidence.
 *
 * `splitFactor` only knows the splits AssetSync happened to record, and it only
 * records the ones its own FIFO needed - a position closed before its split is
 * absent. So every symbol is cross-examined against its own price series, which
 * costs no extra request:
 *
 *   - Taiwan quotes are unadjusted, so a split leaves a discontinuity that
 *     `findBreaks` sees. A break the sheet does not explain means the units are
 *     not safe.
 *   - US quotes are adjusted, so there is no discontinuity to find - but a fill
 *     recorded in pre-split shares no longer sits inside its own day's range,
 *     which is exactly what `alignTrades` detects.
 *
 * A symbol that fails is excluded from anything expressed in shares. Anything
 * expressed in money stays valid for it, because money is a split invariant.
 *
 * @param {Model} m
 * @param {{symbol: string, market: 'TW'|'US'}[]} symbols
 * @param {Map<string, import('../market.js').Bar[]>} series
 * @returns {Map<string, boolean>}
 */
function unitTrust(m, symbols, series) {
  /** @type {Map<string, boolean>} */
  const ok = new Map();
  for (const { symbol, market } of symbols) {
    const rows = series.get(symbol);
    if (!rows) continue;
    if (m.adjustments.some((a) => a.kind === "split" && a.symbol === symbol)) {
      ok.set(symbol, true);
      continue;
    }
    if (market === "TW") {
      ok.set(symbol, findBreaks(rows).length === 0);
    } else {
      const mine = m.trades.filter((t) => t.symbol === symbol);
      ok.set(symbol, !alignTrades(rows, mine).converted);
    }
  }
  return ok;
}

/** The bar on `day`, or null. */
function barOn(rows, day) {
  // Linear is fine: the longest series here is a few hundred bars and this
  // runs once per fill, not per frame.
  for (const b of rows) if (b[0] === day) return b;
  return null;
}

/** The last bar at or before `day`, for a date the symbol did not trade on. */
function barAtOrBefore(rows, day) {
  let out = null;
  for (const b of rows) {
    if (b[0] > day) break;
    out = b;
  }
  return out;
}

// ---------------------------------------------------------- buy quality ---

/**
 * Where each buy landed inside the price range around it.
 *
 * 0% means the fill was the lowest price in the window, 100% the highest. The
 * window is N trading days centred on the fill, so it looks forward as well as
 * back - which is the point: buying at a local low that was actually the start
 * of a slide is not a good entry, and a backward-only window would call it one.
 *
 * That forward half is also the reason recent buys are excluded rather than
 * scored on a truncated window: a fill from last week has no future to be
 * measured against, and scoring it against half a window would systematically
 * flatter or punish it depending on the last few sessions.
 *
 * Prices are compared in the price SERIES' own units - `alignTrades` converts
 * each fill first - because US series are split-adjusted while the recorded
 * fill is not, and a raw comparison there would put every pre-split buy at the
 * top of its range.
 *
 * @param {Model} m
 * @param {Map<string, import('../market.js').Bar[]>} series
 * @param {Map<string, boolean>} units
 * @param {string[]} failed
 */
function buyQualityCard(m, series, units, failed) {
  const node = card("買點品質：買在區間的哪個位置", {
    span: "span-12",
    note: "每一筆買進的成交價，放進「該筆前後 N 個交易日」的最高最低區間裡看落在哪。"
      + "0% 是買在最低點，100% 是最高點。"
      + "區間刻意含買進之後的走勢——買在當下低點但之後繼續跌，那不是好買點。",
  });

  let n = 20;
  const body = el("div", {});
  node.tools.append(el("div", { class: "segmented", role: "group", "aria-label": "區間長度" },
    [20, 60].map((v) => el("button", {
      class: "seg" + (v === n ? " on" : ""),
      "aria-pressed": String(v === n),
      text: `${v} 日`,
      onclick: (ev) => {
        n = v;
        for (const b of node.tools.querySelectorAll(".seg")) {
          const on = b.textContent === `${v} 日`;
          b.classList.toggle("on", on);
          b.setAttribute("aria-pressed", String(on));
        }
        paint();
      },
    }))));
  node.append(body);

  function paint() {
    disposeIn(node);
    node.charts.length = 0;
    clear(body);

    const half = Math.floor(n / 2);
    /** @type {{symbol: string, name: string, date: string, amount: number, p: number}[]} */
    const scored = [];
    let short = 0;
    let noBar = 0;

    for (const [symbol, rows] of series) {
      const mine = m.trades.filter((t) => t.symbol === symbol && t.side === "buy");
      if (!mine.length) continue;
      // Into the series' units before comparing against the series' own bars.
      const { aligned } = alignTrades(rows, mine);
      for (const o of aligned) {
        const i = rows.findIndex((b) => b[0] === o.date);
        if (i < 0) { noBar += 1; continue; }
        if (i - half < 0 || i + half > rows.length - 1) { short += 1; continue; }
        const win = rows.slice(i - half, i + half + 1);
        const lo = Math.min(...win.map((b) => b[3]));
        const hi = Math.max(...win.map((b) => b[2]));
        if (!(hi > lo)) { short += 1; continue; }
        // An odd-lot session can print outside the regular range, so a fill is
        // clamped rather than allowed to score below 0 or above 100.
        const p = Math.min(1, Math.max(0, (o.plotPrice - lo) / (hi - lo)));
        scored.push({ symbol, name: o.name || symbol, date: o.date, amount: o.amount, p });
      }
    }

    if (!scored.length) {
      body.append(el("div", { class: "empty", text: "沒有足夠的行情資料可以評分。" }));
      return;
    }

    const counts = new Array(10).fill(0);
    for (const s of scored) counts[Math.min(9, Math.floor(s.p * 10))] += 1;
    const mean = scored.reduce((a, s) => a + s.p, 0) / scored.length;
    const weight = scored.reduce((a, s) => a + s.amount, 0);
    const weighted = weight
      ? scored.reduce((a, s) => a + s.p * s.amount, 0) / weight
      : null;
    const sorted = scored.map((s) => s.p).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    body.append(tileRow([
      // No gain/loss colour on any of these: a low percentile is not a profit,
      // and painting it red would borrow a meaning this number does not have.
      tile({
        label: "平均百分位", value: pct(mean, 1),
        sub: mean < 0.5 ? "偏區間下半（買得比較低）" : "偏區間上半（買得比較高）",
      }),
      tile({ label: "金額加權", value: pct(weighted, 1), sub: "大單佔比較重的版本" }),
      tile({ label: "中位數", value: pct(median, 1), sub: "不受極端值影響" }),
      tile({
        label: "納入評分", value: `${int(scored.length)} 筆`,
        sub: `區間 ${n} 個交易日（前後各 ${half} 日）`,
      }),
    ]));

    body.append(mount(node, distribution({
      names: PCTL_LABELS,
      values: counts,
      label: "買進筆數",
      divider: 4,
      dividerLabel: "中點",
      fmt: (v) => `${int(v)} 筆`,
      sub: PCTL_LABELS.map(() => "買進筆數"),
    }), { class: "chart", height: barRows(PCTL_LABELS.length, { top: 24, min: 240 }) }));

    // Per symbol, so a single stock's habit is visible rather than averaged
    // into everyone else's.
    const perSymbol = [...groupBy(scored, (s) => s.symbol)]
      .map(([symbol, rows]) => ({
        symbol,
        name: rows[0].name,
        count: rows.length,
        mean: rows.reduce((a, s) => a + s.p, 0) / rows.length,
        amount: rows.reduce((a, s) => a + s.amount, 0),
      }))
      .sort((a, b) => a.mean - b.mean);
    body.append(table([
      { key: "symbol", label: "代號", align: "left" },
      { key: "name", label: "名稱", align: "left", fmt: (v) => v || DASH },
      { key: "count", label: "買進筆數", fmt: (v) => int(v) },
      {
        key: "mean", label: "平均百分位", fmt: (v) => pct(v, 1),
        title: "0% = 都買在區間最低，100% = 都買在最高",
      },
    ], perSymbol, { sortKey: "mean", sortDir: "asc", scroll: true }));

    body.append(footnote(
      "百分位只說進場點在當時區間裡的位置，不代表報酬——買在最低點也可能整段都在跌。"
      + (short ? `　${short} 筆前後湊不滿 ${n} 個交易日，已排除。` : "")
      + (noBar ? `　${noBar} 筆當天沒有對應行情。` : "")
      + (failed.length ? `　抓不到股價：${failed.join("、")}。` : ""),
    ));
  }

  paint();
  return node;
}

// -------------------------------------------------------------- sold early ---

/**
 * What each sale actually cost, once the buy-backs are taken into account.
 *
 * The naive version of this card - value the sold shares at today's price and
 * compare against what they fetched - is wrong whenever a position was
 * re-entered. Sell high, watch it fall, buy the same shares back cheaper, and
 * that arithmetic still calls the sale a mistake because the price is higher
 * today. It is not: the shares came back and the difference stayed in the
 * account. So `sellFollowUps` matches every sale against later buys of the same
 * (broker, symbol), and each parcel of shares is measured against the price it
 * should be measured against:
 *
 *   - bought back  -> the buy-back price. The comparison ends the day the
 *                     position was restored; what happened afterwards belongs
 *                     to the new position, not to the sale.
 *   - never bought back -> today's close. Only here is "if I had just held"
 *                     the right counterfactual.
 *
 * One formula covers both: `(reference - sellPrice) x qty`. Positive means
 * holding would have been better; negative means the sale was the better call.
 *
 * @param {Model} m
 * @param {import('../model.js').Derived} d
 * @param {import('../fifo.js').SoldShares[]} sold
 * @param {Map<string, import('../market.js').Bar[]>} series
 * @param {Map<string, boolean>} units
 * @param {string[]} failed
 */
function soldTooEarlyCard(m, d, sold, series, units, failed) {
  /**
   * @type {Map<string, {symbol: string, name: string, currency: any,
   *   backQty: number, backCost: number, openQty: number, openCost: number,
   *   costTwd: number, parcels: number}>}
   */
  const bySymbol = new Map();
  const skipped = new Set();

  for (const s of sold) {
    const rows = series.get(s.symbol);
    // Only the never-repurchased parcels need a quote, but a symbol whose share
    // units cannot be confirmed is unsafe for both halves.
    if (units.get(s.symbol) === false) { skipped.add(s.symbol); continue; }
    let reference = s.backPrice;
    if (reference === null) {
      const last = rows?.[rows.length - 1];
      if (!last || !last[4]) { skipped.add(s.symbol); continue; }
      reference = last[4];
    }
    const cost = (reference - s.sellPrice) * s.qty;
    const cur = bySymbol.get(s.symbol) ?? {
      symbol: s.symbol, name: s.name || s.symbol, currency: s.currency,
      backQty: 0, backCost: 0, openQty: 0, openCost: 0, costTwd: 0, parcels: 0,
    };
    if (s.backPrice === null) { cur.openQty += s.qty; cur.openCost += cost; }
    else { cur.backQty += s.qty; cur.backCost += cost; }
    cur.costTwd += twd(cost, s.currency, d.rate) ?? 0;
    cur.parcels += 1;
    bySymbol.set(s.symbol, cur);
  }

  const rows = [...bySymbol.values()].sort((a, b) => b.costTwd - a.costTwd);
  const node = card("賣出之後呢：真的賣飛了嗎", {
    span: "span-12",
    note: "賣掉之後又買回來的，只算到買回那天為止——低賣高買才是損失，"
      + "高賣低買反而是賺到。沒有買回的才用今天的股價算，那才是真正的賣飛。"
      + "正的代表當初不賣比較好，負的代表賣掉是對的。",
  });

  if (!rows.length) {
    node.append(el("div", { class: "empty", text: "沒有可以試算的賣出（抓不到現價）。" }));
    return node;
  }

  const total = rows.reduce((a, r) => a + r.costTwd, 0);
  const backTwd = rows.reduce((a, r) => a + (twd(r.backCost, r.currency, d.rate) ?? 0), 0);
  const openTwd = rows.reduce((a, r) => a + (twd(r.openCost, r.currency, d.rate) ?? 0), 0);
  const backParcels = sold.filter((s) => s.backDate).length;
  const gaps = sold.filter((s) => isNum(s.gapDays)).map((s) => /** @type {number} */ (s.gapDays))
    .sort((a, b) => a - b);

  node.append(tileRow([
    // Uncoloured: the sign means "holding would have been better", not "the
    // account made or lost this" - it never appeared in any statement.
    tile({
      label: "賣出決策的機會成本", value: signedMoney(total),
      sub: total > 0 ? "正的代表當初不賣比較好" : "整體而言賣得對",
    }),
    tile({
      label: "沒買回的", value: signedMoney(openTwd),
      sub: "用今天的股價算，真正的賣飛",
    }),
    tile({
      label: "賣掉又買回的", value: signedMoney(backTwd),
      sub: backParcels
        ? `正的是買回時更貴　${int(backParcels)} 段，間隔中位數 `
          + `${days(gaps[Math.floor(gaps.length / 2)])}`
        : "沒有買回紀錄",
    }),
    tile({
      label: "涉及檔數", value: `${int(rows.length)} 檔`,
      sub: `${int(sold.filter((s) => bySymbol.has(s.symbol)).length)} 段賣出`,
    }),
  ]));

  node.append(mount(node, divergingBars({
    names: rows.map(chartName),
    values: rows.map((r) => r.costTwd),
    label: "不賣的話會多多少 (TWD)",
    sub: rows.map((r) => `${r.symbol}　`
      + (r.backQty ? `買回 ${shareText(r.backQty)} 股 ${signedMoney(r.backCost, r.currency)}　` : "")
      + (r.openQty ? `未買回 ${shareText(r.openQty)} 股 ${signedMoney(r.openCost, r.currency)}` : "")),
  }), { class: "chart", height: barRows(rows.length, { min: 260 }) }));

  node.append(table([
    { key: "symbol", label: "代號", align: "left" },
    { key: "name", label: "名稱", align: "left", fmt: (v) => v || DASH },
    { key: "backQty", label: "已買回股數", fmt: (v) => (v ? shareText(v) : DASH) },
    {
      key: "backCost", label: "買回的代價",
      fmt: (v, r) => (r.backQty ? signedMoney(v, r.currency) : DASH),
      title: "買回價 − 賣出價：正的代表買回時比賣出時貴，也就是當初不賣比較好",
    },
    { key: "openQty", label: "未買回股數", fmt: (v) => (v ? shareText(v) : DASH) },
    {
      key: "openCost", label: "未買回的機會成本",
      fmt: (v, r) => (r.openQty ? signedMoney(v, r.currency) : DASH),
      title: "今天的股價 − 賣出價：正的代表賣飛了",
    },
    // No gain/loss colour anywhere in this table: every column is a
    // counterfactual, and none of these amounts ever appeared in an account.
    { key: "costTwd", label: "合計 (TWD)", fmt: (v) => signedMoney(v) },
  ], rows, { sortKey: "costTwd", scroll: true }));

  node.append(footnote(
    "只算價差，不含期間的股息，也不含賣出後那筆錢拿去買別的東西所賺到的。"
    + (skipped.size ? `　沒有納入：${[...skipped].join("、")}（抓不到現價，`
      + "或行情顯示有分割但沒有對應的分割紀錄，股數單位無法確認）。" : "")
    + (failed.length ? `　抓不到股價：${failed.join("、")}。` : ""),
  ));
  return node;
}

// -------------------------------------------------------------- benchmark ---

/**
 * Every Taiwan purchase, against the same cash put into 0050 that day.
 *
 * The comparison is buy-and-hold on both sides: it asks what stock picking was
 * worth against not picking at all, so it deliberately ignores what was sold
 * afterwards. Mixing the sales back in would need to model where the proceeds
 * went, and the workbook does not record that - the same gap that rules out an
 * IRR for the whole account.
 *
 * US purchases are excluded. Their cash was USD, so a TWD benchmark would fold
 * two years of exchange-rate movement into a number labelled "stock picking",
 * and there is no honest way to separate them afterwards.
 *
 * Both sides are price-only: neither the stock's dividends nor 0050's are
 * counted. That is symmetric, and it understates both by roughly a dividend
 * yield - which is stated on the card rather than quietly corrected for.
 *
 * @param {Model} m
 * @param {import('../model.js').Derived} d
 * @param {Map<string, import('../market.js').Bar[]>} series
 * @param {Map<string, boolean>} units
 * @param {{actions: any[], authoritative: boolean}} benchActions
 * @param {string[]} failed
 */
function benchmarkCard(m, d, series, units, benchActions, failed) {
  const node = card(`如果當初買 ${BENCH} 放著：個股 vs 大盤`, {
    span: "span-12",
    note: `每一筆台股買進，拿同一天、同一筆金額改買 ${BENCH} 來對照，兩邊都假設抱到今天。`
      + "刻意不管後來有沒有賣掉——這張圖問的是「選股有沒有加分」。"
      + "兩邊都只算股價不含配息，所以債券與高股息 ETF 在這裡一定很難看，"
      + "那是它們的報酬本來就來自配息，不是選錯標的。",
  });

  const benchRows = series.get(BENCH);
  if (!benchRows || !benchRows.length) {
    node.append(el("div", { class: "empty", text: `抓不到 ${BENCH} 的歷史股價，無法對照。` }));
    return node;
  }
  const benchLast = benchRows[benchRows.length - 1][4];

  // Restating 0050 itself matters most of all - it is the denominator of every
  // row. The sheet's own split row wins when it has one; FinMind's official
  // reference prices are the fallback, and they are exact for Taiwan.
  const sheetHasBenchSplit = m.adjustments.some(
    (a) => a.kind === "split" && a.symbol === BENCH);
  const benchFactor = (day) => (sheetHasBenchSplit
    ? splitFactor(m.adjustments, BENCH, day)
    : shareFactor(day, benchActions.actions));

  /** @type {Map<string, {symbol: string, name: string, invested: number,
   *          nowValue: number, benchValue: number, excess: number, buys: number}>} */
  const bySymbol = new Map();
  let noRange = 0;
  const skipped = new Set();

  for (const t of m.trades) {
    if (t.side !== "buy" || t.currency !== "TWD") continue;
    const rows = series.get(t.symbol);
    if (!rows || units.get(t.symbol) === false) { skipped.add(t.symbol); continue; }
    const last = rows[rows.length - 1];
    if (!last || !last[4]) { skipped.add(t.symbol); continue; }

    // The benchmark's own bar for that day; a day 0050 did not trade falls back
    // to the previous close rather than dropping the row.
    const b = barOn(benchRows, t.date) ?? barAtOrBefore(benchRows, t.date);
    const f = benchFactor(t.date);
    if (!b || !b[4] || f === null) { noRange += 1; continue; }

    const qtyToday = t.qty * splitFactor(m.adjustments, t.symbol, t.date);
    const nowValue = qtyToday * last[4];
    // Shares of 0050 that cash would have bought, restated into today's units,
    // valued at today's close.
    const benchValue = (t.amount / b[4]) * f * benchLast;

    const cur = bySymbol.get(t.symbol) ?? {
      symbol: t.symbol, name: t.name || t.symbol,
      invested: 0, nowValue: 0, benchValue: 0, excess: 0, buys: 0,
    };
    cur.invested += t.amount;
    cur.nowValue += nowValue;
    cur.benchValue += benchValue;
    cur.excess += nowValue - benchValue;
    cur.buys += 1;
    if (!cur.name && t.name) cur.name = t.name;
    bySymbol.set(t.symbol, cur);
  }

  const rows = [...bySymbol.values()].sort((a, b) => b.excess - a.excess);
  if (!rows.length) {
    node.append(el("div", { class: "empty", text: "沒有可以對照的台股買進紀錄。" }));
    return node;
  }

  const invested = rows.reduce((a, r) => a + r.invested, 0);
  const nowValue = rows.reduce((a, r) => a + r.nowValue, 0);
  const benchValue = rows.reduce((a, r) => a + r.benchValue, 0);
  const beat = rows.filter((r) => r.excess > 0).length;

  node.append(tileRow([
    tile({
      label: "全部買進（假設沒賣）", value: money(nowValue),
      deltaText: invested ? `較投入 ${signedPct((nowValue - invested) / invested)}` : undefined,
      tone: nowValue >= invested ? "up" : "down",
      sub: `投入 ${compact(invested)}`,
    }),
    tile({
      label: `同樣的錢買 ${BENCH}`, value: money(benchValue),
      deltaText: invested ? `較投入 ${signedPct((benchValue - invested) / invested)}` : undefined,
      sub: "同日期、同金額",
    }),
    tile({
      label: "選股的加減分", value: signedMoney(nowValue - benchValue),
      tone: nowValue >= benchValue ? "up" : "down",
      sub: benchValue ? signedPct((nowValue - benchValue) / benchValue) : undefined,
    }),
    tile({
      label: `贏過 ${BENCH} 的檔數`, value: `${int(beat)} / ${int(rows.length)}`,
      sub: `共 ${int(rows.reduce((a, r) => a + r.buys, 0))} 筆買進`,
    }),
  ]));

  node.append(mount(node, divergingBars({
    names: rows.map(chartName),
    values: rows.map((r) => r.excess),
    label: `個股現值 − ${BENCH} 對照現值 (TWD)`,
    sub: rows.map((r) => `${r.symbol}　投入 ${money(r.invested)}`
      + `　現值 ${money(r.nowValue)} vs ${BENCH} ${money(r.benchValue)}`),
  }), { class: "chart", height: barRows(rows.length, { min: 260 }) }));

  const maxInvested = Math.max(...rows.map((r) => r.invested), 1);
  node.append(table([
    { key: "symbol", label: "代號", align: "left" },
    { key: "name", label: "名稱", align: "left", fmt: (v) => v || DASH },
    { key: "buys", label: "買進筆數", fmt: (v) => int(v) },
    { key: "invested", label: "投入金額", fmt: (v) => money(v) },
    { key: "nowValue", label: "抱到今天", fmt: (v) => money(v) },
    { key: "benchValue", label: `改買 ${BENCH}`, fmt: (v) => money(v) },
    {
      key: "excess", label: "差額", fmt: (v) => signedMoney(v), cls: (r) => tone(r.excess),
    },
    {
      key: "excessPct", label: "差額 ÷ 投入",
      value: (r) => (r.invested ? r.excess / r.invested : null),
      fmt: (_v, r) => (r.invested ? signedPct(r.excess / r.invested) : DASH),
      cls: (r) => tone(r.excess),
    },
  ], rows, { sortKey: "excess", scroll: true }));

  node.append(footnote(
    "美股買進沒有納入：那些現金是美元，換算成台幣對照會把匯率變動混進「選股」裡。"
    + (skipped.size ? `　沒有納入：${[...skipped].join("、")}（抓不到股價，`
      + "或股數單位無法確認）。" : "")
    + (noRange ? `　${noRange} 筆買進的日期落在 ${BENCH} 的行情範圍之外。` : "")
    + (failed.length ? `　抓不到股價：${failed.join("、")}。` : ""),
  ));
  return node;
}
