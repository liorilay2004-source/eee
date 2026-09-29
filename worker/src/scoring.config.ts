/**
 * Typed camelCase view of /config/scoring.json and /config/bag_fees.json.
 * The JSON files stay the single source of truth shared with the Python engine (engine/tpe/config.py);
 * SPEC §8 requires penalties to live in config, never in scoring code.
 */
import scoringJson from "../../config/scoring.json";
import bagFeesJson from "../../config/bag_fees.json";

export interface ScoringConfig {
  /** Added once per leg departing in [nightStartHour, nightEndHour). */
  nightDeparturePenaltyIls: number;
  nightStartHour: number;
  nightEndHour: number;
  /** Added per stop, per leg. */
  stopPenaltyIls: number;
  /** Added per hour above the fastest option in that direction, per leg. */
  durationPenaltyIlsPerHour: number;
  defaultDropPct: number;
  cacheTtlHours: number;
  topNCandidates: number;
}

export const SCORING: ScoringConfig = {
  nightDeparturePenaltyIls: scoringJson.night_departure_penalty_ils,
  nightStartHour: scoringJson.night_start_hour,
  nightEndHour: scoringJson.night_end_hour,
  stopPenaltyIls: scoringJson.stop_penalty_ils,
  durationPenaltyIlsPerHour: scoringJson.duration_penalty_ils_per_hour,
  defaultDropPct: scoringJson.default_drop_pct,
  cacheTtlHours: scoringJson.cache_ttl_hours,
  topNCandidates: scoringJson.top_n_candidates,
};

/** Per-passenger, per-leg fee in its own currency (converted to ILS at comparison time, SPEC §4.2). */
export interface BagFee {
  amount: number;
  currency: string;
}

export interface AirlineBagFees {
  checkedBag?: BagFee;
  note?: string;
}

/** Keyed by airline IATA code. Airlines missing here are "unknown", never guessed (SPEC §4.1). */
export type BagFeeTable = Record<string, AirlineBagFees>;

function loadBagFees(): BagFeeTable {
  const table: BagFeeTable = {};
  for (const [airline, entry] of Object.entries(bagFeesJson.fees)) {
    table[airline] = {
      checkedBag: { amount: entry.checked_bag.amount, currency: entry.checked_bag.currency },
      note: entry.note,
    };
  }
  return table;
}

export const BAG_FEES: BagFeeTable = loadBagFees();
