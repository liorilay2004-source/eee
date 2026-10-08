import { bucketKey } from "./deals";
import { parseTicketPrices } from "./ticket-prices";
import { isPublishedSource } from "./quotes";
import type { CachedOffers, FxRates, Leg, Offer, OneWayPair, PriceContext, PriceHistoryRow, Repo, SearchRequest, SourceName } from "./types";

/**
 * D1 persistence (SPEC §12). Every statement is prepared and bound: values never reach the SQL text, only
 * generated "?" placeholder lists do. Money is stored as the ORIGINAL amount + currency (SPEC §4.2).
 * Timestamps are written as canonical UTC ISO strings so that string order equals time order in SQL.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const BATCH_CHUNK = 50; // statements per db.batch call
const LOAD_LIMIT = 5000; // newest rows read by loadRecentOffers, a guard against unbounded history
const CACHE_RETENTION_MS = 7 * DAY_MS; // search_cache rows older than this are garbage under any sane TTL
const ERROR_MAX_LEN = 300;
/** priceHistory bounds (D1 allows 100 bound parameters per query: 6 per pair). */
const HISTORY_MAX_PAIRS = 10;
const HISTORY_MAX_PER_PAIR = 100;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The only period keys a quota row may have: a one-off allowance, or a UTC month (see quotaPeriodKey in quotes.ts). */
const QUOTA_PERIOD = /^(lifetime|\d{4}-(0[1-9]|1[0-2]))$/;
/**
 * The only keys a daily share may have: "quota:" and a vendor name (see withDailyShare in quotes.ts), or "party:" and a vendor
 * name (the party check's own daily cap, src/partycheck.ts).
 */
const DAILY_KEY = /^(quota|party):[a-z_]{1,32}$/;
/** reserveQuotaUnits / reserveDailyUnits take at most this many units at once (a party check takes 2). */
const MAX_UNITS_AT_ONCE = 10;
const CURRENCY = /^[A-Za-z]{3}$/;

type Bind = string | number | null;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseJson(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Stored timestamps are always canonical, so callers may pass Python-style "+00:00" strings and stay comparable. */
function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Statements go through db.batch in chunks: one atomic transaction per chunk. */
async function runChunked(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK));
  }
}

// --- prices <-> Offer -------------------------------------------------------------------------------

export interface PriceRow {
  id: number;
  origin: string;
  destination: string;
  depart_date: string;
  return_date: string;
  price_amount: number;
  price_currency: string;
  source: string;
  ticket_structure: string;
  airlines_json: string;
  legs_json: string;
  includes_json: string;
  deeplink: string | null;
  verify_link: string | null;
  checked_at: string;
}

export const PRICE_COLUMNS =
  "id, origin, destination, depart_date, return_date, price_amount, price_currency, source, ticket_structure, " +
  "airlines_json, legs_json, includes_json, deeplink, verify_link, checked_at";

const INSERT_PRICE =
  "INSERT INTO prices (origin, destination, depart_date, return_date, price_amount, price_currency, source, " +
  "ticket_structure, airlines_json, legs_json, includes_json, deeplink, verify_link, checked_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const SOURCES: readonly string[] = ["travelpayouts", "google_flights", "ignav", "wego", "searchapi", "serpapi", "duffel", "hasdata", "ryanair", "aegean", "air_canada", "tap", "ethiopian", "air_europa", "philippine", "virgin_atlantic", "air_new_zealand", "air_baltic", "sky_express", "gol", "aeromexico", "copa", "brussels_airlines", "turkish", "lufthansa", "swiss", "austrian", "icelandair", "eurowings", "finnair", "norwegian", "iberia", "avianca", "klm", "american", "aer_lingus", "jetblue", "frontier", "singapore", "air_serbia", "elal", "direct_combination"];
const STRUCTURES: readonly string[] = ["roundtrip", "split"];

function serializeLeg(leg: Leg | undefined): Leg {
  return {
    departTime: leg?.departTime ?? null,
    arriveTime: leg?.arriveTime ?? null,
    stops: leg?.stops ?? null,
    durationMin: leg?.durationMin ?? null,
    airlines: Array.isArray(leg?.airlines) ? leg.airlines.filter((a) => typeof a === "string") : [],
  };
}

function parseLeg(v: unknown): Leg {
  const r = isRecord(v) ? v : {};
  return {
    departTime: asString(r.departTime),
    arriveTime: asString(r.arriveTime),
    stops: asNumber(r.stops),
    durationMin: asNumber(r.durationMin),
    airlines: Array.isArray(r.airlines) ? r.airlines.filter((a): a is string => typeof a === "string") : [],
  };
}

/** Same rule as Offer.airlines in the Python engine: outbound then inbound, first occurrence wins. */
function unionAirlines(outbound: Leg, inbound: Leg): string[] {
  return [...new Set([...outbound.airlines, ...inbound.airlines])];
}

