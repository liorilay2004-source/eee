/**
 * Worker entry point: the REST API (SPEC §6).
 *   POST /api/search    the search pipeline (rate limited)
 *   GET  /api/airports  autocomplete over the Hebrew/English city dataset, plus country suggestions (src/countries/search.ts)
 *   GET  /api/calendar  cheapest cached round trip per departure day (rate limited, src/calendar.ts)
 *   GET  /api/explore   cheapest destinations from TLV/ETM in a month or window (rate limited, src/explore.ts)
 *   GET  /api/sources   known airline/metasearch source registry, no external calls
 *   GET|POST /api/flight-links  user-pasted booking/search links remembered per client
 *   GET  /api/health    D1 liveness, deployed commit, newest applied migration, whether the private-use lock is on
 *   POST /api/watches, GET|DELETE /api/watches/<token>, POST /api/telegram/webhook   price alerts (src/watches.ts)
 *   GET  /api/deals     unusual fares per watched route, precomputed by the hourly snapshot cron (dealreports.ts)
 *   POST /api/party-check  "book together or one by one?" for one date pair, on demand (rate limited, src/partycheck.ts)
 *   GET  /api/auth/check  204 once the access gate let the request through: how the web tests a key (src/access.ts)
 *
 * The private-use lock (src/access.ts) runs first in fetch(), before any rate limit, D1 read or cache lookup: with the
 * ACCESS_KEY secret set, every request but GET /api/health, the Telegram webhook and CORS preflights needs
 * `Authorization: Bearer <key>`, and every preflight gets the same answer whatever its path (so none says which routes
 * exist). Without the secret the API is public, as before.
 *
 * Every response is JSON, `Cache-Control: no-store`, `nosniff`. Errors are
 * { error: { code, message, reason?, fields?, fieldCodes?, retryAfterSec? } } (all but code and message are additive)
 * and never carry stack traces, upstream response bodies or secrets. CORS is opt-in for exactly one origin
 * (env.ALLOWED_ORIGIN) and is never a wildcard.
 */
import { checkAccess, createFailureLimiter, lockInfo } from "./access";
import { stripTrailingSlashes } from "./paths";
import {
  CALENDAR_GLOBAL_LIMIT,
  CALENDAR_GLOBAL_WINDOW_SECONDS,
  CALENDAR_RATE_LIMIT_MAX,
  CALENDAR_RATE_LIMIT_WINDOW_SECONDS,
  CalendarError,
  parseCalendarQuery,
  runCalendar,
} from "./calendar";
import { COUNTRIES_ATTRIBUTION } from "./countries/countries";
import { DEFAULT_COUNTRY_LIMIT, searchCountries } from "./countries/search";
import { createRepo, pruneHistory } from "./db";
import { loadDeals, refreshDealReport } from "./dealreports";
import { EXPLORE_RATE_LIMIT_MAX, EXPLORE_RATE_LIMIT_WINDOW_SECONDS, ExploreError, parseExploreParams, runExplore } from "./explore";
import { getFxRates } from "./fx";
import { handleFlightLinks } from "./flight-links";
import { checkHealth } from "./health";
import { handlePartyCheck, signPartyToken } from "./partycheck";
import { defaultResolver, PipelineError, runSearch, sha256Hex, type ScanBudgetVerdict } from "./pipeline";
import { withDailyShare, type FareQuoteSource } from "./quotes";
import { clientIdentity, createMemoryLimiter, limiterSalt } from "./ratelimit";
import { createIgnavSource } from "./sources/ignav";
import { sourceRegistry } from "./source-registry";
import { createSearchApiSource } from "./sources/searchapi";
import { createSerpApiSource } from "./sources/serpapi";
import { createWegoSource } from "./sources/wego";
import { pickSnapshotRoute, runSnapshot } from "./snapshots";
import { secretMatches, telegramConfig } from "./telegram";
import { createTravelpayoutsClient, marketForCountry } from "./travelpayouts";
import type { Env } from "./types";
import { handleBotUpdate, handleCreateWatch, handleWatchByToken, runWatchChecks } from "./watches";
import { GLOBAL_SCAN_LIMIT, GLOBAL_SCAN_WINDOW_SECONDS, MAX_BODY_BYTES, parseSearchBody, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS } from "./validate";

