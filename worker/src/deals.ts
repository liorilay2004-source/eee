/**
 * Deal / error-fare detector. Pure and deterministic: no I/O, no clock reads (`now` is a parameter), no randomness.
 *
 * A fare is judged against the history of ITS OWN date pair (see detectDeals) with ROBUST statistics: the median and
 * the scaled MAD, never the mean and standard deviation, because one past error fare or one overpriced peak day would
 * drag those and hide (or invent) the next one. A verdict needs a big enough relative drop, a low enough robust
 * z-score AND a price the history has hardly ever reached: the drop alone would flag every ordinary swing of a noisy
 * bucket, the z-score alone would flag a 4 % dip of a bucket that never moves, and the two together still flag the
 * cheap half of a history that sits on two price levels (the rank rule in assessPrice closes that hole).
 *
 * Evidence rules (assessPrice): a hard minimum of distinct observations spread over a minimum of days and of calendar
 * days, the candidate is never part of its own baseline, and a time bin counts once. That last rule matters: one cron
 * run stores many date pairs with the SAME checkedAt (see historyRows in pipeline.ts) and every fresh user search
 * stamps its own checkedAt, so raw counts would let one run, or ten minutes of searching, pass for a week of evidence.
 * Per bin the cheapest fare is kept, which is also what the candidate is (the cheapest fare of the latest run).
 *
 * Prices in the table are per traveller (the pipeline stores the total divided by the passenger count), so
 * searches for different party sizes are comparable.
 */
import { round2 } from "./extras";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** 1 / (inverse normal CDF at 0.75): scales the MAD to match a standard deviation on normally distributed data. */
const MAD_SCALE = 1.4826;
/** Keeps the boundary comparisons exact despite float noise (a 30 % drop can come out as 29.999999999999996). */
const EPS = 1e-9;
/** The trend line is fitted to at most this many of the newest observations (the pairwise slopes are O(n^2)), and to at least this many (a line through fewer points fits any noise perfectly). */
const TREND_MAX_POINTS = 60;
const TREND_MIN_POINTS = 8;
/**
 * A trend is only believed when the line moves the price over the window by at least this many times the scatter that
 * is left around it: a line fitted to noise moves it by about one scatter, and using one would only add error.
 */
const TREND_MIN_SNR = 4;

// --- configuration ------------------------------------------------------------------------------------

export interface DealConfig {
  /** Distinct observations (candidate excluded) needed before any verdict other than insufficient_data. */
  minSamples: number;
  /** Days between the oldest and the newest of those observations needed for the same. */
  minSpanDays: number;
  /** Distinct UTC calendar days those observations must fall on, for the same. */
  minDistinctDays: number;
  /** Snapshots in the same UTC bin of this many hours are ONE observation (the cheapest): searches minutes apart are one look. */
  binHours: number;
  /** Percent below the median at which a fare is a deal / an error fare (inclusive). */
  dealDropPct: number;
  errorDropPct: number;
  /** The robust z-score must also be at or below -minRobustZ. */
  minRobustZ: number;
  /** Floor for the scale, as a fraction of the median: identical prices give MAD 0 and any dip would score infinity. Also the tolerance of the rank rule. */
  minRelSpread: number;
  /** A price that at most this many earlier observations already reached (within minRelSpread) can still be a deal. */
  maxPriorAtOrBelow: number;
  /** Observations up to this many days before the candidate can be fitted with a trend line. */
  trendWindowDays: number;
  /** ...which is used only when the fitted line moves the price by at least this percent over the window. */
  minTrendPct: number;
  /** detectDeals only: a candidate checked longer ago than this is not a live deal. */
  liveWithinHours: number;
  /** detectDeals only: rows stamped up to this many minutes after `now` still count as now (clock skew, a slow upstream). */
  futureToleranceMinutes: number;
}

/**
 * Every number here is a tunable estimate, chosen to be conservative, NOT a sourced figure. 12 observations over 7
 * days on 5 different days is enough for a median and a MAD to mean something without waiting weeks (the hourly cron
 * gives one route only a few observations a day), 6-hour bins keep a burst of searches from counting as a week of
 * evidence, 30 % / 50 % are the "worth a look" / "probably a mistake" cut-offs, 3.5 is a common rule of thumb for
 * modified z-scores, a price is only news while at most one earlier observation was as cheap, 21 days is a window
 * short enough to follow a seasonal climb, a trend of 10 % over it is worth correcting for (less is noise, and a flat
 * bucket keeps the plain median), and 48 hours keeps an alert from advertising a fare that is long gone. Re-tune
 * against real history once there is some.
 */
