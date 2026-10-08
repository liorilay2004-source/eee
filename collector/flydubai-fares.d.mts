/** Explicit dated public advertisements, without inferred flight or cabin details. */
export interface FlydubaiAdvertisement {
  origin: string;
  destination: string;
  departDate: string;
  returnDate: string | null;
  amount: number;
  currency: string;
  structure: 'oneway' | 'roundtrip';
  sourceUrl: string;
  checkedAt: string;
  pricing: 'published_advertisement';
}

export function normalizeFlydubaiFares(rows: unknown[], context: {
  origin: string;
  destination: string;
  sourceUrl: string;
  checkedAt: string;
}): FlydubaiAdvertisement[];
