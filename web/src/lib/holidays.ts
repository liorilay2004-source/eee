/**
 * Israeli holidays and calendar insights from the Worker (/api/explore results[].holidayHe and vacationDaysUsed,
 * /api/calendar days[].holidayHe and meta.insights). Pure and unit tested in holidays.test.tsx.
 */
import type { CalendarInsights } from "../api/contract";
import { WEEKDAYS_LONG } from "./calendar";
import { formatILS } from "./search";

/** Hebcal's CC BY 4.0 licence asks for credit wherever its holiday names are shown. */
export const HOLIDAYS_ATTRIBUTION_FALLBACK = "Hebcal.com, CC BY 4.0";

/** "נתוני חגים: Hebcal.com, CC BY 4.0", from the response's own credit when it sends one. */
export function holidayCreditText(attribution: string | null | undefined): string {
  const credit = typeof attribution === "string" && attribution.trim() ? attribution.trim() : HOLIDAYS_ATTRIBUTION_FALLBACK;
  return `נתוני חגים: ${credit}`;
}

/** "ימי חופש נדרשים: 3", "יום חופש אחד" or "בלי ימי חופש", or null when unknown. */
export function vacationDaysText(days: number | null | undefined): string | null {
  if (typeof days !== "number" || !Number.isFinite(days) || days < 0) return null;
  const n = Math.round(days);
  if (n === 0) return "בלי ימי חופש";
  if (n === 1) return "יום חופש אחד";
  return `ימי חופש נדרשים: ${n}`;
}

/** The label shown under the insights when the response lacks its own. */
export const INSIGHTS_LABEL_FALLBACK = "לפי מחירים שנמצאו לאחרונה";

/** The insights' "based on cached prices" note, never "undefined". */
export function insightsBasisText(labelHe: string | null | undefined): string {
  const label = typeof labelHe === "string" && labelHe.trim() ? labelHe.trim() : INSIGHTS_LABEL_FALLBACK;
  return `${label}. לא התחייבות למחיר.`;
}

/** Whether a list of explore results shows any holiday data, so the Hebcal credit must appear under it. */
export function resultsNeedHolidayCredit(results: readonly { holidayHe?: string | null; vacationDaysUsed?: number | null }[]): boolean {
  return results.some((r) => holidayText(r.holidayHe) !== null || vacationDaysText(r.vacationDaysUsed) !== null);
}

/** A non-empty holiday name, or null. */
export function holidayText(holidayHe: string | null | undefined): string | null {
  return typeof holidayHe === "string" && holidayHe.trim() ? holidayHe.trim() : null;
}

export interface InsightLine { key: string; text: string }

/** The lines shown above the calendar, only for the fields the response actually has. */
export function insightLines(insights: CalendarInsights | null | undefined): InsightLine[] {
  if (!insights || typeof insights !== "object") return [];
  const lines: InsightLine[] = [];
  const hasSummary = typeof insights.summaryHe === "string" && insights.summaryHe.trim() !== "";
  if (hasSummary) lines.push({ key: "summary", text: insights.summaryHe.trim() });
  // The Worker's summary already names the cheapest weekday (and the saving), so the weekday line is only a fallback.
  const weekday = WEEKDAYS_LONG[insights.cheapestWeekday];
  if (!hasSummary && Number.isInteger(insights.cheapestWeekday) && weekday) {
    const pct = insights.savingVsDearestWeekdayPct;
    const saving = typeof pct === "number" && Number.isFinite(pct) && Math.round(pct) > 0 ? ` (חיסכון של כ-${Math.round(pct)}% לעומת היום היקר)` : "";
    lines.push({ key: "weekday", text: `יום היציאה הזול ביותר בממוצע: יום ${weekday}${saving}` });
  }
  if (typeof insights.cheapestNights === "number" && insights.cheapestNights > 0) {
    const n = insights.cheapestNights;
    const group = Array.isArray(insights.byNights) ? insights.byNights.find((g) => g.nights === n) : undefined;
    const from = group && group.minIls > 0 ? `, החל מ-${formatILS(group.minIls)}` : "";
    lines.push({ key: "nights", text: `אורך הטיול הזול ביותר: ${n === 1 ? "לילה אחד" : `${n} לילות`}${from}` });
  }
  return lines;
}