export const DEAL_CONFIG: Readonly<DealConfig> = {
  minSamples: 12,
  minSpanDays: 7,
  minDistinctDays: 5,
  binHours: 6,
  dealDropPct: 30,
  errorDropPct: 50,
  minRobustZ: 3.5,
  minRelSpread: 0.02,
  maxPriorAtOrBelow: 1,
  trendWindowDays: 21,
  minTrendPct: 10,
  liveWithinHours: 48,
  futureToleranceMinutes: 5,
};

/** Caller overrides win; a missing or non-finite value falls back to the default instead of poisoning every comparison. */
function resolveConfig(over: Partial<DealConfig>): DealConfig {
  const cfg = { ...DEAL_CONFIG };
  for (const key of Object.keys(DEAL_CONFIG) as (keyof DealConfig)[]) {
    const v = over[key];
    if (typeof v === "number" && Number.isFinite(v)) cfg[key] = v;
  }
  if (!(cfg.minRelSpread > 0)) cfg.minRelSpread = DEAL_CONFIG.minRelSpread; // 0 would divide by zero on a flat bucket
  if (!(cfg.binHours > 0)) cfg.binHours = DEAL_CONFIG.binHours; // 0 would put every instant in a bin of its own
  cfg.futureToleranceMinutes = Math.max(0, cfg.futureToleranceMinutes);
  cfg.maxPriorAtOrBelow = Math.max(0, cfg.maxPriorAtOrBelow);
  return cfg;
}

// --- small helpers ------------------------------------------------------------------------------------

/** round2 without negative zero, so results compare equal to plain literals. */
const r2 = (x: number): number => round2(x) + 0;

/**
 * Fixed-point text cut toward zero instead of rounded: "29.9" for 29.999, so the reason of a failed threshold check
 * can never read as if the threshold had been reached.
 */
const trunc = (x: number, digits: number): string => {
  const f = 10 ** digits;
  return (Math.trunc(x * f + Math.sign(x) * EPS) / f).toFixed(digits);
};

const isPrice = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Only ISO-8601 with an explicit zone: a zone-less string would be parsed in the host's local time. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since the epoch for a real calendar date "YYYY-MM-DD", else null ("2026-02-30" is not a date). */
function dayNumber(value: unknown): number | null {
  const m = typeof value === "string" ? ISO_DATE.exec(value) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}

/** Median of any list (sorts a copy). The caller guarantees at least one value. */
export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Scaled median absolute deviation around `center`: comparable to a standard deviation, immune to outliers. */
export function scaledMad(values: readonly number[], center: number = median(values)): number {
  return MAD_SCALE * median(values.map((v) => Math.abs(v - center)));
}

// --- bucket key ---------------------------------------------------------------------------------------

/** Upper edges (inclusive, in nights) of the trip-length bands: 0-3, 4-6, 7-10, 11-14, 15-21, 22+. */
const TRIP_BAND_EDGES = [3, 6, 10, 14, 21] as const;

function tripBand(nights: number): string {
  let lo = 0;
  for (const hi of TRIP_BAND_EDGES) {
    if (nights <= hi) return `${lo}-${hi}n`;
    lo = hi + 1;
  }
  return `${lo}+n`;
}

export interface BucketFields {
  origin: string;
  destination: string;
  depart_date: string;
  return_date: string;
  ticket_structure: string;
}

