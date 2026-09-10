// Daily OHLC for a stock, straight from the browser.
//
// ## Why this works without a server
//
// FinMind answers with `Access-Control-Allow-Origin: *` and needs no key, so
// the page can call it directly - measured, not assumed. Its `TaiwanStockPrice`
// dataset covers listed, OTC and ETFs in one endpoint, and `USStockPrice`
// covers US tickers, so the two datasets between them handle every symbol this
// workbook contains. TWSE's own `STOCK_DAY` is also CORS-open and stands as the
// fallback for Taiwan, at the cost of one request per calendar month.
//
// Rejected: Yahoo's v8 chart endpoint (429s without a cookie/crumb), TPEx's new
// site and Stooq (no CORS header at all - the browser blocks them outright).
//
// ## Taiwan prices are unadjusted; US prices are NOT
//
// This asymmetry is measured, and it matters more than anything else in this
// file. `TaiwanStockPrice` returns the price as it traded: 0050's series steps
// from ~190 to ~47.5 across its 2025-06-18 split, and every recorded TW fill
// lands inside its own day's high/low with no conversion at all.
// `USStockPrice` restates history instead - it reports IBKR at a quarter of
// the price a fill from two days before its 2025-06-18 split was booked at.
//
// So a marker plotted at the recorded price is right on a Taiwan chart and
// four times too high on that US one - and nothing in the series itself shows
// it, because an adjusted series has no discontinuity to detect.
//
// `alignTrades` closes that hole without needing a split dataset for either
// market: it asks, per fill, which whole-number factor puts the price inside
// that day's actual range. The answer is unique in practice - a 4:1 split
// leaves only the factor 4 able to land the fill between that day's low and
// high - and it is a constraint, not an inference. It also has to tolerate a
// fill that misses its range for ordinary reasons: an odd-lot session prints
// outside the regular high/low, so a near miss stays factor 1 rather than
// being read as a corporate action.
//
// The cost is a genuine discontinuity in any chart spanning a split. For
// Taiwan that is not guesswork: `TaiwanStockSplitPrice` states the official
// before/after reference prices, whose quotient is the exact share multiplier
// with no price movement mixed in (0050 gives 188.65/47.16 = 4.000;
// 00631L gives 443.15/20.14 = 22.003). `findBreaks` stays as the detector for
// US symbols, where FinMind has no equivalent dataset - there the ratio is
// genuinely unrecoverable, because a day's own move and the split factor are
// multiplied together in the only number available.

/** @typedef {import('./types.js').Market} Market */

/**
 * One trading day. Arrays, not objects, because these go into localStorage by
 * the thousand and the key names would triple the size.
 *
 * @typedef {[string, number, number, number, number, number]} Bar
 *   [date, open, high, low, close, volume]
 */

const FINMIND = "https://api.finmindtrade.com/api/v4/data";
/** Official split reference prices. Taiwan only - no US equivalent exists. */
const DS_SPLIT = "TaiwanStockSplitPrice";
/** Capital reductions, which also restate the share count. */
const DS_REDUCTION = "TaiwanStockCapitalReductionReferencePrice";
const TWSE_DAY = "https://www.twse.com.tw/exchangeReport/STOCK_DAY";

const CACHE_PREFIX = "aw.px.";
const ACTION_PREFIX = "aw.ca.";
const INDEX_KEY = "aw.px.index";
const TOKEN_KEY = "aw.finmindToken";
/**
 * Symbols kept on disk. Past this the least recently used is dropped.
 *
 * Sized for the 行為分析 board, which is the only screen that wants every
 * traded symbol's series at once - at 40 it evicted a symbol the moment one
 * more stock was traded, and the next visit paid for a full refetch of the
 * whole set. A series is roughly 20KB, so this ceiling costs about a megabyte
 * against a multi-megabyte quota, and `writeCache` already sheds half the
 * cache and retries if a browser disagrees.
 */
const MAX_CACHED = 64;
/** How long a cache entry is trusted without asking for newer bars. */
const FRESH_MS = 6 * 3600 * 1000;

