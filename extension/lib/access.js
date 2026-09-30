/**
 * The optional ACCESS KEY of a locked API (worker/src/access.ts: `Authorization: Bearer <key>`, 20-256 visible ASCII
 * characters). Loaded by the service worker (which sends the key, lib/api.js) and by the toolbar popup (which saves it)
 * and by nothing else: this file is NOT in the manifest's content_scripts, so the code that reads the key never runs
 * inside Google's pages (test/access.test.mjs checks the manifest and the content scripts' source).
 *
 * Where it is kept: chrome.storage.LOCAL, under its own name (KEY), never chrome.storage.sync. A secret must not leave
 * this device and this browser profile; sync would copy it to the user's Google account and to every browser signed
 * into it. The key is never logged and never put in a URL (lib/api.js sends it in the Authorization header only).
 *
 * Beside the key, one flag: `rejected`, set by the service worker after a 401 so the popup can say "המפתח נדחה", and
 * cleared by a successful check. The key itself is never removed by the code (a lock switched off, or a typo in the
 * secret, is the owner's call): only "מחיקה" in the popup removes it.
 */
(() => {
  "use strict";
  const EEE = /** @type {any} */ ((/** @type {any} */ (globalThis))[Symbol.for("eee.extension")] ??= {});
  if (EEE.access) return;

  const KEY = "accessKey";
  const MIN_LENGTH = 20;
  const MAX_LENGTH = 256;
  /** Visible ASCII, no spaces: what the API accepts (worker/src/access.ts KEY_CHARS). */
  const KEY_CHARS = /^[\x21-\x7e]+$/;
  const MESSAGES = Object.freeze({
    empty: "הדביקו את המפתח קודם.",
    tooShort: `המפתח קצר מדי: צריך לפחות ${MIN_LENGTH} תווים.`,
    tooLong: `המפתח ארוך מדי: עד ${MAX_LENGTH} תווים.`,
    badChars: "המפתח יכול להכיל רק אותיות באנגלית, ספרות וסימנים, בלי רווחים ובלי עברית.",
  });
  /** @typedef {{ key: string | null, rejected: boolean }} AccessKeyState */

  /**
   * A pasted key, checked the way the API checks its secret (surrounding whitespace, e.g. a pasted newline, is not part
   * of it). Never throws, never logs.
   * @param {unknown} raw
   * @returns {{ ok: true, key: string } | { ok: false, messageHe: string }}
   */
  function validate(raw) {
    const key = typeof raw === "string" ? raw.replace(/^[\s ]+|[\s ]+$/g, "") : "";
    if (key === "") return { ok: false, messageHe: MESSAGES.empty };
    if (key.length < MIN_LENGTH) return { ok: false, messageHe: MESSAGES.tooShort };
    if (key.length > MAX_LENGTH) return { ok: false, messageHe: MESSAGES.tooLong };
    if (!KEY_CHARS.test(key)) return { ok: false, messageHe: MESSAGES.badChars };
    return { ok: true, key };
  }

  /**
   * What is stored, cleaned: a damaged or invalid stored key counts as no key.
   * @param {unknown} raw
   * @returns {AccessKeyState}
   */
  function sanitize(raw) {
    const r = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
    const v = validate(r.key);
    return v.ok ? { key: v.key, rejected: r.rejected === true } : { key: null, rejected: false };
  }

  /**
   * Reads the key through a chrome.storage area (chrome.storage.local). Never throws: storage trouble means no key.
   * @param {{ get: (key: string) => Promise<Record<string, unknown>> } | undefined} area
   * @returns {Promise<AccessKeyState>}
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
   * Stores a key that passes validate() (anything else is refused, not stored), as not rejected.
   * @param {{ set: (items: Record<string, unknown>) => Promise<void> } | undefined} area
   * @param {string} key
   */
  async function save(area, key) {
    const v = validate(key);
    if (!v.ok) throw new Error("invalid access key");
    if (!area) return;
    await area.set({ [KEY]: { key: v.key, rejected: false } });
  }

  /** @param {{ remove: (key: string) => Promise<void> } | undefined} area */
  async function clear(area) {
    if (!area) return;
    await area.remove(KEY);
  }

  /**
   * The service worker's note after a 401 (rejected) or the check's after a 204 (accepted again). The key stays as it
   * is. With `key`, the verdict applies only while that key is still the stored one: a request that went out with the
   * old key and came back 401 after the popup saved a new one must not flag the new key. Never throws.
   * @param {{ get: (key: string) => Promise<Record<string, unknown>>, set: (items: Record<string, unknown>) => Promise<void> } | undefined} area
   * @param {boolean} rejected
   * @param {string} [key] the key the verdict is about
   */
  async function setRejected(area, rejected, key) {
    try {
      if (!area) return;
      const current = await load(area);
      if (current.key === null || current.rejected === rejected) return;
      if (key !== undefined && current.key !== key) return;
      await area.set({ [KEY]: { key: current.key, rejected } });
    } catch {
      /* the flag is a courtesy for the popup; the key is what matters */
    }
  }

  EEE.access = Object.freeze({ KEY, MIN_LENGTH, MAX_LENGTH, MESSAGES, validate, sanitize, load, save, clear, setRejected });
})();
