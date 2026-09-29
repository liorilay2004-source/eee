import type { FxRates } from "./types";

/** Convert an amount in `currency` to ILS at comparison/display time (SPEC §4.2). Throws on unknown currency. */
export function toIls(fx: FxRates, amount: number, currency: string): number {
  const rate = fx.ratesToIls[currency.toUpperCase()];
  if (rate === undefined) throw new Error(`No FX rate for ${currency}`);
  return amount * rate;
}
