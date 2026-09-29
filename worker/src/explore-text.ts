/**
 * Hebrew free text -> explore filters, for the "I don't know where to go" box ("יש לי 4 ימים בנובמבר").
 *
 * Pure and dependency-free so the web client can import it as well as the Worker (GET /api/explore?q=...).
 * It only reads what it recognises: a trip length and a month. Anything it cannot read is reported in `missing`,
 * never guessed; with neither found the result is { ok: false } and a Hebrew message saying so.
 *
 * Conventions (stated, because Hebrew speakers use both):
 *   "N ימים" / "N יום"   = N days away = N-1 nights ("4 ימים" -> 3 nights). "יום אחד" is refused (0 nights).
 *   "N לילות" / "לילה"   = N nights.
 *   "סופ״ש" / "סוף שבוע" = 2-3 nights (Thursday or Friday out, Saturday or Sunday back).
 *   "שבוע" = 7 nights, "שבוע וחצי" = 10, "שבועיים" = 14, "N שבועות" = 7N (up to 30 nights).
 *   A month name is the next time that month comes (this month counts); "בחודש הבא" = next calendar month;
 *   "החודש" = this month.
 */

export interface NightsRange {
  min: number;
  max: number;
}

export interface ExploreTextResult {
  ok: boolean;
  /** Nights away (both ends inclusive), or null when the text gives no trip length. */
  nights: NightsRange | null;
  /** "YYYY-MM", or null when the text names no month. */
  month: string | null;
  /** What could not be read: "nights" and/or "month". */
  missing: ("nights" | "month")[];
  /** Hebrew, for the user: set whenever something is missing. */
  message: string | null;
  /** ADDITIVE: a trip length was written but makes no trip ("יום אחד", "40 לילות"): the caller must not ignore it. */
  invalidNights: boolean;
}

export const MAX_TEXT_LEN = 200;
export const MIN_NIGHTS = 1;
export const MAX_NIGHTS = 30;

const MONTHS: readonly (readonly string[])[] = [
  ["ינואר"],
  ["פברואר"],
  ["מרץ", "מרס"],
  ["אפריל"],
  ["מאי"],
  ["יוני"],
  ["יולי"],
  ["אוגוסט"],
  ["ספטמבר"],
  ["אוקטובר"],
  ["נובמבר"],
  ["דצמבר"],
];

/** Hebrew number words, both genders ("ארבעה ימים", "ארבע לילות" is common even if not standard). */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  אחד: 1,
  אחת: 1,
  שניים: 2,
  שני: 2,
  שתיים: 2,
  שתי: 2,
  שלושה: 3,
  שלוש: 3,
  ארבעה: 4,
  ארבע: 4,
  חמישה: 5,
  חמש: 5,
  שישה: 6,
  שש: 6,
  שבעה: 7,
  שבע: 7,
  שמונה: 8,
  תשעה: 9,
  תשע: 9,
  עשרה: 10,
  עשר: 10,
};

/** A word boundary for Hebrew text: JS `\b` does not know Hebrew letters. */
const B = "(?:^|[\\s,.;:!?()\\-–—/])";
const E = "(?=$|[\\s,.;:!?()\\-–—/])";
/** Prefix letters that attach to a word: ב ל ה ו מ ש, in any short combination ("ובנובמבר"). */
const PFX = "[ובלהמש]{0,2}";
const NUM = `(\\d{1,2}|${Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join("|")})`;
const DAYS = "(?:ימים|יום)";
const NIGHTS = "(?:לילות|לילה)";

function toNumber(token: string): number | null {
  if (/^\d{1,2}$/.test(token)) return Number(token);
  return NUMBER_WORDS[token] ?? null;
}

