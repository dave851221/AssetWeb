// Reading the chosen file out of Drive.
//
// The browser talks to Drive directly rather than through a proxy: the Drive
// API supports CORS, and "can I read this file" *is* the permission question.
// There is no server in this project to proxy through anyway.
//
// Two calls per refresh: a metadata probe, then the bytes. The probe is cheap
// and turns the two recoverable mistakes - the file was replaced by a Google
// Sheet, or access is gone - into a sentence before a megabyte is downloaded.

const API = "https://www.googleapis.com/drive/v3/files";

/**
 * Drive said no, or the file is gone. `status` distinguishes an expired token
 * (401) from a withdrawn share (403/404), which the shell handles differently:
 * a 401 must never revoke, a 404 should offer a re-pick.
 */
export class DriveAccessError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** The picked file is no longer an xlsx workbook. */
export class DriveShapeError extends Error {}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** @param {Response} res */
function explain(res) {
  if (res.status === 401) return new DriveAccessError("登入已逾期", 401);
  if (res.status === 403) return new DriveAccessError("沒有這個檔案的讀取權限", 403);
  if (res.status === 404) return new DriveAccessError("找不到這個檔案，可能已被移動或刪除", 404);
  return new DriveAccessError(`Drive 回應 ${res.status}`, res.status);
}

/**
 * Name, mime type, size and Drive's own last-modified time.
 *
 * @param {string} id
 * @param {string} token
 * @returns {Promise<{name: string, mimeType: string, size: number|null, modifiedTime: string|null}>}
 */
async function getMeta(id, token) {
  const url = `${API}/${encodeURIComponent(id)}`
    + `?fields=${encodeURIComponent("name,mimeType,size,modifiedTime")}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw explain(res);
  const j = await res.json();
  return {
    name: j.name || "",
    mimeType: j.mimeType || "",
    size: j.size ? Number(j.size) : null,
    modifiedTime: j.modifiedTime || null,
  };
}

/**
 * The file's bytes.
 *
 * `alt=media` returns the stored blob unchanged, which is what we want: the
 * workbook is a real xlsx on Drive, never converted to a Google Sheet. (If it
 * ever were converted, `alt=media` would fail and the export endpoint would be
 * needed instead - hence the mime check in `fetchWorkbook`.)
 *
 * @param {string} id
 * @param {string} token
 * @returns {Promise<ArrayBuffer>}
 */
async function getBytes(id, token) {
  const res = await fetch(`${API}/${encodeURIComponent(id)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw explain(res);
  return res.arrayBuffer();
}

/**
 * Metadata plus bytes, with the mime type checked first.
 *
 * @param {string} id
 * @param {string} token
 */
export async function fetchWorkbook(id, token) {
  const meta = await getMeta(id, token);
  if (meta.mimeType === "application/vnd.google-apps.spreadsheet") {
    // A Google Sheet cannot be fetched with alt=media, and this app is built
    // around AssetSync's xlsx. Say so rather than letting the download fail
    // with an unhelpful 403.
    throw new DriveShapeError(
      "這是原生 Google Sheet，不是 AssetSync 產出的 .xlsx 檔，請重新選擇");
  }
  if (meta.mimeType !== XLSX_MIME) {
    throw new DriveShapeError(`這個檔案不是 .xlsx（${meta.mimeType || "未知格式"}），請重新選擇`);
  }
  const buf = await getBytes(id, token);
  return { meta, buf };
}
