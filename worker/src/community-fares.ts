import { clientIdentity, limiterSalt } from "./ratelimit";
import { createRepo } from "./db";
import { sha256Hex } from "./pipeline";
import { sourceRegistry } from "./source-registry";
import type { CommunityFareObservation, Env } from "./types";

const IATA = /^[A-Z]{3}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92;
const MAX_RESULTS = 50;
const RETENTION_MS = 7 * 86_400_000;
const CURRENCIES = new Set(["ILS", "USD", "EUR", "GBP", "CHF", "JPY", "KRW", "TWD", "CNY", "INR", "AED", "TRY", "PLN", "CAD", "AUD"]);
interface ApiResult { status: number; body?: unknown; headers?: Record<string, string> }
const json = (status: number, body: unknown, headers: Record<string, string> = {}): ApiResult => ({ status, body, ...(Object.keys(headers).length ? { headers } : {}) });
const isDay = (value: unknown): value is string => typeof value === "string" && ISO_DAY.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const cleanHost = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 253 || value !== value.toLowerCase()) return null;
  return /^[a-z0-9.-]+$/.test(value) && !value.startsWith(".") && !value.endsWith(".") && !value.includes("..") ? value : null;
};
const airlineHosts = () => sourceRegistry().filter((source) => source.kind === "airline").flatMap((source) => {
  try { return [new URL(source.homeUrl).hostname.toLowerCase().replace(/^www\./, "")]; } catch { return []; }
});
const domainKey = (host: string) => host.replace(/^www\./, "");
const allowedHost = (host: string) => airlineHosts().some((base) => domainKey(host) === domainKey(base));

interface ObservationInput {
  host: string;
  origin: string;
  destination: string;
  departDate: string;
  returnDate: string;
  priceAmount: number;
  currency: string;
}

function parseObservation(value: unknown): ObservationInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const host = cleanHost(row.host);
  if (!host || !allowedHost(host) || typeof row.origin !== "string" || !IATA.test(row.origin)
    || typeof row.destination !== "string" || !IATA.test(row.destination) || row.origin === row.destination
    || !isDay(row.departDate) || !isDay(row.returnDate) || row.returnDate <= row.departDate
    || typeof row.priceAmount !== "number" || !Number.isFinite(row.priceAmount) || row.priceAmount < 1 || row.priceAmount > 250_000
    || typeof row.currency !== "string" || !CURRENCIES.has(row.currency)) return null;
  return { host, origin: row.origin, destination: row.destination, departDate: row.departDate, returnDate: row.returnDate, priceAmount: Math.round(row.priceAmount * 100) / 100, currency: row.currency };
}

async function clientHash(env: Env, ip: string): Promise<string> {
  return sha256Hex(`${clientIdentity(ip)}|${limiterSalt(env)}|community-fares`);
}

