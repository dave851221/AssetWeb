// The shell: sign-in, cache-first paint, background refresh, tabs.
//
// Load order is the whole user experience:
//   1. paint whatever is in localStorage, labelled with its age
//   2. get a fresh token silently, in the background
//   3. re-read the workbook and swap the screen underneath the reader
//
// Inverting 1 and 2 turns every visit into a blank second or two. Every failure
// mode below keeps the cached screen up and adds a banner or an amber dot -
// none of them is allowed to become a white page.

import { STORAGE, missingConfig } from "./config.js";
import * as auth from "./auth.js";
import { SilentAuthFailure } from "./auth.js";
import { DriveAccessError, DriveShapeError } from "./drive.js";
import { WorkbookShapeError } from "./parse/workbook.js";
import { readCache, clearCache, refreshAll, loadFixture } from "./store.js";
import { clearPriceCache, cacheStats } from "./market.js";
import { el, clear, dateTime, ago, errText } from "./util.js";
import { disposeIn } from "./charts.js";

import * as overview from "./views/overview.js";
import * as assets from "./views/assets.js";
import * as positions from "./views/positions.js";
import * as pnl from "./views/pnl.js";
import * as trades from "./views/trades.js";
import * as selftest from "./views/selftest.js";

/** @typedef {import('./types.js').Model} Model */

/**
 * Tabs, in order of how often they get opened.
 *
 * 自我測試 is marked hidden: it is a diagnostic, not a dashboard, so it stays
 * out of the nav and is reached with `?selftest=1` or `?tab=selftest`. It is
 * still worth shipping - its structural half needs no expectations file, so if
 * AssetSync changes a column and a parser starts mis-reading it silently, that
 * board is where it shows up.
 */
const VIEWS = /** @type {const} */ ([
  ["overview", "總覽", overview, false],
  ["assets", "資產走勢", assets, false],
  ["positions", "持股", positions, false],
  ["pnl", "損益", pnl, false],
  ["trades", "交易明細", trades, false],
  ["selftest", "自我測試", selftest, true],
]);

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @type {{model: Model|null, tab: string, arg: any, refreshing: boolean}} */
const state = { model: null, tab: VIEWS[0][0], arg: null, refreshing: false };

// Views ask the shell to jump elsewhere by dispatching an event rather than
// importing this module - boot.js already imports all of them, and an import
// back would close the cycle.
document.addEventListener("nav", (ev) => {
  const detail = /** @type {CustomEvent} */ (ev).detail;
  state.tab = detail.tab;
  state.arg = detail.arg;
  renderTabs();
  renderView();
  window.scrollTo({ top: 0 });
});

// ---------------------------------------------------------------- banners ---

/**
 * @param {string} id
 * @param {{text: string, kind?: string, action?: {label: string, run: () => void}|null}} opts
 */
function banner(id, { text, kind = "", action = null }) {
  dismiss(id);
  $("banners").append(el("div", { class: `banner ${kind}`, dataset: { id } }, [
    el("span", { class: "icon", text: kind === "bad" ? "⛔" : "⚠️" }),
    el("span", { text }),
    el("span", { class: "spacer" }),
    action ? el("button", { class: "btn", text: action.label, onclick: action.run }) : null,
    el("button", { class: "btn", text: "✕", onclick: () => dismiss(id) }),
  ]));
}
function dismiss(id) {
  $("banners").querySelectorAll(`[data-id="${id}"]`).forEach((n) => n.remove());
}

// -------------------------------------------------------------- rendering ---

function renderTabs() {
  const nav = $("tabs");
  nav.hidden = false;
  clear(nav);
  for (const [id, label, , hidden] of VIEWS) {
    // A hidden tab appears only while it is the one being shown, so a deep
    // link still tells you where you are and gives you a way back out.
    if (hidden && id !== state.tab) continue;
    nav.append(el("button", {
      class: "tab", role: "tab", "aria-selected": String(id === state.tab),
      text: label,
      onclick: () => { state.tab = id; renderTabs(); renderView(); },
    }));
  }
}

