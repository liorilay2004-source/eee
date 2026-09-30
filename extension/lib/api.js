/**
 * The extension's only network code, used by the background service worker alone.
 *
 * What is sent: GET /api/calendar?origin=TLV&destination=ATH&month=2026-11 or GET /api/explore?origin=TLV&month=2026-11
 * &limit=3. Nothing else: no query text, no page address, no cookies (credentials: "omit"), no referrer, no identifier,
 * no analytics. Requests are validated here again, whatever the caller sent.
 *
 * Politeness, well below the API's own per-client limits (worker/src/calendar.ts and explore.ts: 30 per 10 minutes each):
 *   - every answer is cached for 30 minutes (an answer with nothing to show, or a failure, for less);
 *   - at most LIMIT_MAX calls per LIMIT_WINDOW_MS for the whole browser, kept in chrome.storage.session so a restarted
 *     service worker still remembers them, and in memory too, so a storage that fails never lifts the limit;
 *   - a 429 pauses ALL calls for its Retry-After (at least a minute), any other failure for a minute;
 *   - never a retry: a failed lookup stays silent until the user searches again after the pause;
 *   - 8 second timeout; one request at a time per key; a body over 1 MB is not read to the end.
 * Answers are reduced to the few fields the popup shows and checked field by field (the response is data, not trusted):
 * control characters and bidi embedding/override/isolate controls are stripped from every text shown.
 */
