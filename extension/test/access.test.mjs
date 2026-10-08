/**
 * The access key of a locked API (worker/src/access.ts): validation, chrome.storage.local (never sync), the
 * Authorization header only when a key is stored, the key never in a URL or a log, the 401 flag, the popup's key check
 * (GET /api/auth/check) mapped status by status, and the content scripts having no path to the key.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EEE, fixture, read } from "./helpers.mjs";

const S = EEE.settings;
const K = EEE.access;
const A = EEE.api;
const START = Date.parse("2026-09-30T08:00:00Z");
const CAL = { kind: "calendar", origin: "TLV", destination: "ATH", month: "2026-11" };
const KEY = "k7Qx2mP9vL4nR8sT1wY6zB3c"; // 24 visible ASCII characters, like the generator's output
const manifest = JSON.parse(read("manifest.json"));
const contentFiles = /** @type {string[]} */ (manifest.content_scripts[0].js);
const code = (/** @type {string} */ f) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** A fake chrome.storage area (get/set/remove), like chrome.storage.local. */
function area(initial = {}) {
  /** @type {Record<string, unknown>} */
  const data = { ...initial };
  return {
    data,
    get: async (/** @type {string} */ key) => (key in data ? { [key]: data[key] } : {}),
    set: async (/** @type {Record<string, unknown>} */ items) => void Object.assign(data, items),
    remove: async (/** @type {string} */ key) => void delete data[key],
  };
}

/** @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
function response(status, body, headers = {}) {
  const h = { "content-type": "application/json; charset=utf-8", ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
  return { status, ok: status >= 200 && status < 300, headers: { get: (/** @type {string} */ n) => h[/** @type {keyof typeof h} */ (n.toLowerCase())] ?? null }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

/**
 * A client whose key lives in a fake chrome.storage.local, the way background.js wires it.
 * @param {(url: string, init: any, n: number) => any} responder
 * @param {{ local?: ReturnType<typeof area>, access?: any, storage?: any }} [opts]
 */