/**
 * Comparable-bucket key: origin | destination | ticket structure | departure month | trip-length band.
 *
 * Fares are only comparable inside a bucket. A July fare against a December one is a season, not a deal; a 3-night
 * break against a 3-week trip is a different product; a split ticket (two one-ways) is priced differently from a
 * round trip. Departure month and trip length are coarse on purpose: the bucket answers "which fare is the candidate"
 * (the cheapest of the newest run in the month and length), so the exact date pairs of a run may differ. It does NOT
 * answer "what is that fare compared with": the baseline is the history of the candidate's own date pair, because a
 * bucket-wide minimum is taken over a different set of date pairs every run (see detectDeals). The cost of hard edges
 * is that 31 July and 1 August (or a 6 and a 7 night trip) are never candidates of one bucket, which errs on the side
 * of fewer, not wrong, verdicts. Deliberately NOT in the key: the source (a second source would halve an already thin
 * history; a source that comes and goes makes a history of two price levels, which only widens the MAD while no level
 * holds more than half of it, and the rank rule of assessPrice covers the rest) and the lead time to departure (a
 * known limitation: a fare seen 300 days out and one seen 10 days out share a bucket).
 *
 * Returns null when the row cannot be placed (not an object, unparseable dates, or a return before the departure).
 */
export function bucketKey(row: BucketFields): string | null {
  if (row === null || typeof row !== "object") return null;
  const dep = dayNumber(row.depart_date);
  const ret = dayNumber(row.return_date);
  if (dep === null || ret === null || ret < dep) return null;
  if (typeof row.origin !== "string" || typeof row.destination !== "string" || typeof row.ticket_structure !== "string") return null;
  return [
    row.origin.trim().toUpperCase(),
    row.destination.trim().toUpperCase(),
    row.ticket_structure.trim().toLowerCase(),
    row.depart_date.slice(0, 7),
    tripBand(ret - dep),
  ].join("|");
}

// --- one candidate against one history ----------------------------------------------------------------

export interface PriceSnapshot {
  priceIls: number;
  /** Canonical ISO-8601 timestamp with a zone, as stored in prices.checked_at. */
  checkedAt: string;
}

export type DealVerdict = "insufficient_data" | "normal" | "deal" | "error_fare";

/**
 * With insufficient_data every statistic is null on purpose: a "62 % below the median of 5 fares" must never reach a
 * screen. dropPct is positive when the candidate is cheaper than the median and negative when it is dearer.
 * sampleSize and spanDays describe the observations the baseline was built from.
 */
export type DealAssessment =
  | {
      verdict: "insufficient_data";
      baselineIls: null;
      madIls: null;
      dropPct: null;
      robustZ: null;
      sampleSize: number;
      spanDays: number;
      reason: string;
    }
  | {
      verdict: "normal" | "deal" | "error_fare";
      /** Median of the baseline; in a trending history the median of the prices carried to the candidate's time along the trend. */
      baselineIls: number;
      /** Scaled MAD of the baseline (before the minRelSpread floor is applied to the z-score). */
      madIls: number;
      dropPct: number;
      /** (candidate - median) / scale; negative means cheaper than usual. */
      robustZ: number;
      sampleSize: number;
      spanDays: number;
      reason: string;
    };

interface Observation {
  ms: number;
  priceIls: number;
}

/**
 * Usable snapshots strictly older than `beforeMs`, one per time bin (the cheapest, the older one on a tie), oldest
 * first. A bin is a UTC window of `binMs`: everything a burst of searches stamped inside it is one look at the market.
 */
function observations(history: readonly PriceSnapshot[], beforeMs: number, binMs: number): Observation[] {
  const byBin = new Map<number, Observation>();
  for (const s of history) {
    const ms = parseTimestamp(s?.checkedAt);
    if (ms === null || ms >= beforeMs || !isPrice(s.priceIls)) continue;
    const bin = Math.floor(ms / binMs);
    const seen = byBin.get(bin);
    if (seen === undefined || s.priceIls < seen.priceIls || (s.priceIls === seen.priceIls && ms < seen.ms)) byBin.set(bin, { ms, priceIls: s.priceIls });
  }
  return [...byBin.values()].sort((a, b) => a.ms - b.ms);
}

const spanDaysOf = (obs: readonly Observation[]): number => {
  const first = obs[0];
  const last = obs[obs.length - 1];
  return first && last ? (last.ms - first.ms) / DAY_MS : 0;
};

