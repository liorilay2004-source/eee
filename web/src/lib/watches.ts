/**
 * Price alerts (POST/GET/DELETE /api/watches): the alert rules form, the token kept on this device, and the error copy.
 * Pure (storage is passed in), unit tested in watches.test.ts.
 *
 * The token is the only proof of ownership. It is kept in localStorage only: never in a page URL, never in the shared
 * search link. (The Telegram deep link carries it once, by design: that is how the bot links the chat.)
 */
import type { SearchRequest, WatchView } from "../api/contract";
import { formatShortDate } from "./search";
import { GENERIC_NOTICE, commonNotice, type ApiFailure, type FailureNotice } from "./failure";
import { nightsText, placeLabel, waitText } from "./builder";
import scoring from "../../../config/scoring.json";

/** The Worker's drop rule when the user sets neither a target nor a drop (config/scoring.json default_drop_pct). */
export const DEFAULT_DROP_PCT: number = scoring.default_drop_pct;

export const WATCH_STORAGE_KEY = "eee.watches.v1";
export const MAX_STORED_WATCHES = 10;
export const TARGET_MIN_ILS = 50;
export const TARGET_MAX_ILS = 200_000;
export const DROP_MIN_PCT = 1;
export const DROP_MAX_PCT = 90;
/** Worker: at most this many active alerts per user. */
export const WATCH_MAX_PER_CLIENT = 3;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const isWatchToken = (t: unknown): t is string => typeof t === "string" && TOKEN_RE.test(t);

export interface StoredWatch {
  token: string;
  /** When it was saved on this device (ISO). */
  savedAt: string;
  /** Hebrew route line for the list, e.g. "תל אביב – אתונה". */
  label: string;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** localStorage, or null where it is unavailable (private mode, blocked site data, tests): then nothing is kept. */
function defaultStore(): Store | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadStoredWatches(store: Store | null = defaultStore()): StoredWatch[] {
  if (!store) return [];
  try {
    const raw: unknown = JSON.parse(store.getItem(WATCH_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: StoredWatch[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const { token, savedAt, label } = item as Record<string, unknown>;
      if (!isWatchToken(token) || seen.has(token)) continue;
      seen.add(token);
      out.push({
        token,
        savedAt: typeof savedAt === "string" && Number.isFinite(Date.parse(savedAt)) ? savedAt : new Date(0).toISOString(),
        label: typeof label === "string" ? label.slice(0, 80) : "",
      });
    }
    return out.slice(0, MAX_STORED_WATCHES);
  } catch { return []; }
}

function write(list: StoredWatch[], store: Store | null): boolean {
  if (!store) return false;
  try {
    if (list.length) store.setItem(WATCH_STORAGE_KEY, JSON.stringify(list));
    else store.removeItem(WATCH_STORAGE_KEY);
    return true;
  } catch { return false; }
}

/** Newest first; returns false when the device could not keep it (the user is told to keep the Telegram link). */
export function addStoredWatch(entry: StoredWatch, store: Store | null = defaultStore()): boolean {
  if (!isWatchToken(entry.token)) return false;
  const list = [entry, ...loadStoredWatches(store).filter((w) => w.token !== entry.token)].slice(0, MAX_STORED_WATCHES);
  return write(list, store);
}

export function removeStoredWatch(token: string, store: Store | null = defaultStore()): StoredWatch[] {
  const list = loadStoredWatches(store).filter((w) => w.token !== token);
  write(list, store);
  return list;
}

export const DROP_CHOICES: readonly { value: number | null; label: string }[] = [
  { value: null, label: "אוטומטי" },
  { value: 5, label: "5%" },
  { value: 10, label: "10%" },
  { value: 20, label: "20%" },
];

export type AlertRules = { targetPriceIls?: number; dropPct?: number };

/**
 * The optional rules as the API takes them. Without either, the Worker applies its default drop rule. The target is for
 * the whole party, in shekels, like the prices on the cards.
 */
export function parseAlertRules(targetText: string, dropPct: number | null): { ok: true; value: AlertRules } | { ok: false; error: string } {
  const value: AlertRules = {};
  const cleaned = targetText.trim().replace(/[,₪\s]/g, "");
  if (cleaned) {
    if (!/^\d+$/.test(cleaned)) return { ok: false, error: "מחיר יעד הוא מספר שלם של שקלים." };
    const n = Number(cleaned);
    if (n < TARGET_MIN_ILS || n > TARGET_MAX_ILS) return { ok: false, error: `מחיר יעד בין ₪${TARGET_MIN_ILS} ל־₪${TARGET_MAX_ILS.toLocaleString("en-US")}.` };
    value.targetPriceIls = n;
  }
  if (dropPct !== null) {
    if (!Number.isInteger(dropPct) || dropPct < DROP_MIN_PCT || dropPct > DROP_MAX_PCT) return { ok: false, error: `ירידה באחוזים בין ${DROP_MIN_PCT} ל־${DROP_MAX_PCT}.` };
    value.dropPct = dropPct;
  }
  return { ok: true, value };
}

/** What the alert will watch for, in the Worker's own terms (see parseWatchBody and alertReasons in watches.ts). */
export function rulesSummary(rules: AlertRules): string {
  const parts: string[] = [];
  if (rules.targetPriceIls !== undefined) parts.push(`המחיר הכולל יהיה ₪${rules.targetPriceIls.toLocaleString("en-US")} או פחות`);
  const drop = rules.dropPct ?? (rules.targetPriceIls !== undefined ? 0 : DEFAULT_DROP_PCT);
  if (drop > 0) parts.push(`המחיר ירד ב־${drop}% לפחות מהמחיר הראשון שנמצא`);
  parts.push("יופיע מחיר נמוך בצורה חריגה לעומת ההיסטוריה של אותם תאריכים");
  return `נשלח הודעה כש${parts.join(", או כש")}.`;
}

/** Only a real t.me start link is ever shown as a button. */
export function safeTelegramLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "t.me") return null;
    if (!/^\/[A-Za-z][A-Za-z0-9_]{3,31}$/.test(url.pathname)) return null;
    const start = url.searchParams.get("start");
    if (!start || !/^[A-Za-z0-9_-]{1,64}$/.test(start)) return null;
    return url.toString();
  } catch { return null; }
}

