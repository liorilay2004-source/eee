import { LIMITS } from "../config";
import type { SearchForm } from "./search";

export const nightsBetween = (start: string, end: string) => Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);

/** Exact dates must send exactly one date pair to the existing flexible search engine. */
export function selectVacationDate(form: SearchForm, date: string, flexible: boolean): Partial<SearchForm> {
  if (!form.windowStart || form.windowEnd || date <= form.windowStart) return { windowStart: date, windowEnd: "" };
  const nights = nightsBetween(form.windowStart, date);
  if (nights > (flexible ? LIMITS.maxWindowDays : LIMITS.maxStayNights)) return { windowStart: date, windowEnd: "" };
  return { windowEnd: date, ...(!flexible ? { stayMin: nights, stayMax: nights } : {}) };
}
