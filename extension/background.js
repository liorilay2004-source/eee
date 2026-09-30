/**
 * Service worker: the only part of the extension that talks to the network, and only to the project's own API
 * (lib/api.js: GET /api/calendar or /api/explore with origin, destination and month; cached, rate limited, no retries).
 *
 * Messages it answers, only from this extension's own content scripts (they always come from a tab):
 *   { type: "index" }                 -> the bundled place index (data/index.json, read from the extension package)
 *   { type: "lookup", req: {...} }    -> the popup's data, or null
 * And one message only from this extension's own pages (the toolbar popup, which has no tab):
 *   { type: "authCheck" }             -> { outcome, retryAfterMin? } of GET /api/auth/check (lib/api.js checkAuth)
 * Nothing else is handled, nothing is logged, nothing is collected.
 *
 * The access key of a locked API (lib/access.js) is read here from chrome.storage.local and sent as
 * `Authorization: Bearer <key>` by lib/api.js. It never reaches a content script: the answers above carry data or an
 * outcome word, never the key, the "authCheck" message is refused from a tab, and chrome.storage.local itself is
 * closed to content scripts (closeLocalStorageToPages below), so neither a read nor a storage.onChanged event can
 * hand them the key.
 */
import "./lib/settings.js";
import "./lib/access.js";
import "./lib/api.js";

const EEE = /** @type {any} */ (globalThis)[Symbol.for("eee.extension")];
const api = EEE.api;
const Settings = EEE.settings;
const Access = EEE.access;

/**
 * chrome.storage.local is, by default, readable from content scripts too (TRUSTED_AND_UNTRUSTED_CONTEXTS), and its
 * onChanged events reach them. The key lives there, so the service worker restricts the area to the extension's own
 * contexts (this worker and the popup) every time it starts. Chrome 130+; on older versions the method is missing and
 * nothing changes (the content scripts still never ask for it: test/access.test.mjs). Never throws.
 */
function closeLocalStorageToPages() {
  try {
    const done = chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
    if (done && typeof done.catch === "function") done.catch(() => undefined);
  } catch {
    /* an older Chrome */
  }
}
closeLocalStorageToPages();

const client = api.createClient({
  fetch: (/** @type {string} */ url, /** @type {RequestInit} */ init) => fetch(url, init),
  now: () => Date.now(),
  storage: api.chromeStorage(chrome.storage.session) ?? api.memoryStorage(),
  setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms),
  clearTimeout: (/** @type {any} */ t) => clearTimeout(t),
  access: {
    load: () => Access.load(chrome.storage.local),
    setRejected: (/** @type {boolean} */ rejected, /** @type {string} */ key) => Access.setRejected(chrome.storage.local, rejected, key),
  },
});

/** @type {Promise<unknown> | null} */
let indexPromise = null;

/** The place index from the extension's own files (a local file, never the network). */
function loadIndex() {
  indexPromise ??= fetch(chrome.runtime.getURL("data/index.json"))
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null)
    .then((index) => {
      if (!index) indexPromise = null; // a failed read may be retried on the next page
      return index;
    });
  return indexPromise;
}

/** @param {unknown} req */
async function lookup(req) {
  const settings = await Settings.load(chrome.storage.sync);
  if (!settings.enabled) return null;
  return client.lookup(req);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Web pages cannot send here (no externally_connectable); only this extension's own scripts and pages.
  if (sender.id !== chrome.runtime.id || !message || typeof message !== "object") return false;
  if (!sender.tab) {
    // An extension page (the toolbar popup), never a content script: those always run in a tab.
    if (message.type === "authCheck") {
      client.checkAuth().then(sendResponse, () => sendResponse({ outcome: "offline" }));
      return true;
    }
    return false;
  }
  if (message.type === "index") {
    loadIndex().then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (message.type === "lookup") {
    lookup(message.req).then(sendResponse, () => sendResponse(null));
    return true;
  }
  return false;
});
