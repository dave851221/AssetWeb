// Trade-by-trade FIFO matching - the one thing the workbook does not provide.
//
// AssetSync's 已實現損益 blocks are aggregated per (broker, year, symbol). That
// is enough for "how much did 2026 make" and useless for "how long do I hold a
// winner". Every behavioural question - win rate, holding period, whether an
// early sale cost anything - needs the individual buy-sell pairs, and those
// only exist by recomputing FIFO from `trades_YYYY`.
//
// ## The conventions here are AssetSync's, not invented
//
// They were derived by matching this module's output against the sheet's own
// realized rows, group by group, until every fully-covered one agreed to the
// dollar:
//
//   - **Cost is the gross buy amount.** The buy-side fee is NOT capitalised
//     into the lot. Adding it moved every single group off the sheet's figure
//     by roughly the fee, in the same direction - which is what identified the
//     convention rather than a bug.
//   - **Fee and tax are sell-side only**, apportioned across the matched
//     quantity when one sell fills from several lots.
//   - **pnl = proceeds - cost - feeTax**, matching the sheet's own columns.
//
// `reconcile()` re-runs that comparison at load time, so if AssetSync ever
// changes its mind the self-test board says so instead of this file quietly
// disagreeing with the rest of the site.
//
// ## Matching is per (broker, symbol), never per symbol
//
// The same ETF sits at more than one broker, and each broker sheet runs its own
// FIFO over its own account. Pooling them would match a buy at one broker
// against a sell at another, produce pairs that never happened, and put the
// year totals out by however much the two bases differ.
//
// ## Share units are restated before anything is matched
//
// The sheet records each fill in the units of its own trading day, so a lot
// bought before a split and sold after it is quoted in two different units.
// Every quantity here is multiplied into today's units by `splitFactor` first;
// amounts need no conversion, because money is a split invariant. Doing this
// the other way round - matching raw quantities - silently under- or
// over-consumes lots across a split and nothing downstream can detect it.
//
// ## Sells that no lot can cover
//
// A 股數補登 row may carry no per-share cost: the shares arrived from outside
// the brokerage feed and AssetSync resolved their basis from cost_override.json,
// which is not part of the workbook. Those shares are deliberately NOT added as
// lots - a zero-cost lot would book their entire proceeds as profit. So a sell
// can run out of lots, and when it does the shortfall is recorded in
// `uncovered` rather than matched against something invented. Every consumer
// has to treat a symbol listed there as having incomplete pairs, and say so.

import { splitFactor } from "./parse/adjustments.js";

/** @typedef {import('./types.js').Model} Model */
/** @typedef {import('./types.js').Broker} Broker */
/** @typedef {import('./types.js').Currency} Currency */
/** @typedef {import('./types.js').Adjustment} Adjustment */

/** Share counts below this are rounding dust, not a position. IBKR fills are fractional. */
const EPS = 1e-9;

/**
 * One closed buy-sell match. Amounts stay in the position's own currency -
 * conversion is the view's job, at the rate it chooses to show.
 *
 * `qty`, `buyPrice` and `sellPrice` are all in TODAY's share units, so they
 * stay comparable across a split and `qty * todayPrice` is a valid what-if.
 *
 * @typedef {object} FifoPair
 * @property {Broker}   broker
 * @property {string}   symbol
 * @property {string}   name
 * @property {Currency} currency
 * @property {'TW'|'US'} market
 * @property {string}   buyDate
 * @property {string}   sellDate
 * @property {number}   qty        matched shares, in today's units
 * @property {number}   buyPrice   per share, today's units
 * @property {number}   sellPrice  per share, today's units
 * @property {number}   cost       qty x buyPrice, gross - no buy-side fee
 * @property {number}   proceeds   qty x sellPrice, gross
 * @property {number}   feeTax     the sell's fee + tax, apportioned to `qty`
 * @property {number}   pnl        proceeds - cost - feeTax
 * @property {number|null} roi     pnl / cost; null for a zero-cost lot (配股)
 * @property {number}   days       calendar days held
 * @property {number}   year       the year the SELL happened, matching the sheet
 * @property {'trade'|'adjustment'} source  where the buy side came from
 */

/**
 * A lot that is still open at the end of the run.
 *
 * @typedef {object} OpenLot
 * @property {Broker}   broker
 * @property {string}   symbol
 * @property {string}   name
 * @property {Currency} currency
 * @property {string}   buyDate
 * @property {number}   qty
 * @property {number}   buyPrice
 * @property {number}   cost
 */

