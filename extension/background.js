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
const SITE_OBSERVATIONS_KEY = "eee.siteObservations";

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

/** The action popup has to be open on the active tab; host matching then limits injection to bundled airline domains. */
let airlineSitesPromise = null;
function airlineHosts() {
  airlineSitesPromise ??= fetch(chrome.runtime.getURL("data/airline-sites.json"))
    .then((res) => (res.ok ? res.json() : []))
    .catch(() => [])
    .then((sites) => Array.isArray(sites) ? sites.map((site) => site?.host).filter((host) => typeof host === "string") : []);
  return airlineSitesPromise;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Captures only a visible, user-selected page's small fare tuple. It never sends the URL, text or page to the server. */
async function rememberSiteObservation(value, sender) {
  if (!sender.tab || sender.frameId !== 0 || !sender.url || !value || typeof value !== "object") return { saved: false };
  let host;
  try { host = new URL(sender.url).hostname.toLowerCase(); } catch { return { saved: false }; }
  if (!(await airlineHosts()).some((allowed) => host.replace(/^www\./, "") === allowed.replace(/^www\./, ""))) return { saved: false };
  const { origin, destination, departDate, returnDate, priceAmount, currency } = value;
  if (typeof origin !== "string" || !/^[A-Z]{3}$/.test(origin)
    || typeof destination !== "string" || !/^[A-Z]{3}$/.test(destination) || origin === destination
    || !validDate(departDate) || !validDate(returnDate) || returnDate <= departDate
    || typeof priceAmount !== "number" || !Number.isFinite(priceAmount) || priceAmount <= 0 || priceAmount > 250000
    || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return { saved: false };
  const storage = await chrome.storage.local.get(SITE_OBSERVATIONS_KEY);
  const rows = Array.isArray(storage[SITE_OBSERVATIONS_KEY]) ? storage[SITE_OBSERVATIONS_KEY] : [];
  const key = [host, origin, destination, departDate, returnDate, currency].join("|");
  const previous = rows.find((row) => row?.key === key);
  if (previous?.priceAmount === priceAmount) return { saved: false, unchanged: true };
  const record = {
    key, host, origin, destination, departDate, returnDate, priceAmount, currency,
    capturedAt: new Date().toISOString(),
    ...(previous ? { previousPriceAmount: previous.priceAmount } : {}),
    method: "visible-page-change",
  };
  const next = [record, ...rows.filter((row) => row?.key !== key)].slice(0, 100);
  await chrome.storage.local.set({ [SITE_OBSERVATIONS_KEY]: next });
  return { saved: true, record };
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
    if (message.type === "shareObservation" && typeof message.key === "string") {
      chrome.storage.local.get(SITE_OBSERVATIONS_KEY).then(async (storage) => {
        const rows = Array.isArray(storage[SITE_OBSERVATIONS_KEY]) ? storage[SITE_OBSERVATIONS_KEY] : [];
        const row = rows.find((item) => item?.key === message.key);
        if (!row) return { ok: false, status: 400 };
        const result = await client.shareObservation({ host: row.host, origin: row.origin, destination: row.destination, departDate: row.departDate, returnDate: row.returnDate, priceAmount: row.priceAmount, currency: row.currency });
        if (result.ok) {
          const next = rows.map((item) => item?.key === row.key ? { ...item, sharedAt: new Date().toISOString() } : item);
          await chrome.storage.local.set({ [SITE_OBSERVATIONS_KEY]: next });
        }
        return result;
      }).then(sendResponse, () => sendResponse({ ok: false, status: 0 }));
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
  if (message.type === "siteObservation") {
    rememberSiteObservation(message.observation, sender).then(sendResponse, () => sendResponse({ saved: false }));
    return true;
  }
  return false;
});
