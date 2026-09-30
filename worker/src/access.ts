/**
 * The private-use lock (owner request): one secret, ACCESS_KEY, closes the whole API to anyone who does not have it.
 *
 * index.ts runs checkAccess() at the very top of fetch(), before any rate limit, D1 read or cache lookup, so a refused
 * request costs one Worker invocation and nothing else. The gate is DEFAULT-DENY and not per route: every request needs
 * the key except the short public list in isPublicRequest(), so a route added later is locked without anyone having to
 * remember to lock it. Of that list only GET /api/health reads D1 (its two small liveness reads, older than the lock).
 * Scheduled (cron) runs are not HTTP requests and never pass through here.
 *
 * Configuration: the owner sets the secret himself (`npx wrangler secret put ACCESS_KEY`); nothing else is needed.
 *   unset or ""                                         lock OFF: the API answers everyone, exactly as before this module
 *   20-256 visible ASCII characters (no spaces)         lock ON
 *   anything else (too short, too long, other chars)    MISCONFIGURED: fail closed, every protected request answers 503
 *                                                      and serves nothing (a weak key must never quietly open the API)
 *
 * Transport: `Authorization: Bearer <key>` and nothing else. Never a query parameter (URLs end up in logs, history and
 * Referer headers) and never a cookie. The key is compared in constant time and is never logged or echoed.
 *
 * Guessing: failed attempts are counted per client (the same salted identity as the other rate limiters, ratelimit.ts,
 * from the CF-Connecting-IP header that Cloudflare's edge sets) in isolate memory only, so unauthenticated traffic never
 * costs a D1 read or write. Past ACCESS_FAILURE_MAX failures in
 * the window the client gets 429 for everything protected, the right key included: otherwise the difference between a
 * 429 and a 200 would still tell a guesser when the key is right. Best effort: each isolate counts on its own.
 */
import { clientIdentity, limiterSalt } from "./ratelimit";

export const ACCESS_KEY_MIN_LENGTH = 20;
/** Also the longest token a request may present (a longer configured key could never be sent). */
export const ACCESS_KEY_MAX_LENGTH = 256;
/** Failed attempts allowed per client per window before every protected request answers 429. */
export const ACCESS_FAILURE_MAX = 20;
export const ACCESS_FAILURE_WINDOW_SECONDS = 600;

/** Visible ASCII, no spaces: what a browser can always send in a header, and never ambiguous inside one. */
const KEY_CHARS = /^[\x21-\x7e]+$/;
/**
 * The whole header value: the scheme (any case), exactly ONE space, the token. A second space anywhere means extra
 * parts (or two Authorization headers, which the Headers API joins as "a, b"), and is refused.
 */
const BEARER = /^bearer ([\x21-\x7e]+)$/i;
/** HTTP's optional whitespace: space and horizontal tab only (RFC 9110). */
const isOws = (code: number): boolean => code === 0x20 || code === 0x09;

/**
 * `value` without the optional whitespace at its ends. Not String.trim(), which also drops vertical tabs, form feeds and
 * no-break spaces. And not a regex: /[ \t]+$/ backtracks over every run of spaces inside the value (quadratic: seconds of CPU
 * for a 64 KB header of spaces), and this runs on whatever a client sends, before any length check. One pass instead.
 */
