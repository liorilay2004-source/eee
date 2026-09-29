/**
 * Price alerts (SPEC §10, without accounts): a user saves a search and is told on Telegram when a good price shows up.
 *
 *   POST   /api/watches           save a search (+ optional target price and/or drop %) -> a secret token + the bot link
 *   GET    /api/watches/<token>   the watch's status
 *   DELETE /api/watches/<token>   stop it and erase it
 *   POST   /api/telegram/webhook  the bot: "/start <token>" links the chat, "/stop", "/stop_<id>", "/list", "/help"
 *
 * Ownership is the token alone (256 random bits, only its SHA-256 is stored). No account, no password, no name, no email:
 * the one contact kept is the Telegram chat id the user linked, dropped as soon as the watch stops or expires.
 *
 * Free-tier limits: at most WATCH_MAX_PER_CLIENT active watches per client, WATCH_MAX_TOTAL overall, WATCH_MAX_PER_CHAT per
 * chat; creation and reads are rate limited; a watch expires after WATCH_TTL_DAYS (earlier when its dates pass) and an
 * unlinked one after WATCH_PENDING_HOURS.
 *
 * The scheduled check (runWatchChecks, an hourly cron) takes a bounded batch of watches that were not checked for
 * WATCH_CHECK_INTERVAL_HOURS (so every watch is checked about once a day) and prices each FROM THE STORED PRICE HISTORY
 * first (the `prices` table every search and snapshot feeds). Only a watch with no recent history gets a small live scan
 * (its primary airport pair, round trips only, at most LIVE_SCAN_MAX_TP_REQUESTS requests), at most LIVE_SCANS_PER_RUN per
 * run, each one taking a unit of the global scan budget. Every D1 query and outbound request of a run is counted against
 * RUN_SUBREQUEST_BUDGET (below the 50 subrequests of a Workers Free invocation) BEFORE it is made.
 */
import { assessPrice, type DealAssessment, type PriceSnapshot } from "./deals";
import { PRICE_COLUMNS, rowToOffer, type PriceRow } from "./db";
import { applyExtrasAndFx, paxCount, round2 } from "./extras";
import { toIls } from "./money";
import { airportPairs, computeSearchKey, defaultResolver, sha256Hex } from "./pipeline";
import { clientIdentity, limiterSalt } from "./ratelimit";
import { hasTimePrefs, matchesTimes } from "./scoring";
import { SCORING } from "./scoring.config";
import { dayNumber, pairOk } from "./splits";
import { botStartLink, parseCommand, parseUpdate, sendTelegramMessage, telegramConfig, webhookReply, type TelegramConfig } from "./telegram";
import { monthsBetween, withPartySize } from "./travelpayouts";
import type { Env, FxRates, Offer, Repo, SearchRequest, TravelpayoutsClient } from "./types";
import type { Resolver } from "./airports/types";
import { parseSearchBody } from "./validate";

// --- limits (tunable, all well inside the free tiers) --------------------------------------------------------

export const WATCH_MAX_PER_CLIENT = 3;
export const WATCH_MAX_TOTAL = 500;
export const WATCH_MAX_PER_CHAT = 5;
export const WATCH_TTL_DAYS = 60;
/** A watch nobody linked to Telegram within this time is deleted (it would hold a place under the caps for nothing). */
export const WATCH_PENDING_HOURS = 48;
/** Stopped/expired rows are kept this long (GET answers "expired"), then deleted with their alerts. */
export const WATCH_EXPIRED_KEEP_DAYS = 7;
/** Creation: per client, per hour. */
export const WATCH_CREATE_LIMIT = 6;
export const WATCH_CREATE_WINDOW_SECONDS = 3600;
/** GET / DELETE by token: per client, per 10 minutes. */
export const WATCH_READ_LIMIT = 60;
export const WATCH_READ_WINDOW_SECONDS = 600;
/** Bot messages per chat per 10 minutes (beyond this the bot stays silent). */
export const TELEGRAM_CHAT_LIMIT = 20;
export const TELEGRAM_CHAT_WINDOW_SECONDS = 600;

/** A watch is due when its last check is at least this old: with the hourly job, about once a day. */
export const WATCH_CHECK_INTERVAL_HOURS = 20;
/** A watch that could not be priced (no history, no live scan left) is tried again after this long. */
export const WATCH_RETRY_HOURS = 3;
/** At most one alert per watch per this many hours. */
export const WATCH_ALERT_MIN_GAP_HOURS = 24;
/** The same price level is not announced twice: a new alert needs this much further drop below the last alerted price... */
export const WATCH_REALERT_DROP_PCT = 3;
/** ...unless the last alert is this old. */
export const WATCH_REALERT_AFTER_DAYS = 7;
/** Stored fares at most this old count as "current" for a watch (they are the fare source's cached prices anyway). */
export const WATCH_HISTORY_MAX_AGE_HOURS = 36;
/** History rows read per watch: a guard against a route with a huge history. */
export const WATCH_HISTORY_ROWS = 200;
/** The deal detector's look-back for the candidate's own date pair. */
export const WATCH_DEAL_LOOKBACK_DAYS = 60;

/** Watches taken per scheduled run (the budget below usually ends a run first). 24 runs x 25 >= WATCH_MAX_TOTAL. */
export const WATCHES_PER_RUN = 25;
/** Counted D1 queries + outbound requests per run: below the 50 subrequests of a Workers Free invocation. */
export const RUN_SUBREQUEST_BUDGET = 45;
export const LIVE_SCANS_PER_RUN = 2;
/** Round-trip requests of one live scan (months*(months+1)/2 of its window): a window of up to 3 months fits. */
export const LIVE_SCAN_MAX_TP_REQUESTS = 6;
/**
 * Worst case of getFxRates: the stored day (1), two sources (2), saving a fallback day of ~160 currencies in 50-statement
 * chunks (4), or instead the stale fallback (2).
 */
const FX_COST = 8;
/** checkRateLimit: its batch, plus the cleanup DELETE on the first hit of a window. */
const SCAN_BUDGET_COST = 2;

export const TARGET_MIN_ILS = 50;
export const TARGET_MAX_ILS = 200_000;
export const DROP_MIN_PCT = 1;
export const DROP_MAX_PCT = 90;

/** The placeholder owner row of every anonymous watch (migration 0005). */
export const ANON_USER_EMAIL = "anonymous-watches@watches.invalid";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// --- small helpers ---------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** 32 random bytes, base64url without padding: 43 characters, valid as a t.me start parameter. */
export function newWatchToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const isWatchToken = (t: unknown): t is string => typeof t === "string" && TOKEN_RE.test(t);

