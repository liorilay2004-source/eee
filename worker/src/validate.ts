/**
 * Request validation for POST /api/search (SPEC §5 inputs, §4.1 defaults).
 *
 * Strict on types: a string where a number is expected is an error, never coerced. Unknown keys are ignored
 * (forward compatibility with a newer frontend); every known key is checked. All problems are collected so the
 * form can highlight every bad field at once.
 */
import type { Resolver } from "./airports/types";
import { countValidPairs, dayNumber } from "./splits";
import type { Cabin, SearchRequest } from "./types";

// Limits are constants, not magic numbers scattered through the checks.
export const MIN_WINDOW_DAYS = 1; // windowEnd - windowStart
export const MAX_WINDOW_DAYS = 120;
export const MAX_ADVANCE_DAYS = 365; // how far ahead the window may start (also bounds Travelpayouts month scans)
export const MIN_STAY_NIGHTS = 1;
export const MAX_STAY_NIGHTS = 30;
export const MAX_PASSENGERS = 9;
export const MAX_HOUR = 24;
export const MAX_STOPS = 5;
export const MAX_VALID_PAIRS = 400;
export const MAX_PLACE_TEXT_LEN = 64;

// HTTP-level limits used by index.ts (kept here because the Worker entry module may export nothing but its handler).
export const MAX_BODY_BYTES = 8 * 1024;
/** SPEC §14: 30 searches per 10 minutes per client. */
export const RATE_LIMIT_MAX = 30;
export const RATE_LIMIT_WINDOW_SECONDS = 600;
/**
 * Upstream budget across ALL clients: fresh Travelpayouts scans per window. The per-client limit cannot stop many
 * clients (or one with many networks) from each varying a parameter to dodge the cache and burn the API token's
 * quota; a scan costs up to 30 upstream requests, so this caps the total at a few thousand requests per window.
 */
export const GLOBAL_SCAN_LIMIT = 120;
export const GLOBAL_SCAN_WINDOW_SECONDS = 600;

const CABINS: readonly Cabin[] = ["economy", "premium-economy", "business", "first"];
/** The only cabin any fare source can price today (see the cabin check in parseSearchBody). */
const SUPPORTED_CABIN: Cabin = "economy";

export type ValidationCode = "invalid_request" | "destination_required";

export type ParseResult =
  | { ok: true; req: SearchRequest }
  | { ok: false; code: ValidationCode; fields: Record<string, string> };

export interface ValidateDeps {
  resolver: Resolver;
  now: Date;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Only own keys: an inherited property ("constructor", "__proto__") is never a field. */
function field(body: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(body, name) ? body[name] : undefined;
}

const missing = (v: unknown): boolean => v === undefined || v === null;

export function parseSearchBody(body: unknown, deps: ValidateDeps): ParseResult {
  if (!isRecord(body)) return { ok: false, code: "invalid_request", fields: { body: "must be a JSON object" } };

  const errors: Record<string, string> = {};
  const fail = (name: string, message: string): void => {
    if (!Object.hasOwn(errors, name)) errors[name] = message;
  };
  const failed = (...names: string[]): boolean => names.some((n) => Object.hasOwn(errors, n));

  /** Integer in [min, max]; absent/null takes the default (SPEC §4.1: unfilled basics = default). */
  const int = (name: string, min: number, max: number, dflt: number): number => {
    const v = field(body, name);
    if (missing(v)) return dflt;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      fail(name, "must be an integer");
      return dflt;
    }
    if (v < min || v > max) {
      fail(name, `must be between ${min} and ${max}`);
      return dflt;
    }
    return v;
  };

  const bool = (name: string, dflt: boolean): boolean => {
    const v = field(body, name);
    if (missing(v)) return dflt;
    if (typeof v !== "boolean") {
      fail(name, "must be true or false");
      return dflt;
    }
    return v;
  };

  /** [start, end) departure-hour window; absent/null = no restriction (SPEC §4.1 filters). */
  const hours = (name: string): [number, number] | null => {
    const v = field(body, name);
    if (missing(v)) return null;
    if (!Array.isArray(v) || v.length !== 2) {
      fail(name, "must be [startHour, endHour]");
      return null;
    }
    const [a, b] = v as unknown[];
    if (typeof a !== "number" || typeof b !== "number" || !Number.isInteger(a) || !Number.isInteger(b)) {
      fail(name, "hours must be integers");
      return null;
    }
    if (a < 0 || a > MAX_HOUR || b < 0 || b > MAX_HOUR) {
      fail(name, `hours must be between 0 and ${MAX_HOUR}`);
      return null;
    }
    if (a === b) {
      fail(name, "start and end hour must differ");
      return null;
    }
    return [a, b];
  };

  /**
   * Submitted text -> a place, strictly. A code or an exact name resolves as in the autocomplete; a fuzzy hit is NOT
   * accepted, because a search for the wrong destination looks exactly like a right one ("REP" -> Punta Cana).
   * A well-formed 3-letter code that the dataset does not know is passed on as an airport code (SPEC §4.3: any
   * airport worldwide); the pipeline already searches unknown codes as they are.
   */
  const place = (name: string, text: string): { code: string; city: string } | null => {
    if (text.length > MAX_PLACE_TEXT_LEN) {
      fail(name, `must be at most ${MAX_PLACE_TEXT_LEN} characters`);
      return null;
    }
    const match = deps.resolver.resolvePlace(text);
    if (match) {
      // An airport match searches just that airport; a city match expands to all its airports in the pipeline.
      return { code: match.airportCode ?? match.code, city: match.code };
    }
    if (/^[A-Za-z]{3}$/.test(text)) {
      const code = text.toUpperCase();
      return { code, city: code };
    }
    fail(name, "no matching city or airport");
    return null;
  };

