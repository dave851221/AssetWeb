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
// 買點品質, 賣飛 and vs 0050 need historical quotes, so they load from FinMind
// and fill in when they land. They share ONE fetch pass over the symbols that
// were actually traded, and everything goes through `daily()`, which caches per
// symbol in localStorage and only tops up the missing tail - the free tier is
// small enough that a re-fetch per visit would spend it.
//
// Each of them degrades on its own: a symbol whose prices cannot be fetched is
// dropped from that card and counted in its footnote, never silently averaged
// away.

import {
  el, card, table, money, priceText, signedMoney, pct, signedPct, isNum, int,
  clear, groupBy, navigate, DASH,
} from "../util.js";
import { derive, twd } from "../model.js";
import { match as fifoMatch, stats as fifoStats, histogram, addOns } from "../fifo.js";
import { splitFactor } from "../parse/adjustments.js";
import {
  columns, scatterXY, heatmap, divergingBars, barRows, disposeIn, mount, compact,
} from "../charts.js";
import {
  daily, alignTrades, findBreaks, corporateActions, shareFactor,
  MarketError, getToken, setToken,
} from "../market.js";
import { tile, tileRow, chartCard, footnote } from "./parts.js";

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
const MONTHS = ["1 月", "2 月", "3 月", "4 月", "5 月", "6 月",
  "7 月", "8 月", "9 月", "10 月", "11 月", "12 月"];

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
      note: "還沒有任何完成的買賣配對。這一頁的每個數字都來自「買進後又賣出」的成對紀錄，"
        + "只有買進沒有賣出時無從分析。",
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
    note: "試算表的已實現損益是「每檔每年」彙總的，沒有逐筆配對，所以本站用 trades 分頁"
      + "重跑了一次 FIFO：每個券商、每檔股票各自排隊，先買的先賣掉，股數先用分割倍率"
      + "還原成今日單位。成本用成交總額（不含買進手續費）、費用只算賣出的手續費與交易稅，"
      + "這是比對試算表自己的年度數字後確定的做法——"
      + "?selftest=1 會把每一組（券商 × 年度 × 個股）拿去跟試算表對，對不上就會變紅。"
      + "配對的損益只看價差，不含期間領到的股息。",
  }));

  if (result.uncovered.length) {
    const detail = result.uncovered
      .map((u) => `${u.symbol}${u.name ? `（${u.name}）` : ""} ${shareText(u.qty)} 股`)
      .join("、");
    grid.append(card("有股數配不到買進成本", {
      span: "span-12",
      warn: true,
      note: `${detail}：這些股數是「股數補登」進來的（員工持股、券商贈股之類），`
        + "試算表沒有記每股成本，AssetSync 是從 cost_override.json 取得的，那個檔案不在試算表裡。"
        + "本站不會替它們編一個成本（成本填 0 會把整筆賣出金額算成獲利），所以這些股數的配對"
        + "被略過了，下面每一張圖都少了它們。這幾檔的勝率與損益會偏離試算表的數字。",
    }));
  }

  // ----------------------------------------------------- return histogram ---
  const rated = pairs.filter((p) => isNum(p.roi));
  const zeroCost = pairs.length - rated.length;
  const roiCounts = histogram(rated.map((p) => /** @type {number} */ (p.roi)), ROI_EDGES);
  grid.append(chartCard("每筆配對的報酬率分布", columns({
    names: ROI_LABELS,
    values: roiCounts,
    label: "配對筆數",
    divider: ROI_DIVIDER,
    dividerLabel: "損益兩平",
    yName: "筆數",
    sub: ROI_LABELS.map((l, i) => `${l}　${roiCounts[i]} 筆`),
  }), {
    span: "half",
    scroll: true,
    note: "一根柱子是一個報酬率區間裡有幾筆配對。正負由「在虛線的哪一邊」表示，"
      + "不是靠顏色——虛線左邊全是賠錢出場的。"
      + "報酬率 = (賣出金額 − 成本 − 費稅) ÷ 成本，不是年化：一筆抱兩年賺 20% 和"
      + "一筆抱兩週賺 20% 在這裡長得一樣，時間的部分請看右邊那張圖。"
      + (zeroCost ? `　另有 ${zeroCost} 筆成本為 0 的配股，算不出報酬率，未計入。` : ""),
  }));

  // ------------------------------------------------------ holding-day bars ---
  const dayCounts = histogram(pairs.map((p) => p.days), DAY_EDGES);
  grid.append(chartCard("持有天數分布", columns({
    names: DAY_LABELS,
    values: dayCounts,
    label: "配對筆數",
    yName: "筆數",
    sub: DAY_LABELS.map((l, i) => `${l}　${dayCounts[i]} 筆`),
  }), {
    span: "half",
    scroll: true,
    note: "從買進那批股票到把它賣掉，中間隔了多少「日曆天」（不是交易日）。"
      + "這張圖回答的是「實際上到底做的是短線還是長線」——"
      + "同一檔分批買進時，FIFO 會先賣掉最早買的那批，所以最左邊的短天期通常是"
      + "加碼後又快速減碼的部位，不一定是當沖。",
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
      scroll: true,
      note: "每個點是一筆配對，大小是投入成本（換算 TWD）。"
        + "水平線是損益兩平：線以下的點就是賠錢出場的那些。"
        + "右上角是「抱得久也賺得多」，左下角是「很快就認賠」——"
        + "如果賺錢的點都擠在左邊、賠錢的點都拖在右邊，那就是典型的「賺了就跑、賠了就凹」。"
        + "顏色只分券商，不分賺賠。",
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

    const premCard = chartCard("加碼行為：越跌越買，還是追高？", columns({
      names: PREMIUM_LABELS,
      values: premCounts,
      label: "加碼筆數",
      divider: PREMIUM_DIVIDER,
      dividerLabel: "等於當時均價",
      yName: "筆數",
      sub: PREMIUM_LABELS.map((l, i) => `${l}　${premCounts[i]} 筆`),
    }), {
      span: "half",
      scroll: true,
      note: `每一筆「已經有部位之後再買進」的成交，價格比當時的持有均價高多少或低多少。`
        + `虛線左邊是買在均價之下（攤平），右邊是買在均價之上（追高）。`
        + `這裡的均價是券商式的移動平均成本（賣出時按均價扣成本、均價不變），`
        + `跟上面 FIFO 的配對是兩套算法，因為「我的成本是多少」大家心裡想的是前者。`
        + `第一次建倉的 ${buys.length - withAvg.length} 筆沒有可比的均價，未計入。`,
    });
    premCard.append(footnote(
      `${withAvg.length} 筆加碼裡有 ${below} 筆（${pct(below / withAvg.length, 0)}）買在均價之下，`
      + `溢價中位數 ${signedPct(median, 1)}。`
      + "偏左不代表比較好——攤平會在下跌時放大部位，只是說明習慣。",
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
    note: "本站自己配對出來的每一筆。股數與單價是用試算表 adjustments 分頁記錄的分割比例"
      + "還原成今日單位的，所以跨過分割的那幾筆，單價會跟交易明細頁上的原始成交價不同"
      + "（金額則完全相同）。試算表沒有記錄的分割不在還原範圍內——"
      + "AssetSync 只記它自己 FIFO 用得到的那些，所以一檔在分割前就全部賣掉的股票，"
      + "分割前後兩段的「股」會是不同單位（金額一樣不受影響）。"
      + "上面需要用到股數的兩張圖會自己比對行情把這種標的排除，並在圖下標出是哪一檔。",
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
    "「損益 (TWD)」的美股部位是用最新匯率換算的，不是成交當天的匯率——"
    + "試算表沒有記錄每筆成交當天的匯率，所以這一欄含有匯率變動，原幣別的單價則沒有。",
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
    yNames: rows.map((wd) => WEEKDAYS[wd]),
    cells,
    label: "交易筆數",
    fmt: (v) => `${int(v)} 筆`,
  }), {
    span: "half",
    scroll: true,
    height: Math.max(230, rows.length * 34 + 96),
    note: "橫軸是月份、直軸是星期，深淺是那個格子裡的成交筆數。"
      + "用筆數不用金額：這張圖問的是習慣，一筆大單會把整個月的小單淹掉。"
      + "顏色是單一色相的深淺（低到高），不是紅綠——這裡的量沒有好壞之分。",
  });
  node.append(footnote(
    `最密集的是 ${MONTHS[busiest[0]]}的${WEEKDAYS[rows[busiest[1]]] ?? ""}，共 ${busiest[2]} 筆。`
    + "同一天的多筆成交會分別計算（分批買進很常見），所以格子的數字比「有幾天在交易」多。",
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
    note: `買點品質、賣飛試算與 0050 對照都需要歷史股價。正在向 FinMind 取 `
      + `${symbols.length} 檔的日線，第一次會慢一點，之後 6 小時內都走瀏覽器本機快取。`,
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
      host.append(soldTooEarlyCard(m, d, result, series, units, failed));
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
    note: "把每一筆買進的成交價，放進「該筆前後 N 個交易日」的最高最低區間裡看它落在哪裡。"
      + "0% 是買在整段區間的最低點，100% 是最高點，50% 是中間。"
      + "區間刻意包含買進之後的走勢——買在當下的低點但之後繼續跌，那不是好買點，"
      + "只往回看的區間會把它算成好買點。",
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

    body.append(mountInto(node, columns({
      names: PCTL_LABELS,
      values: counts,
      label: "買進筆數",
      divider: 4,
      dividerLabel: "區間中點",
      yName: "筆數",
      sub: PCTL_LABELS.map((l, i) => `${l}　${counts[i]} 筆`),
    })));

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
      `${scored.length} 筆買進納入評分。`
      + (short ? `　${short} 筆因為前後湊不滿 ${n} 個交易日被排除（最早與最近的買進）。` : "")
      + (noBar ? `　${noBar} 筆當天沒有對應的行情（可能是停牌或盤後零股）。` : "")
      + (failed.length ? `　${failed.length} 檔抓不到股價：${failed.join("、")}。` : "")
      + "　百分位只描述進場點在當時區間裡的位置，不代表報酬——買在最低點也可能整段區間都在跌。",
    ));
  }

  paint();
  return node;
}