/** What is stored instead of the token (domain-separated, so it is never the hash of anything else). */
export const tokenHash = (token: string): Promise<string> => sha256Hex(`watch-token|${token}`);

export class SubrequestBudget {
  constructor(private left: number) {}
  /** Takes n units if they are all there; false (and nothing taken) otherwise. */
  take(n: number): boolean {
    if (!(n >= 0) || n > this.left) return false;
    this.left -= n;
    return true;
  }
  has(n: number): boolean {
    return n <= this.left;
  }
  get remaining(): number {
    return this.left;
  }
}

// --- the watch request -------------------------------------------------------------------------------------

export interface WatchInput {
  req: SearchRequest;
  targetPriceIls: number | null;
  /** 0 = no drop rule. */
  dropPct: number;
}

export type WatchParse = { ok: true; value: WatchInput } | { ok: false; code: string; fields: Record<string, string> };

/**
 * The body of POST /api/watches: exactly the body of POST /api/search (same validation) plus
 * `targetPriceIls` (whole party, ILS, same total as the cards show) and `dropPct` (percent below the first price seen).
 * Without either, the drop rule uses the default of config/scoring.json (default_drop_pct).
 */
export function parseWatchBody(body: unknown, deps: { resolver: Resolver; now: Date }): WatchParse {
  const parsed = parseSearchBody(body, deps);
  const fields: Record<string, string> = parsed.ok ? {} : { ...parsed.fields };
  const rec = isRecord(body) ? body : {};
  const own = (k: string): unknown => (Object.hasOwn(rec, k) ? rec[k] : undefined);

  let target: number | null = null;
  const rawTarget = own("targetPriceIls");
  if (rawTarget !== undefined && rawTarget !== null) {
    if (typeof rawTarget !== "number" || !Number.isFinite(rawTarget)) fields.targetPriceIls = "must be a number";
    else if (rawTarget < TARGET_MIN_ILS || rawTarget > TARGET_MAX_ILS) fields.targetPriceIls = `must be between ${TARGET_MIN_ILS} and ${TARGET_MAX_ILS}`;
    else target = round2(rawTarget);
  }
  let drop: number | null = null;
  const rawDrop = own("dropPct");
  if (rawDrop !== undefined && rawDrop !== null) {
    if (typeof rawDrop !== "number" || !Number.isInteger(rawDrop)) fields.dropPct = "must be an integer";
    else if (rawDrop < DROP_MIN_PCT || rawDrop > DROP_MAX_PCT) fields.dropPct = `must be between ${DROP_MIN_PCT} and ${DROP_MAX_PCT}`;
    else drop = rawDrop;
  }
  if (!parsed.ok || Object.keys(fields).length > 0) {
    return { ok: false, code: parsed.ok ? "invalid_request" : parsed.code, fields };
  }
  // A target alone means "tell me below this price", not "and also on any 10 % dip".
  const dropPct = drop ?? (target !== null ? 0 : SCORING.defaultDropPct);
  return { ok: true, value: { req: parsed.req, targetPriceIls: target, dropPct } };
}

/** A stored request_json back to a SearchRequest, or null when the row is damaged (such a watch is retired). */
export function parseStoredRequest(text: unknown): SearchRequest | null {
  if (typeof text !== "string") return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(v)) return null;
  const str = (k: string) => typeof v[k] === "string";
  const int = (k: string) => typeof v[k] === "number" && Number.isInteger(v[k]);
  const hours = (k: string) => v[k] === null || (Array.isArray(v[k]) && (v[k] as unknown[]).length === 2 && (v[k] as unknown[]).every((h) => typeof h === "number" && Number.isInteger(h)));
  if (!["origin", "destination", "windowStart", "windowEnd", "cabin"].every(str)) return null;
  if (!["stayMin", "stayMax", "adults", "children", "infants"].every(int)) return null;
  if (typeof v.checkedBag !== "boolean" || typeof v.nearbyAirports !== "boolean") return null;
  if (!hours("outHours") || !hours("retHours")) return null;
  if (!(v.maxStops === null || int("maxStops"))) return null;
  if (dayNumber(v.windowStart as string) === null || dayNumber(v.windowEnd as string) === null) return null;
  if ((v.adults as number) < 1) return null;
  return v as unknown as SearchRequest;
}

/** Expiry: WATCH_TTL_DAYS from now, or the day after the last possible departure, whichever is first. */
export function watchExpiry(req: SearchRequest, now: Date): string {
  const lastDepart = dayNumber(req.windowEnd);
  const byTtl = now.getTime() + WATCH_TTL_DAYS * DAY_MS;
  const byDates = lastDepart === null ? byTtl : (lastDepart - req.stayMin + 1) * DAY_MS;
  return iso(Math.min(byTtl, byDates));
}

// --- Hebrew text ---------------------------------------------------------------------------------------------

export const formatIls = (n: number): string => `₪${Math.round(n).toLocaleString("en-US")}`;

/** "2026-11-10" -> "10.11.2026". */
export function formatDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : isoDate;
}

function placeName(resolver: Resolver, code: string): string {
  try {
    return resolver.cityNameHe(code) ?? resolver.cityNameEn(code) ?? code;
  } catch {
    return code;
  }
}

const partyText = (pax: number): string => (pax === 1 ? "לנוסע אחד" : `ל-${pax} נוסעים`);

export function routeText(req: SearchRequest, resolver: Resolver = defaultResolver): string {
  return `${placeName(resolver, req.origin)} ⇄ ${placeName(resolver, req.destination)}`;
}

function rulesText(target: number | null, dropPct: number): string {
  const parts: string[] = [];
  if (target !== null) parts.push(`מחיר של ${formatIls(target)} או פחות`);
  if (dropPct > 0) parts.push(`ירידה של ${dropPct}% לפחות מהמחיר הראשון שנמצא`);
  parts.push("מחיר חריג לעומת ההיסטוריה של אותם תאריכים");
  return parts.join(", או ");
}

export function watchSummaryText(req: SearchRequest, resolver: Resolver = defaultResolver): string {
  const stay = req.stayMin === req.stayMax ? `${req.stayMin} לילות` : `${req.stayMin}–${req.stayMax} לילות`;
  return `${routeText(req, resolver)}, ${formatDate(req.windowStart)}–${formatDate(req.windowEnd)}, ${stay}, ${partyText(paxCount(req))}${req.checkedBag ? ", עם מזוודה" : ""}`;
}

