/**
 * The private-use lock (src/access.ts, wired first in index.ts's fetch): real Request objects into worker.fetch, a D1 that
 * records every touch, and the Date frozen. The route list is read from index.ts's ROUTES table itself, so a route added
 * later (by any branch) is covered here without editing this file.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as entry from "../src/index";
import {
  ACCESS_FAILURE_MAX,
  ACCESS_FAILURE_WINDOW_SECONDS,
  ACCESS_KEY_MAX_LENGTH,
  ACCESS_KEY_MIN_LENGTH,
  accessConfig,
  bearerToken,
  createFailureLimiter,
  isPublicRequest,
  keyMatches,
  lockInfo,
  timingSafeEqual,
} from "../src/access";
import type { Env } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const worker = entry.default;
const here = dirname(fileURLToPath(import.meta.url));
const workerDir = join(here, "..");

// Window-aligned plus 2 minutes, so the failure window's remaining time is known exactly (8 minutes).
const NOW = new Date(Math.floor(Date.parse("2026-10-01T09:00:00.000Z") / 600_000) * 600_000 + 120_000);
const BASE = "https://api.example.test";
const ORIGIN = "https://app.example.test";
/** 32 characters, like the generator in the docs (24 random bytes, base64url). */
const KEY = "Zq9vN3tXk2pL8sR4wY7eB1cD5fG0hJ6m";
const WATCH_TOKEN = "A".repeat(43);
const GATE_CODES = ["unauthorized", "too_many_attempts", "access_misconfigured"];
/** GET /api/health's whole answer with the lock on (test build, empty test D1): all a request without the key can read. */
const PUBLIC_HEALTH = { status: "ok", db: "ok", build: { sha: "unknown", time: null }, migration: null, migrationsPending: null, locked: true, lockStatus: "on" };

// --- harness ---------------------------------------------------------------------------------------------

