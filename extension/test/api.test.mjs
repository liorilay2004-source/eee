/**
 * The service worker's API client (lib/api.js) with a fake clock, fake timers, fake fetch and in-memory storage:
 * what is sent, caching, the global limiter, pauses after 429 / failures, timeouts, and response checking.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EEE, fixture } from "./helpers.mjs";

const A = EEE.api;
const START = Date.parse("2026-09-30T08:00:00Z");
const CAL = { kind: "calendar", origin: "TLV", destination: "ATH", month: "2026-11" };
const EXP = { kind: "explore", origin: "TLV", month: "2026-11" };

/** @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
function response(status, body, headers = {}) {
  const h = { "content-type": "application/json; charset=utf-8", ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
  return { status, ok: status >= 200 && status < 300, headers: { get: (/** @type {string} */ n) => h[/** @type {keyof typeof h} */ (n.toLowerCase())] ?? null }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

/**
 * @param {(url: string, init: any, n: number) => any} responder
 * @param {{ storage?: any, now?: number }} [opts]
 */
function setup(responder, opts = {}) {
  const state = { now: opts.now ?? START };
  /** @type {{ url: string, init: any }[]} */
  const calls = [];
  /** @type {Map<number, { fn: () => void, at: number }>} */
  const timers = new Map();
  let nextId = 1;
  const storage = opts.storage ?? A.memoryStorage();
  const deps = {
    now: () => state.now,
    storage,
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
  };
  return {
    client: A.createClient(deps),
    calls,
    storage,
    timers,
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

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const calendarOk = () => response(200, fixture("calendar.json"));
const exploreOk = () => response(200, fixture("explore.json"));

describe("what is sent", () => {
  it("calendar: exactly origin, destination and month; explore: origin, month and the fixed limit", async () => {
    const env = setup((url) => (url.includes("/api/calendar") ? calendarOk() : exploreOk()));
    await env.client.lookup(CAL);
    await env.client.lookup(EXP);
    const [cal, exp] = env.calls.map((c) => new URL(c.url));
    assert.equal(cal?.origin, "https://eee-api.liorilay2004.workers.dev");
    assert.equal(cal?.pathname, "/api/calendar");
    assert.deepEqual([...(cal?.searchParams ?? [])], [["origin", "TLV"], ["destination", "ATH"], ["month", "2026-11"]]);
    assert.equal(exp?.pathname, "/api/explore");
    assert.deepEqual([...(exp?.searchParams ?? [])], [["origin", "TLV"], ["month", "2026-11"], ["limit", "3"]]);
  });

  it("shares only an explicit fare tuple, with no page URL, text, cookies, referrer or retry", async () => {
    const env = setup(() => response(201, { saved: true }));
    const observation = { host: "www.lufthansa.com", origin: "TLV", destination: "FRA", departDate: "2027-06-01", returnDate: "2027-06-08", priceAmount: 489.9, currency: "EUR", pageUrl: "https://www.lufthansa.com/?session=secret", pageText: "private text" };
    assert.deepEqual(await env.client.shareObservation(observation), { ok: true, status: 201 });
    assert.equal(env.calls.length, 1);
    const call = env.calls[0];
    assert.equal(new URL(call.url).pathname, "/api/community-fares");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.referrerPolicy, "no-referrer");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.redirect, "error");
    assert.deepEqual(JSON.parse(call.init.body), { host: "www.lufthansa.com", origin: "TLV", destination: "FRA", departDate: "2027-06-01", returnDate: "2027-06-08", priceAmount: 489.9, currency: "EUR" });
    assert.equal(call.init.body.includes("session"), false);
    assert.equal(call.init.body.includes("private text"), false);
  });

  it("does not share malformed observations", async () => {
    const env = setup(() => response(201, { saved: true }));
    assert.deepEqual(await env.client.shareObservation({ host: "invalid host", origin: "TLV", destination: "FRA", departDate: "2027-06-01", returnDate: "2027-06-08", priceAmount: 489.9, currency: "EUR" }), { ok: false, status: 0 });
    assert.equal(env.calls.length, 0);
  });

  it("no cookies, no referrer, no body, no custom identity: GET with Accept only", async () => {
    const env = setup(() => calendarOk());
    await env.client.lookup(CAL);
    const init = env.calls[0]?.init;
    assert.equal(init.method, "GET");
    assert.equal(init.credentials, "omit");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.equal(init.body, undefined);
    assert.deepEqual(init.headers, { Accept: "application/json" });
  });

  it("only valid requests, and only their three fields, ever go out", async () => {
    const env = setup(() => calendarOk());
    for (const bad of [
      null,
      "TLV-ATH",
      { ...CAL, origin: "tlv" },
      { ...CAL, destination: "TLV" },
      { ...CAL, month: "2026-13" },
      { ...CAL, month: "11/2026" },
      { ...CAL, kind: "search" },
      { ...EXP, origin: "HFA" },
      { kind: "calendar", origin: "TLV", month: "2026-11" },
    ]) {
      assert.equal(await env.client.lookup(bad), null);
    }
    assert.equal(env.calls.length, 0);
    await env.client.lookup({ ...CAL, q: "טיסות לאתונה", url: "https://www.google.com/search?q=x", cookie: "a=b" });
    assert.equal(env.calls.length, 1);
    const sent = /** @type {string} */ (env.calls[0]?.url);
    assert.ok(!sent.includes("google") && !sent.includes("cookie") && !sent.includes("%D7"), sent);
    assert.deepEqual(A.validateRequest({ ...CAL, extra: 1 }), CAL);
  });
});

