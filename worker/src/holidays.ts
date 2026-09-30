/**
 * Israeli holidays for the calendar and explore views (docs/FLIGHT_API_RESEARCH.md §17). Pure lookups over a bundled
 * table, so the Worker makes ZERO runtime calls for holidays:
 *
 *   holidays.json is written by scripts/gen-holidays.mjs from the free Hebcal.com REST API (Israel schedule, Hebrew
 *   titles), about 24 months from the day it was generated. Content is CC BY 4.0: every response that shows a holiday
 *   carries HOLIDAYS_ATTRIBUTION, and the web legal page credits Hebcal.
 *
 * Outside the table's range nothing is known: lookups return no holiday and vacationDaysUsed returns null (it never
 * guesses that an unknown day is a work day). Re-run the script to extend the range.
 */
import holidaysJson from "./holidays.json";

export const HOLIDAYS_ATTRIBUTION = "Hebcal.com, CC BY 4.0";

export interface Holiday {
  date: string; // YYYY-MM-DD
  titleHe: string;
  /** Hebcal's yom tov flag: a festival day on which work is not done (Rosh Hashana, Yom Kippur, first/last day of Pesach...). */
  yomtov: boolean;
  /** Hebcal subcat: "major", "minor", "modern" (and possibly "fast", "shabbat"). */
  category: string;
}

export interface HolidayIndex {
  /** Inclusive range the table covers, or null when the table is empty or malformed. */
  readonly range: { start: string; end: string } | null;
  /** Holidays on one day, in table order. Empty outside the range or for a malformed date. */
  on(date: string): Holiday[];
  /** Hebrew titles of the day's holidays joined with ", ", or null when there is none. */
  holidayHeOn(date: string): string | null;
  /**
   * Holidays between two days (inclusive), as distinct Hebrew names in date order with day numbering removed
   * ("סוכות ה׳ (חוה״מ)" and "סוכות ו׳ (חוה״מ)" -> "סוכות"; "ערב פסח" is dropped when "פסח" is listed too). null when none.
   */
  holidayHeBetween(start: string, end: string): string | null;
  /**
   * Work days a trip from `depart` to `ret` (both days included) takes off: Sunday-Thursday days that are not yom tov.
   * null when a date is malformed, ret < depart, or any day of the trip is outside the table's range.
   */
  vacationDaysUsed(depart: string, ret: string): number | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Day number since 1970-01-01 (UTC) of a real calendar date, else null. */
function dayOf(iso: string): number | null {
  if (typeof iso !== "string" || !ISO.test(iso)) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== iso) return null;
  return ms / DAY_MS;
}

/** A holiday's name without its day numbering: "פסח ב׳ (חוה״מ)" -> "פסח", "חנוכה: ג׳ נרות" -> "חנוכה", "ראש השנה 5788" -> "ראש השנה". */
export function holidayBaseName(title: string): string {
  let t = title.trim();
  t = t.replace(/\s*\([^)]*\)\s*$/, "");
  t = t.replace(/\s*:.*$/, "");
  t = t.replace(/\s+\d+$/, "");
  t = t.replace(/\s+[א-ת]{1,2}[׳']$/, ""); // Hebrew ordinal with geresh: א׳, ב׳, ...
  return t.trim() || title.trim();
}

function sanitize(v: unknown): Holiday | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.date !== "string" || dayOf(r.date) === null) return null;
  if (typeof r.titleHe !== "string" || r.titleHe.trim() === "") return null;
  return { date: r.date, titleHe: r.titleHe.trim(), yomtov: r.yomtov === true, category: typeof r.category === "string" ? r.category : "holiday" };
}

/** Builds an index from the generator's JSON shape ({ range: {start, end}, holidays: [...] }). Malformed rows are dropped. */
export function buildHolidayIndex(raw: unknown): HolidayIndex {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const list = (Array.isArray(obj.holidays) ? obj.holidays : []).map(sanitize).filter((h): h is Holiday => h !== null);
  const r = typeof obj.range === "object" && obj.range !== null ? (obj.range as Record<string, unknown>) : {};
  const startDay = typeof r.start === "string" ? dayOf(r.start) : null;
  const endDay = typeof r.end === "string" ? dayOf(r.end) : null;
  const range = startDay !== null && endDay !== null && startDay <= endDay ? { start: r.start as string, end: r.end as string } : null;

  const byDay = new Map<number, Holiday[]>();
  for (const h of list) {
    const d = dayOf(h.date) as number;
    if (startDay === null || endDay === null || d < startDay || d > endDay) continue; // only what the range vouches for
    const at = byDay.get(d);
    if (at) at.push(h);
    else byDay.set(d, [h]);
  }
  const inRange = (d: number): boolean => startDay !== null && endDay !== null && d >= startDay && d <= endDay;

  const on = (date: string): Holiday[] => {
    const d = dayOf(date);
    return d === null ? [] : [...(byDay.get(d) ?? [])];
  };

  return {
    range,
    on,
    holidayHeOn(date) {
      const titles = on(date).map((h) => h.titleHe);
      return titles.length > 0 ? titles.join(", ") : null;
    },
    holidayHeBetween(start, end) {
      const a = dayOf(start);
      const b = dayOf(end);
      if (a === null || b === null || b < a) return null;
      const names: string[] = [];
      for (let d = a; d <= b; d++) {
        for (const h of byDay.get(d) ?? []) {
          const name = holidayBaseName(h.titleHe);
          if (!names.includes(name)) names.push(name);
        }
      }
      const kept = names.filter((n) => !(n.startsWith("ערב ") && names.includes(n.slice(4))));
      return kept.length > 0 ? kept.join(", ") : null;
    },
    vacationDaysUsed(depart, ret) {
      const a = dayOf(depart);
      const b = dayOf(ret);
      if (a === null || b === null || b < a || !inRange(a) || !inRange(b)) return null;
      let used = 0;
      for (let d = a; d <= b; d++) {
        const weekday = new Date(d * DAY_MS).getUTCDay(); // 0 Sunday .. 6 Saturday
        if (weekday > 4) continue; // Friday and Saturday are not work days in Israel
        if ((byDay.get(d) ?? []).some((h) => h.yomtov)) continue;
        used++;
      }
      return used;
    },
  };
}

/** The bundled table (src/holidays.json). */
export const bundledHolidays: HolidayIndex = buildHolidayIndex(holidaysJson);