// The entry module must export only the handler: workerd refuses to load a Worker whose main module exports anything
// else (the limits live in validate.ts, the limiter helpers in ratelimit.ts for that reason).
const AIRPORTS_DEFAULT_LIMIT = 8;
const AIRPORTS_MAX_LIMIT = 10;

/** Must equal the hourly entry of `crons` in wrangler.toml (a test pins that). */
const SNAPSHOT_CRON = "43 * * * *";
/** Must equal the price-alert entry of `crons` in wrangler.toml (a test pins that). Hourly, small batches: each watch about once a day. */
const WATCH_CRON = "29 * * * *";

/**
 * Used only while the D1-backed limiter is failing (e.g. the free-tier write quota is spent, when every D1 write
 * throws): failing closed there would turn a storage problem into a full outage, cache hits included.
 */
const fallbackLimiter = createMemoryLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS);
const calendarFallbackLimiter = createMemoryLimiter(CALENDAR_RATE_LIMIT_MAX, CALENDAR_RATE_LIMIT_WINDOW_SECONDS);
const exploreFallbackLimiter = createMemoryLimiter(EXPLORE_RATE_LIMIT_MAX, EXPLORE_RATE_LIMIT_WINDOW_SECONDS);
let lastFallbackLog = 0;
/** Failed access-key attempts per client (src/access.ts): isolate memory only, so a refused request never costs D1. */
const accessFailures = createFailureLimiter();

interface ApiResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const errorResult = (
  status: number,
  code: string,
  message: string,
  extra: {
    reason?: string;
    fields?: Record<string, string>;
    fieldCodes?: Record<string, string>;
    retryAfterSec?: number;
    headers?: Record<string, string>;
  } = {},
): ApiResult => ({
  status,
  body: {
    error: {
      code,
      message,
      ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
      ...(extra.fields ? { fields: extra.fields } : {}),
      ...(extra.fieldCodes ? { fieldCodes: extra.fieldCodes } : {}),
      ...(extra.retryAfterSec !== undefined ? { retryAfterSec: extra.retryAfterSec } : {}),
    },
  },
  headers: extra.headers,
});

/** The one configured origin, or null. A wildcard is refused: credentials-free or not, "*" is never emitted. */
function allowedOrigin(env: Env): string | null {
  const trimmed = env.ALLOWED_ORIGIN?.trim();
  const configured = trimmed === undefined ? undefined : stripTrailingSlashes(trimmed);
  return configured && configured !== "*" ? configured : null;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const allowed = allowedOrigin(env);
  if (!allowed) return {};
  const headers: Record<string, string> = { Vary: "Origin" }; // the answer depends on the Origin header
  if (request.headers.get("Origin") === allowed) {
    headers["Access-Control-Allow-Origin"] = allowed;
    // Without this a cross-origin fetch cannot read Retry-After on a 429.
    headers["Access-Control-Expose-Headers"] = "Retry-After";
  }
  return headers;
}

function toResponse(result: ApiResult, cors: Record<string, string>): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...cors,
    ...result.headers,
  });
  if (result.body === undefined) return new Response(null, { status: result.status, headers });
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(result.body), { status: result.status, headers });
}

// --- request body ---------------------------------------------------------------------------------------

/** Reads at most MAX_BODY_BYTES: Content-Length can be absent or wrong, so the stream itself is counted. */
async function readBody(request: Request): Promise<{ text: string } | { tooLarge: true } | { invalid: true }> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return { tooLarge: true };
  if (!request.body) return { text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes) };
  } catch {
    return { invalid: true };
  }
}

const isJsonContentType = (request: Request): boolean =>
  (request.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";

/** Content type, size cap, UTF-8 and JSON checks of a request body, with the same errors as /api/search. */
async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }> {
  if (!isJsonContentType(request)) return { ok: false, result: errorResult(415, "unsupported_media_type", "Content-Type must be application/json") };
  const raw = await readBody(request);
  if ("tooLarge" in raw) return { ok: false, result: errorResult(413, "payload_too_large", `Request body must be at most ${MAX_BODY_BYTES} bytes`) };
  if ("invalid" in raw) return { ok: false, result: errorResult(400, "invalid_json", "Request body is not valid UTF-8 JSON") };
  try {
    return { ok: true, value: JSON.parse(raw.text) };
  } catch {
    return { ok: false, result: errorResult(400, "invalid_json", "Request body is not valid JSON") };
  }
}

// --- handlers -------------------------------------------------------------------------------------------

