import type { Offer } from "./types";
/** Retain independently priced tickets only when they match the complete fare and carriers. */
export function parseTicketPrices(raw: unknown, offer: Pick<Offer, "ticketStructure" | "priceAmount" | "priceCurrency" | "outbound" | "inbound">): Offer["ticketPrices"] {
  if (offer.ticketStructure !== "split" || !raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const leg = (rawLeg: unknown, airlines: string[]) => {
    if (!rawLeg || typeof rawLeg !== "object") return null;
    const r = rawLeg as Record<string, unknown>;
    if (typeof r.amount !== "number" || !Number.isFinite(r.amount) || r.amount <= 0
      || typeof r.currency !== "string" || r.currency !== offer.priceCurrency
      || typeof r.airline !== "string" || !airlines.includes(r.airline)) return null;
    return { amount: r.amount, currency: r.currency, airline: r.airline };
  };
  const outbound = leg(value.outbound, offer.outbound.airlines);
  const inbound = leg(value.inbound, offer.inbound.airlines);
  if (!outbound || !inbound || Math.round((outbound.amount + inbound.amount) * 100) !== Math.round(offer.priceAmount * 100)) return undefined;
  return { outbound, inbound };
}
