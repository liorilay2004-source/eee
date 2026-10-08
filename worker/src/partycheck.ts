/**
 * "Book the group together, or one by one?" The owner's request: "אני רוצה שהוא יעשה לי בדיקה אם עדיף להזמין בן אדם בודד או
 * ישר זוג".
 *
 * Why it can matter: airlines sell seats in fare classes. When only one seat is left in the cheapest class, a booking for two
 * prices BOTH travellers at the next class, while two separate bookings get the first at the cheap fare and only the second at
 * the next one. So one by one CAN be cheaper. It is never guaranteed, and separate bookings have downsides: seats are not
 * guaranteed together, every booking is changed, cancelled and given luggage on its own, and a child or an infant must stay
 * in a booking with an adult.
 *
 * Two parts:
 *  A) FREE: no key, no upstream call (cardPartyCheck). On a search for 2+ adults without children, every card carries its own
 *     booking link pointed at ONE adult and at the whole group, so the user compares "one adult x N" with "everybody" on the
 *     booking site. A link that is not a recognisable Aviasales search link gets nothing: a link is never made up.
 *  B) LIVE, only on demand (POST /api/party-check, handlePartyCheck): never automatic, only a click in the web app, and only for
 *     a card of a recent search. The search signs each round-trip card's route, dates and adults (a token, HMAC-SHA256 with the
 *     Worker's secret salt, valid PARTY_TOKEN_TTL_SECONDS) when the live check can run; a check without a valid token is refused
 *     before anything is loaded or reserved, so a made-up route or date never reaches a vendor and costs nothing.
 *     The first configured source in PARTY_CHECK_ORDER whose multi-adult price can be read (PartyPricing "total" or
 *     "per_person"; "unknown" is never used) and whose daily share fits a check is asked twice: one adult, then the whole group.
 *     BOTH units are reserved up front, all or none, through the quota core (the source's hard cap AND its daily share) before
 *     any request; fewer than two left means no request at all. The first failure ends the check (no second request, no retry),
 *     and so does a first answer without a usable fare. On top: PARTY_CHECK_RATE_LIMIT_MAX checks per client per 10 minutes
 *     (salted-hash identity, fail closed) and a daily cap per source well below its daily share (partyChecksPerDay).
 *     SerpApi, SearchApi and Ignav document an adults parameter but give no basis for
 *     reading a multi-adult price (per person, or for everybody?). Wego's docs only let us INFER that its total is for everybody
 *     (a reading its adapter checks on every fare, see wego.ts partyTotalAgrees), and its daily share (1 request) cannot fit a
 *     2-search check. So meta.partyCheck.available is false and the endpoint answers 404 until that changes (see the adapters).
 */
import { toIls } from "./money";
import { round2 } from "./extras";
import { dailyShare, QuoteError, quotaPeriodKey, quotaSpecIsSafe, type FareQuoteSource, type PartyFare, type QuotaSpec, type QuoteQuery, type QuoteSourceName } from "./quotes";
import { dayNumber } from "./splits";
import { partySizedLink } from "./travelpayouts";
import type {
  FxRates,
  Offer,
  PartyCheckCard,
  PartyCheckMeta,
  PartyCheckPrice,
  PartyCheckRequest,
  PartyCheckResult,
  PartyCheckVerdict,
  Repo,
  SearchRequest,
} from "./types";
import { field, isRecord, MAX_ADVANCE_DAYS, MAX_PASSENGERS, MAX_STAY_NIGHTS, missing, MIN_STAY_NIGHTS, type FieldErrorCode } from "./validate";

// --- limits ---------------------------------------------------------------------------------------------

/** Per client: at most this many checks per window (each one can spend two vendor requests). */
export const PARTY_CHECK_RATE_LIMIT_MAX = 3;
export const PARTY_CHECK_RATE_LIMIT_WINDOW_SECONDS = 600;
/** Vendor requests one check reserves: one adult alone, then the whole group. */
export const PARTY_CHECK_UNITS = 2;
/** At most this share (percent) of a source's daily share may go to party checks: the rest stays for the searches' live prices. */
export const PARTY_CHECK_SHARE_PERCENT = 50;
/** And never more than this many checks per source per UTC day, whatever its share. */
export const PARTY_CHECK_MAX_PER_DAY = 5;
/** The fixed order the live check picks its source in (the same order as the search's live sources, index.ts quoteSources). */
export const PARTY_CHECK_ORDER: readonly QuoteSourceName[] = ["ignav", "wego", "searchapi", "serpapi", "duffel", "hasdata"];
/** A difference counts only from max(PARTY_MIN_DIFF_ILS, PARTY_MIN_DIFF_SHARE of the group total). */
export const PARTY_MIN_DIFF_ILS = 20;
export const PARTY_MIN_DIFF_SHARE = 0.03;
/** A card's token is accepted this long after the search answer that carried it. */
export const PARTY_TOKEN_TTL_SECONDS = 86_400;

