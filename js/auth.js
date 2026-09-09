// Google sign-in and the file picker.
//
// One credential in the whole system: a Google access token, good for an hour.
// No session of our own - reading the file needs a fresh Google token anyway,
// so a long-lived cookie would save nothing and slow down revocation. The
// smooth second visit comes from the cache (store.js), not from a longer-lived
// credential.
//
// `drive.file` means this app can only ever see files the user handed it
// through the picker. That is what keeps the consent screen non-sensitive, and
// it is also the gate: a workbook nobody shared with you never appears.
//
// Copied, almost unchanged, from the ro-guild-portal project. Three of the
// decisions below are scar tissue from that one - each comment says which.

import { CONFIG, SCOPES, STORAGE, XLSX_MIME } from "./config.js";

export class SilentAuthFailure extends Error {}

let ready = false;
/** @type {string|null} */
let accessToken = null;
let expiresAt = 0;
let pickerReady = false;

/**
 * The token survives a reload, in sessionStorage.
 *
 * This is not an optimisation, it is the only way a reload can be silent at
 * all: GIS always mints tokens through a popup - `prompt: "none"` included -
 * and a popup that no click asked for is blocked, which is exactly the
 * `popup_failed_to_open` you get from calling requestAccessToken() on load.
 * Keeping the hour-long token means a reload inside that hour needs no popup.
 *
 * sessionStorage rather than localStorage: it dies with the tab, so a token
 * does not sit on disk between sessions. The cached workbook data
 * (localStorage) is a deliberate exception - it is read-only and already on
 * this machine.
 */
function loadStoredToken() {
  try {
    const raw = sessionStorage.getItem(STORAGE.TOKEN);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved && saved.token && saved.expiresAt > Date.now()) {
      accessToken = saved.token;
      expiresAt = saved.expiresAt;
    }
  } catch { /* storage disabled - just means a click is needed */ }
}

function storeToken() {
  try {
    sessionStorage.setItem(STORAGE.TOKEN, JSON.stringify({ token: accessToken, expiresAt }));
  } catch { /* ignore */ }
}

loadStoredToken();

/**
 * The address that signed in last, for Google's `hint`.
 *
 * Without it, anyone signed into more than one Google account gets the account
 * chooser on every single token request - and since a lapsed token needs a
 * click anyway, that chooser is what makes a routine refresh feel like logging
 * in again. With it, Google goes straight to the account already granted and
 * the window closes by itself.
 *
 * A hint, not a restriction: if that account cannot be used Google falls back
 * to asking, so a stale value costs nothing.
 */
function hint() {
  try {
    return localStorage.getItem(STORAGE.EMAIL) || undefined;
  } catch {
    return undefined;
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.async = true; s.defer = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`載入失敗：${src}`));
    document.head.append(s);
  });
}

/** Load Google's two SDKs. Deferred to runtime so the cached screen paints
 *  before anything touches the network. */
export async function init() {
  await Promise.all([
    loadScript("https://accounts.google.com/gsi/client"),
    loadScript("https://apis.google.com/js/api.js"),
  ]);
  await new Promise((resolve) => {
    /** @type {any} */ (window).gapi.load("picker", () => { pickerReady = true; resolve(null); });
  });
  ready = true;
}

/**
 * Ask Google for a token. **Must be called from a user gesture** - it opens a
 * popup, whatever `prompt` says.
 *
 * A fresh client per request, with both callbacks in the config object: that is
 * the documented shape. Reassigning `.callback`/`.error_callback` on a
 * long-lived client works for the success path but is not contractual for the
 * error path, and the error path is exactly the one this app has to handle.
 *
 * @param {string} prompt
 * @returns {Promise<string>}
 */
function request(prompt) {
  if (!ready) return Promise.reject(new Error("Google 服務尚未載入"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => (arg) => { if (!settled) { settled = true; fn(arg); } };
    const fail = done((err) => reject(new Error(String(err))));
    const google = /** @type {any} */ (window).google;
    const client = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      scope: SCOPES,
      hint: hint(),
      callback: (resp) => {
        if (resp.error) return fail(resp.error_description || resp.error);
        accessToken = resp.access_token;
        // Renew a minute early; a token that expires mid-request costs a retry.
        expiresAt = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
        storeToken();
        done(resolve)(accessToken);
      },
      error_callback: (err) => fail(err?.type || "failed"),
    });
    try {
      client.requestAccessToken({ prompt });
    } catch (err) {
      fail(err);
    }
  });
}