/**
 * Shares sold that no lot could cover, per (broker, symbol).
 *
 * @typedef {object} Uncovered
 * @property {Broker}  broker
 * @property {string}  symbol
 * @property {string}  name
 * @property {number}  qty        shares, today's units
 * @property {number}  proceeds   what those shares sold for
 * @property {number[]} years     the sell years affected
 */

/**
 * @typedef {object} FifoResult
 * @property {FifoPair[]} pairs
 * @property {OpenLot[]}  open
 * @property {Uncovered[]} uncovered
 */

/** An event on one (broker, symbol) timeline, already in today's share units. */
/**
 * @typedef {object} Event
 * @property {string} date
 * @property {'buy'|'sell'} side
 * @property {number} qty
 * @property {number} amount
 * @property {number} feeTax
 * @property {'trade'|'adjustment'} source
 * @property {number} order   tiebreaker within a day
 */

const key = (broker, symbol) => `${broker}|${symbol}`;

/** Calendar days between two `YYYY-MM-DD` strings. */
export function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86400000) : 0;
}

/**
 * Which brokers an adjustment's 適用範圍 covers.
 *
 * The sheet writes either a bare broker id (`fubon`) or prose naming several
 * (`台股 (fubon/sinopac)`), so this looks for ids inside the string rather than
 * matching it whole. A row naming none is skipped by the caller - guessing an
 * account for a share movement would put the shares in the wrong FIFO queue.
 *
 * @param {string} scope
 * @returns {Broker[]}
 */
export function brokersInScope(scope) {
  const s = scope.toLowerCase();
  return /** @type {Broker[]} */ (
    ["fubon", "sinopac", "ibkr"].filter((b) => s.includes(b)));
}

/**
 * Run FIFO over the whole workbook.
 *
 * Synchronous and network-free: everything it needs is in the model, which is
 * what lets the self-test run it on every load.
 *
 * @param {Model} m
 * @returns {FifoResult}
 */
