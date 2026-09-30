/**
 * "זוג או בנפרד?" (worker/src/partycheck.ts): what the card's box shows, as pure helpers so they are tested without a browser.
 * Every API field here is optional (an older API sends none of them): anything missing or malformed shows nothing, never a
 * guess. An automatic check's answer goes through readPartyCheckResult before any of it is shown, and only https Aviasales
 * links are ever turned into buttons.
 */
import type { CardView, PartyCheckRequest, PartyCheckResult, SearchResponse } from "../api/contract";
import { waitText } from "./builder";
import { airlineLabels } from "./cards";
import { hebrewOrNull, type ApiFailure } from "./failure";
import { formatILS, trustedBookingUrl } from "./search";

/** The owner's title, for a couple; a bigger group is not a "זוג". */
export const PARTY_TITLE = "זוג או בנפרד?";
export const PARTY_TITLE_GROUP = "ביחד או בנפרד?";
export function partyTitle(adults: number): string {
  return adults === 2 ? PARTY_TITLE : PARTY_TITLE_GROUP;
}

export const AUTO_CHECK_LABEL = "בדקו בשבילי אוטומטית";

/**
 * What to do, in one sentence: the owner's wording, hedged (a cheaper split is never guaranteed). From 3 adults only ONE traveller
 * needs a booking of their own for a last cheap seat to count; the others can stay in one booking (and sit together).
 */
export function partyInstruction(adults: number): string {
  const what = adults === 2 ? "להזמין כל נוסע בנפרד" : "להזמין נוסע אחד בנפרד ואת השאר יחד";
  return `פתחו את שני הקישורים ובדקו: אם המחיר לנוסע אחד כפול ${adults} זול מהמחיר לכולם — ייתכן שכדאי ${what}.`;
}

/**
 * How to compare fairly: the same flight in both links (the cheapest flight for one is often the one the group cannot get), what
 * the site's price covers (whether the booking site shows a price for several passengers per passenger or for all of them is
 * NOT verified by us, so the user is asked to look), and the single price may hold for the first traveller only.
 */
export const COMPARE_NOTE =
  "השוו את אותה טיסה בשני הקישורים, ובדקו אם המחיר שמוצג הוא לנוסע אחד או לכל הנוסעים. ייתכן שהמחיר לנוסע אחד יישאר רק לנוסע הראשון: אחרי כל הזמנה בדקו שוב את המחיר לפני ההזמנה הבאה.";

export const SPLIT_INSTRUCTION = "בהצעה הזו יש שני כרטיסים נפרדים, הלוך וחזור: בודקים כל כיוון בנפרד, באותה דרך.";

/** Honest about the links: the booking site's prices are live, and the group link's passenger count is worth a glance. */
export const LIVE_PRICES_NOTE = "המחירים באתר ההזמנה הם מחירים חיים, והם יכולים להיות שונים מהמחיר השמור שלנו. ודאו שם שמספר הנוסעים נכון.";

export const WHY_TITLE = "למה זה קורה?";
/** In the children view the explanation follows the children rule, so its title says what it explains. */
export const WHY_TITLE_CHILDREN = "למה הזמנה נפרדת יכולה לעלות פחות?";
/** "דרגות מחיר", not "מחלקות" (which reads as economy / business), and "בדרך כלל": airlines do not all price it the same way. */
export const WHY_TEXT =
  "חברות התעופה מוכרות את המושבים בכמה דרגות מחיר. אם נשאר רק מושב אחד בדרגה הזולה, הזמנה לשני נוסעים מתומחרת בדרך כלל כולה לפי הדרגה הבאה, היקרה יותר. בהזמנות נפרדות הנוסע הראשון מקבל את המחיר הזול, ורק השני משלם את המחיר הבא. לכן לפעמים הזמנה נפרדת זולה יותר, אבל זה אף פעם לא מובטח.";