export async function handleCommunityFares(request: Request, env: Env, now: Date, ip: string): Promise<ApiResult> {
  const hash = await clientHash(env, ip);
  if (request.method === "POST") {
    if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return json(415, { error: { code: "unsupported_media_type", message: "Content-Type must be application/json" } });
    let raw: unknown;
    try {
      const declared = request.headers.get("Content-Length");
      if (declared !== null && Number(declared) > 8192) return json(413, { error: { code: "payload_too_large", message: "Request body is too large" } });
      if (!request.body) return json(400, { error: { code: "invalid_json", message: "Request body is required" } });
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 8192) { await reader.cancel(); return json(413, { error: { code: "payload_too_large", message: "Request body is too large" } }); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    } catch { return json(400, { error: { code: "invalid_json", message: "Request body is not valid JSON" } }); }
    const observation = parseObservation(raw);
    if (!observation) return json(400, { error: { code: "invalid_observation", message: "The fare observation is invalid" } });
    const allowed = await createRepo(env.DB).claimWindowLock(`community-fare:${hash}`, 60, now);
    if (!allowed) return json(429, { error: { code: "rate_limited", message: "Try sharing again in a minute", retryAfterSec: 60 } }, { "Retry-After": "60" });
    try {
      await env.DB.prepare(`INSERT INTO community_fares
        (client_hash, host, origin, destination, depart_date, return_date, price_amount, currency, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(client_hash, host, origin, destination, depart_date, return_date)
        DO UPDATE SET price_amount=excluded.price_amount, currency=excluded.currency, observed_at=excluded.observed_at`)
        .bind(hash, observation.host, observation.origin, observation.destination, observation.departDate, observation.returnDate, observation.priceAmount, observation.currency, now.toISOString()).run();
    } catch { return json(503, { error: { code: "storage_unavailable", message: "Could not save the observation" } }); }
    return json(201, { saved: true, observation: { ...observation, observedAt: now.toISOString(), verification: "unverified", link: `https://${observation.host}/` } });
  }
  if (request.method !== "GET") return json(405, { error: { code: "method_not_allowed", message: "Method not allowed" } }, { Allow: "GET, POST, OPTIONS" });
  const url = new URL(request.url);
  const origin = url.searchParams.get("origin");
  const destination = url.searchParams.get("destination");
  const windowStart = url.searchParams.get("windowStart");
  const windowEnd = url.searchParams.get("windowEnd");
  const stayMin = Number(url.searchParams.get("stayMin"));
  const stayMax = Number(url.searchParams.get("stayMax"));
  if (!origin || !IATA.test(origin) || !destination || !IATA.test(destination) || origin === destination
    || !isDay(windowStart) || !isDay(windowEnd) || windowStart > windowEnd
    || !Number.isInteger(stayMin) || stayMin < 1 || !Number.isInteger(stayMax) || stayMax < stayMin || stayMax > 62
    || (Date.parse(`${windowEnd}T00:00:00Z`) - Date.parse(`${windowStart}T00:00:00Z`)) / 86_400_000 > MAX_RANGE_DAYS) {
    return json(400, { error: { code: "invalid_query", message: "A valid route, date range and stay range are required" } });
  }
  const readLimit = await createRepo(env.DB).checkRateLimit(`community-fares-read:${hash}`, 30, 600, now);
  if (!readLimit.allowed) return json(429, { error: { code: "rate_limited", message: "Too many observation queries", retryAfterSec: readLimit.retryAfterSec } }, { "Retry-After": String(readLimit.retryAfterSec) });
  try {
    const since = new Date(now.getTime() - RETENTION_MS).toISOString();
    const rows = await env.DB.prepare(`SELECT host, origin, destination, depart_date, return_date, price_amount, currency,
        COUNT(DISTINCT client_hash) AS observations, MAX(observed_at) AS observed_at
      FROM community_fares
      WHERE origin=? AND destination=? AND depart_date BETWEEN ? AND ? AND observed_at >= ?
        AND CAST(julianday(return_date)-julianday(depart_date) AS INTEGER) BETWEEN ? AND ?
      GROUP BY host, origin, destination, depart_date, return_date, price_amount, currency
      ORDER BY currency ASC, price_amount ASC, observed_at DESC LIMIT ?`)
      .bind(origin, destination, windowStart, windowEnd, since, stayMin, stayMax, MAX_RESULTS)
      .all<Record<string, unknown>>();
    const fares: CommunityFareObservation[] = rows.results.map((row) => ({
      host: String(row.host), origin: String(row.origin), destination: String(row.destination),
      departDate: String(row.depart_date), returnDate: String(row.return_date), priceAmount: Number(row.price_amount),
      currency: String(row.currency), observations: Number(row.observations), observedAt: String(row.observed_at),
      verification: "unverified", link: `https://${String(row.host)}/`,
    }));
    return json(200, { fares, generatedAt: now.toISOString(), noticeHe: "תצפיות שדווחו מדפדפנים; המחיר והזמינות לא אומתו מול חברת התעופה." });
  } catch { return json(503, { error: { code: "storage_unavailable", message: "Could not read observations" } }); }
}