export function match(m) {
  const A = m.adjustments;

  /** @type {Map<string, Event[]>} */
  const timelines = new Map();
  /** @type {Map<string, {name: string, currency: Currency, market: 'TW'|'US'}>} */
  const about = new Map();

  const add = (broker, symbol, ev) => {
    const k = key(broker, symbol);
    const list = timelines.get(k);
    if (list) list.push(ev);
    else timelines.set(k, [ev]);
  };

  m.trades.forEach((t, i) => {
    const k = key(t.broker, t.symbol);
    const known = about.get(k);
    if (!known) about.set(k, { name: t.name, currency: t.currency, market: t.market });
    else if (!known.name && t.name) known.name = t.name;
    add(t.broker, t.symbol, {
      date: t.date,
      side: t.side,
      // Into today's units before anything else touches it.
      qty: t.qty * splitFactor(A, t.symbol, t.date),
      amount: t.amount,
      // Buy-side fees are not capitalised - see the header. A buy carries none
      // into the lot, a sell carries fee + tax.
      feeTax: t.side === "sell" ? t.fee + t.tax : 0,
      source: "trade",
      // Sheet order within a day. The sheets are written in fill order, and
      // a same-day buy-then-sell must not be reordered into sell-then-buy.
      order: i + 1,
    });
  });

  for (const a of A) {
    // A split restates units; it adds no shares and is already applied above.
    if (a.kind === "split" || a.qty === null) continue;
    // No per-share cost means the basis is not in this workbook. Adding the
    // shares at zero would book their whole proceeds as profit, so they are
    // left out and the resulting shortfall is reported instead.
    if (a.costPerShare === null) continue;
    const qtyToday = a.unitsAsOfDate ? a.qty * splitFactor(A, a.symbol, a.date) : a.qty;
    if (qtyToday <= EPS) continue;
    for (const broker of brokersInScope(a.scope)) {
      const k = key(broker, a.symbol);
      const known = about.get(k);
      if (!known) {
        // A symbol whose only record is an adjustment has no trade row to take
        // a currency from; the scope names the account, so use the account's.
        about.set(k, {
          name: a.name,
          currency: /** @type {Currency} */ (broker === "ibkr" ? "USD" : "TWD"),
          market: /** @type {'TW'|'US'} */ (broker === "ibkr" ? "US" : "TW"),
        });
      } else if (!known.name && a.name) known.name = a.name;
      add(broker, a.symbol, {
        date: a.date,
        side: "buy",
        qty: qtyToday,
        // costPerShare is quoted per share as the row records it, so it pairs
        // with the row's own qty - not with the restated one.
        amount: a.qty * a.costPerShare,
        feeTax: 0,
        source: "adjustment",
        // Before that day's trades: shares that arrive from outside the feed
        // are a position that exists before anything is dealt against it.
        order: 0,
      });
    }
  }

  /** @type {FifoPair[]} */
  const pairs = [];
  /** @type {OpenLot[]} */
  const open = [];
  /** @type {Uncovered[]} */
  const uncovered = [];

  for (const [k, events] of timelines) {
    const [broker, symbol] = k.split("|");
    const meta = about.get(k) ?? {
      name: "", currency: /** @type {Currency} */ ("TWD"), market: /** @type {'TW'|'US'} */ ("TW"),
    };
    events.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.order - y.order));

    /** @type {{date: string, qty: number, price: number, source: 'trade'|'adjustment'}[]} */
    const lots = [];
    let shortQty = 0;
    let shortProceeds = 0;
    /** @type {Set<number>} */
    const shortYears = new Set();

    for (const ev of events) {
      if (ev.qty <= EPS) continue;
      if (ev.side === "buy") {
        lots.push({
          date: ev.date, qty: ev.qty, price: ev.amount / ev.qty, source: ev.source,
        });
        continue;
      }
      const sellPrice = ev.amount / ev.qty;
      const feePerShare = ev.feeTax / ev.qty;
      let left = ev.qty;
      while (left > EPS && lots.length) {
        const lot = lots[0];
        const q = Math.min(left, lot.qty);
        const cost = q * lot.price;
        const proceeds = q * sellPrice;
        const feeTax = q * feePerShare;
        const pnl = proceeds - cost - feeTax;
        pairs.push({
          broker: /** @type {Broker} */ (broker),
          symbol,
          name: meta.name,
          currency: meta.currency,
          market: meta.market,
          buyDate: lot.date,
          sellDate: ev.date,
          qty: q,
          buyPrice: lot.price,
          sellPrice,
          cost,
          proceeds,
          feeTax,
          pnl,
          // 配股 lots cost nothing, so their return is not a number - null,
          // never Infinity, and never a silent 0 that would drag an average.
          roi: cost > 0 ? pnl / cost : null,
          days: daysBetween(lot.date, ev.date),
          year: Number(ev.date.slice(0, 4)),
          source: lot.source,
        });
        lot.qty -= q;
        left -= q;
        if (lot.qty <= EPS) lots.shift();
      }
      if (left > EPS) {
        shortQty += left;
        shortProceeds += left * sellPrice;
        shortYears.add(Number(ev.date.slice(0, 4)));
      }
    }

    for (const lot of lots) {
      if (lot.qty <= EPS) continue;
      open.push({
        broker: /** @type {Broker} */ (broker),
        symbol,
        name: meta.name,
        currency: meta.currency,
        buyDate: lot.date,
        qty: lot.qty,
        buyPrice: lot.price,
        cost: lot.qty * lot.price,
      });
    }
    if (shortQty > EPS) {
      uncovered.push({
        broker: /** @type {Broker} */ (broker),
        symbol,
        name: meta.name,
        qty: shortQty,
        proceeds: shortProceeds,
        years: [...shortYears].sort((a, b) => a - b),
      });
    }
  }

  pairs.sort((a, b) => (a.sellDate < b.sellDate ? -1 : a.sellDate > b.sellDate ? 1 : 0));
  return { pairs, open, uncovered };
}

// ------------------------------------------------------------ reconciliation ---

/**
 * @typedef {object} ReconRow
 * @property {Broker} broker
 * @property {number} year
 * @property {string} symbol
 * @property {string} name
 * @property {Currency} currency
 * @property {number|null} fifo      this module's P&L for the group
 * @property {number|null} sheet     AssetSync's own figure
 * @property {number|null} diff
 * @property {number} tolerance
 * @property {boolean} comparable    false when a known gap rules the group out
 * @property {string} reason         why, when it is not comparable
 * @property {boolean} ok
 */