describe("cache", () => {
  it("an answer is reused for 30 minutes, then asked again", async () => {
    const env = setup(() => calendarOk());
    const first = await env.client.lookup(CAL);
    assert.equal(first?.kind, "calendar");
    env.advance(29 * 60_000);
    assert.deepEqual(await env.client.lookup(CAL), first);
    assert.equal(env.calls.length, 1);
    env.advance(2 * 60_000);
    await env.client.lookup(CAL);
    assert.equal(env.calls.length, 2);
  });

  it("an answer with nothing to show is null and kept 10 minutes", async () => {
    const env = setup(() => response(200, { days: [{ date: "2026-11-02", known: true, fare: null }], meta: {} }));
    assert.equal(await env.client.lookup(CAL), null);
    env.advance(9 * 60_000);
    assert.equal(await env.client.lookup(CAL), null);
    assert.equal(env.calls.length, 1);
    env.advance(2 * 60_000);
    await env.client.lookup(CAL);
    assert.equal(env.calls.length, 2);
  });

  it("a 400 is not asked again for 30 minutes", async () => {
    const env = setup(() => response(400, { error: { code: "invalid_request" } }));
    assert.equal(await env.client.lookup(CAL), null);
    env.advance(20 * 60_000);
    assert.equal(await env.client.lookup(CAL), null);
    assert.equal(env.calls.length, 1);
  });

  it("the same request asked twice at once makes one call", async () => {
    const env = setup(() => calendarOk());
    const [a, b] = await Promise.all([env.client.lookup(CAL), env.client.lookup(CAL)]);
    assert.deepEqual(a, b);
    assert.equal(env.calls.length, 1);
  });
});

