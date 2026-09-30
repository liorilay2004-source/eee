import { airlineFromTokens } from "./airlines/openflights";
import { sourceRegistry } from "./source-registry";
import { sha256Hex } from "./pipeline";
import { clientIdentity, limiterSalt } from "./ratelimit";
import type { Env, FlightLinkMemory, FlightLinkParse, FlightLinkRequest, FlightLinkResponse, SearchRequest } from "./types";

const MAX_URL_LENGTH = 2048;
const RECENT_LIMIT = 8;
const IATA = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SENSITIVE_PARAM = /(token|session|auth|key|secret|pass(word)?|email|mail|phone|tel|name|passport|document|cookie|jwt|signature|sig)/i;

type JsonReader = () => Promise<{ ok: true; value: unknown } | { ok: false; result: { status: number; body?: unknown; headers?: Record<string, string> } }>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cleanHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function canonicalUrl(value: unknown): { ok: true; url: URL; sanitized: string } | { ok: false; code: string; message: string; fields: Record<string, string> } {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, code: "link_required", message: "Flight link is required", fields: { url: "הדביקו קישור לטיסה" } };
  }
  if (value.length > MAX_URL_LENGTH) {
    return { ok: false, code: "link_too_long", message: "Flight link is too long", fields: { url: "הקישור ארוך מדי" } };
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, code: "invalid_link", message: "Flight link is invalid", fields: { url: "הקישור לא תקין" } };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, code: "unsupported_link", message: "Only web links are supported", fields: { url: "אפשר להדביק רק קישור אתר" } };
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_PARAM.test(key)) url.searchParams.delete(key);
  }
  const sanitized = url.toString().slice(0, MAX_URL_LENGTH);
  return { ok: true, url, sanitized };
}

function sourceFor(url: URL): { id: string | null; name: string; host: string } {
  const host = cleanHost(url.hostname);
  const sources = sourceRegistry();
  const exact = sources.find((s) => {
    try {
      const sourceHost = cleanHost(new URL(s.homeUrl).hostname);
      return host === sourceHost || host.endsWith(`.${sourceHost}`) || sourceHost.endsWith(`.${host}`);
    } catch {
      return false;
    }
  });
  if (exact) return { id: exact.id, name: exact.name, host };
  const label = host.split(".").slice(0, -1).join(".") || host;
  return { id: null, name: label.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), host };
}

function tokensFromUrl(url: URL): string[] {
  const parts: string[] = [];
  parts.push(...url.pathname.split(/[\/_.~:-]+/));
  for (const [key, value] of url.searchParams) parts.push(key, value);
  return parts.flatMap((p) => p.split(/[^A-Za-z0-9-]+/)).filter(Boolean);
}

function firstDates(tokens: string[]): { departDate: string | null; returnDate: string | null } {
  const dates = tokens
    .map((t) => t.match(/\d{4}-\d{2}-\d{2}|\d{8}/)?.[0] ?? null)
    .filter((d): d is string => d !== null)
    .map((d) => d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d)
    .filter((d) => DATE_RE.test(d));
  return { departDate: dates[0] ?? null, returnDate: dates.find((d, i) => i > 0 && d !== dates[0]) ?? null };
}

function firstIataPair(tokens: string[]): { origin: string | null; destination: string | null } {
  const codes: string[] = [];
  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (IATA.test(upper) && !codes.includes(upper)) codes.push(upper);
    const compact = /^[A-Z]{6}$/.test(upper) ? upper : null;
    if (compact) {
      for (const code of [compact.slice(0, 3), compact.slice(3, 6)]) if (!codes.includes(code)) codes.push(code);
    }
    if (codes.length >= 2) break;
  }
  return { origin: codes[0] ?? null, destination: codes[1] ?? null };
}

function parseFlightLink(url: URL): FlightLinkParse {
  const source = sourceFor(url);
  const tokens = tokensFromUrl(url);
  const airline = airlineFromTokens(tokens, [source.name, source.host]);
  return {
    ...source,
    ...firstIataPair(tokens),
    ...firstDates(tokens),
    airlineIata: airline?.iata ?? null,
    airlineIcao: airline?.icao ?? null,
    airlineName: airline?.name ?? null,
  };
}