/** What `obs` lacks to support a verdict: empty when it is enough. */
function shortfall(obs: readonly Observation[], cfg: DealConfig): string[] {
  const short: string[] = [];
  const minSamples = Math.max(1, cfg.minSamples);
  const spanDays = spanDaysOf(obs);
  const days = new Set(obs.map((o) => Math.floor(o.ms / DAY_MS))).size;
  if (obs.length < minSamples) short.push(`${obs.length} of ${minSamples} snapshots`);
  if (spanDays < cfg.minSpanDays) short.push(`${trunc(spanDays, 1)} of ${cfg.minSpanDays} days`);
  if (days < cfg.minDistinctDays) short.push(`${days} of ${cfg.minDistinctDays} distinct days`);
  return short;
}

/** Median of the slopes of every pair of points, in ILS per day: a line fit that a few odd fares cannot pull off course. */
function theilSenSlope(points: readonly Observation[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i] as Observation;
      const b = points[j] as Observation;
      slopes.push(((b.priceIls - a.priceIls) / (b.ms - a.ms)) * DAY_MS); // the points sit in different bins: b.ms > a.ms
    }
  }
  return median(slopes);
}

interface Baseline {
  /** The observations the baseline stands on. */
  used: Observation[];
  /** Their prices: as observed, or carried to the candidate's time along the trend. */
  prices: number[];
  /** ILS per day, only when the trend was used. */
  trendPerDay: number | null;
}

/**
 * The baseline of a candidate at `candidateMs`. Normally every earlier observation, as it was. When the recent ones
 * (a window, on its own enough evidence) show a clear trend, the trend is not noise: the climb before a departure
 * would inflate the MAD and the median would lag the current level, so a real deal in a rising bucket goes unseen. The
 * prices are then carried to the candidate's time along the Theil-Sen line, and the same median, MAD and rank rules
 * apply to those. A history too thin for the window, a trend below minTrendPct or one that does not stand out of the
 * noise keeps the plain baseline: the window never turns a verdict into insufficient_data.
 */
function baselineFor(obs: readonly Observation[], candidateMs: number, cfg: DealConfig): Baseline {
  const plain: Baseline = { used: [...obs], prices: obs.map((o) => o.priceIls), trendPerDay: null };
  const recent = obs.filter((o) => o.ms >= candidateMs - cfg.trendWindowDays * DAY_MS).slice(-TREND_MAX_POINTS);
  if (recent.length < TREND_MIN_POINTS || shortfall(recent, cfg).length > 0) return plain;
  const slope = theilSenSlope(recent);
  const drift = Math.abs(slope) * spanDaysOf(recent); // ILS the line moves over the window
  if (!(drift >= (cfg.minTrendPct / 100) * median(recent.map((o) => o.priceIls)))) return plain;
  const prices = recent.map((o) => o.priceIls - slope * ((o.ms - candidateMs) / DAY_MS));
  if (!isPrice(median(prices)) || !(drift >= TREND_MIN_SNR * scaledMad(prices))) return plain;
  return { used: recent, prices, trendPerDay: slope };
}

function insufficient(sampleSize: number, spanDays: number, reason: string): DealAssessment {
  return { verdict: "insufficient_data", baselineIls: null, madIls: null, dropPct: null, robustZ: null, sampleSize, spanDays: r2(spanDays), reason };
}

/**
 * Judge `candidate` against the price history of ONE series (in detectDeals: one date pair). `history` may contain
 * the candidate itself (a row that was already stored) and rows from after it: only snapshots strictly older than the
 * candidate form the baseline, so a fare is never compared with itself. Snapshots with a non-positive price or an
 * unusable timestamp are ignored, and so is a candidate like that (bad data is never an error fare).
 *
 * A candidate is a deal only if the drop, the robust z-score AND the rank rule all agree. The rank rule: at most
 * maxPriorAtOrBelow earlier observations may have been as cheap (within minRelSpread). Without it a history with a
 * majority price level plus a minority lower level scores the lower level as a huge z (the median and the tiny MAD sit
 * on the majority), so a price seen 5 times in 12 would be reported as a mistake fare. A genuinely new low, or one
 * seen once before, still passes. The check runs on the same prices as the z-score, so a trend is taken out of both.
 */