/** Something went wrong fetching prices. `kind` decides what the UI says. */
export class MarketError extends Error {
  /** @param {string} message @param {'rate-limit'|'not-found'|'network'|'empty'} kind */
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

// ------------------------------------------------------------------ token ---

/**
 * An optional FinMind token, kept in localStorage and never in the repo.
 *
 * The free tier works with no token at all, which is why the site ships
 * without one; a token only raises the request ceiling, and pasting one is the
 * escape hatch when the anonymous quota runs out mid-session.
 */
export const getToken = () => {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
};
export const setToken = (v) => {
  try {
    if (v) localStorage.setItem(TOKEN_KEY, v);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage disabled - the anonymous tier still works */ }
};

// ------------------------------------------------------------------ cache ---

const cacheKey = (market, symbol) => `${CACHE_PREFIX}${market}.${symbol}`;

function readIndex() {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY) || "[]"); } catch { return []; }
}

/** Move a symbol to the front of the LRU list, evicting the tail. */
function touch(key) {
  try {
    const idx = readIndex().filter((k) => k !== key);
    idx.unshift(key);
    for (const dead of idx.slice(MAX_CACHED)) localStorage.removeItem(dead);
    localStorage.setItem(INDEX_KEY, JSON.stringify(idx.slice(0, MAX_CACHED)));
  } catch { /* ignore */ }
}

/** @returns {{from: string, to: string, checkedAt: number, rows: Bar[]}|null} */
function readCache(market, symbol) {
  try {
    const raw = localStorage.getItem(cacheKey(market, symbol));
    if (!raw) return null;
    const c = JSON.parse(raw);
    return c && Array.isArray(c.rows) && c.from && c.to ? c : null;
  } catch {
    return null;
  }
}

function writeCache(market, symbol, entry) {
  const key = cacheKey(market, symbol);
  try {
    localStorage.setItem(key, JSON.stringify(entry));
    touch(key);
  } catch {
    // Over quota. Drop the oldest half and try once more; prices are a cache,
    // so failing to store them costs a refetch and nothing else.
    try {
      const idx = readIndex();
      for (const dead of idx.slice(Math.floor(idx.length / 2))) localStorage.removeItem(dead);
      localStorage.setItem(key, JSON.stringify(entry));
    } catch { /* give up silently */ }
  }
}

/** Clear every cached price series. Exposed for the menu. */
export function clearPriceCache() {
  try {
    for (const key of readIndex()) localStorage.removeItem(key);
    localStorage.removeItem(INDEX_KEY);
  } catch { /* ignore */ }
}

/** How much is cached, for the menu read-out. */
export function cacheStats() {
  const keys = readIndex();
  let bytes = 0;
  try {
    for (const k of keys) bytes += (localStorage.getItem(k) || "").length;
  } catch { /* ignore */ }
  return { symbols: keys.length, bytes };
}

// ---------------------------------------------------------------- fetching ---

const iso = (d) => d.toISOString().slice(0, 10);