/**
 * Global cap on fresh scans (see GLOBAL_SCAN_LIMIT), with the limiter's wait when it says no (surfaced as retryAfterSec on a
 * 503). Storage trouble never blocks: the per-client limit still applies.
 */
async function scanBudgetLeft(repo: ReturnType<typeof createRepo>, now: Date): Promise<ScanBudgetVerdict> {
  try {
    const verdict = await repo.checkRateLimit("global:scan", GLOBAL_SCAN_LIMIT, GLOBAL_SCAN_WINDOW_SECONDS, now);
    return { allowed: verdict.allowed, retryAfterSec: verdict.retryAfterSec };
  } catch {
    return true;
  }
}

/** A secret only counts when it is a non-blank string: anything else (unset, empty, a stray number var) leaves the source out. */
const secret = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/**
 * The optional live fare sources (quotes.ts), built once per search and only for the keys that are set: a source without a
 * key is not constructed, so it is never called, never counted and not listed in meta.sources. Only this request path uses
 * them: the scheduled job never does. The hard request caps live in the adapters and are counted in D1 (migration 0004);
 * the daily shares (rate_limits) come on top.
 */
function quoteSources(env: Env, repo: ReturnType<typeof createRepo>, fetchFn: typeof fetch, now: Date): FareQuoteSource[] {
  const marker = env.TRAVELPAYOUTS_MARKER;
  // Every vendor request also takes one unit of that vendor's daily share first (see withDailyShare): a client that dodges the
  // search cache cannot use up a whole allowance in minutes. Fails closed like the caps.
  const shared = { repo: withDailyShare(repo), now, fetchFn };
  const ignav = secret(env.IGNAV_API_KEY);
  const wego = secret(env.WEGO_API_TOKEN);
  const searchApi = secret(env.SEARCHAPI_KEY);
  const serpApi = secret(env.SERPAPI_KEY);
  return [
    ignav ? createIgnavSource({ ...shared, apiKey: ignav, marker }) : null,
    wego ? createWegoSource({ ...shared, apiKey: wego }) : null,
    searchApi ? createSearchApiSource({ ...shared, apiKey: searchApi, marker }) : null,
    serpApi ? createSerpApiSource({ ...shared, apiKey: serpApi, marker }) : null,
  ].filter((s): s is FareQuoteSource => s !== null && s.configured);
}

async function handleSearch(request: Request, env: Env, ctx: ExecutionContext): Promise<ApiResult> {
  const now = new Date();
  const repo = createRepo(env.DB);

  // Rate limit first, so it also covers malformed and oversized requests. Only a salted hash of the client is
  // stored, never the address itself; an IPv6 client is identified by its /64 (see clientIdentity).
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const key = `search:${await sha256Hex(`${clientIdentity(ip)}|${limiterSalt(env)}`)}`;
  let limit: { allowed: boolean; retryAfterSec: number };
  try {
    limit = await repo.checkRateLimit(key, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS, now);
  } catch {
    // Degrade to the per-isolate counter instead of answering 503 (the rest of the pipeline already treats storage
    // errors as "not cached"). Logged at most once a minute, and only that it happened.
    if (now.getTime() - lastFallbackLog > 60_000) {
      lastFallbackLog = now.getTime();
      console.error("rate limiter storage unavailable: using the in-memory fallback");
    }
    limit = fallbackLimiter.check(key, now.getTime());
  }
  if (!limit.allowed) {
    return errorResult(429, "rate_limited", "Too many searches, try again later", {
      retryAfterSec: limit.retryAfterSec,
      headers: { "Retry-After": String(limit.retryAfterSec) },
    });
  }

  if (!isJsonContentType(request)) return errorResult(415, "unsupported_media_type", "Content-Type must be application/json");
  const raw = await readBody(request);
  if ("tooLarge" in raw) return errorResult(413, "payload_too_large", `Request body must be at most ${MAX_BODY_BYTES} bytes`);
  if ("invalid" in raw) return errorResult(400, "invalid_json", "Request body is not valid UTF-8 JSON");
  let body: unknown;
  try {
    body = JSON.parse(raw.text);
  } catch {
    return errorResult(400, "invalid_json", "Request body is not valid JSON");
  }

  const parsed = parseSearchBody(body, { resolver: defaultResolver, now });
  if (!parsed.ok) {
    const message = parsed.code === "destination_required" ? "A destination is required" : "The search request is invalid";
    return errorResult(400, parsed.code, message, { fields: parsed.fields, fieldCodes: parsed.fieldCodes });
  }

  // Per-request wiring. The wrapper resolves globalThis.fetch at call time (workerd rejects a detached fetch).
  const fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init);
  const tp = createTravelpayoutsClient({
    token: env.TRAVELPAYOUTS_TOKEN,
    marker: env.TRAVELPAYOUTS_MARKER,
    fetchFn,
    marketFor: (origin) => marketForCountry(defaultResolver.countryOfAirport(origin)),
  });
  try {
    const result = await runSearch(
      {
        repo,
        tp,
        fx: () => getFxRates(repo, fetchFn, now),
        now,
        resolver: defaultResolver,
        waitUntil: (p) => ctx.waitUntil(p),
        scanBudget: () => scanBudgetLeft(repo, now),
        quoteSources: quoteSources(env, repo, fetchFn, now),
        // A cache row past its TTL (up to 24h) answers at once, marked meta.stale, and is rescanned in the background.
        staleWhileRevalidate: true,
        // Round-trip cards get the signed token POST /api/party-check needs (only when that check can run: see partycheck.ts).
        partyToken: (fields) => signPartyToken(limiterSalt(env), fields, now),
      },
      parsed.req,
    );
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof PipelineError) {
      // Retry-After (already exposed to the one CORS origin) only when the wait is actually known: never a guess.
      return errorResult(503, err.code, err.message, {
        reason: err.reason,
        retryAfterSec: err.retryAfterSec,
        headers: err.retryAfterSec !== undefined ? { "Retry-After": String(err.retryAfterSec) } : undefined,
      });
    }
    throw err;
  }
}

