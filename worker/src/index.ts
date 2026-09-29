/**
 * Worker entry point: the public REST API (SPEC §6).
 *   POST /api/search    the search pipeline (rate limited)
 *   GET  /api/airports  autocomplete over the Hebrew/English city dataset
 *   GET  /api/health    D1 liveness
 *
 * Every response is JSON, `Cache-Control: no-store`, `nosniff`. Errors are { error: { code, message, fields? } }
 * and never carry stack traces, upstream response bodies or secrets. CORS is opt-in for exactly one origin
 * (env.ALLOWED_ORIGIN) and is never a wildcard.
 */
import { createRepo, pruneHistory } from "./db";
import { getFxRates } from "./fx";
import { defaultResolver, PipelineError, runSearch, sha256Hex } from "./pipeline";
import { withDailyShare, type FareQuoteSource } from "./quotes";
import { clientIdentity, createMemoryLimiter, limiterSalt } from "./ratelimit";
import { createIgnavSource } from "./sources/ignav";
import { createSearchApiSource } from "./sources/searchapi";
import { createSerpApiSource } from "./sources/serpapi";
import { createWegoSource } from "./sources/wego";
import { createTravelpayoutsClient, marketForCountry } from "./travelpayouts";
import type { Env } from "./types";
import { GLOBAL_SCAN_LIMIT, GLOBAL_SCAN_WINDOW_SECONDS, MAX_BODY_BYTES, parseSearchBody, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS } from "./validate";

// The entry module must export only the handler: workerd refuses to load a Worker whose main module exports anything
// else (the limits live in validate.ts, the limiter helpers in ratelimit.ts for that reason).
const AIRPORTS_DEFAULT_LIMIT = 8;
const AIRPORTS_MAX_LIMIT = 10;

/**
 * Used only while the D1-backed limiter is failing (e.g. the free-tier write quota is spent, when every D1 write
 * throws): failing closed there would turn a storage problem into a full outage, cache hits included.
 */
const fallbackLimiter = createMemoryLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS);
let lastFallbackLog = 0;

interface ApiResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const errorResult = (
  status: number,
  code: string,
  message: string,
  extra: { fields?: Record<string, string>; retryAfterSec?: number; headers?: Record<string, string> } = {},
): ApiResult => ({
  status,
  body: { error: { code, message, ...(extra.fields ? { fields: extra.fields } : {}), ...(extra.retryAfterSec !== undefined ? { retryAfterSec: extra.retryAfterSec } : {}) } },
  headers: extra.headers,
});

/** The one configured origin, or null. A wildcard is refused: credentials-free or not, "*" is never emitted. */
function allowedOrigin(env: Env): string | null {
  const configured = env.ALLOWED_ORIGIN?.trim().replace(/\/+$/, "");
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

// --- handlers -------------------------------------------------------------------------------------------

/** Global cap on fresh scans (see GLOBAL_SCAN_LIMIT). Storage trouble never blocks: the per-client limit still applies. */
async function scanBudgetLeft(repo: ReturnType<typeof createRepo>, now: Date): Promise<boolean> {
  try {
    return (await repo.checkRateLimit("global:scan", GLOBAL_SCAN_LIMIT, GLOBAL_SCAN_WINDOW_SECONDS, now)).allowed;
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
    return errorResult(400, parsed.code, message, { fields: parsed.fields });
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
      },
      parsed.req,
    );
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof PipelineError) return errorResult(503, err.code, err.message);
    throw err;
  }
}

function handleAirports(url: URL): ApiResult {
  const q = url.searchParams.get("q") ?? "";
  const asked = Number(url.searchParams.get("limit") ?? AIRPORTS_DEFAULT_LIMIT);
  const limit = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, AIRPORTS_MAX_LIMIT) : AIRPORTS_DEFAULT_LIMIT;
  return { status: 200, body: { results: defaultResolver.resolveLocation(q, limit) } };
}

async function handleHealth(env: Env): Promise<ApiResult> {
  try {
    await env.DB.prepare("SELECT 1 AS ok").first();
    return { status: 200, body: { status: "ok", db: "ok" } };
  } catch {
    return { status: 503, body: { status: "degraded", db: "error" } };
  }
}

const ROUTES: Record<string, string> = { "/api/search": "POST", "/api/airports": "GET", "/api/health": "GET" };

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<ApiResult> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = ROUTES[path];
  if (method === undefined) return errorResult(404, "not_found", "Not found");

  if (request.method === "OPTIONS") {
    const allowed = allowedOrigin(env);
    if (!allowed || request.headers.get("Origin") !== allowed) return { status: 204 }; // no CORS grant for anyone else
    return {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": `${method}, OPTIONS`,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    };
  }
  if (request.method !== method) return errorResult(405, "method_not_allowed", "Method not allowed", { headers: { Allow: `${method}, OPTIONS` } });

  if (path === "/api/search") return handleSearch(request, env, ctx);
  if (path === "/api/airports") return handleAirports(url);
  return handleHealth(env);
}

export default {
  /** Daily retention job (see wrangler.toml `[triggers]`): the append-only tables must not grow without bound. */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
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
      return toResponse(await route(request, env, ctx), cors);
    } catch (err) {
      // Name only: messages can echo upstream text, and nothing here is worth a stack trace in a response.
      console.error("unhandled error:", err instanceof Error ? err.name : typeof err);
      return toResponse(errorResult(500, "internal_error", "Internal error"), cors);
    }
  },
} satisfies ExportedHandler<Env>;