/** @param {string} day @param {number} days */
function shift(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * FinMind, one request for the whole range.
 *
 * @param {string} dataset
 * @param {string} symbol
 * @param {string} from
 * @param {string} to
 * @returns {Promise<any[]>}
 */
async function finmind(dataset, symbol, from, to) {
  const params = new URLSearchParams({
    dataset, data_id: symbol, start_date: from, end_date: to,
  });
  const token = getToken();
  if (token) params.set("token", token);

  let res;
  try {
    res = await fetch(`${FINMIND}?${params}`, { cache: "no-store" });
  } catch (err) {
    throw new MarketError("連不上行情服務", "network");
  }
  if (res.status === 402 || res.status === 429) {
    throw new MarketError("FinMind 免費額度已用完", "rate-limit");
  }
  if (!res.ok) throw new MarketError(`行情服務回應 ${res.status}`, "network");

  const body = await res.json().catch(() => null);
  if (!body) throw new MarketError("行情服務回傳的格式看不懂", "network");
  if (body.status && body.status !== 200) {
    const msg = String(body.msg || "");
    // The anonymous tier reports its ceiling in the message body rather than
    // in the status code, so both have to be checked.
    if (/limit|quota|402|429/i.test(msg)) {
      throw new MarketError("FinMind 免費額度已用完", "rate-limit");
    }
    throw new MarketError(msg || "行情服務拒絕了這個請求", "network");
  }
  return Array.isArray(body.data) ? body.data : [];
}

/** @returns {Promise<Bar[]>} */
async function fromFinMindTw(symbol, from, to) {
  const rows = await finmind("TaiwanStockPrice", symbol, from, to);
  return rows.map((r) => /** @type {Bar} */ ([
    r.date, num(r.open), num(r.max), num(r.min), num(r.close), num(r.Trading_Volume),
  ]));
}

/** @returns {Promise<Bar[]>} */
async function fromFinMindUs(symbol, from, to) {
  const rows = await finmind("USStockPrice", symbol, from, to);
  // `Close`, not `Adj_Close`: the trades sheet records the price actually paid,
  // so the candles have to be the prices actually traded.
  return rows.map((r) => /** @type {Bar} */ ([
    r.date, num(r.Open), num(r.High), num(r.Low), num(r.Close), num(r.Volume),
  ]));
}

/**
 * TWSE's own report, as the Taiwan fallback.
 *
 * One request per calendar month, dates in the Republic-of-China calendar
 * (`115/08/03` is 2026-08-03), numbers comma-separated, and a suspended stock
 * writes `--` into the price columns.
 *
 * @returns {Promise<Bar[]>}
 */
async function fromTwse(symbol, from, to) {
  /** @type {Bar[]} */
  const out = [];
  let cursor = `${from.slice(0, 7)}-01`;
  const last = `${to.slice(0, 7)}-01`;
  let requests = 0;
  while (cursor <= last && requests < 40) {
    requests += 1;
    const stamp = cursor.replace(/-/g, "");
    let body = null;
    try {
      const res = await fetch(
        `${TWSE_DAY}?response=json&date=${stamp}&stockNo=${encodeURIComponent(symbol)}`,
        { cache: "no-store" },
      );
      if (res.ok) body = await res.json().catch(() => null);
    } catch { /* one bad month should not lose the rest */ }

    for (const row of (body?.data || [])) {
      const m = /^(\d{2,3})\/(\d{2})\/(\d{2})$/.exec(String(row[0]).trim());
      if (!m) continue;
      const date = `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
      // Columns: 日期, 成交股數, 成交金額, 開盤價, 最高價, 最低價, 收盤價, …
      const o = num(row[3]), h = num(row[4]), l = num(row[5]), c = num(row[6]);
      if (!c) continue;                     // suspended day: price columns are "--"
      out.push([date, o, h, l, c, num(row[1])]);
    }
    // Next calendar month.
    const d = new Date(`${cursor}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    cursor = `${iso(d).slice(0, 7)}-01`;
  }
  return out.filter((b) => b[0] >= from && b[0] <= to);
}

/** Merge two series on date, newer winning, sorted ascending. */
function merge(a, b) {
  /** @type {Map<string, Bar>} */
  const m = new Map();
  for (const bar of a) m.set(bar[0], bar);
  for (const bar of b) m.set(bar[0], bar);
  return [...m.values()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
}

/**
 * Daily bars for one symbol, cached.
 *
 * Only the missing tail is fetched: a cache that already reaches back far
 * enough is topped up from its last bar to today, which keeps a session inside
 * the anonymous request ceiling even when several stocks get opened.
 *
 * @param {string} symbol
 * @param {Market} market
 * @param {{from: string, to?: string, force?: boolean}} opts
 * @returns {Promise<{rows: Bar[], source: string, cached: boolean}>}
 */
export async function daily(symbol, market, { from, to = iso(new Date()), force = false }) {
  const cached = force ? null : readCache(market, symbol);

  if (cached && cached.from <= from) {
    const fresh = Date.now() - (cached.checkedAt || 0) < FRESH_MS;
    if (fresh || cached.to >= to) {
      const rows = cached.rows.filter((b) => b[0] >= from && b[0] <= to);
      if (rows.length) return { rows, source: "cache", cached: true };
    }
    // Top up from the day after the last bar we hold.
    try {
      const tail = await fetchRange(symbol, market, shift(cached.to, 1), to);
      const rows = merge(cached.rows, tail.rows);
      writeCache(market, symbol, { from: cached.from, to, checkedAt: Date.now(), rows });
      return {
        rows: rows.filter((b) => b[0] >= from && b[0] <= to),
        source: tail.source, cached: false,
      };
    } catch (err) {
      // A failed top-up must not throw away usable history: show what we have
      // and let the card say it may be a few days stale.
      const rows = cached.rows.filter((b) => b[0] >= from && b[0] <= to);
      if (rows.length) return { rows, source: "cache", cached: true };
      throw err;
    }
  }

  const got = await fetchRange(symbol, market, from, to);
  if (!got.rows.length) {
    throw new MarketError(`找不到 ${symbol} 的歷史股價`, "empty");
  }
  writeCache(market, symbol, { from, to, checkedAt: Date.now(), rows: got.rows });
  return { ...got, cached: false };
}

/**
 * @param {string} symbol
 * @param {Market} market
 * @param {string} from
 * @param {string} to
 * @returns {Promise<{rows: Bar[], source: string}>}
 */
async function fetchRange(symbol, market, from, to) {
  if (from > to) return { rows: [], source: "none" };
  if (market === "US") {
    return { rows: await fromFinMindUs(symbol, from, to), source: "FinMind" };
  }
  try {
    const rows = await fromFinMindTw(symbol, from, to);
    if (rows.length) return { rows, source: "FinMind" };
  } catch (err) {
    // Only the quota case is worth falling back for. A network failure would
    // most likely hit TWSE too, and a wrong symbol is wrong at both.
    if (!(err instanceof MarketError) || err.kind !== "rate-limit") throw err;
  }
  return { rows: await fromTwse(symbol, from, to), source: "TWSE" };
}

// ------------------------------------------------------------- derivations ---

/**
 * A simple moving average, aligned to the input and null until it has `n` bars.
 *
 * @param {Bar[]} rows
 * @param {number} n
 * @returns {(number|null)[]}
 */
export function sma(rows, n) {
  /** @type {(number|null)[]} */
  const out = [];
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    sum += rows[i][4];
    if (i >= n) sum -= rows[i - n][4];
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

/**
 * Dates where the series jumps further than the market allows in one day.
 *
 * Taiwan's daily limit is 10% and no listed stock halves overnight, so a move
 * past 35% is not a price move at all - it is a split, a reverse split or a
 * capital reduction restating the share count. This is a detector, not a
 * guess, and the chart labels those dates instead of letting the step read as
 * a crash. (Prices here are deliberately unadjusted; see the file header.)
 *
 * @param {Bar[]} rows
 * @returns {{date: string, ratio: number}[]}
 */
export function findBreaks(rows) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1][4];
    const now = rows[i][4];
    if (!prev || !now) continue;
    const ratio = now / prev;
    if (ratio < 0.65 || ratio > 1.55) out.push({ date: rows[i][0], ratio });
  }
  return out;
}


// ------------------------------------------------------- corporate actions ---

/**
 * A share-count restatement.
 *
 * `factor` is how many of today's shares one share held before `date` became -
 * 4 for a 1:4 split, so a fill recorded before that date has its quantity
 * multiplied by 4 to reach today's units.
 *
 * @typedef {object} Action
 * @property {string} date
 * @property {number|null} factor null when the multiplier cannot be trusted
 * @property {'split'|'reduction'} kind
 */

const actionKey = (market, symbol) => `${ACTION_PREFIX}${market}.${symbol}`;

/**
 * Splits and capital reductions for one symbol.
 *
 * Cached for a day: corporate actions are announced well in advance and never
 * change retroactively, so there is nothing to gain from asking again.
 *
 * Returns an empty list for US symbols rather than throwing - FinMind has no
 * US split dataset, and the caller's job is to notice the list is empty and
 * fall back to the price-break detector.
 *
 * @param {string} symbol
 * @param {Market} market
 * @returns {Promise<{actions: Action[], authoritative: boolean}>}
 */
export async function corporateActions(symbol, market) {
  if (market !== "TW") return { actions: [], authoritative: false };

  const key = actionKey(market, symbol);
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const c = JSON.parse(raw);
      if (c && Array.isArray(c.actions) && Date.now() - (c.at || 0) < 24 * 3600 * 1000) {
        return { actions: c.actions, authoritative: true };
      }
    }
  } catch { /* fall through and fetch */ }

  const from = "2000-01-01";
  const to = iso(new Date());
  /** @type {Action[]} */
  const actions = [];

  const splits = await finmind(DS_SPLIT, symbol, from, to);
  for (const r of splits) {
    const before = num(r.before_price), after = num(r.after_price);
    if (!before || !after) continue;
    actions.push({ date: r.date, factor: before / after, kind: "split" });
  }

  // Capital reductions are detected but their factor is deliberately withheld:
  // for a cash reduction the reference price also absorbs the cash returned to
  // shareholders, so before/after is not purely the share ratio. Flagging one
  // is honest; inferring a multiplier from it would not be.
  const reductions = await finmind(DS_REDUCTION, symbol, from, to).catch(() => []);
  for (const r of reductions) {
    actions.push({ date: r.date, factor: null, kind: "reduction" });
  }

  actions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), actions }));
  } catch { /* a cache miss only costs a request */ }
  return { actions, authoritative: true };
}

