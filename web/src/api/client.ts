import { API_BASE } from "../config";
import type {
  AirportSuggestion, ApiError, CalendarResponse, CreateWatchRequest, CreateWatchResponse, DealsResponse, ExploreResponse,
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

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // An abort while the body is still streaming is a cancellation, not a server error: let callers see it as one.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new RequestError(response.status, {});
  }
  if (!response.ok) throw new RequestError(response.status, body as ApiError);
  return body as T;
}

/** API_BASE is "" in dev (Vite proxies /api), so the URL needs the page origin as its base. */
function apiUrl(path: string, params?: Record<string, string>): URL {
  const url = new URL(`${API_BASE}${path}`, location.origin);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  return url;
}

async function getJson<T>(path: string, params: Record<string, string> | undefined, signal?: AbortSignal): Promise<T> {
  return readJson<T>(await fetch(apiUrl(path, params), { signal, cache: "no-store" }));
}

export async function findAirports(query: string, signal: AbortSignal): Promise<AirportSuggestion[]> {
  const data = await getJson<{ results: AirportSuggestion[] }>("/api/airports", { q: query, limit: "8" }, signal);
  return data.results;
}

export async function searchFlights(request: SearchRequest, signal: AbortSignal): Promise<SearchResponse> {
  const response = await fetch(`${API_BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
    cache: "no-store",
  });
  return readJson<SearchResponse>(response);
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

export async function createWatch(body: CreateWatchRequest, signal?: AbortSignal): Promise<CreateWatchResponse> {
  const response = await fetch(`${API_BASE}/api/watches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
  });
  return readJson<CreateWatchResponse>(response);
}

/** The token travels only in the request path to the API, never in a page URL. */
export function getWatch(token: string, signal?: AbortSignal): Promise<GetWatchResponse> {
  return getJson<GetWatchResponse>(`/api/watches/${encodeURIComponent(token)}`, undefined, signal);
}

export async function deleteWatch(token: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(apiUrl(`/api/watches/${encodeURIComponent(token)}`), { method: "DELETE", signal, cache: "no-store" });
  await readJson<{ deleted: boolean }>(response);
}
