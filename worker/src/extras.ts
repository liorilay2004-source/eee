/**
 * Extras + FX step of the pipeline (SPEC §4.1, §7 step 7). Port of pipeline.apply_extras_and_fx.
 *
 * Paid extras the user did not ask for are never added to the price. Extras that are already
 * included are shown as a bonus tag and never penalised. Unknown carriers get a tag, never a guess.
 */
import { toIls } from "./money";
import { BAG_FEES, type BagFee, type BagFeeTable } from "./scoring.config";
import type { FxRates, Leg, Offer, SearchRequest } from "./types";

export const TAG_BONUS_BAG = "bonus_checked_bag";
export const TAG_BAG_UNKNOWN = "bag_fee_unknown";

/** Every traveller pays a bag fee, infants included (mirrors SearchRequest.pax in Python). */
export function paxCount(req: Pick<SearchRequest, "adults" | "children" | "infants">): number {
  return req.adults + req.children + req.infants;
}

/**
 * Round to 2 decimals exactly like Python's round(x, 2): ties (only possible for values whose
 * fraction is an odd multiple of 1/8, e.g. 0.125) go to the even cent, while Number.prototype.toFixed
 * would round them up. Everything else is correctly rounded by toFixed.
 */
export function round2(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const eighths = a * 8;
  if (Number.isInteger(eighths) && eighths % 2 === 1) {
    const cents = Math.floor(a * 100);
    return (sign * (cents % 2 === 0 ? cents : cents + 1)) / 100;
  }
  return Number((sign * a).toFixed(2));
}

/** ILS value, or null when there is no FX rate: an unconvertible amount must not be guessed. */
function ilsOrNull(fx: FxRates, amount: number, currency: string): number | null {
  try {
    const v = toIls(fx, amount, currency);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function checkedBagFee(table: BagFeeTable, carrier: string | undefined): BagFee | undefined {
  if (carrier === undefined || !Object.hasOwn(table, carrier)) return undefined;
  return table[carrier]?.checkedBag;
}

/**
 * Checked-bag fee of one leg for ONE traveller in ILS, or null when the carrier or the fee currency is unknown.
 * Split-ticket building uses it to pick each leg on fare + fee (SPEC §4.1), not on the base fare alone.
 */
export function legBagFeeIls(leg: Leg, fx: FxRates, bagFees: BagFeeTable = BAG_FEES): number | null {
  const fee = checkedBagFee(bagFees, leg.airlines[0]);
  return fee ? ilsOrNull(fx, fee.amount, fee.currency) : null;
}

/**
 * Fills extrasAmountIls, totalIls and the bag tags on every offer (mutating).
 * Idempotent: everything is recomputed from priceAmount/priceCurrency, so re-running after an FX or
 * request change never double-counts a fee. Unrelated tags are preserved.
 *
 * Deviation from Python: an offer whose currency (or a bag fee's currency) has no FX rate does not
 * raise. Its totalIls stays null (recommend() skips it) / the fee is treated as unknown, so one odd
 * fare cannot fail a whole search.
 */
export function applyExtrasAndFx(
  offers: Offer[],
  req: SearchRequest,
  fx: FxRates,
  bagFees: BagFeeTable = BAG_FEES,
): void {
  const pax = paxCount(req);
  for (const o of offers) {
    o.tags = o.tags.filter((t) => t !== TAG_BONUS_BAG && t !== TAG_BAG_UNKNOWN);
    let extras = 0;
    const included = Boolean(o.includes.checkedBag);
    if (req.checkedBag && !included) {
      for (const leg of [o.outbound, o.inbound]) {
        const feeIls = legBagFeeIls(leg, fx, bagFees);
        if (feeIls !== null) extras += feeIls * pax;
        else if (!o.tags.includes(TAG_BAG_UNKNOWN)) o.tags.push(TAG_BAG_UNKNOWN);
      }
    } else if (included && !req.checkedBag) {
      o.tags.push(TAG_BONUS_BAG); // never penalised
    }
    o.extrasAmountIls = round2(extras);
    const base = ilsOrNull(fx, o.priceAmount, o.priceCurrency);
    o.totalIls = base === null ? null : round2(base + extras);
  }
}