export const DOWNSIDES_TITLE = "חסרונות של הזמנות נפרדות";
/** Adults only (the box of a search with children says the children rule in its own words). */
export const DOWNSIDES: readonly string[] = [
  "אין הבטחה שתשבו יחד במטוס.",
  "כל הזמנה מטופלת לחוד: שינויים, ביטולים ומזוודות.",
  "בחלק מהאתרים משלמים עמלה על כל הזמנה, והיא יכולה לבטל חיסכון קטן.",
];

/** An infant always travels in an adult's booking, a child usually does: stated on the safe side. */
export const CHILDREN_TEXT =
  "בחיפוש יש ילדים או תינוקות. תינוק חייב להיות באותה הזמנה עם מבוגר, וכך בדרך כלל גם ילד, ולכן אין כאן קישורים להשוואה. הזמנה נפרדת יכולה לעזור רק למבוגר שנוסע בלי ילד או תינוק.";

export const AUTO_CHECK_NOTE = "הבדיקה משתמשת בשני חיפושים חיים מהמכסה החינמית של מקור המחירים, ורק כשלוחצים.";

export function singleButtonLabel(): string {
  return "מחיר לנוסע אחד";
}

export function partyButtonLabel(adults: number): string {
  return `מחיר ל־${adults} נוסעים`;
}

export interface PartyLinkRow {
  /** "הלוך" / "חזור" for a split ticket's two one-ways; null for a round trip. */
  label: string | null;
  single: string;
  party: string;
}

export type PartyBoxView = { kind: "links"; adults: number; rows: PartyLinkRow[] } | { kind: "children"; adults: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The card's box, or null when it has none: one adult, an older API, a link the web would not open, or a split ticket whose two
 * halves cannot both be compared. With children the box only explains (no links).
 */
export function partyBoxView(card: Pick<CardView, "offer"> & { partyCheck?: unknown }): PartyBoxView | null {
  const pc = card.partyCheck;
  if (!isRecord(pc)) return null;
  const adults = pc.adults;
  if (typeof adults !== "number" || !Number.isInteger(adults) || adults < 2 || adults > 9) return null;
  if (pc.reason === "children") return { kind: "children", adults };
  const link = (v: unknown): string | null => (typeof v === "string" ? trustedBookingUrl(v) : null);
  const single = link(pc.singleLink);
  const party = link(pc.partyLink);
  if (!single || !party) return null;
  if (card.offer.ticketStructure !== "split") return { kind: "links", adults, rows: [{ label: null, single, party }] };
  const backSingle = link(pc.returnSingleLink);
  const backParty = link(pc.returnPartyLink);
  if (!backSingle || !backParty) return null;
  return { kind: "links", adults, rows: [{ label: "הלוך", single, party }, { label: "חזור", single: backSingle, party: backParty }] };
}

/** meta.partyCheck.available, strictly: an older API (no field) never shows the automatic check. */
export function autoCheckAvailable(meta: Partial<Pick<SearchResponse["meta"], "partyCheck">> | null | undefined): boolean {
  return meta?.partyCheck?.available === true;
}

const TOKEN = /^v1\.\d{1,12}\.[A-Za-z0-9_-]{43}$/;

/** The token the search gave this card for the automatic check (only a card of a recent search can be checked), or null. */
export function partyToken(card: { partyCheck?: unknown }): string | null {
  const pc = card.partyCheck;
  return isRecord(pc) && typeof pc.token === "string" && TOKEN.test(pc.token) ? pc.token : null;
}

/** The automatic check is offered on a round-trip card with links and its token, and only when the API says it can run. */
export function canAutoCheck(card: Pick<CardView, "offer"> & { partyCheck?: unknown }, available: boolean): boolean {
  return available && card.offer.ticketStructure === "roundtrip" && partyBoxView(card)?.kind === "links" && partyToken(card) !== null;
}

/** The POST /api/party-check body for a card: its airports and dates, the adults of the search, and the card's token. */
export function partyCheckRequest(card: Pick<CardView, "offer"> & { partyCheck?: unknown }, adults: number): PartyCheckRequest {
  const o = card.offer;
  const token = partyToken(card);
  return {
    origin: o.origin,
    destination: o.destination,
    departDate: o.departDate,
    returnDate: o.ticketStructure === "split" ? null : o.returnDate,
    adults,
    ...(token ? { token } : {}),
  };
}

// --- the automatic check's answer ----------------------------------------------------------------------------

const VERDICTS = new Set(["separate", "together", "same", "unknown"]);
const finiteOrNull = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));
const positiveOrNull = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v) && v > 0);

