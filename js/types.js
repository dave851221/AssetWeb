// The normalised model, defined once so `checkJs` can hold every parser and
// every view to it. Imports nothing and exports nothing on purpose - other
// modules pull these in with `@typedef {import('./types.js').Trade} Trade`.
//
// The rule that runs through all of it: **null is not zero.** A blank cell in
// this workbook means "not applicable" (a broker that was disabled that run) or
// "unresolved" (a FIFO cost awaiting cost_override.json) - never zero. Nothing
// in the model coerces null into a number.

/** @typedef {'fubon'|'sinopac'|'ibkr'|'manual'} Broker */
/** @typedef {'TWD'|'USD'} Currency */
/** @typedef {'TW'|'US'} Market */

/**
 * One filled order, from a `trades_<year>` sheet. Literal values, no formulas.
 *
 * @typedef {object} Trade
 * @property {string}   date      `YYYY-MM-DD`, stored as a string in the sheet
 * @property {Broker}   broker
 * @property {string}   symbol    bare code, no exchange suffix: `2330`, `VOO`
 * @property {string}   name      zh-TW for TW, English for US; empty if delisted
 * @property {'buy'|'sell'} side  the sheet stores 買 / 賣
 * @property {number}   qty       SHARES, never lots; may be fractional (IBKR)
 * @property {number}   price     per share, in `currency`
 * @property {number}   amount    qty x price, gross
 * @property {number}   fee       positive; ESTIMATED for fubon, actual otherwise
 * @property {number}   tax       sell side only; always 0 for IBKR
 * @property {number}   net       signed: negative for buys, positive for sells
 * @property {string}   orderNo   only unique within (broker, date) - see fubon
 * @property {Currency} currency
 * @property {Market}   market    derived from currency
 * @property {number}   year      derived from date
 */

/**
 * A current position, from a broker sheet's 持股庫存 block. Original currency.
 *
 * @typedef {object} Holding
 * @property {Broker}   broker
 * @property {string}   symbol
 * @property {string}   name
 * @property {number}   qty
 * @property {number|null} avgCost      per share
 * @property {number|null} price        broker's snapshot at run time
 * @property {number|null} marketValue
 * @property {number|null} unrealizedPnl
 * @property {number|null} roi          already a fraction (0.2479 = +24.79%)
 * @property {Currency} currency
 * @property {boolean}  delisted        blank name and price 0
 */

/**
 * Realized P&L, aggregated per (symbol, year) by AssetSync's FIFO - NOT per
 * trade. Reconstructing individual matches means recomputing FIFO from trades.
 *
 * @typedef {object} Realized
 * @property {Broker}   broker
 * @property {number}   year
 * @property {string}   symbol
 * @property {string}   name
 * @property {number|null} qty        shares sold
 * @property {number|null} proceeds
 * @property {number|null} cost       null when the sheet showed the no-value dash
 * @property {number|null} feeTax     fee + tax combined
 * @property {number|null} pnl        null when `pending`
 * @property {number|null} roi        fraction
 * @property {Currency} currency
 * @property {boolean}  pending       sheet held 「請填入 cost_override.json」
 */

/**
 * Dividend income, per (symbol, ex-date). `cash` is CASH ONLY - a stock
 * dividend is reported as a share count with no monetary value, deliberately,
 * so that adding `cash` up never double-counts.
 *
 * @typedef {object} Dividend
 * @property {Broker}   broker
 * @property {number}   year
 * @property {string}   symbol
 * @property {string}   name
 * @property {string|null} exDate       `YYYY-MM-DD`
 * @property {number|null} qty          shares held on the ex-date
 * @property {number|null} perShare
 * @property {number|null} cash         cash dividend income
 * @property {number|null} perThousand  bonus shares per 1,000 held
 * @property {number|null} shares       bonus shares allotted
 * @property {Currency} currency
 */

