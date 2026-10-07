/**
 * Public fares from EL AL's published Flight Deals pages. This source makes a plain GET to the official, sitemap-listed
 * page for a route touching TLV. It never opens or submits the booking widget, and does not follow redirects. The page
 * states that its prices are one-adult Economy round trips, include taxes and surcharges, and may reflect searches from
 * the last 12 hours. Only an exact airport/date match is returned; flight times, stops and bags remain unknown.
 */
import type { Resolver } from "../airports/types";
import { createQuoteSource, QuoteError, type FareQuoteSource, type ParsedFare, type QuoteAdapter, type QuoteQuery, type QuotaSpec } from "../quotes";
import type { Leg, Repo } from "../types";
import dealRoutes from "./elal-deals-routes.json";

const ROOT = "https://www.elal.com/flight-deals/en-il/";
const ROUTES = new Set<string>(dealRoutes);
const MAX_HTML_CHARS = 2_000_000;
const MAX_FARES = 600;
const UNKNOWN_LEG: Leg = { departTime: null, arriveTime: null, stops: null, durationMin: null, airlines: ["LY"] };

/** One public-page request is the local budget unit. These caps are owner-side limits, not an EL AL allowance. */
export const ELAL_DEALS_QUOTA: Readonly<QuotaSpec> = Object.freeze({ period: "monthly", cap: 100, allowance: 100, localBudget: true });

const SLUG_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "hong kong": "hong-kong-china",
  "naples": "naples-italy",
  "patras": "patras-peloponnese",
  "sitia": "sitia-crete",
});

function slugFor(code: string, resolver: Resolver): string | null {
  const name = resolver.cityNameEn(code);
  if (!name) return null;
  const alias = SLUG_ALIASES[name.trim().toLowerCase()];
  const slug = alias ?? name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
}

/** URL only for currently published sitemap pages. A user value is never interpolated as a host or query parameter. */
export function elalDealsRouteUrl(origin: string, destination: string, resolver: Resolver): string | null {
  const from = origin.trim().toUpperCase();
  const to = destination.trim().toUpperCase();
  if (from === "TLV" && to !== "TLV") {
    const slug = slugFor(to, resolver);
    const path = slug ? `flights-from-tel-aviv-to-${slug}` : "";
    return ROUTES.has(path) ? `${ROOT}${path}` : null;
  }
  if (to === "TLV" && from !== "TLV") {
    const slug = slugFor(from, resolver);
    const path = slug ? `flights-from-${slug}-to-tel-aviv` : "";
    return ROUTES.has(path) ? `${ROOT}${path}` : null;
  }
  return null;
}

interface PublicFare {
  origin: string;
  destination: string;
  departDate: string;
  returnDate: string;
  price: number;
  currency: string;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, decimal: string) => String.fromCodePoint(Number(decimal)));
}