(() => {
  "use strict";
  const EEE = /** @type {any} */ ((/** @type {any} */ (globalThis))[Symbol.for("eee.extension")] ??= {});
  if (EEE.api) return;

  const API_BASE = "https://eee-api.liorilay2004.workers.dev";
  const LIMIT_MAX = 10;
  const LIMIT_WINDOW_MS = 10 * 60_000;
  const CACHE_TTL_MS = 30 * 60_000;
  /** A well-formed answer without any fare to show. */
  const EMPTY_TTL_MS = 10 * 60_000;
  /** 400/404: asking the same again cannot help. */
  const INVALID_TTL_MS = 30 * 60_000;
  /** 5xx, network error, timeout, unreadable body. */
  const FAILURE_TTL_MS = 5 * 60_000;
  const FAILURE_PAUSE_MS = 60_000;
  const MIN_429_PAUSE_MS = 60_000;
  const MAX_PAUSE_MS = 60 * 60_000;
  const TIMEOUT_MS = 8_000;
  const MAX_BODY_BYTES = 1_000_000;
  /** A 429 body is read only for its retryAfterSec. */
  const MAX_ERROR_BODY_BYTES = 16_384;
  const MAX_CACHE_ENTRIES = 60;
  const EXPLORE_LIMIT = 3;
  const STATE_KEY = "apiLimiter";
  const CACHE_KEY = "apiCache";

  const IATA = /^[A-Z]{3}$/;
  const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const EXPLORE_ORIGINS = ["TLV", "ETM"];

  /**
   * @typedef {{ kind: "calendar", origin: string, destination: string, month: string } | { kind: "explore", origin: string, month: string }} ApiRequest
   * @typedef {{ date: string, priceIls: number, returnDate: string, nights: number, stops: number | null, returnStops: number | null, book: string | null }} DayFare
   * @typedef {{ kind: "calendar", month: string, days: DayFare[], insightHe: string | null, noticeHe: string | null }} CalendarData
   * @typedef {{ code: string, nameHe: string | null, nameEn: string | null, countryHe: string | null, cc: string | null, priceIls: number, departDate: string, returnDate: string, nights: number, stops: number | null, book: string | null }} ExploreItem
   * @typedef {{ kind: "explore", month: string, results: ExploreItem[], noticeHe: string | null }} ExploreData
   */

  /**
   * A clean copy of a request, or null. Only these fields, only these shapes.
   * @param {unknown} input
   * @returns {ApiRequest | null}
   */
  function validateRequest(input) {
    const r = /** @type {Record<string, unknown> | null} */ (input && typeof input === "object" ? input : null);
    if (!r || typeof r.month !== "string" || !MONTH.test(r.month) || typeof r.origin !== "string" || !IATA.test(r.origin)) return null;
    if (r.kind === "calendar") {
      if (typeof r.destination !== "string" || !IATA.test(r.destination) || r.destination === r.origin) return null;
      return { kind: "calendar", origin: r.origin, destination: r.destination, month: r.month };
    }
    if (r.kind === "explore" && EXPLORE_ORIGINS.includes(r.origin)) return { kind: "explore", origin: r.origin, month: r.month };
    return null;
  }

  /** @param {ApiRequest} req */
  function buildUrl(req) {
    const u = new URL(req.kind === "calendar" ? "/api/calendar" : "/api/explore", API_BASE);
    u.searchParams.set("origin", req.origin);
    if (req.kind === "calendar") u.searchParams.set("destination", req.destination);
    u.searchParams.set("month", req.month);
    if (req.kind === "explore") u.searchParams.set("limit", String(EXPLORE_LIMIT));
    return u.toString();
  }

  /** @param {ApiRequest} req */
  const cacheKeyOf = (req) => (req.kind === "calendar" ? `c:${req.origin}:${req.destination}:${req.month}` : `e:${req.origin}:${req.month}`);

  /**
   * A booking link from the API is used only when it is an https link to Aviasales (the only booking site the API
   * links to, the same rule as the website's trustedBookingUrl). We never build one ourselves.
   * @param {unknown} raw
   * @returns {string | null}
   */
  function trustedBookingUrl(raw) {
    if (typeof raw !== "string" || raw.length > 2048) return null;
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if (u.protocol !== "https:" || u.username || u.password) return null;
      return host === "aviasales.com" || host.endsWith(".aviasales.com") ? u.toString() : null;
    } catch {
      return null;
    }
  }

  const isRecord = (/** @type {unknown} */ v) => typeof v === "object" && v !== null && !Array.isArray(v);
  /** @param {unknown} v @param {number} max */
  const cleanText = (v, max) => {
    if (typeof v !== "string") return null;
    // Bidi embeddings, overrides and isolates (U+202A-U+202E, U+2066-U+2069) could reorder what the card shows.
    const t = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/[\u202a-\u202e\u2066-\u2069]/g, "").trim();
    return t !== "" && t.length <= max ? t : null;
  };
  /** @param {unknown} v */
  const price = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1_000_000 ? v : null);
  /** @param {unknown} v */
  const stopsOf = (v) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 5 ? v : null);
  /** @param {unknown} v */
  const isDay = (v) => typeof v === "string" && DAY.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));
  const nightsBetween = (/** @type {string} */ a, /** @type {string} */ b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

  /**
   * /api/calendar answer -> the fares of the asked month (priced days only), or null when the shape is wrong.
   * @param {unknown} body
   * @param {Extract<ApiRequest, { kind: "calendar" }>} req
   * @returns {CalendarData | null}
   */
  function sanitizeCalendar(body, req) {
    if (!isRecord(body)) return null;
    const b = /** @type {Record<string, any>} */ (body);
    if (!Array.isArray(b.days)) return null;
    /** @type {DayFare[]} */
    const days = [];
    for (const d of b.days.slice(0, 100)) {
      if (!isRecord(d) || d.known !== true || !isDay(d.date) || !d.date.startsWith(`${req.month}-`) || !isRecord(d.fare)) continue;
      const f = d.fare;
      const priceIls = price(f.priceIls);
      if (priceIls === null || !isDay(f.returnDate) || f.returnDate <= d.date) continue;
      const nights = nightsBetween(d.date, f.returnDate);
      if (nights < 1 || nights > 30) continue;
      days.push({ date: d.date, priceIls, returnDate: f.returnDate, nights, stops: stopsOf(f.stops), returnStops: stopsOf(f.returnStops), book: trustedBookingUrl(f.deeplink) });
    }
    days.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    const meta = isRecord(b.meta) ? b.meta : {};
    return {
      kind: "calendar",
      month: req.month,
      days: days.slice(0, 31),
      insightHe: isRecord(meta.insights) ? cleanText(meta.insights.summaryHe, 200) : null,
      noticeHe: cleanText(meta.noticeHe, 400),
    };
  }

  /**
   * /api/explore answer -> up to three destinations, cheapest first, or null when the shape is wrong.
   * @param {unknown} body
   * @param {Extract<ApiRequest, { kind: "explore" }>} req
   * @returns {ExploreData | null}
   */
  function sanitizeExplore(body, req) {
    if (!isRecord(body)) return null;
    const b = /** @type {Record<string, any>} */ (body);
    if (!Array.isArray(b.results)) return null;
    /** @type {ExploreItem[]} */
    const results = [];
    for (const r of b.results.slice(0, 50)) {
      if (!isRecord(r) || !isRecord(r.destination) || !isRecord(r.price)) continue;
      const code = typeof r.destination.code === "string" && IATA.test(r.destination.code) ? r.destination.code : null;
      const priceIls = price(r.price.ils);
      if (!code || code === req.origin || priceIls === null || !isDay(r.departDate) || !isDay(r.returnDate) || r.returnDate <= r.departDate) continue;
      if (!r.departDate.startsWith(`${req.month}-`)) continue;
      const nights = nightsBetween(r.departDate, r.returnDate);
      if (nights < 1 || nights > 30) continue;
      const cc = typeof r.destination.countryCode === "string" && /^[A-Z]{2}$/.test(r.destination.countryCode) ? r.destination.countryCode : null;
      if (cc === "IL") continue;
      results.push({
        code,
        nameHe: cleanText(r.destination.nameHe, 60),
        nameEn: cleanText(r.destination.nameEn, 60),
        countryHe: cleanText(r.destination.countryHe, 60),
        cc,
        priceIls,
        departDate: r.departDate,
        returnDate: r.returnDate,
        nights,
        stops: stopsOf(r.stops),
        book: isRecord(r.links) ? trustedBookingUrl(r.links.book) : null,
      });
    }
    results.sort((x, y) => x.priceIls - y.priceIls || (x.code < y.code ? -1 : 1));
    const meta = isRecord(b.meta) ? b.meta : {};
    const notes = Array.isArray(meta.notes) ? meta.notes : [];
    return { kind: "explore", month: req.month, results: results.slice(0, EXPLORE_LIMIT), noticeHe: cleanText(notes[0], 400) };
  }

  /**
   * How long a 429 asks us to wait: Retry-After (seconds or an HTTP date), else the body's retryAfterSec; clamped to
   * [MIN_429_PAUSE_MS, MAX_PAUSE_MS].
   * @param {{ get(name: string): string | null } | undefined} headers
   * @param {unknown} body
   * @param {number} nowMs
   */
  function retryAfterMs(headers, body, nowMs) {
    let sec = Number.NaN;
    const h = headers?.get("Retry-After")?.trim();
    if (h) {
      if (/^\d{1,7}$/.test(h)) sec = Number(h);
      else {
        const t = Date.parse(h);
        if (Number.isFinite(t)) sec = (t - nowMs) / 1000;
      }
    }
    if (!Number.isFinite(sec) && isRecord(body)) {
      const e = /** @type {any} */ (body).error;
      if (isRecord(e) && typeof e.retryAfterSec === "number") sec = e.retryAfterSec;
    }
    const ms = Number.isFinite(sec) ? sec * 1000 : MIN_429_PAUSE_MS;
    return Math.min(MAX_PAUSE_MS, Math.max(MIN_429_PAUSE_MS, ms));
  }

  // --- storage ------------------------------------------------------------------------------------------------

  /**
   * @typedef {{ get(key: string): Promise<unknown>, set(key: string, value: unknown): Promise<void> }} KeyValue
   */

  /** In-memory storage: the fallback when chrome.storage.session is missing, and the tests' storage. @returns {KeyValue} */
  function memoryStorage() {
    /** @type {Map<string, string>} */
    const map = new Map();
    return {
      async get(key) {
        const v = map.get(key);
        return v === undefined ? undefined : JSON.parse(v);
      },
      async set(key, value) {
        map.set(key, JSON.stringify(value));
      },
    };
  }

  /**
   * chrome.storage.session (cleared when the browser closes) behind the KeyValue interface, or null.
   * @param {any} area
   * @returns {KeyValue | null}
   */
  function chromeStorage(area) {
    if (!area || typeof area.get !== "function" || typeof area.set !== "function") return null;
    return {
      async get(key) {
        const got = await area.get(key);
        return got ? got[key] : undefined;
      },
      async set(key, value) {
        await area.set({ [key]: value });
      },
    };
  }

  // --- the client ---------------------------------------------------------------------------------------------

  /**
   * @param {{
   *   fetch: (url: string, init: Record<string, unknown>) => Promise<{ status: number, ok: boolean, headers: { get(n: string): string | null }, text(): Promise<string>, body?: { getReader?: () => any } | null }>,
   *   now: () => number,
   *   storage: KeyValue,
   *   setTimeout: (fn: () => void, ms: number) => unknown,
   *   clearTimeout: (t: unknown) => void,
   * }} deps
   */
  function createClient(deps) {
    /** @type {Map<string, Promise<CalendarData | ExploreData | null>>} */
    const inflight = new Map();
    /** @type {Promise<unknown>} */
    let chain = Promise.resolve();
    /**
     * Runs fn after every earlier locked call: the limiter state is read-modified-written without interleaving.
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    const locked = (fn) => {
      const run = chain.then(fn, fn);
      chain = run.catch(() => undefined);
      return run;
    };

    /**
     * The limiter as this service worker last wrote it. Storage is the truth across restarts; this copy keeps the limit
     * (and a pause) in force when storage reads or writes fail, so a broken storage never means unlimited calls.
     * @type {{ calls: number[], pausedUntil: number }}
     */
    let memState = { calls: [], pausedUntil: 0 };

    async function readState() {
      const raw = /** @type {any} */ (await deps.storage.get(STATE_KEY).catch(() => undefined));
      const stored = Array.isArray(raw?.calls) ? raw.calls.filter((/** @type {unknown} */ t) => typeof t === "number" && Number.isFinite(t)) : [];
      const storedPause = typeof raw?.pausedUntil === "number" && Number.isFinite(raw.pausedUntil) ? raw.pausedUntil : 0;
      const calls = stored.length >= memState.calls.length ? stored : [...memState.calls];
      return { calls, pausedUntil: Math.max(storedPause, memState.pausedUntil) };
    }

    /** @param {{ calls: number[], pausedUntil: number }} st */
    const writeState = (st) => {
      memState = { calls: [...st.calls], pausedUntil: st.pausedUntil };
      return deps.storage.set(STATE_KEY, st).catch(() => undefined);
    };

    /** @returns {Promise<Record<string, { at: number, ttl: number, data: unknown }>>} */
    async function readCacheAll() {
      const raw = await deps.storage.get(CACHE_KEY).catch(() => undefined);
      return isRecord(raw) ? /** @type {any} */ (raw) : {};
    }

    /**
     * true = go ahead (and the call is counted); false = paused or over the limit.
     * @param {number} nowMs
     */
    async function takePermit(nowMs) {
      const st = await readState();
      // A clock that jumped back must not pause us forever (the clamp is stored, so the pause really ends), nor keep
      // calls from "the future" counted.
      if (st.pausedUntil > nowMs + MAX_PAUSE_MS) {
        st.pausedUntil = nowMs + MAX_PAUSE_MS;
        await writeState(st);
      }
      if (st.pausedUntil > nowMs) return false;
      st.calls = st.calls.filter((t) => t > nowMs - LIMIT_WINDOW_MS && t <= nowMs + 60_000);
      if (st.calls.length >= LIMIT_MAX) {
        await writeState(st);
        return false;
      }
      st.calls.push(nowMs);
      await writeState(st);
      return true;
    }

    /**
     * @param {string} key
     * @param {number} nowMs
     * @returns {Promise<{ data: unknown } | undefined>}
     */
    async function cached(key, nowMs) {
      const all = await readCacheAll();
      const e = all[key];
      if (!isRecord(e) || typeof e.at !== "number" || typeof e.ttl !== "number") return undefined;
      if (e.at > nowMs + 60_000 || nowMs - e.at >= e.ttl) return undefined;
      return { data: e.data ?? null };
    }

    /**
     * @param {string} key
     * @param {number} nowMs
     * @param {number} ttl
     * @param {unknown} data
     */
    async function remember(key, nowMs, ttl, data) {
      if (ttl <= 0) return;
      const all = await readCacheAll();
      const live = Object.entries(all).filter(([, e]) => isRecord(e) && typeof e.at === "number" && typeof e.ttl === "number" && nowMs - e.at < e.ttl && e.at <= nowMs + 60_000);
      live.push([key, { at: nowMs, ttl, data }]);
      const kept = live.sort((x, y) => /** @type {any} */ (y[1]).at - /** @type {any} */ (x[1]).at).slice(0, MAX_CACHE_ENTRIES);
      await deps.storage.set(CACHE_KEY, Object.fromEntries(kept)).catch(() => undefined);
    }

    /**
     * The response body as text, or null when it is (or grows) larger than `max` bytes: a declared Content-Length over
     * the limit is not read at all, a streamed body is cancelled as soon as it passes the limit.
     * @param {any} res
     * @param {Promise<never>} timeout
     * @param {number} max
     * @returns {Promise<string | null>}
     */
    async function readBody(res, timeout, max) {
      const declared = Number(res.headers.get("Content-Length"));
      if (Number.isFinite(declared) && declared > max) return null;
      const reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null;
      if (!reader) {
        const text = await Promise.race([res.text(), timeout]);
        return typeof text === "string" && text.length <= max ? text : null;
      }
      const decoder = new TextDecoder("utf-8");
      let text = "";
      let size = 0;
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), timeout]);
        if (done) break;
        size += value?.byteLength ?? 0;
        if (size > max) {
          void Promise.resolve(reader.cancel()).catch(() => undefined);
          return null;
        }
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    }

    /**
     * One API call. Never throws.
     * @param {ApiRequest} req
     * @returns {Promise<{ data: CalendarData | ExploreData | null, ttl: number, pauseMs: number }>}
     */
    async function call(req) {
      /** @type {unknown} */
      let timer;
      try {
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        // The timer both aborts the request and settles the wait, even for a fetch that ignores the signal.
        /** @type {Promise<never>} */
        const timeout = new Promise((_, reject) => {
          timer = deps.setTimeout(() => {
            controller?.abort();
            reject(new Error("timeout"));
          }, TIMEOUT_MS);
        });
        const res = await Promise.race([
          deps.fetch(buildUrl(req), {
            method: "GET",
            credentials: "omit",
            cache: "no-store",
            redirect: "error",
            referrerPolicy: "no-referrer",
            headers: { Accept: "application/json" },
            ...(controller ? { signal: controller.signal } : {}),
          }),
          timeout,
        ]);
        if (res.status === 429) {
          let body = null;
          try {
            const text = await readBody(res, timeout, MAX_ERROR_BODY_BYTES);
            body = text === null ? null : JSON.parse(text);
          } catch {
            /* the header decides */
          }
          return { data: null, ttl: 0, pauseMs: retryAfterMs(res.headers, body, deps.now()) };
        }
        if (res.status === 400 || res.status === 404) return { data: null, ttl: INVALID_TTL_MS, pauseMs: 0 };
        if (!res.ok || res.status !== 200) return { data: null, ttl: FAILURE_TTL_MS, pauseMs: FAILURE_PAUSE_MS };
        const type = res.headers.get("Content-Type") ?? "";
        if (type !== "" && !/json/i.test(type)) return { data: null, ttl: FAILURE_TTL_MS, pauseMs: 0 };
        const text = await readBody(res, timeout, MAX_BODY_BYTES);
        if (text === null) return { data: null, ttl: FAILURE_TTL_MS, pauseMs: 0 };
        const body = JSON.parse(text);
        const data = req.kind === "calendar" ? sanitizeCalendar(body, req) : sanitizeExplore(body, req);
        if (!data) return { data: null, ttl: FAILURE_TTL_MS, pauseMs: 0 };
        const empty = data.kind === "calendar" ? data.days.length === 0 : data.results.length === 0;
        return empty ? { data: null, ttl: EMPTY_TTL_MS, pauseMs: 0 } : { data, ttl: CACHE_TTL_MS, pauseMs: 0 };
      } catch {
        // network error, timeout (abort), unreadable JSON
        return { data: null, ttl: FAILURE_TTL_MS, pauseMs: FAILURE_PAUSE_MS };
      } finally {
        if (timer !== undefined) deps.clearTimeout(timer);
      }
    }

    /**
     * The popup's data for a request, or null (nothing to show, a failure, paused, over the limit). Never throws.
     * @param {unknown} input
     * @returns {Promise<CalendarData | ExploreData | null>}
     */
    async function lookup(input) {
      const req = validateRequest(input);
      if (!req) return null;
      const key = cacheKeyOf(req);
      try {
        const hit = await cached(key, deps.now());
        if (hit) return /** @type {any} */ (hit.data);
      } catch {
        /* a broken cache is a miss */
      }
      const pending = inflight.get(key);
      if (pending) return pending;
      const work = (async () => {
        if (!(await locked(() => takePermit(deps.now())))) return null;
        const out = await call(req);
        await locked(async () => {
          const nowMs = deps.now();
          if (out.pauseMs > 0) {
            const st = await readState();
            st.pausedUntil = Math.max(st.pausedUntil, nowMs + out.pauseMs);
            await writeState(st);
          }
          await remember(key, nowMs, out.ttl, out.data);
        });
        return out.data;
      })()
        .catch(() => null)
        .finally(() => inflight.delete(key));
      inflight.set(key, work);
      return work;
    }

    return { lookup };
  }

  EEE.api = Object.freeze({
    API_BASE,
    LIMIT_MAX,
    LIMIT_WINDOW_MS,
    CACHE_TTL_MS,
    EMPTY_TTL_MS,
    INVALID_TTL_MS,
    FAILURE_TTL_MS,
    FAILURE_PAUSE_MS,
    MIN_429_PAUSE_MS,
    MAX_PAUSE_MS,
    TIMEOUT_MS,
    EXPLORE_LIMIT,
    validateRequest,
    buildUrl,
    trustedBookingUrl,
    sanitizeCalendar,
    sanitizeExplore,
    retryAfterMs,
    memoryStorage,
    chromeStorage,
    createClient,
  });
})();