/**
 * Interactive sign-in. Exactly one popup, opened synchronously inside the
 * click.
 *
 * An earlier version tried `prompt:"none"` first and fell back to `prompt:""`.
 * That cannot work: the fallback runs after an `await`, by which point the
 * click's transient activation has been spent on the first attempt, so the
 * browser blocks the second popup - `popup_failed_to_open` on a button the
 * user did press. One gesture buys one popup; spend it on the call that can
 * actually finish. With consent already granted `prompt:""` does not ask again.
 */
export const signIn = () => request("");

/**
 * A usable token.
 *
 * `silent: true` means "use what we already have or give up" - it deliberately
 * does **not** call Google. There is no such thing as a background token
 * refresh in this flow: GIS opens a popup every time, and a popup with no click
 * behind it is blocked. Trying anyway would put a console error on every page
 * load and still fail.
 *
 * So the deal is: within the hour the stored token covers reloads with zero
 * clicks, and after that the caller catches SilentAuthFailure and shows the
 * cached data plus one button. Never a blank screen, never a forced sign-in.
 *
 * @param {{silent?: boolean}} [opts]
 * @returns {Promise<string>}
 */
export async function token({ silent = true } = {}) {
  if (accessToken && Date.now() < expiresAt) return accessToken;
  if (silent) throw new SilentAuthFailure("需要重新確認身分");
  return signIn();
}

export const hasToken = () => Boolean(accessToken) && Date.now() < expiresAt;

/** Drop the cached token locally. The grant stays, so signIn() needs no consent. */
export function clearToken() {
  accessToken = null;
  expiresAt = 0;
  try { sessionStorage.removeItem(STORAGE.TOKEN); } catch { /* ignore */ }
}

/**
 * Sign out for real: revoke the grant at Google.
 *
 * Only for the explicit 登出 action. Never on a 401 - revoking withdraws the
 * drive.file permission too, so the user would have to walk back through the
 * consent screen *and* the file picker to recover from a merely expired token.
 */
export function forget() {
  const google = /** @type {any} */ (window).google;
  if (accessToken && google?.accounts?.oauth2) {
    try { google.accounts.oauth2.revoke(accessToken, () => {}); } catch { /* best effort */ }
  }
  clearToken();
  // The hint goes too, and only here: 登出 is the one moment somebody may want
  // to come back as a different account, and a stale hint would send them
  // straight past the chooser to the account they just left.
  try { localStorage.removeItem(STORAGE.EMAIL); } catch { /* ignore */ }
}

/**
 * The chosen workbook, or null if the user closed the picker.
 *
 * Filtered to the xlsx mime type, so the list holds nothing but candidates -
 * AssetSync's output is a real xlsx on Drive, not a Google Sheet, and a native
 * Sheet here would not be readable by the same code path.
 *
 * @returns {Promise<{id: string, name: string}|null>}
 */
export function pickFile() {
  if (!pickerReady) throw new Error("選檔器尚未載入");
  const google = /** @type {any} */ (window).google;
  return new Promise((resolve) => {
    const mine = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes(XLSX_MIME).setOwnedByMe(true)
      .setIncludeFolders(true).setLabel("我的雲端硬碟");   // Drive 的預設根目錄名稱
    const shared = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes(XLSX_MIME).setOwnedByMe(false)
      .setIncludeFolders(true).setLabel("與我共用");
    const picker = new google.picker.PickerBuilder()
      .setTitle("請選擇 AssetSync.xlsx")
      // The GCP project number. This is how the Picker hands drive.file access
      // for the chosen file back to *this* app.
      .setAppId(CONFIG.GOOGLE_APP_ID)
      .setOAuthToken(accessToken)
      .setDeveloperKey(CONFIG.GOOGLE_API_KEY)
      .addView(mine)
      .addView(shared)
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) {
          const doc = data.docs[0];
          try {
            localStorage.setItem(STORAGE.FILE_ID, doc.id);
            localStorage.setItem(STORAGE.FILE_NAME, doc.name || "");
          } catch { /* ignore */ }
          resolve({ id: doc.id, name: doc.name || "" });
        } else if (data.action === google.picker.Action.CANCEL) {
          // Cancel resolves null rather than rejecting: closing the picker is a
          // choice, not a failure. Note LOADED is deliberately ignored.
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}

export const fileId = () => {
  try { return localStorage.getItem(STORAGE.FILE_ID); } catch { return null; }
};
export const fileName = () => {
  try { return localStorage.getItem(STORAGE.FILE_NAME) || ""; } catch { return ""; }
};

/** The signed-in address. Also remembers it, which is what feeds `hint()`. */
export async function whoami() {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return "";
    const email = (await res.json()).email || "";
    if (email) {
      try { localStorage.setItem(STORAGE.EMAIL, email); } catch { /* ignore */ }
    }
    return email;
  } catch {
    return "";
  }
}