async function handleExplore(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<ApiResult> {
  const now = new Date();
  const repo = createRepo(env.DB);

  // Rate limit first (own key, same salted-hash identity as /api/search), so it also covers invalid requests.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const key = `explore:${await sha256Hex(`${clientIdentity(ip)}|${limiterSalt(env)}`)}`;
  let limit: { allowed: boolean; retryAfterSec: number };
  try {
    limit = await repo.checkRateLimit(key, EXPLORE_RATE_LIMIT_MAX, EXPLORE_RATE_LIMIT_WINDOW_SECONDS, now);
  } catch {
    limit = exploreFallbackLimiter.check(key, now.getTime());
  }
  if (!limit.allowed) {
    return errorResult(429, "rate_limited", "Too many searches, try again later", {
      retryAfterSec: limit.retryAfterSec,
      headers: { "Retry-After": String(limit.retryAfterSec) },
    });
  }

  const parsed = parseExploreParams(url.searchParams, now);
  if (!parsed.ok) return errorResult(400, parsed.code, parsed.message, { fields: parsed.fields });

  const fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init);
  try {
    const body = await runExplore(
      {
        db: env.DB,
        token: env.TRAVELPAYOUTS_TOKEN,
        marker: env.TRAVELPAYOUTS_MARKER,
        fetchFn,
        now,
        resolver: defaultResolver,
        // The SAME global budget as /api/search: one unit per request that needs any upstream call.
        scanBudget: async () => {
          const verdict = await scanBudgetLeft(repo, now);
          return typeof verdict === "boolean" ? verdict : verdict.allowed;
        },
        fx: () => getFxRates(repo, fetchFn, now),
        waitUntil: (p) => ctx.waitUntil(p),
      },
      parsed.params,
    );
    return { status: 200, body };
  } catch (err) {
    if (err instanceof ExploreError) return errorResult(503, err.code, err.message);
    throw err;
  }
}

/**
 * GET /api/calendar (src/calendar.ts). Per-client limit on its own counter; a fresh upstream fetch additionally takes one
 * unit of the calendar's global share and one of the global scan budget shared with /api/search. Unlike the search's budget
 * check, both fail CLOSED: a calendar is never worth an uncounted upstream call.
 */
