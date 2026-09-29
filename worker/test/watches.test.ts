/**
 * Price alerts (src/watches.ts, src/telegram.ts, migration 0006): the API, the Telegram webhook, the good-price rules and
 * the scheduled check, including its subrequest budget. Upstreams (Telegram, Travelpayouts) are stubs: nothing leaves.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as entry from "../src/index";
import { createRepo } from "../src/db";
import { botStartLink, parseCommand, parseUpdate, secretMatches, sendTelegramMessage, telegramConfig } from "../src/telegram";
import {
  alertMessage,
  alertReasons,
  ANON_USER_EMAIL,
  cheapestForWatch,
  LIVE_SCANS_PER_RUN,
  newWatchToken,
  parseStoredRequest,
  parseWatchBody,
  RUN_SUBREQUEST_BUDGET,
  runWatchChecks,
  SubrequestBudget,
  tokenHash,
  WATCH_MAX_PER_CHAT,
  WATCH_MAX_PER_CLIENT,
  WATCH_MAX_TOTAL,
  WATCH_HISTORY_ROWS,
  WATCHES_PER_RUN,
  WRITE_FLUSH_EVERY,
  loadWatchHistory,
  cachedPriceText,
  watchExpiry,
  type WatchRunDeps,
  type WatchState,
} from "../src/watches";
import { defaultResolver } from "../src/pipeline";
import { QUOTE_MAX_AGE_HOURS } from "../src/quotes";
import type { DealAssessment } from "../src/deals";
import type { Env, FxRates, Offer, SearchRequest, TravelpayoutsClient } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const worker = entry.default;
const NOW = new Date("2026-10-01T09:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BASE = "https://api.example.test";
const IP = "203.0.113.7";
const BOT_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw5";
const WH_SECRET = "whsec_test_0123456789abcdef";
const BOT_USER = "EeeFlightsBot";
const TG = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: WH_SECRET, TELEGRAM_BOT_USERNAME: BOT_USER };
const FX: FxRates = { date: "2026-10-01", source: "test", ratesToIls: { ILS: 1, USD: 3.6, EUR: 4 } };

const BODY = { origin: "TLV", destination: "BCN", windowStart: "2026-11-10", windowEnd: "2026-11-25", stayMin: 5, stayMax: 7 };

function makeEnv(over: Partial<Env> = {}): Env {
  return { DB: createTestD1(), TRAVELPAYOUTS_TOKEN: "tp-token-0123456789", TRAVELPAYOUTS_MARKER: "12345", ...TG, ...over };
}

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
  await Promise.all(pending);
  return res;
}

const createWatch = (env: Env, body: unknown = BODY, ip = IP) =>
  call(env, "/api/watches", { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(body) });

const webhook = (env: Env, update: unknown, secret: string | null = WH_SECRET) =>
  call(env, "/api/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret === null ? {} : { "X-Telegram-Bot-Api-Secret-Token": secret }) },
    body: typeof update === "string" ? update : JSON.stringify(update),
  });

const replyText = async (r: Promise<Response>): Promise<string> => ((await (await r).json()) as { text: string }).text;

const tgText = (chatId: number, text: string, type = "private") => ({ update_id: 1, message: { message_id: 1, chat: { id: chatId, type }, text } });

const rows = async <T = Record<string, unknown>>(env: Env | D1Database, sql: string, ...binds: unknown[]) =>
  (await ("DB" in env ? env.DB : env).prepare(sql).bind(...binds).all<T>()).results;

function mkReq(o: Partial<SearchRequest> = {}): SearchRequest {
  return {
    origin: "TLV", destination: "BCN", windowStart: "2026-11-10", windowEnd: "2026-11-25", stayMin: 5, stayMax: 7,
    adults: 1, children: 0, infants: 0, cabin: "economy", checkedBag: false, outHours: null, retHours: null, maxStops: null, nearbyAirports: false,
    ...o,
  };
}

function mkOffer(o: Partial<Offer> = {}): Offer {
  return {
    origin: "TLV", destination: "BCN", departDate: "2026-11-12", returnDate: "2026-11-18", priceAmount: 100, priceCurrency: "USD",
    source: "travelpayouts", ticketStructure: "roundtrip",
    outbound: { departTime: "07:30", arriveTime: "11:05", stops: 0, durationMin: 215, airlines: ["LY"] },
    inbound: { departTime: "12:10", arriveTime: "16:45", stops: 0, durationMin: 275, airlines: ["LY"] },
    includes: {}, deeplink: "https://www.aviasales.com/search/TLV1211BCN18111?marker=12345", verifyLink: null,
    checkedAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(), extrasAmountIls: 0, totalIls: null, tags: [],
    ...o,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- migration ---------------------------------------------------------------------------------------------

describe("migration 0006", () => {
  it("adds the placeholder owner, the new columns and the token index", async () => {
    const db = createTestD1();
    expect(await rows(db, "SELECT email FROM users")).toEqual([{ email: ANON_USER_EMAIL }]);
    const cols = (await rows<{ name: string }>(db, "PRAGMA table_info(watches)")).map((c) => c.name);
    for (const c of ["token_hash", "request_json", "client_hash", "created_at", "telegram_chat_id", "last_checked_at", "baseline_ils", "last_alert_ils"]) expect(cols).toContain(c);
    const alertCols = (await rows<{ name: string }>(db, "PRAGMA table_info(alerts)")).map((c) => c.name);
    expect(alertCols).toContain("sent_telegram");
    const idx = await rows<{ name: string; unique: number }>(db, "PRAGMA index_list(watches)");
    expect(idx.find((i) => i.name === "idx_watches_token")?.unique).toBe(1);
  });

  it("is named with the team id and has no semicolon inside a comment (D1 splits on them)", () => {
    const text = readFileSync(join(__dirname, "..", "migrations", "0006_m11_price_alerts.sql"), "utf8");
    for (const line of text.split("\n").filter((l) => l.trim().startsWith("--"))) expect(line).not.toContain(";");
  });
});

// --- pure parts ----------------------------------------------------------------------------------------------

describe("watch body", () => {
  const deps = { resolver: defaultResolver, now: NOW };

  it("is the search body; without rules the default drop % applies, a target alone turns the drop rule off", () => {
    const plain = parseWatchBody(BODY, deps);
    expect(plain).toMatchObject({ ok: true, value: { targetPriceIls: null, dropPct: 10 } });
    expect(parseWatchBody({ ...BODY, targetPriceIls: 1500 }, deps)).toMatchObject({ ok: true, value: { targetPriceIls: 1500, dropPct: 0 } });
    expect(parseWatchBody({ ...BODY, targetPriceIls: 1500, dropPct: 20 }, deps)).toMatchObject({ ok: true, value: { targetPriceIls: 1500, dropPct: 20 } });
  });

  it("collects the search errors and its own", () => {
    const bad = parseWatchBody({ ...BODY, windowStart: "2020-01-01", targetPriceIls: "cheap", dropPct: 0.5 }, deps);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.fields)).toEqual(expect.arrayContaining(["dropPct", "targetPriceIls", "windowStart"]));
    for (const t of [10, 1e7, Number.NaN, -5]) expect(parseWatchBody({ ...BODY, targetPriceIls: t }, deps).ok).toBe(false);
    for (const d of [0, 91, 12.5]) expect(parseWatchBody({ ...BODY, dropPct: d }, deps).ok).toBe(false);
  });

  it("the stored request round-trips and a damaged one is rejected", () => {
    const req = mkReq({ outHours: [6, 12], maxStops: 1 });
    expect(parseStoredRequest(JSON.stringify(req))).toEqual(req);
    for (const t of ["", "{", "null", JSON.stringify({ ...req, adults: 0 }), JSON.stringify({ ...req, outHours: [1] }), JSON.stringify({ ...req, windowEnd: "2026-02-30" })]) {
      expect(parseStoredRequest(t)).toBeNull();
    }
  });

  it("expires after 60 days, or the day after the last possible departure", () => {
    expect(watchExpiry(mkReq(), NOW)).toBe("2026-11-21T00:00:00.000Z"); // window end 25.11 minus 5 nights = 20.11, +1 day
    expect(watchExpiry(mkReq({ windowStart: "2027-06-01", windowEnd: "2027-07-01" }), NOW)).toBe(new Date(NOW.getTime() + 60 * DAY).toISOString());
  });

  it("tokens are 43 url-safe characters, unique, and valid bot start parameters", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const t = newWatchToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      seen.add(t);
    }
    expect(seen.size).toBe(50);
    expect(botStartLink(BOT_USER, [...seen][0] as string)).toMatch(/^https:\/\/t\.me\/EeeFlightsBot\?start=[A-Za-z0-9_-]{43}$/);
    expect(() => botStartLink(BOT_USER, "a b")).toThrow();
  });
});

describe("telegram helpers", () => {
  it("the channel exists only with all three well-formed settings (fail closed)", () => {
    expect(telegramConfig(TG)).toEqual({ botToken: BOT_TOKEN, webhookSecret: WH_SECRET, botUsername: BOT_USER });
    expect(telegramConfig({ ...TG, TELEGRAM_BOT_USERNAME: "@EeeFlightsBot" })?.botUsername).toBe(BOT_USER);
    for (const k of Object.keys(TG)) expect(telegramConfig({ ...TG, [k]: undefined }), k).toBeNull();
    for (const k of Object.keys(TG)) expect(telegramConfig({ ...TG, [k]: "  " }), k).toBeNull();
    expect(telegramConfig({ ...TG, TELEGRAM_WEBHOOK_SECRET: "short" })).toBeNull();
    expect(telegramConfig({ ...TG, TELEGRAM_WEBHOOK_SECRET: "has spaces in it 0123456789" })).toBeNull();
    expect(telegramConfig({ ...TG, TELEGRAM_BOT_TOKEN: "123:abc/../x" })).toBeNull();
    expect(telegramConfig({ ...TG, TELEGRAM_BOT_USERNAME: "NotABotName" })).toBeNull();
  });

  it("secret comparison", async () => {
    expect(await secretMatches(WH_SECRET, WH_SECRET)).toBe(true);
    expect(await secretMatches(`${WH_SECRET}x`, WH_SECRET)).toBe(false);
    expect(await secretMatches("", WH_SECRET)).toBe(false);
    expect(await secretMatches(null, WH_SECRET)).toBe(false);
  });

  it("commands and updates", () => {
    expect(parseCommand("/start abc")).toEqual({ name: "start", arg: "abc" });
    expect(parseCommand("/stop@EeeFlightsBot")).toEqual({ name: "stop", arg: "" });
    expect(parseCommand("/STOP_12")).toEqual({ name: "stop_12", arg: "" });
    expect(parseCommand("hello")).toBeNull();
    expect(parseUpdate(tgText(42, "/list"))).toEqual({ chatId: "42", text: "/list" });
    expect(parseUpdate(tgText(-100, "/list", "group"))).toBeNull();
    expect(parseUpdate({ update_id: 1, edited_message: tgText(1, "x").message })).toBeNull();
    expect(parseUpdate({ message: { chat: { id: 1.5, type: "private" }, text: "x" } })).toBeNull();
    expect(parseUpdate(null)).toBeNull();
  });

  it("sendMessage: plain text, no preview, a timeout; 403 means blocked; errors never throw and are not retried", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await sendTelegramMessage(fetchFn as unknown as typeof fetch, BOT_TOKEN, "42", "שלום")).toBe("sent");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: "42", text: "שלום", link_preview_options: { is_disabled: true } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const once = (r: Response | Error) => vi.fn(async () => { if (r instanceof Error) throw r; return r; }) as unknown as typeof fetch;
    expect(await sendTelegramMessage(once(new Response("", { status: 403 })), BOT_TOKEN, "42", "x")).toBe("blocked");
    expect(await sendTelegramMessage(once(new Response(JSON.stringify({ description: "Bad Request: chat not found" }), { status: 400 })), BOT_TOKEN, "42", "x")).toBe("blocked");
    expect(await sendTelegramMessage(once(new Response("", { status: 429 })), BOT_TOKEN, "42", "x")).toBe("failed");
    const boom = vi.fn(async () => { throw new Error("net"); });
    expect(await sendTelegramMessage(boom as unknown as typeof fetch, BOT_TOKEN, "42", "x")).toBe("failed");
    expect(boom).toHaveBeenCalledTimes(1);
  });
});

describe("good-price rules", () => {
  const state = (o: Partial<WatchState> = {}): WatchState => ({ thresholdIls: null, dropPct: 10, baselineIls: null, lastAlertAt: null, lastAlertIls: null, ...o });
  const deal = (verdict: DealAssessment["verdict"], dropPct = 35): DealAssessment =>
    verdict === "insufficient_data"
      ? { verdict, baselineIls: null, madIls: null, dropPct: null, robustZ: null, sampleSize: 0, spanDays: 0, reason: "" }
      : { verdict, baselineIls: 1000, madIls: 10, dropPct, robustZ: -5, sampleSize: 20, spanDays: 10, reason: "" };

  it("target: at or below it", () => {
    expect(alertReasons(1500, state({ thresholdIls: 1500, dropPct: 0 }), null, NOW).map((r) => r.kind)).toEqual(["target"]);
    expect(alertReasons(1500.01, state({ thresholdIls: 1500, dropPct: 0 }), null, NOW)).toEqual([]);
  });

  it("drop: measured from the first price seen; no baseline yet, no drop", () => {
    expect(alertReasons(900, state({ baselineIls: 1000 }), null, NOW).map((r) => r.kind)).toEqual(["drop"]);
    expect(alertReasons(901, state({ baselineIls: 1000 }), null, NOW)).toEqual([]);
    expect(alertReasons(100, state({ baselineIls: null }), null, NOW)).toEqual([]);
    expect(alertReasons(100, state({ baselineIls: 1000, dropPct: 0 }), null, NOW)).toEqual([]);
  });

  it("deal: only the detector's deal / error_fare verdicts", () => {
    expect(alertReasons(1000, state(), deal("deal"), NOW).map((r) => r.text)).toEqual(["נמוך ב-35% מהמחיר הרגיל לתאריכים האלה"]);
    expect(alertReasons(1000, state(), deal("error_fare", 55), NOW)[0]?.text).toMatch(/טעות תמחור/);
    expect(alertReasons(1000, state(), deal("normal"), NOW)).toEqual([]);
    expect(alertReasons(1000, state(), deal("insufficient_data"), NOW)).toEqual([]);
  });

  it("anti-spam: one per 24 hours, and the same price level is not announced again for a week", () => {
    const s = (lastAgoH: number, lastIls: number) => state({ thresholdIls: 2000, lastAlertAt: new Date(NOW.getTime() - lastAgoH * HOUR).toISOString(), lastAlertIls: lastIls });
    expect(alertReasons(1000, s(23, 1500), null, NOW)).toEqual([]); // too soon, even if much cheaper
    expect(alertReasons(1000, s(25, 1000), null, NOW)).toEqual([]); // same level
    expect(alertReasons(975, s(25, 1000), null, NOW)).toEqual([]); // only 2.5 % lower
    expect(alertReasons(969, s(25, 1000), null, NOW)).toHaveLength(1); // 3.1 % lower
    expect(alertReasons(1000, s(7 * 24, 1000), null, NOW)).toHaveLength(1); // a week later the same level may be repeated
  });
});

describe("pricing a watch", () => {
  it("prices the whole party with the requested bag, in ILS", () => {
    const req = mkReq({ adults: 2, children: 1 });
    const best = cheapestForWatch([mkOffer({ priceAmount: 100 }), mkOffer({ priceAmount: 90, departDate: "2026-11-13", returnDate: "2026-11-19" })], req, FX);
    expect(best).toMatchObject({ priceAmount: 270, totalIls: 972, departDate: "2026-11-13" });
    const w6 = { departTime: "07:30", arriveTime: null, stops: 0, durationMin: null, airlines: ["W6"] };
    const bag = cheapestForWatch([mkOffer({ priceAmount: 100, outbound: w6, inbound: { ...w6, departTime: "12:00" } })], mkReq({ checkedBag: true }), FX);
    expect(bag?.totalIls).toBe(360 + 2 * 45 * 4); // Wizz Air's bag fee both ways, like on a card
  });

  it("ignores dates outside the window/stay and older rows of the same flight", () => {
    const req = mkReq();
    expect(cheapestForWatch([mkOffer({ departDate: "2026-11-12", returnDate: "2026-11-14" })], req, FX)).toBeNull(); // 2 nights
    const old = mkOffer({ priceAmount: 50, checkedAt: new Date(NOW.getTime() - 20 * HOUR).toISOString() });
    const fresh = mkOffer({ priceAmount: 120 });
    expect(cheapestForWatch([old, fresh], req, FX)?.priceAmount).toBe(120);
  });

  it("with hour windows or max stops, only fares that verifiably fit count", () => {
    const night = mkOffer({ priceAmount: 50, outbound: { departTime: "02:00", arriveTime: null, stops: 0, durationMin: null, airlines: ["LY"] } });
    const day = mkOffer({ priceAmount: 80, departDate: "2026-11-13", returnDate: "2026-11-19" });
    const unknownStops = mkOffer({ priceAmount: 40, departDate: "2026-11-14", returnDate: "2026-11-20", outbound: { departTime: "08:00", arriveTime: null, stops: null, durationMin: null, airlines: ["LY"] } });
    expect(cheapestForWatch([night, day, unknownStops], mkReq({ outHours: [6, 12] }), FX)?.priceAmount).toBe(40);
    expect(cheapestForWatch([night, day, unknownStops], mkReq({ outHours: [6, 12], maxStops: 0 }), FX)?.priceAmount).toBe(80);
  });

  it("a currency without a rate is never guessed", () => {
    expect(cheapestForWatch([mkOffer({ priceCurrency: "XYZ" })], mkReq(), FX)).toBeNull();
  });
});

describe("cached price text", () => {
  it("always carries the age and the caveat", () => {
    expect(cachedPriceText(900, new Date(NOW.getTime() - 30 * 60_000).toISOString(), NOW)).toBe("מחיר שמור אחרון: ₪900 (נבדק לפני פחות משעה, ייתכן שהשתנה)");
    expect(cachedPriceText(900, null, NOW)).toContain("זמן הבדיקה לא ידוע");
  });
});

describe("the alert text", () => {
  it("Hebrew, with price, dates, the cached-price warning, the party's booking link and the stop commands", () => {
    const req = mkReq({ adults: 2 });
    const offer = cheapestForWatch([mkOffer()], req, FX) as Offer;
    const text = alertMessage({ watchId: 7, req, offer, reasons: [{ kind: "target", text: "במחיר היעד שלך" }], now: NOW });
    expect(text).toContain("₪720");
    expect(text).toContain("ל-2 נוסעים");
    expect(text).toContain("הלוך 12.11.2026 · חזור 18.11.2026 (6 לילות)");
    expect(text).toContain("מחיר שמור");
    expect(text).toContain("עשוי להשתנות");
    expect(text).toContain("לפני 2 שעות");
    expect(text).toContain("https://www.aviasales.com/search/TLV1211BCN18112?marker=12345"); // one adult -> two
    expect(text).toContain("/stop_7");
    expect(text).toMatch(/\/stop$/m);
    expect(text).toContain("ברצלונה");
  });

  it("a split ticket gets both links and says so; an unknown bag fee is said, not hidden", () => {
    const req = mkReq({ checkedBag: true });
    const offer = { ...(cheapestForWatch([mkOffer({ outbound: { ...mkOffer().outbound, airlines: ["ZZ"] } })], req, FX) as Offer) };
    offer.ticketStructure = "split";
    offer.returnDeeplink = "https://www.aviasales.com/search/BCN18111?marker=12345";
    const text = alertMessage({ watchId: 1, req, offer, reasons: [], now: NOW });
    expect(text).toContain("שני כרטיסים נפרדים");
    expect(text).toContain("כרטיס הלוך:");
    expect(text).toContain("כרטיס חזור: https://www.aviasales.com/search/BCN18111?marker=12345");
    expect(text).toContain("מחיר המזוודה לא ידוע");
  });
});

// --- HTTP ----------------------------------------------------------------------------------------------------

describe("POST /api/watches", () => {
  it("without the Telegram settings the feature is off (503) and nothing is stored", async () => {
    const env = makeEnv({ TELEGRAM_BOT_TOKEN: undefined });
    const res = await createWatch(env);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "alerts_unavailable" } });
    expect(await rows(env, "SELECT id FROM watches")).toEqual([]);
  });

  it("creates a pending watch: the token and the bot link go to the client, only the token's hash is stored", async () => {
    const env = makeEnv();
    const res = await createWatch(env, { ...BODY, targetPriceIls: 1400 });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { token: string; telegramLink: string; watch: Record<string, unknown> };
    expect(data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(data.telegramLink).toBe(`https://t.me/${BOT_USER}?start=${data.token}`);
    expect(data.watch).toMatchObject({ status: "pending", telegramLinked: false, targetPriceIls: 1400, dropPct: 0, origin: "TLV", destination: "BCN", expiresAt: "2026-11-21T00:00:00.000Z" });
    const stored = await rows<Record<string, unknown>>(env, "SELECT * FROM watches");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.token_hash).toBe(await tokenHash(data.token));
    expect(JSON.stringify(stored)).not.toContain(data.token);
    expect(JSON.stringify(stored)).not.toContain(IP);
    expect(stored[0]?.telegram_chat_id).toBeNull();
  });

  it("validation errors are 400 with fields; non-JSON is 415", async () => {
    const env = makeEnv();
    const bad = await createWatch(env, { ...BODY, dropPct: 200 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_request", fields: { dropPct: expect.any(String) } } });
    const res = await call(env, "/api/watches", { method: "POST", headers: { "content-type": "text/plain", "CF-Connecting-IP": IP }, body: "x" });
    expect(res.status).toBe(415);
  });

  it(`caps active watches per client (${WATCH_MAX_PER_CLIENT}) and in total (${WATCH_MAX_TOTAL})`, async () => {
    const env = makeEnv();
    for (let i = 0; i < WATCH_MAX_PER_CLIENT; i++) expect((await createWatch(env)).status).toBe(201);
    const over = await createWatch(env);
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: { code: "watch_limit" } });
    expect((await createWatch(env, BODY, "198.51.100.9")).status).toBe(201); // another client
    // Fill up to the global cap directly, then a new client is refused.
    const stmt = env.DB.prepare(
      "INSERT INTO watches (user_id, search_key, drop_pct, active, expires_at, token_hash, request_json, client_hash, created_at) " +
        "VALUES ((SELECT id FROM users WHERE email = ?), 'k', 10, 1, '2027-01-01T00:00:00.000Z', ?, '{}', ?, ?)",
    );
    const have = (await rows<{ n: number }>(env, "SELECT COUNT(*) AS n FROM watches"))[0]?.n as number;
    await env.DB.batch(Array.from({ length: WATCH_MAX_TOTAL - have }, (_, i) => stmt.bind(ANON_USER_EMAIL, `h${i}`, `c${i}`, NOW.toISOString())));
    const full = await createWatch(env, BODY, "192.0.2.44");
    expect(full.status).toBe(503);
    expect(await full.json()).toMatchObject({ error: { code: "watch_capacity" } });
  });

  it("an expired watch no longer counts against the client's cap", async () => {
    const env = makeEnv();
    for (let i = 0; i < WATCH_MAX_PER_CLIENT; i++) await createWatch(env);
    await env.DB.prepare("UPDATE watches SET expires_at = ?").bind(new Date(NOW.getTime() - 1000).toISOString()).run();
    expect((await createWatch(env)).status).toBe(201);
  });

  it("is rate limited per client before the body is read", async () => {
    const env = makeEnv();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await createWatch(env, { nope: true })).status);
    expect(statuses).toEqual([400, 400, 400, 400, 400, 400, 429]);
  });
});

describe("GET / DELETE /api/watches/<token>", () => {
  it("reads the watch (with the bot link while pending), deletes it, then it is gone", async () => {
    const env = makeEnv();
    const { token } = (await (await createWatch(env)).json()) as { token: string };
    const get = await call(env, `/api/watches/${token}`, { headers: { "CF-Connecting-IP": IP } });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ watch: { status: "pending", dropPct: 10 }, telegramLink: `https://t.me/${BOT_USER}?start=${token}` });
    const del = await call(env, `/api/watches/${token}`, { method: "DELETE", headers: { "CF-Connecting-IP": IP } });
    expect(del.status).toBe(200);
    expect((await call(env, `/api/watches/${token}`)).status).toBe(404);
    expect((await call(env, `/api/watches/${token}`, { method: "DELETE" })).status).toBe(404);
  });

  it("an unknown or malformed token is 404; other methods are 405 with Allow", async () => {
    const env = makeEnv();
    expect((await call(env, `/api/watches/${newWatchToken()}`)).status).toBe(404);
    expect((await call(env, "/api/watches/short")).status).toBe(404);
    expect((await call(env, "/api/watches/a%27%20OR%201=1")).status).toBe(404);
    const put = await call(env, `/api/watches/${newWatchToken()}`, { method: "PUT" });
    expect(put.status).toBe(405);
    expect(put.headers.get("Allow")).toBe("GET, DELETE, OPTIONS");
    expect((await call(env, "/api/watches", { method: "GET" })).status).toBe(405);
  });

  it("works without the Telegram settings too (a user can always look up and delete)", async () => {
    const env = makeEnv();
    const { token } = (await (await createWatch(env)).json()) as { token: string };
    const off = { ...env, TELEGRAM_BOT_TOKEN: undefined };
    expect(await (await call(off, `/api/watches/${token}`)).json()).not.toHaveProperty("telegramLink");
    expect((await call(off, `/api/watches/${token}`, { method: "DELETE" })).status).toBe(200);
  });
});

describe("POST /api/telegram/webhook", () => {
  async function linked(env: Env, chatId = 42) {
    const { token } = (await (await createWatch(env)).json()) as { token: string };
    const res = await webhook(env, tgText(chatId, `/start ${token}`));
    return { token, res, reply: (await res.json()) as { method: string; chat_id: string; text: string } };
  }

  it("does not exist without the settings; a wrong or missing secret is 401", async () => {
    expect((await webhook(makeEnv({ TELEGRAM_WEBHOOK_SECRET: undefined }), tgText(1, "/help"))).status).toBe(404);
    const env = makeEnv();
    expect((await webhook(env, tgText(1, "/help"), "wrong-secret-0123456789")).status).toBe(401);
    expect((await webhook(env, tgText(1, "/help"), null)).status).toBe(401);
  });

  it("/start <token> links the chat and answers in Hebrew through the webhook response", async () => {
    const env = makeEnv();
    const { token, res, reply } = await linked(env);
    expect(res.status).toBe(200);
    expect(reply).toMatchObject({ method: "sendMessage", chat_id: "42", link_preview_options: { is_disabled: true } });
    expect(reply.text).toContain("ההתראה הופעלה");
    expect(reply.text).toMatch(/\/stop_\d+/);
    expect(await rows(env, "SELECT telegram_chat_id FROM watches")).toEqual([{ telegram_chat_id: "42" }]);
    expect(await (await call(env, `/api/watches/${token}`)).json()).toMatchObject({ watch: { status: "active", telegramLinked: true } });
    // the same chat again is fine; another chat cannot take it over
    expect((await replyText(webhook(env, tgText(42, `/start ${token}`))))).toContain("ההתראה הופעלה");
    expect((await replyText(webhook(env, tgText(77, `/start ${token}`))))).toContain("כבר מחוברת");
    expect(await rows(env, "SELECT telegram_chat_id FROM watches")).toEqual([{ telegram_chat_id: "42" }]);
  });

  it("unknown, malformed and expired tokens get a clear answer and change nothing", async () => {
    const env = makeEnv();
    expect((await replyText(webhook(env, tgText(5, `/start ${newWatchToken()}`))))).toContain("לא מצאנו");
    expect((await replyText(webhook(env, tgText(5, "/start bad"))))).toContain("לא תקין");
    const { token } = (await (await createWatch(env)).json()) as { token: string };
    await env.DB.prepare("UPDATE watches SET expires_at = ?").bind(new Date(NOW.getTime() - 1).toISOString()).run();
    expect((await replyText(webhook(env, tgText(5, `/start ${token}`))))).toContain("פג");
  });

  it(`a chat can hold at most ${WATCH_MAX_PER_CHAT} watches`, async () => {
    const env = makeEnv();
    const answers: string[] = [];
    for (let i = 0; i <= WATCH_MAX_PER_CHAT; i++) {
      const { token } = (await (await createWatch(env, BODY, `198.51.100.${i + 1}`)).json()) as { token: string };
      answers.push(((await (await webhook(env, tgText(9, `/start ${token}`))).json()) as { text: string }).text);
    }
    expect(answers.slice(0, WATCH_MAX_PER_CHAT).every((t) => t.includes("ההתראה הופעלה"))).toBe(true);
    expect(answers[WATCH_MAX_PER_CHAT]).toContain(`עד ${WATCH_MAX_PER_CHAT}`);
    expect(await rows(env, "SELECT id FROM watches WHERE telegram_chat_id = '9'")).toHaveLength(WATCH_MAX_PER_CHAT);
  });

  it("/list, /stop_<id> (only the chat's own), /stop (all, erased)", async () => {
    const env = makeEnv();
    await linked(env, 42);
    await linked(env, 42);
    const other = await linked(env, 43);
    await env.DB.prepare("UPDATE watches SET last_price_amount = 1234, last_price_currency = 'ILS', last_price_at = ? WHERE telegram_chat_id = '42'")
      .bind(new Date(NOW.getTime() - 5 * HOUR).toISOString()).run();
    const list = (await replyText(webhook(env, tgText(42, "/list")))) as string;
    expect(list).toContain("ההתראות הפעילות שלך");
    expect(list).toContain("מחיר שמור אחרון: ₪1,234 (נבדק לפני 5 שעות, ייתכן שהשתנה)");
    expect(list).not.toMatch(/מחיר אחרון:/);
    expect(list.match(/\/stop_\d+/g)).toHaveLength(2);
    const otherId = (await rows<{ id: number }>(env, "SELECT id FROM watches WHERE telegram_chat_id = '43'"))[0]?.id;
    expect((await replyText(webhook(env, tgText(42, `/stop_${otherId}`))))).toContain("לא מצאנו");
    const mineId = (await rows<{ id: number }>(env, "SELECT id FROM watches WHERE telegram_chat_id = '42' ORDER BY id"))[0]?.id;
    expect((await replyText(webhook(env, tgText(42, `/stop_${mineId}`))))).toContain("הופסקה");
    expect((await replyText(webhook(env, tgText(42, "/stop"))))).toContain("(1)");
    expect(await rows(env, "SELECT telegram_chat_id FROM watches")).toEqual([{ telegram_chat_id: "43" }]);
    expect((await replyText(webhook(env, tgText(42, "/stop"))))).toContain("אין לך");
    expect(other.reply.text).toContain("ההתראה הופעלה");
  });

  it("anything else gets the help text; groups, junk and oversized bodies get a silent 200", async () => {
    const env = makeEnv();
    expect((await replyText(webhook(env, tgText(1, "hello"))))).toContain("/stop");
    for (const u of [tgText(-1, "/stop", "group"), "{not json", { update_id: 1 }, JSON.stringify({ x: "y".repeat(10_000) })]) {
      const res = await webhook(env, u);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
    }
  });

  it("a chat that floods the bot is answered at most 20 times per 10 minutes", async () => {
    const env = makeEnv();
    const bodies: string[] = [];
    for (let i = 0; i < 22; i++) bodies.push(await (await webhook(env, tgText(3, "/help"))).text());
    expect(bodies.filter((b) => b !== "")).toHaveLength(20);
  });
});

// --- the scheduled check -------------------------------------------------------------------------------------

/** Counts every D1 round trip (a batch is one) so a run's subrequests can be checked against the Workers Free limit. */
function countingDb(db: D1Database) {
  const counter = { n: 0 };
  const wrapStmt = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv) as unknown;
        if (prop === "bind") return (...a: unknown[]) => wrapStmt((v as (...x: unknown[]) => D1PreparedStatement).apply(target, a));
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
          return (...a: unknown[]) => {
            counter.n += 1;
            return (v as (...x: unknown[]) => unknown).apply(target, a);
          };
        }
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
  const proxied = new Proxy(db, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv) as unknown;
      if (prop === "prepare") return (sql: string) => wrapStmt(target.prepare(sql));
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) => {
          counter.n += 1;
          return target.batch(stmts);
        };
      }
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { db: proxied, counter };
}