export function assessPrice(history: readonly PriceSnapshot[], candidate: PriceSnapshot, config: Partial<DealConfig> = {}): DealAssessment {
  const cfg = resolveConfig(config);
  const candidateMs = candidate == null ? null : parseTimestamp(candidate.checkedAt);
  if (candidateMs === null || !isPrice(candidate.priceIls)) return insufficient(0, 0, "the candidate has no usable price or check time");

  const obs = observations(history, candidateMs, cfg.binHours * HOUR_MS);
  const short = shortfall(obs, cfg);
  if (short.length > 0) return insufficient(obs.length, spanDaysOf(obs), `not enough history: ${short.join(", ")}`);

  const { used, prices, trendPerDay } = baselineFor(obs, candidateMs, cfg);
  const sampleSize = used.length;
  const spanDays = spanDaysOf(used);
  const med = median(prices);
  const mad = scaledMad(prices, med);
  const scale = Math.max(mad, cfg.minRelSpread * med);
  const price = candidate.priceIls;
  const dropPct = ((med - price) / med) * 100;
  const z = (price - med) / scale;
  const seenAtOrBelow = prices.filter((p) => p <= price * (1 + cfg.minRelSpread)).length;

  const zLow = z <= -cfg.minRobustZ + EPS;
  const unusual = zLow && seenAtOrBelow <= cfg.maxPriorAtOrBelow;
  const level = trendPerDay === null ? "median" : "trend-adjusted median";
  const evidence = `${sampleSize} snapshots over ${spanDays.toFixed(1)} days${trendPerDay === null ? "" : `, trend ${trendPerDay > 0 ? "+" : ""}${trendPerDay.toFixed(0)} ILS/day`}`;
  let verdict: "normal" | "deal" | "error_fare" = "normal";
  let reason: string;
  if (unusual && dropPct + EPS >= cfg.errorDropPct) {
    verdict = "error_fare";
    reason = `${dropPct.toFixed(1)}% below the ${level} ${med.toFixed(0)} ILS (robust z ${z.toFixed(2)}, ${evidence}): likely a mistake fare`;
  } else if (unusual && dropPct + EPS >= cfg.dealDropPct) {
    verdict = "deal";
    reason = `${dropPct.toFixed(1)}% below the ${level} ${med.toFixed(0)} ILS (robust z ${z.toFixed(2)}, ${evidence})`;
  } else if (dropPct + EPS < cfg.dealDropPct) {
    reason = dropPct > 0
      ? `${trunc(dropPct, 1)}% below the ${level} ${med.toFixed(0)} ILS, under the ${cfg.dealDropPct}% needed for a deal`
      : `not below the ${level} ${med.toFixed(0)} ILS`;
  } else if (!zLow) {
    reason = `${dropPct.toFixed(1)}% below the ${level} ${med.toFixed(0)} ILS, but robust z ${trunc(z, 2)} is above -${cfg.minRobustZ}: this bucket's usual spread (MAD ${mad.toFixed(0)} ILS) is too wide to call it unusual`;
  } else {
    reason = `${dropPct.toFixed(1)}% below the ${level} ${med.toFixed(0)} ILS, but this price already occurred in ${seenAtOrBelow} of ${sampleSize} earlier snapshots`;
  }

  return { verdict, baselineIls: r2(med), madIls: r2(mad), dropPct: r2(dropPct), robustZ: r2(z), sampleSize, spanDays: r2(spanDays), reason };
}

// --- a whole prices table -----------------------------------------------------------------------------

/** The columns of the prices table this module reads (SELECT exactly these). */
export interface DealPriceRow {
  origin: string;
  destination: string;
  depart_date: string;
  return_date: string;
  price_amount: number;
  price_currency: string;
  source: string;
  ticket_structure: string;
  airlines_json: string;
  checked_at: string;
}

/** Rates to ILS per currency, the shape of FxRates.ratesToIls: 1 unit of the currency = N ILS. */
export type RatesToIls = Readonly<Record<string, number>>;

export interface Deal {
  verdict: "deal" | "error_fare";
  origin: string;
  destination: string;
  departDate: string;
  returnDate: string;
  ticketStructure: string;
  source: string;
  airlines: string[];
  /** The fare as stored, in its original currency. */
  priceAmount: number;
  priceCurrency: string;
  priceIls: number;
  dropPct: number;
  checkedAt: string;
  bucket: string;
  evidence: { baselineIls: number; madIls: number; robustZ: number; sampleSize: number; spanDays: number };
  reason: string;
}