/** Returns the bound parameters for INSERT_PRICE, or null when the offer is not safe to persist. */
function priceParams(offer: Offer): Bind[] | null {
  if (!Number.isFinite(offer.priceAmount) || offer.priceAmount <= 0) return null;
  if (typeof offer.priceCurrency !== "string" || offer.priceCurrency === "") return null;
  if (typeof offer.origin !== "string" || typeof offer.destination !== "string") return null;
  if (!ISO_DATE.test(offer.departDate) || !ISO_DATE.test(offer.returnDate)) return null;
  // An unparseable timestamp is skipped rather than replaced by "now": we never guess when a fare was seen.
  const checkedAt = canonicalTimestamp(offer.checkedAt);
  if (checkedAt === null) return null;

  const outbound = serializeLeg(offer.outbound);
  const inbound = serializeLeg(offer.inbound);
  const checkedBag = offer.includes?.checkedBag;
  return [
    offer.origin,
    offer.destination,
    offer.departDate,
    offer.returnDate,
    offer.priceAmount,
    offer.priceCurrency,
    offer.source,
    offer.ticketStructure,
    JSON.stringify(unionAirlines(outbound, inbound)),
    // The return one-way's link (split tickets) rides in legs_json: the columns of SPEC §12 have no room for it.
    JSON.stringify({ outbound, inbound, ...(typeof offer.returnDeeplink === "string" ? { returnDeeplink: offer.returnDeeplink } : {}), ...(offer.ticketPrices ? { ticketPrices: parseTicketPrices(offer.ticketPrices, offer) } : {}) }),
    JSON.stringify(typeof checkedBag === "boolean" ? { checked_bag: checkedBag } : {}),
    offer.deeplink ?? null,
    offer.verifyLink ?? null,
    checkedAt,
  ];
}

/** Exported for the price-alert job (watches.ts), which reads the same rows. */
export function rowToOffer(row: PriceRow): Offer | null {
  if (!SOURCES.includes(row.source) || !STRUCTURES.includes(row.ticket_structure)) return null;
  if (!Number.isFinite(row.price_amount)) return null;
  const legs = parseJson(row.legs_json);
  const legsRec = isRecord(legs) ? legs : {};
  const includes = parseJson(row.includes_json);
  const checkedBag = isRecord(includes) && typeof includes.checked_bag === "boolean" ? includes.checked_bag : undefined;
  const returnDeeplink = asString(legsRec.returnDeeplink);
  return {
    origin: row.origin,
    destination: row.destination,
    departDate: row.depart_date,
    returnDate: row.return_date,
    priceAmount: row.price_amount,
    priceCurrency: row.price_currency,
    source: row.source as SourceName,
    ticketStructure: row.ticket_structure as Offer["ticketStructure"],
    outbound: parseLeg(legsRec.outbound),
    inbound: parseLeg(legsRec.inbound),
    includes: checkedBag === undefined ? {} : { checkedBag },
    deeplink: row.deeplink,
    ...(returnDeeplink !== null ? { returnDeeplink } : {}),
    ticketPrices: parseTicketPrices(legsRec.ticketPrices, { ticketStructure: row.ticket_structure as Offer["ticketStructure"], priceAmount: row.price_amount, priceCurrency: row.price_currency, outbound: parseLeg(legsRec.outbound), inbound: parseLeg(legsRec.inbound) }),
    verifyLink: row.verify_link,
    checkedAt: row.checked_at,
    // Pipeline-derived fields are recomputed per request, never persisted (SPEC §7 step 7).
    extrasAmountIls: 0,
    totalIls: null,
    tags: [],
  };
}

// --- price-history write dedup ---------------------------------------------------------------------------

/** Only the Data API's cached fares are deduplicated: a live quote's own timestamp is what makes it "live". */
const DEDUP_SOURCE = "travelpayouts";

/** Identity of one fare in INSERT_PRICE params order: origin, destination, depart, return, source, structure. */
const fareKey = (p: readonly Bind[]): string => [p[0], p[1], p[2], p[3], p[6], p[7]].join("|");

/** The deal-detection bucket (deals.ts bucketKey: route, structure, month, trip length band) of INSERT_PRICE params. */
const bucketOf = (p: readonly Bind[]): string =>
  bucketKey({ origin: p[0] as string, destination: p[1] as string, depart_date: p[2] as string, return_date: p[3] as string, ticket_structure: p[7] as string }) ??
  `unbucketed|${fareKey(p)}`;

/**
 * Keys (fareKey) of the rows in `rows` that need not be written: whole deal-detection BUCKETS in which every row is a
 * travelpayouts fare whose NEWEST stored row is at or after `since` with the same amount and currency. Writing them again
 * adds three D1 row writes each (the table and two indexes) and no information inside that time bin.
 *  - Newest row only: a fare that went 100 -> 120 -> 100 in one bin still writes the second 100.
 *  - Whole buckets only: deals.ts takes its candidate from the newest instant of a bucket, so a bucket is either written
 *    complete or not at all, and the history then reads exactly as if this repeat look had not happened (an equal row is
 *    already in the same bin, so the per-bin observations are unchanged too).
 * One indexed read per origin (idx_prices_recent, bounded to rows since `since`). Any failure = skip nothing.
 */