/**
 * Check this module against the workbook's own realized rows.
 *
 * The comparison is per (broker, year, symbol), which is exactly the grain the
 * sheet aggregates at - so a mismatch names the position rather than pointing
 * at a whole year. Two kinds of group are excluded up front, both for reasons
 * the workbook states about itself:
 *
 *   - `pending` rows, where AssetSync could not resolve a cost either and wrote
 *     prose into the number column.
 *   - Any (broker, symbol) with uncovered sells, whose basis lives in
 *     cost_override.json outside this file.
 *
 * Everything else must agree. The tolerance is a dollar, widened to a ten
 * thousandth of the cost for large positions: restating share units across a
 * split leaves both sides rounding a per-share figure in different places, and
 * that error scales with the position while a real matching fault does not - a
 * mis-consumed lot is off by a whole lot, orders of magnitude above this.
 *
 * @param {Model} m
 * @param {FifoResult} [result] pass one in to avoid matching twice
 * @returns {{rows: ReconRow[], compared: number, skipped: number, worst: ReconRow|null}}
 */
export function reconcile(m, result) {
  const { pairs, uncovered } = result ?? match(m);
  const blocked = new Set(uncovered.map((u) => key(u.broker, u.symbol)));

  /** @type {Map<string, {pnl: number, cost: number}>} */
  const mine = new Map();
  for (const p of pairs) {
    const k = `${p.broker}|${p.year}|${p.symbol}`;
    const cur = mine.get(k) ?? { pnl: 0, cost: 0 };
    cur.pnl += p.pnl;
    cur.cost += p.cost;
    mine.set(k, cur);
  }

  /** @type {ReconRow[]} */
  const rows = [];
  for (const r of m.realized) {
    const k = `${r.broker}|${r.year}|${r.symbol}`;
    const got = mine.get(k) ?? null;
    const tolerance = Math.max(1, (got?.cost ?? 0) * 1e-4);
    /** @type {ReconRow} */
    const row = {
      broker: r.broker, year: r.year, symbol: r.symbol, name: r.name,
      currency: r.currency,
      fifo: got ? got.pnl : null,
      sheet: r.pnl,
      diff: got && r.pnl !== null ? got.pnl - r.pnl : null,
      tolerance,
      comparable: true,
      reason: "",
      ok: true,
    };
    if (r.pending) {
      row.comparable = false;
      row.reason = "試算表的成本待補（cost_override.json）";
    } else if (blocked.has(key(r.broker, r.symbol))) {
      row.comparable = false;
      row.reason = "有買進成本不在試算表裡的股數（股數補登未填每股成本）";
    } else if (got === null) {
      row.comparable = false;
      row.reason = "本站沒有配對到這一組";
    }
    row.ok = !row.comparable || (row.diff !== null && Math.abs(row.diff) <= tolerance);
    rows.push(row);
  }

  rows.sort((a, b) => Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0));
  const comparableRows = rows.filter((r) => r.comparable);
  return {
    rows,
    compared: comparableRows.length,
    skipped: rows.length - comparableRows.length,
    worst: comparableRows.reduce(
      (a, r) => (a === null || Math.abs(r.diff ?? 0) > Math.abs(a.diff ?? 0) ? r : a),
      /** @type {ReconRow|null} */ (null)),
  };
}

// -------------------------------------------------------------- behaviour ---

/**
 * @typedef {object} FifoStats
 * @property {number} count
 * @property {number} wins
 * @property {number} losses
 * @property {number} flat
 * @property {number|null} winRate      wins / (wins + losses)
 * @property {number} grossProfit       TWD
 * @property {number} grossLoss         TWD, positive
 * @property {number|null} avgWin
 * @property {number|null} avgLoss      positive
 * @property {number|null} payoff       avgWin / avgLoss
 * @property {number|null} profitFactor grossProfit / grossLoss
 * @property {number|null} expectancy   TWD per closed pair
 * @property {number} net               TWD
 * @property {number|null} medianDays
 * @property {number|null} meanDays
 */

/**
 * Win rate, payoff ratio and expectancy over a set of pairs.
 *
 * Everything is converted to TWD first, because a payoff ratio built from a mix
 * of TWD and USD figures is arithmetic on two different units - it would come
 * out roughly thirty times too kind to the US side.
 *
 * A pair that lands exactly flat counts in neither column: it is neither a win
 * nor a loss, and putting it in either moves the rate without cause.
 *
 * @param {FifoPair[]} pairs
 * @param {number} rate USD/TWD
 * @returns {FifoStats}
 */
