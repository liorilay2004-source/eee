/**
 * The API client. EVERY request to the API goes through apiCall() (getJson/postJson for the usual shapes), or through
 * checkAccess() for the lock's own check: that is what puts the private-use lock's key in the Authorization header and
 * reads the lock's answers. A new call that used fetch() directly would go out without the key and fail (401) once the lock
 * is on; lib/client-guard.test.ts fails on any fetch() outside these two.
 */
import { API_BASE } from "../config";
import { clearAccessKey, emitAccessEvent, getAccessKey } from "../lib/access-key";
import type {
  AirportLookup, AirportSuggestion, ApiError, CountrySuggestion, CalendarResponse, CreateWatchRequest, CreateWatchResponse, DealsResponse, ExploreResponse,
  GetWatchResponse, SearchRequest, SearchResponse,
} from "./contract";

export class RequestError extends Error {
  code: string;
  status: number;
  retryAfterSec?: number;
  fields?: Record<string, string>;

  constructor(status: number, payload: ApiError) {
    super(payload.error?.message ?? "Request failed");
    this.name = "RequestError";
    this.status = status;
    this.code = payload.error?.code ?? "request_failed";
    this.retryAfterSec = payload.error?.retryAfterSec;
    this.fields = payload.error?.fields;
  }
}

const isAbortError = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

const positiveOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;

/**
 * The private-use lock (worker/src/access.ts): the key stored on this device rides in the Authorization header of every API
 * call, and only there (never in a URL). Without a stored key no header is added, so the request stays exactly what it was
 * before the lock existed, and an API without the lock keeps working.
 */
function withAccessKey(key: string | null, headers?: Record<string, string>): Headers {
  const out = new Headers(headers);
  if (key !== null) out.set("Authorization", `Bearer ${key}`);
  return out;
}

/**
 * The lock's answers, whichever call meets them: 401 = the key is missing or no longer right, so it is forgotten and the lock
 * screen shown; 429 too_many_attempts = the wait; 503 access_misconfigured = the owner must fix the key on the server. An
 * answer to a key that was replaced or removed meanwhile (the user just logged in or out) changes nothing.
 */
function noticeAccessAnswer(status: number, payload: ApiError, sentKey: string | null): void {
  if (getAccessKey() !== sentKey) return;
  const code = payload.error?.code;
  if (status === 401) {
    if (sentKey !== null) clearAccessKey();
    emitAccessEvent({ type: "lock", reason: { kind: "unauthorized", hadKey: sentKey !== null } });
  } else if (status === 429 && code === "too_many_attempts") {
    emitAccessEvent({ type: "lock", reason: { kind: "too_many_attempts", retryAfterSec: positiveOrNull(payload.error?.retryAfterSec) } });
  } else if (status === 503 && code === "access_misconfigured") {
    emitAccessEvent({ type: "lock", reason: { kind: "misconfigured", reason: typeof payload.error?.reason === "string" ? payload.error.reason : null } });
  }
}

async function readJson<T>(response: Response, sentKey: string | null): Promise<T> {
  let body: unknown;
  let parsed = true;
  try {
    body = await response.json();
  } catch (error) {
    // An abort while the body is still streaming is a cancellation, not a server error: let callers see it as one.
    if (isAbortError(error)) throw error;
    parsed = false;
  }
  if (!response.ok) {
    const payload = (parsed && typeof body === "object" && body !== null ? body : {}) as ApiError;
    noticeAccessAnswer(response.status, payload, sentKey);
    throw new RequestError(response.status, payload);
  }
  if (!parsed) throw new RequestError(response.status, {});
  return body as T;
}

/** API_BASE is "" in dev (Vite proxies /api), so the URL needs the page origin as its base. */
function apiUrl(path: string, params?: Record<string, string>): URL {
  const url = new URL(`${API_BASE}${path}`, location.origin);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  return url;
}

interface CallInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** Every API call goes through here: the stored key in its header, and never from or into the HTTP cache. */
async function apiCall<T>(url: URL, init: CallInit = {}): Promise<T> {
  const key = getAccessKey();
  const response = await fetch(url, { method: init.method, headers: withAccessKey(key, init.headers), body: init.body, signal: init.signal, cache: "no-store" });
  return readJson<T>(response, key);
}

// async, so that anything thrown while building the request (the URL, JSON.stringify) is a rejection, as it always was.
async function getJson<T>(path: string, params: Record<string, string> | undefined, signal?: AbortSignal): Promise<T> {
  return apiCall<T>(apiUrl(path, params), { signal });
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return apiCall<T>(apiUrl(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
}

/** Keeps only well-formed country suggestions with at least one airport; anything else (older API: absent) -> []. */
export function cleanCountries(raw: unknown): CountrySuggestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is CountrySuggestion => {
    if (!c || typeof c !== "object") return false;
    const x = c as Partial<CountrySuggestion>;
    return x.type === "country" && typeof x.code === "string" && typeof x.nameHe === "string"
      && Array.isArray(x.places) && x.places.length > 0
      && x.places.every((p) => p && typeof p.code === "string" && /^[A-Z]{3}$/.test(p.code));
  });
}