const STOP_HINT = (id: number): string => `🛑 להפסקת ההתראה הזו: /stop_${id}\nלהפסקת כל ההתראות ומחיקתן: /stop`;

export const HELP_TEXT =
  "שלום! כאן מקבלים התראות על מחירי טיסות שביקשת לעקוב אחריהם.\n" +
  "כדי להתחיל, שומרים חיפוש באתר ולוחצים על הקישור לטלגרם שמופיע שם.\n\n" +
  "פקודות:\n/list – ההתראות הפעילות שלך\n/stop – הפסקה ומחיקה של כל ההתראות\n/help – העזרה הזו";

export interface AlertReason {
  kind: "target" | "drop" | "deal";
  text: string;
}

export interface AlertContent {
  watchId: number;
  req: SearchRequest;
  offer: Offer;
  reasons: AlertReason[];
  now: Date;
}

/** The alert, in Hebrew, plain text. Always says the price is cached and may change, and always ends with the stop commands. */
export function alertMessage(a: AlertContent, resolver: Resolver = defaultResolver): string {
  const { offer: o, req } = a;
  const pax = paxCount(req);
  const total = o.totalIls ?? 0;
  const nights = (dayNumber(o.returnDate) ?? 0) - (dayNumber(o.departDate) ?? 0);
  const ageH = Math.max(0, Math.round((a.now.getTime() - Date.parse(o.checkedAt)) / HOUR_MS));
  const bagUnknown = o.tags.includes("bag_fee_unknown");
  let bag = "";
  if (req.checkedBag) bag = bagUnknown ? " (מחיר המזוודה לא ידוע ולא נכלל)" : o.includes.checkedBag ? " (מזוודה כלולה)" : " (כולל מזוודה לכל נוסע)";
  const party = { adults: req.adults, children: req.children, infants: req.infants };
  const link = (l: string | null | undefined): string | null => {
    try {
      return withPartySize(l ?? null, party);
    } catch {
      return l ?? null;
    }
  };
  const lines = [
    "🔔 מחיר טוב לחיפוש ששמרת",
    `✈️ ${routeText(req, resolver)} (${o.origin}–${o.destination})`,
    `💰 ${formatIls(total)} סה״כ ${partyText(pax)}${bag}`,
    `📅 הלוך ${formatDate(o.departDate)} · חזור ${formatDate(o.returnDate)} (${nights} לילות)`,
    ...a.reasons.map((r) => `✅ ${r.text}`),
  ];
  if (o.ticketStructure === "split") lines.push("🎫 שני כרטיסים נפרדים (הלוך וחזור בנפרד)");
  lines.push(
    `⚠️ זה מחיר שמור מהמטמון של מקור המחירים (נבדק אצלנו לפני ${ageH === 0 ? "פחות משעה" : `${ageH} שעות`}), והוא עשוי להשתנות או להיגמר. המחיר הסופי נקבע באתר ההזמנה.`,
  );
  const out = link(o.deeplink);
  const back = o.ticketStructure === "split" ? link(o.returnDeeplink) : null;
  if (out && back) lines.push(`🔗 כרטיס הלוך: ${out}`, `🔗 כרטיס חזור: ${back}`);
  else if (out) lines.push(`🔗 להזמנה: ${out}`);
  lines.push("", STOP_HINT(a.watchId));
  return lines.join("\n");
}

// --- pricing a watch from stored fares ---------------------------------------------------------------------

const flightKey = (o: Offer): string =>
  JSON.stringify([o.origin, o.destination, o.departDate, o.returnDate, o.source, o.ticketStructure, o.outbound.departTime, o.inbound.departTime]);

/**
 * The cheapest fare for the watch, priced like a card (whole party, extras, ILS). `offers` are per passenger (history rows,
 * or a live scan's per-adult fares). Only the newest row of each flight counts (an older, cheaper row of the same flight is
 * a price that is gone). With hour windows or max stops set, only fares that verifiably fit them count, like the 🎯 card.
 */
export function cheapestForWatch(offers: Offer[], req: SearchRequest, fx: FxRates): Offer | null {
  const pax = paxCount(req);
  const newest = new Map<string, Offer>();
  for (const o of offers) {
    if (!pairOk(req, o.departDate, o.returnDate)) continue;
    const k = flightKey(o);
    const cur = newest.get(k);
    if (!cur || Date.parse(o.checkedAt) > Date.parse(cur.checkedAt)) newest.set(k, o);
  }
  const priced = [...newest.values()].map((o) => ({
    ...o,
    outbound: { ...o.outbound, airlines: [...o.outbound.airlines] },
    inbound: { ...o.inbound, airlines: [...o.inbound.airlines] },
    includes: { ...o.includes },
    priceAmount: round2(o.priceAmount * pax),
    extrasAmountIls: 0,
    totalIls: null,
    tags: [],
  }));
  applyExtrasAndFx(priced, req, fx);
  const strict = hasTimePrefs(req) || req.maxStops !== null;
  let best: Offer | null = null;
  for (const o of priced) {
    if (o.totalIls === null || !(o.totalIls > 0)) continue;
    if (strict && !matchesTimes(o, req)) continue;
    if (!best || (o.totalIls as number) < (best.totalIls as number)) best = o;
  }
  return best;
}

/** Stored fares of the watch's airport pairs, checked within WATCH_HISTORY_MAX_AGE_HOURS. One query. */
export async function loadWatchHistory(db: D1Database, req: SearchRequest, now: Date, resolver: Resolver = defaultResolver): Promise<Offer[]> {
  const pairs = airportPairs(resolver, req);
  if (pairs.length === 0) return [];
  const origins = [...new Set(pairs.map((p) => p.origin))];
  const dests = [...new Set(pairs.map((p) => p.dest))];
  const wanted = new Set(pairs.map((p) => `${p.origin}|${p.dest}`));
  const cutoff = iso(now.getTime() - WATCH_HISTORY_MAX_AGE_HOURS * HOUR_MS);
  const sql =
    `SELECT ${PRICE_COLUMNS} FROM prices INDEXED BY idx_prices_recent ` +
    `WHERE origin IN (${origins.map(() => "?").join(", ")}) AND destination IN (${dests.map(() => "?").join(", ")}) ` +
    "AND checked_at > ? AND depart_date >= ? AND return_date <= ? " +
    // The stay length in SQL, so the row cap is spent on trips the watch can use (and less JSON is parsed: 10 ms of CPU).
    "AND julianday(return_date) - julianday(depart_date) BETWEEN ? AND ? " +
    "ORDER BY checked_at DESC, id DESC LIMIT ?";
  const { results } = await db
    .prepare(sql)
    .bind(...origins, ...dests, cutoff, req.windowStart, req.windowEnd, req.stayMin, req.stayMax, WATCH_HISTORY_ROWS)
    .all<PriceRow>();
  const out: Offer[] = [];
  for (const row of results) {
    if (!wanted.has(`${row.origin}|${row.destination}`)) continue;
    const o = rowToOffer(row);
    if (o) out.push(o);
  }
  return out;
}