export function stats(pairs, rate) {
  const twd = (p) => (p.currency === "USD" ? p.pnl * rate : p.pnl);
  const values = pairs.map(twd);
  const wins = values.filter((v) => v > 0);
  const losses = values.filter((v) => v < 0);
  const grossProfit = wins.reduce((a, v) => a + v, 0);
  const grossLoss = -losses.reduce((a, v) => a + v, 0);
  const avgWin = wins.length ? grossProfit / wins.length : null;
  const avgLoss = losses.length ? grossLoss / losses.length : null;
  const decided = wins.length + losses.length;

  const days = pairs.map((p) => p.days).sort((a, b) => a - b);
  const mid = days.length
    ? (days.length % 2
        ? days[(days.length - 1) / 2]
        : (days[days.length / 2 - 1] + days[days.length / 2]) / 2)
    : null;

  return {
    count: pairs.length,
    wins: wins.length,
    losses: losses.length,
    flat: pairs.length - decided,
    winRate: decided ? wins.length / decided : null,
    grossProfit,
    grossLoss,
    avgWin,
    avgLoss,
    payoff: avgWin !== null && avgLoss ? avgWin / avgLoss : null,
    profitFactor: grossLoss ? grossProfit / grossLoss : null,
    // Per closed pair, over every pair including the flat ones - it is the
    // average outcome of deciding to close a position, not of winning one.
    expectancy: pairs.length ? (grossProfit - grossLoss) / pairs.length : null,
    net: grossProfit - grossLoss,
    medianDays: mid,
    meanDays: days.length ? days.reduce((a, v) => a + v, 0) / days.length : null,
  };
}

/**
 * Bucket values into a histogram over caller-supplied edges.
 *
 * Edges are the interior boundaries, so `[0, 30]` gives three buckets:
 * below 0, 0 to 30, and 30 and up. The caller supplies the labels because only
 * it knows whether the axis is days, per cent or dollars.
 *
 * @param {number[]} values
 * @param {number[]} edges ascending
 * @returns {number[]} one count per bucket, length edges.length + 1
 */
export function histogram(values, edges) {
  const counts = new Array(edges.length + 1).fill(0);
  for (const v of values) {
    let i = 0;
    while (i < edges.length && v >= edges[i]) i += 1;
    counts[i] += 1;
  }
  return counts;
}

/**
 * What happened to each sale afterwards: was the position bought back, or not?
 *
 * ## Why "sold too early" cannot be answered without this
 *
 * The obvious what-if - value the sold shares at today's price and compare
 * against what they fetched - quietly assumes the position was never re-entered.
 * Sell at a high, watch it fall, buy the same shares back cheaper, and that
 * arithmetic still calls the sale a mistake because the price is higher today
 * than it was on the day. It is not: the shares came back AND the difference
 * stayed in the account. Selling to buy back lower is the whole point of
 * trading a position rather than holding it, and a metric that scores it as a
 * loss is measuring the wrong thing.
 *
 * So sales are matched against LATER BUYS of the same (broker, symbol), FIFO,
 * exactly as buys are matched against later sells for realized P&L. The two
 * walks are independent views of one timeline: that one asks what a purchase
 * eventually earned, this one asks what a sale eventually cost.
 *
 * Each returned segment carries the reference price its cost should be measured
 * against - the buy-back price where there was one, and nothing where the shares
 * never came back, leaving the caller to use today's price for those. Only real
 * buy orders count as a repurchase: a stock dividend or a share top-up is not a
 * decision to get back in.
 *
 * @typedef {object} SoldShares
 * @property {Broker}   broker
 * @property {string}   symbol
 * @property {string}   name
 * @property {Currency} currency
 * @property {string}   sellDate
 * @property {number}   sellPrice  per share, today's units
 * @property {number}   qty        today's units
 * @property {string|null} backDate   null when never repurchased
 * @property {number|null} backPrice
 * @property {number|null} gapDays    days between the sale and the buy-back
 */

/**
 * @param {Model} m
 * @returns {SoldShares[]}
 */