function setup(responder, opts = {}) {
  const state = { now: START };
  /** @type {{ url: string, init: any }[]} */
  const calls = [];
  /** @type {Map<number, { fn: () => void, at: number }>} */
  const timers = new Map();
  let nextId = 1;
  const local = opts.local ?? area();
  const access = "access" in opts ? opts.access : { load: () => K.load(local), setRejected: (/** @type {boolean} */ r, /** @type {string} */ k) => K.setRejected(local, r, k) };
  const client = A.createClient({
    now: () => state.now,
    storage: opts.storage ?? A.memoryStorage(),
    setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: state.now + ms });
      return id;
    },
    clearTimeout: (/** @type {any} */ id) => void timers.delete(id),
    fetch: async (/** @type {string} */ url, /** @type {any} */ init) => {
      calls.push({ url, init });
      return responder(url, init, calls.length);
    },
    ...(access ? { access } : {}),
  });
  return {
    client,
    calls,
    local,
    /** @param {number} ms */
    advance(ms) {
      state.now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= state.now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}
const calendarOk = () => response(200, fixture("calendar.json"));
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

describe("validation (client side, in Hebrew)", () => {
  it("accepts 20-256 visible ASCII characters, trimming pasted whitespace", () => {
    assert.deepEqual(K.validate(KEY), { ok: true, key: KEY });
    assert.deepEqual(K.validate(`  ${KEY}\n`), { ok: true, key: KEY });
    assert.deepEqual(K.validate("a".repeat(20)), { ok: true, key: "a".repeat(20) });
    assert.deepEqual(K.validate("!".repeat(256)), { ok: true, key: "!".repeat(256) });
    assert.equal(K.MIN_LENGTH, 20);
    assert.equal(K.MAX_LENGTH, 256);
  });

  it("rejects empty, short, long, spaces inside, Hebrew, control characters, non-strings, each with a Hebrew message", () => {
    const cases = /** @type {[unknown, string][]} */ ([
      ["", K.MESSAGES.empty],
      ["   ", K.MESSAGES.empty],
      [undefined, K.MESSAGES.empty],
      [null, K.MESSAGES.empty],
      [42, K.MESSAGES.empty],
      ["a".repeat(19), K.MESSAGES.tooShort],
      ["a".repeat(257), K.MESSAGES.tooLong],
      [`${"a".repeat(10)} ${"b".repeat(10)}`, K.MESSAGES.badChars],
      [`${"a".repeat(20)}א`, K.MESSAGES.badChars],
      [`${"a".repeat(20)}\u0007`, K.MESSAGES.badChars],
      [`${"a".repeat(20)}é`, K.MESSAGES.badChars],
      [`${"a".repeat(10)}\t${"b".repeat(10)}`, K.MESSAGES.badChars],
    ]);
    for (const [input, message] of cases) {
      const v = K.validate(input);
      assert.equal(v.ok, false, String(input));
      assert.equal(/** @type {any} */ (v).messageHe, message, String(input));
      assert.match(message, /[א-ת]/);
    }
    assert.match(K.MESSAGES.tooShort, /20/);
    assert.match(K.MESSAGES.tooLong, /256/);
  });
});

describe("storage: chrome.storage.local, under its own name", () => {
  it("save, load, clear, and the rejected flag", async () => {
    const local = area();
    assert.deepEqual(await K.load(local), { key: null, rejected: false });
    await K.save(local, `  ${KEY}\n`);
    assert.deepEqual(local.data, { [K.KEY]: { key: KEY, rejected: false } });
    assert.deepEqual(await K.load(local), { key: KEY, rejected: false });
    await K.setRejected(local, true);
    assert.deepEqual(await K.load(local), { key: KEY, rejected: true }); // the key itself stays
    await K.setRejected(local, false);
    assert.deepEqual(await K.load(local), { key: KEY, rejected: false });
    await K.clear(local);
    assert.deepEqual(local.data, {});
    assert.deepEqual(await K.load(local), { key: null, rejected: false });
  });

  it("an invalid key is never stored; a damaged stored value counts as no key; storage trouble means no key", async () => {
    const local = area();
    await assert.rejects(K.save(local, "short"));
    await assert.rejects(K.save(local, ""));
    assert.deepEqual(local.data, {});
    for (const damaged of [{ key: "short", rejected: true }, { key: 7 }, "junk", null, { rejected: true }, { key: `${"a".repeat(20)} b` }]) {
      assert.deepEqual(K.sanitize(damaged), { key: null, rejected: false }, JSON.stringify(damaged));
    }
    assert.deepEqual(K.sanitize({ key: KEY, rejected: "yes" }), { key: KEY, rejected: false });
    await K.setRejected(local, true); // no key: nothing to flag, nothing written
    assert.deepEqual(local.data, {});
    const broken = { get: async () => { throw new Error("gone"); }, set: async () => { throw new Error("gone"); }, remove: async () => { throw new Error("gone"); } };
    assert.deepEqual(await K.load(/** @type {any} */ (broken)), { key: null, rejected: false });
    await K.setRejected(/** @type {any} */ (broken), true); // never throws
    assert.deepEqual(await K.load(undefined), { key: null, rejected: false });
  });

  it("the settings in chrome.storage.sync never carry the key, whatever is passed to them", () => {
    const s = /** @type {any} */ (S.sanitize({ enabled: true, origin: "TLV", hiddenOn: [], accessKey: KEY, key: KEY }));
    assert.deepEqual(Object.keys(s).sort(), ["enabled", "hiddenOn", "origin"]);
    assert.ok(!JSON.stringify(s).includes(KEY));
    assert.notEqual(K.KEY, S.KEY);
  });

  it("the service worker and the popup read the key from chrome.storage.local only; the settings stay in sync", () => {
    const bg = code("background.js");
    assert.match(bg, /load: \(\) => Access\.load\(chrome\.storage\.local\)/);
    assert.match(bg, /Access\.setRejected\(chrome\.storage\.local, rejected, key\)/);
    assert.match(bg, /Settings\.load\(chrome\.storage\.sync\)/);
    assert.doesNotMatch(bg, /Access\.\w+\(chrome\.storage\.(sync|session)/);
    const popup = code("popup/popup.js");
    assert.match(popup, /const local = chrome\.storage\.local;/);
    assert.match(popup, /K\.save\(local, v\.key\)/);
    assert.match(popup, /K\.clear\(local\)/);
    assert.match(popup, /K\.load\(local\)/);
    assert.doesNotMatch(popup, /K\.\w+\((area|chrome\.storage\.sync|chrome\.storage\.session)/);
    assert.match(read("lib/access.js"), /chrome\.storage\.LOCAL, under its own name \(KEY\), never chrome\.storage\.sync/);
    assert.ok(!code("lib/settings.js").includes("accessKey")); // the settings module (a content script) knows nothing of it
  });
});

describe("what is sent", () => {
  it("no key stored: Accept only, exactly as before", async () => {
    const env = setup(() => calendarOk());
    assert.equal((await env.client.lookup(CAL))?.kind, "calendar");
    assert.deepEqual(env.calls[0]?.init.headers, { Accept: "application/json" });
    const noStore = setup(() => calendarOk(), { access: undefined });
    assert.equal((await noStore.client.lookup(CAL))?.kind, "calendar");
    assert.deepEqual(noStore.calls[0]?.init.headers, { Accept: "application/json" });
  });

  it("a key stored: Authorization: Bearer <key> on every request, still no cookies and no referrer", async () => {
    const local = area();
    await K.save(local, KEY);
    const env = setup(() => calendarOk(), { local });
    await env.client.lookup(CAL);
    await env.client.lookup({ kind: "explore", origin: "TLV", month: "2026-11" });
    assert.equal(env.calls.length, 2);
    for (const c of env.calls) {
      assert.deepEqual(c.init.headers, { Accept: "application/json", Authorization: `Bearer ${KEY}` });
      assert.equal(c.init.credentials, "omit");
      assert.equal(c.init.referrerPolicy, "no-referrer");
      assert.equal(c.init.method, "GET");
      assert.equal(c.init.body, undefined);
    }
  });

  it("the key is never in a URL, and never in anything the client keeps or returns", async () => {
    const local = area();
    await K.save(local, KEY);
    const env = setup(() => calendarOk(), { local });
    const data = await env.client.lookup(CAL);
    const check = await env.client.checkAuth();
    for (const c of env.calls) {
      assert.ok(!c.url.includes(KEY), c.url);
      assert.ok(!decodeURIComponent(c.url).includes(KEY.slice(0, 8)));
      assert.deepEqual([...new URL(c.url).searchParams.keys()].filter((k) => /key|token|auth/i.test(k)), []);
    }
    assert.ok(!JSON.stringify(data).includes(KEY));
    assert.ok(!JSON.stringify(check).includes(KEY));
    assert.deepEqual(A.buildUrl(CAL).includes(KEY), false);
  });

  it("nothing in the extension logs anything (no console at all), so the key cannot end up in a log", () => {
    for (const f of ["background.js", "lib/api.js", "lib/settings.js", "popup/popup.js", ...contentFiles]) {
      assert.doesNotMatch(code(f), /\bconsole\s*\.|\bdebugger\b|reportError\(/, f);
    }
  });

  it("a rejected key is not sent again (a wrong key counts as a guess at the API; a request without one does not)", async () => {
    const local = area({ [K.KEY]: { key: KEY, rejected: true } });
    const env = setup(() => calendarOk(), { local });
    await env.client.lookup(CAL);
    assert.deepEqual(env.calls[0]?.init.headers, { Accept: "application/json" });
  });

  it("a storage that fails while reading the key means a request without a key, never a broken lookup", async () => {
    const env = setup(() => calendarOk(), { access: { load: async () => { throw new Error("gone"); }, setRejected: async () => undefined } });
    assert.equal((await env.client.lookup(CAL))?.kind, "calendar");
    assert.deepEqual(env.calls[0]?.init.headers, { Accept: "application/json" });
  });
});

describe("401", () => {
  it("marks the stored key as rejected, keeps it, shows nothing, pauses like any failure, and stops sending it", async () => {
    const local = area();
    await K.save(local, KEY);
    const env = setup((_u, init, n) => (n === 1 || !init.headers.Authorization ? response(401, { error: { code: "unauthorized" } }, { "WWW-Authenticate": "Bearer" }) : calendarOk()), { local });
    assert.equal(await env.client.lookup(CAL), null);
    assert.deepEqual(local.data[K.KEY], { key: KEY, rejected: true });
    env.advance(30_000);
    assert.equal(await env.client.lookup({ ...CAL, destination: "ROM" }), null); // the usual one-minute pause
    assert.equal(env.calls.length, 1);
    env.advance(31_000);
    await env.client.lookup({ ...CAL, destination: "ROM" });
    assert.equal(env.calls.length, 2);
    assert.deepEqual(env.calls[1]?.init.headers, { Accept: "application/json" }); // no key: not counted as a guess
    assert.deepEqual(local.data[K.KEY], { key: KEY, rejected: true }); // a 401 without a key changes nothing
  });

  it("a 401 without any key stored sets no flag and stores nothing", async () => {
    const env = setup(() => response(401, { error: { code: "unauthorized" } }));
    assert.equal(await env.client.lookup(CAL), null);
    assert.deepEqual(env.local.data, {});
  });

  it("the flag is cleared only by a successful check, not by a later 200 (the popup decides)", async () => {
    const local = area({ [K.KEY]: { key: KEY, rejected: true } });
    const env = setup(() => calendarOk(), { local });
    await env.client.lookup(CAL);
    assert.deepEqual(local.data[K.KEY], { key: KEY, rejected: true });
    assert.deepEqual(await env.client.checkAuth(), { outcome: "ok" });
    assert.deepEqual(local.data[K.KEY], { key: KEY, rejected: false });
  });
});

describe("the popup's check: GET /api/auth/check through the service worker", () => {
  /** @param {any} responder @param {boolean} withKey */
  const check = async (responder, withKey = true) => {
    const local = area(withKey ? { [K.KEY]: { key: KEY, rejected: false } } : {});
    const env = setup(responder, { local });
    const out = await env.client.checkAuth();
    return { out, env, local };
  };

  it("asks exactly GET /api/auth/check, with the key in the header only, no cookies, no referrer, no cache", async () => {
    const { env } = await check(() => response(204, ""));
    assert.equal(env.calls.length, 1);
    const u = new URL(/** @type {string} */ (env.calls[0]?.url));
    assert.equal(u.origin, A.API_BASE);
    assert.equal(u.pathname, A.AUTH_CHECK_PATH);
    assert.equal(A.AUTH_CHECK_PATH, "/api/auth/check");
    assert.equal(u.search, "");
    const init = env.calls[0]?.init;
    assert.equal(init.method, "GET");
    assert.equal(init.credentials, "omit");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.deepEqual(init.headers, { Accept: "application/json", Authorization: `Bearer ${KEY}` });
  });

  it("204 -> ok (המפתח תקין), and the rejected flag is cleared", async () => {
    const local = area({ [K.KEY]: { key: KEY, rejected: true } });
    const env = setup(() => response(204, ""), { local });
    assert.deepEqual(await env.client.checkAuth(), { outcome: "ok" });
    assert.deepEqual(local.data[K.KEY], { key: KEY, rejected: false });
  });

  it("204 with no key stored -> unlocked (the lock is off), and nothing is stored", async () => {
    const { out, local } = await check(() => response(204, ""), false);
    assert.deepEqual(out, { outcome: "unlocked" });
    assert.deepEqual(local.data, {});
  });

  it("401 -> wrong (המפתח שגוי), the flag set, the key kept", async () => {
    const { out, local } = await check(() => response(401, { error: { code: "unauthorized" } }));
    assert.deepEqual(out, { outcome: "wrong" });
    assert.deepEqual(local.data[K.KEY], { key: KEY, rejected: true });
  });

  it("401 with no key stored -> no_key", async () => {
    const { out, env } = await check(() => response(401, { error: { code: "unauthorized" } }), false);
    assert.deepEqual(out, { outcome: "no_key" });
    assert.deepEqual(env.calls[0]?.init.headers, { Accept: "application/json" });
  });

  it("404 -> unlocked (האתר לא נעול, לא צריך מפתח: the deployed API has no lock at all)", async () => {
    const { out } = await check(() => response(404, { error: { code: "not_found" } }));
    assert.deepEqual(out, { outcome: "unlocked" });
  });

  it("429 -> blocked with the minutes of Retry-After, and lookups pause for that long", async () => {
    const { out, env } = await check((/** @type {string} */ url) => (url.includes("/api/auth/check") ? response(429, { error: { code: "too_many_attempts", retryAfterSec: 290 } }, { "Retry-After": "290" }) : calendarOk()));
    assert.deepEqual(out, { outcome: "blocked", retryAfterMin: 5 });
    assert.equal(await env.client.lookup(CAL), null);
    assert.equal(env.calls.length, 1);
    env.advance(291_000);
    assert.equal((await env.client.lookup(CAL))?.kind, "calendar");
    const short = await check(() => response(429, {}, { "Retry-After": "5" }));
    assert.deepEqual(short.out, { outcome: "blocked", retryAfterMin: 1 }); // never "0 minutes"
    const noHeader = await check(() => response(429, {}));
    assert.deepEqual(noHeader.out, { outcome: "blocked", retryAfterMin: 1 });
  });

  it("503 (misconfigured lock) and 500 -> unavailable; an odd status too (a redirect never gets this far: redirect \"error\" makes fetch throw -> offline)", async () => {
    for (const status of [503, 500, 502, 403, 418]) {
      const { out } = await check(() => response(status, { error: { code: "access_misconfigured" } }));
      assert.deepEqual(out, { outcome: "unavailable" }, String(status));
    }
  });

  it("network error and timeout -> offline (אין חיבור)", async () => {
    const { out } = await check(() => {
      throw new TypeError("Failed to fetch");
    });
    assert.deepEqual(out, { outcome: "offline" });
    const local = area({ [K.KEY]: { key: KEY, rejected: false } });
    const env = setup(() => new Promise(() => {}), { local });
    const pending = env.client.checkAuth();
    await flush();
    env.advance(A.TIMEOUT_MS);
    assert.deepEqual(await pending, { outcome: "offline" });
  });

  it("one check at a time, and a check is not counted in the lookup limiter", async () => {
    const local = area({ [K.KEY]: { key: KEY, rejected: false } });
    const env = setup((/** @type {string} */ url) => (url.includes("/api/auth/check") ? response(204, "") : calendarOk()), { local });
    const [a, b] = await Promise.all([env.client.checkAuth(), env.client.checkAuth()]);
    assert.deepEqual(a, b);
    assert.equal(env.calls.length, 1);
    const months = ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07"];
    for (const month of months) await env.client.lookup({ ...CAL, month });
    assert.equal(env.calls.length, 1 + A.LIMIT_MAX); // the check did not use up a lookup
  });

  it("the popup maps every outcome to a Hebrew line and calls the check only through the service worker", () => {
    const popup = code("popup/popup.js");
    assert.match(popup, /chrome\.runtime\.sendMessage\(\{ type: "authCheck" \}/);
    for (const needle of ["המפתח תקין", "המפתח שגוי", "האתר לא נעול, לא צריך מפתח", "יותר מדי ניסיונות, נסו שוב בעוד ${n === 1 ? \"דקה אחת\" : `${n} דקות`}", "אין חיבור", "המפתח נדחה"]) {
      assert.ok(popup.includes(needle), needle);
    }
    assert.doesNotMatch(popup, /1 דקות/); // "בעוד 1 דקות" is not Hebrew
    for (const outcome of ["ok", "wrong", "no_key", "unlocked", "blocked", "unavailable"]) assert.ok(popup.includes(`case "${outcome}":`), outcome);
    const bg = code("background.js");
    assert.match(bg, /client\.checkAuth\(\)\.then\(sendResponse/);
  });

  it("the toolbar page: a masked field, show/hide, save, check, delete, and the one-line privacy note", () => {
    const html = read("popup/popup.html");
    assert.match(html, /<input type="text" class="masked" id="access-key" autocomplete="off"/);
    for (const needle of ['id="access-toggle"', 'id="access-save">שמירה<', 'id="access-check">בדיקה<', 'id="access-clear">מחיקה<', "מפתח גישה", "המפתח נשמר רק במכשיר הזה", "אם נעלתם את האתר"]) {
      assert.ok(html.includes(needle), needle);
    }
    const popup = code("popup/popup.js");
    assert.match(popup, /keyField\.classList\.toggle\("masked", !show\)/);
    assert.match(popup, /keyField\.value = "";/); // the field never keeps the key once it is stored
    assert.doesNotMatch(popup, /keyField\.value = (?!"")/); // and is never filled from storage
  });

  it("the key field is never type=\"password\": Chrome's password manager (which syncs) must never be offered the key", () => {
    // Review finding: a password field emptied right after typing is the password manager's cue to offer saving it.
    const html = read("popup/popup.html");
    assert.doesNotMatch(html, /type="password"/);
    assert.doesNotMatch(code("popup/popup.js"), /"password"|keyField\.type\s*=/);
    const css = read("popup/popup.css");
    assert.match(css, /\.access-field input\.masked \{\s*-webkit-text-security: disc;\s*\}/);
    assert.match(css, /\.access-field input::placeholder \{\s*direction: rtl;\s*text-align: right;\s*\}/); // Hebrew placeholder in the ltr field
  });
});

describe("content scripts have no path to the key", () => {
  it("never touch chrome.storage.local (or session), never name the key, the header or the check", () => {
    for (const f of contentFiles) {
      const text = code(f);
      assert.doesNotMatch(text, /storage\.local|storage\.session|chrome\.storage\.get|Authorization|Bearer|accessKey|AccessKey|ACCESS_KEY|authCheck|checkAuth|EEE\.access|\.access\b/, f);
    }
    // The module that reads the key is loaded by the service worker and the popup page only, never into a page.
    assert.ok(!contentFiles.includes("lib/access.js"));
    assert.ok(!contentFiles.includes("lib/api.js") && !contentFiles.includes("background.js") && !contentFiles.includes("popup/popup.js"));
    assert.match(read("background.js"), /^import "\.\/lib\/access\.js";$/m);
    assert.match(read("popup/popup.html"), /<script src="\.\.\/lib\/access\.js"><\/script>/);
  });

  it("the settings a content script reads (chrome.storage.sync) are sanitized to three fields: a key could not ride along", () => {
    const main = code("content/main.js");
    assert.match(main, /S\.load\(chrome\.storage\.sync\)/);
    assert.match(main, /if \(area !== "sync" \|\| !changes\[S\.KEY\]\) return;/);
    assert.deepEqual(Object.keys(S.sanitize({ accessKey: KEY })).sort(), ["enabled", "hiddenOn", "origin"]);
  });

  it("the service worker never answers a tab with the key or a check: answers are data or an outcome word", async () => {
    const local = area({ [K.KEY]: { key: KEY, rejected: false } });
    const env = setup(() => calendarOk(), { local });
    const data = await env.client.lookup(CAL);
    assert.ok(!JSON.stringify(data).includes(KEY));
    assert.deepEqual(Object.keys(/** @type {any} */ (data)).sort(), ["days", "insightHe", "kind", "month", "noticeHe"]);
    const bg = code("background.js");
    // "authCheck" is answered only when the sender has no tab (an extension page), so a content script cannot trigger it.
    const noTab = bg.slice(bg.indexOf("if (!sender.tab) {"), bg.indexOf('if (message.type === "index")'));
    assert.match(noTab, /"authCheck"/);
    assert.doesNotMatch(bg.slice(bg.indexOf('if (message.type === "index")')), /authCheck|AccessKey|accessKey/);
  });

  it("the API host remains the only fixed host permission", () => {
    assert.deepEqual(manifest.permissions, ["storage", "activeTab", "scripting"]);
    assert.deepEqual(manifest.host_permissions, [`${A.API_BASE}/*`]);
    assert.ok(new URL(A.AUTH_CHECK_PATH, A.API_BASE).toString().startsWith(`${A.API_BASE}/`));
  });
});

describe("review fixes: the verdict is about the key that was sent", () => {
  const KEY2 = "n3Vb8Hj1Kq5Ms7Wz2Xc4Ry9t"; // another 24-character key

  it("setRejected with a key is a no-op once another key is stored", async () => {
    const local = area({ [K.KEY]: { key: KEY, rejected: false } });
    await K.setRejected(local, true, KEY2); // about a key that is no longer stored
    assert.deepEqual(local.data[K.KEY], { key: KEY, rejected: false });
    await K.setRejected(local, true, KEY); // about the stored one
    assert.deepEqual(local.data[K.KEY], { key: KEY, rejected: true });
    await K.setRejected(local, false, KEY2);
    assert.deepEqual(local.data[K.KEY], { key: KEY, rejected: true });
    await K.setRejected(local, false); // without a key: whatever is stored (the popup's own flag reset, if ever)
    assert.deepEqual(local.data[K.KEY], { key: KEY, rejected: false });
  });

  it("a 401 for a lookup sent with the OLD key does not flag a key the popup saved meanwhile", async () => {
    const local = area();
    await K.save(local, KEY);
    /** @type {() => void} */
    let release = () => undefined;
    const gate = new Promise((r) => (release = /** @type {any} */ (r)));
    const env = setup(async () => {
      await gate;
      return response(401, { error: { code: "unauthorized" } });
    }, { local });
    const pending = env.client.lookup(CAL);
    await flush();
    assert.equal(env.calls[0]?.init.headers.Authorization, `Bearer ${KEY}`); // went out with the old key
    await K.save(local, KEY2); // the user pastes the right key while the request is in flight
    release();
    assert.equal(await pending, null);
    assert.deepEqual(local.data[K.KEY], { key: KEY2, rejected: false }); // the new key is not flagged...
    env.advance(61_000);
    await env.client.lookup({ ...CAL, destination: "ROM" });
    assert.equal(env.calls[1]?.init.headers.Authorization, `Bearer ${KEY2}`); // ...and is sent
  });

  it("a check's verdict (204 or 401) likewise applies only to the key it was sent with", async () => {
    for (const [status, expect] of /** @type {[number, unknown][]} */ ([
      [401, { key: KEY2, rejected: false }],
      [204, { key: KEY2, rejected: true }],
    ])) {
      const local = area({ [K.KEY]: { key: KEY, rejected: status === 204 } });
      /** @type {() => void} */
      let release = () => undefined;
      const gate = new Promise((r) => (release = /** @type {any} */ (r)));
      const env = setup(async () => {
        await gate;
        return response(status, status === 401 ? { error: { code: "unauthorized" } } : "");
      }, { local });
      const pending = env.client.checkAuth();
      await flush();
      await local.set({ [K.KEY]: { key: KEY2, rejected: status === 204 } });
      release();
      assert.equal((await pending).outcome, status === 401 ? "wrong" : "ok");
      assert.deepEqual(local.data[K.KEY], expect, String(status));
    }
  });
});

describe("review fixes: a blocked address is not asked again until Retry-After has passed", () => {
  const lockout = (/** @type {number} */ sec) => response(429, { error: { code: "too_many_attempts", retryAfterSec: sec } }, { "Retry-After": String(sec) });
  const rateLimited = (/** @type {number} */ sec) => response(429, { error: { code: "rate_limited", retryAfterSec: sec } }, { "Retry-After": String(sec) });

  it("after a 429 from the check, further clicks answer 'blocked' locally, with the minutes left, without a request", async () => {
    const local = area({ [K.KEY]: { key: KEY, rejected: false } });
    const env = setup(() => lockout(290), { local });
    assert.deepEqual(await env.client.checkAuth(), { outcome: "blocked", retryAfterMin: 5 });
    assert.deepEqual(await env.client.checkAuth(), { outcome: "blocked", retryAfterMin: 5 });
    env.advance(150_000);
    assert.deepEqual(await env.client.checkAuth(), { outcome: "blocked", retryAfterMin: 3 }); // 140 s left
    env.advance(139_000);
    assert.deepEqual(await env.client.checkAuth(), { outcome: "blocked", retryAfterMin: 1 }); // never "0 minutes"
    assert.equal(env.calls.length, 1);
    env.advance(2_000);
    await env.client.checkAuth();
    assert.equal(env.calls.length, 2); // the wait is over: one real request again
  });

  it("a lookup's 429 from the access lock (too_many_attempts) blocks the check too; a route's rate limit (rate_limited) or a plain failure pause does not", async () => {
    const local = area({ [K.KEY]: { key: KEY, rejected: false } });
    const locked = setup(() => lockout(120), { local });
    assert.equal(await locked.client.lookup(CAL), null);
    assert.deepEqual(await locked.client.checkAuth(), { outcome: "blocked", retryAfterMin: 2 });
    assert.equal(locked.calls.length, 1);

    const limited = setup((/** @type {string} */ url) => (url.includes(A.AUTH_CHECK_PATH) ? response(204, "") : rateLimited(120)), { local: area({ [K.KEY]: { key: KEY, rejected: false } }) });
    assert.equal(await limited.client.lookup(CAL), null);
    assert.deepEqual(await limited.client.checkAuth(), { outcome: "ok" }); // /api/auth/check is not the route that limited us
    assert.equal(limited.calls.length, 2);

    const failed = setup((/** @type {string} */ url) => (url.includes(A.AUTH_CHECK_PATH) ? response(204, "") : response(500, "")), { local: area({ [K.KEY]: { key: KEY, rejected: false } }) });
    assert.equal(await failed.client.lookup(CAL), null); // a one-minute pause for lookups
    assert.deepEqual(await failed.client.checkAuth(), { outcome: "ok" }); // the user asked: one request
    assert.equal(failed.calls.length, 2);
  });

  it("the block survives a service worker restart (it is in the limiter's storage) and a clock that jumped back", async () => {
    const storage = A.memoryStorage();
    const first = setup(() => lockout(600), { local: area({ [K.KEY]: { key: KEY, rejected: false } }), storage });
    assert.deepEqual(await first.client.checkAuth(), { outcome: "blocked", retryAfterMin: 10 });
    const second = setup(() => response(204, ""), { local: area({ [K.KEY]: { key: KEY, rejected: false } }), storage });
    assert.deepEqual(await second.client.checkAuth(), { outcome: "blocked", retryAfterMin: 10 });
    assert.equal(second.calls.length, 0);
    await storage.set("apiLimiter", { calls: [], pausedUntil: 0, blockedUntil: START + 48 * 3_600_000 }); // a damaged or future value
    assert.deepEqual(await second.client.checkAuth(), { outcome: "blocked", retryAfterMin: A.MAX_PAUSE_MS / 60_000 }); // clamped to an hour, as pauses are
  });
});

describe("review fixes: after a check the API accepted, cached failures are forgotten", () => {
  it("a search that came back 401 shows data on the next try after the pause, not five minutes later; good data stays cached", async () => {
    const local = area();
    await K.save(local, KEY);
    let accepted = false;
    const env = setup((/** @type {string} */ url) => {
      if (url.includes(A.AUTH_CHECK_PATH)) return response(204, "");
      return accepted ? calendarOk() : response(401, { error: { code: "unauthorized" } });
    }, { local });
    assert.equal(await env.client.lookup(CAL), null); // cached as "nothing" for FAILURE_TTL_MS
    accepted = true; // the owner fixed the secret on the server
    assert.deepEqual(await env.client.checkAuth(), { outcome: "ok" });
    assert.deepEqual(local.data[K.KEY], { key: KEY, rejected: false });
    env.advance(A.FAILURE_PAUSE_MS + 1_000);
    assert.equal((await env.client.lookup(CAL))?.kind, "calendar"); // asked again, not the cached null
    assert.equal(env.calls.length, 3);
    assert.deepEqual(await env.client.checkAuth(), { outcome: "ok" });
    assert.equal((await env.client.lookup(CAL))?.kind, "calendar");
    assert.equal(env.calls.length, 4); // the good answer was kept: no fifth request
  });

  it("a check that is not 'ok' (wrong, unlocked, blocked) leaves the cache alone", async () => {
    for (const [status, withKey] of /** @type {[number, boolean][]} */ ([[401, true], [404, true], [204, false], [429, true]])) {
      const local = area(withKey ? { [K.KEY]: { key: KEY, rejected: false } } : {});
      let n = 0;
      const env = setup((/** @type {string} */ url) => (url.includes(A.AUTH_CHECK_PATH) ? response(status, "") : (n++, response(500, ""))), { local });
      assert.equal(await env.client.lookup(CAL), null);
      await env.client.checkAuth();
      env.advance(A.FAILURE_PAUSE_MS + 1_000);
      assert.equal(await env.client.lookup(CAL), null);
      assert.equal(n, 1, String(status)); // still the cached failure
    }
  });
});

describe("review fixes: the service worker itself (background.js, with a fake chrome)", () => {
  it("closes chrome.storage.local to content scripts at start (Chrome 130+, guarded), and routes messages by sender", async () => {
    /** @type {unknown[]} */
    const levels = [];
    /** @type {((m: any, s: any, r: (v: unknown) => void) => boolean)[]} */
    const listeners = [];
    const store = area({ [K.KEY]: { key: KEY, rejected: false } });
    const chrome = {
      runtime: { id: "eee-test", getURL: (/** @type {string} */ p) => `chrome-extension://eee-test/${p}`, onMessage: { addListener: (/** @type {any} */ fn) => void listeners.push(fn) } },
      storage: {
        local: { ...store, setAccessLevel: (/** @type {unknown} */ opts) => (levels.push(opts), Promise.reject(new Error("not supported here"))) },
        session: area(),
        sync: area(),
      },
    };
    /** @type {any} */ (globalThis).chrome = chrome;
    /** @type {{ url: string, init: any }[]} */
    const fetches = [];
    /** @type {any} */ (globalThis).fetch = async (/** @type {string} */ url, /** @type {any} */ init) => (fetches.push({ url, init }), response(204, ""));
    await import("../background.js"); // a rejected setAccessLevel (an older Chrome) must not break the start
    assert.deepEqual(levels, [{ accessLevel: "TRUSTED_CONTEXTS" }]);
    assert.match(code("background.js"), /chrome\.storage\.local\.setAccessLevel\?\.\(\{ accessLevel: "TRUSTED_CONTEXTS" \}\)/);
    assert.equal(listeners.length, 1);
    const onMessage = /** @type {any} */ (listeners[0]);
    const ask = (/** @type {unknown} */ message, /** @type {unknown} */ sender) =>
      new Promise((resolve) => {
        const handled = onMessage(message, sender, resolve);
        if (!handled) resolve("unhandled");
      });
    assert.equal(await ask({ type: "authCheck" }, { id: "eee-test", tab: { id: 1 } }), "unhandled"); // a content script (a tab) cannot check
    assert.equal(await ask({ type: "lookup", req: CAL }, { id: "eee-test" }), "unhandled"); // the popup does not look up
    assert.equal(await ask({ type: "authCheck" }, { id: "other" }), "unhandled"); // another extension
    assert.deepEqual(await ask({ type: "authCheck" }, { id: "eee-test" }), { outcome: "ok" }); // the toolbar popup
    assert.equal(fetches.length, 1);
    assert.equal(new URL(fetches[0].url).pathname, A.AUTH_CHECK_PATH);
    assert.deepEqual(fetches[0].init.headers, { Accept: "application/json", Authorization: `Bearer ${KEY}` });
  });
});