/** deals.ts verdict for the candidate against the history of its own date pair (per passenger, base fare, ILS). One query. */
export async function assessWatchDeal(db: D1Database, best: Offer, req: SearchRequest, fx: FxRates, now: Date): Promise<DealAssessment | null> {
  const pax = paxCount(req);
  let candidateIls: number;
  try {
    candidateIls = toIls(fx, best.priceAmount / pax, best.priceCurrency);
  } catch {
    return null;
  }
  const { results } = await db
    .prepare(
      "SELECT price_amount, price_currency, checked_at FROM prices WHERE origin = ? AND destination = ? AND depart_date = ? AND return_date = ? " +
        "AND ticket_structure = ? AND checked_at > ? ORDER BY checked_at DESC LIMIT 300",
    )
    .bind(best.origin, best.destination, best.departDate, best.returnDate, best.ticketStructure, iso(now.getTime() - WATCH_DEAL_LOOKBACK_DAYS * DAY_MS))
    .all<{ price_amount: number; price_currency: string; checked_at: string }>();
  const history: PriceSnapshot[] = [];
  for (const r of results) {
    try {
      const v = toIls(fx, r.price_amount, r.price_currency);
      if (Number.isFinite(v) && v > 0) history.push({ priceIls: v, checkedAt: r.checked_at });
    } catch {
      // a currency without a rate is skipped, never guessed
    }
  }
  return assessPrice(history, { priceIls: candidateIls, checkedAt: best.checkedAt });
}

// --- the decision ------------------------------------------------------------------------------------------

export interface WatchState {
  thresholdIls: number | null;
  dropPct: number;
  baselineIls: number | null;
  lastAlertAt: string | null;
  lastAlertIls: number | null;
}

/**
 * Why this price is worth a message (empty = not). Rules, any of which is enough: at or below the target; at least dropPct
 * below the first price the watch saw (the baseline); deals.ts calls it a deal or an error fare. Then the anti-spam rules:
 * at most one alert per WATCH_ALERT_MIN_GAP_HOURS, and the same price level is not announced again (a new alert needs a
 * further WATCH_REALERT_DROP_PCT below the last alerted price, unless that alert is WATCH_REALERT_AFTER_DAYS old).
 */
export function alertReasons(priceIls: number, state: WatchState, deal: DealAssessment | null, now: Date): AlertReason[] {
  const reasons: AlertReason[] = [];
  if (state.thresholdIls !== null && priceIls <= state.thresholdIls) {
    reasons.push({ kind: "target", text: `במחיר היעד שלך או מתחתיו (${formatIls(state.thresholdIls)})` });
  }
  if (state.dropPct > 0 && state.baselineIls !== null && state.baselineIls > 0) {
    const drop = ((state.baselineIls - priceIls) / state.baselineIls) * 100;
    if (drop + 1e-9 >= state.dropPct) {
      reasons.push({ kind: "drop", text: `ירד ב-${Math.floor(drop)}% מאז שהתחלנו לעקוב (היה ${formatIls(state.baselineIls)})` });
    }
  }
  if (deal && (deal.verdict === "deal" || deal.verdict === "error_fare")) {
    const pct = Math.floor(deal.dropPct);
    reasons.push({
      kind: "deal",
      text:
        deal.verdict === "error_fare"
          ? `נמוך ב-${pct}% מהמחיר הרגיל לתאריכים האלה: ייתכן שזו טעות תמחור, כדאי למהר ולבדוק`
          : `נמוך ב-${pct}% מהמחיר הרגיל לתאריכים האלה`,
    });
  }
  if (reasons.length === 0) return [];
  const lastMs = state.lastAlertAt === null ? NaN : Date.parse(state.lastAlertAt);
  if (Number.isFinite(lastMs)) {
    if (now.getTime() - lastMs < WATCH_ALERT_MIN_GAP_HOURS * HOUR_MS) return [];
    const old = now.getTime() - lastMs >= WATCH_REALERT_AFTER_DAYS * DAY_MS;
    if (!old && state.lastAlertIls !== null && !(priceIls < state.lastAlertIls * (1 - WATCH_REALERT_DROP_PCT / 100))) return [];
  }
  return reasons;
}

// --- storage ---------------------------------------------------------------------------------------------

export interface WatchRow {
  id: number;
  search_key: string;
  threshold_ils: number | null;
  drop_pct: number;
  active: number;
  expires_at: string;
  last_price_amount: number | null;
  last_price_currency: string | null;
  last_alert_at: string | null;
  request_json: string;
  created_at: string | null;
  telegram_chat_id: string | null;
  last_checked_at: string | null;
  baseline_ils: number | null;
  last_alert_ils: number | null;
}

const WATCH_COLUMNS =
  "id, search_key, threshold_ils, drop_pct, active, expires_at, last_price_amount, last_price_currency, last_alert_at, " +
  "request_json, created_at, telegram_chat_id, last_checked_at, baseline_ils, last_alert_ils";

export interface WatchView {
  status: "pending" | "active" | "expired";
  telegramLinked: boolean;
  origin: string;
  destination: string;
  windowStart: string;
  windowEnd: string;
  stayMin: number;
  stayMax: number;
  adults: number;
  children: number;
  infants: number;
  checkedBag: boolean;
  targetPriceIls: number | null;
  dropPct: number;
  createdAt: string | null;
  expiresAt: string;
  lastCheckedAt: string | null;
  lastPriceIls: number | null;
  baselinePriceIls: number | null;
  lastAlertAt: string | null;
}

