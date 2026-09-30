/**
 * The user's choices, kept in chrome.storage.sync (they follow the user's browser profile, nothing else):
 *   enabled   show prices at all (the toolbar switch)
 *   origin    default departure airport when the query names none: TLV or ETM
 *   hiddenOn  surfaces where the user chose "לא להציג יותר באתר הזה": "search" (Google Search), "flights" (Google Flights)
 * Anything else read from storage is ignored; a damaged value falls back to the default.
 *
 * The access key of a locked API is NOT here: this file is loaded into the content scripts (inside Google's pages), and
 * the key must never be near them. It lives in lib/access.js (chrome.storage.local), loaded by the service worker and
 * the toolbar popup only.
 */
(() => {
  "use strict";
  const EEE = /** @type {any} */ ((/** @type {any} */ (globalThis))[Symbol.for("eee.extension")] ??= {});
  if (EEE.settings) return;

  const KEY = "settings";
  const ORIGINS = ["TLV", "ETM"];
  const SURFACES = ["search", "flights"];
  /** @typedef {{ enabled: boolean, origin: "TLV" | "ETM", hiddenOn: ("search" | "flights")[] }} Settings */
  /** @type {Readonly<Settings>} */
  const DEFAULTS = Object.freeze({ enabled: true, origin: "TLV", hiddenOn: [] });

  /**
   * @param {unknown} raw
   * @returns {Settings}
   */
  function sanitize(raw) {
    const r = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
    const origin = typeof r.origin === "string" && ORIGINS.includes(r.origin) ? /** @type {"TLV" | "ETM"} */ (r.origin) : DEFAULTS.origin;
    const hiddenOn = Array.isArray(r.hiddenOn)
      ? /** @type {("search" | "flights")[]} */ (SURFACES.filter((s) => /** @type {unknown[]} */ (r.hiddenOn).includes(s)))
      : [];
    return { enabled: r.enabled !== false, origin, hiddenOn };
  }

  /**
   * @param {Settings} s
   * @param {string | null} surface
   */
  const showsOn = (s, surface) => s.enabled && surface !== null && !s.hiddenOn.includes(/** @type {any} */ (surface));

  /**
   * Reads the settings through a chrome.storage area (sync). Never throws: storage trouble means the defaults.
   * @param {{ get: (key: string) => Promise<Record<string, unknown>> } | undefined} area
   * @returns {Promise<Settings>}
   */
  async function load(area) {
    try {
      if (!area) return sanitize(null);
      const got = await area.get(KEY);
      return sanitize(got?.[KEY]);
    } catch {
      return sanitize(null);
    }
  }

  /**
   * @param {{ set: (items: Record<string, unknown>) => Promise<void> } | undefined} area
   * @param {Settings} value
   */
  async function save(area, value) {
    if (!area) return;
    await area.set({ [KEY]: sanitize(value) });
  }

  EEE.settings = Object.freeze({ KEY, ORIGINS, SURFACES, DEFAULTS, sanitize, showsOn, load, save });
})();