const SOURCE_LABEL: Record<QuoteSourceName, string> = { ignav: "Ignav", wego: "Wego", searchapi: "SearchApi", serpapi: "SerpApi", duffel: "Duffel", hasdata: "HasData", ryanair: "Ryanair", aegean: "Aegean", air_canada: "Air Canada", tap: "TAP", ethiopian: "Ethiopian", air_europa: "Air Europa", philippine: "Philippine Airlines", virgin_atlantic: "Virgin Atlantic", air_new_zealand: "Air New Zealand", air_baltic: "airBaltic", sky_express: "SKY express", gol: "GOL", elal: "EL AL", direct_combination: "Official airline combination" };

// --- A) the free part: links on the cards ---------------------------------------------------------------

type Pax = Pick<SearchRequest, "adults" | "children" | "infants">;

/**
 * The card's party check: its own booking link pointed at ONE adult and at the whole group (and, for a split ticket, the return
 * one-way's too). null when it does not apply: fewer than 2 adults, or a link that is not a recognisable Aviasales search link.
 * With children or infants only the reason comes back: they must stay in a booking with an adult, so no links are offered.
 */
export function cardPartyCheck(offer: Pick<Offer, "deeplink" | "returnDeeplink" | "ticketStructure">, req: Pax): PartyCheckCard | null {
  const adults = req.adults;
  if (!Number.isInteger(adults) || adults < 2 || adults > MAX_PASSENGERS) return null;
  if (req.children > 0 || req.infants > 0) return { adults, reason: "children" };
  const one = { adults: 1 };
  const all = { adults };
  const singleLink = partySizedLink(offer.deeplink, one);
  const partyLink = partySizedLink(offer.deeplink, all);
  if (singleLink === null || partyLink === null) return null;
  if (offer.ticketStructure !== "split") return { adults, singleLink, partyLink };
  // A split ticket is two bookings: the check is only offered when both halves can be compared.
  const returnSingleLink = partySizedLink(offer.returnDeeplink, one);
  const returnPartyLink = partySizedLink(offer.returnDeeplink, all);
  return returnSingleLink !== null && returnPartyLink !== null ? { adults, singleLink, partyLink, returnSingleLink, returnPartyLink } : null;
}

/** For spreading into a card view: `{ partyCheck }` when it applies, else nothing at all (a one-adult card has no such field). */
export function partyCheckFields(offer: Pick<Offer, "deeplink" | "returnDeeplink" | "ticketStructure">, req: Pax): { partyCheck?: PartyCheckCard } {
  const check = cardPartyCheck(offer, req);
  return check ? { partyCheck: check } : {};
}

// --- the card token: a live check belongs to a card of a recent search -----------------------------------

/** What a token signs: exactly what the live check would ask a vendor for. */
export interface PartyTokenFields {
  origin: string;
  destination: string;
  departDate: string;
  returnDate: string;
  adults: number;
}

/** Signs a card's fields (index.ts wires it with the Worker's secret salt). null or a rejection = that card gets no token. */
export type PartyTokenSigner = (fields: PartyTokenFields) => Promise<string | null>;

/** "v1.<expiry in unix seconds>.<HMAC-SHA256 in base64url>". */
const TOKEN_SHAPE = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;
const encoder = new TextEncoder();

function tokenMessage(f: PartyTokenFields, exp: number): Uint8Array {
  return encoder.encode(["party-check", "v1", f.origin.toUpperCase(), f.destination.toUpperCase(), f.departDate, f.returnDate, String(f.adults), String(exp)].join("|"));
}

