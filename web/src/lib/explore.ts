/**
 * "לא יודע לאן?": pure logic behind the explore screen (GET /api/explore). Unit tested in explore.test.ts.
 */
import type { ExploreResult, ExploreScore, ExploreUnderstood, NightsRange } from "../api/contract";
import { parseExploreQuery } from "../../../worker/src/explore-text";
import { HEBREW_MONTHS, addDays, firstMonthOffset, nightsText, waitText } from "./builder";
import { GENERIC_NOTICE, commonNotice, hebrewOrNull, type ApiFailure, type FailureNotice } from "./failure";
import { sanitizeForm, type SearchForm } from "./search";

export const EXPLORE_ORIGINS = [
  { code: "TLV", label: "תל אביב" },
  { code: "ETM", label: "אילת" },
] as const;
export type ExploreOrigin = (typeof EXPLORE_ORIGINS)[number]["code"];

export const EXPLORE_MAX_TEXT = 200;
export const EXPLORE_MAX_BUDGET = 100_000;
export const EXPLORE_LIMIT = 20;

/** Trip-length choices; "" leaves the length to the text (or to any length). */
export const EXPLORE_NIGHTS: readonly { value: string; label: string }[] = [
  { value: "", label: "לפי הטקסט, או כל אורך" },
  { value: "2-3", label: "סופ״ש · 2–3 לילות" },
  { value: "3-5", label: "קצר · 3–5 לילות" },
  { value: "6-8", label: "שבוע · 6–8 לילות" },
  { value: "12-15", label: "שבועיים · 12–15 לילות" },
];

export interface ExploreInput {
  text: string;
  origin: ExploreOrigin;
  /** "YYYY-MM", or "" to take the month from the text. */
  month: string;
  /** "N-M", or "" (see EXPLORE_NIGHTS). */
  nights: string;
  /** Whole shekels as typed, or "". */
  maxPrice: string;
}

export type ExploreSort = "price" | "score";

export function emptyExploreInput(): ExploreInput {
  return { text: "", origin: "TLV", month: "", nights: "", maxPrice: "" };
}

export type ExploreField = "text" | "month" | "maxPrice";

/** The query string for GET /api/explore, or the fields to fix first. */
export function buildExploreParams(input: ExploreInput, sort: ExploreSort):
  | { ok: true; params: Record<string, string> }
  | { ok: false; errors: Partial<Record<ExploreField, string>> } {
  const errors: Partial<Record<ExploreField, string>> = {};
  const text = input.text.trim();
  if (text.length > EXPLORE_MAX_TEXT) errors.text = `אפשר לכתוב עד ${EXPLORE_MAX_TEXT} תווים.`;
  if (!text && !input.month) errors.month = "כתבו מתי תרצו לטוס, או בחרו חודש.";
  if (input.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) errors.month = "בחרו חודש מהרשימה.";
  const budget = input.maxPrice.trim().replace(/[,₪\s]/g, "");
  if (budget && (!/^\d+$/.test(budget) || Number(budget) < 1 || Number(budget) > EXPLORE_MAX_BUDGET)) {
    errors.maxPrice = `תקציב הוא מספר שלם של שקלים, עד ${EXPLORE_MAX_BUDGET.toLocaleString("en-US")}.`;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const params: Record<string, string> = { origin: input.origin, sort, limit: String(EXPLORE_LIMIT) };
  if (text) params.q = text;
  if (input.month) params.month = input.month;
  if (input.nights && /^\d{1,2}(-\d{1,2})?$/.test(input.nights)) params.nights = input.nights;
  if (budget) params.maxPrice = String(Number(budget));
  return { ok: true, params };
}

/** "נובמבר 2026" */
export function monthName(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  return `${HEBREW_MONTHS[Number(m[2]) - 1] ?? ""} ${m[1]}`;
}

function nightsRangeText(n: NightsRange): string {
  return nightsText(n.min, n.max);
}

/** What the server read from the text, as one Hebrew line, e.g. "3 לילות · נובמבר 2026". */
export function understoodSummary(u: Pick<ExploreUnderstood, "nights" | "month">): string {
  const parts: string[] = [];
  if (u.nights) parts.push(nightsRangeText(u.nights));
  if (u.month) parts.push(monthName(u.month));
  return parts.join(" · ");
}

/** Live preview while typing: the same parser the server uses (worker/src/explore-text.ts), run locally. */
export function previewText(text: string, now: Date): { summary: string; message: string | null } | null {
  if (!text.trim()) return null;
  const parsed = parseExploreQuery(text, now);
  return { summary: understoodSummary(parsed), message: parsed.message };
}

/** The Worker accepts a month that starts within this many days of tomorrow (worker/src/explore.ts). */
const EXPLORE_MAX_ADVANCE_DAYS = 365;

/**
 * Month choices for the explore form: this month only when enough of it is left (the same rule as the search's month
 * chips, see firstMonthOffset), then the following months, never one the Worker would refuse as too far ahead.
 */
export function exploreMonths(today: string, count = 12): { key: string; label: string }[] {
  const [y, m] = today.split("-").map(Number);
  const first = firstMonthOffset(today);
  const lastStart = addDays(today, EXPLORE_MAX_ADVANCE_DAYS);
  const out: { key: string; label: string }[] = [];
  for (let i = first; i < first + count; i += 1) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (`${key}-01` > lastStart) break;
    out.push({ key, label: monthName(key) });
  }
  return out;
}