describe("limits and pauses", () => {
  it(`at most ${A.LIMIT_MAX} calls per 10 minutes for the whole browser`, async () => {
    const env = setup(() => calendarOk());
    const months = ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08"];
    const results = [];
    for (const month of months) results.push(await env.client.lookup({ ...CAL, month }));
    assert.equal(env.calls.length, A.LIMIT_MAX);
    assert.equal(results[A.LIMIT_MAX], null); // the 11th: silent, no call
    env.advance(10 * 60_000 + 1);
    await env.client.lookup({ ...CAL, month: "2027-08" });
    assert.equal(env.calls.length, A.LIMIT_MAX + 1);
  });

  it("the limiter survives a service worker restart (state in session storage)", async () => {
    const storage = A.memoryStorage();
    const first = setup(() => calendarOk(), { storage });
    for (let i = 0; i < A.LIMIT_MAX; i++) await first.client.lookup({ ...CAL, destination: ["ATH", "ROM", "PAR", "LON", "BER", "BUD", "PRG", "VIE", "MAD", "BCN"][i] });
    const second = setup(() => calendarOk(), { storage });
    assert.equal(await second.client.lookup({ ...CAL, destination: "LIS" }), null);
    assert.equal(second.calls.length, 0);
  });

  it("a 429 pauses every call for Retry-After seconds", async () => {
    const env = setup((url, _i, n) => (n === 1 ? response(429, { error: { code: "rate_limited", retryAfterSec: 30 } }, { "Retry-After": "120" }) : calendarOk()));
    assert.equal(await env.client.lookup(CAL), null);
    env.advance(119_000);
    assert.equal(await env.client.lookup({ ...CAL, destination: "ROM" }), null);
    assert.equal(env.calls.length, 1);
    env.advance(2_000);
    assert.equal((await env.client.lookup({ ...CAL, destination: "ROM" }))?.kind, "calendar");
    assert.equal(env.calls.length, 2);
  });

  it("Retry-After as a date, from the body, missing, or absurd", () => {
    const now = START;
    const headers = (/** @type {string | null} */ v) => ({ get: () => v });
    assert.equal(A.retryAfterMs(headers("300"), null, now), 300_000);
    assert.equal(A.retryAfterMs(headers(new Date(now + 600_000).toUTCString()), null, now), 600_000);
    assert.equal(A.retryAfterMs(headers(null), { error: { retryAfterSec: 90 } }, now), 90_000);
    assert.equal(A.retryAfterMs(headers(null), null, now), A.MIN_429_PAUSE_MS);
    assert.equal(A.retryAfterMs(headers("5"), null, now), A.MIN_429_PAUSE_MS);
    assert.equal(A.retryAfterMs(headers("999999"), null, now), A.MAX_PAUSE_MS);
    assert.equal(A.retryAfterMs(headers("soon"), null, now), A.MIN_429_PAUSE_MS);
  });

  it("a server error pauses every call for a minute and is not retried by itself", async () => {
    const env = setup((_u, _i, n) => (n === 1 ? response(503, { error: { code: "source_unavailable" } }) : calendarOk()));
    assert.equal(await env.client.lookup(CAL), null);
    env.advance(30_000);
    assert.equal(await env.client.lookup({ ...CAL, destination: "ROM" }), null);
    assert.equal(env.calls.length, 1);
    env.advance(10 * 60_000);
    await flush();
    assert.equal(env.calls.length, 1); // nothing happens without a new lookup: no retry loop
    assert.equal((await env.client.lookup(CAL))?.kind, "calendar"); // after its 5-minute failure cache
    assert.equal(env.calls.length, 2);
  });

  it("a network error behaves like a server error", async () => {
    const env = setup(() => {
      throw new TypeError("Failed to fetch");
    });
    assert.equal(await env.client.lookup(CAL), null);
    env.advance(30_000);
    assert.equal(await env.client.lookup(EXP), null);
    assert.equal(env.calls.length, 1);
  });

  it("times out after 8 seconds, even when fetch ignores the abort signal", async () => {
    /** @type {any} */
    let signal = null;
    const env = setup((_u, init) => {
      signal = init.signal;
      return new Promise(() => {}); // never settles
    });
    const pending = env.client.lookup(CAL);
    await flush();
    assert.equal(env.calls.length, 1);
    env.advance(A.TIMEOUT_MS - 1);
    await flush();
    let settled = false;
    void pending.then(() => (settled = true));
    await flush();
    assert.equal(settled, false);
    env.advance(1);
    assert.equal(await pending, null);
    assert.equal(signal?.aborted, true);
    env.advance(30_000);
    assert.equal(await env.client.lookup(EXP), null); // paused after the timeout
    assert.equal(env.calls.length, 1);
  });

  it("a clock that jumped back cannot pause calls for more than an hour", async () => {
    const storage = A.memoryStorage();
    await storage.set("apiLimiter", { calls: [], pausedUntil: START + 365 * 86_400_000 });
    const env = setup(() => calendarOk(), { storage });
    assert.equal(await env.client.lookup(CAL), null);
    env.advance(A.MAX_PAUSE_MS + 1);
    assert.equal((await env.client.lookup(CAL))?.kind, "calendar");
  });

  it("a broken storage never breaks a lookup", async () => {
    const broken = { get: async () => { throw new Error("quota"); }, set: async () => { throw new Error("quota"); } };
    const env = setup(() => calendarOk(), { storage: broken });
    assert.equal((await env.client.lookup(CAL))?.kind, "calendar");
  });
});

