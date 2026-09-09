// Public settings. Everything here is safe in a public repo by design: the
// OAuth client id and the Picker API key *identify* the app, they do not grant
// anything. The real defence is the origin restriction on the OAuth client -
// a request from anywhere other than the origins listed below is rejected by
// Google, which is why publishing these costs nothing.
//
// There is no secret in this project at all: the data comes from the viewer's
// own Drive with the viewer's own token, and the market-price API needs no key.
//
// The app shows a 「尚未設定」 screen while any required value is blank, rather
// than failing somewhere inside Google's SDK with an error nobody can act on.

// GCP project: asset-web-508011 (project number 331301331298).
// All three values below must come from that same project.
export const CONFIG = {
  // Google Cloud → APIs & Services → Credentials → Create OAuth client ID
  // → Web application. Authorised JavaScript origins must be exactly:
  //     http://localhost:8899
  //     http://127.0.0.1:8899
  //     https://dave851221.github.io
  // Leave the redirect URIs empty - the token flow does not use them.
  GOOGLE_CLIENT_ID: "331301331298-ku9a100maoj7savctqqi7g3i2jrm0ehh.apps.googleusercontent.com",

  // Same Credentials page → Create credentials → API key. Google Picker needs
  // it. Restrict it to the origins above and to the Picker API.
  GOOGLE_API_KEY: "AIzaSyAk4g34SnbtbRZGJO4_orI8flFMpYaJDXU",

  // Google Cloud → the project NUMBER (not the project id, not the name).
  // Picker uses it to hand drive.file access for the chosen file back to this
  // app, so it must belong to the same project as the client id above - it is
  // in fact the leading digits of that client id. Get these two out of step and
  // the picker still opens and still returns a file, but every read of that
  // file comes back 404: the grant went to a different app.
  GOOGLE_APP_ID: "331301331298",
};

// drive.file keeps the consent screen non-sensitive: no Google verification
// review, no 100-test-user cap, no "this app isn't verified" warning. The cost
// is the one-time file picker - and that picker *is* the gate, because a file
// nobody shared with you never appears in it.
//
// Do not add spreadsheets.readonly or drive.readonly. One sensitive scope and
// the review plus the user cap come straight back.
export const SCOPES = "openid email profile https://www.googleapis.com/auth/drive.file";

// The workbook AssetSync produces. Picker filters on this so the list holds
// nothing but candidates.
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Sheet names inside AssetSync.xlsx.
 *
 * `TRADES_PREFIX` is a prefix on purpose: AssetSync creates `trades_<year>` on
 * demand, so trades_2027 will appear by itself in January. Never hard-code the
 * list of years.
 */
export const SHEETS = {
  SUMMARY: "summary",
  FUBON: "fubon",
  SINOPAC: "sinopac",
  IBKR: "ibkr",
  HISTORY: "history",
  MANUAL: "manual",
  ADJUSTMENTS: "adjustments",
  TRADES_PREFIX: "trades_",
};

/** Sheets that must exist, or this is not an AssetSync workbook. */
export const REQUIRED_SHEETS = [SHEETS.HISTORY, SHEETS.SUMMARY];

/** fubon / sinopac / ibkr, with the display name and whether it is TWD. */
export const BROKERS = {
  fubon: { label: "富邦", currency: "TWD", historyPrefix: "富邦" },
  sinopac: { label: "永豐", currency: "TWD", historyPrefix: "永豐" },
  ibkr: { label: "IBKR", currency: "USD", historyPrefix: "IBKR" },
  manual: { label: "手動項目", currency: "TWD", historyPrefix: "手動" },
};

export const STORAGE = {
  FILE_ID: "aw.fileId",
  FILE_NAME: "aw.fileName",
  CACHE: "aw.cache",
  TOKEN: "aw.token",
  // Who signed in last. Not a credential - it is passed to Google as a hint so
  // the account chooser can be skipped. Cleared on an explicit 登出, the one
  // moment somebody might want a different account.
  EMAIL: "aw.email",
};

/** What has to be filled in before the site can do anything at all. */
export function missingConfig() {
  return ["GOOGLE_CLIENT_ID", "GOOGLE_API_KEY", "GOOGLE_APP_ID"]
    .filter((k) => !CONFIG[/** @type {keyof typeof CONFIG} */ (k)]);
}