export function watchLabel(req: Pick<SearchRequest, "origin" | "destination">, originLabel = "", destinationLabel = ""): string {
  return `${placeLabel(req.origin, originLabel)} – ${placeLabel(req.destination, destinationLabel)}`;
}

/** "10/11 – 30/11 · 3–5 לילות". */
export function watchDatesLine(w: Pick<WatchView, "windowStart" | "windowEnd" | "stayMin" | "stayMax">): string {
  return `${formatShortDate(w.windowStart)} – ${formatShortDate(w.windowEnd)} · ${nightsText(w.stayMin, w.stayMax)}`;
}

export const WATCH_STATUS_HE: Record<WatchView["status"], string> = {
  pending: "ממתינה לחיבור לטלגרם",
  active: "פעילה",
  expired: "הסתיימה",
};

/** Errors of POST /api/watches. 503 alerts_unavailable means the Telegram channel is not configured on the server. */
export function describeCreateWatchFailure(failure: ApiFailure): FailureNotice {
  const common = commonNotice(failure);
  if (common) return common;
  if (failure.type !== "http") return GENERIC_NOTICE;
  switch (failure.code) {
    case "alerts_unavailable":
      return { title: "התראות מחירים עוד לא פעילות", body: "ערוץ ההתראות (טלגרם) עדיין לא הוגדר בשרת, ולכן אי אפשר לשמור התראה כרגע. החיפוש עצמו עובד כרגיל.", retryAfterSec: null, canRetry: false };
    case "watch_limit":
      return { title: `אפשר עד ${WATCH_MAX_PER_CLIENT} התראות פעילות`, body: "מחקו התראה קיימת בעמוד ״ההתראות שלי״ ונסו שוב.", retryAfterSec: null, canRetry: false };
    case "watch_capacity":
      return { title: "ההתראות מלאות כרגע", body: "הגענו למספר ההתראות שהשירות יכול לבדוק. נסו שוב בעוד כמה ימים.", retryAfterSec: null, canRetry: false };
    case "storage_unavailable":
      return { title: "לא הצלחנו לשמור את ההתראה", body: "האחסון שלנו לא זמין כרגע. נסו שוב בעוד כמה דקות.", retryAfterSec: null, canRetry: true };
  }
  if (failure.status === 400) {
    if (failure.fields.targetPriceIls) return { title: "בדקו את מחיר היעד", body: `מחיר יעד בין ₪${TARGET_MIN_ILS} ל־₪${TARGET_MAX_ILS.toLocaleString("en-US")}.`, retryAfterSec: null, canRetry: false };
    if (failure.fields.dropPct) return { title: "בדקו את אחוז הירידה", body: `ירידה באחוזים בין ${DROP_MIN_PCT} ל־${DROP_MAX_PCT}.`, retryAfterSec: null, canRetry: false };
    return { title: "אי אפשר לשמור את החיפוש הזה", body: "ייתכן שהתאריכים כבר עברו או שפרטי החיפוש השתנו. חפשו שוב ונסו לשמור.", retryAfterSec: null, canRetry: false };
  }
  if (failure.status === 503) return { title: "התראות מחירים לא זמינות כרגע", body: "נסו שוב בעוד כמה דקות.", retryAfterSec: null, canRetry: true };
  return GENERIC_NOTICE;
}