export function sellFollowUps(m) {
  const A = m.adjustments;
  /** @type {Map<string, {name: string, currency: Currency}>} */
  const about = new Map();
  /** @type {Map<string, {date: string, side: 'buy'|'sell', qty: number, price: number}[]>} */
  const timelines = new Map();

  for (const t of m.trades) {
    const k = key(t.broker, t.symbol);
    if (!about.has(k)) about.set(k, { name: t.name, currency: t.currency });
    const qty = t.qty * splitFactor(A, t.symbol, t.date);
    if (qty <= EPS) continue;
    const list = timelines.get(k);
    const ev = { date: t.date, side: t.side, qty, price: t.amount / qty };
    if (list) list.push(ev);
    else timelines.set(k, [ev]);
  }

  /** @type {SoldShares[]} */
  const out = [];
  for (const [k, events] of timelines) {
    const [broker, symbol] = k.split("|");
    const meta = about.get(k) ?? { name: "", currency: /** @type {Currency} */ ("TWD") };
    /** @type {{date: string, qty: number, price: number}[]} */
    const sold = [];

    for (const ev of events) {
      if (ev.side === "sell") {
        sold.push({ date: ev.date, qty: ev.qty, price: ev.price });
        continue;
      }
      // A buy repays the oldest outstanding sale first. Anything left over is
      // a genuinely new position and closes nothing.
      let left = ev.qty;
      while (left > EPS && sold.length) {
        const s = sold[0];
        const q = Math.min(left, s.qty);
        out.push({
          broker: /** @type {Broker} */ (broker),
          symbol, name: meta.name, currency: meta.currency,
          sellDate: s.date, sellPrice: s.price, qty: q,
          backDate: ev.date, backPrice: ev.price,
          gapDays: daysBetween(s.date, ev.date),
        });
        s.qty -= q;
        left -= q;
        if (s.qty <= EPS) sold.shift();
      }
    }

    for (const s of sold) {
      if (s.qty <= EPS) continue;
      out.push({
        broker: /** @type {Broker} */ (broker),
        symbol, name: meta.name, currency: meta.currency,
        sellDate: s.date, sellPrice: s.price, qty: s.qty,
        backDate: null, backPrice: null, gapDays: null,
      });
    }
  }

  out.sort((a, b) => (a.sellDate < b.sellDate ? -1 : a.sellDate > b.sellDate ? 1 : 0));
  return out;
}

/**
 * Every buy, with the average cost of the position it was added to.
 *
 * The question is whether a top-up went in below the price already paid
 * (averaging down) or above it (chasing). That needs the running average at the
 * moment of the buy, which is a FIFO walk of its own - the same (broker,
 * symbol) queues, but reading the book instead of closing it.
 *
 * The first buy into an empty position has nothing to compare against and is
 * returned with `avgCost: null`, not dropped: the count of opening buys is
 * itself part of the answer.
 *
 * @param {Model} m
 * @returns {{broker: Broker, symbol: string, name: string, currency: Currency,
 *            date: string, qty: number, price: number, amount: number,
 *            avgCost: number|null, premium: number|null, heldQty: number}[]}
 */
export function addOns(m) {
  const A = m.adjustments;
  /** @type {Map<string, {qty: number, cost: number}>} */
  const book = new Map();
  const out = [];

  for (const t of m.trades) {
    const k = key(t.broker, t.symbol);
    const pos = book.get(k) ?? { qty: 0, cost: 0 };
    // Today's units on both sides of the division, so a split cannot make the
    // running average jump by the split ratio.
    const qty = t.qty * splitFactor(A, t.symbol, t.date);
    const price = qty > 0 ? t.amount / qty : 0;

    if (t.side === "buy") {
      const avgCost = pos.qty > EPS ? pos.cost / pos.qty : null;
      out.push({
        broker: t.broker, symbol: t.symbol, name: t.name, currency: t.currency,
        date: t.date, qty, price, amount: t.amount,
        avgCost,
        premium: avgCost ? (price - avgCost) / avgCost : null,
        heldQty: pos.qty,
      });
      pos.qty += qty;
      pos.cost += t.amount;
    } else {
      // A sell takes cost out at the average, which keeps the remaining
      // average where it was - the standard moving-average book. FIFO would
      // move it, and the reader's mental model of "my average cost" is the
      // broker's, which is this one.
      const avg = pos.qty > EPS ? pos.cost / pos.qty : 0;
      pos.qty = Math.max(0, pos.qty - qty);
      pos.cost = pos.qty > EPS ? pos.qty * avg : 0;
    }
    book.set(k, pos);
  }
  return out;
}
