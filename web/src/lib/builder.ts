/**
 * Pure logic behind the question-by-question search builder and the results states.
 * Everything here is deterministic (takes `today` explicitly) so it is unit tested in builder.test.ts.
 */
import { LIMITS } from "../config";
import type { Offer, RecKind, SearchRequest, SourceStatus } from "../api/contract";
import { countValidPairs, formatILS, formatShortDate, type SearchForm } from "./search";

export type Question = "from" | "to" | "when" | "stay" | "who";
export const QUESTIONS: readonly Question[] = ["from", "to", "when", "stay", "who"];

export const QUESTION_TITLES: Record<Question, string> = {
  from: "מאיפה טסים?",
  to: "לאן טסים?",
  when: "מתי?",
  stay: "לכמה זמן?",
  who: "מי טס?",
};

const DAY = 86_400_000;
const toDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const fromDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  return fromDay(toDay(iso) + days * DAY);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((toDay(end) - toDay(start)) / DAY);
}

export function nightsBetween(depart: string, ret: string): number {
  const n = daysBetween(depart, ret);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

/* ---------------------------------------------------------------- when */

export const HEBREW_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"] as const;

export interface MonthOption {
  key: string; // "YYYY-MM"
  label: string; // "נובמבר"
  year: number;
  /** Shown under the month when it is not in the current year. */
  showYear: boolean;
}

/** Days left in the current month below which the month is no longer offered. */
const MIN_DAYS_LEFT_IN_MONTH = 10;

function monthKey(year: number, monthIndex: number): string {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function lastDayOfMonth(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return fromDay(Date.UTC(y, m, 0));
}

/**
 * 1 when the current month is no longer worth offering (fewer than MIN_DAYS_LEFT_IN_MONTH days left, which also covers its
 * last day, when the servers' windows, starting tomorrow, hold nothing of it), else 0. Shared by every month picker.
 */
export function firstMonthOffset(today: string): 0 | 1 {
  const [y, m] = today.split("-").map(Number);
  return daysBetween(today, lastDayOfMonth(monthKey(y, m - 1))) < MIN_DAYS_LEFT_IN_MONTH ? 1 : 0;
}

/** The next `count` months, starting with the current one only when enough of it is left. */
export function monthOptions(today: string, count = 6): MonthOption[] {
  const [y, m] = today.split("-").map(Number);
  const first = firstMonthOffset(today);
  return Array.from({ length: count }, (_, i) => {
    const key = monthKey(y, m - 1 + first + i);
    const [year, month] = key.split("-").map(Number);
    return { key, label: HEBREW_MONTHS[month - 1], year, showYear: year !== y };
  });
}

function monthIndex(key: string): number {
  const [y, m] = key.split("-").map(Number);
  return y * 12 + (m - 1);
}

/** Tap logic for month chips: one month, or two consecutive months. */
export function toggleMonth(selected: readonly string[], key: string): string[] {
  if (selected.includes(key)) return selected.filter((k) => k !== key);
  if (selected.length === 1 && Math.abs(monthIndex(selected[0]) - monthIndex(key)) === 1) {
    return [selected[0], key].sort();
  }
  return [key];
}

export interface DateWindow { windowStart: string; windowEnd: string }

/** 1 or 2 consecutive months -> a search window clamped to today and to the 120-day limit. */
export function windowForMonths(keys: readonly string[], today: string): DateWindow | null {
  if (!keys.length) return null;
  const sorted = [...keys].sort();
  const start = `${sorted[0]}-01` < today ? today : `${sorted[0]}-01`;
  let end = lastDayOfMonth(sorted[sorted.length - 1]);
  const maxEnd = addDays(start, LIMITS.maxWindowDays);
  if (end > maxEnd) end = maxEnd;
  if (end <= start) return null;
  return { windowStart: start, windowEnd: end };
}

/** "בחודש הקרוב": tomorrow up to 30 days from today. */
export function nextMonthWindow(today: string): DateWindow {
  return { windowStart: addDays(today, 1), windowEnd: addDays(today, 30) };
}

export type WhenChoice =
  | { mode: "none" }
  | { mode: "next30" }
  | { mode: "months"; keys: string[] }
  | { mode: "exact" };

/** Recovers which chip produced a stored or shared window, so the sheet shows the right selection. */
export function inferWhen(windowStart: string, windowEnd: string, today: string): WhenChoice {
  if (!windowStart || !windowEnd) return { mode: "none" };
  // Month chips are checked first: on the last day of a month, "the coming month" can be exactly the next
  // (30-day) month, and the user most likely tapped the month chip itself.
  const options = monthOptions(today).map((o) => o.key);
  const candidates: string[][] = [];
  options.forEach((key, i) => {
    candidates.push([key]);
    if (i + 1 < options.length) candidates.push([key, options[i + 1]]);
  });
  for (const keys of candidates) {
    const w = windowForMonths(keys, today);
    if (w && w.windowStart === windowStart && w.windowEnd === windowEnd) return { mode: "months", keys };
  }
  const next = nextMonthWindow(today);
  if (next.windowStart === windowStart && next.windowEnd === windowEnd) return { mode: "next30" };
  return { mode: "exact" };
}

export function rangeLabel(windowStart: string, windowEnd: string): string {
  if (!windowStart || !windowEnd) return "";
  return `${formatShortDate(windowStart)} – ${formatShortDate(windowEnd)}`;
}

export function whenLabel(windowStart: string, windowEnd: string, today: string): string {
  const choice = inferWhen(windowStart, windowEnd, today);
  if (choice.mode === "none") return "";
  if (choice.mode === "next30") return "בחודש הקרוב";
  if (choice.mode === "months") {
    return choice.keys.map((k) => HEBREW_MONTHS[Number(k.slice(5, 7)) - 1]).join("–");
  }
  return rangeLabel(windowStart, windowEnd);
}

/* ---------------------------------------------------------------- how long */

export interface StayPreset { key: string; label: string; min: number; max: number }

export const STAY_PRESETS: readonly StayPreset[] = [
  { key: "weekend", label: "סופ״ש", min: 2, max: 3 },
  { key: "short", label: "קצר", min: 3, max: 5 },
  { key: "week", label: "שבוע", min: 6, max: 8 },
  { key: "twoWeeks", label: "שבועיים", min: 12, max: 15 },
];

export function stayPresetFor(min: number, max: number): string {
  return STAY_PRESETS.find((p) => p.min === min && p.max === max)?.key ?? "custom";
}

export function nightsText(min: number, max: number): string {
  if (min === max) return min === 1 ? "לילה אחד" : `${min} לילות`;
  return `${min}–${max} לילות`;
}

export function stayLabel(min: number, max: number): string {
  const preset = STAY_PRESETS.find((p) => p.min === min && p.max === max);
  return preset ? `${preset.label} · ${nightsText(min, max)}` : nightsText(min, max);
}

export type PairCheck = { count: number; status: "none" | "ok" | "too_many" | "empty" };

/** How many (depart, return) pairs the search will check, and whether that is allowed. */
export function pairCheck(form: Pick<SearchForm, "windowStart" | "windowEnd" | "stayMin" | "stayMax">): PairCheck {
  if (!form.windowStart || !form.windowEnd) return { count: 0, status: "none" };
  const count = countValidPairs(form.windowStart, form.windowEnd, form.stayMin, form.stayMax);
  if (count === 0) return { count, status: "empty" };
  return { count, status: count > LIMITS.maxValidPairs ? "too_many" : "ok" };
}

/* ---------------------------------------------------------------- who */

export function passengersLabel(adults: number, children: number, infants: number): string {
  const parts = [adults === 1 ? "מבוגר אחד" : `${adults} מבוגרים`];
  if (children) parts.push(children === 1 ? "ילד אחד" : `${children} ילדים`);
  if (infants) parts.push(infants === 1 ? "תינוק אחד" : `${infants} תינוקות`);
  return parts.join(", ");
}

export function whoLabel(form: Pick<SearchForm, "adults" | "children" | "infants" | "checkedBag">): string {
  return `${passengersLabel(form.adults, form.children, form.infants)}${form.checkedBag ? " · עם מזוודה" : ""}`;
}

export function totalPassengers(p: { adults: number; children: number; infants: number }): number {
  return p.adults + p.children + p.infants;
}

/** Average share of the total, per traveller. Null when it cannot be computed. */
export function pricePerPerson(totalIls: number | null, passengers: number): number | null {
  if (totalIls === null || !Number.isFinite(totalIls) || passengers < 1) return null;
  return Math.ceil(totalIls / passengers);
}

/* ---------------------------------------------------------------- errors */

export type ErrorTarget = Question | "general";

/** Which question owns a field, for both the Worker's 400 `fields` and the client's own validation keys. */
export function questionForField(field: string): ErrorTarget {
  switch (field) {
    case "origin": return "from";
    case "destination": return "to";
    case "windowStart": case "windowEnd": case "dates": return "when";
    case "stayMin": case "stayMax": case "stay": return "stay";
    case "adults": case "children": case "infants": case "passengers": return "who";
    default: return "general";
  }
}

/** Hebrew text for one of the Worker's (English) field messages. */
export function serverFieldMessage(field: string, message: string): string {
  const m = message.toLowerCase();
  switch (field) {
    case "origin":
      if (m.includes("no matching")) return "לא זיהינו את נקודת המוצא. בחרו עיר או שדה תעופה מהרשימה.";
      return m.includes("required") ? "בחרו מאיפה טסים." : "בדקו את נקודת המוצא.";
    case "destination":
      if (m.includes("differ")) return "היעד צריך להיות שונה מהמוצא.";
      if (m.includes("no matching")) return "לא זיהינו את היעד. בחרו עיר או שדה תעופה מהרשימה.";
      return m.includes("required") ? "בחרו לאן טסים." : "בדקו את היעד.";
    case "windowStart":
      if (m.includes("past")) return "התאריכים כבר עברו. בחרו מהיום והלאה.";
      if (m.includes("within")) return "אפשר לחפש עד שנה מראש.";
      return "בדקו את התאריכים.";
    case "windowEnd":
      if (m.includes("too many")) return `יש יותר מ־${LIMITS.maxValidPairs} צירופי תאריכים. קצרו את הטווח או צמצמו את מספר הלילות.`;
      if (m.includes("exceed")) return "הטווח ארוך מ־120 יום. בחרו טווח קצר יותר.";
      if (m.includes("after")) return "סוף הטווח צריך להיות אחרי תחילתו.";
      return "בדקו את התאריכים.";
    case "stayMin": case "stayMax":
      if (m.includes("fits")) return "אין טיול באורך הזה שנכנס בטווח התאריכים.";
      return "מספר הלילות צריך להיות בין 1 ל־30.";
    case "adults":
      if (m.includes("passengers")) return "אפשר לחפש עד 9 נוסעים.";
      return "בדקו את מספר המבוגרים.";
    case "children": return "בדקו את מספר הילדים.";
    case "infants":
      if (m.includes("infant per adult")) return "אפשר עד תינוק אחד לכל מבוגר.";
      return "בדקו את מספר התינוקות.";
    case "cabin": return "כרגע אפשר לחפש רק במחלקת תיירים.";
    case "outHours": case "retHours": case "maxStops": case "nearbyAirports":
      return "אחת האפשרויות המתקדמות לא תקינה. בדקו את השעות והעצירות ונסו שוב.";
    default:
      return "הבקשה לא נשלחה כראוי. רעננו את הדף ונסו שוב.";
  }
}

export interface FieldErrors {
  byQuestion: Partial<Record<Question, string>>;
  general: string[];
}

export const NO_FIELD_ERRORS: FieldErrors = { byQuestion: {}, general: [] };

/**
 * Groups field errors by the chip that owns them. `translate` is true for the Worker's English messages and false
 * for the client's own Hebrew ones. The first message per question wins; general messages are de-duplicated.
 */
export function mapFieldErrors(fields: Record<string, string> | undefined, translate: boolean): FieldErrors {
  const result: FieldErrors = { byQuestion: {}, general: [] };
  for (const [field, message] of Object.entries(fields ?? {})) {
    const target = questionForField(field);
    const text = translate ? serverFieldMessage(field, String(message)) : String(message);
    if (target === "general") {
      if (!result.general.includes(text)) result.general.push(text);
    } else if (!result.byQuestion[target]) result.byQuestion[target] = text;
  }
  return result;
}

/**
 * The questions whose errors a form change resolves: the open question, every question that owns a changed field,
 * and both "when" and "stay" when either changes (too many pairs / no trip fits depend on both).
 */
export function questionsTouchedBy(changedFields: readonly string[], openQuestion: Question | null): Set<Question> {
  const touched = new Set<Question>();
  if (openQuestion) touched.add(openQuestion);
  for (const field of changedFields) {
    const target = questionForField(field);
    if (target !== "general") touched.add(target);
  }
  if (touched.has("when") || touched.has("stay")) { touched.add("when"); touched.add("stay"); }
  return touched;
}

/** Drops the errors of the given questions; returns the same object when nothing changes. */
export function clearQuestionErrors(errors: FieldErrors, questions: ReadonlySet<Question>): FieldErrors {
  if (![...questions].some((q) => errors.byQuestion[q])) return errors;
  const byQuestion = { ...errors.byQuestion };
  for (const q of questions) delete byQuestion[q];
  return { ...errors, byQuestion };
}

export function firstErrorQuestion(errors: FieldErrors): Question | null {
  return QUESTIONS.find((q) => errors.byQuestion[q]) ?? null;
}

export type Failure =
  | { type: "offline" }
  | { type: "timeout" }
  | { type: "network" }
  | { type: "http"; status: number; code: string; retryAfterSec?: number; fields?: Record<string, string> };

export type FailureKind = "offline" | "rate_limited" | "source_unavailable" | "invalid" | "timeout" | "error";

export interface FailureView {
  kind: FailureKind;
  title: string;
  body: string;
  /** Only when the server said so; never invented. */
  retryAfterSec: number | null;
  fields: FieldErrors;
  canRetry: boolean;
}

export function waitText(retryAfterSec: number | null): string {
  if (retryAfterSec === null) return "נסו שוב בעוד כמה דקות.";
  if (retryAfterSec < 60) return "אפשר לנסות שוב בעוד פחות מדקה.";
  const minutes = Math.ceil(retryAfterSec / 60);
  return minutes === 1 ? "אפשר לנסות שוב בעוד כדקה." : `אפשר לנסות שוב בעוד כ־${minutes} דקות.`;
}

export function describeFailure(failure: Failure): FailureView {
  const base = { retryAfterSec: null, fields: NO_FIELD_ERRORS, canRetry: true };
  switch (failure.type) {
    case "offline":
      return { ...base, kind: "offline", title: "אין חיבור לאינטרנט", body: "החיפוש שלכם שמור. כשהחיבור יחזור, לחצו על ״נסו שוב״." };
    case "timeout":
      return { ...base, kind: "timeout", title: "הבדיקה לוקחת יותר מדי זמן", body: "אפשר לנסות שוב, או לקצר את טווח התאריכים כדי שהבדיקה תהיה מהירה יותר." };
    case "network":
      return { ...base, kind: "error", title: "לא הצלחנו להתחבר לשירות", body: "בדקו את החיבור ונסו שוב בעוד רגע." };
    case "http": {
      if (failure.code === "rate_limited" || failure.status === 429) {
        const seconds = typeof failure.retryAfterSec === "number" && Number.isFinite(failure.retryAfterSec) && failure.retryAfterSec > 0
          ? Math.ceil(failure.retryAfterSec) : null;
        return { ...base, kind: "rate_limited", title: "ביצעתם הרבה חיפושים בזמן קצר", body: waitText(seconds), retryAfterSec: seconds };
      }
      if (failure.code === "storage_daily_limit") {
        const seconds = typeof failure.retryAfterSec === "number" && Number.isFinite(failure.retryAfterSec) && failure.retryAfterSec > 0 ? Math.ceil(failure.retryAfterSec) : null;
        return { ...base, kind: "source_unavailable", title: "בדיקת המחירים נעצרה זמנית", body: `מכסת בדיקת המחירים היומית מוצתה. ${waitText(seconds)} החיפוש והתאריכים שבחרתם שמורים.`, retryAfterSec: seconds };
      }
      if (failure.code === "source_unavailable") {
        return { ...base, kind: "source_unavailable", title: "מקור המחירים לא זמין כרגע", body: "נסו שוב בקרוב. החיפוש שלכם שמור." };
      }
      if (failure.code === "fx_unavailable") {
        return { ...base, kind: "error", title: "לא הצלחנו להמיר את המחירים לשקלים", body: "שער המטבע לא זמין כרגע. נסו שוב בעוד כמה דקות." };
      }
      if (failure.status === 400) {
        const fields = mapFieldErrors(failure.fields, true);
        const hasAny = Object.keys(fields.byQuestion).length > 0 || fields.general.length > 0;
        return {
          ...base, kind: "invalid", canRetry: false,
          title: "צריך לתקן משהו בחיפוש",
          body: hasAny ? "סימנו את מה שצריך לתקן. אחרי התיקון, חפשו שוב." : "הבקשה לא התקבלה. רעננו את הדף ונסו שוב.",
          fields: hasAny ? fields : { byQuestion: {}, general: ["הבקשה לא התקבלה. רעננו את הדף ונסו שוב."] },
        };
      }
      return { ...base, kind: "error", title: "לא הצלחנו להשלים את החיפוש", body: "משהו השתבש אצלנו. נסו שוב בעוד רגע." };
    }
  }
}

/* ---------------------------------------------------------------- results */

export const KIND_TITLES: Record<RecKind, string> = {
  cheapest: "הכי זול",
  best_value: "התמורה הטובה ביותר",
  my_times: "מתאים לשעות שלכם",
};

export const KIND_REASONS: Record<RecKind, string> = {
  cheapest: "הכי זול",
  best_value: "איזון בין מחיר לזמן",
  my_times: "מתאים לשעות שבחרתם",
};

export function hasTruncation(sources: readonly SourceStatus[]): boolean {
  return sources.some((s) => typeof s.error === "string" && s.error.includes("truncated"));
}

/**
 * A readable Hebrew line for a source note. The Worker's notes are English; the UI is Hebrew only, so an
 * unrecognised note becomes a generic Hebrew line instead of being shown raw.
 */
export function sourceNote(error: string): { text: string; codes?: string } {
  if (/today's share of the free quota used up/i.test(error)) return { text: "בדיקת המחירים החיים חסומה: המכסה היומית נגמרה או שלא ניתן לבדוק אותה כרגע. המכסה מתחדשת בחצות לפי שעון UTC (03:00 בישראל בשעון קיץ, 02:00 בשעון חורף)" };
  if (/free quota used up/i.test(error)) return { text: "מכסת בדיקת המחירים של המקור נגמרה לתקופה הנוכחית" };
  const truncated = /truncated:\s*(\d+)\s+of\s+(\d+)/i.exec(error);
  if (truncated) return { text: `${truncated[1]} מתוך ${truncated[2]} בדיקות מתוכננות לא בוצעו הפעם` };
  const notSearchable = /not searchable at Travelpayouts:\s*([A-Z0-9, -]+)/i.exec(error);
  if (notSearchable) return { text: "מסלולים שהמקור לא תומך בהם:", codes: notSearchable[1].trim() };
  if (/not configured/i.test(error)) return { text: "המקור לא זמין כרגע" };
  if (/too many searches/i.test(error)) return { text: "המקור עמוס כרגע, נסו שוב מאוחר יותר" };
  return { text: "המקור דיווח על בעיה בבדיקה הזו" };
}

export function emptySearchCopy(sources: readonly SourceStatus[]): { title: string; body: string } {
  const dailyQuota = sources.some((s) => s.enabled && /today's share of the free quota used up/i.test(s.error ?? ""));
  if (dailyQuota) return {
    title: "אין כרגע מחיר מאומת לתאריכים שבחרתם",
    body: "לא נמצא מחיר שמור לתאריכים האלה, ובדיקת המחירים החיים חסומה: המכסה היומית נגמרה או שלא ניתן לבדוק אותה כרגע. המכסה מתחדשת בחצות UTC (03:00 בישראל בשעון קיץ, 02:00 בשעון חורף). זה לא אומר שאין טיסות. התאריכים שבחרתם נשמרו ללא שינוי.",
  };
  const gaps = scanGaps(sources);
  if (gaps.failed || gaps.truncated) return {
    title: "בדיקת המחירים לא הושלמה",
    body: "לא הצלחנו לקבל מחיר מכל המקורות לתאריכים שבחרתם. זה לא אומר שאין טיסות. אפשר לנסות שוב מאוחר יותר; התאריכים נשמרו ללא שינוי.",
  };
  return { title: "לא נמצא מחיר לתאריכים שבחרתם", body: "מקורות המחירים לא החזירו הצעה לתאריכים האלה. זה לא אומר שאין טיסות. אפשר לשנות את החיפוש או לבדוק באתר חברת התעופה." };
}

/** Whether a scan did not check everything: a truncation note, or an enabled source that failed. */
export function scanGaps(sources: readonly SourceStatus[]): { truncated: boolean; failed: boolean } {
  return {
    truncated: hasTruncation(sources),
    failed: sources.some((s) => s.enabled && !s.ok),
  };
}

/* ---------------------------------------------------------------- price and bag copy */

export interface BagView { text: string; tone: "plain" | "good" | "warn"; short: string }

/**
 * What the price says about a checked bag. Mirrors the Worker (extras.ts): known leg fees are already inside
 * totalIls (extrasAmountIls), bag_fee_unknown marks legs whose fee is unknown, and an included bag adds nothing.
 */
export function bagView(
  offer: Pick<Offer, "tags" | "extrasAmountIls" | "includes"> & Partial<Pick<Offer, "source">>,
  request: Pick<SearchRequest, "checkedBag">,
): BagView {
  const tags = new Set(offer.tags);
  if (tags.has("bonus_checked_bag")) return { text: "מזוודה נגררת כלולה במחיר", short: "כולל מזוודה", tone: "good" };
  const advertised = tags.has("published_advertisement") || ["aegean", "air_canada", "tap", "ethiopian", "air_europa", "philippine", "virgin_atlantic", "air_new_zealand", "air_baltic", "sky_express", "gol", "elal", "direct_combination"].includes(offer.source ?? "");
  if (!request.checkedBag && advertised && offer.includes.checkedBag === undefined) return { text: "תנאי המזוודה לא נמסרו במקור; בדקו באתר החברה", short: "מזוודה: בדקו באתר", tone: "warn" };
  if (!request.checkedBag) return { text: "המחיר בלי מזוודה נגררת", short: "בלי מזוודה", tone: "plain" };
  if (offer.includes?.checkedBag === true) return { text: "מזוודה נגררת כלולה במחיר", short: "כולל מזוודה", tone: "good" };
  const extras = offer.extrasAmountIls > 0 ? offer.extrasAmountIls : 0;
  if (tags.has("bag_fee_unknown")) {
    return extras > 0
      ? { text: `המחיר כולל הערכה של ${formatILS(extras)} למזוודות שהעלות שלהן ידועה. עלות המזוודות בשאר הטיסות לא ידועה ולא כלולה`, short: "מזוודה: עלות חלקית", tone: "warn" }
      : { text: "עלות המזוודה לא ידועה לטיסות האלה, והיא לא כלולה במחיר", short: "מזוודה לא כלולה", tone: "warn" };
  }
  if (extras > 0) return { text: `כולל הערכה של ${formatILS(extras)} למזוודות`, short: "כולל הערכת מזוודה", tone: "plain" };
  return { text: "מזוודה נגררת: בדקו את העלות באתר ההזמנה", short: "מזוודה: בדקו באתר", tone: "warn" };
}

/** The price is a floor when a requested bag has a leg with an unknown fee. */
export function isMinimumPrice(offer: Pick<Offer, "tags">, request: Pick<SearchRequest, "checkedBag">): boolean {
  return request.checkedBag && offer.tags.includes("bag_fee_unknown");
}

/** "₪1,234", or "לפחות ₪1,234" when the price is a minimum. */
export function priceText(amount: number | null, atLeast: boolean): string {
  if (amount === null || !Number.isFinite(amount)) return formatILS(null);
  return `${atLeast ? "לפחות " : ""}${formatILS(amount)}`;
}

/** The line under a price: who it covers and the average per traveller. */
export function partyPriceLine(totalIls: number | null, passengers: number, atLeast: boolean): string {
  if (passengers <= 1) return "לנוסע אחד, הלוך וחזור";
  const each = pricePerPerson(totalIls, passengers);
  if (each === null) return `לכל ${passengers} הנוסעים`;
  return `לכל ${passengers} הנוסעים · ${atLeast ? `לפחות ${formatILS(each)}` : `כ־${formatILS(each)}`} לנוסע`;
}

/** Label for the original fare line; it excludes the bag estimate, so it says so when there is one. */
export function originalPriceLabel(extrasAmountIls: number): string {
  return extrasAmountIls > 0 ? "מחיר הכרטיס המקורי (בלי מזוודות)" : "המחיר המקורי";
}

/* ---------------------------------------------------------------- empty-state suggestions */

/** Extends the window's end (up to +30 days) while staying within 120 days and 400 pairs. */
export function widenWindow(form: SearchForm): SearchForm | null {
  if (!form.windowStart || !form.windowEnd) return null;
  const maxEnd = addDays(form.windowStart, LIMITS.maxWindowDays);
  for (let extra = 30; extra >= 7; extra -= 1) {
    let end = addDays(form.windowEnd, extra);
    if (end > maxEnd) end = maxEnd;
    if (end <= form.windowEnd) return null;
    if (countValidPairs(form.windowStart, end, form.stayMin, form.stayMax) <= LIMITS.maxValidPairs) {
      return { ...form, windowEnd: end };
    }
  }
  return null;
}

/**
 * About half the window (never shorter than the longest stay plus a week), for scans that were truncated:
 * fewer date pairs means every pair gets checked.
 */
export function shorterWindow(form: SearchForm): SearchForm | null {
  if (!form.windowStart || !form.windowEnd) return null;
  const length = daysBetween(form.windowStart, form.windowEnd);
  const target = Math.max(form.stayMax + 7, Math.ceil(length / 2));
  if (target >= length) return null;
  const end = addDays(form.windowStart, target);
  if (countValidPairs(form.windowStart, end, form.stayMin, form.stayMax) === 0) return null;
  return { ...form, windowEnd: end };
}

/** A looser stay range (one night shorter, two longer) that still fits the limits. */
export function otherDuration(form: SearchForm): SearchForm | null {
  const tries: [number, number][] = [
    [Math.max(1, form.stayMin - 1), Math.min(LIMITS.maxStayNights, form.stayMax + 2)],
    [Math.max(1, form.stayMin - 1), Math.min(LIMITS.maxStayNights, form.stayMax + 1)],
    [Math.max(1, form.stayMin - 2), form.stayMax],
  ];
  for (const [min, max] of tries) {
    if (min === form.stayMin && max === form.stayMax) continue;
    const pairs = countValidPairs(form.windowStart, form.windowEnd, min, max);
    if (pairs > 0 && pairs <= LIMITS.maxValidPairs) return { ...form, stayMin: min, stayMax: max };
  }
  return null;
}

export function withNearby(form: SearchForm): SearchForm | null {
  return form.nearbyAirports ? null : { ...form, nearbyAirports: true };
}

export const POPULAR_DESTINATIONS: readonly { code: string; label: string }[] = [
  { code: "ATH", label: "אתונה" },
  { code: "ROM", label: "רומא" },
  { code: "BCN", label: "ברצלונה" },
  { code: "LON", label: "לונדון" },
  { code: "PAR", label: "פריז" },
  { code: "BUD", label: "בודפשט" },
  { code: "PRG", label: "פראג" },
  { code: "LCA", label: "לרנקה" },
  { code: "IST", label: "איסטנבול" },
  { code: "BKK", label: "בנגקוק" },
  { code: "NYC", label: "ניו יורק" },
  { code: "DXB", label: "דובאי" },
];

export const QUICK_ORIGINS: readonly { code: string; label: string }[] = [
  { code: "TLV", label: "תל אביב" },
  { code: "ETM", label: "אילת" },
];

/** Other cities the price monitor watches (worker SNAPSHOT_ROUTES), so every watched route reads in Hebrew. */
const MORE_CITIES: readonly { code: string; label: string }[] = [
  { code: "AMS", label: "אמסטרדם" },
  { code: "BER", label: "ברלין" },
  { code: "MIL", label: "מילאנו" },
  { code: "MAD", label: "מדריד" },
  { code: "LIS", label: "ליסבון" },
  { code: "VIE", label: "וינה" },
  { code: "SOF", label: "סופיה" },
  { code: "TBS", label: "טביליסי" },
  { code: "ZRH", label: "ציריך" },
  { code: "MUC", label: "מינכן" },
];

const KNOWN_LABELS = new Map([...POPULAR_DESTINATIONS, ...QUICK_ORIGINS, ...MORE_CITIES].map((p) => [p.code, p.label]));

/** Display text for a place: the chosen label, a known city name, or the code itself. */
export function placeLabel(code: string, label: string): string {
  return label || KNOWN_LABELS.get(code.toUpperCase()) || code.toUpperCase();
}