/** A working test D1 that records the name of every property read on it: an empty list means D1 was never touched. */
function spyDb(): { db: D1Database; touched: string[] } {
  const real = createTestD1();
  const touched: string[] = [];
  const db = new Proxy(real, {
    get(target, prop) {
      if (typeof prop === "string") touched.push(prop);
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db, touched };
}

function makeEnv(over: Partial<Env> = {}): Env & { touched: string[] } {
  const { db, touched } = spyDb();
  return { DB: db, TRAVELPAYOUTS_TOKEN: "tp-token-0123456789", TRAVELPAYOUTS_MARKER: "12345", ACCESS_KEY: KEY, ...over, touched };
}

/** A fresh client address per call where the test is not about one client: failures are counted per client. */
let ipCounter = 0;
const nextIp = () => {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
};

async function call(env: Env, path: string, init: RequestInit = {}, request?: Request): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  const headers = new Headers(init.headers);
  if (!headers.has("CF-Connecting-IP")) headers.set("CF-Connecting-IP", nextIp());
  const res = await worker.fetch(request ?? new Request(`${BASE}${path}`, { ...init, headers }), env, ctx);
  await Promise.all(pending);
  return res;
}

const bearer = (key = KEY) => ({ Authorization: `Bearer ${key}` });
const errorCode = async (res: Response): Promise<string | undefined> =>
  ((await res.clone().json().catch(() => ({}))) as { error?: { code?: string } }).error?.code;

/** The ROUTES table of src/index.ts, read from the source (the entry module may export nothing but its handler). */
function routeTable(): [path: string, methods: string[]][] {
  const source = readFileSync(join(workerDir, "src", "index.ts"), "utf8");
  const block = /const ROUTES: Record<string, string> = \{([\s\S]*?)\n\};/.exec(source)?.[1];
  if (!block) throw new Error("ROUTES table not found in src/index.ts: update routeTable() in this test");
  return [...block.matchAll(/"(\/api\/[^"]+)":\s*"([A-Z, ]+)"/g)].map((m) => [m[1] as string, (m[2] as string).split(", ")]);
}

/** Every path the router serves: the static table plus the one dynamic route (/api/watches/<token>). */
function allRoutes(): [path: string, methods: string[]][] {
  return [...routeTable(), [`/api/watches/${WATCH_TOKEN}`, ["GET", "DELETE"]]];
}

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

function requestInit(method: string, headers: Record<string, string> = {}): RequestInit {
  const withBody = method === "POST" || method === "PUT" || method === "PATCH";
  return { method, headers: { ...(withBody ? { "content-type": "application/json" } : {}), ...headers }, body: withBody ? "{}" : undefined };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Hermetic: no handler reached here may call out (none should: the requests are refused or invalid before any upstream call).
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in tests"); }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- pure parts ------------------------------------------------------------------------------------------

describe("accessConfig: the secret's three states", () => {
  it("unset or empty is OFF (the API stays public, so deploying this changes nothing until the owner sets the secret)", () => {
    expect(accessConfig({})).toEqual({ status: "off" });
    expect(accessConfig({ ACCESS_KEY: undefined })).toEqual({ status: "off" });
    expect(accessConfig({ ACCESS_KEY: "" })).toEqual({ status: "off" });
  });

  it("20 to 256 visible ASCII characters is ON; surrounding whitespace (a pasted newline) is not part of the key", () => {
    expect(ACCESS_KEY_MIN_LENGTH).toBe(20);
    expect(ACCESS_KEY_MAX_LENGTH).toBe(256);
    expect(accessConfig({ ACCESS_KEY: KEY })).toEqual({ status: "on", key: KEY });
    expect(accessConfig({ ACCESS_KEY: "x".repeat(20) })).toEqual({ status: "on", key: "x".repeat(20) });
    expect(accessConfig({ ACCESS_KEY: "~".repeat(256) })).toEqual({ status: "on", key: "~".repeat(256) });
    expect(accessConfig({ ACCESS_KEY: `  ${KEY}\n` })).toEqual({ status: "on", key: KEY });
    expect(accessConfig({ ACCESS_KEY: "!#$%&'()*+,-./:;<=>?@[]^_`{|}" })).toMatchObject({ status: "on" });
  });

  it("anything else is MISCONFIGURED and fails closed, never open", () => {
    expect(accessConfig({ ACCESS_KEY: "short" })).toEqual({ status: "misconfigured", reason: "too_short" });
    expect(accessConfig({ ACCESS_KEY: "x".repeat(19) })).toEqual({ status: "misconfigured", reason: "too_short" });
    expect(accessConfig({ ACCESS_KEY: "   " })).toEqual({ status: "misconfigured", reason: "too_short" });
    expect(accessConfig({ ACCESS_KEY: ` ${"x".repeat(19)} ` })).toEqual({ status: "misconfigured", reason: "too_short" });
    expect(accessConfig({ ACCESS_KEY: "x".repeat(257) })).toEqual({ status: "misconfigured", reason: "too_long" });
    expect(accessConfig({ ACCESS_KEY: "correct horse battery staple" })).toEqual({ status: "misconfigured", reason: "invalid_characters" });
    expect(accessConfig({ ACCESS_KEY: `${"x".repeat(20)}ש` })).toEqual({ status: "misconfigured", reason: "invalid_characters" });
    expect(accessConfig({ ACCESS_KEY: `${"x".repeat(20)}é` })).toEqual({ status: "misconfigured", reason: "invalid_characters" });
    expect(accessConfig({ ACCESS_KEY: 12345 })).toEqual({ status: "misconfigured", reason: "invalid_characters" });
    expect(accessConfig({ ACCESS_KEY: true })).toEqual({ status: "misconfigured", reason: "invalid_characters" });
  });

  it("lockInfo reports the state and nothing about the key", () => {
    expect(lockInfo({})).toEqual({ locked: false, lockStatus: "off" });
    expect(lockInfo({ ACCESS_KEY: KEY })).toEqual({ locked: true, lockStatus: "on" });
    expect(lockInfo({ ACCESS_KEY: "short" })).toEqual({ locked: true, lockStatus: "misconfigured" });
  });
});

describe("bearerToken: strict parsing of the Authorization header", () => {
  it("accepts exactly `Bearer <token>`, the scheme in any case, the ends trimmed", () => {
    expect(bearerToken(`Bearer ${KEY}`)).toBe(KEY);
    expect(bearerToken(`bearer ${KEY}`)).toBe(KEY);
    expect(bearerToken(`BEARER ${KEY}`)).toBe(KEY);
    expect(bearerToken(`bEaReR ${KEY}`)).toBe(KEY);
    expect(bearerToken(`  Bearer ${KEY} \t`)).toBe(KEY);
    expect(bearerToken(`Bearer ${"a".repeat(256)}`)).toBe("a".repeat(256));
  });

  it("refuses everything else", () => {
    for (const bad of [
      null, "", " ", "Bearer", "Bearer ", "Bearer  ", KEY, `Bearer  ${KEY}`, `Bearer ${KEY} extra`, `Bearer\t${KEY}`, `Bearer:${KEY}`,
      `Bearer${KEY}`, `Basic ${KEY}`, `Token ${KEY}`, `Bearer ${KEY}, Bearer ${KEY}`, `Bearer ${KEY} Bearer ${KEY}`,
      `Bearer ${"a".repeat(257)}`, `Bearer ${"a".repeat(100_000)}`, `Bearer ${KEY}é`, `Bearer ${KEY}\u0000`, `Bearer מ${KEY}`,
      // only space and tab are HTTP whitespace: String.trim() would have let these through
      `Bearer ${KEY}\u000b`, `\u000cBearer ${KEY}`, `Bearer ${KEY}\u00a0`, `\u00a0Bearer ${KEY}`, `Bearer ${KEY}\u2028`, `\ufeffBearer ${KEY}`,
    ]) {
      expect(bearerToken(bad), String(bad).slice(0, 40)).toBeNull();
    }
  });

  // Skeptic finding: the ends used to be stripped with /^[ \t]+|[ \t]+$/g, which backtracks over every run of whitespace
  // INSIDE the value: about 3 seconds of CPU for these, on any request, before the length check.
  it("takes linear time: a huge value with long runs of spaces or tabs inside is refused at once", () => {
    for (const value of [
      `Bearer ${" ".repeat(64_000)}x`, `Bearer${"\t".repeat(64_000)}${KEY}`, `Bearer ${" \t".repeat(32_000)}${KEY}`, `x${" ".repeat(64_000)}Bearer ${KEY}`,
    ]) {
      const started = performance.now();
      expect(bearerToken(value)).toBeNull();
      expect(performance.now() - started, JSON.stringify(value.slice(0, 8))).toBeLessThan(500); // about 1 ms now; the regex took seconds
    }
    // the ends are still trimmed, space and tab only
    expect(bearerToken(` \t Bearer ${KEY}\t \t`)).toBe(KEY);
    expect(bearerToken(" \t \t ")).toBeNull();
  });
});

describe("isPublicRequest: the whole allowlist", () => {
  it("is exactly GET /api/health, POST /api/telegram/webhook and preflights", () => {
    expect(isPublicRequest("GET", "/api/health")).toBe(true);
    expect(isPublicRequest("POST", "/api/telegram/webhook")).toBe(true);
    expect(isPublicRequest("OPTIONS", "/api/deals")).toBe(true);
    expect(isPublicRequest("OPTIONS", "/anything")).toBe(true);
  });

  it("no other method, spelling or neighbour of those paths", () => {
    for (const [method, path] of [
      ["HEAD", "/api/health"], ["POST", "/api/health"], ["GET", "/api/health/"], ["GET", "/API/health"], ["GET", "//api/health"],
      ["GET", "/api/health/x"], ["GET", "/api/healthz"], ["GET", "/api/%68ealth"], ["get", "/api/health"],
      ["GET", "/api/telegram/webhook"], ["POST", "/api/telegram/webhook/"], ["POST", "/api/telegram"], ["POST", "/api/telegram/webhooks"],
      ["GET", "/api/auth/check"], ["GET", "/api/deals"], ["POST", "/api/search"], ["GET", "/"],
    ] as const) {
      expect(isPublicRequest(method, path), `${method} ${path}`).toBe(false);
    }
  });
});

describe("constant-time comparison", () => {
  it("timingSafeEqual: equal only for the same bytes and the same length", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([0, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2, 0]), new Uint8Array([1, 2]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([128]), new Uint8Array([0]))).toBe(false);
  });

  it("never returns early: every byte of both inputs is read, wherever the first difference is", () => {
    const reads = (values: number[], log: number[]) =>
      new Proxy(values, {
        get(target, prop) {
          if (typeof prop === "string" && /^\d+$/.test(prop)) log.push(Number(prop));
          return Reflect.get(target, prop);
        },
      });
    const base = Array.from({ length: 32 }, (_, i) => i);
    for (const differAt of [0, 1, 15, 31, -1]) {
      const other = [...base];
      if (differAt >= 0) other[differAt] = 255;
      const la: number[] = [];
      const lb: number[] = [];
      expect(timingSafeEqual(reads(base, la), reads(other, lb))).toBe(differAt < 0);
      expect(la, `difference at ${differAt}`).toEqual(base); // indices 0..31, in order, each once
      expect(lb, `difference at ${differAt}`).toEqual(base);
    }
  });

  it("keyMatches compares SHA-256 digests: only the exact key matches", async () => {
    expect(await keyMatches(KEY, KEY)).toBe(true);
    for (const wrong of ["", KEY.slice(0, -1), `${KEY}x`, KEY.toLowerCase(), KEY.toUpperCase(), `x${KEY.slice(1)}`, `${KEY.slice(0, -1)}x`, ` ${KEY}`]) {
      expect(await keyMatches(wrong, KEY), wrong).toBe(false);
    }
  });
});