const tpStub = (fares: Offer[] = [], configured = true) => {
  const calls: string[] = [];
  const tp: TravelpayoutsClient = {
    configured,
    callCount: () => calls.length,
    async roundTrips(o, d) {
      calls.push(`${o}-${d}`);
      return fares.map((f) => ({ ...f, checkedAt: NOW.toISOString() }));
    },
    async oneWays() {
      throw new Error("not used");
    },
  };
  return { tp, calls };
};

async function seedWatch(db: D1Database, o: { chat?: string | null; req?: SearchRequest; threshold?: number | null; drop?: number; created?: Date; expires?: string; lastChecked?: string | null; baseline?: number | null; lastAlertAt?: string | null; lastAlertIls?: number | null } = {}): Promise<number> {
  const res = await db
    .prepare(
      "INSERT INTO watches (user_id, search_key, threshold_ils, drop_pct, active, expires_at, token_hash, request_json, client_hash, created_at, telegram_chat_id, last_checked_at, baseline_ils, last_alert_at, last_alert_ils) " +
        "VALUES ((SELECT id FROM users WHERE email = ?), 'k', ?, ?, 1, ?, ?, ?, 'c', ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(
      ANON_USER_EMAIL, o.threshold ?? null, o.drop ?? 10, o.expires ?? "2026-11-21T00:00:00.000Z", await tokenHash(newWatchToken()), JSON.stringify(o.req ?? mkReq()),
      (o.created ?? NOW).toISOString(), o.chat === undefined ? "42" : o.chat, o.lastChecked ?? null, o.baseline ?? null, o.lastAlertAt ?? null, o.lastAlertIls ?? null,
    )
    .all<{ id: number }>();
  return res.results[0]?.id as number;
}