export async function findAirports(query: string, signal: AbortSignal): Promise<AirportLookup> {
  const data = await getJson<{ results?: AirportSuggestion[]; countries?: unknown }>("/api/airports", { q: query, limit: "8" }, signal);
  return { results: Array.isArray(data.results) ? data.results : [], countries: cleanCountries(data.countries) };
}

export function searchFlights(request: SearchRequest, signal: AbortSignal): Promise<SearchResponse> {
  return postJson<SearchResponse>("/api/search", request, signal);
}

export function fetchExplore(params: Record<string, string>, signal: AbortSignal): Promise<ExploreResponse> {
  return getJson<ExploreResponse>("/api/explore", params, signal);
}

export function fetchCalendar(params: Record<string, string>, signal: AbortSignal): Promise<CalendarResponse> {
  return getJson<CalendarResponse>("/api/calendar", params, signal);
}

export function fetchDeals(signal: AbortSignal): Promise<DealsResponse> {
  return getJson<DealsResponse>("/api/deals", undefined, signal);
}

export function createWatch(body: CreateWatchRequest, signal?: AbortSignal): Promise<CreateWatchResponse> {
  return postJson<CreateWatchResponse>("/api/watches", body, signal);
}

/** The token travels only in the request path to the API, never in a page URL. */
export function getWatch(token: string, signal?: AbortSignal): Promise<GetWatchResponse> {
  return getJson<GetWatchResponse>(`/api/watches/${encodeURIComponent(token)}`, undefined, signal);
}

export async function deleteWatch(token: string, signal?: AbortSignal): Promise<void> {
  await apiCall<{ deleted: boolean }>(apiUrl(`/api/watches/${encodeURIComponent(token)}`), { method: "DELETE", signal });
}

// --- the private-use lock ----------------------------------------------------------------------------------

/** What GET /api/auth/check said about a key (or about no key). */
export type AccessCheck =
  /** 2xx: this key is let in, or the lock is off and everyone is. */
  | { kind: "open" }
  /** 404: an API from before the lock (the route does not exist), so there is nothing to unlock. */
  | { kind: "no_lock" }
  | { kind: "unauthorized" }
  | { kind: "too_many_attempts"; retryAfterSec: number | null }
  | { kind: "misconfigured"; reason: string | null }
  /** Unreachable (offline, DNS, or a CORS refusal, which a browser reports the same way). */
  | { kind: "network" }
  | { kind: "error"; status: number };

/**
 * How long the access check may take. The app waits for it before showing anything when no key is stored, so a stalled
 * connection must not keep the page on "בודקים גישה…": past this, the check counts as unreachable ("network"), the app
 * shows, and its own screens say the service cannot be reached. Nothing is exposed by that: with the lock on, the app's
 * first API call answers 401 and brings the lock screen.
 */
export const ACCESS_CHECK_TIMEOUT_MS = 8_000;

/**
 * Asks the API whether `key` (null = no key) opens it. Reports nothing to the app and stores nothing: the caller decides
 * (lib/access.ts). Throws only when the caller aborts; no answer within `timeoutMs` is "network".
 */
export async function checkAccess(key: string | null, signal?: AbortSignal, timeoutMs = ACCESS_CHECK_TIMEOUT_MS): Promise<AccessCheck> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const passAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", passAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(apiUrl("/api/auth/check"), { headers: withAccessKey(key), signal: controller.signal, cache: "no-store" });
    if (response.ok) return { kind: "open" };
    if (response.status === 404) return { kind: "no_lock" };
    if (response.status === 401) return { kind: "unauthorized" };
    const payload = ((await response.json().catch((error: unknown) => {
      if (isAbortError(error)) throw error; // the timeout or the caller, while the body was still arriving
      return null;
    })) ?? {}) as ApiError;
    if (response.status === 429) {
      const retryAfterSec = positiveOrNull(payload.error?.retryAfterSec) ?? positiveOrNull(Number(response.headers.get("Retry-After")));
      return { kind: "too_many_attempts", retryAfterSec };
    }
    if (response.status === 503 && payload.error?.code === "access_misconfigured") {
      return { kind: "misconfigured", reason: typeof payload.error.reason === "string" ? payload.error.reason : null };
    }
    return { kind: "error", status: response.status };
  } catch (error) {
    if (!timedOut && (signal?.aborted || isAbortError(error))) throw error; // the caller gave up: a newer check runs
    return { kind: "network" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", passAbort);
  }
}