async function handleCalendar(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<ApiResult> {
  const now = new Date();
  const repo = createRepo(env.DB);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const key = `calendar:${await sha256Hex(`${clientIdentity(ip)}|${limiterSalt(env)}`)}`;
  let limit: { allowed: boolean; retryAfterSec: number };
  try {
    limit = await repo.checkRateLimit(key, CALENDAR_RATE_LIMIT_MAX, CALENDAR_RATE_LIMIT_WINDOW_SECONDS, now);
  } catch {
    limit = calendarFallbackLimiter.check(key, now.getTime());
  }
  if (!limit.allowed) {
    return errorResult(429, "rate_limited", "Too many calendar requests, try again later", {
      retryAfterSec: limit.retryAfterSec,
      headers: { "Retry-After": String(limit.retryAfterSec) },
    });
  }

  const parsed = parseCalendarQuery(url.searchParams, { resolver: defaultResolver, now });
  if (!parsed.ok) {
    const message = parsed.code === "destination_required" ? "A destination is required" : "The calendar request is invalid";
    return errorResult(400, parsed.code, message, { fields: parsed.fields });
  }

  const fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init);
  const tp = createTravelpayoutsClient({
    token: env.TRAVELPAYOUTS_TOKEN,
    marker: env.TRAVELPAYOUTS_MARKER,
    fetchFn,
    marketFor: (origin) => marketForCountry(defaultResolver.countryOfAirport(origin)),
  });
  const reserveFetch = async (): Promise<boolean> => {
    try {
      // The calendar's own share first, so a refused calendar never spends a unit of the search budget.
      if (!(await repo.checkRateLimit("global:calendar", CALENDAR_GLOBAL_LIMIT, CALENDAR_GLOBAL_WINDOW_SECONDS, now)).allowed) return false;
      return (await repo.checkRateLimit("global:scan", GLOBAL_SCAN_LIMIT, GLOBAL_SCAN_WINDOW_SECONDS, now)).allowed;
    } catch {
      return false;
    }
  };
  try {
    const body = await runCalendar(
      { db: env.DB, tp, fx: () => getFxRates(repo, fetchFn, now), now, reserveFetch, waitUntil: (p) => ctx.waitUntil(p) },
      parsed.q,
    );
    return { status: 200, body };
  } catch (err) {
    if (err instanceof CalendarError) return errorResult(503, err.code, err.message);
    throw err;
  }
}

/**
 * POST /api/party-check (src/partycheck.ts): the live "together or one by one?" check of one card, only when the user asks for
 * it, and only with the token the search signed that card with. The live sources are wired exactly like the search's (same keys,
 * same caps, same daily shares); partycheck.ts picks the one that may be used, or answers 404 when none may. Its own per-client
 * limit (own key, same salted-hash identity) fails closed.
 */
async function handlePartyCheckRoute(request: Request, env: Env): Promise<ApiResult> {
  const now = new Date();
  const repo = createRepo(env.DB);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  // Its own limiter key; "party:<source>" (no hash) is the check's daily cap per source, in the same table.
  const clientKey = `party-client:${await sha256Hex(`${clientIdentity(ip)}|${limiterSalt(env)}`)}`;
  const fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init);
  return handlePartyCheck(
    // tokenSecret: the key the search signed its cards with (handleSearch's partyToken), so only a card of a recent search is checked.
    { repo, sources: quoteSources(env, repo, fetchFn, now), fx: () => getFxRates(repo, fetchFn, now), tokenSecret: limiterSalt(env), now, clientKey },
    () => readJson(request),
  );
}

function handleAirports(url: URL): ApiResult {
  const q = url.searchParams.get("q") ?? "";
  const asked = Number(url.searchParams.get("limit") ?? AIRPORTS_DEFAULT_LIMIT);
  const limit = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, AIRPORTS_MAX_LIMIT) : AIRPORTS_DEFAULT_LIMIT;
  const results = defaultResolver.resolveLocation(q, limit);
  // Additive: older web builds read only `results`. Country names are CLDR data, so the attribution rides along.
  const countries = searchCountries(q, DEFAULT_COUNTRY_LIMIT, new Set(results.flatMap((r) => r.airports)));
  return {
    status: 200,
    body: countries.length > 0 ? { results, countries, countriesAttribution: COUNTRIES_ATTRIBUTION } : { results, countries },
  };
}

/** Precomputed by the hourly cron (dealreports.ts): one small bounded D1 read, cached per isolate, no external calls. */
async function handleDeals(env: Env): Promise<ApiResult> {
  try {
    return { status: 200, body: await loadDeals(env.DB, new Date()) };
  } catch {
    return errorResult(503, "deals_unavailable", "Deals are temporarily unavailable");
  }
}