export function watchView(row: WatchRow, req: SearchRequest, now: Date): WatchView {
  const live = row.active === 1 && Date.parse(row.expires_at) > now.getTime();
  return {
    status: !live ? "expired" : row.telegram_chat_id === null ? "pending" : "active",
    telegramLinked: row.telegram_chat_id !== null,
    origin: req.origin,
    destination: req.destination,
    windowStart: req.windowStart,
    windowEnd: req.windowEnd,
    stayMin: req.stayMin,
    stayMax: req.stayMax,
    adults: req.adults,
    children: req.children,
    infants: req.infants,
    checkedBag: req.checkedBag,
    targetPriceIls: row.threshold_ils,
    dropPct: row.drop_pct,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastCheckedAt: row.last_checked_at,
    lastPriceIls: row.last_price_currency === "ILS" ? row.last_price_amount : null,
    baselinePriceIls: row.baseline_ils,
    lastAlertAt: row.last_alert_at,
  };
}

export type InsertOutcome = { ok: true; id: number } | { ok: false; reason: "client_limit" | "total_limit" | "storage" };

/**
 * One atomic INSERT ... SELECT ... WHERE: the caps are checked in the same statement that writes, so concurrent requests
 * cannot pass them together.
 */
export async function insertWatch(
  db: D1Database,
  w: { input: WatchInput; searchKey: string; tokenHash: string; clientHash: string; now: Date; expiresAt: string },
): Promise<InsertOutcome> {
  const nowIso = w.now.toISOString();
  const res = await db
    .prepare(
      "INSERT INTO watches (user_id, search_key, threshold_ils, drop_pct, active, expires_at, token_hash, request_json, client_hash, created_at) " +
        "SELECT (SELECT id FROM users WHERE email = ?), ?, ?, ?, 1, ?, ?, ?, ?, ? " +
        "WHERE EXISTS (SELECT 1 FROM users WHERE email = ?) " +
        "AND (SELECT COUNT(*) FROM watches WHERE client_hash = ? AND active = 1 AND expires_at > ?) < ? " +
        "AND (SELECT COUNT(*) FROM watches WHERE active = 1 AND expires_at > ?) < ? " +
        "RETURNING id",
    )
    .bind(
      ANON_USER_EMAIL, w.searchKey, w.input.targetPriceIls, w.input.dropPct, w.expiresAt, w.tokenHash, JSON.stringify(w.input.req), w.clientHash, nowIso,
      ANON_USER_EMAIL, w.clientHash, nowIso, WATCH_MAX_PER_CLIENT, nowIso, WATCH_MAX_TOTAL,
    )
    .all<{ id: number }>();
  const id = res.results[0]?.id;
  if (typeof id === "number") return { ok: true, id };
  const row = await db
    .prepare("SELECT (SELECT COUNT(*) FROM watches WHERE client_hash = ? AND active = 1 AND expires_at > ?) AS mine, (SELECT COUNT(*) FROM users WHERE email = ?) AS anon")
    .bind(w.clientHash, nowIso, ANON_USER_EMAIL)
    .first<{ mine: number; anon: number }>();
  if (!row || row.anon === 0) return { ok: false, reason: "storage" }; // migration 0005 not applied
  return { ok: false, reason: row.mine >= WATCH_MAX_PER_CLIENT ? "client_limit" : "total_limit" };
}

export async function findWatchByToken(db: D1Database, token: string): Promise<WatchRow | null> {
  return db.prepare(`SELECT ${WATCH_COLUMNS} FROM watches WHERE token_hash = ?`).bind(await tokenHash(token)).first<WatchRow>();
}

// --- HTTP handlers (index.ts wires them) --------------------------------------------------------------------

export interface ApiResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const err = (status: number, code: string, message: string, extra: { fields?: Record<string, string>; retryAfterSec?: number } = {}): ApiResult => ({
  status,
  body: { error: { code, message, ...(extra.fields ? { fields: extra.fields } : {}), ...(extra.retryAfterSec !== undefined ? { retryAfterSec: extra.retryAfterSec } : {}) } },
  headers: extra.retryAfterSec !== undefined ? { "Retry-After": String(extra.retryAfterSec) } : undefined,
});

export interface WatchHttpDeps {
  env: Env;
  repo: Repo;
  now: Date;
  ip: string;
  resolver?: Resolver;
}

/** Salted hash of the client (same identity rules as the search limiter). */
async function clientKey(ip: string, env: Env): Promise<string> {
  return sha256Hex(`${clientIdentity(ip)}|${limiterSalt(env)}`);
}

/** Fail closed: a limiter that cannot count answers 503 (nothing here is urgent enough to run unmetered). */
async function limited(repo: Repo, key: string, max: number, windowSec: number, now: Date): Promise<ApiResult | null> {
  try {
    const r = await repo.checkRateLimit(key, max, windowSec, now);
    return r.allowed ? null : err(429, "rate_limited", "Too many requests, try again later", { retryAfterSec: r.retryAfterSec });
  } catch {
    return err(503, "storage_unavailable", "Price alerts are unavailable right now");
  }
}

export const alertsUnavailable = (): ApiResult => err(503, "alerts_unavailable", "Price alerts are not available right now");

/** Rate limit first (like /api/search), then the body: `readJson` is index.ts's size-capped JSON reader. */
export async function handleCreateWatch(
  deps: WatchHttpDeps,
  readJson: () => Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }>,
): Promise<ApiResult> {
  const { env, repo, now } = deps;
  const tg = telegramConfig(env);
  if (!tg) return alertsUnavailable();
  const client = await clientKey(deps.ip, env);
  const rl = await limited(repo, `watch-create:${client}`, WATCH_CREATE_LIMIT, WATCH_CREATE_WINDOW_SECONDS, now);
  if (rl) return rl;
  const body = await readJson();
  if (!body.ok) return body.result;
  const parsed = parseWatchBody(body.value, { resolver: deps.resolver ?? defaultResolver, now });
  if (!parsed.ok) return err(400, parsed.code, "The watch request is invalid", { fields: parsed.fields });

  const token = newWatchToken();
  const expiresAt = watchExpiry(parsed.value.req, now);
  let outcome: InsertOutcome;
  try {
    outcome = await insertWatch(env.DB, {
      input: parsed.value,
      searchKey: await computeSearchKey(parsed.value.req),
      tokenHash: await tokenHash(token),
      clientHash: client,
      now,
      expiresAt,
    });
  } catch {
    outcome = { ok: false, reason: "storage" };
  }
  if (!outcome.ok) {
    if (outcome.reason === "client_limit") return err(409, "watch_limit", `At most ${WATCH_MAX_PER_CLIENT} active price alerts per user`);
    if (outcome.reason === "total_limit") return err(503, "watch_capacity", "Price alerts are full right now, try again later");
    return err(503, "storage_unavailable", "Price alerts are unavailable right now");
  }
  const row: WatchRow = {
    id: outcome.id, search_key: "", threshold_ils: parsed.value.targetPriceIls, drop_pct: parsed.value.dropPct, active: 1, expires_at: expiresAt,
    last_price_amount: null, last_price_currency: null, last_alert_at: null, request_json: "", created_at: now.toISOString(),
    telegram_chat_id: null, last_checked_at: null, baseline_ils: null, last_alert_ils: null,
  };
  return {
    status: 201,
    body: {
      token,
      telegramLink: botStartLink(tg.botUsername, token),
      watch: watchView(row, parsed.value.req, now),
    },
  };
}