function trimOws(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isOws(value.charCodeAt(start))) start += 1;
  while (end > start && isOws(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

export type LockStatus = "on" | "off" | "misconfigured";
export type MisconfiguredReason = "too_short" | "too_long" | "invalid_characters";
export type AccessConfig =
  | { status: "off" }
  | { status: "on"; key: string }
  | { status: "misconfigured"; reason: MisconfiguredReason };

export interface AccessEnv {
  ACCESS_KEY?: unknown;
  RATE_LIMIT_SALT?: string;
  TRAVELPAYOUTS_TOKEN?: string;
}

/** Reads the lock's state from the secret. Surrounding whitespace (a pasted newline) is not part of the key. */
export function accessConfig(env: { ACCESS_KEY?: unknown }): AccessConfig {
  const raw = env.ACCESS_KEY;
  if (raw === undefined || raw === null || raw === "") return { status: "off" };
  // Anything but a string (e.g. a number set as a plain variable) is a mistake: closed, never open.
  if (typeof raw !== "string") return { status: "misconfigured", reason: "invalid_characters" };
  const key = raw.trim();
  if (key.length < ACCESS_KEY_MIN_LENGTH) return { status: "misconfigured", reason: "too_short" };
  if (key.length > ACCESS_KEY_MAX_LENGTH) return { status: "misconfigured", reason: "too_long" };
  if (!KEY_CHARS.test(key)) return { status: "misconfigured", reason: "invalid_characters" };
  return { status: "on", key };
}

/** For GET /api/health: whether the lock is on. Nothing about the key itself, not even its length. */
export function lockInfo(env: { ACCESS_KEY?: unknown }): { locked: boolean; lockStatus: LockStatus } {
  const { status } = accessConfig(env);
  return { locked: status !== "off", lockStatus: status };
}

/**
 * The ONLY requests that pass without the key. Exact method and exact path: no prefix match, no trailing-slash or case
 * folding, no decoding, so no spelling of another route can pass as one of these.
 */
const PUBLIC_ROUTES: ReadonlyArray<readonly [method: string, path: string]> = [
  // Liveness for monitors and the smoke script. It says whether the lock is on, never anything about the key.
  ["GET", "/api/health"],
  // Telegram's servers cannot hold the key; the route checks its own secret header (TELEGRAM_WEBHOOK_SECRET).
  ["POST", "/api/telegram/webhook"],
];

export function isPublicRequest(method: string, pathname: string): boolean {
  // CORS preflight: browsers never send credentials on it, so it cannot carry the key. index.ts answers it before any
  // handler, with no body and no D1, and while the lock is on with one answer for every path (it must not say which exist).
  if (method === "OPTIONS") return true;
  return PUBLIC_ROUTES.some(([m, p]) => m === method && p === pathname);
}

/** The token of an `Authorization: Bearer <token>` header, or null for anything else (absent, empty, malformed, too long). */
export function bearerToken(header: string | null): string | null {
  if (header === null) return null;
  const value = trimOws(header); // the Headers API already strips these; kept so this function stands alone
  if (value.length > "bearer ".length + ACCESS_KEY_MAX_LENGTH) return null; // before the regex: no work on huge values
  const token = BEARER.exec(value)?.[1];
  return token !== undefined && token.length <= ACCESS_KEY_MAX_LENGTH ? token : null;
}

/**
 * Equality without an early exit: every byte of both inputs is read whatever the first difference is, so the time taken
 * does not say how much of a guess was right. Different lengths are unequal (and only the length is then observable,
 * which never happens for the fixed-size digests keyMatches passes).
 */
export function timingSafeEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Compares SHA-256 digests (always 32 bytes) in constant time, so neither the key's bytes nor its length leak through timing. */
export async function keyMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  return timingSafeEqual(a, b);
}

// --- failed attempts -------------------------------------------------------------------------------------

export interface FailureLimiter {
  /** Seconds until `key` may try again (0 = not blocked). Never counts anything itself. */
  blockedFor(key: string, nowMs: number): number;
  /** Counts one failed attempt of `key`. */
  fail(key: string, nowMs: number): void;
  /** Number of clients held (tests, diagnostics). */
  size(): number;
}

/**
 * Per-isolate fixed-window counter of failed attempts. Unlike ratelimit.ts's createMemoryLimiter, asking "is this client
 * blocked?" does not count: only failures do, so the owner's own requests never use up anything. Memory is bounded like
 * there: an address-rotating client cannot grow it.
 */
export function createFailureLimiter(max = ACCESS_FAILURE_MAX, windowSec = ACCESS_FAILURE_WINDOW_SECONDS, maxKeys = 5000): FailureLimiter {
  const windowMs = windowSec * 1000;
  const counters = new Map<string, { windowStart: number; count: number }>();
  const windowOf = (nowMs: number) => Math.floor(nowMs / windowMs) * windowMs;
  return {
    blockedFor(key, nowMs) {
      const entry = counters.get(key);
      const windowStart = windowOf(nowMs);
      if (!entry || entry.windowStart !== windowStart || entry.count < max) return 0;
      return Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000));
    },
    fail(key, nowMs) {
      const windowStart = windowOf(nowMs);
      let entry = counters.get(key);
      if (!entry || entry.windowStart !== windowStart) {
        if (!entry && counters.size >= maxKeys) {
          for (const [k, v] of counters) if (v.windowStart !== windowStart) counters.delete(k);
          if (counters.size >= maxKeys) counters.clear(); // still full of live keys: start over rather than grow
        }
        entry = { windowStart, count: 0 };
        counters.set(key, entry);
      }
      entry.count += 1;
    },
    size: () => counters.size,
  };
}

/** The limiter key: a salted hash of the client (an IPv6 client is its /64), as for every other limiter. */
async function clientKey(request: Request, env: AccessEnv): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const digest = await sha256(`${clientIdentity(ip)}|${limiterSalt(env)}`);
  return `access:${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// --- the gate --------------------------------------------------------------------------------------------

export interface AccessDenial {
  status: 401 | 429 | 503;
  code: "unauthorized" | "too_many_attempts" | "access_misconfigured";
  message: string;
  reason?: MisconfiguredReason;
  retryAfterSec?: number;
  headers: Record<string, string>;
}

/**
 * null = the request may go on to the router; otherwise the answer to send instead (index.ts adds the usual no-store,
 * nosniff and CORS headers, so the web can read it). Touches nothing but the request's method, URL and two headers.
 */
export async function checkAccess(request: Request, env: AccessEnv, failures: FailureLimiter, nowMs: number): Promise<AccessDenial | null> {
  const config = accessConfig(env);
  if (config.status === "off") return null;
  if (isPublicRequest(request.method, new URL(request.url).pathname)) return null;
  if (config.status === "misconfigured") {
    return { status: 503, code: "access_misconfigured", message: "The access lock is misconfigured", reason: config.reason, headers: {} };
  }

  // Blocked clients first, before the key is even looked at (see the header). Nothing is hashed while nobody has failed.
  let client: string | null = null;
  if (failures.size() > 0) {
    client = await clientKey(request, env);
    const wait = failures.blockedFor(client, nowMs);
    if (wait > 0) {
      return {
        status: 429,
        code: "too_many_attempts",
        message: "Too many failed access attempts, try again later",
        retryAfterSec: wait,
        headers: { "Retry-After": String(wait) },
      };
    }
  }

  const header = request.headers.get("Authorization");
  const token = bearerToken(header);
  if (token !== null && (await keyMatches(token, config.key))) return null;
  // Only a request that presented credentials is an attempt; one without any (the lock screen loading) is not counted.
  if (header !== null) failures.fail(client ?? (await clientKey(request, env)), nowMs);
  return { status: 401, code: "unauthorized", message: "Access key required", headers: { "WWW-Authenticate": "Bearer" } };
}
