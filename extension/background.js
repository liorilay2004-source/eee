/**
 * Service worker: the only part of the extension that talks to the network, and only to the project's own API
 * (lib/api.js: GET /api/calendar or /api/explore with origin, destination and month; cached, rate limited, no retries).
 *
 * Messages it answers, only from this extension's own content scripts:
 *   { type: "index" }                 -> the bundled place index (data/index.json, read from the extension package)
 *   { type: "lookup", req: {...} }    -> the popup's data, or null
 * Nothing else is handled, nothing is logged, nothing is collected.
 */
import "./lib/settings.js";
import "./lib/api.js";

const EEE = /** @type {any} */ (globalThis)[Symbol.for("eee.extension")];
const api = EEE.api;
const Settings = EEE.settings;

const client = api.createClient({
  fetch: (/** @type {string} */ url, /** @type {RequestInit} */ init) => fetch(url, init),
  now: () => Date.now(),
  storage: api.chromeStorage(chrome.storage.session) ?? api.memoryStorage(),
  setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms),
  clearTimeout: (/** @type {any} */ t) => clearTimeout(t),
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
  // Only this extension's content scripts (they run in a tab); web pages cannot send here (no externally_connectable).
  if (sender.id !== chrome.runtime.id || !sender.tab || !message || typeof message !== "object") return false;
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