/**
 * How many of today's shares one share held on `day` has become.
 *
 * Only actions strictly after `day` apply - a split on the 18th restates a fill
 * from the 17th, not one from the 18th itself, because the fill on the split
 * date is already quoted in the new units.
 *
 * @param {string} day
 * @param {Action[]} actions
 * @returns {number|null} null when some action in the way has no trusted factor
 */
export function shareFactor(day, actions) {
  let f = 1;
  for (const a of actions) {
    if (a.date <= day) continue;
    if (a.factor === null) return null;
    f *= a.factor;
  }
  return f;
}


// ------------------------------------------------------------- alignment ---

/** Whole-number factors a split or reverse split plausibly produces. */
const FACTORS = (() => {
  const whole = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 22, 25, 30, 40, 50, 100];
  return [...whole, ...whole.map((f) => 1 / f)];
})();

/**
 * How far a price sits from a day's range, as a multiple of its midpoint.
 * 1 means dead centre of the bar.
 */
const nearness = (price, bar) => {
  const mid = (bar[2] + bar[3]) / 2 || bar[4];
  return mid ? price / mid : 0;
};

/** A fill whose price is within this much of the bar's midpoint is in units. */
const SAME_UNITS_LO = 0.8;
const SAME_UNITS_HI = 1.25;
/** ...and a converted price has to land at least this close to count. */
const CONVERTED_LO = 0.85;
const CONVERTED_HI = 1.18;