/** Its own key, domain-separated from every other use of the salt (the limiters hash it into their keys). */
function tokenKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(`party-check-token|${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function toBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | null {
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The token of a card: valid PARTY_TOKEN_TTL_SECONDS from `now`. Rejects without a secret (the card then gets no token). */
export async function signPartyToken(secret: string, fields: PartyTokenFields, now: Date): Promise<string> {
  if (secret === "") throw new Error("party token: no secret");
  const exp = Math.floor(now.getTime() / 1000) + PARTY_TOKEN_TTL_SECONDS;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await tokenKey(secret), tokenMessage(fields, exp)));
  return `v1.${exp}.${toBase64url(sig)}`;
}

export type PartyTokenVerdict = "ok" | "invalid" | "expired";

/**
 * Checks a card's token against exactly what the check would ask for (crypto.subtle.verify compares in constant time). A token
 * signed for other fields, with another secret, malformed, or with an expiry later than a fresh token's is "invalid"; a genuine
 * one past its expiry is "expired". Never throws.
 */
export async function verifyPartyToken(secret: string, token: string, fields: PartyTokenFields, now: Date): Promise<PartyTokenVerdict> {
  const m = TOKEN_SHAPE.exec(token);
  if (!m || secret === "") return "invalid";
  const exp = Number(m[1]);
  const sig = fromBase64url(m[2] as string);
  if (!Number.isSafeInteger(exp) || sig === null || sig.length !== 32) return "invalid";
  let genuine = false;
  try {
    genuine = await crypto.subtle.verify("HMAC", await tokenKey(secret), sig, tokenMessage(fields, exp));
  } catch {
    genuine = false;
  }
  if (!genuine) return "invalid";
  const nowSec = Math.floor(now.getTime() / 1000);
  if (exp > nowSec + PARTY_TOKEN_TTL_SECONDS + 300) return "invalid"; // not a token this Worker issued lately (clock or salt mix-up)
  return exp <= nowSec ? "expired" : "ok";
}

/**
 * partyCheckFields plus, when `sign` is given (the live check can run for this search), the token of a round-trip card with
 * links: what POST /api/party-check needs to accept a check of that card. Any trouble signing = no token (no automatic check
 * for that card; its links stay).
 */
export async function signedPartyCheckFields(
  offer: Pick<Offer, "origin" | "destination" | "departDate" | "returnDate" | "deeplink" | "returnDeeplink" | "ticketStructure">,
  req: Pax,
  sign?: PartyTokenSigner,
): Promise<{ partyCheck?: PartyCheckCard }> {
  const fields = partyCheckFields(offer, req);
  const check = fields.partyCheck;
  if (!sign || !check || !("singleLink" in check) || offer.ticketStructure !== "roundtrip") return fields;
  let token: string | null = null;
  try {
    token = await sign({ origin: offer.origin, destination: offer.destination, departDate: offer.departDate, returnDate: offer.returnDate, adults: check.adults });
  } catch {
    token = null;
  }
  return typeof token === "string" && TOKEN_SHAPE.test(token) ? { partyCheck: { ...check, token } } : fields;
}

// --- B) the live part: which source ---------------------------------------------------------------------

/** Checks per UTC day a source can take: min(PARTY_CHECK_MAX_PER_DAY, half its daily share / 2 units). 0 = it cannot afford one. */
export function partyChecksPerDay(quota: QuotaSpec): number {
  if (!quotaSpecIsSafe(quota)) return 0;
  const share = dailyShare(quota.period, quota.cap);
  return Math.max(0, Math.min(PARTY_CHECK_MAX_PER_DAY, Math.floor((share * PARTY_CHECK_SHARE_PERCENT) / 100 / PARTY_CHECK_UNITS)));
}

/** A source the live check may use: configured, able to run a series, its multi-adult price readable, a check fits its share. */
export function partyCapable(source: FareQuoteSource): boolean {
  return (
    source.configured &&
    typeof source.partySeries === "function" &&
    (source.partyPricing === "total" || source.partyPricing === "per_person") &&
    partyChecksPerDay(source.quota) >= 1
  );
}

/** The first capable source in PARTY_CHECK_ORDER, or null. */
export function partyCheckSource(sources: readonly FareQuoteSource[]): FareQuoteSource | null {
  for (const name of PARTY_CHECK_ORDER) {
    const source = sources.find((s) => s.name === name);
    if (source && partyCapable(source)) return source;
  }
  return null;
}

/**
 * meta.partyCheck, the static part: only on 2+ adults; true only without children or infants and with a capable source
 * configured. The search answer uses partyCheckMetaNow, which also asks whether that source has room for a check right now.
 */
export function partyCheckMeta(req: Pax, sources: readonly FareQuoteSource[]): { partyCheck?: PartyCheckMeta } {
  if (!Number.isInteger(req.adults) || req.adults < 2) return {};
  return { partyCheck: { available: req.children === 0 && req.infants === 0 && partyCheckSource(sources) !== null } };
}

/** What the room check reads with: the plain repo (read only) and the moment. */
export interface PartyRoomDeps {
  repo: Pick<Repo, "readAllowance">;
  now: Date;
}

/**
 * True only when `source` can take one more check right now: PARTY_CHECK_UNITS left under its cap AND in today's share, and a
 * slot left in the check's own daily cap. Read only, nothing is reserved (the check reserves for real, and can still be refused
 * when someone else took the room in between). A repo that cannot read the counters, an odd value or any error means "no".
 */
export async function partyCheckRoom(source: FareQuoteSource, deps: PartyRoomDeps): Promise<boolean> {
  if (typeof deps.repo.readAllowance !== "function") return false;
  const quotaKey = `quota:${source.name}`;
  const partyKey = `party:${source.name}`;
  try {
    const counts = await deps.repo.readAllowance(source.name, quotaPeriodKey(source.quota.period, deps.now), [quotaKey, partyKey], deps.now);
    const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
    const used = count(counts?.used);
    const shareUsed = count(counts?.daily?.[quotaKey] ?? 0);
    const checks = count(counts?.daily?.[partyKey] ?? 0);
    if (used === null || shareUsed === null || checks === null) return false;
    return (
      source.quota.cap - used >= PARTY_CHECK_UNITS &&
      dailyShare(source.quota.period, source.quota.cap) - shareUsed >= PARTY_CHECK_UNITS &&
      partyChecksPerDay(source.quota) - checks >= 1
    );
  } catch {
    return false;
  }
}

/**
 * meta.partyCheck for a search answer: partyCheckMeta, and "available" only while the chosen source has room for a check
 * (partyCheckRoom), so a spent allowance (a one-off cap never comes back) stops offering a button that could only fail.
 */
export async function partyCheckMetaNow(req: Pax, sources: readonly FareQuoteSource[], deps: PartyRoomDeps): Promise<{ partyCheck?: PartyCheckMeta }> {
  const meta = partyCheckMeta(req, sources);
  if (meta.partyCheck?.available !== true) return meta;
  const source = partyCheckSource(sources);
  return { partyCheck: { available: source !== null && (await partyCheckRoom(source, deps)) } };
}

// --- request validation ---------------------------------------------------------------------------------

/** A validated POST /api/party-check body: the token is checked by runPartyCheck (it needs the secret), null when absent. */
export type ParsedPartyCheck = Omit<PartyCheckRequest, "token"> & { token: string | null };

export type PartyCheckParse =
  | { ok: true; q: ParsedPartyCheck }
  | { ok: false; fields: Record<string, string>; fieldCodes: Record<string, FieldErrorCode> };

/**
 * POST /api/party-check body, strictly (like parseSearchBody: no coercion, every problem collected, unknown keys ignored):
 * { origin, destination (3-letter airport codes, different), departDate (not past, within MAX_ADVANCE_DAYS), returnDate (null or
 * absent = one way; else MIN_STAY_NIGHTS-MAX_STAY_NIGHTS nights later), adults (2-9), token (the card's, from the search answer) }.
 * Children and infants are refused: they must stay in a booking with an adult, so splitting a party with them is not what this
 * check prices.
 */
export function parsePartyCheckBody(body: unknown, now: Date): PartyCheckParse {
  if (!isRecord(body)) return { ok: false, fields: { body: "must be a JSON object" }, fieldCodes: { body: "invalid_format" } };
  const fields: Record<string, string> = {};
  const codes: Record<string, FieldErrorCode> = {};
  const fail = (name: string, message: string, code: FieldErrorCode): void => {
    if (!Object.hasOwn(fields, name)) {
      fields[name] = message;
      codes[name] = code;
    }
  };
  const airport = (name: string): string | null => {
    const v = field(body, name);
    if (missing(v) || (typeof v === "string" && v.trim() === "")) {
      fail(name, "is required", "required");
      return null;
    }
    if (typeof v !== "string" || !/^[A-Za-z]{3}$/.test(v.trim())) {
      fail(name, "must be a 3-letter IATA airport code", "invalid_format");
      return null;
    }
    return v.trim().toUpperCase();
  };
  const origin = airport("origin");
  const destination = airport("destination");
  if (origin !== null && destination !== null && origin === destination) fail("destination", "must differ from origin", "same_place");

  const today = Math.floor(now.getTime() / 86_400_000); // UTC day, like the search
  let departDate: string | null = null;
  let departDay: number | null = null;
  const rawDepart = field(body, "departDate");
  if (missing(rawDepart)) fail("departDate", "is required", "required");
  else if (typeof rawDepart !== "string" || dayNumber(rawDepart) === null) fail("departDate", "must be a real date formatted YYYY-MM-DD", "invalid_format");
  else {
    departDay = dayNumber(rawDepart);
    if (departDay !== null && departDay < today) fail("departDate", "must not be in the past", "past_date");
    else if (departDay !== null && departDay > today + MAX_ADVANCE_DAYS) fail("departDate", `must be within ${MAX_ADVANCE_DAYS} days from today`, "out_of_range");
    else departDate = rawDepart;
  }

  let returnDate: string | null = null;
  const rawReturn = field(body, "returnDate");
  if (!missing(rawReturn)) {
    if (typeof rawReturn !== "string" || dayNumber(rawReturn) === null) fail("returnDate", "must be null or a real date formatted YYYY-MM-DD", "invalid_format");
    else if (departDay !== null) {
      const nights = (dayNumber(rawReturn) as number) - departDay;
      if (nights < MIN_STAY_NIGHTS) fail("returnDate", `must be at least ${MIN_STAY_NIGHTS} night after departDate`, "start_after_end");
      else if (nights > MAX_STAY_NIGHTS) fail("returnDate", `must be at most ${MAX_STAY_NIGHTS} nights after departDate`, "out_of_range");
      else returnDate = rawReturn;
    }
  }

  let adults = 0;
  const rawAdults = field(body, "adults");
  if (missing(rawAdults)) fail("adults", "is required", "required");
  else if (typeof rawAdults !== "number" || !Number.isInteger(rawAdults)) fail("adults", "must be an integer", "invalid_format");
  else if (rawAdults < 2 || rawAdults > MAX_PASSENGERS) fail("adults", `must be between 2 and ${MAX_PASSENGERS}`, "out_of_range");
  else adults = rawAdults;

  for (const name of ["children", "infants"] as const) {
    const v = field(body, name);
    if (!missing(v) && v !== 0) fail(name, "the party check is for adults only: children and infants must stay in a booking with an adult", "not_supported");
  }

  let token: string | null = null;
  const rawToken = field(body, "token");
  if (!missing(rawToken)) {
    if (typeof rawToken !== "string" || !TOKEN_SHAPE.test(rawToken)) fail("token", "must be the token of a search result card", "invalid_format");
    else token = rawToken;
  }

  if (Object.keys(fields).length > 0 || origin === null || destination === null || departDate === null) return { ok: false, fields, fieldCodes: codes };
  return { ok: true, q: { origin, destination, departDate, returnDate, adults, token } };
}

// --- comparing the two answers --------------------------------------------------------------------------

export interface PartyVerdictNumbers {
  verdict: PartyCheckVerdict;
  perPersonIls: number | null;
  /** Only for "separate" (see partyVerdict); null otherwise. */
  separateEstimateIls: number | null;
  savingIls: number | null;
  thresholdIls: number | null;
}

const UNKNOWN_NUMBERS: PartyVerdictNumbers = { verdict: "unknown", perPersonIls: null, separateEstimateIls: null, savingIls: null, thresholdIls: null };
const positive = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
/** Agorot, and never a negative zero. */
const money = (v: number): number => {
  const r = round2(v);
  return r === 0 ? 0 : r;
};

/**
 * The verdict for `adults` adults, from the price of ONE adult alone (`singleIls`) and of all of them in one booking
 * (`togetherIls`). Booking one by one is an ESTIMATE: the first adult at the single price, every other one at the group's price
 * per person (the "last cheap seat" case): estimate = single + (adults - 1) x together / adults, and
 * saving = together - estimate = together / adults - single (per person; also the estimated total saving, as only the first
 * seat changes price). "separate" only when the saving is at least max(PARTY_MIN_DIFF_ILS, PARTY_MIN_DIFF_SHARE of together);
 * "together" when the group's price per person is lower than the single price by that margin; "same" otherwise; "unknown"
 * without both prices.
 * The estimate itself is returned for "separate" only: the formula assumes the single price is the LOWER one, and for any other
 * verdict it would name a cost no booking can reach (one adult at 450 and a group at 400 each: two bookings cost at least 900,
 * not 850).
 */
export function partyVerdict(singleIls: number | null, togetherIls: number | null, adults: number): PartyVerdictNumbers {
  if (!positive(singleIls) || !positive(togetherIls) || !Number.isInteger(adults) || adults < 2) return { ...UNKNOWN_NUMBERS };
  const perPerson = togetherIls / adults;
  const estimate = singleIls + (adults - 1) * perPerson;
  const saving = togetherIls - estimate;
  const threshold = Math.max(PARTY_MIN_DIFF_ILS, togetherIls * PARTY_MIN_DIFF_SHARE);
  const verdict: PartyCheckVerdict = saving >= threshold ? "separate" : -saving >= threshold ? "together" : "same";
  return {
    verdict,
    perPersonIls: money(perPerson),
    separateEstimateIls: verdict === "separate" ? money(estimate) : null,
    savingIls: money(saving),
    thresholdIls: money(threshold),
  };
}

interface Priced {
  fare: PartyFare;
  /** For everybody the request asked for, in the vendor's currency. */
  total: number;
  ils: number;
}

/** The fares with a total for the request's adults and an ILS value; a currency without a rate cannot be compared and is left out. */
function priced(fares: readonly PartyFare[], fx: FxRates, factor: number): Priced[] {
  const out: Priced[] = [];
  for (const fare of fares) {
    if (!positive(fare.amount) || !/^[A-Z]{3}$/.test(fare.currency)) continue;
    const total = fare.amount * factor;
    let ils: number;
    try {
      ils = toIls(fx, total, fare.currency);
    } catch {
      continue;
    }
    if (positive(ils)) out.push({ fare, total, ils });
  }
  return out;
}

export interface FareComparison {
  basis: "same_flight" | "cheapest" | null;
  /**
   * Why not the same flight, or why nothing: "no_single" / "no_group" (nothing priceable in that answer), "no_identity" (an
   * answer names none of its flights), "no_common_flight" (both name their flights, and none is in both). null = same flight.
   */
  why: "no_single" | "no_group" | "no_identity" | "no_common_flight" | null;
  single: Priced | null;
  together: Priced | null;
}

const cheapestOf = (list: Priced[]): Priced | null => list.reduce<Priced | null>((best, p) => (best === null || p.ils < best.ils ? p : best), null);

/**
 * Finds what to compare. When both answers name their flights (PartyFare.flightKey), the same flight in both: among the flights
 * both answers have, the one cheapest for ONE adult (where a last cheap seat shows). Otherwise the cheapest single price against
 * the cheapest group price, and the basis says so ("cheapest": possibly two different flights) and `why`. Nothing priceable on
 * either side = nothing to compare (basis null). `pricing` is how the source's multi-adult price is read.
 */
export function compareFares(single: readonly PartyFare[], group: readonly PartyFare[], adults: number, fx: FxRates, pricing: "total" | "per_person"): FareComparison {
  const one = priced(single, fx, 1);
  const all = priced(group, fx, pricing === "per_person" ? adults : 1);
  if (one.length === 0) return { basis: null, why: "no_single", single: null, together: null };
  if (all.length === 0) return { basis: null, why: "no_group", single: null, together: null };
  const groupByFlight = new Map<string, Priced>();
  for (const g of all) {
    const key = g.fare.flightKey;
    if (key === null) continue;
    const cur = groupByFlight.get(key);
    if (!cur || g.ils < cur.ils) groupByFlight.set(key, g);
  }
  let match: { one: Priced; all: Priced } | null = null;
  for (const o of one) {
    const g = o.fare.flightKey === null ? undefined : groupByFlight.get(o.fare.flightKey);
    if (!g) continue;
    if (!match || o.ils < match.one.ils || (o.ils === match.one.ils && g.ils < match.all.ils)) match = { one: o, all: g };
  }
  if (match) return { basis: "same_flight", why: null, single: match.one, together: match.all };
  const named = one.some((o) => o.fare.flightKey !== null) && groupByFlight.size > 0;
  return { basis: "cheapest", why: named ? "no_common_flight" : "no_identity", single: cheapestOf(one), together: cheapestOf(all) };
}

/**
 * Whole shekels exactly as the web shows every price (rounded UP, formatILS), and differences taken between those shown figures:
 * a sum in a note always matches the lines beside it.
 */
const up = (n: number): number => Math.ceil(n);
const shekels = (n: number): string => `₪${n.toLocaleString("en-US")}`;

/**
 * Says WHICH flight was compared (the cheapest for one among those in both answers), so it cannot read as "this card's flight";
 * the web names that flight beside it (result.flight) with its own caveat that it may not be the card's.
 */
const SAME_FLIGHT_HE = "בשתי הבדיקות השווינו את אותה טיסה (לפי מספרי הטיסות ושעות ההמראה): הזולה ביותר לנוסע אחד מבין הטיסות שהופיעו בשתיהן.";
const CHEAPEST_HE: Record<"no_identity" | "no_common_flight", string> = {
  no_identity: "הספק לא מסר פרטי טיסה (מספרי טיסות ושעות), ולכן השווינו את המחיר הזול ביותר לנוסע אחד מול הזול ביותר לכל הקבוצה. ייתכן שאלה טיסות שונות.",
  no_common_flight: "אף טיסה לא הופיעה בשתי הבדיקות, ולכן השווינו את המחיר הזול ביותר לנוסע אחד מול הזול ביותר לכל הקבוצה, בטיסות שונות.",
};

/** Why a check ends without a verdict: nothing priceable in one answer, or a lower single price that may be on another flight. */
export type PartyUnknownReason = "no_single" | "no_group" | "different_flights";

export interface PartyNoteInput {
  numbers: PartyVerdictNumbers;
  cmp: Pick<FareComparison, "basis" | "why" | "single" | "together">;
  /** Set when the verdict is "unknown". */
  reason: PartyUnknownReason | null;
  adults: number;
  sourceName: string;
  /** False when the group search was never sent (the one-adult answer held nothing usable). */
  askedGroup: boolean;
}

/** The Hebrew note of a result: the verdict in words (the separate cost always called an estimate), the basis, and the caveat. */
export function partyNoteHe(input: PartyNoteInput): string {
  const { numbers, cmp, reason, adults, sourceName } = input;
  const parts: string[] = [];
  const pricesChecked = `המחירים נבדקו עכשיו אצל ${sourceName}, והם עשויים להשתנות עד ההזמנה.`;
  if (numbers.verdict === "unknown") {
    if (reason === "different_flights") {
      const cause = cmp.why === "no_common_flight" ? "הם בטיסות שונות" : "הספק לא מסר פרטי טיסה, וייתכן שהם בטיסות שונות";
      parts.push(`המחיר הזול ביותר לנוסע אחד נמוך מהמחיר לנוסע בהזמנה המשותפת הזולה ביותר, אבל ${cause}, ולכן אי אפשר לדעת אם הזמנה נפרדת תחסוך. בדקו את אותה טיסה בשני הקישורים.`);
      parts.push(pricesChecked);
    } else {
      parts.push(
        reason === "no_group"
          ? "בחיפוש לכל הקבוצה לא נמצא מחיר שאפשר להשוות."
          : input.askedGroup
            ? "בחיפוש לנוסע אחד לא נמצא מחיר שאפשר להשוות."
            : "בחיפוש לנוסע אחד לא נמצא מחיר שאפשר להשוות, ולכן לא חיפשנו גם לכל הקבוצה.",
      );
      parts.push("אפשר לבדוק בעצמכם עם שני הקישורים.");
      parts.push(`הבדיקה נעשתה עכשיו אצל ${sourceName}.`);
    }
    return parts.join(" ");
  }
  const single = cmp.single?.ils ?? 0;
  const together = cmp.together?.ils ?? 0;
  if (numbers.verdict === "separate") {
    const saving = shekels(Math.max(0, up(together) - up(numbers.separateEstimateIls ?? together)));
    parts.push(
      adults === 2
        ? `לפי הערכה, הזמנה נפרדת לכל נוסע עשויה לחסוך כ־${saving}. זו הערכה בלבד: היא מניחה שהנוסע הראשון יקבל את המחיר לנוסע אחד, והשני את המחיר לנוסע בהזמנה המשותפת.`
        : `לפי הערכה, הזמנה נפרדת לנוסע אחד, ושאר הנוסעים יחד בהזמנה אחת, עשויה לחסוך כ־${saving}. זו הערכה בלבד: היא מניחה שהנוסע הראשון יקבל את המחיר לנוסע אחד, וכל השאר את המחיר לנוסע בהזמנה המשותפת.`,
    );
  } else if (numbers.verdict === "together") {
    const lower = shekels(Math.max(0, up(single) - up(numbers.perPersonIls ?? together / adults)));
    parts.push(`בהזמנה אחת לכולם המחיר לנוסע נמוך בכ־${lower} מהמחיר לנוסע אחד, ולכן עדיף להזמין את כולם יחד.`);
  } else {
    parts.push(`אין הבדל משמעותי (פחות מ־${shekels(up(numbers.thresholdIls ?? PARTY_MIN_DIFF_ILS))}), ולכן עדיף להזמין את כולם יחד, בהזמנה אחת.`);
  }
  parts.push(cmp.basis === "same_flight" ? SAME_FLIGHT_HE : cmp.why === "no_common_flight" ? CHEAPEST_HE.no_common_flight : CHEAPEST_HE.no_identity);
  parts.push(pricesChecked);
  return parts.join(" ");
}

// --- the endpoint ---------------------------------------------------------------------------------------

export interface ApiResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const err = (
  status: number,
  code: string,
  message: string,
  extra: { fields?: Record<string, string>; fieldCodes?: Record<string, string>; retryAfterSec?: number } = {},
): ApiResult => ({
  status,
  body: {
    error: {
      code,
      message,
      ...(extra.fields ? { fields: extra.fields } : {}),
      ...(extra.fieldCodes ? { fieldCodes: extra.fieldCodes } : {}),
      ...(extra.retryAfterSec !== undefined ? { retryAfterSec: extra.retryAfterSec } : {}),
    },
  },
  headers: extra.retryAfterSec !== undefined ? { "Retry-After": String(extra.retryAfterSec) } : undefined,
});

/** Whole seconds until the next UTC midnight (when the day's counters start again), at least 1. */
function secondsToUtcMidnight(now: Date): number {
  const day = 86_400_000;
  return Math.max(1, Math.ceil((Math.floor(now.getTime() / day) * day + day - now.getTime()) / 1000));
}

export interface PartyCheckDeps {
  /** The plain repo: the per-client limit and the check's own daily cap per source. */
  repo: Repo;
  /** The configured live sources, wired exactly like the search's (their repo takes each vendor's daily share first). */
  sources: readonly FareQuoteSource[];
  /** The day's exchange rates (production: getFxRates). Loaded BEFORE anything is reserved. */
  fx: () => Promise<FxRates>;
  /** The secret the search signed its cards' tokens with (index.ts: the limiter salt). */
  tokenSecret: string;
  now: Date;
}

/**
 * The check itself, after validation: the source, the card's token, the rates, the check's daily cap, the two units, the
 * requests, the verdict. Nothing is loaded or reserved before the token matched, nothing is reserved before the rates are in,
 * and nothing of a vendor's allowance before the check's own daily cap agreed. Errors are fixed texts: no vendor body, URL or
 * key can reach a response.
 */
export async function runPartyCheck(deps: PartyCheckDeps, q: ParsedPartyCheck): Promise<ApiResult> {
  // The sources price round trips only: a one-way check (a split ticket's half) has no source today.
  const source = q.returnDate === null ? null : partyCheckSource(deps.sources);
  const series = source?.partySeries;
  const pricing = source?.partyPricing;
  if (!source || !series || (pricing !== "total" && pricing !== "per_person") || q.returnDate === null) {
    return err(404, "unavailable", "No live fare source can run the party check right now");
  }

  // Only a card of a recent search: its token must match exactly what would be asked (route, dates, adults). A made-up route or
  // date has none, and is refused here, before the rates, any counter or any vendor.
  const asked: PartyTokenFields = { origin: q.origin, destination: q.destination, departDate: q.departDate, returnDate: q.returnDate, adults: q.adults };
  const token = q.token === null ? "invalid" : await verifyPartyToken(deps.tokenSecret, q.token, asked, deps.now);
  if (token === "expired") return err(400, "offer_expired", "This search result is too old for an automatic check: search again");
  if (token !== "ok") return err(400, "invalid_token", "A party check needs the token of a card from a recent search, for exactly its route, dates and adults");

  let fx: FxRates;
  try {
    fx = await deps.fx();
  } catch {
    return err(503, "fx_unavailable", "Exchange rates are unavailable");
  }

  // The check's own daily cap for this source (rate_limits "party:<source>"), well below the source's daily share. Fail closed.
  let granted = false;
  try {
    granted = (await deps.repo.reserveDaily(`party:${source.name}`, partyChecksPerDay(source.quota), deps.now)) === true;
  } catch {
    granted = false;
  }
  if (!granted) return err(503, "daily_limit", "Today's automatic party checks are used up", { retryAfterSec: secondsToUtcMidnight(deps.now) });

  const base: Omit<QuoteQuery, "adults"> = { origin: q.origin, destination: q.destination, departDate: q.departDate, returnDate: q.returnDate, party: { adults: q.adults } };
  let answers: PartyFare[][];
  try {
    // ONE adult first, then the whole group. The series reserves BOTH units before the first request and stops at the first
    // failure, or after a first answer without a fare this check can compare (a positive price in a currency with a rate today).
    const comparable = (fare: PartyFare): boolean => priced([fare], fx, 1).length > 0;
    answers = await series.call(source, [{ ...base, adults: 1 }, { ...base, adults: q.adults }], comparable);
  } catch (e) {
    // A day's share comes back at UTC midnight; a spent cap does not (a monthly one next month, a one-off one never).
    if (e instanceof QuoteError && e.code === "ration_exhausted") {
      return err(503, "daily_limit", "Today's share of the live source's free allowance is used up", { retryAfterSec: secondsToUtcMidnight(deps.now) });
    }
    if (e instanceof QuoteError && e.code === "quota_exhausted") return err(503, "quota_exhausted", "The live source's free allowance is used up");
    return err(503, "upstream_unavailable", "The live fare source did not answer");
  }

  const [single = [], group = []] = answers;
  const cmp = compareFares(single, group, q.adults, fx, pricing);
  const numbers = partyVerdict(cmp.single?.ils ?? null, cmp.together?.ils ?? null, q.adults);
  // Cheapest against cheapest may be two different flights: a lower single price then says nothing about booking ONE flight one
  // by one (the estimate would put the first traveller on one flight and the others on another). Never "separate" on that
  // basis: the prices found are shown, and the answer says it cannot tell. "together" and "same" stand: booking everybody on the
  // group's cheapest flight is then within the threshold of any split, on any flight.
  const mixed = cmp.basis === "cheapest" && numbers.verdict === "separate";
  const shown: PartyVerdictNumbers = mixed ? { ...UNKNOWN_NUMBERS } : numbers;
  const reason: PartyUnknownReason | null = mixed ? "different_flights" : numbers.verdict === "unknown" ? (cmp.why === "no_group" ? "no_group" : "no_single") : null;
  const withPrices = shown.verdict !== "unknown" || mixed;
  const sourceName = SOURCE_LABEL[source.name];
  const price = (p: Priced | null): PartyCheckPrice | null => (p ? { amount: round2(p.total), currency: p.fare.currency, ils: money(p.ils) } : null);
  const togetherPrice = withPrices ? price(cmp.together) : null;
  const matched = cmp.basis === "same_flight" && cmp.single ? cmp.single.fare : null;
  const result: PartyCheckResult = {
    source: source.name,
    sourceName,
    checkedAt: deps.now.toISOString(),
    adults: q.adults,
    matchBasis: withPrices ? cmp.basis : null,
    flight: matched
      ? {
          outboundDepartTime: matched.outbound.departTime,
          inboundDepartTime: matched.inbound.departTime,
          airlines: [...new Set([...matched.outbound.airlines, ...matched.inbound.airlines])],
        }
      : null,
    single: withPrices ? price(cmp.single) : null,
    together: togetherPrice ? { ...togetherPrice, perPersonIls: numbers.perPersonIls } : null,
    separateEstimateIls: shown.separateEstimateIls,
    savingIls: shown.savingIls,
    thresholdIls: shown.thresholdIls,
    verdict: shown.verdict,
    noteHe: partyNoteHe({ numbers: shown, cmp, reason, adults: q.adults, sourceName, askedGroup: answers.length >= 2 }),
    fx: { date: fx.date, source: fx.source },
  };
  return { status: 200, body: result };
}

/**
 * POST /api/party-check. The per-client limit first (so it also covers bad requests; fail closed: a check spends a vendor's free
 * allowance, nothing here runs unmetered), then the body (`readJson` is index.ts's size-capped JSON reader), then the check.
 * `clientKey` is the limiter key index.ts builds from a salted hash of the client, like every other limiter's.
 */
export async function handlePartyCheck(
  deps: PartyCheckDeps & { clientKey: string },
  readJson: () => Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }>,
): Promise<ApiResult> {
  let limit: { allowed: boolean; retryAfterSec: number };
  try {
    limit = await deps.repo.checkRateLimit(deps.clientKey, PARTY_CHECK_RATE_LIMIT_MAX, PARTY_CHECK_RATE_LIMIT_WINDOW_SECONDS, deps.now);
  } catch {
    return err(503, "storage_unavailable", "The party check is unavailable right now");
  }
  if (!limit.allowed) return err(429, "rate_limited", "Too many party checks, try again later", { retryAfterSec: limit.retryAfterSec });
  const body = await readJson();
  if (!body.ok) return body.result;
  const parsed = parsePartyCheckBody(body.value, deps.now);
  if (!parsed.ok) return err(400, "invalid_request", "The party check request is invalid", { fields: parsed.fields, fieldCodes: parsed.fieldCodes });
  return runPartyCheck(deps, parsed.q);
}