async function unchangedFares(db: D1Database, rows: readonly Bind[][], since: string): Promise<Set<string>> {
  const skip = new Set<string>();
  const byOrigin = new Map<string, Set<string>>();
  for (const p of rows) {
    if (p[6] !== DEDUP_SOURCE) continue;
    const dests = byOrigin.get(p[0] as string) ?? new Set<string>();
    dests.add(p[1] as string);
    byOrigin.set(p[0] as string, dests);
  }
  if (byOrigin.size === 0) return skip;
  try {
    const newest = new Map<string, { amount: number; currency: string }>();
    for (const [origin, dests] of byOrigin) {
      const list = [...dests];
      const { results } = await db
        .prepare(
          "SELECT origin, destination, depart_date, return_date, source, ticket_structure, price_amount, price_currency " +
            "FROM prices INDEXED BY idx_prices_recent " +
            `WHERE origin = ? AND destination IN (${list.map(() => "?").join(", ")}) AND checked_at >= ? AND source = ? ` +
            "ORDER BY checked_at ASC, id ASC",
        )
        .bind(origin, ...list, since, DEDUP_SOURCE)
        .all<PriceRow>();
      // Ascending: the last row seen per fare is its newest.
      for (const r of results) {
        newest.set(fareKey([r.origin, r.destination, r.depart_date, r.return_date, null, null, r.source, r.ticket_structure]), {
          amount: r.price_amount,
          currency: r.price_currency,
        });
      }
    }
    const changed = new Set<string>(); // buckets with at least one row that must be written
    for (const p of rows) {
      const prev = p[6] === DEDUP_SOURCE ? newest.get(fareKey(p)) : undefined;
      if (!(prev && prev.amount === p[4] && prev.currency === p[5])) changed.add(bucketOf(p));
    }
    for (const p of rows) if (!changed.has(bucketOf(p))) skip.add(fareKey(p));
  } catch {
    return new Set<string>(); // never lose history over a failed read: write everything
  }
  return skip;
}

/** Repeated advertisements do not become new price-history observations every hour.
 * Compare the complete stored offer, including baggage, airlines and booking links.
 * Live API quotes retain their existing append-only behavior.
 */
