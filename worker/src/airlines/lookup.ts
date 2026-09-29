/**
 * Airline reference table (IATA code -> Hebrew name, English name, low-cost flag) for the carriers of TLV and ETM.
 *
 * Offers carry airline CODES only (WEB_APP_SPEC 7.7 gap 7), and "W6" means nothing to most users. The search answer
 * therefore adds, per card, the names of the airlines that card's legs name. A code missing from the table is simply
 * left out of the maps: the client shows the bare code, never a guessed name (P1). Sources and licence: airlines.json.
 *
 * Pure data, no I/O: the table is bundled and the lookup is a Map read, so it costs no subrequest and no D1 row.
 */
import type { Offer } from "../types";
import airlinesData from "./airlines.json";

export interface AirlineInfo {
  nameHe: string;
  nameEn: string;
  /** True only when the carrier is listed as a low-cost airline by the source named in airlines.json. */
  lowCost: boolean;
}

interface AirlineRow extends AirlineInfo {
  iata: string;
  heSource: string;
}

/** Two-character IATA airline designator: letters and digits, at least one letter ("W6", "6H", "2S"). */
const AIRLINE_CODE = /^(?=.*[A-Z])[A-Z0-9]{2}$/;

const TABLE: ReadonlyMap<string, AirlineInfo> = new Map(
  (airlinesData.airlines as AirlineRow[]).map((a) => [a.iata, Object.freeze({ nameHe: a.nameHe, nameEn: a.nameEn, lowCost: a.lowCost })]),
);

/** The table entry for one code, or null. Exact match only: codes are upper case in every source we read. */
export function airlineInfo(code: unknown): AirlineInfo | null {
  if (typeof code !== "string" || !AIRLINE_CODE.test(code)) return null;
  return TABLE.get(code) ?? null;
}

/** Every airline code an offer names, outbound first, each once, in order of first appearance. */
export function offerAirlineCodes(offer: Pick<Offer, "outbound" | "inbound">): string[] {
  const out: string[] = [];
  for (const leg of [offer.outbound, offer.inbound]) {
    for (const code of Array.isArray(leg?.airlines) ? leg.airlines : []) if (typeof code === "string" && !out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * The additive per-card fields: `airlineNames` (code -> Hebrew display name, the optional field of WEB_APP_SPEC 7.2)
 * and `airlines` (code -> { nameHe, nameEn, lowCost }). Only known codes appear; both are {} when none is known.
 * Fresh objects every call, so a caller can never mutate the shared table.
 */
export function airlineFieldsFor(offer: Pick<Offer, "outbound" | "inbound">): { airlineNames: Record<string, string>; airlines: Record<string, AirlineInfo> } {
  const airlineNames: Record<string, string> = {};
  const airlines: Record<string, AirlineInfo> = {};
  for (const code of offerAirlineCodes(offer)) {
    const info = airlineInfo(code);
    if (!info) continue;
    airlineNames[code] = info.nameHe;
    airlines[code] = { nameHe: info.nameHe, nameEn: info.nameEn, lowCost: info.lowCost };
  }
  return { airlineNames, airlines };
}

/** Number of carriers in the bundled table (for tests and the health of the dataset). */
export const AIRLINE_COUNT = TABLE.size;