/**
 * Put every fill into the same units as the price series.
 *
 * Returns each trade with the price to plot and the factor that got it there.
 * `factor` is also the share multiplier from that fill's units to today's,
 * which is what makes a correct average possible for a market with no split
 * dataset: a fill needing price ÷ 4 to match an adjusted series was recorded
 * in pre-split shares, so its quantity × 4 is today's units.
 *
 * @template {{date: string, price: number}} T
 * @param {Bar[]} rows
 * @param {T[]} trades
 * @returns {{aligned: (T & {plotPrice: number, factor: number})[],
 *            converted: boolean, unmatched: number}}
 */
export function alignTrades(rows, trades) {
  /** @type {Map<string, Bar>} */
  const byDate = new Map(rows.map((b) => [b[0], b]));
  let converted = false;
  let unmatched = 0;

  const aligned = trades.map((tr) => {
    const bar = byDate.get(tr.date);
    // No bar for that date - a suspended day, or a fill outside the fetched
    // window. Nothing to compare against, so leave it alone.
    if (!bar) {
      unmatched += 1;
      return { ...tr, plotPrice: tr.price, factor: 1 };
    }
    const r = nearness(tr.price, bar);
    if (r >= SAME_UNITS_LO && r <= SAME_UNITS_HI) {
      return { ...tr, plotPrice: tr.price, factor: 1 };
    }
    let best = null;
    let bestErr = Infinity;
    for (const f of FACTORS) {
      const rr = nearness(tr.price / f, bar);
      if (rr < CONVERTED_LO || rr > CONVERTED_HI) continue;
      const err = Math.abs(Math.log(rr));
      if (err < bestErr) { bestErr = err; best = f; }
    }
    if (best === null) {
      // Off its range and no factor explains it. Plot it where it was recorded
      // and let the caller say the count.
      unmatched += 1;
      return { ...tr, plotPrice: tr.price, factor: 1 };
    }
    converted = true;
    return { ...tr, plotPrice: tr.price / best, factor: best };
  });

  return { aligned, converted, unmatched };
}
