import { LIMITS } from "../config";
import type { SearchRequest } from "../api/contract";

export interface SearchForm {
  origin: string;
  destination: string;
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

export const todayISO = () => new Date().toISOString().slice(0, 10);

export function emptyForm(): SearchForm {
  return {
    origin: "", destination: "", windowStart: "", windowEnd: "", stayMin: 5, stayMax: 7,
    adults: 1, children: 0, infants: 0, checkedBag: false,
    outHoursPreset: "none", retHoursPreset: "none", customOut: [7, 15], customRet: [7, 15],
    useCustomOut: false, useCustomRet: false, maxStops: null, nearbyAirports: false,
  };
}

export function hoursFor(preset: string, custom: [number, number], enabled: boolean): [number, number] | null {
  if (preset === "custom") return enabled && custom[0] !== custom[1] ? custom : null;
  return hourPresets[preset] ?? null;
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

export function validateForm(form: SearchForm): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.origin.trim()) errors.origin = "בחרו עיר או שדה תעופה מהמוצעים.";
  if (!form.destination.trim()) errors.destination = "בחרו יעד מהמוצעים.";
  if (form.origin.trim().toLowerCase() === form.destination.trim().toLowerCase()) errors.destination = "המוצא והיעד צריכים להיות שונים.";
  if (!form.windowStart || !form.windowEnd) errors.dates = "בחרו את תחילת וסוף טווח התאריכים.";
  if (form.windowStart && form.windowStart < todayISO()) errors.windowStart = "תאריך היציאה צריך להיות היום או בעתיד.";
  if (form.windowStart && form.windowEnd) {
    const span = (Date.parse(`${form.windowEnd}T00:00:00Z`) - Date.parse(`${form.windowStart}T00:00:00Z`)) / 86_400_000;
    if (span < 1) errors.windowEnd = "תאריך החזרה המאוחר צריך להיות אחרי תאריך היציאה.";
    if (span > LIMITS.maxWindowDays) errors.windowEnd = "בחרו טווח של עד 120 ימים.";
    const advance = (Date.parse(`${form.windowStart}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / 86_400_000;
    if (advance > LIMITS.maxAdvanceDays) errors.windowStart = "אפשר לחפש עד שנה מראש.";
  }
  if (form.stayMin < 1 || form.stayMax < form.stayMin || form.stayMax > LIMITS.maxStayNights) errors.stay = "טווח הלילות צריך להיות בין 1 ל־30, כשהמינימום אינו גדול מהמקסימום.";
  const passengers = form.adults + form.children + form.infants;
  if (passengers > LIMITS.maxPassengers) errors.passengers = "אפשר לחפש עד 9 נוסעים.";
  if (form.adults < 1) errors.adults = "נדרש לפחות מבוגר אחד.";
  if (form.infants > form.adults) errors.infants = "מספר התינוקות לא יכול לעלות על מספר המבוגרים.";
  for (const [preset, custom, field] of [[form.outHoursPreset, form.customOut, "outHours"], [form.retHoursPreset, form.customRet, "retHours"]] as const) {
    if (preset === "custom" && custom[0] === custom[1]) errors[field] = "שעת ההתחלה והסיום צריכות להיות שונות.";
  }
  if (form.windowStart && form.windowEnd && form.stayMin <= form.stayMax) {
    const pairs = countValidPairs(form.windowStart, form.windowEnd, form.stayMin, form.stayMax);
    if (pairs === 0) errors.dates = "אין צירופי תאריכים שמתאימים למספר הלילות שבחרתם.";
    else if (pairs > LIMITS.maxValidPairs) errors.dates = "יש יותר מדי צירופים אפשריים — קצרו את טווח התאריכים.";
  }
  return errors;
}

export function toRequest(form: SearchForm): SearchRequest {
  return {
    origin: form.origin.trim(), destination: form.destination.trim(),
    windowStart: form.windowStart, windowEnd: form.windowEnd,
    stayMin: form.stayMin, stayMax: form.stayMax,
    adults: form.adults, children: form.children, infants: form.infants,
    cabin: "economy", checkedBag: form.checkedBag,
    outHours: hoursFor(form.outHoursPreset, form.customOut, form.useCustomOut),
    retHours: hoursFor(form.retHoursPreset, form.customRet, form.useCustomRet),
    maxStops: form.outHoursPreset === "none" && form.retHoursPreset === "none" ? null : form.maxStops,
    nearbyAirports: form.nearbyAirports,
  };
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

export function formatDuration(minutes: number | null): string {
  if (minutes === null) return "משך לא ידוע";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} שע׳${rest ? ` ${rest} דק׳` : ""}` : `${rest} דק׳`;
}

export function trustedBookingUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return null;
    if (host === "aviasales.com" || host.endsWith(".aviasales.com")) return url.toString();
  } catch { /* invalid URLs are never actionable */ }
  return null;
}

export function updateSearchUrl(form: SearchForm): void {
  const params = new URLSearchParams({
    o: form.origin, d: form.destination, ws: form.windowStart, we: form.windowEnd,
    n: `${form.stayMin}-${form.stayMax}`, a: String(form.adults), c: String(form.children), i: String(form.infants),
  });
  if (form.checkedBag) params.set("bag", "1");
  if (form.outHoursPreset !== "none") params.set("oh", hoursFor(form.outHoursPreset, form.customOut, form.useCustomOut)!.join("-"));
  if (form.retHoursPreset !== "none") params.set("rh", hoursFor(form.retHoursPreset, form.customRet, form.useCustomRet)!.join("-"));
  if (form.maxStops !== null) params.set("st", String(form.maxStops));
  if (form.nearbyAirports) params.set("nb", "1");
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
}

export function readSearchUrl(): Partial<SearchForm> {
  const params = new URLSearchParams(location.search);
  if (!params.has("o") && !params.has("d")) return {};
  const stay = (params.get("n") ?? "5-7").split("-").map(Number);
  const parseHours = (key: string): [number, number] | null => {
    const values = (params.get(key) ?? "").split("-").map(Number);
    return values.length === 2 && values.every(Number.isInteger) ? [values[0], values[1]] : null;
  };
  const out = parseHours("oh");
  const ret = parseHours("rh");
  return {
    ...emptyForm(), origin: params.get("o") ?? "", destination: params.get("d") ?? "",
    windowStart: params.get("ws") ?? "", windowEnd: params.get("we") ?? "",
    stayMin: stay[0] || 5, stayMax: stay[1] || stay[0] || 7,
    adults: Number(params.get("a") ?? 1), children: Number(params.get("c") ?? 0), infants: Number(params.get("i") ?? 0),
    checkedBag: params.get("bag") === "1", nearbyAirports: params.get("nb") === "1",
    outHoursPreset: out ? "custom" : "none", retHoursPreset: ret ? "custom" : "none",
    customOut: out ?? [7, 15], customRet: ret ?? [7, 15],
    useCustomOut: Boolean(out), useCustomRet: Boolean(ret),
    maxStops: params.has("st") ? Number(params.get("st")) : null,
  };
}
