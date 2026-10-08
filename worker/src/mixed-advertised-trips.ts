import pages from './flydubai-published-catalog.json';
import type {FlydubaiAdvertisement} from '../../collector/flydubai-fares.mjs';
import {round2} from './extras';
import type {QuoteQuery} from './quotes';
import type {FxRates} from './types';

export interface MixedAdvertisedTicket {
  origin: string;
  destination: string;
  departDate: string;
  amount: number;
  currency: string;
  sourceUrl: string;
  checkedAt: string;
  operator: null;
  cabin: null;
  departTime: null;
  arriveTime: null;
  stops: null;
  durationMin: null;
}

/** A combination of native prices; deliberately not an Offer with a fabricated aggregate currency. */
export interface MixedAdvertisedTrip {
  source: 'flydubai';
  origin: string;
  destination: string;
  departDate: string;
  returnDate: string;
  ticketStructure: 'split';
  outbound: MixedAdvertisedTicket;
  inbound: MixedAdvertisedTicket;
  checkedAt: string;
  expiresAt: string;
  comparison: {amountIls: number; fxDate: string; fxSource: string; kind: 'conversion_estimate'};
  pricing: 'published_advertisement';
  separateTickets: true;
  checkoutVerified: false;
  additionalFeesKnown: false;
}

const MAX_ROWS = 500, MAX_TRIPS = 20, MAX_CAPTURE_AGE_MS = 600_000;
const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

function validFx(fx: FxRates, now: Date): boolean {
  if (!validDate(fx.date) || typeof fx.source !== 'string' || !fx.source || fx.source.length > 64
    || !fx.ratesToIls || typeof fx.ratesToIls !== 'object' || Array.isArray(fx.ratesToIls)) return false;
  const days = (Date.parse(now.toISOString().slice(0, 10)) - Date.parse(fx.date)) / 86_400_000;
  const rates = Object.entries(fx.ratesToIls);
  return days >= 0 && days <= 7 && (days === 0 || fx.source.endsWith(':stale')) && fx.ratesToIls.ILS === 1
    && positive(fx.ratesToIls.USD) && rates.length <= 64
    && rates.every(([currency, rate]) => /^[A-Z]{3}$/.test(currency) && positive(rate));
}

/**
 * Compose only explicit, approved fresh one-way ads for exact dates and one adult.
 * The caller supplies independently validated FX. This helper never fetches or renews captures.
 * Original amounts stay in separate tickets; the ILS amount is only a dated comparison estimate.
 */