function textOf(html: string): string {
  return decodeHtml(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function visibleText(html: string): string {
  return textOf(html.replace(/<(script|style|audio)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " "));
}

function dateFromText(value: string): string | null {
  const match = /^([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(match[1] as string);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 0 || day < 1 || day > 31 || year < 2020 || year > 2100) return null;
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function datePair(value: string): [string, string] | null {
  const match = /([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s*[-–—]\s*([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/.exec(value);
  if (!match) return null;
  const depart = dateFromText(match[1] as string);
  const ret = dateFromText(match[2] as string);
  return depart && ret && ret >= depart ? [depart, ret] : null;
}

function priceFromText(value: string): { price: number; currency: string } | null {
  const match = /\b([A-Z]{3})\s*([\d][\d,]*(?:\.\d{1,2})?)/.exec(value);
  if (!match) return null;
  const price = Number((match[2] as string).replace(/,/g, ""));
  const currency = match[1] as string;
  return Number.isFinite(price) && price > 0 && price < 10_000_000 ? { price, currency } : null;
}

function routeCodes(value: string): [string, string] | null {
  const match = /^\s*([A-Z]{3})\s*[–—-]\s*([A-Z]{3})\s*,/.exec(value);
  return match ? [match[1] as string, match[2] as string] : null;
}

function addFare(out: PublicFare[], seen: Set<string>, fare: PublicFare | null): void {
  if (!fare || fare.origin === fare.destination || fare.departDate > fare.returnDate) return;
  if (!/^[A-Z]{3}$/.test(fare.origin) || !/^[A-Z]{3}$/.test(fare.destination) || !/^[A-Z]{3}$/.test(fare.currency)) return;
  const key = [fare.origin, fare.destination, fare.departDate, fare.returnDate, fare.price, fare.currency].join("|");
  if (seen.has(key) || out.length >= MAX_FARES) return;
  seen.add(key);
  out.push(fare);
}

function cell(row: string, name: string): string {
  const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<td\\b[^>]*\\bdata-test=["']${safeName}["'][^>]*>([\\s\\S]*?)<\\/td>`, "i").exec(row);
  return match ? textOf(match[1] as string) : "";
}

function faresFromRows(html: string, out: PublicFare[], seen: Set<string>): void {
  const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi) ?? [];
  for (const row of rows) {
    if (out.length >= MAX_FARES) return;
    const originCell = cell(row, "origin-col");
    const destinationCell = cell(row, "destination-col");
    const fareType = cell(row, "fare-type-col");
    const dates = datePair(cell(row, "dates-col"));
    const priceCell = cell(row, "price-col");
    if (!/round\s*trip/i.test(fareType) || !/economy/i.test(fareType) || !/\bfrom\b/i.test(priceCell) || !dates) continue;
    const origin = /\(([A-Z]{3})\)/.exec(originCell)?.[1];
    const destination = /\(([A-Z]{3})\)/.exec(destinationCell)?.[1];
    const price = priceFromText(priceCell);
    if (!origin || !destination || !price) continue;
    addFare(out, seen, { origin, destination, departDate: dates[0], returnDate: dates[1], ...price });
  }
}

function faresFromDailyBars(html: string, out: PublicFare[], seen: Set<string>): void {
  const bars = html.match(/<span\b[^>]*\bdata-att=["']bar-fare-text["'][^>]*>[^<]*<\/span\s*>/gi) ?? [];
  for (const bar of bars) {
    if (out.length >= MAX_FARES) return;
    const value = textOf(bar);
    const route = routeCodes(value);
    const dates = datePair(value);
    const price = priceFromText(value);
    if (!route || !dates || !/\bfrom\b/i.test(value) || !price) continue;
    addFare(out, seen, { origin: route[0], destination: route[1], departDate: dates[0], returnDate: dates[1], ...price });
  }
}

/** Parses only the official page's semantic fare rows and histogram labels; arbitrary page text is never treated as a fare. */
export function parseElalDealsHtml(html: string): PublicFare[] {
  if (typeof html !== "string" || html.length === 0 || html.length > MAX_HTML_CHARS) throw new QuoteError("response");
  if (/__cf_chl|verify you are human|unusual traffic|access denied|request blocked|queue-it|captcha challenge/i.test(html)) throw new QuoteError("blocked");
  const text = visibleText(html);
  const disclaimer = /fares and availability are based on round trip searches for (?:1 passenger|one passenger)\s*\(1 adult\) in economy class in (?:the )?last 12 hours\.\s*fares (?:are inclusive of|include) tax and surcharges, and subject to availability/i.test(text);
  if (!disclaimer) throw new QuoteError("response");
  const fares: PublicFare[] = [];
  const seen = new Set<string>();
  faresFromRows(html, fares, seen);
  faresFromDailyBars(html, fares, seen);
  return fares;
}

export function createElalDealsSource(opts: {
  origin: string;
  destination: string;
  resolver: Resolver;
  repo: Repo;
  now: Date;
  fetchFn?: typeof fetch;
}): FareQuoteSource {
  const url = elalDealsRouteUrl(opts.origin, opts.destination, opts.resolver);
  const adapter: QuoteAdapter = {
    name: "elal",
    quota: ELAL_DEALS_QUOTA,
    enabled: url !== null,
    requiresKey: false,
    responseFormat: "text",
    accept: "text/html,application/xhtml+xml",
    requestScope: "search",
    blockedStatuses: [401, 403, 492],
    maxResponseChars: MAX_HTML_CHARS,
    partyPricing: "unknown",
    request() {
      if (!url) throw new QuoteError("not_configured");
      return { url, headers: { "Accept-Language": "en" } };
    },
    parse(body, q: QuoteQuery): ParsedFare[] {
      if (typeof body !== "string") throw new QuoteError("response");
      const seen = new Set<string>();
      return parseElalDealsHtml(body)
        .filter((f) => f.origin === q.origin && f.destination === q.destination && f.departDate === q.departDate && f.returnDate === q.returnDate)
        .filter((f) => {
          const key = `${f.price}|${f.currency}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((f) => ({
          price: f.price,
          currency: f.currency,
          outbound: { ...UNKNOWN_LEG, airlines: [...UNKNOWN_LEG.airlines] },
          inbound: { ...UNKNOWN_LEG, airlines: [...UNKNOWN_LEG.airlines] },
        }));
    },
    offerLinks: () => ({ deeplink: null, verifyLink: url }),
  };
  return createQuoteSource(adapter, { repo: opts.repo, now: opts.now, fetchFn: opts.fetchFn });
}
