import type { PublishedFare } from "./sources/published-fares";
import { FINNAIR_PAGE } from "./finnair-fares";

const MAX_BYTES = 1_500_000;
const MAX_AGE_MS = 36 * 3_600_000;
const realDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

/** Compact current prices, rather than appending thousands of indexed history rows each day. */
export async function saveFinnairSnapshots(db: D1Database, fares: readonly PublishedFare[], now: Date): Promise<number> {
  const groups = new Map<string, PublishedFare[]>();
  for (const fare of fares) {
    const key = `${fare.destination}|${fare.departDate.slice(0, 7)}`;
    const group = groups.get(key) ?? [];
    group.push(fare);
    groups.set(key, group);
  }
  const statements: D1PreparedStatement[] = [];
  for (const [key, group] of groups) {
    const json = JSON.stringify(group);
    if (new TextEncoder().encode(json).byteLength > MAX_BYTES) throw new Error("Finnair snapshot too large");
    const [destination, month] = key.split("|");
    statements.push(db.prepare("INSERT INTO public_calendar_snapshots (source,origin,destination,month,fares_json,checked_at) VALUES (?,?,?,?,?,?) ON CONFLICT(source,origin,destination,month) DO UPDATE SET fares_json=excluded.fares_json,checked_at=excluded.checked_at")
      .bind("finnair", "HEL", destination, month, json, now.toISOString()));
  }
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
  return statements.length;
}

/** Exact primary-key lookup. Old, malformed, foreign-route or special fares fail closed. */
export async function readFinnairSnapshot(db: D1Database, destination: string, month: string, now: Date): Promise<PublishedFare[]> {
  if (!/^[A-Z]{3}$/.test(destination) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return [];
  const row = await db.prepare("SELECT fares_json,checked_at FROM public_calendar_snapshots WHERE source=? AND origin=? AND destination=? AND month=?")
    .bind("finnair", "HEL", destination, month).first<{ fares_json: string; checked_at: string }>();
  if (!row || typeof row.fares_json !== "string" || new TextEncoder().encode(row.fares_json).byteLength > MAX_BYTES) return [];
  const age = now.getTime() - Date.parse(row.checked_at);
  if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(row.fares_json); } catch { return []; }
  if (!Array.isArray(parsed) || parsed.length > 20_000) return [];
  return parsed.filter((fare): fare is PublishedFare => fare && typeof fare === "object" &&
    fare.airline === "AY" && fare.origin === "HEL" && fare.destination === destination &&
    realDate(fare.departDate) && fare.departDate.slice(0, 7) === month && fare.departDate >= now.toISOString().slice(0, 10) &&
    realDate(fare.returnDate) && fare.returnDate > fare.departDate &&
    typeof fare.amount === "number" && Number.isFinite(fare.amount) && fare.amount > 0 && fare.currency === "EUR" &&
    fare.structure === "roundtrip" && fare.sourceUrl === FINNAIR_PAGE && fare.checkedAt === row.checked_at && fare.pricing === "published_advertisement");
}