/**
 * Tear down the ECharts instances the outgoing view created.
 *
 * Unlike hand-rolled SVG, ECharts holds a canvas, a ResizeObserver and an
 * animation frame per chart. Dropping the DOM node releases none of that, so
 * ten tab switches would leak ten charts' worth. `card()` collects the
 * instances it owns in `node.charts`; disposeIn walks them.
 */
const disposeCharts = disposeIn;

function renderView() {
  const main = $("main");
  disposeCharts(main);
  clear(main);
  if (!state.model) return;
  const entry = VIEWS.find(([id]) => id === state.tab) ?? VIEWS[0];
  const arg = state.arg;
  state.arg = null;          // one-shot: a later tab click starts clean
  try {
    main.append(entry[2].render(state.model, arg));
  } catch (err) {
    // One broken view must not take the app down with it.
    console.error(err);
    main.append(el("div", { class: "empty", text: `這個畫面畫不出來：${errText(err)}` }));
  }
  main.classList.toggle("refreshing", state.refreshing);
}

/** @param {Model} model */
function renderChrome(model) {
  const at = model.meta.fetchedAt;
  $("freshness").hidden = false;
  const stale = Date.now() - new Date(at).getTime() > 6 * 3600 * 1000;
  $("freshness").classList.toggle("stale", stale);
  $("freshness-text").textContent = `資料時間 ${dateTime(at)}（${ago(at)}）`;
  $("btn-refresh").hidden = false;
  $("menu-file").textContent = model.meta.fileName || auth.fileName() || "—";
  $("menu-fetched").textContent = dateTime(at);
  $("menu-updated").textContent = dateTime(model.meta.updatedAt);
}

/** @param {Model} model */
function show(model) {
  state.model = model;
  renderChrome(model);
  renderTabs();
  renderView();
  if (model.meta.warnings.length) {
    banner("parse", {
      text: `解析時有 ${model.meta.warnings.length} 個警告，數字可能不完整。`,
      kind: "warn",
      action: {
        label: "查看",
        run: () => { state.tab = "selftest"; renderTabs(); renderView(); },
      },
    });
  } else {
    dismiss("parse");
  }
}

// ----------------------------------------------------------------- errors ---

/**
 * A dead end with a sentence.
 *
 * `wipe` is only true when access is genuinely gone. A mis-picked file or a
 * temporarily malformed workbook must not cost the user the cached data they
 * could otherwise still read.
 */
function blocked(text, withRepick, wipe = false) {
  if (wipe) clearCache();
  state.model = null;
  $("tabs").hidden = true;
  $("freshness").hidden = true;
  $("btn-refresh").hidden = true;
  const main = $("main");
  disposeCharts(main);
  clear(main);
  main.append(el("section", { class: "gate" }, [
    el("h1", { text: "無法載入" }),
    el("p", { class: "gate-lead", text }),
    withRepick
      ? el("button", { class: "btn btn-primary btn-lg", text: "重新選擇檔案", onclick: repick })
      : null,
  ]));
}

/**
 * Everything that can go wrong on the way in, turned into a sentence.
 *
 * @param {any} err
 */