function readPrice(v: unknown): { amount: number; currency: string; ils: number | null } | null | undefined {
  if (v === null) return null;
  if (!isRecord(v) || typeof v.amount !== "number" || !Number.isFinite(v.amount) || v.amount <= 0) return undefined;
  if (typeof v.currency !== "string" || !/^[A-Z]{3}$/.test(v.currency) || !positiveOrNull(v.ils)) return undefined;
  return { amount: v.amount, currency: v.currency, ils: v.ils };
}

function readFlight(v: unknown): PartyCheckResult["flight"] | undefined {
  if (v === null) return null;
  if (!isRecord(v) || !Array.isArray(v.airlines)) return undefined;
  const time = (t: unknown): t is string | null => t === null || (typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
  if (!time(v.outboundDepartTime) || !time(v.inboundDepartTime)) return undefined;
  if (!v.airlines.every((a): a is string => typeof a === "string" && /^[A-Z0-9]{2}$/.test(a))) return undefined;
  return { outboundDepartTime: v.outboundDepartTime, inboundDepartTime: v.inboundDepartTime, airlines: [...v.airlines] };
}

/**
 * A POST /api/party-check 200 body, checked field by field (the web never shows half-read numbers): null when anything the box
 * shows is missing, malformed, or does not fit its verdict ("separate" needs both prices and the estimate; "together" and
 * "same" both prices).
 */
export function readPartyCheckResult(raw: unknown): PartyCheckResult | null {
  if (!isRecord(raw)) return null;
  const adults = raw.adults;
  if (typeof adults !== "number" || !Number.isInteger(adults) || adults < 2 || adults > 9) return null;
  if (typeof raw.verdict !== "string" || !VERDICTS.has(raw.verdict)) return null;
  const verdict = raw.verdict as PartyCheckResult["verdict"];
  if (raw.matchBasis !== null && raw.matchBasis !== "same_flight" && raw.matchBasis !== "cheapest") return null;
  if (typeof raw.noteHe !== "string" || typeof raw.sourceName !== "string" || typeof raw.source !== "string" || typeof raw.checkedAt !== "string") return null;
  const single = readPrice(raw.single);
  const togetherBase = readPrice(raw.together);
  if (single === undefined || togetherBase === undefined) return null;
  const perPerson = isRecord(raw.together) ? raw.together.perPersonIls : null;
  if (!positiveOrNull(perPerson)) return null;
  const flight = readFlight(raw.flight);
  if (flight === undefined) return null;
  const { separateEstimateIls, savingIls, thresholdIls } = raw;
  if (!positiveOrNull(separateEstimateIls) || !finiteOrNull(savingIls) || !positiveOrNull(thresholdIls)) return null;
  if (verdict !== "unknown" && (single === null || single.ils === null || togetherBase === null || togetherBase.ils === null)) return null;
  if (verdict === "separate" && separateEstimateIls === null) return null;
  const fx = isRecord(raw.fx) && typeof raw.fx.date === "string" && typeof raw.fx.source === "string" ? { date: raw.fx.date, source: raw.fx.source } : null;
  return {
    source: raw.source as PartyCheckResult["source"],
    sourceName: raw.sourceName,
    checkedAt: raw.checkedAt,
    adults,
    matchBasis: raw.matchBasis,
    flight,
    single,
    together: togetherBase ? { ...togetherBase, perPersonIls: perPerson } : null,
    separateEstimateIls,
    savingIls,
    thresholdIls,
    verdict,
    noteHe: raw.noteHe,
    fx,
  };
}

/** One price line: a Hebrew label and left-to-right amounts, kept apart so each amount is shown in its own LTR span. */
export interface VerdictLine {
  label: string;
  /** "₪1,924" */
  amount: string;
  /** The vendor's own figure, e.g. "520 USD"; null for ILS or when unknown. */
  original: string | null;
  /** "₪962" per traveller, or null. */
  perPerson: string | null;
}

/** The one flight both prices are for ("same_flight"): its local departure times and airlines (Hebrew names when the card knows them). */
export interface VerdictFlight {
  outbound: string | null;
  inbound: string | null;
  airlines: string | null;
}

export interface VerdictView {
  title: string;
  tone: "good" | "plain" | "warn";
  lines: VerdictLine[];
  /** Which flight was compared; it may not be the card's own (the caveat always comes with it). */
  flight: VerdictFlight | null;
  note: string | null;
  /** Only when booking one by one looks cheaper: the downsides come with it. */
  reminder?: string;
}

export const SEPARATE_REMINDER = "לפני שמזמינים בנפרד, כדאי לקרוא את החסרונות שלמטה, ולבדוק את שני המחירים באתר ההזמנה.";
export const FLIGHT_CAVEAT = "ייתכן שזו לא הטיסה שבכרטיס הזה.";
const MANUAL_NOTE = "אפשר לבדוק בעצמכם עם שני הקישורים.";
const UNKNOWN_TITLE = "לא הצלחנו להשוות הפעם";

/** The vendor's amount in its own currency, e.g. "260 USD" (null for ILS: the shekel figure already says it). */
function original(p: { amount: number; currency: string } | null | undefined): string | null {
  if (!p || !Number.isFinite(p.amount) || p.currency === "ILS") return null;
  return `${Math.ceil(p.amount).toLocaleString("en-US")} ${p.currency}`;
}

/** The whole line as plain text (for screen-reader labels and tests). */
export function verdictLineText(line: VerdictLine): string {
  return `${line.label}: ${line.amount}${line.original ? ` (${line.original})` : ""}${line.perPerson ? `, כ־${line.perPerson} לנוסע` : ""}`;
}

/** The compared flight in one line, with its caveat (plain text, for tests and labels). */
export function verdictFlightText(f: VerdictFlight): string {
  const bits = [f.outbound ? `הלוך ב־${f.outbound}` : null, f.inbound ? `חזור ב־${f.inbound}` : null, f.airlines].filter((b): b is string => b !== null);
  return `הטיסה שהושוותה: ${bits.length > 0 ? bits.join(", ") : "פרטי הטיסה לא ידועים"}. ${FLIGHT_CAVEAT}`;
}

/**
 * The result in words. The separate cost is always called an estimate and is shown for "separate" only (the worker gives it for
 * nothing else); an answer that does not read as a whole shows no number at all.
 */
export function verdictView(input: unknown, airlineNames?: Readonly<Record<string, string>>): VerdictView {
  const result = readPartyCheckResult(input);
  if (!result) return { title: UNKNOWN_TITLE, tone: "warn", lines: [], flight: null, note: MANUAL_NOTE };
  const n = result.adults;
  const lines: VerdictLine[] = [];
  if (result.single && result.single.ils !== null) {
    lines.push({ label: "נוסע אחד לבד", amount: formatILS(result.single.ils), original: original(result.single), perPerson: null });
  }
  if (result.together && result.together.ils !== null) {
    const each = result.together.perPersonIls !== null ? formatILS(result.together.perPersonIls) : null;
    lines.push({ label: n === 2 ? "שני הנוסעים בהזמנה אחת" : `כל ${n} הנוסעים בהזמנה אחת`, amount: formatILS(result.together.ils), original: original(result.together), perPerson: each });
  }
  if (result.verdict === "separate" && result.separateEstimateIls !== null) {
    lines.push({ label: n === 2 ? "הערכה, כל נוסע בהזמנה נפרדת" : "הערכה, נוסע אחד בנפרד והשאר יחד", amount: formatILS(result.separateEstimateIls), original: null, perPerson: null });
  }
  const flight: VerdictFlight | null =
    result.matchBasis === "same_flight" && result.flight
      ? {
          outbound: result.flight.outboundDepartTime,
          inbound: result.flight.inboundDepartTime,
          airlines: result.flight.airlines.length > 0 ? airlineLabels(result.flight.airlines, airlineNames).map((a) => a.name ?? a.code).join(", ") : null,
        }
      : null;
  const note = hebrewOrNull(result.noteHe);
  switch (result.verdict) {
    case "separate":
      return { title: n === 2 ? "לפי הערכה, כדאי לבדוק הזמנה נפרדת לכל נוסע" : "לפי הערכה, כדאי לבדוק הזמנה נפרדת לנוסע אחד", tone: "good", lines, flight, note, reminder: SEPARATE_REMINDER };
    case "together":
      return { title: "עדיף להזמין את כולם יחד", tone: "plain", lines, flight, note };
    case "same":
      return { title: "אין הבדל משמעותי: הזמינו את כולם יחד", tone: "plain", lines, flight, note };
    default:
      // Prices were found, but the lower single price may be on another flight than the group's: shown, never a saving.
      if (lines.length > 0) return { title: "לא ברור אם הזמנה נפרדת תחסוך", tone: "warn", lines, flight: null, note: note ?? MANUAL_NOTE };
      return { title: UNKNOWN_TITLE, tone: "warn", lines: [], flight: null, note: note ?? MANUAL_NOTE };
  }
}

/** An answer that could not be read as a whole (readPartyCheckResult). */
export const MALFORMED_TEXT = "קיבלנו תשובה לא תקינה, ולכן לא נציג אותה. אפשר לבדוק בעצמכם עם שני הקישורים למעלה.";

export interface PartyFailureView {
  text: string;
  /** False when trying again cannot help now (no source, allowance used up, an old or refused card): the button then stays off. */
  retry: boolean;
}

/** A failed automatic check, in Hebrew, by its actual cause. 404 / 429 / 503 each say what happened; the manual links always remain. */
export function partyCheckFailureView(failure: ApiFailure): PartyFailureView {
  const manual = "אפשר לבדוק בעצמכם עם שני הקישורים למעלה.";
  if (failure.type === "offline") return { text: "אין חיבור לאינטרנט. כשהחיבור יחזור, נסו שוב.", retry: true };
  if (failure.type === "network") return { text: "לא הצלחנו להתחבר לשירות. נסו שוב בעוד רגע.", retry: true };
  if (failure.status === 404) return { text: `הבדיקה האוטומטית לא זמינה כרגע. ${manual}`, retry: false };
  if (failure.status === 429 || failure.code === "rate_limited") return { text: `ביקשתם הרבה בדיקות בזמן קצר. ${waitText(failure.retryAfterSec)}`, retry: true };
  if (failure.status === 503) {
    // Today's checks (or today's share of the source) come back at midnight UTC; a spent free allowance may never come back.
    if (failure.code === "daily_limit") return { text: `הבדיקות האוטומטיות להיום נגמרו. ${manual}`, retry: false };
    if (failure.code === "quota_exhausted") return { text: `המכסה החינמית של מקור המחירים נגמרה, ולכן הבדיקה האוטומטית לא זמינה. ${manual}`, retry: false };
    if (failure.code === "upstream_unavailable") return { text: `מקור המחירים לא ענה כרגע. אפשר לנסות שוב מאוחר יותר. ${manual}`, retry: true };
    // fx_unavailable, storage_unavailable, anything else: nothing was asked of the price source.
    return { text: `הבדיקה האוטומטית לא זמינה כרגע בגלל תקלה אצלנו. אפשר לנסות שוב מאוחר יותר. ${manual}`, retry: true };
  }
  if (failure.status === 400 && failure.code === "offer_expired") return { text: `תוצאות החיפוש האלה ישנות מדי לבדיקה אוטומטית. חפשו שוב כדי לבדוק. ${manual}`, retry: false };
  if (failure.status === 400) return { text: `לא הצלחנו לבדוק את ההצעה הזו אוטומטית. ${manual}`, retry: false };
  return { text: `משהו השתבש אצלנו. נסו שוב בעוד רגע. ${manual}`, retry: true };
}

export function partyCheckFailureText(failure: ApiFailure): string {
  return partyCheckFailureView(failure).text;
}