const FIELD_TEXT: Record<string, (message: string) => string> = {
  q: (m) => hebrewOrNull(m) ?? `אפשר לכתוב עד ${EXPLORE_MAX_TEXT} תווים.`,
  month: (m) => /past/.test(m) ? "החודש שבחרתם כבר עבר. בחרו חודש אחר."
    : /within/.test(m) ? "אפשר לחפש עד שנה מראש."
      : /required/.test(m) ? "כתבו באיזה חודש, או בחרו חודש מהרשימה."
        : "בדקו את החודש.",
  start: () => "בדקו את התאריכים.",
  end: () => "בדקו את התאריכים.",
  nights: () => "אורך הטיול צריך להיות בין לילה אחד ל־30 לילות.",
  maxPrice: () => `תקציב הוא מספר שלם של שקלים, עד ${EXPLORE_MAX_BUDGET.toLocaleString("en-US")}.`,
  origin: () => "אפשר לצאת מתל אביב או מאילת.",
};

/** Hebrew text for a failed explore request. 400 query_not_understood shows the server's own Hebrew explanation. */
export function describeExploreFailure(failure: ApiFailure): FailureNotice & { lines: string[] } {
  const common = commonNotice(failure);
  if (common) return { ...common, lines: [] };
  if (failure.type !== "http") return { ...GENERIC_NOTICE, lines: [] };
  if (failure.code === "query_not_understood") {
    const why = hebrewOrNull(failure.fields.q) ?? "נסו למשל: ״4 לילות בנובמבר״ או ״סופ״ש בחודש הבא״.";
    return { title: "לא הבנו את הבקשה", body: why, retryAfterSec: null, canRetry: false, lines: [] };
  }
  if (failure.status === 400) {
    const lines = [...new Set(Object.entries(failure.fields).map(([field, message]) => (FIELD_TEXT[field] ?? (() => "בדקו את פרטי החיפוש."))(message)))];
    return { title: "צריך לתקן משהו בבקשה", body: lines.length ? "" : "בדקו את הפרטים ונסו שוב.", retryAfterSec: null, canRetry: false, lines };
  }
  if (failure.code === "source_unavailable") {
    return { title: "מקור המחירים לא זמין כרגע", body: "אין לנו כרגע מחירים שמורים לחודש הזה. נסו שוב בעוד כמה דקות.", retryAfterSec: null, canRetry: true, lines: [] };
  }
  if (failure.code === "fx_unavailable") {
    return { title: "לא הצלחנו להמיר את המחירים לשקלים", body: "שער המטבע לא זמין כרגע. נסו שוב בעוד כמה דקות.", retryAfterSec: null, canRetry: true, lines: [] };
  }
  if (failure.status === 503) return { title: "השירות לא זמין כרגע", body: "נסו שוב בעוד כמה דקות.", retryAfterSec: null, canRetry: true, lines: [] };
  return { ...GENERIC_NOTICE, lines: [] };
}

/**
 * An inline line for a failed re-sort. The results already on screen stay (they are still right, only in the other
 * order), so this never replaces them and never claims that no prices exist.
 */