function runDeps(db: D1Database, over: Partial<WatchRunDeps> = {}) {
  const sent: Array<{ chat_id: string; text: string }> = [];
  let status = 200;
  const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as { chat_id: string; text: string });
    return new Response("{}", { status });
  });
  const deps: WatchRunDeps = {
    db, repo: createRepo(db), tp: tpStub().tp, now: NOW, fetchFn: fetchFn as unknown as typeof fetch, fx: FX,
    telegram: telegramConfig(TG), scanBudget: async () => true, ...over,
  };
  return { deps, sent, fetchFn, setStatus: (s: number) => void (status = s) };
}

describe("runWatchChecks", () => {
  it("housekeeping: expired watches drop their chat at once and go a week later; unlinked ones go after 48 hours", async () => {
    const db = createTestD1();
    const expired = await seedWatch(db, { expires: new Date(NOW.getTime() - HOUR).toISOString() });
    await seedWatch(db, { expires: new Date(NOW.getTime() - 8 * DAY).toISOString() });
    await seedWatch(db, { chat: null, created: new Date(NOW.getTime() - 49 * HOUR) });
    const young = await seedWatch(db, { chat: null, created: new Date(NOW.getTime() - 47 * HOUR) });
    const { deps } = runDeps(db, { telegram: null });
    const res = await runWatchChecks(deps);
    expect(res).toMatchObject({ housekeeping: true, selected: 0 });
    expect(await rows(db, "SELECT id, active, telegram_chat_id FROM watches ORDER BY id")).toEqual([
      { id: expired, active: 0, telegram_chat_id: null },
      { id: young, active: 1, telegram_chat_id: null },
    ]);
  });

  it("without the Telegram channel nothing is checked or sent", async () => {
    const db = createTestD1();
    await seedWatch(db, { threshold: 5000 });
    await createRepo(db).savePrices([mkOffer()]);
    const { deps, fetchFn } = runDeps(db, { telegram: null });
    expect(await runWatchChecks(deps)).toMatchObject({ checked: 0, alerts: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("prices from the stored history, alerts once, records it, and does not repeat the same level", async () => {
    const db = createTestD1();
    const id = await seedWatch(db, { threshold: 400, drop: 0 });
    await createRepo(db).savePrices([mkOffer({ priceAmount: 100 })]); // 360 ILS
    const { tp, calls } = tpStub([mkOffer()]);
    const r = runDeps(db, { tp });
    expect(await runWatchChecks(r.deps)).toMatchObject({ checked: 1, priced: 1, alerts: 1, liveScans: 0 });
    expect(calls).toEqual([]); // history was enough: no live scan
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.chat_id).toBe("42");
    expect(r.sent[0]?.text).toContain("₪360");
    expect(r.sent[0]?.text).toContain(`/stop_${id}`);
    expect(await rows(db, "SELECT last_checked_at, last_price_amount, last_price_currency, baseline_ils, last_alert_at, last_alert_ils FROM watches")).toEqual([
      { last_checked_at: NOW.toISOString(), last_price_amount: 360, last_price_currency: "ILS", baseline_ils: 360, last_alert_at: NOW.toISOString(), last_alert_ils: 360 },
    ]);
    expect(await rows(db, "SELECT watch_id, price_amount, price_currency, sent_telegram FROM alerts")).toEqual([{ watch_id: id, price_amount: 360, price_currency: "ILS", sent_telegram: 1 }]);

    // An hour later it is not due; a day later the same price is not announced again.
    const later = runDeps(db, { now: new Date(NOW.getTime() + HOUR) });
    expect(await runWatchChecks(later.deps)).toMatchObject({ selected: 0 });
    const nextDay = new Date(NOW.getTime() + 25 * HOUR);
    await createRepo(db).savePrices([mkOffer({ priceAmount: 100, checkedAt: new Date(nextDay.getTime() - HOUR).toISOString() })]);
    const again = runDeps(db, { now: nextDay });
    expect(await runWatchChecks(again.deps)).toMatchObject({ checked: 1, alerts: 0 });
    // Cheaper again (-5 %): announced.
    const day3 = new Date(NOW.getTime() + 50 * HOUR);
    await createRepo(db).savePrices([mkOffer({ priceAmount: 95, checkedAt: new Date(day3.getTime() - HOUR).toISOString() })]);
    const third = runDeps(db, { now: day3 });
    expect(await runWatchChecks(third.deps)).toMatchObject({ alerts: 1 });
    expect(third.sent[0]?.text).toContain("₪342");
  });

  it("the drop rule measures from the first price the watch saw", async () => {
    const db = createTestD1();
    await seedWatch(db, { drop: 10 });
    await createRepo(db).savePrices([mkOffer({ priceAmount: 100 })]);
    const first = runDeps(db);
    expect(await runWatchChecks(first.deps)).toMatchObject({ priced: 1, alerts: 0 }); // sets the baseline
    const t = new Date(NOW.getTime() + 21 * HOUR);
    await createRepo(db).savePrices([mkOffer({ priceAmount: 89, checkedAt: new Date(t.getTime() - HOUR).toISOString() })]);
    const second = runDeps(db, { now: t });
    expect(await runWatchChecks(second.deps)).toMatchObject({ alerts: 1 });
    expect(second.sent[0]?.text).toContain("ירד ב-11%");
    expect(await rows(db, "SELECT baseline_ils FROM watches")).toEqual([{ baseline_ils: 360 }]);
  });

  it("a watch with no recent history gets one small live scan, stored in the price history for everyone", async () => {
    const db = createTestD1();
    await seedWatch(db, { threshold: 400, drop: 0 });
    const { tp, calls } = tpStub([mkOffer({ priceAmount: 100 }), mkOffer({ priceAmount: 150, departDate: "2026-11-14", returnDate: "2026-11-20" })]);
    const r = runDeps(db, { tp });
    expect(await runWatchChecks(r.deps)).toMatchObject({ liveScans: 1, priced: 1, alerts: 1 });
    expect(calls).toEqual(["TLV-BCN"]);
    expect((await rows(db, "SELECT price_amount FROM prices ORDER BY price_amount")).map((x) => x.price_amount)).toEqual([100, 150]);
  });

  it("live scans: never when the global scan budget is spent, without a token, or for a window too wide", async () => {
    for (const over of [{ scanBudget: async () => false }, { tp: tpStub([mkOffer()], false).tp }]) {
      const db = createTestD1();
      await seedWatch(db, { threshold: 400 });
      const r = runDeps(db, over);
      expect(await runWatchChecks(r.deps)).toMatchObject({ liveScans: 0, priced: 0, alerts: 0 });
    }
    const db = createTestD1();
    await seedWatch(db, { req: mkReq({ windowStart: "2026-10-10", windowEnd: "2027-01-20" }) }); // 4 months = 10 requests
    const { tp, calls } = tpStub([mkOffer()]);
    expect(await runWatchChecks(runDeps(db, { tp }).deps)).toMatchObject({ liveScans: 0 });
    expect(calls).toEqual([]);
  });

  it(`at most ${LIVE_SCANS_PER_RUN} live scans per run; an unpriced watch is retried a few hours later, not a day`, async () => {
    const db = createTestD1();
    for (let i = 0; i < 4; i++) await seedWatch(db, { req: mkReq({ stayMin: 5 + i, stayMax: 7 + i }) });
    const { tp, calls } = tpStub([]);
    const r = runDeps(db, { tp });
    expect(await runWatchChecks(r.deps)).toMatchObject({ checked: 4, liveScans: LIVE_SCANS_PER_RUN, priced: 0 });
    expect(calls).toHaveLength(LIVE_SCANS_PER_RUN);
    const checked = await rows<{ last_checked_at: string }>(db, "SELECT last_checked_at FROM watches");
    for (const c of checked) expect(c.last_checked_at).toBe(new Date(NOW.getTime() - 17 * HOUR).toISOString());
    expect(await runWatchChecks(runDeps(db, { now: new Date(NOW.getTime() + 2 * HOUR) }).deps)).toMatchObject({ selected: 0 });
    expect(await runWatchChecks(runDeps(db, { now: new Date(NOW.getTime() + 3 * HOUR) }).deps)).toMatchObject({ selected: 4 });
  });

  it(`stays inside the subrequest budget (${RUN_SUBREQUEST_BUDGET}) even when every watch wants an alert and needs a live scan`, async () => {
    const base = createTestD1();
    const { db, counter } = countingDb(base);
    for (let i = 0; i < 30; i++) await seedWatch(base, { threshold: 100_000, drop: 0, chat: String(1000 + i), req: mkReq({ stayMin: 5, stayMax: 7 + (i % 20), adults: 1 + (i % 3) }) });
    const { tp, calls } = tpStub([mkOffer()]);
    const r = runDeps(db, { tp, fx: async () => FX });
    const res = await runWatchChecks(r.deps);
    const used = counter.n + r.fetchFn.mock.calls.length + calls.length;
    expect(used).toBeLessThanOrEqual(RUN_SUBREQUEST_BUDGET);
    expect(res.alerts).toBeGreaterThan(0);
    expect(res.budgetLeft).toBeGreaterThanOrEqual(0);
    // The budget ended the run early: what was not handled stays due (never checked) for the next run.
    expect(res.checked).toBeLessThan(30);
    expect((await rows(base, "SELECT id FROM watches WHERE last_checked_at IS NULL")).length).toBeGreaterThanOrEqual(30 - res.checked);
  });

  it("with the history and today's rates in place a run checks more than its share of the daily cap (the 'about once a day' promise)", async () => {
    const base = createTestD1();
    const { db, counter } = countingDb(base);
    await createRepo(base).savePrices([mkOffer()]);
    await createRepo(base).saveFxRates(FX);
    for (let i = 0; i < WATCHES_PER_RUN; i++) await seedWatch(base, { drop: 10, chat: String(i + 1), req: mkReq({ stayMax: 7 + i }) });
    const loader = vi.fn(async () => FX);
    const r = runDeps(db, { fx: loader });
    const res = await runWatchChecks(r.deps);
    expect(loader).not.toHaveBeenCalled(); // stored rates: the full loader's reserve is not paid
    expect(res.checked).toBeGreaterThanOrEqual(Math.ceil(WATCH_MAX_TOTAL / 24) + 3);
    expect(WATCHES_PER_RUN * 24).toBeGreaterThanOrEqual(WATCH_MAX_TOTAL);
    expect(counter.n + r.fetchFn.mock.calls.length).toBeLessThanOrEqual(RUN_SUBREQUEST_BUDGET);
  });

  it("an older, cheaper fare of the same date pair that a newer scan replaced never triggers an alert", async () => {
    const db = createTestD1();
    await seedWatch(db, { threshold: 400, drop: 0 });
    const old = mkOffer({ priceAmount: 50, checkedAt: new Date(NOW.getTime() - 20 * HOUR).toISOString() }); // 180 ILS, gone
    const fresh = mkOffer({ priceAmount: 120, outbound: { ...mkOffer().outbound, departTime: "15:00" } }); // 432 ILS, another flight
    await createRepo(db).savePrices([old, fresh]);
    expect((await loadWatchHistory(db, mkReq(), NOW)).map((o) => o.priceAmount)).toEqual([120]);
    expect(cheapestForWatch([old, fresh], mkReq(), FX, NOW)?.priceAmount).toBe(120);
    const r = runDeps(db);
    expect(await runWatchChecks(r.deps)).toMatchObject({ priced: 1, alerts: 0 });
    expect(r.sent).toEqual([]);
  });

  it("a live quote counts only while it is younger than the pipeline's quote age limit", async () => {
    const db = createTestD1();
    const quote = (h: number, amount: number) => mkOffer({ source: "serpapi", priceAmount: amount, checkedAt: new Date(NOW.getTime() - h * HOUR).toISOString() });
    await createRepo(db).savePrices([quote(QUOTE_MAX_AGE_HOURS + 1, 40), mkOffer({ priceAmount: 100 })]);
    expect((await loadWatchHistory(db, mkReq(), NOW)).map((o) => o.source)).toEqual(["travelpayouts"]);
    expect(cheapestForWatch([quote(QUOTE_MAX_AGE_HOURS + 1, 40), mkOffer()], mkReq(), FX, NOW)?.source).toBe("travelpayouts");
    expect(cheapestForWatch([quote(QUOTE_MAX_AGE_HOURS - 1, 40), mkOffer()], mkReq(), FX, NOW)?.source).toBe("serpapi");
  });

  it("SQL hands back only the cheapest few fares per currency, whatever the history size", async () => {
    const db = createTestD1();
    const many = Array.from({ length: 120 }, (_, i) => {
      const dep = 10 + (i % 8);
      return mkOffer({ departDate: `2026-11-${dep}`, returnDate: `2026-11-${dep + 5 + (i % 3)}`, priceAmount: 300 - i, source: i % 2 ? "travelpayouts" : "google_flights" });
    });
    await createRepo(db).savePrices([...many, mkOffer({ priceAmount: 500, priceCurrency: "EUR" })]);
    const got = await loadWatchHistory(db, mkReq(), NOW);
    const usd = got.filter((o) => o.priceCurrency === "USD");
    expect(usd.length).toBeLessThanOrEqual(WATCH_HISTORY_ROWS);
    expect(Math.min(...usd.map((o) => o.priceAmount))).toBe(Math.min(...many.slice(-48).map((o) => o.priceAmount)));
    expect(got.filter((o) => o.priceCurrency === "EUR")).toHaveLength(1);
    expect(cheapestForWatch(got, mkReq(), FX, NOW)?.priceAmount).toBe(181);
  });

  it("the checked state is written as the run goes: a run cut short (CPU limit) keeps the watches it finished", async () => {
    const base = createTestD1();
    await createRepo(base).savePrices([mkOffer()]);
    for (let i = 0; i < 8; i++) await seedWatch(base, { chat: String(i + 1), req: mkReq({ stayMax: 7 + i }) });
    let historyReads = 0;
    const killing = new Proxy(base, {
      get(target, prop, recv) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("WITH recent AS") && ++historyReads === 6) throw new Error("exceeded CPU");
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop, recv) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    await runWatchChecks(runDeps(killing).deps);
    const done = await rows(base, "SELECT id FROM watches WHERE last_checked_at IS NOT NULL");
    expect(done.length).toBeGreaterThanOrEqual(WRITE_FLUSH_EVERY);
  });

  it("identical watches are priced once per run", async () => {
    const base = createTestD1();
    const { db, counter } = countingDb(base);
    await createRepo(base).savePrices([mkOffer()]);
    for (let i = 0; i < 5; i++) await seedWatch(base, { chat: String(i + 1) });
    const res = await runWatchChecks(runDeps(db).deps);
    expect(res.checked).toBe(5);
    expect(counter.n).toBeLessThanOrEqual(1 + 1 + 1 + 1 + 2); // housekeeping, select, history, deal history, two flushes (4 + 1)
  });

  it("a blocked bot forgets the chat's watches; a failed send is not retried and not recorded as sent", async () => {
    const db = createTestD1();
    await seedWatch(db, { threshold: 5000, chat: "42" });
    await seedWatch(db, { threshold: 5000, chat: "42", req: mkReq({ stayMax: 8 }) });
    await createRepo(db).savePrices([mkOffer()]);
    const r = runDeps(db);
    r.setStatus(403);
    expect(await runWatchChecks(r.deps)).toMatchObject({ alerts: 0, failedSends: 1 });
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
    expect(await rows(db, "SELECT id FROM watches")).toEqual([]);

    const db2 = createTestD1();
    await seedWatch(db2, { threshold: 5000 });
    await createRepo(db2).savePrices([mkOffer()]);
    const r2 = runDeps(db2);
    r2.setStatus(500);
    expect(await runWatchChecks(r2.deps)).toMatchObject({ alerts: 0, failedSends: 1 });
    expect(r2.fetchFn).toHaveBeenCalledTimes(1);
    expect(await rows(db2, "SELECT id FROM alerts")).toEqual([]);
    expect((await rows<{ last_alert_at: string }>(db2, "SELECT last_alert_at FROM watches"))[0]?.last_alert_at).toBe(NOW.toISOString());
  });

  it("a chat blocked after an earlier alert of the same run does not roll back the run's writes", async () => {
    const db = createTestD1();
    await seedWatch(db, { threshold: 5000, chat: "42" });
    await seedWatch(db, { threshold: 5000, chat: "42", req: mkReq({ stayMax: 8 }) });
    const other = await seedWatch(db, { threshold: 5000, chat: "77", req: mkReq({ stayMax: 9 }) });
    await createRepo(db).savePrices([mkOffer()]);
    const statuses = [200, 403, 200];
    const fetchFn = vi.fn(async () => new Response("{}", { status: statuses.shift() ?? 500 }));
    const res = await runWatchChecks(runDeps(db, { fetchFn: fetchFn as unknown as typeof fetch }).deps);
    expect(res).toMatchObject({ alerts: 2, failedSends: 1 });
    expect(await rows(db, "SELECT id, last_checked_at FROM watches")).toEqual([{ id: other, last_checked_at: NOW.toISOString() }]);
    expect(await rows(db, "SELECT watch_id FROM alerts")).toEqual([{ watch_id: other }]);
  });

  it("history rows of a stay the watch cannot use are not even read", async () => {
    const db = createTestD1();
    const short = Array.from({ length: 300 }, (_, i) => mkOffer({ departDate: "2026-11-12", returnDate: "2026-11-14", priceAmount: 50 + i })); // 2 nights
    await createRepo(db).savePrices([...short, mkOffer({ priceAmount: 120 })]);
    const got = await loadWatchHistory(db, mkReq(), NOW);
    expect(got.map((o) => o.priceAmount)).toEqual([120]);
  });

  it("never throws: no FX, a broken database, a damaged row", async () => {
    const db = createTestD1();
    await seedWatch(db, { threshold: 5000 });
    await createRepo(db).savePrices([mkOffer()]);
    expect(await runWatchChecks(runDeps(db, { fx: async () => { throw new Error("no fx"); } }).deps)).toMatchObject({ checked: 0 });
    const broken = { prepare: () => { throw new Error("D1 down"); }, batch: () => { throw new Error("D1 down"); } } as unknown as D1Database;
    await expect(runWatchChecks(runDeps(broken).deps)).resolves.toMatchObject({ housekeeping: false });
    const db3 = createTestD1();
    const id = await seedWatch(db3);
    await db3.prepare("UPDATE watches SET request_json = '{broken' WHERE id = ?").bind(id).run();
    expect(await runWatchChecks(runDeps(db3).deps)).toMatchObject({ retired: 1 });
    expect(await rows(db3, "SELECT id FROM watches")).toEqual([]);
  });

  it("SubrequestBudget never goes below zero", () => {
    const b = new SubrequestBudget(3);
    expect(b.take(2)).toBe(true);
    expect(b.take(2)).toBe(false);
    expect(b.remaining).toBe(1);
    expect(b.has(1)).toBe(true);
  });
});

describe("wiring", () => {
  it("wrangler.toml schedules the price-alert cron the handler listens for, and documents the Telegram settings without values", () => {
    const toml = readFileSync(join(__dirname, "..", "wrangler.toml"), "utf8");
    const index = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");
    const cron = /const WATCH_CRON = "([^"]+)"/.exec(index)?.[1];
    expect(cron).toBeTruthy();
    expect(toml).toContain(`"${cron}"`);
    for (const name of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_USERNAME"]) {
      expect(toml).toContain(name);
      expect(readFileSync(join(__dirname, "..", ".dev.vars.example"), "utf8")).toMatch(new RegExp(`^${name}=$`, "m"));
    }
    const crons = /crons = \[([^\]]*)\]/.exec(toml)?.[1]?.split(",") ?? [];
    expect(crons.length).toBeLessThanOrEqual(5); // Workers Free: 5 cron triggers
  });

  it("the watch cron runs the check through the entry module (and sends nothing without a channel)", async () => {
    const env = makeEnv({ TELEGRAM_BOT_TOKEN: undefined });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as unknown as ExecutionContext;
    await seedWatch(env.DB, { expires: new Date(NOW.getTime() - HOUR).toISOString() });
    await worker.scheduled({ scheduledTime: NOW.getTime(), cron: "29 * * * *", noRetry() {} } as ScheduledController, env, ctx);
    await Promise.all(pending);
    expect(await rows(env, "SELECT active FROM watches")).toEqual([{ active: 0 }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