async function unchangedPublishedFares(db: D1Database, rows: readonly Bind[][], since: string): Promise<Set<string>> {
  const skip = new Set<string>();
  const groups = new Map<string, Bind[][]>();
  for (const row of rows) {
    if (!isPublishedSource(row[6] as SourceName)) continue;
    const key = JSON.stringify([row[0], row[6]]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  try {
    for (const group of groups.values()) {
      const first = group[0]!;
      const newest = new Map<string, string>();
      const destinations = [...new Set(group.map(row => row[1]))];
      for (let i=0;i<destinations.length;i+=80) {
        const chunk=destinations.slice(i,i+80);
        const { results } = await db.prepare(`SELECT ${PRICE_COLUMNS} FROM prices INDEXED BY idx_prices_recent WHERE origin=? AND destination IN (${chunk.map(()=>"?").join(",")}) AND checked_at>=? AND source=? ORDER BY checked_at DESC,id DESC LIMIT 5000`)
          .bind(first[0],...chunk,since,first[6]).all<PriceRow>();
        for (const stored of results) {
          const offer = rowToOffer(stored);
          const params = offer && priceParams(offer);
          if (params && !newest.has(fareKey(params))) newest.set(fareKey(params), JSON.stringify(params.slice(0, -1)));
        }
      }
      for (const row of group) if (newest.get(fareKey(row)) === JSON.stringify(row.slice(0, -1))) skip.add(JSON.stringify(row.slice(0, -1)));
    }
  } catch { return new Set<string>(); }
  return skip;
}

// --- fx_rates -----------------------------------------------------------------------------------------

interface FxRow {
  currency: string;
  rate_to_ils: number;
  source: string;
}

/**
 * A day counts as stored only if its ILS row exists: saveFxRates writes ILS last, so a crash between
 * batch chunks leaves an incomplete day that reads as missing instead of a silently partial rate table.
 */
async function loadFx(db: D1Database, date: string): Promise<FxRates | null> {
  const { results } = await db
    .prepare("SELECT currency, rate_to_ils, source FROM fx_rates WHERE date = ?")
    .bind(date)
    .all<FxRow>();
  const ratesToIls: Record<string, number> = {};
  for (const r of results) {
    if (Number.isFinite(r.rate_to_ils) && r.rate_to_ils > 0) ratesToIls[r.currency] = r.rate_to_ils;
  }
  if (ratesToIls.ILS !== 1) return null;
  return { date, source: results[0]?.source ?? "unknown", ratesToIls };
}

// --- source_health ------------------------------------------------------------------------------------

/** Error text may come from a failed URL or header echo: strip credentials and cap the length before storing. */
function scrubError(message: string): string {
  return message
    .replace(
      /([\w-]*(?:token|secret|passw(?:or)?d|api[_-]?key|authorization|marker|key)[\w-]*["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"'&,;]+/gi,
      "$1[redacted]",
    )
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, "Bearer [redacted]")
    .slice(0, ERROR_MAX_LEN);
}

/**
 * Seconds until the NEXT request would fit under the sliding-window limit, assuming nobody else calls meanwhile.
 * Either the previous window's weight fades enough inside this window, or it has to be the next window, where
 * this window's whole count is the "previous" one.
 */
function retryAfterSeconds(count: number, prev: number, max: number, elapsed: number, windowSec: number): number {
  const untilNext = (1 - elapsed) * windowSec;
  const room = max - (count + 1); // what the previous window's weight may still add for the next request to fit
  let wait: number;
  if (room >= 0 && prev > 0) wait = (1 - room / prev - elapsed) * windowSec;
  else if (max >= 1 && count > 0) wait = untilNext + Math.max(0, 1 - (max - 1) / count) * windowSec;
  else wait = untilNext;
  return Math.min(2 * windowSec, Math.max(1, Math.ceil(wait)));
}

// --- repo ---------------------------------------------------------------------------------------------

export function createRepo(db: D1Database): Repo {
  return {
    async getCachedOffers(searchKey, maxAgeHours, now) {
      const row = await db
        .prepare("SELECT offers_json, extra_json, created_at FROM search_cache WHERE search_key = ?")
        .bind(searchKey)
        .first<{ offers_json: string; extra_json: string | null; created_at: string }>();
      if (!row) return null;
      const createdMs = Date.parse(row.created_at);
      // Strictly younger than the TTL (SPEC §7 step 2 says "< 6h old"); an unreadable row is a miss, not an error.
      if (!Number.isFinite(createdMs) || !(maxAgeHours > 0)) return null;
      if (!(now.getTime() - createdMs < maxAgeHours * HOUR_MS)) return null;
      const offers = parseJson(row.offers_json);
      if (!Array.isArray(offers)) return null;
      const cached: CachedOffers = { offers: offers as Offer[], createdAt: row.created_at };
      if (row.extra_json !== null) {
        // The one-way fares are half of the row: without them the splits would silently vanish, so damage = miss.
        const extra = parseJson(row.extra_json);
        if (!isRecord(extra) || !Array.isArray(extra.oneWayPairs) || !Array.isArray(extra.notes)) return null;
        cached.oneWayPairs = extra.oneWayPairs as OneWayPair[];
        cached.notes = extra.notes.filter((n): n is string => typeof n === "string");
        // Quotes are optional on top of the fares: a damaged list only means the hit shows none, never a miss.
        if (Array.isArray(extra.quotes)) cached.quotes = extra.quotes as Offer[];
      }
      return cached;
    },

    async putCachedOffers(searchKey, offers, now, extra) {
      const createdAt = now.toISOString();
      const cutoff = new Date(now.getTime() - CACHE_RETENTION_MS).toISOString();
      await db.batch([
        db
          .prepare(
            "INSERT INTO search_cache (search_key, offers_json, extra_json, created_at) VALUES (?, ?, ?, ?) " +
              "ON CONFLICT(search_key) DO UPDATE SET offers_json = excluded.offers_json, " +
              "extra_json = excluded.extra_json, created_at = excluded.created_at",
          )
          .bind(searchKey, JSON.stringify(offers), extra ? JSON.stringify(extra) : null, createdAt),
        // Opportunistic retention: keeps the cache bounded without a cron.
        db.prepare("DELETE FROM search_cache WHERE created_at < ?").bind(cutoff),
      ]);
    },

    async savePrices(offers, opts) {
      const rows: Bind[][] = [];
      for (const offer of offers) {
        const params = priceParams(offer);
        if (params) rows.push(params);
      }
      const since = canonicalTimestamp(opts?.skipUnchangedSince);
      const skip = since === null ? new Set<string>() : await unchangedFares(db, rows, since);
      const publishedSince = canonicalTimestamp(opts?.skipUnchangedPublishedSince);
      const publishedSkip = publishedSince === null ? new Set<string>() : await unchangedPublishedFares(db, rows, publishedSince);
      const statements = rows.filter((p) => !skip.has(fareKey(p)) && !publishedSkip.has(JSON.stringify(p.slice(0, -1)))).map((p) => db.prepare(INSERT_PRICE).bind(...p));
      await runChunked(db, statements);
    },

    async loadRecentOffers(origin, destination, departFrom, returnTo, maxAgeHours, now, sources, exactDates = false) {
      if (sources && sources.length === 0) return [];
      if (!(maxAgeHours > 0)) return [];
      const cutoff = new Date(now.getTime() - maxAgeHours * HOUR_MS).toISOString();
      const binds: Bind[] = [origin, destination, cutoff, departFrom, returnTo];
      let sql =
        // INDEXED BY: the range on checked_at keeps the scan proportional to recent rows, not to the route's history.
        // (idx_prices_recent comes with migration 0003: apply migrations before deploying this build.)
        `SELECT ${PRICE_COLUMNS} FROM prices INDEXED BY ${exactDates ? "idx_prices_route" : "idx_prices_recent"} ` +
        (exactDates
          ? "WHERE origin = ? AND destination = ? AND checked_at > ? AND depart_date = ? AND return_date = ?"
          : "WHERE origin = ? AND destination = ? AND checked_at > ? AND depart_date >= ? AND return_date <= ?");
      if (sources) {
        sql += ` AND source IN (${sources.map(() => "?").join(", ")})`;
        binds.push(...sources);
      }
      sql += " ORDER BY checked_at DESC, id DESC LIMIT ?";
      binds.push(LOAD_LIMIT);

      const { results } = await db.prepare(sql).bind(...binds).all<PriceRow>();
      // History rows are all returned (the pipeline merges by lowest price per pair). Newest-first was only for
      // the LIMIT above: hand them back in insertion order so save -> load is order-preserving.
      const rows = [...results].sort((a, b) => a.id - b.id);
      const offers: Offer[] = [];
      for (const row of rows) {
        const offer = rowToOffer(row);
        if (offer) offers.push(offer);
      }
      return offers;
    },

    async priceContext(origin, destination, departDate, returnDate, now): Promise<PriceContext | null> {
      // One round trip. The currency is pinned to the most recent row so amounts from different currencies are
      // never compared (SPEC §4.2): lowest-ever and week-ago are both read in that currency only.
      const weekAgoUpper = new Date(now.getTime() - 7 * DAY_MS).toISOString();
      const weekAgoLower = new Date(now.getTime() - 14 * DAY_MS).toISOString();
      const row = await db
        .prepare(
          "WITH pair AS (" +
            "SELECT id, price_amount, price_currency, checked_at FROM prices " +
            "WHERE origin = ? AND destination = ? AND depart_date = ? AND return_date = ?), " +
            "cur AS (SELECT price_currency FROM pair ORDER BY checked_at DESC, id DESC LIMIT 1) " +
            "SELECT " +
            "(SELECT price_currency FROM cur) AS currency, " +
            "(SELECT MIN(price_amount) FROM pair WHERE price_currency = (SELECT price_currency FROM cur)) AS lowest, " +
            "(SELECT price_amount FROM pair WHERE price_currency = (SELECT price_currency FROM cur) " +
            "AND checked_at <= ? AND checked_at >= ? ORDER BY checked_at DESC, id DESC LIMIT 1) AS week_ago",
        )
        .bind(origin, destination, departDate, returnDate, weekAgoUpper, weekAgoLower)
        .first<{ currency: string | null; lowest: number | null; week_ago: number | null }>();
      if (!row || row.currency === null) return null;
      return { currency: row.currency, weekAgoAmount: row.week_ago ?? null, lowestAmount: row.lowest ?? null };
    },

    async priceHistory(pairs, since, limitPerPair) {
      // One D1 query for all pairs: a UNION ALL of per-pair subqueries, each an exact prefix of idx_prices_route plus a range on
      // checked_at, newest first with its own LIMIT, so the rows read are at most pairs x limit whatever the history holds.
      const sinceMs = since.getTime();
      const limit = Math.min(HISTORY_MAX_PER_PAIR, Math.max(0, Math.floor(limitPerPair)));
      const valid = pairs
        .filter((p) => isRecord(p) && typeof p.origin === "string" && typeof p.destination === "string" && ISO_DATE.test(p.departDate) && ISO_DATE.test(p.returnDate))
        .slice(0, HISTORY_MAX_PAIRS);
      if (valid.length === 0 || !(limit > 0) || !Number.isFinite(sinceMs)) return [];
      const cutoff = new Date(sinceMs).toISOString();
      const one =
        "SELECT * FROM (SELECT origin, destination, depart_date, return_date, price_amount, price_currency, checked_at " +
        "FROM prices INDEXED BY idx_prices_route " +
        "WHERE origin = ? AND destination = ? AND depart_date = ? AND return_date = ? AND checked_at > ? " +
        "ORDER BY checked_at DESC LIMIT ?)";
      const binds: Bind[] = [];
      for (const p of valid) binds.push(p.origin, p.destination, p.departDate, p.returnDate, cutoff, limit);
      const { results } = await db.prepare(valid.map(() => one).join(" UNION ALL ")).bind(...binds).all<PriceHistoryRow>();
      return results.filter((r) => typeof r.price_amount === "number" && typeof r.price_currency === "string" && typeof r.checked_at === "string");
    },

    async saveSearch(req: SearchRequest, searchKey, now) {
      await db
        .prepare(
          "INSERT INTO searches (search_key, origin, destination, window_start, window_end, stay_min, stay_max, " +
            "pax_json, cabin, extras_json, filters_json, created_at, user_id) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        )
        .bind(
          searchKey,
          req.origin,
          req.destination || null, // empty destination = spontaneous mode (SPEC §5)
          req.windowStart,
          req.windowEnd,
          req.stayMin,
          req.stayMax,
          JSON.stringify({ adults: req.adults, children: req.children, infants: req.infants }),
          req.cabin,
          JSON.stringify({ checked_bag: req.checkedBag }),
          JSON.stringify({
            out_hours: req.outHours,
            ret_hours: req.retHours,
            max_stops: req.maxStops,
            nearby_airports: req.nearbyAirports,
          }),
          now.toISOString(),
        )
        .run();
    },

    getFxRates(date) {
      return loadFx(db, date);
    },

    async saveFxRates(fx) {
      if (!ISO_DATE.test(fx.date)) throw new Error("saveFxRates: date must be YYYY-MM-DD");
      const rates = new Map<string, number>();
      for (const [code, rate] of Object.entries(fx.ratesToIls)) {
        if (!CURRENCY.test(code) || !Number.isFinite(rate) || rate <= 0) continue;
        const cur = code.toUpperCase();
        if (cur !== "ILS") rates.set(cur, rate);
      }
      if (rates.size === 0) return; // nothing usable: do not write a day that would read as complete
      rates.set("ILS", 1); // last on purpose, see loadFx
      const upsert =
        "INSERT INTO fx_rates (date, currency, rate_to_ils, source) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(date, currency) DO UPDATE SET rate_to_ils = excluded.rate_to_ils, source = excluded.source";
      // Replace the whole day: a re-save from another source must not leave the first source's currencies behind.
      await runChunked(db, [
        db.prepare("DELETE FROM fx_rates WHERE date = ?").bind(fx.date),
        ...[...rates].map(([cur, rate]) => db.prepare(upsert).bind(fx.date, cur, rate, fx.source)),
      ]);
    },

    async getLatestFxRates() {
      const row = await db
        .prepare("SELECT MAX(date) AS date FROM fx_rates WHERE currency = ?")
        .bind("ILS")
        .first<{ date: string | null }>();
      return row?.date ? loadFx(db, row.date) : null;
    },

    async checkRateLimit(key, limit, windowSeconds, now) {
      const windowSec = Math.max(1, Math.floor(windowSeconds));
      const max = Math.max(0, Math.floor(limit));
      const nowSec = Math.floor(now.getTime() / 1000);
      const windowStart = Math.floor(nowSec / windowSec) * windowSec;
      const elapsed = (now.getTime() / 1000 - windowStart) / windowSec; // 0 <= elapsed < 1

      // Sliding-window counter: this window's count plus the previous window's, faded by how far into this
      // window we are. A plain fixed window lets a client spend a full quota just before a boundary and another
      // just after it (2x the limit within a second).
      // The upsert is atomic, so concurrent requests each get a distinct count (no read-modify-write race); the
      // previous window is only read, in the same batch. `key` must be namespaced per limiter by the caller
      // (e.g. "search:<ip>"): rows are (key, window_start) only.
      const [current, previous] = await db.batch<{ count: number }>([
        db
          .prepare(
            "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) " +
              "ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count",
          )
          .bind(key, windowStart),
        db.prepare("SELECT count FROM rate_limits WHERE key = ? AND window_start = ?").bind(key, windowStart - windowSec),
      ]);
      const count = current?.results[0]?.count ?? max + 1; // no row back: fail closed
      const prev = previous?.results[0]?.count ?? 0;
      const weighted = count + prev * (1 - elapsed);

      // First hit of a new window is a cheap moment to drop dead windows (assumes windows <= 12 hours).
      if (count === 1) {
        try {
          await db
            .prepare("DELETE FROM rate_limits WHERE window_start < ?")
            .bind(nowSec - Math.max(windowSec, 86_400))
            .run();
        } catch {
          // housekeeping must never fail the request
        }
      }

      const allowed = weighted <= max;
      return {
        allowed,
        remaining: Math.max(0, Math.floor(max - weighted + 1e-9)),
        retryAfterSec: allowed ? 0 : retryAfterSeconds(count, prev, max, elapsed, windowSec),
      };
    },

    async reserveQuota(source, period, cap, now) {
      // Fail closed: anything but a confirmed increment (missing table, D1 error, odd result) means "do not call".
      try {
        if (!Number.isSafeInteger(cap) || cap < 1 || !QUOTA_PERIOD.test(period)) return false;
        // One atomic statement, no read-modify-write. A missing row is inserted with used = 1 (only when cap >= 1: the
        // SELECT ... WHERE guards the insert path, which the DO UPDATE ... WHERE below cannot). An existing row is
        // raised only while used < cap, otherwise nothing changes and RETURNING yields no row. The SELECT needs its own
        // WHERE so SQLite does not read ON CONFLICT as a join clause. The cap comes from code, never from D1 or env.
        const res = await db
          .prepare(
            "INSERT INTO source_quota (source, period, used, updated_at) SELECT ?, ?, 1, ? WHERE ? >= 1 " +
              "ON CONFLICT(source, period) DO UPDATE SET used = used + 1, updated_at = excluded.updated_at WHERE used < ? " +
              "RETURNING used",
          )
          .bind(source, period, now.toISOString(), cap, cap)
          .all<{ used: number }>();
        const used = res.results.length === 1 ? res.results[0]?.used : undefined;
        return typeof used === "number" && Number.isInteger(used) && used >= 1 && used <= cap;
      } catch {
        return false;
      }
    },

    async reserveDaily(key, cap, now) {
      // Fail closed, like reserveQuota. The day's counter lives in rate_limits (window_start = the UTC day's start, in seconds), so no
      // migration is needed and the daily cleanup of that table drops old days. The share comes from code, never from D1 or env.
      try {
        const day = Math.floor(now.getTime() / DAY_MS) * (DAY_MS / 1000);
        if (!Number.isSafeInteger(cap) || cap < 1 || !DAILY_KEY.test(key) || !Number.isSafeInteger(day)) return false;
        const res = await db
          .prepare(
            "INSERT INTO rate_limits (key, window_start, count) SELECT ?, ?, 1 WHERE ? >= 1 " +
              "ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 WHERE count < ? " +
              "RETURNING count",
          )
          .bind(key, day, cap, cap)
          .all<{ count: number }>();
        const count = res.results.length === 1 ? res.results[0]?.count : undefined;
        return typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= cap;
      } catch {
        return false;
      }
    },

    async reserveQuotaUnits(source, period, cap, units, now) {
      // reserveQuota for several units, ALL OR NONE, in one atomic statement: a row is inserted with used = units only when units
      // <= cap, and an existing row is raised only while used + units <= cap; otherwise nothing changes and RETURNING yields no
      // row. Fail closed on anything but a confirmed increment, like reserveQuota.
      try {
        if (!Number.isSafeInteger(cap) || cap < 1 || !Number.isSafeInteger(units) || units < 1 || units > MAX_UNITS_AT_ONCE || !QUOTA_PERIOD.test(period)) return false;
        const res = await db
          .prepare(
            "INSERT INTO source_quota (source, period, used, updated_at) SELECT ?, ?, ?, ? WHERE ? <= ? " +
              "ON CONFLICT(source, period) DO UPDATE SET used = used + ?, updated_at = excluded.updated_at WHERE used + ? <= ? " +
              "RETURNING used",
          )
          .bind(source, period, units, now.toISOString(), units, cap, units, units, cap)
          .all<{ used: number }>();
        const used = res.results.length === 1 ? res.results[0]?.used : undefined;
        return typeof used === "number" && Number.isInteger(used) && used >= units && used <= cap;
      } catch {
        return false;
      }
    },

    async reserveDailyUnits(key, cap, units, now) {
      // reserveDaily for several units, all or none, fail closed (same table, same day rows).
      try {
        const day = Math.floor(now.getTime() / DAY_MS) * (DAY_MS / 1000);
        if (!Number.isSafeInteger(cap) || cap < 1 || !Number.isSafeInteger(units) || units < 1 || units > MAX_UNITS_AT_ONCE) return false;
        if (!DAILY_KEY.test(key) || !Number.isSafeInteger(day)) return false;
        const res = await db
          .prepare(
            "INSERT INTO rate_limits (key, window_start, count) SELECT ?, ?, ? WHERE ? <= ? " +
              "ON CONFLICT(key, window_start) DO UPDATE SET count = count + ? WHERE count + ? <= ? " +
              "RETURNING count",
          )
          .bind(key, day, units, units, cap, units, units, cap)
          .all<{ count: number }>();
        const count = res.results.length === 1 ? res.results[0]?.count : undefined;
        return typeof count === "number" && Number.isInteger(count) && count >= units && count <= cap;
      } catch {
        return false;
      }
    },

    async readAllowance(source, period, dailyKeys, now) {
      // READ ONLY (nothing is reserved): what reserveQuota(Units) and reserveDaily(Units) have counted, in one statement. A missing
      // row is 0. Odd input or an unreadable answer rejects; the caller (partycheck.ts partyCheckRoom) reads that as "no room".
      const day = Math.floor(now.getTime() / DAY_MS) * (DAY_MS / 1000);
      const keys = [...new Set(dailyKeys)];
      if (!QUOTA_PERIOD.test(period) || !Number.isSafeInteger(day) || keys.length > 4 || !keys.every((k) => DAILY_KEY.test(k))) {
        throw new Error("readAllowance: invalid arguments");
      }
      const columns = ["(SELECT used FROM source_quota WHERE source = ? AND period = ?) AS used"];
      const binds: Bind[] = [source, period];
      keys.forEach((k, i) => {
        columns.push(`(SELECT count FROM rate_limits WHERE key = ? AND window_start = ?) AS d${i}`);
        binds.push(k, day);
      });
      const row = await db.prepare(`SELECT ${columns.join(", ")}`).bind(...binds).first<Record<string, unknown>>();
      const count = (v: unknown): number => {
        if (v === null || v === undefined) return 0;
        if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
        throw new Error("readAllowance: unreadable counter");
      };
      if (!row) throw new Error("readAllowance: no row");
      const daily: Record<string, number> = {};
      keys.forEach((k, i) => {
        daily[k] = count(row[`d${i}`]);
      });
      return { used: count(row.used), daily };
    },

    async claimWindowLock(key, windowSeconds, now) {
      // Fixed window, not the sliding-window limiter: that one counts refused attempts and weights the previous window, so a
      // key asked every few minutes would never be granted again. Old windows go with the daily rate_limits cleanup.
      try {
        const windowSec = Math.floor(windowSeconds);
        const nowSec = Math.floor(now.getTime() / 1000);
        if (typeof key !== "string" || key === "" || !Number.isSafeInteger(windowSec) || windowSec < 1 || !Number.isSafeInteger(nowSec)) return false;
        const windowStart = Math.floor(nowSec / windowSec) * windowSec;
        const res = await db
          .prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key, window_start) DO NOTHING RETURNING count")
          .bind(key, windowStart)
          .all<{ count: number }>();
        return res.results.length === 1;
      } catch {
        return false;
      }
    },

    async recordSourceHealth(source, ok, error, now) {
      const at = now.toISOString();
      if (ok) {
        await db
          .prepare(
            "INSERT INTO source_health (source, last_ok_at, consecutive_failures) VALUES (?, ?, 0) " +
              "ON CONFLICT(source) DO UPDATE SET last_ok_at = excluded.last_ok_at, consecutive_failures = 0",
          )
          .bind(source, at)
          .run();
        return;
      }
      await db
        .prepare(
          "INSERT INTO source_health (source, last_error_at, last_error, consecutive_failures) VALUES (?, ?, ?, 1) " +
            "ON CONFLICT(source) DO UPDATE SET last_error_at = excluded.last_error_at, " +
            "last_error = excluded.last_error, consecutive_failures = consecutive_failures + 1",
        )
        .bind(source, at, error === null ? null : scrubError(error))
        .run();
    },
  };
}

// --- retention ----------------------------------------------------------------------------------------

/** A fare for a trip that departed more than this long ago is of no use to price context ("lowest we've seen"). */
export const PRICES_GRACE_DAYS = 7;
/** Search log kept for analytics only (docs/WEB_APP_SPEC.md D11). */
export const SEARCHES_RETENTION_DAYS = 90;

export type PruneResult = Record<"prices" | "searches" | "search_cache" | "rate_limits", number>;

/**
 * Retention for the tables that only ever grow. Meant for the daily cron trigger (index.ts `scheduled`): the
 * per-request path must not pay for full-table deletes. Everything removed is already unreachable by the API.
 */
export async function pruneHistory(db: D1Database, now: Date): Promise<PruneResult> {
  // source_quota is deliberately NOT pruned (and PruneResult has no entry for it): a deleted counter hands back the
  // vendor's free allowance, i.e. the next call could be a paid one. The table holds a few tiny rows per year.
  const ms = now.getTime();
  const priceCutoff = new Date(ms - PRICES_GRACE_DAYS * DAY_MS).toISOString().slice(0, 10);
  const searchCutoff = new Date(ms - SEARCHES_RETENTION_DAYS * DAY_MS).toISOString();
  const cacheCutoff = new Date(ms - CACHE_RETENTION_MS).toISOString();
  const rateCutoff = Math.floor(ms / 1000) - 86_400;
  const results = await db.batch([
    db.prepare("DELETE FROM prices WHERE depart_date < ?").bind(priceCutoff),
    db.prepare("DELETE FROM searches WHERE created_at < ?").bind(searchCutoff),
    db.prepare("DELETE FROM search_cache WHERE created_at < ?").bind(cacheCutoff),
    db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(rateCutoff),
  ]);
  const changed = (i: number): number => results[i]?.meta.changes ?? 0;
  return { prices: changed(0), searches: changed(1), search_cache: changed(2), rate_limits: changed(3) };
}