  // --- places ---------------------------------------------------------------------------------------
  let origin: { code: string; city: string } | null = null;
  const rawOrigin = field(body, "origin");
  if (missing(rawOrigin) || (typeof rawOrigin === "string" && rawOrigin.trim() === "")) fail("origin", "is required");
  else if (typeof rawOrigin !== "string") fail("origin", "must be a string");
  else origin = place("origin", rawOrigin.trim());

  let destination: { code: string; city: string } | null = null;
  const rawDest = field(body, "destination");
  let destinationEmpty = false;
  if (missing(rawDest) || (typeof rawDest === "string" && rawDest.trim() === "")) {
    // TODO(Phase 2, SPEC §9): an empty destination becomes spontaneous mode ("where is cheapest?") instead of an error.
    destinationEmpty = true;
    fail("destination", "is required");
  } else if (typeof rawDest !== "string") fail("destination", "must be a string");
  else destination = place("destination", rawDest.trim());

  if (origin && destination && origin.city === destination.city) fail("destination", "must differ from origin");

  // --- dates ----------------------------------------------------------------------------------------
  const dateField = (name: string): string | null => {
    const v = field(body, name);
    if (missing(v)) {
      fail(name, "is required");
      return null;
    }
    if (typeof v !== "string" || dayNumber(v) === null) {
      fail(name, "must be a real date formatted YYYY-MM-DD");
      return null;
    }
    return v;
  };
  const windowStart = dateField("windowStart");
  const windowEnd = dateField("windowEnd");

  const stayMin = int("stayMin", MIN_STAY_NIGHTS, MAX_STAY_NIGHTS, 0);
  const stayMax = int("stayMax", MIN_STAY_NIGHTS, MAX_STAY_NIGHTS, 0);
  for (const name of ["stayMin", "stayMax"] as const) {
    if (missing(field(body, name))) fail(name, "is required");
  }
  const stayValid = !failed("stayMin", "stayMax");
  if (stayValid && stayMin > stayMax) fail("stayMax", "must be at least stayMin");

  const today = Math.floor(deps.now.getTime() / 86_400_000); // UTC day
  const startDay = windowStart === null ? null : dayNumber(windowStart);
  const endDay = windowEnd === null ? null : dayNumber(windowEnd);
  if (startDay !== null) {
    if (startDay < today) fail("windowStart", "must not be in the past");
    else if (startDay > today + MAX_ADVANCE_DAYS) fail("windowStart", `must be within ${MAX_ADVANCE_DAYS} days from today`);
  }
  if (startDay !== null && endDay !== null) {
    const span = endDay - startDay;
    if (span < MIN_WINDOW_DAYS) fail("windowEnd", "must be after windowStart");
    else if (span > MAX_WINDOW_DAYS) fail("windowEnd", `window must not exceed ${MAX_WINDOW_DAYS} days`);
    else if (stayValid && !failed("stayMax")) {
      const pairs = countValidPairs(windowStart as string, windowEnd as string, stayMin, stayMax);
      if (pairs === 0) fail("stayMin", "no trip of this length fits inside the window");
      else if (pairs > MAX_VALID_PAIRS) {
        fail("windowEnd", `too many date combinations (${pairs}, max ${MAX_VALID_PAIRS}): shorten the window or narrow the stay range`);
      }
    }
  }

  // --- passengers, cabin, extras, filters -----------------------------------------------------------
  const adults = int("adults", 1, MAX_PASSENGERS, 1);
  const children = int("children", 0, MAX_PASSENGERS, 0);
  const infants = int("infants", 0, MAX_PASSENGERS, 0);
  if (!failed("adults", "children", "infants")) {
    if (adults + children + infants > MAX_PASSENGERS) fail("adults", `at most ${MAX_PASSENGERS} passengers in total`);
    else if (infants > adults) fail("infants", "at most one infant per adult");
  }

  let cabin: Cabin = "economy";
  const rawCabin = field(body, "cabin");
  if (!missing(rawCabin)) {
    if (typeof rawCabin !== "string" || !(CABINS as readonly string[]).includes(rawCabin)) fail("cabin", `must be one of ${CABINS.join(", ")}`);
    // The fare source (Travelpayouts cached prices) cannot be asked for a cabin, so a business or first search would
    // silently show economy fares under the wrong label. Refuse it until a source can price the cabin.
    else if (rawCabin !== SUPPORTED_CABIN) fail("cabin", `only ${SUPPORTED_CABIN} fares are available at the moment`);
    else cabin = rawCabin as Cabin;
  }

  const checkedBag = bool("checkedBag", false);
  const outHours = hours("outHours");
  const retHours = hours("retHours");
  const maxStopsRaw = field(body, "maxStops");
  const maxStops = missing(maxStopsRaw) ? null : int("maxStops", 0, MAX_STOPS, 0);
  const nearbyAirports = bool("nearbyAirports", false);

  if (Object.keys(errors).length > 0 || !origin || !destination || windowStart === null || windowEnd === null) {
    return { ok: false, code: destinationEmpty ? "destination_required" : "invalid_request", fields: errors };
  }

  return {
    ok: true,
    req: {
      origin: origin.code,
      destination: destination.code,
      windowStart,
      windowEnd,
      stayMin,
      stayMax,
      adults,
      children,
      infants,
      cabin,
      checkedBag,
      outHours,
      retHours,
      maxStops,
      nearbyAirports,
    },
  };
}