function handle(err) {
  if (err instanceof SilentAuthFailure) {
    // Not an error, and not worth a banner: it is simply how this flow works.
    // Google's token popup must be opened by a click, so a lapsed token means
    // the next refresh has to be the user's. The screen already carries both
    // halves of that message - the data timestamp and a 重新整理資料 button -
    // so all this adds is the amber dot saying "this is not live".
    console.debug("需要使用者按一下才能換 token（Google 的彈出視窗限制）");
    $("freshness").classList.add("stale");
    $("btn-refresh").title = "資料是上次載入的。按一下重新確認身分並更新。";
    return;
  }
  console.warn(err);
  if (err instanceof WorkbookShapeError) {
    blocked(`這份檔案不是 AssetSync 的試算表，請重新選擇。（${err.message}）`, true);
    return;
  }
  if (err instanceof DriveShapeError) {
    blocked(err.message, true);
    return;
  }
  if (err instanceof DriveAccessError) {
    // 404 means moved or deleted, 403 means the share is gone. Both are fixed
    // by picking again; neither justifies discarding the cache, since the file
    // may well come back.
    blocked(`${err.message}。請重新選擇檔案。`, true);
    return;
  }
  if (String(err.message) === "NO_FILE") {
    repick();
    return;
  }
  banner("net", {
    text: `更新資料失敗：${errText(err)}`,
    kind: "warn",
    action: { label: "重試", run: () => refresh({ interactive: false }) },
  });
}

// ------------------------------------------------------------------ flows ---

async function refresh({ interactive }) {
  if (state.refreshing) return;
  state.refreshing = true;
  $("main").classList.add("refreshing");     // hold the old render, no skeleton flash
  /** @type {HTMLButtonElement} */ ($("btn-refresh")).disabled = true;
  try {
    const model = await refreshAll({ interactive });
    dismiss("net");
    $("btn-refresh").title = "";      // a successful load clears the amber hint
    show(model);
    auth.whoami().then((mail) => { if (mail) $("menu-user").textContent = mail; });
  } catch (err) {
    handle(err);
  } finally {
    state.refreshing = false;
    $("main").classList.remove("refreshing");
    /** @type {HTMLButtonElement} */ ($("btn-refresh")).disabled = false;
    $("main").classList.toggle("refreshing", false);
  }
}

async function start() {
  // Only when we have nothing usable: signIn() opens a popup, and the stored
  // token already covers reloads inside the hour.
  if (!auth.hasToken()) {
    try {
      await auth.signIn();
    } catch (err) {
      const note = $("gate-note");
      if (note) note.textContent = `登入失敗：${errText(err)}`;
      return;
    }
  }
  if (!auth.fileId()) {
    const picked = await auth.pickFile();
    if (!picked) return;
  }
  await refresh({ interactive: true });
}

async function repick() {
  try {
    if (!auth.hasToken()) await auth.signIn();
    const picked = await auth.pickFile();
    if (!picked) return;
    clearCache();
    await refresh({ interactive: true });
  } catch (err) {
    handle(err);
  }
}

function signOut() {
  auth.forget();
  clearCache();
  try {
    localStorage.removeItem(STORAGE.FILE_ID);
    localStorage.removeItem(STORAGE.FILE_NAME);
  } catch { /* ignore */ }
  location.reload();
}

// ------------------------------------------------------------------- boot ---

/** How much price history is on disk, in the menu's info block. */
function showPriceCache() {
  const { symbols, bytes } = cacheStats();
  $("menu-prices").textContent = symbols
    ? `${symbols} 檔 · ${Math.round(bytes / 1024)} KB`
    : "無";
}

function wireMenu() {
  const panel = $("menu-panel");
  $("btn-menu").addEventListener("click", (ev) => {
    ev.stopPropagation();
    panel.hidden = !panel.hidden;
    $("btn-menu").setAttribute("aria-expanded", String(!panel.hidden));
  });
  document.addEventListener("click", (ev) => {
    if (!panel.hidden && !panel.contains(/** @type {Node} */ (ev.target))) panel.hidden = true;
  });
  // Both of these are clicks, so they may open Google's popup if the token has
  // lapsed - which is the only moment we are allowed to.
  $("menu-refresh").addEventListener("click", () => refresh({ interactive: true }));
  $("menu-repick").addEventListener("click", repick);
  // Historical prices are cached per symbol so a session stays inside the
  // anonymous request ceiling. Clearing is the escape hatch when a series looks
  // wrong or stale - it costs nothing but a refetch.
  $("menu-clear-prices").addEventListener("click", () => {
    clearPriceCache();
    showPriceCache();
  });
  $("menu-signout").addEventListener("click", signOut);
  $("btn-refresh").addEventListener("click", () => refresh({ interactive: true }));
  showPriceCache();
}