export async function handleWatchByToken(deps: WatchHttpDeps, method: "GET" | "DELETE", token: string): Promise<ApiResult> {
  const { env, repo, now } = deps;
  const rl = await limited(repo, `watch-read:${await clientKey(deps.ip, env)}`, WATCH_READ_LIMIT, WATCH_READ_WINDOW_SECONDS, now);
  if (rl) return rl;
  const notFound = err(404, "not_found", "No such price alert");
  if (!isWatchToken(token)) return notFound;
  try {
    if (method === "DELETE") {
      const res = await env.DB.prepare("DELETE FROM watches WHERE token_hash = ?").bind(await tokenHash(token)).run();
      return (res.meta.changes ?? 0) > 0 ? { status: 200, body: { deleted: true } } : notFound;
    }
    const row = await findWatchByToken(env.DB, token);
    const req = row ? parseStoredRequest(row.request_json) : null;
    if (!row || !req) return notFound;
    const view = watchView(row, req, now);
    const tg = telegramConfig(env);
    return { status: 200, body: { watch: view, ...(view.status === "pending" && tg ? { telegramLink: botStartLink(tg.botUsername, token) } : {}) } };
  } catch {
    return err(503, "storage_unavailable", "Price alerts are unavailable right now");
  }
}

// --- the bot --------------------------------------------------------------------------------------------------

export interface BotDeps {
  env: Env;
  repo: Repo;
  now: Date;
  resolver?: Resolver;
}

/**
 * One webhook update -> the reply (as a webhook response body) or null for silence. The caller has verified the secret
 * header. Errors never propagate: Telegram would re-deliver the update again and again.
 */
export async function handleBotUpdate(update: unknown, deps: BotDeps): Promise<Record<string, unknown> | null> {
  const msg = parseUpdate(update);
  if (!msg) return null;
  const { env, repo, now } = deps;
  const resolver = deps.resolver ?? defaultResolver;
  const db = env.DB;
  try {
    const rl = await repo.checkRateLimit(`tg-chat:${await sha256Hex(`${msg.chatId}|${limiterSalt(env)}`)}`, TELEGRAM_CHAT_LIMIT, TELEGRAM_CHAT_WINDOW_SECONDS, now);
    if (!rl.allowed) return null;
  } catch {
    return null; // fail closed: no counting, no answering
  }
  const reply = (text: string) => webhookReply(msg.chatId, text);
  const cmd = parseCommand(msg.text);
  try {
    if (cmd?.name === "start" && cmd.arg !== "") return reply(await linkChat(db, msg.chatId, cmd.arg, now, resolver));
    if (cmd?.name === "stop") {
      const res = await db.prepare("DELETE FROM watches WHERE telegram_chat_id = ?").bind(msg.chatId).run();
      const n = res.meta.changes ?? 0;
      return reply(n > 0 ? `🛑 הפסקנו ומחקנו את כל ההתראות שלך (${n}). לא יישלחו יותר הודעות.` : "אין לך התראות פעילות.");
    }
    const one = cmd ? /^stop_(\d{1,15})$/.exec(cmd.name) : null;
    if (one) {
      const res = await db.prepare("DELETE FROM watches WHERE id = ? AND telegram_chat_id = ?").bind(Number(one[1]), msg.chatId).run();
      return reply((res.meta.changes ?? 0) > 0 ? "🛑 ההתראה הופסקה ונמחקה." : "לא מצאנו התראה כזו אצלך. לרשימה: /list");
    }
    if (cmd?.name === "list") {
      const { results } = await db
        .prepare(`SELECT ${WATCH_COLUMNS} FROM watches WHERE telegram_chat_id = ? AND active = 1 AND expires_at > ? ORDER BY id LIMIT ?`)
        .bind(msg.chatId, now.toISOString(), WATCH_MAX_PER_CHAT)
        .all<WatchRow>();
      if (results.length === 0) return reply("אין לך התראות פעילות.");
      const lines = results.map((r) => {
        const req = parseStoredRequest(r.request_json);
        const price = r.last_price_currency === "ILS" && r.last_price_amount !== null ? ` · מחיר אחרון: ${formatIls(r.last_price_amount)}` : "";
        return `• ${req ? watchSummaryText(req, resolver) : "חיפוש"}${price} · עד ${formatDate(r.expires_at.slice(0, 10))} · להפסקה: /stop_${r.id}`;
      });
      return reply(`ההתראות הפעילות שלך:\n${lines.join("\n")}\n\nלהפסקת כולן: /stop`);
    }
    return reply(HELP_TEXT);
  } catch {
    return reply("משהו השתבש אצלנו. נסו שוב בעוד כמה דקות.");
  }
}