// -------------------------------------------------------------- sold early ---

/**
 * What the sold shares would be worth if they had never been sold.
 *
 * Straight from the FIFO pairs: the matched quantity is already in today's
 * units, so `qty x today's close` is directly comparable with what the sale
 * actually brought in. That is the entire reason the units are restated before
 * matching - the same arithmetic on raw quantities would be off by the split
 * ratio for every position that crossed one.
 *
 * The honest caveat, which the card prints: this assumes the money went nowhere
 * afterwards. In reality a sale usually funded the next purchase, so a large
 * "missed" figure is an argument about that particular decision, not about the
 * account.
 *
 * @param {Model} m
 * @param {import('../model.js').Derived} d
 * @param {import('../fifo.js').FifoResult} result
 * @param {Map<string, import('../market.js').Bar[]>} series
 * @param {Map<string, boolean>} units
 * @param {string[]} failed
 */
function soldTooEarlyCard(m, d, result, series, units, failed) {
  /** @type {Map<string, {symbol: string, name: string, currency: any, qty: number,
   *          proceeds: number, nowValue: number, missed: number, missedTwd: number}>} */
  const bySymbol = new Map();
  const skipped = new Set();

  for (const p of result.pairs) {
    const rows = series.get(p.symbol);
    if (!rows || units.get(p.symbol) === false) { skipped.add(p.symbol); continue; }
    const last = rows[rows.length - 1];
    if (!last || !last[4]) { skipped.add(p.symbol); continue; }
    const nowValue = p.qty * last[4];
    const missed = nowValue - p.proceeds;
    const cur = bySymbol.get(p.symbol) ?? {
      symbol: p.symbol, name: p.name || p.symbol, currency: p.currency,
      qty: 0, proceeds: 0, nowValue: 0, missed: 0, missedTwd: 0,
    };
    cur.qty += p.qty;
    cur.proceeds += p.proceeds;
    cur.nowValue += nowValue;
    cur.missed += missed;
    cur.missedTwd += twd(missed, p.currency, d.rate) ?? 0;
    bySymbol.set(p.symbol, cur);
  }

  const rows = [...bySymbol.values()].sort((a, b) => b.missedTwd - a.missedTwd);
  const node = card("賣飛試算：如果那些股票沒賣，今天值多少", {
    span: "span-12",
    note: "拿每一筆 FIFO 配對賣掉的股數 × 今天的收盤價，減掉當時實際賣得的金額。"
      + "正的是「賣早了」（現在比較貴），負的是「賣對了」（現在比較便宜）。"
      + "股數已經還原成今日單位，所以跨過分割的部位也算得出來。",
    warn: false,
  });

  if (!rows.length) {
    node.append(el("div", { class: "empty", text: "沒有可以試算的配對（抓不到現價）。" }));
    return node;
  }

  const totalMissed = rows.reduce((a, r) => a + r.missedTwd, 0);
  const early = rows.filter((r) => r.missedTwd > 0);
  const right = rows.filter((r) => r.missedTwd < 0);
  node.append(tileRow([
    // Deliberately uncoloured. The sign here means "the price went up after the
    // sale", not "this was a gain" - wearing the gain colour would say the
    // account made this money, and it did not.
    tile({
      label: "合計機會成本", value: signedMoney(totalMissed),
      sub: totalMissed > 0 ? "抱著會比較好" : "賣掉是對的",
    }),
    tile({
      label: "賣早了", value: `${int(early.length)} 檔`,
      sub: `合計 ${compact(early.reduce((a, r) => a + r.missedTwd, 0))}`,
    }),
    tile({
      label: "賣對了", value: `${int(right.length)} 檔`,
      sub: `合計 ${compact(right.reduce((a, r) => a + r.missedTwd, 0))}`,
    }),
    // Pairs, not a share total: adding TW lots to IBKR fractional shares would
    // be a sum over different instruments, which is not a quantity of anything.
    tile({
      label: "涉及檔數", value: `${int(rows.length)} 檔`,
      sub: `${int(result.pairs.filter((p) => bySymbol.has(p.symbol)).length)} 筆配對`,
    }),
  ]));

  node.append(mountInto(node, divergingBars({
    names: rows.map((r) => r.name || r.symbol),
    values: rows.map((r) => r.missedTwd),
    label: "抱到今天 − 當時賣出 (TWD)",
    sub: rows.map((r) => `${r.symbol}　賣出 ${shareText(r.qty)} 股`
      + `　當時 ${money(r.proceeds, r.currency)} → 今天 ${money(r.nowValue, r.currency)}`),
  }), barRows(rows.length, { min: 260 })));

  node.append(footnote(
    "這是「賣掉之後那筆錢就消失」的假設。實際上賣股票的錢通常拿去買了別的東西，"
    + "所以某一檔的機會成本很大，說的是那個賣出決定，不是整個帳戶少賺了這麼多。"
    + "兩邊都只算價差，不含賣出後本來會領到的股息，也不含買回去的成本。"
    // Named, not counted: "1 檔沒有納入" leaves the reader unable to tell
    // whether the one that is missing is the one they came to look at.
    + (skipped.size ? `　沒有納入：${[...skipped].join("、")}（抓不到現價，`
      + "或是行情顯示有分割但試算表沒有對應的分割紀錄，股數單位無法確認）。" : "")
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
    note: `每一筆台股買進，都拿同一天、同一筆金額改買 ${BENCH} 來對照，兩邊都假設抱到今天。`
      + "正的代表這檔比大盤好，負的代表同樣的錢放在 0050 會更多。"
      + "刻意不管後來有沒有賣掉——這張圖問的是「選股有沒有加分」，不是帳戶的實際報酬。"
      + "注意：兩邊都只算股價、完全不含配息，所以債券 ETF 與高股息 ETF 在這張圖上一定很難看——"
      + "它們的報酬本來就大部分來自配息，價格幾乎不漲，拿價差去跟股票指數比並不公平。"
      + "把它們的長條讀成「這筆錢如果放在股票市場會多多少」，而不是「選錯標的」。",
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

  node.append(mountInto(node, divergingBars({
    names: rows.map((r) => r.name || r.symbol),
    values: rows.map((r) => r.excess),
    label: `個股現值 − ${BENCH} 對照現值 (TWD)`,
    sub: rows.map((r) => `${r.symbol}　投入 ${money(r.invested)}`
      + `　現值 ${money(r.nowValue)} vs ${BENCH} ${money(r.benchValue)}`),
  }), barRows(rows.length, { min: 260 })));

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
    `${BENCH} 的股數已用${sheetHasBenchSplit ? "試算表的分割紀錄" : "官方分割參考價"}還原成今日單位。`
    + "兩邊都只算價格，不含配息——0050 的配息與個股的配息都沒有計入，所以兩邊都被低估，"
    + "而配息率較高的那一邊被低估得多一點。"
    + "美股買進沒有納入：那些現金是美元，換算成台幣對照會把匯率變動混進「選股」裡。"
    + (skipped.size ? `　沒有納入：${[...skipped].join("、")}（抓不到股價，`
      + "或是行情顯示有分割但試算表沒有對應的分割紀錄，股數單位無法確認）。" : "")
    + (noRange ? `　${noRange} 筆買進的日期落在 ${BENCH} 的行情範圍之外。` : "")
    + (failed.length ? `　抓不到股價：${failed.join("、")}。` : ""),
  ));
  return node;
}

// --------------------------------------------------------------- plumbing ---

/**
 * Mount a chart into a card and wrap it so a phone can scroll it sideways.
 *
 * A chart squeezed into a 340px viewport is not a smaller chart, it is an
 * unreadable one - ECharts starts dropping category labels and the marks
 * collapse into each other. The wrapper gives the canvas a floor width on
 * narrow screens and lets the card scroll it, which is the same rule the tables
 * already follow: wide content scrolls inside its own box, never by moving the
 * page.
 *
 * @param {import('../util.js').Card} host
 * @param {any} option
 * @param {number} [height]
 */
function mountInto(host, option, height) {
  return el("div", { class: "chart-scroll" },
    mount(host, option, height ? { class: "chart", height } : { class: "chart" }));
}