async function handleHealth(env: Env): Promise<ApiResult> {
  const { status, body } = await checkHealth(env.DB);
  // Additive: whether the private-use lock is on ("on" | "off" | "misconfigured"). Never anything about the key itself.
  return { status, body: { ...body, ...lockInfo(env) } };
}

/**
 * Telegram calls this with the secret it was registered with (setWebhook secret_token) in a header. Without the channel's
 * settings the path does not exist (404); a wrong or missing secret is 401. After that the answer is always 200, even for
 * an update that cannot be read: any other status makes Telegram deliver the same update again and again.
 */
async function handleTelegramWebhook(request: Request, env: Env): Promise<ApiResult> {
  const tg = telegramConfig(env);
  if (!tg) return errorResult(404, "not_found", "Not found");
  if (!(await secretMatches(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), tg.webhookSecret))) {
    return errorResult(401, "unauthorized", "Unauthorized");
  }
  const raw = await readBody(request);
  if (!("text" in raw)) return { status: 200 };
  let update: unknown;
  try {
    update = JSON.parse(raw.text);
  } catch {
    return { status: 200 };
  }
  const reply = await handleBotUpdate(update, { env, repo: createRepo(env.DB), now: new Date() });
  return reply ? { status: 200, body: reply } : { status: 200 };
}

const ROUTES: Record<string, string> = {
  "/api/auth/check": "GET",
  "/api/search": "POST",
  "/api/airports": "GET",
  "/api/deals": "GET",
  "/api/calendar": "GET",
  "/api/explore": "GET",
  "/api/sources": "GET",
  "/api/flight-links": "GET, POST",
  "/api/health": "GET",
  "/api/watches": "POST",
  "/api/telegram/webhook": "POST",
  "/api/party-check": "POST",
};
/** /api/watches/<token>: the token is checked by the handler (a malformed one is simply not found). */
const WATCH_PATH = /^\/api\/watches\/([^/]+)$/;
const WATCH_METHODS = "GET, DELETE";
/**
 * With the private-use lock on (or misconfigured), every preflight gets this one answer whatever its path: every method some
 * route accepts. Preflights need no key (browsers never send one on them), so a per-path answer (404 for an unknown path, a
 * known path's own methods) would let anyone list the routes without the key. The request that follows a preflight still
 * meets the gate, then the router's own 404 or 405. Built from ROUTES, so a route added later is covered.
 */
const LOCKED_PREFLIGHT_METHODS = [...new Set([...Object.values(ROUTES), WATCH_METHODS, "OPTIONS"].flatMap((m) => m.split(", ")))].join(", ");