describe("createFailureLimiter", () => {
  it("blocks a client after `max` failures in the window, for the rest of that window only", () => {
    const limiter = createFailureLimiter(3, 600);
    const t0 = 1_800_000_000_000 - (1_800_000_000_000 % 600_000); // a window start
    for (let i = 0; i < 3; i++) {
      expect(limiter.blockedFor("a", t0 + i)).toBe(0);
      limiter.fail("a", t0 + i);
    }
    expect(limiter.blockedFor("a", t0 + 1_000)).toBe(599);
    expect(limiter.blockedFor("a", t0 + 599_500)).toBe(1);
    expect(limiter.blockedFor("b", t0 + 1_000)).toBe(0); // per client
    expect(limiter.blockedFor("a", t0 + 600_000)).toBe(0); // next window: free again
  });

  it("asking does not count; only failures do", () => {
    const limiter = createFailureLimiter(2, 600);
    for (let i = 0; i < 100; i++) expect(limiter.blockedFor("a", 0)).toBe(0);
    limiter.fail("a", 0);
    expect(limiter.blockedFor("a", 0)).toBe(0);
    limiter.fail("a", 0);
    expect(limiter.blockedFor("a", 0)).toBeGreaterThan(0);
  });

  it("keeps its memory bounded", () => {
    const limiter = createFailureLimiter(5, 600, 3);
    for (let i = 0; i < 50; i++) limiter.fail(`client-${i}`, 0);
    expect(limiter.size()).toBeLessThanOrEqual(3);
  });

  it("is 20 failures per 10 minutes in the Worker", () => {
    expect(ACCESS_FAILURE_MAX).toBe(20);
    expect(ACCESS_FAILURE_WINDOW_SECONDS).toBe(600);
  });
});

// --- the gate in the Worker ------------------------------------------------------------------------------

