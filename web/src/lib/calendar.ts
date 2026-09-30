/**
 * The price calendar inside the "when" question (GET /api/calendar): request parameters, the month grid and its
 * heat-map levels. Pure and unit tested in calendar.test.ts.
 */
import type { CalendarDay, CalendarLevel } from "../api/contract";
import { HEBREW_MONTHS, addDays, inferWhen } from "./builder";
import { commonNotice, type ApiFailure } from "./failure";
import { formatILS, formatShortDate, type SearchForm } from "./search";

/** Every level has a word, so the heat-map never relies on colour alone. */
export const LEVEL_LABELS: Record<CalendarLevel, string> = { low: "זול", mid: "בינוני", high: "יקר" };

export const WEEKDAYS_SHORT = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"] as const;
export const WEEKDAYS_LONG = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"] as const;

/**
 * Query for one month, or null when the calendar should not be asked at all (origin or destination missing, or the
 * same place): the calendar is an extra, it never asks for anything the search itself does not have.
 */
export function calendarParams(form: Pick<SearchForm, "origin" | "destination" | "stayMin" | "stayMax">, month: string): Record<string, string> | null {
  const origin = form.origin.trim();
  const destination = form.destination.trim();
  if (!origin || !destination || origin.toUpperCase() === destination.toUpperCase()) return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const min = Math.max(1, Math.min(30, form.stayMin));
  const max = Math.max(min, Math.min(30, form.stayMax));
  return { origin, destination, month, minNights: String(min), maxNights: String(max) };
}

/** Stable key for the in-memory response cache (same parameters, same answer, for a few minutes). */
export function calendarKey(params: Record<string, string>): string {
  return ["origin", "destination", "month", "minNights", "maxNights"].map((k) => params[k] ?? "").join("|");
}

/** The month the calendar opens on: the chosen month chip, else the month of the chosen dates, else the first month offered. */
export function initialCalendarMonth(form: Pick<SearchForm, "windowStart" | "windowEnd">, today: string, firstOffered: string): string {
  const choice = inferWhen(form.windowStart, form.windowEnd, today);
  if (choice.mode === "months") return choice.keys[0];
  if (form.windowStart && form.windowStart >= today) return form.windowStart.slice(0, 7);
  return firstOffered;
}

export function shiftMonth(key: string, n: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export type CellKind = "pad" | "past" | "unknown" | "none" | "priced";

export interface CalendarCell {
  kind: CellKind;
  /** null for the padding cells before the 1st and after the last day. */
  date: string | null;
  day: number | null;
  priceIls: number | null;
  level: CalendarLevel | null;
  returnDate: string | null;
  nights: number | null;
  cheapest: boolean;
}

const pad = (): CalendarCell => ({ kind: "pad", date: null, day: null, priceIls: null, level: null, returnDate: null, nights: null, cheapest: false });

/**
 * One month as weeks of seven cells, Sunday first (the Israeli week). Days the response does not list are in the past
 * (the API starts at today); a listed day with known: false could not be loaded, and a known day without a fare has no
 * cached price, which is not the same as "no flights".
 */
export function buildCalendarGrid(month: string, days: readonly CalendarDay[], today: string, cheapestDate: string | null = null): CalendarCell[][] {
  const [y, m] = month.split("-").map(Number);
  const first = `${month}-01`;
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const byDate = new Map(days.map((d) => [d.date, d]));
  const cells: CalendarCell[] = Array.from({ length: lead }, pad);
  for (let i = 0; i < count; i += 1) {
    const date = addDays(first, i);
    const listed = byDate.get(date);
    const base = { date, day: i + 1, priceIls: null, level: null, returnDate: null, nights: null, cheapest: false };
    if (!listed) cells.push({ ...base, kind: date < today ? "past" : "unknown" });
    else if (!listed.known) cells.push({ ...base, kind: "unknown" });
    else if (!listed.fare) cells.push({ ...base, kind: "none" });
    else cells.push({
      ...base, kind: "priced", priceIls: listed.fare.priceIls, level: listed.fare.level,
      returnDate: listed.fare.returnDate, nights: listed.fare.nights, cheapest: date === cheapestDate,
    });
  }
  while (cells.length % 7) cells.push(pad());
  const weeks: CalendarCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** "₪1,234" rounded up, like every other price in the app. */
export function cellPrice(priceIls: number): string {
  return formatILS(priceIls);
}

/** What a screen reader hears for one day, e.g. "יום שלישי, 10 בנובמבר: ₪1,234, זול, חזרה 14/11, 4 לילות". */
export function cellLabel(cell: CalendarCell): string {
  if (cell.kind === "pad" || !cell.date) return "";
  const [y, m, d] = cell.date.split("-").map(Number);
  const weekday = WEEKDAYS_LONG[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const head = `יום ${weekday}, ${d} ב${HEBREW_MONTHS[m - 1]}`;
  switch (cell.kind) {
    case "past": return `${head}: עבר`;
    case "unknown": return `${head}: לא הצלחנו לטעון מחיר`;
    case "none": return `${head}: אין מחיר שמור`;
    case "priced": {
      const parts = [cellPrice(cell.priceIls as number)];
      if (cell.level) parts.push(LEVEL_LABELS[cell.level]);
      if (cell.cheapest) parts.push("הזול בחודש");
      if (cell.returnDate) parts.push(`חזרה ${formatShortDate(cell.returnDate)}`);
      if (cell.nights) parts.push(cell.nights === 1 ? "לילה אחד" : `${cell.nights} לילות`);
      return `${head}: ${parts.join(", ")}`;
    }
  }
}

/** Tapping a priced day: exactly that fare's dates (one date pair), so the search checks just it. */
export function datesForCell(cell: CalendarCell): Pick<SearchForm, "windowStart" | "windowEnd" | "stayMin" | "stayMax"> | null {
  if (cell.kind !== "priced" || !cell.date || !cell.returnDate || !cell.nights || cell.nights < 1) return null;
  return { windowStart: cell.date, windowEnd: cell.returnDate, stayMin: cell.nights, stayMax: cell.nights };
}

/** A short, calm line when the calendar could not load. It never blocks the question. */
export function calendarFailureText(failure: ApiFailure): string {
  const common = commonNotice(failure);
  if (failure.type === "http" && (failure.status === 429 || failure.code === "rate_limited")) return `לוח המחירים לא זמין כרגע. ${common?.body ?? ""}`.trim();
  if (failure.type === "offline") return "אין חיבור לאינטרנט, ולכן לוח המחירים לא נטען.";
  if (failure.type === "http" && failure.code === "source_unavailable") return "אין כרגע מחירים שמורים להצגה בלוח. אפשר להמשיך לבחור חודש או תאריכים.";
  return "לוח המחירים לא זמין כרגע. אפשר להמשיך לבחור חודש או תאריכים.";
}

/**
 * What the calendar's persistent live region says for the month on screen, so a screen-reader user hears the month
 * change and what it holds (the month name alone sits in a plain heading).
 */
export function calendarStatusText(monthLabel: string, state: { status: "loading" } | { status: "failed"; text: string } | { status: "done"; priced: number }): string {
  if (state.status === "loading") return `${monthLabel}: טוענים מחירים…`;
  if (state.status === "failed") return `${monthLabel}: ${state.text}`;
  if (state.priced === 0) return `${monthLabel}: אין ימים עם מחיר שמור.`;
  return `${monthLabel}: ${state.priced === 1 ? "יום אחד" : `${state.priced} ימים`} עם מחיר שמור.`;
}
