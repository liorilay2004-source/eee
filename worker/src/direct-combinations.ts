/** Compose separately priced official one-way fares. No requests and no inferred return prices. */
import type { Leg } from "./types";
export interface PricedDirection {
  source: string;
  airline: string;
  origin: string;
  destination: string;
  date: string;
  amount: number;
  currency: string;
  checkedAt: string;
  bookingUrl: string;
  leg?: Leg;
}
export interface DirectCombination {
  outbound: PricedDirection;
  inbound: PricedDirection;
  amount: number;
  currency: string;
  checkedAt: string;
  separateTickets: true;
}
const valid = (f: PricedDirection): boolean => /^[A-Z]{3}$/.test(f.origin) && /^[A-Z]{3}$/.test(f.destination)
  && f.origin !== f.destination && /^[A-Z0-9]{2}$/.test(f.airline) && /^[A-Z]{3}$/.test(f.currency)
  && Number.isFinite(f.amount) && f.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(f.date)
  && Number.isFinite(Date.parse(f.date)) && new Date(f.date).toISOString().slice(0, 10) === f.date
  && Number.isFinite(Date.parse(f.checkedAt));
export function combineDirectDirections(fares: readonly PricedDirection[], q: {
  origin: string; destination: string; departDate: string; returnDate: string;
  adults: number; children: number; infants: number;
}): DirectCombination[] {
  if (q.adults !== 1 || q.children !== 0 || q.infants !== 0 || q.returnDate <= q.departDate) return [];
  const clean = fares.filter(valid);
  const outs = clean.filter(f => f.origin === q.origin && f.destination === q.destination && f.date === q.departDate);
  const backs = clean.filter(f => f.origin === q.destination && f.destination === q.origin && f.date === q.returnDate);
  const combinations: DirectCombination[] = [];
  const seen = new Set<string>();
  for (const outbound of outs) for (const inbound of backs) {
    // Currency conversion belongs to comparison, never invent a same-currency amount here.
    if (outbound.airline === inbound.airline || outbound.currency !== inbound.currency) continue;
    const key = JSON.stringify([outbound, inbound]);
    if (seen.has(key)) continue;
    seen.add(key);
    const amount = Math.round((outbound.amount + inbound.amount) * 100) / 100;
    if (!Number.isFinite(amount)) continue;
    combinations.push({ outbound, inbound, amount,
      currency: outbound.currency, checkedAt: Date.parse(outbound.checkedAt) < Date.parse(inbound.checkedAt) ? outbound.checkedAt : inbound.checkedAt,
      separateTickets: true });
  }
  // Rank only within a currency; never compare numeric EUR and USD amounts as though equal.
  return combinations.sort((a, b) => a.currency.localeCompare(b.currency) || a.amount - b.amount);
}
