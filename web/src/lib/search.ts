import { LIMITS } from "../config";
import type { SearchRequest } from "../api/contract";

/** The live, editable search. Places are stored as the codes the API accepts plus a display label. */
export interface SearchForm {
  origin: string;
  originLabel: string;
  destination: string;
  destinationLabel: string;
  windowStart: string;
  windowEnd: string;
  stayMin: number;
  stayMax: number;
  adults: number;
  children: number;
  infants: number;
  checkedBag: boolean;
  outHoursPreset: string;
  retHoursPreset: string;
  customOut: [number, number];
  customRet: [number, number];
  useCustomOut: boolean;
  useCustomRet: boolean;
  maxStops: number | null;
  nearbyAirports: boolean;
}

export const hourPresets: Record<string, [number, number] | null> = {
  none: null,
  morning: [6, 12],
  afternoon: [12, 17],
  evening: [17, 23],
  night: [23, 6],
  custom: [7, 15],
};

/** UTC day, the same "today" the Worker validates against. */
export const todayISO = () => new Date().toISOString().slice(0, 10);

export function emptyForm(): SearchForm {
  return {
    origin: "TLV", originLabel: "תל אביב", destination: "", destinationLabel: "",
    windowStart: "", windowEnd: "", stayMin: 6, stayMax: 8,
    adults: 1, children: 0, infants: 0, checkedBag: false,
    outHoursPreset: "none", retHoursPreset: "none", customOut: [7, 15], customRet: [7, 15],
    useCustomOut: false, useCustomRet: false, maxStops: null, nearbyAirports: false,
  };
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const intIn = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
const hourPair = (value: unknown, fallback: [number, number]): [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((n) => Number.isInteger(n) && n >= 0 && n <= 24)
    ? [value[0] as number, value[1] as number] : fallback;
const text = (value: unknown, fallback: string, max = 60): string =>
  typeof value === "string" ? value.slice(0, max) : fallback;

/** Coerces untrusted stored or shared data (localStorage, URL) into a well-typed form. */
export function sanitizeForm(raw: unknown): SearchForm {
  const base = emptyForm();
  if (typeof raw !== "object" || raw === null) return base;
  const r = raw as Record<string, unknown>;
  const preset = (value: unknown) => typeof value === "string" && Object.hasOwn(hourPresets, value) ? value : "none";
  const form: SearchForm = {
    origin: text(r.origin, base.origin, 40).trim(),
    originLabel: text(r.originLabel, ""),
    destination: text(r.destination, base.destination, 40).trim(),
    destinationLabel: text(r.destinationLabel, ""),
    windowStart: typeof r.windowStart === "string" && isoDate.test(r.windowStart) ? r.windowStart : "",
    windowEnd: typeof r.windowEnd === "string" && isoDate.test(r.windowEnd) ? r.windowEnd : "",
    stayMin: intIn(r.stayMin, 1, LIMITS.maxStayNights, base.stayMin),
    stayMax: intIn(r.stayMax, 1, LIMITS.maxStayNights, base.stayMax),
    adults: intIn(r.adults, 1, LIMITS.maxPassengers, 1),
    children: intIn(r.children, 0, LIMITS.maxPassengers, 0),
    infants: intIn(r.infants, 0, LIMITS.maxPassengers, 0),
    checkedBag: r.checkedBag === true,
    outHoursPreset: preset(r.outHoursPreset),
    retHoursPreset: preset(r.retHoursPreset),
    customOut: hourPair(r.customOut, base.customOut),
    customRet: hourPair(r.customRet, base.customRet),
    useCustomOut: r.useCustomOut === true,
    useCustomRet: r.useCustomRet === true,
    maxStops: r.maxStops === null || r.maxStops === undefined ? null : intIn(r.maxStops, 0, 2, 0),
    nearbyAirports: r.nearbyAirports === true,
  };
  if (form.origin === base.origin && !form.originLabel) form.originLabel = base.originLabel;
  if (form.outHoursPreset === "none" && form.retHoursPreset === "none") form.maxStops = null;
  return form;
}

export function hoursFor(preset: string, custom: [number, number], enabled: boolean): [number, number] | null {
  if (preset === "custom") return enabled && custom[0] !== custom[1] ? custom : null;
  return hourPresets[preset] ?? null;
}

export function hasHourPreferences(form: SearchForm): boolean {
  return form.outHoursPreset !== "none" || form.retHoursPreset !== "none";
}

export function countValidPairs(start: string, end: string, stayMin: number, stayMax: number): number {
  if (!start || !end || stayMin < 1 || stayMax < stayMin) return 0;
  const first = Date.parse(`${start}T00:00:00Z`);
  const last = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) return 0;
  const day = 86_400_000;
  let count = 0;
  for (let depart = first; depart <= last; depart += day) {
    for (let nights = stayMin; nights <= stayMax; nights += 1) {
      if (depart + nights * day <= last) count += 1;
    }
  }
  return count;
}

/**
 * Client-side checks mirroring the Worker's limits. Keys: origin, destination, dates, windowStart, windowEnd,
 * stay, passengers, adults, infants, outHours, retHours (see questionForField for where each one is shown).
 */
export function validateForm(form: SearchForm, today = todayISO()): Record<string, string> {
  const errors: Record<string, string> = {};
  const origin = form.origin.trim();
  const destination = form.destination.trim();
  if (!origin) errors.origin = "בחרו מאיפה טסים.";
  if (!destination) errors.destination = "בחרו לאן טסים.";
  if (origin && destination && origin.toLowerCase() === destination.toLowerCase()) errors.destination = "היעד צריך להיות שונה מהמוצא.";
  if (!form.windowStart || !form.windowEnd) errors.dates = "בחרו מתי טסים.";
  if (form.windowStart && form.windowStart < today) errors.windowStart = "התאריכים כבר עברו. בחרו מהיום והלאה.";
  if (form.windowStart && form.windowEnd) {
    const span = (Date.parse(`${form.windowEnd}T00:00:00Z`) - Date.parse(`${form.windowStart}T00:00:00Z`)) / 86_400_000;
    if (span < 1) errors.windowEnd = "סוף הטווח צריך להיות אחרי תחילתו.";
    if (span > LIMITS.maxWindowDays) errors.windowEnd = "בחרו טווח של עד 120 ימים.";
    const advance = (Date.parse(`${form.windowStart}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
    if (advance > LIMITS.maxAdvanceDays) errors.windowStart = "אפשר לחפש עד שנה מראש.";
  }
  if (form.stayMin < 1 || form.stayMax < form.stayMin || form.stayMax > LIMITS.maxStayNights) errors.stay = "מספר הלילות צריך להיות בין 1 ל־30, והמינימום לא גדול מהמקסימום.";
  const passengers = form.adults + form.children + form.infants;
  if (passengers > LIMITS.maxPassengers) errors.passengers = "אפשר לחפש עד 9 נוסעים.";
  if (form.adults < 1) errors.adults = "נדרש לפחות מבוגר אחד.";
  if (form.infants > form.adults) errors.infants = "מספר התינוקות לא יכול לעלות על מספר המבוגרים.";
  for (const [preset, custom, field] of [[form.outHoursPreset, form.customOut, "outHours"], [form.retHoursPreset, form.customRet, "retHours"]] as const) {
    if (preset === "custom" && custom[0] === custom[1]) errors[field] = "שעת ההתחלה והסיום צריכות להיות שונות.";
  }
  if (form.windowStart && form.windowEnd && form.stayMin >= 1 && form.stayMin <= form.stayMax && !errors.windowEnd) {
    const pairs = countValidPairs(form.windowStart, form.windowEnd, form.stayMin, form.stayMax);
    if (pairs === 0) errors.stay = "אין טיול באורך הזה שנכנס בטווח התאריכים. בחרו פחות לילות או טווח ארוך יותר.";
    else if (pairs > LIMITS.maxValidPairs) errors.dates = `יש ${pairs} צירופי תאריכים, והמקסימום הוא ${LIMITS.maxValidPairs}. קצרו את טווח התאריכים או צמצמו את מספר הלילות.`;
  }
  return errors;
}

export function toRequest(form: SearchForm): SearchRequest {
  const hours = hasHourPreferences(form);
  return {
    origin: form.origin.trim(), destination: form.destination.trim(),
    windowStart: form.windowStart, windowEnd: form.windowEnd,
    stayMin: form.stayMin, stayMax: form.stayMax,
    adults: form.adults, children: form.children, infants: form.infants,
    cabin: "economy", checkedBag: form.checkedBag,
    outHours: hoursFor(form.outHoursPreset, form.customOut, form.useCustomOut),
    retHours: hoursFor(form.retHoursPreset, form.customRet, form.useCustomRet),
    maxStops: hours ? form.maxStops : null,
    nearbyAirports: form.nearbyAirports,
  };
}

export function sameRequest(a: SearchRequest, b: SearchRequest): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function formatILS(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return "מחיר לא זמין";
  return `₪${Math.ceil(amount).toLocaleString("en-US")}`;
}

export function formatDate(value: string): string {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

/** "DD/MM" */
export function formatShortDate(value: string): string {
  if (!isoDate.test(value)) return "";
  const [, month, day] = value.split("-");
  return `${day}/${month}`;
}

export function formatDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return "משך לא ידוע";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} שע׳${rest ? ` ${rest} דק׳` : ""}` : `${rest} דק׳`;
}

export function trustedBookingUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return null;
    if (host === "aviasales.com" || host.endsWith(".aviasales.com")) return url.toString();
    if (host === "elal.com" || host.endsWith(".elal.com")) return url.toString();
  } catch { /* invalid URLs are never actionable */ }
  return null;
}

export function searchParamsFor(form: SearchForm): URLSearchParams {
  const params = new URLSearchParams({
    o: form.origin, d: form.destination, ws: form.windowStart, we: form.windowEnd,
    n: `${form.stayMin}-${form.stayMax}`, a: String(form.adults), c: String(form.children), i: String(form.infants),
  });
  if (form.originLabel) params.set("ol", form.originLabel);
  if (form.destinationLabel) params.set("dl", form.destinationLabel);
  if (form.checkedBag) params.set("bag", "1");
  const out = hoursFor(form.outHoursPreset, form.customOut, form.useCustomOut);
  const ret = hoursFor(form.retHoursPreset, form.customRet, form.useCustomRet);
  if (out) params.set("oh", out.join("-"));
  if (ret) params.set("rh", ret.join("-"));
  if (form.maxStops !== null && (out || ret)) params.set("st", String(form.maxStops));
  if (form.nearbyAirports) params.set("nb", "1");
  return params;
}

export function updateSearchUrl(form: SearchForm): void {
  history.replaceState(null, "", `${location.pathname}?${searchParamsFor(form).toString()}`);
}

function presetForHours(hours: [number, number] | null): string {
  if (!hours) return "none";
  for (const [key, value] of Object.entries(hourPresets)) {
    if (key !== "custom" && value && value[0] === hours[0] && value[1] === hours[1]) return key;
  }
  return "custom";
}

/** Reads a shared search from a query string. Returns null when the URL holds no search. */
export function parseSearchParams(search: string): SearchForm | null {
  const params = new URLSearchParams(search);
  if (!params.has("o") && !params.has("d")) return null;
  const stay = (params.get("n") ?? "").split("-").map(Number);
  const parseHours = (key: string): [number, number] | null => {
    const values = (params.get(key) ?? "").split("-").map(Number);
    return values.length === 2 && values.every((n) => Number.isInteger(n) && n >= 0 && n <= 24) && values[0] !== values[1] ? [values[0], values[1]] : null;
  };
  const out = parseHours("oh");
  const ret = parseHours("rh");
  const outPreset = presetForHours(out);
  const retPreset = presetForHours(ret);
  const num = (key: string) => (params.has(key) ? Number(params.get(key)) : undefined);
  return sanitizeForm({
    origin: params.get("o") ?? "", originLabel: params.get("ol") ?? "",
    destination: params.get("d") ?? "", destinationLabel: params.get("dl") ?? "",
    windowStart: params.get("ws") ?? "", windowEnd: params.get("we") ?? "",
    stayMin: stay[0], stayMax: stay[1] ?? stay[0],
    adults: num("a"), children: num("c"), infants: num("i"),
    checkedBag: params.get("bag") === "1", nearbyAirports: params.get("nb") === "1",
    outHoursPreset: outPreset, retHoursPreset: retPreset,
    customOut: out ?? [7, 15], customRet: ret ?? [7, 15],
    useCustomOut: outPreset === "custom", useCustomRet: retPreset === "custom",
    maxStops: params.has("st") ? Number(params.get("st")) : null,
  });
}

/**
 * A link carrying `fill=1` only fills the search form (the explore screen's "fill the search" button): it is not run
 * on arrival, so the user first checks who is flying. A shared search link without it runs as before.
 */
export const FILL_ONLY_PARAM = "fill";

export function isFillOnly(search: string): boolean {
  return new URLSearchParams(search).get(FILL_ONLY_PARAM) === "1";
}

/** The search page's address for a form that should be filled, not run. */
export function fillSearchHref(form: SearchForm): string {
  const params = searchParamsFor(form);
  params.set(FILL_ONLY_PARAM, "1");
  return `/?${params.toString()}`;
}

export function readSearchUrl(): SearchForm | null {
  return parseSearchParams(location.search);
}

const STORAGE_KEY = "eee.lastSearch.v2";

export function loadStoredForm(): SearchForm | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem("eee.lastSearch.v1");
    return stored ? sanitizeForm(JSON.parse(stored)) : null;
  } catch { return null; }
}

export function storeForm(form: SearchForm): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(form)); } catch { /* device storage is optional */ }
}

export function clearStoredForm(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem("eee.lastSearch.v1");
  } catch { /* device storage is optional */ }
}