export interface DealStats {
  rows: number;
  /** Buckets with at least one usable row. */
  buckets: number;
  /** Buckets whose newest snapshot is older than liveWithinHours: not judged, never reported. */
  staleBuckets: number;
  insufficientBuckets: number;
  /** Rows in a currency without a usable rate (skipped, never guessed) and which currencies those were. */
  skippedNoRate: number;
  missingCurrencies: string[];
  /** Rows with an unusable price, date, structure or timestamp, and anything that is not a row at all. */
  skippedInvalid: number;
  /** Rows stamped more than futureToleranceMinutes after `now`: the report is "as of now", so they are ignored. */
  skippedFuture: number;
}

export interface DealReport {
  /** Sorted by dropPct, biggest first (ties: cheaper first, then by bucket, which is unique per deal, so the order is total). */
  deals: Deal[];
  stats: DealStats;
}

interface Snap {
  row: DealPriceRow;
  bucket: string;
  ms: number;
  priceIls: number;
}

/** ILS is 1 by definition (not a guess); every other currency needs a finite positive rate of its own. */
function rateFor(rates: RatesToIls, currency: string): number | null {
  const code = currency.trim().toUpperCase();
  if (code === "ILS") return 1;
  if (!Object.hasOwn(rates, code)) return null;
  const rate = rates[code];
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : null;
}

function parseAirlines(json: unknown): string[] {
  if (typeof json !== "string") return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);

/** Total order used to pick the candidate among the rows of one instant, whatever the input order. */
function cheapestFirst(a: Snap, b: Snap): number {
  return (
    cmp(a.priceIls, b.priceIls) ||
    cmp(a.row.depart_date, b.row.depart_date) ||
    cmp(a.row.return_date, b.row.return_date) ||
    cmp(a.row.source, b.row.source) ||
    cmp(a.row.airlines_json, b.row.airlines_json) ||
    cmp(a.row.price_currency, b.row.price_currency) ||
    cmp(a.row.price_amount, b.row.price_amount)
  );
}

/**
 * Find the live deals in a set of price rows. Rows are converted to ILS with ONE rate table (rows in a currency
 * without a rate are skipped and counted; using a single table means an FX move cannot fake a drop between two
 * snapshots of the same fare), grouped with bucketKey, and in each bucket the newest check instant is where the
 * candidate comes from: its cheapest row. That row is judged against the strictly older snapshots of the SAME date
 * pair only. Every search stores the cheapest date pairs of its own window, so the cheapest fare of a bucket is a
 * minimum over a different set of dates each time; comparing it with the older minima would flag an ordinary fare for a
 * cheap date that an earlier, narrower search never covered. A date pair with too little history of its own is
 * insufficient_data, never a guess from the pooled month. A bucket whose newest snapshot is older than liveWithinHours
 * is not judged: yesterday's fare is not a live deal.
 *
 * The source is not part of the series: a fare is the cheapest offer at that time, and assessPrice's rank rule
 * stops a source that comes and goes from making its own level look like a deal.
 *
 * `now` is "as of": take it AFTER the scan that stored the rows (not from a scheduled-event time, which is earlier than
 * the rows of the run it triggers); a row up to futureToleranceMinutes ahead of it still counts as now. The function is
 * stateless: a fare that stays cheap can be reported again on the next call (the rank rule ends that after a couple of
 * observations), so the caller decides what to alert on and when to stay quiet (a cool-down, or the last alerted price
 * per bucket).
 */
export function detectDeals(rows: readonly DealPriceRow[], ratesToIls: RatesToIls, now: Date, config: Partial<DealConfig> = {}): DealReport {
  const { deals, stats } = assessBuckets(rows, ratesToIls, now, config);
  return { deals, stats };
}

/** One live (not stale) bucket as detectDeals judged it: its candidate date pair and how much evidence that pair has. */
export interface BucketSummary {
  bucket: string;
  departDate: string;
  returnDate: string;
  /** checked_at of the candidate row (the newest instant of the bucket). */
  checkedAt: string;
  verdict: DealVerdict;
  sampleSize: number;
  spanDays: number;
}

/**
 * detectDeals plus one summary per live bucket (sorted by bucket). ADDITIVE: detectDeals is exactly this without
 * `buckets`, so both always agree. The candidate of a bucket depends only on the rows of its newest instant, which is
 * what lets a caller find the candidate date pairs from recent rows alone and then load the history of just those pairs.
 */
