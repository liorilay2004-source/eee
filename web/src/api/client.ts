import { API_BASE } from "../config";
import type { AirportSuggestion, ApiError, SearchRequest, SearchResponse } from "./contract";

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
  } catch {
    throw new RequestError(response.status, {});
  }
  if (!response.ok) throw new RequestError(response.status, body as ApiError);
  return body as T;
}

export async function findAirports(query: string, signal: AbortSignal): Promise<AirportSuggestion[]> {
  const url = new URL(`${API_BASE}/api/airports`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "8");
  const data = await readJson<{ results: AirportSuggestion[] }>(await fetch(url, { signal, cache: "no-store" }));
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