export function sortFailureText(failure: ApiFailure, sort: ExploreSort): string {
  const what = sort === "score" ? "לא הצלחנו לסדר לפי ציון כרגע" : "לא הצלחנו לסדר לפי מחיר כרגע";
  if (failure.type === "offline") return `${what}: אין חיבור לאינטרנט. התוצאות שלמטה נשארו כמו שהן.`;
  if (failure.type === "http" && (failure.status === 429 || failure.code === "rate_limited")) {
    return `${what}. ${waitText(failure.retryAfterSec)} התוצאות שלמטה נשארו כמו שהן.`;
  }
  return `${what}. התוצאות שלמטה נשארו כמו שהן, ואפשר לנסות שוב בעוד רגע.`;
}

export function destinationName(d: ExploreResult["destination"]): string {
  return d.nameHe || d.nameEn || d.code;
}

/**
 * Card title: "עיר, מדינה" when the API gives the Hebrew country name (older deploys do not), else the city alone.
 * The country is left out when one name contains the other, so a city-state or a country named after its capital is
 * not repeated ("סינגפור, סינגפור", "סיישל, איי סיישל").
 */
export function destinationTitle(d: ExploreResult["destination"]): string {
  const name = destinationName(d);
  const country = typeof d.countryHe === "string" ? d.countryHe.trim() : "";
  if (!country || country.includes(name) || name.includes(country)) return name;
  return `${name}, ${country}`;
}

export interface ScorePart { key: keyof Omit<ExploreScore, "total" | "weights">; label: string; value: number | null; weightPct: number; hint: string }

/** The four parts of the score, in the order the breakdown shows them. A null part is left out of the total. */
export function scoreParts(score: ExploreScore): ScorePart[] {
  const pct = (w: number) => Math.round(w * 100);
  return [
    { key: "price", label: "מחיר", value: score.price, weightPct: pct(score.weights.price), hint: "ביחס ליעד הזול ביותר ברשימה" },
    { key: "weather", label: "מזג אוויר", value: score.weather, weightPct: pct(score.weights.weather), hint: "ממוצע רב־שנתי לחודש, לא תחזית" },
    { key: "attractiveness", label: "אטרקטיביות", value: score.attractiveness, weightPct: pct(score.weights.attractiveness), hint: "פופולריות היעד" },
    { key: "flightTime", label: "שעת טיסה", value: score.flightTime, weightPct: pct(score.weights.flightTime), hint: "שעת ההמראה בהלוך" },
  ];
}

/** Results sorted the way the user asked (the server already sorts; this keeps a re-sorted copy stable). */
export function sortResults(results: readonly ExploreResult[], sort: ExploreSort): ExploreResult[] {
  return [...results].sort((a, b) => sort === "score"
    ? b.score.total - a.score.total || a.price.ils - b.price.ils || a.destination.code.localeCompare(b.destination.code)
    : a.price.ils - b.price.ils || a.destination.code.localeCompare(b.destination.code));
}

export function stopsLabel(stops: number | null): string {
  if (stops === null) return "מספר העצירות לא ידוע";
  return stops === 0 ? "טיסה ישירה" : stops === 1 ? "עצירה אחת" : `${stops} עצירות`;
}

/** How long ago the SOURCE saw the fare, when it said so. Never our own fetch time. */
export function foundAgeText(foundAt: string | null, now: Date): string | null {
  const ms = foundAt ? Date.parse(foundAt) : NaN;
  if (!Number.isFinite(ms)) return null;
  const hours = Math.max(0, (now.getTime() - ms) / 3_600_000);
  if (hours < 1) return "המחיר נמצא לפני פחות משעה";
  if (hours < 24) return `המחיר נמצא לפני כ־${Math.round(hours)} שעות`;
  const days = Math.round(hours / 24);
  return days === 1 ? "המחיר נמצא לפני כיום" : `המחיר נמצא לפני כ־${days} ימים`;
}

export function climateText(c: ExploreResult["climate"]): string | null {
  if (!c) return null;
  return `כ־${Math.round(c.tmaxC)}° ביום · כ־${Math.round(c.rainDays)} ימי גשם בחודש (ממוצע רב־שנתי)`;
}

/**
 * The main search, filled with a result's destination and exact dates. Passengers, bag and preferences are kept from the
 * user's last search on this device, so nobody has to answer those questions again.
 */
export function prefillFromExplore(result: ExploreResult, base: SearchForm, originLabel: string): SearchForm {
  return sanitizeForm({
    ...base,
    origin: result.search.origin,
    originLabel,
    destination: result.search.destination,
    destinationLabel: destinationName(result.destination),
    windowStart: result.search.windowStart,
    windowEnd: result.search.windowEnd,
    stayMin: result.search.stayMin,
    stayMax: result.search.stayMax,
  });
}