export function assessBuckets(rows: readonly DealPriceRow[], ratesToIls: RatesToIls, now: Date, config: Partial<DealConfig> = {}): DealReport & { buckets: BucketSummary[] } {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("detectDeals: now must be a valid Date");
  const cfg = resolveConfig(config);

  const stats: DealStats = { rows: rows.length, buckets: 0, staleBuckets: 0, insufficientBuckets: 0, skippedNoRate: 0, missingCurrencies: [], skippedInvalid: 0, skippedFuture: 0 };
  const missing = new Set<string>();
  const buckets = new Map<string, Snap[]>();

  for (const row of rows) {
    const bucket = bucketKey(row);
    const ms = bucket === null ? null : parseTimestamp(row.checked_at);
    if (bucket === null || ms === null || !isPrice(row.price_amount) || typeof row.price_currency !== "string") {
      stats.skippedInvalid++;
      continue;
    }
    if (ms > nowMs + cfg.futureToleranceMinutes * MINUTE_MS) {
      stats.skippedFuture++;
      continue;
    }
    const rate = rateFor(ratesToIls, row.price_currency);
    if (rate === null) {
      stats.skippedNoRate++;
      missing.add(row.price_currency.trim().toUpperCase());
      continue;
    }
    const priceIls = row.price_amount * rate;
    if (!isPrice(priceIls)) {
      stats.skippedInvalid++; // an overflowing amount x rate
      continue;
    }
    const list = buckets.get(bucket);
    if (list) list.push({ row, bucket, ms, priceIls });
    else buckets.set(bucket, [{ row, bucket, ms, priceIls }]);
  }
  stats.missingCurrencies = [...missing].sort();
  stats.buckets = buckets.size;

  const deals: Deal[] = [];
  const summaries: BucketSummary[] = [];
  for (const [bucket, snaps] of buckets) {
    const newest = snaps.reduce((m, s) => (s.ms > m ? s.ms : m), -Infinity);
    if (nowMs - newest > cfg.liveWithinHours * HOUR_MS) {
      stats.staleBuckets++;
      continue;
    }
    const candidate = snaps.filter((s) => s.ms === newest).sort(cheapestFirst)[0] as Snap;
    const own = snaps.filter((s) => s.row.depart_date === candidate.row.depart_date && s.row.return_date === candidate.row.return_date);
    const a = assessPrice(
      own.map((s) => ({ priceIls: s.priceIls, checkedAt: s.row.checked_at })),
      { priceIls: candidate.priceIls, checkedAt: candidate.row.checked_at },
      cfg,
    );
    summaries.push({
      bucket,
      departDate: candidate.row.depart_date,
      returnDate: candidate.row.return_date,
      checkedAt: candidate.row.checked_at,
      verdict: a.verdict,
      sampleSize: a.sampleSize,
      spanDays: a.spanDays,
    });
    if (a.verdict === "insufficient_data") {
      stats.insufficientBuckets++;
      continue;
    }
    if (a.verdict === "normal") continue;
    const r = candidate.row;
    deals.push({
      verdict: a.verdict,
      origin: r.origin.trim().toUpperCase(),
      destination: r.destination.trim().toUpperCase(),
      departDate: r.depart_date,
      returnDate: r.return_date,
      ticketStructure: r.ticket_structure.trim().toLowerCase(),
      source: r.source,
      airlines: parseAirlines(r.airlines_json),
      priceAmount: r.price_amount,
      priceCurrency: r.price_currency,
      priceIls: r2(candidate.priceIls),
      dropPct: a.dropPct,
      checkedAt: r.checked_at,
      bucket,
      evidence: { baselineIls: a.baselineIls, madIls: a.madIls, robustZ: a.robustZ, sampleSize: a.sampleSize, spanDays: a.spanDays },
      reason: a.reason,
    });
  }

  // one deal per bucket, so the bucket already makes the order total
  deals.sort((a, b) => cmp(b.dropPct, a.dropPct) || cmp(a.priceIls, b.priceIls) || cmp(a.bucket, b.bucket));
  summaries.sort((a, b) => cmp(a.bucket, b.bucket));
  return { deals, stats, buckets: summaries };
}