/**
 * A broker's cash position, from the 交割戶餘額 / 帳戶餘額 block.
 *
 * `pending` is the T+2 unsettled net. Note that `history` reports
 * balance + pending as one number, so its 富邦現金 will not match `balance`.
 *
 * @typedef {object} Balance
 * @property {Broker}   broker
 * @property {Currency} currency
 * @property {number|null} balance
 * @property {number|null} pending   null when nothing is pending
 * @property {number|null} equity    IBKR only: account net value
 * @property {string|null} updatedAt that broker sheet's own row-1 timestamp
 */

/**
 * One per-broker slice of a history row. Any of these is null when the broker
 * was disabled on that run - sparse columns are normal, not corruption.
 *
 * @typedef {object} HistorySlice
 * @property {number|null} cash   net_cash: balance + T+2 pending
 * @property {number|null} stock  market value
 * @property {number|null} total
 */

/**
 * A daily snapshot. One row per calendar day; a same-day rerun overwrites the
 * last row rather than appending.
 *
 * IBKR figures are already converted to TWD by AssetSync, using `rate`.
 *
 * @typedef {object} HistoryRow
 * @property {string}  ts           ISO timestamp
 * @property {string}  day          `YYYY-MM-DD`
 * @property {HistorySlice} fubon
 * @property {HistorySlice} sinopac
 * @property {HistorySlice} ibkr
 * @property {number|null} rate        USD/TWD spot at run time
 * @property {number|null} manualCash
 * @property {number|null} manualStock
 * @property {number}  total        TWD grand total
 * @property {number|null} change   delta vs the previous row; 0 on the first
 */

/**
 * A share-count change that is not a trade, from the `adjustments` sheet.
 *
 * `unitsAsOfDate` is the trap: false means `qty` is already in today's units
 * and later splits must not be applied to it again (AssetSync has done that
 * already); true means it is in its own date's units and they still apply.
 *
 * @typedef {object} Adjustment
 * @property {string} date
 * @property {string} symbol
 * @property {string} name
 * @property {string} scope        e.g. `fubon`, `ibkr`, `台股 (fubon/sinopac)`
 * @property {'split'|'topup'|'stock-dividend'} kind
 * @property {string} kindLabel    the sheet's own wording, for display
 * @property {number|null} qty     null for a split, which adds no shares
 * @property {boolean} unitsAsOfDate
 * @property {number|null} ratio   split ratio; null for the other kinds
 * @property {number|null} costPerShare  set makes it a FIFO buy too; 0 for 配股
 * @property {string} note
 */

/**
 * A user-entered asset from the `manual` sheet - bank deposits, and the
 * 富邦美股複委託 holdings that have no API.
 *
 * @typedef {object} ManualItem
 * @property {string}  item
 * @property {number}  amount   TWD
 * @property {'cash'|'stock'} type  anything other than 持股市值 counts as cash
 * @property {string}  note
 */

/**
 * @typedef {object} Meta
 * @property {string}   fileName
 * @property {string}   fetchedAt    ISO, when this browser read the file
 * @property {string|null} updatedAt AssetSync's own run timestamp
 * @property {number|null} usdTwdRate latest rate, from the last history row
 * @property {string[]} sheetNames
 * @property {string[]} warnings     parser complaints worth showing the user
 */

/**
 * @typedef {object} Model
 * @property {Meta}          meta
 * @property {Trade[]}       trades
 * @property {Holding[]}     holdings
 * @property {Realized[]}    realized
 * @property {Dividend[]}    dividends
 * @property {Balance[]}     balances
 * @property {HistoryRow[]}  history
 * @property {ManualItem[]}  manual
 * @property {Adjustment[]}  adjustments
 *
 * `sheetTotals` exists so the parse can check itself: these are the block 小計
 * rows, figures the spreadsheet computed and the parser deliberately skips as
 * data. Comparing them against the sums of the parsed rows is an independent
 * verification that needs no external expectations file and stays valid however
 * often the workbook is refreshed.
 *
 * @property {import('./parse/broker.js').SheetTotals[]} sheetTotals
 */

/**
 * A sheet as a dense grid of raw cell values: numbers stay numbers, dates are
 * Date objects, blanks are null. Rows are padded so `grid[r][c]` never throws.
 *
 * @typedef {(string|number|Date|boolean|null)[][]} Grid
 */

export {};