async function linkChat(db: D1Database, chatId: string, token: string, now: Date, resolver: Resolver): Promise<string> {
  if (!isWatchToken(token)) return "הקישור לא תקין. שמרו את החיפוש שוב באתר ולחצו על הקישור החדש.";
  const hash = await tokenHash(token);
  const nowIso = now.toISOString();
  const res = await db
    .prepare(
      "UPDATE watches SET telegram_chat_id = ? WHERE token_hash = ? AND active = 1 AND expires_at > ? " +
        "AND (telegram_chat_id IS NULL OR telegram_chat_id = ?) " +
        "AND (SELECT COUNT(*) FROM watches WHERE telegram_chat_id = ? AND active = 1 AND expires_at > ? AND token_hash <> ?) < ? " +
        `RETURNING ${WATCH_COLUMNS}`,
    )
    .bind(chatId, hash, nowIso, chatId, chatId, nowIso, hash, WATCH_MAX_PER_CHAT)
    .all<WatchRow>();
  const row = res.results[0];
  if (row) {
    const req = parseStoredRequest(row.request_json);
    return [
      "✅ ההתראה הופעלה!",
      `נבדוק בערך פעם ביום את המחיר של: ${req ? watchSummaryText(req, resolver) : "החיפוש ששמרת"}.`,
      `נשלח הודעה כשיופיע ${rulesText(row.threshold_ils, row.drop_pct)}.`,
      "לכל היותר הודעה אחת ביום. המחירים הם מחירים שמורים (מטמון) ועשויים להשתנות.",
      `ההתראה תפוג ב-${formatDate(row.expires_at.slice(0, 10))}.`,
      "",
      STOP_HINT(row.id),
    ].join("\n");
  }
  const found = await db.prepare("SELECT telegram_chat_id, active, expires_at FROM watches WHERE token_hash = ?").bind(hash).first<{ telegram_chat_id: string | null; active: number; expires_at: string }>();
  if (!found) return "לא מצאנו את ההתראה (אולי נמחקה או פג תוקפה). שמרו את החיפוש שוב באתר.";
  if (found.active !== 1 || !(Date.parse(found.expires_at) > now.getTime())) return "תוקף ההתראה הזו פג. שמרו את החיפוש שוב באתר.";
  if (found.telegram_chat_id !== null && found.telegram_chat_id !== chatId) return "ההתראה הזו כבר מחוברת לחשבון טלגרם אחר.";
  return `אפשר לקבל עד ${WATCH_MAX_PER_CHAT} התראות פעילות בו-זמנית. להפסקת אחת מהן: /list`;
}

// --- the scheduled check ------------------------------------------------------------------------------------

export interface WatchRunDeps {
  db: D1Database;
  repo: Repo;
  tp: TravelpayoutsClient;
  now: Date;
  fetchFn: typeof fetch;
  /** Rates (tests) or a loader (production: getFxRates). */
  fx: FxRates | (() => Promise<FxRates>);
  telegram: TelegramConfig | null;
  /** Takes one unit of the global scan budget; false = spent (no live scan). */
  scanBudget?: () => Promise<boolean>;
  resolver?: Resolver;
  budget?: number;
}

export interface WatchRunResult {
  housekeeping: boolean;
  selected: number;
  checked: number;
  priced: number;
  liveScans: number;
  alerts: number;
  failedSends: number;
  retired: number;
  budgetLeft: number;
}

interface Pending {
  row: WatchRow;
  req: SearchRequest;
  price: number | null;
  retrySoon: boolean;
}

/** Never throws: a failing run must not stop the next one. */
export async function runWatchChecks(deps: WatchRunDeps): Promise<WatchRunResult> {
  const out: WatchRunResult = { housekeeping: false, selected: 0, checked: 0, priced: 0, liveScans: 0, alerts: 0, failedSends: 0, retired: 0, budgetLeft: 0 };
  const budget = new SubrequestBudget(deps.budget ?? RUN_SUBREQUEST_BUDGET);
  try {
    await runInner(deps, budget, out);
  } catch (e) {
    console.error("watch run failed:", e instanceof Error ? e.name : typeof e);
  }
  out.budgetLeft = budget.remaining;
  return out;
}

async function runInner(deps: WatchRunDeps, budget: SubrequestBudget, out: WatchRunResult): Promise<void> {
  const { db, now } = deps;
  const nowIso = now.toISOString();
  const resolver = deps.resolver ?? defaultResolver;

  // Housekeeping: expired watches lose their chat id at once and are deleted (with their alerts) a week later; a watch
  // nobody linked is deleted after WATCH_PENDING_HOURS.
  if (!budget.take(1)) return;
  await db.batch([
    db.prepare("UPDATE watches SET active = 0, telegram_chat_id = NULL WHERE active = 1 AND expires_at <= ?").bind(nowIso),
    db.prepare("DELETE FROM watches WHERE expires_at <= ?").bind(iso(now.getTime() - WATCH_EXPIRED_KEEP_DAYS * DAY_MS)),
    db.prepare("DELETE FROM watches WHERE telegram_chat_id IS NULL AND active = 1 AND created_at <= ?").bind(iso(now.getTime() - WATCH_PENDING_HOURS * HOUR_MS)),
  ]);
  out.housekeeping = true;
  if (!deps.telegram) return; // no channel: nothing could be delivered, so nothing is checked

  if (!budget.take(1)) return;
  const { results: due } = await db
    .prepare(
      `SELECT ${WATCH_COLUMNS} FROM watches WHERE active = 1 AND telegram_chat_id IS NOT NULL AND expires_at > ? ` +
        "AND (last_checked_at IS NULL OR last_checked_at <= ?) ORDER BY last_checked_at IS NOT NULL, last_checked_at, id LIMIT ?",
    )
    .bind(nowIso, iso(now.getTime() - WATCH_CHECK_INTERVAL_HOURS * HOUR_MS), WATCHES_PER_RUN)
    .all<WatchRow>();
  out.selected = due.length;
  if (due.length === 0) return;

  let fx: FxRates;
  if (typeof deps.fx === "function") {
    if (!budget.take(FX_COST)) return;
    try {
      fx = await deps.fx();
    } catch {
      return; // without rates nothing can be compared in ILS
    }
  } else fx = deps.fx;

  const writes: D1PreparedStatement[] = [];
  const pendingWrites = () => Math.ceil((writes.length + 2) / 50);
  const memo = new Map<string, { best: Offer | null; deal: DealAssessment | null }>();

  for (const row of due) {
    const req = parseStoredRequest(row.request_json);
    if (!req) {
      writes.push(db.prepare("DELETE FROM watches WHERE id = ?").bind(row.id));
      out.retired += 1;
      continue;
    }
    // Room for this watch's history read and for the final write of everything so far.
    if (!budget.has(1 + pendingWrites())) break;
    let found = memo.get(row.request_json);
    if (!found) {
      budget.take(1);
      let best = cheapestForWatch(await loadWatchHistory(db, req, now, resolver), req, fx);
      if (!best) best = await liveScan(deps, req, fx, budget, out, pendingWrites);
      let deal: DealAssessment | null = null;
      if (best && budget.has(1 + 3 + pendingWrites())) {
        budget.take(1);
        deal = await assessWatchDeal(db, best, req, fx, now).catch(() => null);
      }
      found = { best, deal };
      memo.set(row.request_json, found);
    }
    out.checked += 1;
    const best = found.best;
    const pending: Pending = { row, req, price: best?.totalIls ?? null, retrySoon: best === null };
    if (best && best.totalIls !== null) {
      out.priced += 1;
      const reasons = alertReasons(
        best.totalIls,
        { thresholdIls: row.threshold_ils, dropPct: row.drop_pct, baselineIls: row.baseline_ils, lastAlertAt: row.last_alert_at, lastAlertIls: row.last_alert_ils },
        found.deal,
        now,
      );
      // An alert costs a claim, a send, maybe forgetting a blocked chat; without room it waits for the next run (not marked checked).
      if (reasons.length > 0) {
        if (!budget.has(3 + pendingWrites())) continue;
        await sendAlert(deps, budget, row, req, best, reasons, writes, out);
      }
    }
    writes.push(checkedWrite(db, pending, now));
  }

  if (writes.length > 0) {
    for (let i = 0; i < writes.length; i += 50) {
      budget.take(1);
      await db.batch(writes.slice(i, i + 50));
    }
  }
}