describe("responses are checked field by field", () => {
  it("calendar: priced, known days of the asked month only; untrusted links dropped", () => {
    const data = /** @type {any} */ (A.sanitizeCalendar(fixture("calendar.json"), CAL));
    assert.deepEqual(data.days.map((/** @type {any} */ d) => d.date), ["2026-11-02", "2026-11-06", "2026-11-10", "2026-11-12"]);
    const cheap = data.days.find((/** @type {any} */ d) => d.date === "2026-11-10");
    assert.deepEqual(cheap, { date: "2026-11-10", priceIls: 350.21, returnDate: "2026-11-20", nights: 10, stops: 0, returnStops: 0, book: "https://www.aviasales.com/search/TLV1011ATH20111?t=fixture-c" });
    assert.equal(data.days.find((/** @type {any} */ d) => d.date === "2026-11-12").book, null); // evil.example
    assert.equal(data.insightHe, "יציאה ביום ג׳ זולה בממוצע ב-26% מיציאה ביום ה׳");
    assert.match(data.noticeHe, /^המחירים הם מחירים שמורים/);
    assert.equal(A.sanitizeCalendar({ days: "x" }, CAL), null);
    assert.equal(A.sanitizeCalendar(null, CAL), null);
  });

  it("explore: cheapest first, top three, never Israel, links checked", () => {
    const data = /** @type {any} */ (A.sanitizeExplore(fixture("explore.json"), EXP));
    assert.deepEqual(data.results.map((/** @type {any} */ r) => `${r.code}:${r.priceIls}`), ["LCA:178", "PMO:276", "PFO:298"]);
    assert.equal(data.results[2].book, null); // http://
    assert.equal(data.results[0].countryHe, "קפריסין");
    assert.equal(data.results[1].countryHe, null); // older deploys send no countryHe
    assert.match(data.noticeHe, /^המחירים הם מחירי מטמון/);
    assert.equal(A.sanitizeExplore({ results: {} }, EXP), null);
  });

  it("booking links: https Aviasales only", () => {
    assert.equal(A.trustedBookingUrl("https://www.aviasales.com/search/TLV1011ATH20111"), "https://www.aviasales.com/search/TLV1011ATH20111");
    assert.equal(A.trustedBookingUrl("https://aviasales.com/x"), "https://aviasales.com/x");
    for (const bad of ["http://www.aviasales.com/x", "https://aviasales.com.evil.example/x", "https://evil.example/?https://www.aviasales.com", "javascript:alert(1)", "https://user:pw@www.aviasales.com/", "", null, 7]) {
      assert.equal(A.trustedBookingUrl(bad), null, String(bad));
    }
  });

  it("a non-JSON or oversized body is a quiet failure", async () => {
    const html = setup(() => response(200, "<html>", { "content-type": "text/html" }));
    assert.equal(await html.client.lookup(CAL), null);
    const broken = setup(() => response(200, "{not json"));
    assert.equal(await broken.client.lookup(CAL), null);
    const huge = setup(() => response(200, "x".repeat(1_000_001)));
    assert.equal(await huge.client.lookup(CAL), null);
  });

  it("a body declared larger than 1 MB is not read at all", async () => {
    let read = false;
    const env = setup(() => ({ ...calendarOk(), headers: { get: (/** @type {string} */ n) => (n.toLowerCase() === "content-length" ? "5000000" : n.toLowerCase() === "content-type" ? "application/json" : null) }, text: async () => ((read = true), "{}") }));
    assert.equal(await env.client.lookup(CAL), null);
    assert.equal(read, false);
  });

  it("a streamed body is cancelled as soon as it passes 1 MB, and a normal one is read in chunks", async () => {
    /** @param {Uint8Array[]} chunks */
    const streamed = (chunks) => {
      const state = { cancelled: false, served: 0 };
      const body = {
        getReader: () => ({
          read: async () => (state.served < chunks.length ? { done: false, value: chunks[state.served++] } : { done: true, value: undefined }),
          cancel: async () => void (state.cancelled = true),
        }),
      };
      return { state, body };
    };
    const big = streamed(Array.from({ length: 40 }, () => new Uint8Array(100_000).fill(0x20)));
    const env = setup(() => ({ ...calendarOk(), body: big.body }));
    assert.equal(await env.client.lookup(CAL), null);
    assert.equal(big.state.cancelled, true);
    assert.ok(big.state.served <= 11, `read ${big.state.served} chunks`);
    const json = new TextEncoder().encode(JSON.stringify(fixture("calendar.json")));
    const ok = streamed([json.subarray(0, 1000), json.subarray(1000)]);
    const env2 = setup(() => ({ ...calendarOk(), body: ok.body }));
    assert.equal((await env2.client.lookup(CAL))?.kind, "calendar");
  });

  it("texts shown on the card lose control characters and bidi embedding/override/isolate controls", () => {
    const body = /** @type {any} */ (fixture("calendar.json"));
    body.meta.insights.summaryHe = "יציאה ביום ג׳ " + "\u202E" + "זולה" + "\u202C" + " " + "\u2066" + "ב-26%" + "\u2069" + "\u0007";
    const data = /** @type {any} */ (A.sanitizeCalendar(body, CAL));
    assert.equal(data.insightHe, "יציאה ביום ג׳ זולה ב-26%");
    assert.doesNotMatch(data.insightHe, /[\u202a-\u202e\u2066-\u2069\u0000-\u001f]/);
  });
});