export function mixedAdvertisedTrips(fares: readonly FlydubaiAdvertisement[], q: QuoteQuery,
  fx: FxRates, now: Date): MixedAdvertisedTrip[] {
  const at = now.getTime();
  if (!Number.isFinite(at) || !Array.isArray(fares) || fares.length > MAX_ROWS
    || q.party.adults !== 1 || (q.party.children ?? 0) !== 0 || (q.party.infants ?? 0) !== 0
    || (q.adults ?? 1) !== 1 || !validDate(q.departDate) || !validDate(q.returnDate)
    || q.returnDate <= q.departDate || q.departDate < now.toISOString().slice(0, 10)
    || !/^[A-Z]{3}$/.test(q.origin) || !/^[A-Z]{3}$/.test(q.destination)
    || q.origin === q.destination || !validFx(fx, now)) return [];

  type Priced = {fare: FlydubaiAdvertisement; ils: number; order: number};
  const clean: Priced[] = [], seen = new Set<string>();
  for (const fare of fares) {
    if (!fare || fare.structure !== 'oneway' || fare.returnDate !== null || fare.pricing !== 'published_advertisement'
      || !positive(fare.amount) || fare.amount > 10_000_000 || !/^[A-Z]{3}$/.test(fare.currency)
      || !validDate(fare.departDate) || !pages.some(page => page.sourceUrl === fare.sourceUrl
        && page.origin === fare.origin && page.destination === fare.destination)) continue;
    const age = at - Date.parse(fare.checkedAt);
    const rate = Object.hasOwn(fx.ratesToIls, fare.currency) ? fx.ratesToIls[fare.currency] : undefined;
    if (!Number.isFinite(age) || age < 0 || age >= MAX_CAPTURE_AGE_MS || !positive(rate)) continue;
    const ils = fare.amount * rate;
    if (!positive(ils)) continue;
    const identity = JSON.stringify([fare.origin, fare.destination, fare.departDate, fare.amount,
      fare.currency, fare.sourceUrl, fare.checkedAt]);
    if (seen.has(identity)) continue;
    seen.add(identity); clean.push({fare, ils, order: clean.length});
  }
  const outgoing = clean.filter(p => p.fare.origin === q.origin && p.fare.destination === q.destination
    && p.fare.departDate === q.departDate);
  const incoming = clean.filter(p => p.fare.origin === q.destination && p.fare.destination === q.origin
    && p.fare.departDate === q.returnDate).sort((a, b) => a.ils - b.ils || a.order - b.order);

  type Candidate = {out: Priced; back: Priced; backIndex: number; compatible: Priced[]; ils: number};
  const byOutgoingCurrency = new Map<string, Priced[]>(), queue: Candidate[] = [];
  const before = (a: Candidate, b: Candidate) => a.ils < b.ils
    || a.ils === b.ils && (a.out.order < b.out.order || a.out.order === b.out.order && a.back.order < b.back.order);
  const insert = (item: Candidate) => {
    let low = 0, high = queue.length;
    while (low < high) {const middle = (low + high) >>> 1; if (before(item, queue[middle]!)) high = middle; else low = middle + 1;}
    queue.splice(low, 0, item);
  };
  for (const out of outgoing) {
    let compatible = byOutgoingCurrency.get(out.fare.currency);
    if (!compatible) {compatible = incoming.filter(back => back.fare.currency !== out.fare.currency); byOutgoingCurrency.set(out.fare.currency, compatible);}
    const back = compatible[0];
    if (back && positive(out.ils + back.ils)) insert({out, back, backIndex: 0, compatible, ils: out.ils + back.ils});
  }

  const ticket = (fare: FlydubaiAdvertisement): MixedAdvertisedTicket => ({
    origin: fare.origin, destination: fare.destination, departDate: fare.departDate,
    amount: fare.amount, currency: fare.currency, sourceUrl: fare.sourceUrl, checkedAt: fare.checkedAt,
    operator: null, cabin: null, departTime: null, arriveTime: null, stops: null, durationMin: null,
  });
  const result: MixedAdvertisedTrip[] = [];
  // Each outgoing fare walks its compatible returns in price order: no 500-by-500 matrix is materialized.
  while (queue.length && result.length < MAX_TRIPS) {
    const current = queue.shift()!;
    const checkedAt = Date.parse(current.out.fare.checkedAt) <= Date.parse(current.back.fare.checkedAt)
      ? current.out.fare.checkedAt : current.back.fare.checkedAt;
    const amountIls = round2(current.ils);
    if (positive(amountIls)) result.push({source: 'flydubai', origin: q.origin, destination: q.destination,
      departDate: q.departDate, returnDate: q.returnDate, ticketStructure: 'split',
      outbound: ticket(current.out.fare), inbound: ticket(current.back.fare), checkedAt,
      expiresAt: new Date(Date.parse(checkedAt) + MAX_CAPTURE_AGE_MS).toISOString(),
      comparison: {amountIls, fxDate: fx.date, fxSource: fx.source, kind: 'conversion_estimate'},
      pricing: 'published_advertisement', separateTickets: true, checkoutVerified: false, additionalFeesKnown: false});
    const backIndex = current.backIndex + 1, back = current.compatible[backIndex];
    if (back && positive(current.out.ils + back.ils)) insert({...current, backIndex, back, ils: current.out.ils + back.ils});
  }
  return result;
}