function cleanSearchRequest(value: unknown): SearchRequest | null {
  if (!isRecord(value)) return null;
  const origin = typeof value.origin === "string" && IATA.test(value.origin.toUpperCase()) ? value.origin.toUpperCase() : null;
  const destination = typeof value.destination === "string" && IATA.test(value.destination.toUpperCase()) ? value.destination.toUpperCase() : null;
  const windowStart = typeof value.windowStart === "string" && DATE_RE.test(value.windowStart) ? value.windowStart : null;
  const windowEnd = typeof value.windowEnd === "string" && DATE_RE.test(value.windowEnd) ? value.windowEnd : null;
  if (!origin || !destination || !windowStart || !windowEnd) return null;
  return value as unknown as SearchRequest;
}

function rowToMemory(row: Record<string, unknown>): FlightLinkMemory {
  return {
    id: Number(row.id),
    url: String(row.url),
    host: String(row.host),
    sourceId: typeof row.source_id === "string" ? row.source_id : null,
    sourceName: String(row.source_name),
    origin: typeof row.origin === "string" ? row.origin : null,
    destination: typeof row.destination === "string" ? row.destination : null,
    departDate: typeof row.depart_date === "string" ? row.depart_date : null,
    returnDate: typeof row.return_date === "string" ? row.return_date : null,
    airlineIata: typeof row.airline_iata === "string" ? row.airline_iata : null,
    airlineIcao: typeof row.airline_icao === "string" ? row.airline_icao : null,
    airlineName: typeof row.airline_name === "string" ? row.airline_name : null,
    checkedAt: String(row.checked_at),
  };
}

export async function handleFlightLinks(deps: { env: Env; now: Date; ip: string }, method: "GET" | "POST", readJson: JsonReader): Promise<{ status: number; body?: unknown; headers?: Record<string, string> }> {
  const clientHash = await sha256Hex(`${clientIdentity(deps.ip)}|${limiterSalt(deps.env)}|flight-link`);
  if (method === "GET") {
    const rows = await deps.env.DB.prepare(
      "SELECT id, url, host, source_id, source_name, origin, destination, depart_date, return_date, airline_iata, airline_icao, airline_name, checked_at FROM flight_links WHERE client_hash = ? ORDER BY checked_at DESC, id DESC LIMIT ?",
    ).bind(clientHash, RECENT_LIMIT).all<Record<string, unknown>>();
    return { status: 200, body: { links: rows.results.map(rowToMemory), generatedAt: deps.now.toISOString() } };
  }

  const parsedBody = await readJson();
  if (!parsedBody.ok) return parsedBody.result;
  const body = parsedBody.value;
  if (!isRecord(body)) return { status: 400, body: { error: { code: "invalid_json", message: "Request body must be an object" } } };
  const urlResult = canonicalUrl(body.url);
  if (!urlResult.ok) return { status: 400, body: { error: { code: urlResult.code, message: urlResult.message, fields: urlResult.fields } } };

  const parsed = parseFlightLink(urlResult.url);
  const request = cleanSearchRequest(body.search);
  const memory: Omit<FlightLinkMemory, "id"> = {
    url: urlResult.sanitized,
    host: parsed.host,
    sourceId: parsed.id,
    sourceName: parsed.name,
    origin: request?.origin ?? parsed.origin ?? null,
    destination: request?.destination ?? parsed.destination ?? null,
    departDate: parsed.departDate ?? request?.windowStart ?? null,
    returnDate: parsed.returnDate ?? request?.windowEnd ?? null,
    airlineIata: parsed.airlineIata,
    airlineIcao: parsed.airlineIcao,
    airlineName: parsed.airlineName,
    checkedAt: deps.now.toISOString(),
  };
  const res = await deps.env.DB.prepare(
    "INSERT INTO flight_links (client_hash, url, host, source_id, source_name, origin, destination, depart_date, return_date, airline_iata, airline_icao, airline_name, request_json, checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    clientHash,
    memory.url,
    memory.host,
    memory.sourceId,
    memory.sourceName,
    memory.origin,
    memory.destination,
    memory.departDate,
    memory.returnDate,
    memory.airlineIata,
    memory.airlineIcao,
    memory.airlineName,
    request ? JSON.stringify(request) : null,
    memory.checkedAt,
    memory.checkedAt,
  ).run();
  const saved: FlightLinkMemory = { id: Number(res.meta.last_row_id), ...memory };
  const recent = await deps.env.DB.prepare(
    "SELECT id, url, host, source_id, source_name, origin, destination, depart_date, return_date, airline_iata, airline_icao, airline_name, checked_at FROM flight_links WHERE client_hash = ? ORDER BY checked_at DESC, id DESC LIMIT ?",
  ).bind(clientHash, RECENT_LIMIT).all<Record<string, unknown>>();
  return { status: 201, body: { saved, parse: parsed, links: recent.results.map(rowToMemory) } satisfies FlightLinkResponse };
}