/** Errors of GET/DELETE /api/watches/<token>. 404 means it no longer exists on the server. */
export function describeWatchLookupFailure(failure: ApiFailure): FailureNotice & { gone: boolean } {
  if (failure.type === "http" && failure.status === 404) {
    return { title: "ההתראה לא נמצאה", body: "ייתכן שהיא נמחקה בטלגרם או שתוקפה פג. אפשר להסיר אותה מהמכשיר.", retryAfterSec: null, canRetry: false, gone: true };
  }
  const common = commonNotice(failure);
  if (common) return { ...common, gone: false };
  if (failure.type === "http" && failure.status === 503) return { title: "לא הצלחנו לבדוק את ההתראה", body: "השירות לא זמין כרגע. נסו שוב בעוד כמה דקות.", retryAfterSec: null, canRetry: true, gone: false };
  return { ...GENERIC_NOTICE, gone: false };
}

/**
 * Errors of DELETE /api/watches/<token>. The alert was NOT deleted: it still exists and, once connected, keeps sending
 * Telegram messages, so the copy says exactly that. 404 means it is already gone (nothing left to stop).
 */
export function describeWatchDeleteFailure(failure: ApiFailure): FailureNotice & { gone: boolean } {
  if (failure.type === "http" && failure.status === 404) return describeWatchLookupFailure(failure);
  // U+2066/U+2069 isolate the command as left-to-right inside the Hebrew sentence (a plain string, no markup).
  const still = "ההתראה לא נמחקה והיא עדיין קיימת: אם היא מחוברת לטלגרם, יישלחו עליה הודעות. אפשר גם לעצור אותה מהבוט עם הפקודה \u2066/stop\u2069.";
  const title = "לא הצלחנו למחוק את ההתראה";
  if (failure.type === "offline") return { title, body: `אין חיבור לאינטרנט. ${still}`, retryAfterSec: null, canRetry: true, gone: false };
  if (failure.type === "http" && (failure.status === 429 || failure.code === "rate_limited")) {
    return { title, body: `${waitText(failure.retryAfterSec)} ${still}`, retryAfterSec: failure.retryAfterSec, canRetry: true, gone: false };
  }
  if (failure.type === "http" && failure.status === 503) return { title, body: `השירות לא זמין כרגע. ${still}`, retryAfterSec: null, canRetry: true, gone: false };
  return { title, body: still, retryAfterSec: null, canRetry: true, gone: false };
}

/** The card that takes focus when `token`'s card is removed: the next one, else the previous one, else none. */
export function neighbourToken(list: readonly Pick<StoredWatch, "token">[], token: string): string | null {
  const index = list.findIndex((w) => w.token === token);
  if (index < 0) return null;
  return (list[index + 1] ?? list[index - 1])?.token ?? null;
}