/**
 * Offline development: `?dev=1` reads dev-data.xlsx and skips Google entirely.
 *
 * The fixture is the workbook itself, not a pre-parsed snapshot, so this path
 * exercises the real parser - which is where all the complexity lives. It is
 * gitignored: it holds real account data.
 */
async function devMode() {
  const model = await loadFixture();
  banner("dev", {
    text: "開發模式：資料來自本機 dev-data.xlsx，沒有經過任何驗證。",
    kind: "warn",
  });
  show(model);
}

/**
 * What to do when config.js is not filled in yet.
 *
 * Names the missing keys and where each one comes from, because "it failed
 * inside Google's SDK" is the least actionable error this app could give.
 */
function setupScreen(missing) {
  const WHERE = {
    GOOGLE_CLIENT_ID: "APIs & Services → Credentials → Create OAuth client ID → Web application。"
      + "授權來源填 http://localhost:8899 、 http://127.0.0.1:8899 、 https://dave851221.github.io，"
      + "Redirect URI 留空。",
    GOOGLE_API_KEY: "同一頁 → Create credentials → API key。"
      + "建好後按 Edit，Application restrictions 選 Websites 並填上同樣的來源，"
      + "API restrictions 限定 Google Picker API。",
    GOOGLE_APP_ID: "Google Cloud 首頁 Project info 的「專案編號」（Project number），"
      + "也就是 client ID 開頭那串數字。",
  };
  const main = $("main");
  clear(main);
  main.append(el("section", { class: "gate" }, [
    el("h1", { text: "尚未設定" }),
    el("p", { class: "gate-lead", html: `請填好 <code>js/config.js</code> 裡的 ${missing.length} 個值：` }),
    el("ul", { class: "setup-list" }, missing.map((k) => el("li", {}, [
      el("code", { text: k }),
      el("span", { text: "　" + (WHERE[k] || "") }),
    ]))),
    el("p", {
      class: "gate-lead",
      html: "三個值必須來自<b>同一個 GCP 專案</b>，並且該專案要啟用 "
        + "<b>Google Picker API</b> 與 <b>Google Drive API</b>。",
    }),
    el("p", {
      class: "gate-lead",
      html: "只想先看資料解析結果的話，用 <code>?dev=1</code> 開啟離線模式。",
    }),
  ]));
}

async function main() {
  wireMenu();

  const params = new URLSearchParams(location.search);
  // Deep links, for checking one view in one step instead of loading and then
  // clicking: ?selftest=1 for the report card, ?tab=<id> for any view.
  if (params.has("selftest")) state.tab = "selftest";
  const wanted = params.get("tab");
  if (wanted && VIEWS.some(([id]) => id === wanted)) state.tab = wanted;
  // ?symbol=2330 opens 交易明細 already filtered, so a stock can be linked to.
  const symbol = params.get("symbol");
  if (symbol) { state.tab = "trades"; state.arg = symbol; }

  if (params.has("dev")) {
    try { await devMode(); } catch (err) { blocked(errText(err), false); }
    return;
  }

  const missing = missingConfig();
  if (missing.length) {
    setupScreen(missing);
    return;
  }

  // 1. Cache first - the screen is up before anything touches the network.
  const cached = readCache();
  if (cached && auth.fileId()) show(cached);
  else $("btn-signin").addEventListener("click", start);

  // 2. Then the SDKs, then whatever token we already have, then fresh data.
  try {
    await auth.init();
  } catch (err) {
    if (cached) banner("net", { text: `Google 服務載入失敗：${errText(err)}`, kind: "warn" });
    else blocked(`Google 服務載入失敗：${errText(err)}`, false);
    return;
  }
  if (cached && auth.fileId()) await refresh({ interactive: false });
}

main();
