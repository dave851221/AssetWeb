// Cache and load orchestration - stale-while-revalidate.
//
// The order matters and must not be inverted: paint the cache first, then go
// and get a fresh token and fresh data in the background. Waiting for
// verification before drawing anything turns every visit into a blank second
// or two, which is exactly what the cache is for.
//
// What is cached is the *parsed model*, not the xlsx bytes. Bytes would need
// base64 (a third bigger) and a re-parse on every load; the model is JSON
// already and comes back ready to render.

import { STORAGE } from "./config.js";
import * as auth from "./auth.js";
import { SilentAuthFailure } from "./auth.js";
import { fetchWorkbook, DriveAccessError } from "./drive.js";
import { parseWorkbook } from "./parse/workbook.js";

/** @typedef {import('./types.js').Model} Model */

/**
 * The last model this browser read, or null.
 *
 * @returns {Model|null}
 */
export function readCache() {
  try {
    const raw = localStorage.getItem(STORAGE.CACHE);
    if (!raw) return null;
    const data = JSON.parse(raw);
    // A shape check, not a version check: anything without these is either
    // from an older layout or corrupt, and either way is not worth rendering.
    return data && data.meta && Array.isArray(data.trades) && Array.isArray(data.history)
      ? data
      : null;
  } catch {
    return null;
  }
}

/** @param {Model} model */
export function writeCache(model) {
  try {
    localStorage.setItem(STORAGE.CACHE, JSON.stringify(model));
  } catch {
    // Over quota, or storage disabled. The app works without the cache - the
    // next visit is just slower - so this is not worth an error to the user.
    try { localStorage.removeItem(STORAGE.CACHE); } catch { /* ignore */ }
  }
}

export function clearCache() {
  try { localStorage.removeItem(STORAGE.CACHE); } catch { /* ignore */ }
}

/**
 * One round of loading: token, bytes, parse, cache.
 *
 * Errors are thrown for the shell to translate into a sentence:
 * WorkbookShapeError (wrong file), DriveShapeError (not an xlsx),
 * DriveAccessError (permission gone), SilentAuthFailure (needs a click).
 *
 * @param {{interactive?: boolean}} [opts]
 * @returns {Promise<Model>}
 */
export async function refreshAll({ interactive = false } = {}) {
  const id = auth.fileId();
  if (!id) throw new Error("NO_FILE");

  const token = await auth.token({ silent: !interactive });

  let loaded;
  try {
    loaded = await fetchWorkbook(id, token);
  } catch (err) {
    if (!(err instanceof DriveAccessError && err.status === 401)) throw err;
    auth.clearToken();      // not forget(): revoking would take drive.file with it
    // **No retry, and there cannot be one.** Minting a token opens a popup, and
    // by now the click that authorised this refresh is a network round trip in
    // the past - its transient activation (~5s) is spent, so the popup would be
    // blocked and surface as a generic `popup_failed_to_open`. Saying it
    // outright instead lands on the amber "press refresh again" state, which is
    // a button that works.
    throw new SilentAuthFailure("登入已逾期，請按「重新整理資料」再試一次");
  }

  const model = parseWorkbook(loaded.buf, loaded.meta.name || auth.fileName());
  writeCache(model);
  return model;
}

/**
 * Offline development: read the local xlsx fixture and run it through the very
 * same parser. Deliberately not a pre-parsed JSON snapshot - the point is that
 * `?dev=1` exercises the real parse path, which is where the complexity is.
 *
 * @returns {Promise<Model>}
 */
export async function loadFixture() {
  const res = await fetch("dev-data.xlsx", { cache: "no-store" });
  if (!res.ok) {
    throw new Error("找不到 dev-data.xlsx：請從 Drive 的同步資料夾複製一份 AssetSync.xlsx 過來");
  }
  return parseWorkbook(await res.arrayBuffer(), "dev-data.xlsx");
}