/** A CORS preflight's answer: the grant goes only to the one configured origin; anyone else gets a bare 204. */
function preflight(request: Request, env: Env, methods: string): ApiResult {
  const allowed = allowedOrigin(env);
  if (!allowed || request.headers.get("Origin") !== allowed) return { status: 204 }; // no CORS grant for anyone else
  return {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": methods,
      // Authorization carries the access key (src/access.ts). Granted whether or not the lock is on, so a browser that
      // still holds a key keeps working after the owner turns the lock off.
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  };
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<ApiResult> {
  // Before the path is even looked up: a locked API's preflight answer must not depend on it (LOCKED_PREFLIGHT_METHODS).
  if (request.method === "OPTIONS" && lockInfo(env).locked) return preflight(request, env, LOCKED_PREFLIGHT_METHODS);
  const url = new URL(request.url);
  const path = stripTrailingSlashes(url.pathname) || "/";
  const watchToken = WATCH_PATH.exec(path)?.[1];
  const method = watchToken !== undefined ? WATCH_METHODS : ROUTES[path];
  if (method === undefined) return errorResult(404, "not_found", "Not found");

  if (request.method === "OPTIONS") return preflight(request, env, `${method}, OPTIONS`); // the lock off: exactly as before
  if (!method.split(", ").includes(request.method)) {
    return errorResult(405, "method_not_allowed", "Method not allowed", { headers: { Allow: `${method}, OPTIONS` } });
  }
  if (path === "/api/auth/check") return { status: 204 }; // fetch() already ran the access gate on this request

  if (watchToken !== undefined || path === "/api/watches") {
    const deps = { env, repo: createRepo(env.DB), now: new Date(), ip: request.headers.get("CF-Connecting-IP") ?? "unknown" };
    if (watchToken !== undefined) return handleWatchByToken(deps, request.method as "GET" | "DELETE", watchToken);
    return handleCreateWatch(deps, () => readJson(request));
  }
  if (path === "/api/telegram/webhook") return handleTelegramWebhook(request, env);
  if (path === "/api/search") return handleSearch(request, env, ctx);
  if (path === "/api/party-check") return handlePartyCheckRoute(request, env);
  if (path === "/api/airports") return handleAirports(url);
  if (path === "/api/deals") return handleDeals(env);
  if (path === "/api/sources") return { status: 200, body: { sources: sourceRegistry(), generatedAt: new Date().toISOString() } };
  if (path === "/api/flight-links") return handleFlightLinks({ env, now: new Date(), ip: request.headers.get("CF-Connecting-IP") ?? "unknown" }, request.method as "GET" | "POST", () => readJson(request));
  if (path === "/api/calendar") return handleCalendar(request, url, env, ctx);
  if (path === "/api/explore") return handleExplore(request, url, env, ctx);
  return handleHealth(env);
}

export default {
  /**
   * Three cron triggers (wrangler.toml `[triggers]`): the daily retention job (the append-only tables must not grow without
   * bound), the hourly price snapshot of one watchlist route (src/snapshots.ts), and the hourly price-alert batch
   * (src/watches.ts).
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === SNAPSHOT_CRON) {
      const now = new Date(controller.scheduledTime);
      const fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init);
      const repo = createRepo(env.DB);
      const tp = createTravelpayoutsClient({
        token: env.TRAVELPAYOUTS_TOKEN,
        marker: env.TRAVELPAYOUTS_MARKER,
        fetchFn,
        marketFor: (origin) => marketForCountry(defaultResolver.countryOfAirport(origin)),
      });
      const [origin, destination] = pickSnapshotRoute(now);
      // Then the route's deal report, as of AFTER the scan (a fresh Date, not the scheduled time: see detectDeals).
      // Only D1 reads and one upsert; it runs even when the scan was skipped or failed (user searches add history too).
      ctx.waitUntil(
        runSnapshot({ repo, tp, fx: () => getFxRates(repo, fetchFn, now), now, resolver: defaultResolver })
          .then(() => refreshDealReport(env.DB, origin, destination, new Date()))
          .then(() => undefined),
      );
      return;
    }
    if (controller.cron === WATCH_CRON) {
      const now = new Date(controller.scheduledTime);
      const fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init);
      const repo = createRepo(env.DB);
      const tp = createTravelpayoutsClient({
        token: env.TRAVELPAYOUTS_TOKEN,
        marker: env.TRAVELPAYOUTS_MARKER,
        fetchFn,
        marketFor: (origin) => marketForCountry(defaultResolver.countryOfAirport(origin)),
      });
      ctx.waitUntil(
        runWatchChecks({
          db: env.DB,
          repo,
          tp,
          now,
          fetchFn,
          fx: () => getFxRates(repo, fetchFn, now),
          telegram: telegramConfig(env),
          scanBudget: async () => {
            const verdict = await scanBudgetLeft(repo, now);
            return typeof verdict === "boolean" ? verdict : verdict.allowed;
          },
          resolver: defaultResolver,
        }).then(() => undefined),
      );
      return;
    }
    ctx.waitUntil(
      pruneHistory(env.DB, new Date(controller.scheduledTime)).then(
        () => undefined,
        (err: unknown) => console.error("retention job failed:", err instanceof Error ? err.name : typeof err),
      ),
    );
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let cors: Record<string, string> = {};
    try {
      cors = corsHeaders(request, env);
      // The private-use lock comes before everything else: no rate-limit row, D1 read or cache lookup for a refused request.
      // Its answers carry the CORS headers too, so the web can read them.
      const denied = await checkAccess(request, env, accessFailures, Date.now());
      if (denied) {
        return toResponse(
          errorResult(denied.status, denied.code, denied.message, { reason: denied.reason, retryAfterSec: denied.retryAfterSec, headers: denied.headers }),
          cors,
        );
      }
      return toResponse(await route(request, env, ctx), cors);
    } catch (err) {
      // Name only: messages can echo upstream text, and nothing here is worth a stack trace in a response.
      console.error("unhandled error:", err instanceof Error ? err.name : typeof err);
      return toResponse(errorResult(500, "internal_error", "Internal error"), cors);
    }
  },
} satisfies ExportedHandler<Env>;