function checkedWrite(db: D1Database, p: Pending, now: Date): D1PreparedStatement {
  // A watch that could not be priced is looked at again after WATCH_RETRY_HOURS rather than a whole day later.
  const checkedAt = p.retrySoon ? iso(now.getTime() - (WATCH_CHECK_INTERVAL_HOURS - WATCH_RETRY_HOURS) * HOUR_MS) : now.toISOString();
  if (p.price === null) return db.prepare("UPDATE watches SET last_checked_at = ? WHERE id = ?").bind(checkedAt, p.row.id);
  return db
    .prepare("UPDATE watches SET last_checked_at = ?, last_price_amount = ?, last_price_currency = 'ILS', baseline_ils = COALESCE(baseline_ils, ?) WHERE id = ?")
    .bind(checkedAt, round2(p.price), round2(p.price), p.row.id);
}

/**
 * A small live scan for a watch with no recent stored fare: the primary airport pair, round trips only, inside the global
 * scan budget and this run's subrequest budget. The fares are appended to the shared price history (the cheapest per date
 * pair, per passenger, like the pipeline's history rows), so the next check and everyone's price context profit.
 */
async function liveScan(
  deps: WatchRunDeps,
  req: SearchRequest,
  fx: FxRates,
  budget: SubrequestBudget,
  out: WatchRunResult,
  pendingWrites: () => number,
): Promise<Offer | null> {
  if (out.liveScans >= LIVE_SCANS_PER_RUN || !deps.tp.configured) return null;
  const pair = airportPairs(deps.resolver ?? defaultResolver, req)[0];
  if (!pair) return null;
  const months = monthsBetween(req.windowStart, req.windowEnd).length;
  const cost = (months * (months + 1)) / 2;
  if (cost < 1 || cost > LIVE_SCAN_MAX_TP_REQUESTS) return null;
  const save = 2; // up to 60 rows = two batches
  // The global budget check, the scan, the save; plus room left for an alert (3) and the final write.
  if (!budget.has(SCAN_BUDGET_COST + cost + save + 3 + pendingWrites())) return null;
  if (deps.scanBudget) {
    budget.take(SCAN_BUDGET_COST);
    if (!(await deps.scanBudget().catch(() => false))) return null;
  }
  budget.take(cost);
  out.liveScans += 1;
  let fares: Offer[];
  try {
    fares = await deps.tp.roundTrips(pair.origin, pair.dest, req.windowStart, req.windowEnd);
  } catch {
    return null;
  }
  const inWindow = fares.filter((o) => pairOk(req, o.departDate, o.returnDate));
  const cheapestPerPair = new Map<string, { o: Offer; ils: number }>();
  for (const o of inWindow) {
    let ils: number;
    try {
      ils = toIls(fx, o.priceAmount, o.priceCurrency);
    } catch {
      continue;
    }
    const k = `${o.departDate}|${o.returnDate}`;
    const cur = cheapestPerPair.get(k);
    if (!cur || ils < cur.ils) cheapestPerPair.set(k, { o, ils });
  }
  const rows = [...cheapestPerPair.values()].sort((a, b) => a.ils - b.ils).slice(0, 60).map((x) => x.o);
  if (rows.length > 0) {
    budget.take(save);
    await deps.repo.savePrices(rows).catch(() => undefined);
  }
  return cheapestForWatch(inWindow, req, fx);
}

async function sendAlert(
  deps: WatchRunDeps,
  budget: SubrequestBudget,
  row: WatchRow,
  req: SearchRequest,
  best: Offer,
  reasons: AlertReason[],
  writes: D1PreparedStatement[],
  out: WatchRunResult,
): Promise<void> {
  const { db, now } = deps;
  const tg = deps.telegram as TelegramConfig;
  const chatId = row.telegram_chat_id as string;
  const price = round2(best.totalIls as number);
  // Claim first, atomically: at most one alert per watch per WATCH_ALERT_MIN_GAP_HOURS even if two runs overlap.
  budget.take(1);
  const claim = await db
    .prepare(
      "UPDATE watches SET last_alert_at = ?, last_alert_ils = ? WHERE id = ? AND active = 1 AND telegram_chat_id = ? " +
        "AND (last_alert_at IS NULL OR last_alert_at <= ?) RETURNING id",
    )
    .bind(now.toISOString(), price, row.id, chatId, iso(now.getTime() - WATCH_ALERT_MIN_GAP_HOURS * HOUR_MS))
    .all<{ id: number }>();
  if (claim.results.length === 0) return;
  budget.take(1);
  const text = alertMessage({ watchId: row.id, req, offer: best, reasons, now }, deps.resolver ?? defaultResolver);
  const sent = await sendTelegramMessage(deps.fetchFn, tg.botToken, chatId, text);
  if (sent === "sent") {
    out.alerts += 1;
    writes.push(
      db
        // Guarded: a later send of this run may find the chat blocked and delete its watches, and a foreign-key error would
        // roll back the whole final batch (every watch's check state with it).
        .prepare(
          "INSERT INTO alerts (watch_id, price_amount, price_currency, sent_email, seen_in_app, created_at, sent_telegram) " +
            "SELECT ?, ?, 'ILS', 0, 0, ?, 1 WHERE EXISTS (SELECT 1 FROM watches WHERE id = ?)",
        )
        .bind(row.id, price, now.toISOString(), row.id),
    );
    return;
  }
  out.failedSends += 1;
  if (sent === "blocked") {
    // The user blocked the bot or the chat is gone: forget the chat and its watches (nothing could reach them anyway).
    budget.take(1);
    await db.prepare("DELETE FROM watches WHERE telegram_chat_id = ?").bind(chatId).run().catch(() => undefined);
  }
  // A plain failure is not retried (the claim stays): one missed alert is better than a burst of duplicates.
}