describe("the limiter never fails open", () => {
  it("a storage that always fails still limits calls (in memory)", async () => {
    const broken = { get: async () => { throw new Error("quota"); }, set: async () => { throw new Error("quota"); } };
    const env = setup(() => calendarOk(), { storage: broken });
    const months = ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09"];
    for (const month of months) await env.client.lookup({ ...CAL, month });
    assert.equal(env.calls.length, A.LIMIT_MAX);
  });

  it("a 429 pause holds even when storage cannot keep it", async () => {
    const broken = { get: async () => { throw new Error("gone"); }, set: async () => { throw new Error("gone"); } };
    const env = setup((_u, _i, n) => (n === 1 ? response(429, {}, { "Retry-After": "120" }) : calendarOk()), { storage: broken });
    assert.equal(await env.client.lookup(CAL), null);
    env.advance(60_000);
    assert.equal(await env.client.lookup({ ...CAL, destination: "ROM" }), null);
    assert.equal(env.calls.length, 1);
    env.advance(61_000);
    assert.equal((await env.client.lookup({ ...CAL, destination: "ROM" }))?.kind, "calendar");
  });

  it("storage that lost its state (read returns nothing) does not reset the count", async () => {
    let calls = 0;
    const forgetful = { get: async () => undefined, set: async () => void calls++ };
    const env = setup(() => calendarOk(), { storage: forgetful });
    const months = ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08"];
    for (const month of months) await env.client.lookup({ ...CAL, month });
    assert.equal(env.calls.length, A.LIMIT_MAX);
    assert.ok(calls > 0);
  });
});