/** Folds the look-alike quote marks (gershayim, geresh, typographic quotes) and invisible marks into plain ones. */
function normalize(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[‎‏‪-‮⁦-⁩]/g, "")
    .replace(/[״“”„]/g, '"')
    .replace(/[׳‘’]/g, "'")
    .replace(/''/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function monthKey(year: number, monthIndex0: number): string {
  return `${year}-${String(monthIndex0 + 1).padStart(2, "0")}`;
}

function parseMonth(text: string, now: Date): string | null {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (new RegExp(`${B}${PFX}חודש הבא${E}`).test(text) || new RegExp(`${B}בעוד חודש${E}`).test(text)) {
    return m === 11 ? monthKey(y + 1, 0) : monthKey(y, m + 1);
  }
  for (const [i, names] of MONTHS.entries()) {
    for (const name of names) {
      if (new RegExp(`${B}${PFX}${name}${E}`).test(text)) return i >= m ? monthKey(y, i) : monthKey(y + 1, i);
    }
  }
  if (new RegExp(`${B}[וב]?החודש${E}`).test(text)) return monthKey(y, m);
  return null;
}

function range(min: number, max: number): NightsRange | null {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo >= MIN_NIGHTS && hi <= MAX_NIGHTS ? { min: lo, max: hi } : null;
}

/** "invalid" = a length was written but makes no trip (e.g. "יום אחד", "40 לילות"): reported, not guessed around. */
function parseNights(text: string): NightsRange | null | "invalid" {
  // Weekend first: "סוף שבוע" contains "שבוע", which on its own means 7 nights.
  if (new RegExp(`${B}${PFX}(?:סופ"ש|סופש|סוף[ -]שבוע|סופ"שים|ויקנד|וויקנד)${E}`).test(text)) return { min: 2, max: 3 };

  const rangeRe = new RegExp(`${B}(?:בין )?${NUM} ?(?:-|–|עד|ל-?|או) ?${PFX}${NUM} ${PFX}(${DAYS}|${NIGHTS})${E}`);
  const r = rangeRe.exec(text);
  if (r) {
    const a = toNumber(r[1] as string);
    const b = toNumber(r[2] as string);
    if (a === null || b === null) return "invalid";
    const days = /^(?:ימים|יום)$/.test(r[3] as string);
    return range(days ? a - 1 : a, days ? b - 1 : b) ?? "invalid";
  }

  const single = new RegExp(`${B}${NUM} ${PFX}(${DAYS}|${NIGHTS})${E}`).exec(text);
  if (single) {
    const n = toNumber(single[1] as string);
    if (n === null) return "invalid";
    const days = /^(?:ימים|יום)$/.test(single[2] as string);
    const nights = days ? n - 1 : n;
    return range(nights, nights) ?? "invalid";
  }
  // Noun-first forms: "יום אחד", "לילה אחד", "שני לילות" is covered above; "ימים 4" is not Hebrew word order.
  if (new RegExp(`${B}${PFX}לילה(?: אחד)?${E}`).test(text)) return { min: 1, max: 1 };
  if (new RegExp(`${B}${PFX}יום אחד${E}`).test(text)) return "invalid";
  if (new RegExp(`${B}${PFX}יומיים${E}`).test(text)) return { min: 1, max: 1 };
  if (new RegExp(`${B}${PFX}לילותיים${E}`).test(text)) return { min: 2, max: 2 };
  if (new RegExp(`${B}${PFX}שבועיים${E}`).test(text)) return { min: 14, max: 14 };
  const weeks = new RegExp(`${B}${NUM} ${PFX}שבועות${E}`).exec(text);
  if (weeks) {
    const n = toNumber(weeks[1] as string);
    return n === null ? "invalid" : (range(7 * n, 7 * n) ?? "invalid");
  }
  if (new RegExp(`${B}${PFX}שבוע וחצי${E}`).test(text)) return { min: 10, max: 10 };
  if (new RegExp(`${B}${PFX}שבוע${E}`).test(text)) return { min: 7, max: 7 };
  return null;
}

const MESSAGES = {
  nothing: "לא הצלחנו להבין כמה זמן ובאיזה חודש. נסו למשל: \"4 לילות בנובמבר\" או \"סופ״ש בחודש הבא\".",
  nights: "לא הבנו לכמה לילות. נסו למשל: \"4 לילות\", \"5 ימים\" או \"סופ״ש\".",
  month: "לא הבנו באיזה חודש. נסו למשל: \"בנובמבר\" או \"בחודש הבא\".",
  badNights: `אורך הטיול צריך להיות בין ${MIN_NIGHTS} ל-${MAX_NIGHTS} לילות.`,
} as const;

/**
 * Reads a trip length and a month out of Hebrew free text. `now` decides which year a month name means and what
 * "next month" is (UTC calendar).
 */
export function parseExploreQuery(input: string, now: Date = new Date()): ExploreTextResult {
  const text = typeof input === "string" ? normalize(input.slice(0, MAX_TEXT_LEN)) : "";
  const month = text ? parseMonth(text, now) : null;
  const parsedNights = text ? parseNights(text) : null;
  const nights = parsedNights === "invalid" ? null : parsedNights;
  const missing: ("nights" | "month")[] = [];
  if (!nights) missing.push("nights");
  if (!month) missing.push("month");
  let message: string | null = null;
  if (parsedNights === "invalid") message = MESSAGES.badNights;
  else if (missing.length === 2) message = MESSAGES.nothing;
  else if (missing[0] === "nights") message = MESSAGES.nights;
  else if (missing[0] === "month") message = MESSAGES.month;
  return { ok: nights !== null || month !== null, nights, month, missing, message, invalidNights: parsedNights === "invalid" };
}