describe("locked: every route in index.ts's ROUTES table, every method, needs the key", () => {
  it("the table is read from the source and holds every known route", () => {
    const paths = routeTable().map(([p]) => p);
    for (const known of ["/api/auth/check", "/api/search", "/api/airports", "/api/deals", "/api/calendar", "/api/explore", "/api/health", "/api/watches", "/api/telegram/webhook"]) {
      expect(paths).toContain(known);
    }
  });

  it("without a key: 401 unauthorized + WWW-Authenticate: Bearer, no-store, and D1 never touched", async () => {
    const env = makeEnv();
    let checked = 0;
    for (const [path, methods] of allRoutes()) {
      for (const method of new Set([...methods, ...METHODS])) {
        if (isPublicRequest(method, path)) continue;
        const res = await call(env, path, requestInit(method));
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(res.headers.get("WWW-Authenticate"), `${method} ${path}`).toBe("Bearer");
        expect(res.headers.get("Cache-Control")).toBe("no-store");
        expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
        if (method !== "HEAD") expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Access key required" } });
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10 * METHODS.length - 2);
    expect(env.touched).toEqual([]);
  });

  // The review's route x method x key matrix (break-the-lock), kept.
  it("...and with a wrong key or a near miss, the same 401: nothing echoed or logged, no D1, no upstream call", async () => {
    const env = makeEnv();
    const logs = [vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {}), vi.mocked(console.error)];
    const nearMisses = [
      "wrong-key-0123456789-wrong", `${KEY.slice(0, -1)}x`, `x${KEY.slice(1)}`, KEY.slice(0, -1), `${KEY}x`, KEY.toLowerCase(), KEY.toUpperCase(),
      [...KEY].reverse().join(""), KEY.slice(0, ACCESS_KEY_MIN_LENGTH), `${KEY}${KEY}`,
    ];
    let checked = 0;
    for (const [path, methods] of allRoutes()) {
      for (const method of new Set([...methods, ...METHODS])) {
        if (isPublicRequest(method, path)) continue;
        for (const key of nearMisses) {
          const res = await call(env, path, requestInit(method, bearer(key)));
          expect(res.status, `${method} ${path} ${key}`).toBe(401);
          expect(await res.text()).not.toContain(KEY);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual((10 * METHODS.length - 2) * nearMisses.length);
    expect(env.touched).toEqual([]);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(JSON.stringify(logs.flatMap((spy) => spy.mock.calls))).not.toContain(KEY.slice(0, 12));
  });

  it("without the key a known path and an unknown one get the same answer, whatever the method: no request says which routes exist", async () => {
    const env = makeEnv({ ALLOWED_ORIGIN: ORIGIN });
    for (const method of METHODS) {
      const answers = new Set<string>();
      for (const path of ["/api/deals", "/api/search", "/api/auth/check", `/api/watches/${WATCH_TOKEN}`, "/api/nope", "/api/deals-nope", "/", "/nope"]) {
        const res = await call(env, path, requestInit(method, { Origin: ORIGIN }));
        answers.add(JSON.stringify({ status: res.status, body: await res.text(), headers: [...res.headers].sort() }));
      }
      expect([...answers], method).toHaveLength(1);
    }
    expect(env.touched).toEqual([]);
  });

  // The review's 42 path probes (break-the-lock), kept: gate and router read the same parsed pathname, and the gate's two
  // public entries are exact matches, so no spelling of a path can pass the gate as one route and reach another.
  it("paths the router does not know, and spellings of known ones, are denied too (default deny, not a route list)", async () => {
    const env = makeEnv();
    const tricks: [method: string, path: string][] = [
      ["GET", "/api/deals/"], ["GET", "//api/deals"], ["GET", "/API/deals"], ["GET", "/api/%64eals"], ["GET", "/api/deals?x"],
      ["HEAD", "/api/deals"], ["GET", "/api/deals#frag"], ["GET", "/api/health/"], ["GET", "/API/HEALTH"], ["GET", "//api/health"],
      ["GET", "/api/%68ealth"], ["GET", "/api/health/../deals"], ["GET", "/api/health%2F..%2Fdeals"], ["GET", "/api//health"],
      ["GET", "/api/health;x"], ["HEAD", "/api/health"], ["POST", "/api/health"], ["GET", "/api/telegram/webhook"],
      ["POST", "/api/telegram/webhook/"], ["POST", "/api/telegram/webhook/x"], ["POST", "/API/telegram/webhook"], ["GET", "/api/auth/check/"],
      ["GET", "/"], ["GET", "/api"], ["GET", "/api/"], ["GET", "/nope"], ["GET", "/api/party-check"], ["POST", "/api/party-check"],
      ["GET", "/api/watches/"], ["GET", "/api/watches/x/y"], ["GET", "/favicon.ico"],
    ];
    const moreSpellings = [
      "///api/deals", "/Api/Deals", "/%61pi/deals", "/api/deals%2f", "/api/deals%2F", "/api/./deals", "/api/x/../deals", "/api/health/%2e%2e/deals",
      "/api/health/%2E%2E/deals", "/api/%2e%2e/api/deals", "/api/deals/.", "/api/deals/..", "/api/deals;x", "/api/health%00", "/api/health%20",
      "/api/health%09", "/api/ſearch", "/api/heałth", "/api/de\tals", "/api/de\nals", "/api\\deals", "\\api\\deals", "/api/health\\..\\deals",
      "/api/health/.", "/api/health/x", "/api/healthz", "/api/auth/./check", "/api/auth/check/..", "/api/telegram/webhook/../../deals",
      `/api/watches/${WATCH_TOKEN}/`, `/api/watches/../watches/${WATCH_TOKEN}`, `/api/deals?${"a".repeat(100_000)}`,
    ];
    for (const path of moreSpellings) for (const method of ["GET", "HEAD", "POST", "DELETE"]) tricks.push([method, path]);
    for (const [method, path] of tricks) {
      const res = await call(env, path, requestInit(method));
      expect(res.status, `${method} ${JSON.stringify(path.slice(0, 60))}`).toBe(401);
    }
    expect(env.touched).toEqual([]);
  });

  it("the spellings that the URL parser turns into a public path reach only that path's public answer", async () => {
    const env = makeEnv();
    for (const path of ["/api/deals/../health", "/api/deals/%2e%2e/health", "/api/./health", "/./api/health", "/api\\health", "/api/hea\tlth", "/api/hea\nlth"]) {
      const res = await call(env, path);
      expect(res.status, JSON.stringify(path)).toBe(200);
      expect(await res.json()).toEqual(PUBLIC_HEALTH);
    }
    // The webhook keeps its own secret check: not configured here, so the route does not exist (404), and no handler runs.
    const webhook = makeEnv();
    for (const path of ["/api/deals/../telegram/webhook", "/api/./telegram/webhook"]) expect((await call(webhook, path, requestInit("POST"))).status).toBe(404);
    expect(webhook.touched).toEqual([]);
  });

  it("the key never works from the query string, the path, a cookie, the body or another header", async () => {
    const env = makeEnv();
    for (const path of [
      `/api/auth/check?key=${KEY}`, `/api/auth/check?access_key=${KEY}`, `/api/auth/check?ACCESS_KEY=${KEY}`, `/api/auth/check?token=${KEY}`,
      `/api/auth/check?authorization=${encodeURIComponent(`Bearer ${KEY}`)}`, `/api/auth/check?Authorization=Bearer%20${KEY}`,
      `/api/deals?accessKey=${KEY}`, `/api/deals?bearer=${KEY}`, `/api/deals;key=${KEY}`, `/api/deals/${KEY}`, `/api/${KEY}/deals`, `/api/deals#${KEY}`,
    ]) {
      expect((await call(env, path)).status, path).toBe(401);
    }
    const elsewhere: Record<string, string>[] = [
      { Cookie: `key=${KEY}` }, { Cookie: `eee.accessKey=${KEY}` }, { Cookie: `Authorization=Bearer ${KEY}` }, { "X-Access-Key": KEY }, { "X-Api-Key": KEY },
      { "Proxy-Authorization": `Bearer ${KEY}` }, { "X-Forwarded-Authorization": `Bearer ${KEY}` }, { "X-Authorization": `Bearer ${KEY}` },
      { "X-Original-Authorization": `Bearer ${KEY}` }, { Authentication: `Bearer ${KEY}` }, { "X-Auth-Token": KEY },
    ];
    for (const headers of elsewhere) {
      expect((await call(env, "/api/auth/check", { headers })).status, Object.keys(headers)[0]).toBe(401);
    }
    const inBody = await call(env, "/api/search", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: KEY, accessKey: KEY, authorization: `Bearer ${KEY}` }),
    });
    expect(inBody.status).toBe(401);
    expect(env.touched).toEqual([]);
  });

  it("malformed Authorization headers are refused, even when they contain the right key", async () => {
    const env = makeEnv();
    for (const value of [
      "", "Bearer", "Bearer ", `Bearer  ${KEY}`, `Bearer ${KEY} extra`, `Bearer\t${KEY}`, KEY, `Basic ${btoa(`owner:${KEY}`)}`, `Token ${KEY}`,
      `Bearer ${KEY}x`, `Bearer ${"a".repeat(257)}`, `Bearer ${KEY.toLowerCase()}`,
      // the review's further variants: near-miss schemes, separators and quoting, bytes a browser could never send, a 200 KB value
      `BearerX ${KEY}`, `XBearer ${KEY}`, `Bearer: ${KEY}`, `Bearer=${KEY}`, `Bearer "${KEY}"`, `Bearer ${KEY};`, `Bearer ${KEY},`, `Bearer ,${KEY}`,
      `Bearer realm="eee" ${KEY}`, `Bearer Bearer ${KEY}`, `${KEY} Bearer`, `Bearer\u00a0${KEY}`, `Bearer ${KEY}\u000b`, `Bearer ${KEY}\u007f`,
      `Bearer ${KEY}é`, `Bearer ×\u0090${KEY}`, `Digest ${KEY}`, `Negotiate ${KEY}`, `Bearer ${KEY}${" ".repeat(10)}x`, `Bearer ${"a".repeat(200_000)}`,
    ]) {
      const res = await call(env, "/api/auth/check", { headers: { Authorization: value } });
      expect(res.status, JSON.stringify(value.slice(0, 40))).toBe(401);
      expect(await res.text()).not.toContain(KEY);
    }
    // Two Authorization headers (both right) reach the Worker joined as "Bearer K, Bearer K": refused.
    const two = new Headers({ "CF-Connecting-IP": nextIp() });
    two.append("Authorization", `Bearer ${KEY}`);
    two.append("Authorization", `Bearer ${KEY}`);
    expect(two.get("Authorization")).toBe(`Bearer ${KEY}, Bearer ${KEY}`);
    expect((await call(env, "", {}, new Request(`${BASE}/api/auth/check`, { headers: two }))).status).toBe(401);
    expect(env.touched).toEqual([]);
  });

  // Skeptic finding (see bearerToken's linear-time test): a refused request must stay cheap however its header is built.
  it("a 64 KB Authorization header of spaces is refused as quickly as any other, and counts as one failed attempt", async () => {
    const env = makeEnv();
    const ip = "198.51.100.211";
    for (const value of [`Bearer ${" ".repeat(64_000)}x`, `Bearer${" ".repeat(64_000)}${KEY}`]) {
      const started = performance.now();
      const res = await call(env, "/api/auth/check", { headers: { Authorization: value, "CF-Connecting-IP": ip } });
      expect(res.status).toBe(401);
      expect(performance.now() - started).toBeLessThan(1_000); // about 10 ms now; the regex took seconds
    }
    for (let i = 2; i < ACCESS_FAILURE_MAX; i++) await call(env, "/api/auth/check", { headers: { ...bearer("wrong-key-0123456789-x"), "CF-Connecting-IP": ip } });
    expect((await call(env, "/api/auth/check", { headers: { ...bearer(), "CF-Connecting-IP": ip } })).status).toBe(429);
    expect(env.touched).toEqual([]);
  });
});

describe("locked: with the right key everything works as before", () => {
  it("any case of the scheme, surrounding spaces tolerated; GET /api/auth/check answers 204 with no body", async () => {
    const env = makeEnv();
    for (const value of [`Bearer ${KEY}`, `bearer ${KEY}`, `BEARER ${KEY}`, `  Bearer ${KEY}  `]) {
      const res = await call(env, "/api/auth/check", { headers: { Authorization: value } });
      expect(res.status, value).toBe(204);
      expect(await res.text()).toBe("");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(env.touched).toEqual([]); // the check itself costs no D1 either
  });

  it("a key set with a trailing newline (a paste) still matches", async () => {
    const res = await call(makeEnv({ ACCESS_KEY: `${KEY}\n` }), "/api/auth/check", { headers: bearer() });
    expect(res.status).toBe(204);
  });

  it("every route reaches its own handler: no answer comes from the gate", async () => {
    const env = makeEnv();
    for (const [path, methods] of allRoutes()) {
      for (const method of methods) {
        const res = await call(env, path, requestInit(method, bearer()));
        expect(res.status, `${method} ${path}`).not.toBe(401);
        expect(GATE_CODES, `${method} ${path}`).not.toContain(await errorCode(res));
        expect(res.headers.get("Cache-Control"), `${method} ${path}`).toBe("no-store"); // nothing shared may cache an authorised answer
      }
    }
    // real work happened behind the gate
    const airports = await call(env, "/api/airports?q=tel", { headers: bearer() });
    expect(airports.status).toBe(200);
    expect(((await airports.json()) as { results: { code: string }[] }).results.map((r) => r.code)).toContain("TLV");
    expect((await call(env, "/api/deals", { headers: bearer() })).status).toBe(200);
    expect(env.touched.length).toBeGreaterThan(0);
  });

  it("the router's own answers are unchanged behind the gate: 404, 405, trailing slash", async () => {
    const env = makeEnv();
    expect((await call(env, "/api/nope", { headers: bearer() })).status).toBe(404);
    expect((await call(env, "/api/search", { headers: bearer() })).status).toBe(405);
    expect((await call(env, "/api/auth/check", { method: "POST", headers: bearer() })).status).toBe(405);
    expect((await call(env, "/api/health/", { headers: bearer() })).status).toBe(200);
    expect((await call(env, "/api/deals/", { headers: bearer() })).status).toBe(200);
  });
});

describe("locked: the public allowlist", () => {
  it("GET /api/health answers without the key, says the lock is on, and never contains the key", async () => {
    const env = makeEnv();
    for (const headers of [{}, bearer(), bearer("wrong-key-0123456789-wrong")]) {
      const res = await call(env, "/api/health", { headers });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(KEY);
      // Exactly these fields: nothing about the key, not even its length.
      expect(JSON.parse(text)).toEqual({
        status: "ok", db: "ok", build: { sha: "unknown", time: null }, migration: null, migrationsPending: null, locked: true, lockStatus: "on",
      });
    }
  });

  it("health's 503 (D1 down) carries the lock state too", async () => {
    const env = makeEnv({ DB: { prepare: () => ({ first: async () => { throw new Error("down"); } }) } as unknown as D1Database });
    const res = await call(env, "/api/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "degraded", locked: true, lockStatus: "on" });
  });

  it("POST /api/telegram/webhook reaches its own handler (Telegram cannot hold the key; the route checks its own secret)", async () => {
    // Without the Telegram settings the route does not exist: 404 from the handler, not 401 from the gate.
    const unconfigured = makeEnv();
    expect((await call(unconfigured, "/api/telegram/webhook", requestInit("POST"))).status).toBe(404);
    expect(unconfigured.touched).toEqual([]);
    const tg = {
      TELEGRAM_BOT_TOKEN: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw5",
      TELEGRAM_WEBHOOK_SECRET: "whsec_test_0123456789abcdef",
      TELEGRAM_BOT_USERNAME: "EeeFlightsBot",
    };
    // A wrong or missing webhook secret (the access key does not help either): the handler's own 401, before any D1 or bot work.
    const refused = makeEnv(tg);
    const attempts: Record<string, string>[] = [{ "X-Telegram-Bot-Api-Secret-Token": "wrong-secret-0123456789" }, {}, bearer()];
    for (const headers of attempts) {
      const wrong = await call(refused, "/api/telegram/webhook", requestInit("POST", headers));
      expect(wrong.status).toBe(401); // the webhook's own check still applies
      expect(wrong.headers.get("WWW-Authenticate")).toBeNull(); // ...and that 401 is the handler's, not the gate's
    }
    expect(refused.touched).toEqual([]);
    const env = makeEnv(tg);
    const ok = await call(env, "/api/telegram/webhook", requestInit("POST", { "X-Telegram-Bot-Api-Secret-Token": tg.TELEGRAM_WEBHOOK_SECRET }));
    expect(ok.status).toBe(200);
  });

  // Review finding (break-the-lock, informational): health reads D1 without the key. By design (the public liveness check,
  // older than the lock): pinned here so that it stays the only such route, and stays two small fixed reads.
  it("GET /api/health is the one public request that reads D1: its two fixed liveness reads, nothing else", async () => {
    const env = makeEnv();
    expect((await call(env, "/api/health")).status).toBe(200);
    expect(env.touched).toEqual(["prepare", "prepare"]);
    const others = makeEnv({ ALLOWED_ORIGIN: ORIGIN });
    await call(others, "/api/telegram/webhook", requestInit("POST"));
    for (const [path] of allRoutes()) await call(others, path, { method: "OPTIONS", headers: { Origin: ORIGIN } });
    expect(others.touched).toEqual([]);
  });
});

/** Every method some route accepts: a locked API's one preflight answer grants them all (see index.ts, route()). */
const ALL_ROUTE_METHODS = "GET, POST, DELETE, OPTIONS";

describe("locked: CORS", () => {
  it("a preflight needs no key, grants the Authorization header and every route's methods to the one origin, and touches no D1", async () => {
    const env = makeEnv({ ALLOWED_ORIGIN: ORIGIN });
    for (const [path, methods] of allRoutes()) {
      const res = await call(env, path, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": methods[0] as string, "Access-Control-Request-Headers": "authorization" } });
      expect(res.status, path).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
      expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, Authorization");
      expect(res.headers.get("Access-Control-Allow-Methods")).toBe(ALL_ROUTE_METHODS);
      // ...so every real call the web makes passes its preflight
      for (const method of methods) expect(ALL_ROUTE_METHODS.split(", "), `${method} ${path}`).toContain(method);
    }
    const other = await call(env, "/api/deals", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    expect(other.status).toBe(204);
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(env.touched).toEqual([]);
  });

  // Review finding (break-the-lock, informational): OPTIONS was public on every path, and the router answered 204 for a known
  // path but 404 for an unknown one, so anyone could list the routes without the key.
  it("a preflight cannot tell which routes exist: every path, known or not, gets the same answer (lock on or misconfigured)", async () => {
    const unknown = [
      "/api/deals-nope", "/api/nope", "/api", "/api/", "/", "/nope", "//api/deals", "/API/deals", "/api/watches/", "/api/watches/x/y",
      "/favicon.ico", "/api/party-check-x", "/api/auth", "/api/auth/check/x",
    ];
    const snapshot = async (res: Response) => JSON.stringify({ status: res.status, body: await res.text(), headers: [...res.headers].sort() });
    for (const over of [{}, { ACCESS_KEY: "short-key" }]) {
      const env = makeEnv({ ALLOWED_ORIGIN: ORIGIN, ...over });
      for (const origin of [ORIGIN, "https://evil.example", null]) {
        const answers = new Map<string, string[]>();
        for (const path of [...allRoutes().map(([p]) => p), ...unknown]) {
          const headers: Record<string, string> = { "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" };
          if (origin !== null) headers.Origin = origin;
          const key = await snapshot(await call(env, path, { method: "OPTIONS", headers }));
          answers.set(key, [...(answers.get(key) ?? []), path]);
        }
        expect([...answers.values()], `${JSON.stringify(over)} origin ${origin}`).toHaveLength(1);
      }
      expect(env.touched).toEqual([]);
    }
  });

  it("with the lock off the router answers preflights exactly as before (404 for an unknown path, a path's own methods)", async () => {
    const env = makeEnv({ ALLOWED_ORIGIN: ORIGIN, ACCESS_KEY: undefined });
    const preflight = (path: string) => call(env, path, { method: "OPTIONS", headers: { Origin: ORIGIN } });
    expect((await preflight("/api/nope")).status).toBe(404);
    expect((await preflight("/api/search")).headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect((await preflight(`/api/watches/${WATCH_TOKEN}`)).headers.get("Access-Control-Allow-Methods")).toBe("GET, DELETE, OPTIONS");
    expect((await preflight("/api/deals")).headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, Authorization");
  });

  it("401, 429 and 503 answers carry the CORS headers, so the web can read them", async () => {
    const env = makeEnv({ ALLOWED_ORIGIN: ORIGIN });
    const unauthorized = await call(env, "/api/deals", { headers: { Origin: ORIGIN } });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(unauthorized.headers.get("Vary")).toContain("Origin");

    const ip = "192.0.2.201";
    for (let i = 0; i < ACCESS_FAILURE_MAX; i++) await call(env, "/api/deals", { headers: { ...bearer("wrong-wrong-wrong-wrong"), "CF-Connecting-IP": ip } });
    const blocked = await call(env, "/api/deals", { headers: { ...bearer(), Origin: ORIGIN, "CF-Connecting-IP": ip } });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(blocked.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");

    const misconfigured = await call(makeEnv({ ALLOWED_ORIGIN: ORIGIN, ACCESS_KEY: "short" }), "/api/deals", { headers: { Origin: ORIGIN } });
    expect(misconfigured.status).toBe(503);
    expect(misconfigured.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(env.touched).toEqual([]);
  });
});

describe("locked: failed attempts are limited in memory (never D1)", () => {
  it(`${ACCESS_FAILURE_MAX} failures per client per 10 minutes, then 429 with Retry-After for everything protected, the right key included`, async () => {
    const env = makeEnv();
    const ip = "198.51.100.23";
    for (let i = 1; i <= ACCESS_FAILURE_MAX; i++) {
      const res = await call(env, "/api/auth/check", { headers: { ...bearer(`wrong-${i}-0123456789abcdef`), "CF-Connecting-IP": ip } });
      expect(res.status, `attempt ${i}`).toBe(401);
    }
    for (const headers of [bearer(), {}, bearer("wrong-again-0123456789")]) {
      const blocked = await call(env, "/api/auth/check", { headers: { ...headers, "CF-Connecting-IP": ip } });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("Retry-After")).toBe("480"); // the rest of the fixed 10-minute window (NOW is 2 minutes in)
      expect(await blocked.json()).toEqual({ error: { code: "too_many_attempts", message: "Too many failed access attempts, try again later", retryAfterSec: 480 } });
    }
    // Other routes are blocked for that client too, public ones are not; another client is unaffected.
    expect((await call(env, "/api/deals", { headers: { ...bearer(), "CF-Connecting-IP": ip } })).status).toBe(429);
    expect((await call(env, "/api/health", { headers: { "CF-Connecting-IP": ip } })).status).toBe(200);
    expect((await call(env, "/api/auth/check", { headers: { ...bearer(), "CF-Connecting-IP": "198.51.100.24" } })).status).toBe(204);
    // The next window starts clean.
    vi.setSystemTime(new Date(NOW.getTime() + 480_000));
    expect((await call(env, "/api/auth/check", { headers: { ...bearer(), "CF-Connecting-IP": ip } })).status).toBe(204);
    expect(env.touched.filter((p) => p !== "prepare")).toEqual([]);
    expect(env.touched.filter((p) => p === "prepare")).toHaveLength(2); // health's two reads, nothing else
  });

  it("an IPv6 client is one client per /64", async () => {
    const env = makeEnv();
    for (let i = 1; i <= ACCESS_FAILURE_MAX; i++) {
      await call(env, "/api/auth/check", { headers: { ...bearer("wrong-key-0123456789-x"), "CF-Connecting-IP": `2001:db8:5:6::${i.toString(16)}` } });
    }
    expect((await call(env, "/api/auth/check", { headers: { ...bearer(), "CF-Connecting-IP": "2001:db8:5:6:abcd:ef01:2345:6789" } })).status).toBe(429);
    expect((await call(env, "/api/auth/check", { headers: { ...bearer(), "CF-Connecting-IP": "2001:db8:5:7::1" } })).status).toBe(204);
  });

  it("requests that bring no credentials at all (the lock screen loading) are refused but not counted", async () => {
    const env = makeEnv();
    const ip = "198.51.100.77";
    for (let i = 0; i < ACCESS_FAILURE_MAX * 2; i++) expect((await call(env, "/api/deals", { headers: { "CF-Connecting-IP": ip } })).status).toBe(401);
    expect((await call(env, "/api/auth/check", { headers: { ...bearer(), "CF-Connecting-IP": ip } })).status).toBe(204);
    expect(env.touched).toEqual([]);
  });

  it("a blocked client gets the very same 429 whatever it sends: nothing tells a right key from a wrong one", async () => {
    const env = makeEnv({ ALLOWED_ORIGIN: ORIGIN });
    const ip = "198.51.100.131";
    for (let i = 0; i < ACCESS_FAILURE_MAX; i++) await call(env, "/api/deals", { headers: { ...bearer(`wrong-${i}-0123456789abcdef`), "CF-Connecting-IP": ip } });
    const answers = new Set<string>();
    for (const headers of [bearer(), bearer(`${KEY.slice(0, -1)}x`), {}, { Authorization: "garbage" }]) {
      const res = await call(env, "/api/auth/check", { headers: { ...headers, Origin: ORIGIN, "CF-Connecting-IP": ip } });
      expect(res.status).toBe(429);
      answers.add(JSON.stringify({ body: await res.text(), headers: [...res.headers].sort() }));
    }
    expect(answers.size).toBe(1);
    expect(env.touched).toEqual([]);
  });

  it("failures that arrive without a client address count on their own: they cannot block the owner's real address", async () => {
    const env = makeEnv();
    const anonymous = (key: string) => call(env, "", {}, new Request(`${BASE}/api/auth/check`, { headers: bearer(key) }));
    for (let i = 0; i < ACCESS_FAILURE_MAX; i++) expect((await anonymous(`wrong-${i}-0123456789abcdef`)).status).toBe(401);
    expect((await anonymous(KEY)).status).toBe(429); // that "unknown" bucket is now blocked...
    expect((await call(env, "/api/auth/check", { headers: { ...bearer(), "CF-Connecting-IP": "203.0.113.9" } })).status).toBe(204); // ...nobody else
  });

  it("a refused request's body is never read, however large: nothing is worked on before the key is checked", async () => {
    const env = makeEnv();
    for (const path of ["/api/search", "/api/watches", "/api/nope"]) {
      const request = new Request(`${BASE}${path}`, {
        method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() }, body: "x".repeat(2 * 1024 * 1024),
      });
      expect((await call(env, "", {}, request)).status, path).toBe(401);
      expect(request.bodyUsed, path).toBe(false);
    }
    expect(env.touched).toEqual([]);
  });
});

describe("misconfigured (a key shorter than 20 characters): fail closed", () => {
  it("every protected route answers 503 access_misconfigured, the short key included, and serves no data", async () => {
    const env = makeEnv({ ACCESS_KEY: "short-key" });
    for (const [path, methods] of allRoutes()) {
      for (const method of methods) {
        if (isPublicRequest(method, path)) continue;
        for (const headers of [{}, bearer("short-key"), bearer()]) {
          const res = await call(env, path, requestInit(method, headers));
          expect(res.status, `${method} ${path}`).toBe(503);
          expect(await res.json()).toEqual({ error: { code: "access_misconfigured", message: "The access lock is misconfigured", reason: "too_short" } });
        }
      }
    }
    expect(env.touched).toEqual([]);
  });

  it("health says so; the webhook and preflights keep working", async () => {
    const env = makeEnv({ ACCESS_KEY: "short-key", ALLOWED_ORIGIN: ORIGIN });
    const health = await call(env, "/api/health");
    expect(health.status).toBe(200);
    const body = (await health.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "ok", locked: true, lockStatus: "misconfigured" });
    expect(JSON.stringify(body)).not.toContain("short-key");
    expect((await call(env, "/api/telegram/webhook", requestInit("POST"))).status).toBe(404);
    expect((await call(env, "/api/deals", { method: "OPTIONS", headers: { Origin: ORIGIN } })).status).toBe(204);
  });

  it("whitespace, too long, or characters a header cannot carry are misconfigured too, with the reason", async () => {
    for (const [value, reason] of [["   ", "too_short"], ["x".repeat(257), "too_long"], [`${"x".repeat(20)} ${"y".repeat(5)}`, "invalid_characters"], [`מפתח-${"x".repeat(20)}`, "invalid_characters"]] as const) {
      const env = makeEnv({ ACCESS_KEY: value });
      const res = await call(env, "/api/auth/check");
      expect(res.status, reason).toBe(503);
      expect(((await res.json()) as { error: { reason: string } }).error.reason).toBe(reason);
      expect(await (await call(env, "/api/health")).json()).toMatchObject({ lockStatus: "misconfigured" });
    }
  });

  it("the misconfigured value itself is never echoed, by the 503 or by health (the reason is a fixed word)", async () => {
    for (const value of ["short-key-9", "Q".repeat(300), `${"secret".repeat(4)} with spaces`, `מפתח-${"y".repeat(20)}`]) {
      const env = makeEnv({ ACCESS_KEY: value });
      for (const res of [await call(env, "/api/deals"), await call(env, "/api/auth/check", { headers: bearer("short-key-9") }), await call(env, "/api/health")]) {
        const text = await res.text();
        expect(text).not.toContain(value.slice(0, 11));
        expect(text).not.toMatch(/"reason":"(?!too_short"|too_long"|invalid_characters")/);
      }
      expect(env.touched.filter((p) => p !== "prepare")).toEqual([]); // health's reads only
    }
  });
});

describe("unset: the lock is off and the API is public exactly as before", () => {
  it("no ACCESS_KEY (or an empty one): everything answers without a key, and a stray Authorization header is ignored", async () => {
    for (const env of [makeEnv({ ACCESS_KEY: undefined }), makeEnv({ ACCESS_KEY: "" })]) {
      expect((await call(env, "/api/auth/check")).status).toBe(204);
      expect((await call(env, "/api/auth/check", { headers: bearer("anything-at-all-here") })).status).toBe(204);
      expect((await call(env, "/api/airports?q=tel")).status).toBe(200);
      expect((await call(env, "/api/deals", { headers: { Authorization: "garbage" } })).status).toBe(200);
      expect((await call(env, "/api/nope")).status).toBe(404); // the router's own answer, as before
      expect(await (await call(env, "/api/health")).json()).toMatchObject({ locked: false, lockStatus: "off" });
    }
  });

  it("many wrong keys change nothing while the lock is off (nothing is counted)", async () => {
    const env = makeEnv({ ACCESS_KEY: undefined });
    const ip = "198.51.100.99";
    for (let i = 0; i < ACCESS_FAILURE_MAX + 5; i++) {
      expect((await call(env, "/api/auth/check", { headers: { ...bearer(`wrong-${i}-0123456789abc`), "CF-Connecting-IP": ip } })).status).toBe(204);
    }
  });
});

describe("scheduled jobs are not HTTP and are not gated", () => {
  it("the retention job runs with the lock on", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      "INSERT INTO prices (origin, destination, depart_date, return_date, price_amount, price_currency, source, ticket_structure, airlines_json, legs_json, includes_json, checked_at) VALUES ('TLV', 'BCN', '2026-08-01', '2026-08-06', 100, 'USD', 'travelpayouts', 'roundtrip', '[]', '{}', '{}', ?)",
    ).bind(NOW.toISOString()).run();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as unknown as ExecutionContext;
    await worker.scheduled({ scheduledTime: NOW.getTime(), cron: "17 3 * * *", noRetry() {} } as ScheduledController, env, ctx);
    await Promise.all(pending);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM prices").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("the secret is documented and typed, and never holds a value in the repo", () => {
  it("listed empty in .dev.vars.example, named in wrangler.toml's secrets comment, optional in Env, explained in the docs", () => {
    expect(readFileSync(join(workerDir, ".dev.vars.example"), "utf8")).toMatch(/^ACCESS_KEY=$/m);
    const toml = readFileSync(join(workerDir, "wrangler.toml"), "utf8");
    expect(toml).toContain("wrangler secret put ACCESS_KEY");
    expect(toml).not.toMatch(/^\s*ACCESS_KEY\s*=/m);
    expect(readFileSync(join(workerDir, "src", "types.ts"), "utf8")).toMatch(/\bACCESS_KEY\?: string/);
    const docs = readFileSync(join(workerDir, "..", "docs", "CLOUDFLARE_SETUP.md"), "utf8");
    expect(docs).toContain("נעילת האתר לשימוש אישי");
    expect(docs).toContain("npx wrangler secret put ACCESS_KEY");
    expect(docs).toContain("npx wrangler secret delete ACCESS_KEY");
  });

  // Review findings (ux-compat 2, 8, 9, 10): the setup order, and the smoke run that keeps the key out of history and env.
  it("the docs set the secret last, run the smoke test in a subshell, and word every misconfigured case as the lock screen does", () => {
    const docs = readFileSync(join(workerDir, "..", "docs", "CLOUDFLARE_SETUP.md"), "utf8");
    expect(docs).toContain("קודם הקוד, בסוף הסוד");
    expect(docs).not.toContain("סדר ההעלאה לא משנה");
    expect(docs).not.toMatch(/אין צורך בהעלאה חדשה: הנעילה פעילה מיד/);
    expect(docs).toMatch(/Variable name.*ACCESS_KEY.*Value.*\*\*Deploy\*\*/);
    const safeRun = "( read -rs EEE_ACCESS_KEY && export EEE_ACCESS_KEY && bash scripts/smoke.sh )";
    expect(docs).toContain(safeRun);
    expect(docs).toContain("המסוף לא מציג כלום");
    expect(docs).toContain("(המפתח לא תקין)");
    const smoke = readFileSync(join(workerDir, "..", "scripts", "smoke.sh"), "utf8");
    expect(smoke).toContain(`echo "בלי שהמפתח יישמר בהיסטוריה: ${safeRun}`);
    expect(smoke).toContain("[\\x21-\\x7e]{20,256}");
  });
});
