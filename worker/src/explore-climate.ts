/**
 * Bundled climate normals for the explore ranking (GET /api/explore). Static, free, no live weather API.
 *
 * SOURCE AND ACCURACY: monthly mean daily maximum temperature (°C) and mean number of days with >= 1 mm of rain,
 * ROUNDED approximations of the "Climate data" tables in each city's English Wikipedia article (which cite the
 * national weather services, WMO 1991-2020 normals where available). Every value is an APPROXIMATION: rounded to
 * whole numbers, some stations are the city's airport rather than its centre, rain-day thresholds differ by country.
 * VERIFICATION: only Larnaca and Budapest were checked against the live Wikipedia tables (2026-09-29; Budapest was
 * then corrected, it had been 1-3 °C too cool). The other rows were NOT checked one by one and may lean toward
 * older, cooler normals by a degree or more. Good enough to tell "beach weather" from "cold and rainy", not finer.
 * The API marks every figure it shows as approximate.
 *
 * `category` is a coarse, hand-assigned label of what a short trip there is usually about.
 */

export type DestinationCategory = "beach" | "city" | "ski" | "nature";

export interface ClimateRow {
  category: DestinationCategory;
  /** Mean daily max temperature, °C, January..December. */
  tmax: readonly number[];
  /** Mean days with rain, January..December. */
  rain: readonly number[];
}

export const CLIMATE_SOURCE =
  "Wikipedia city climate tables (national weather services / WMO 1991-2020 normals where available), rounded; approximate";

const row = (category: DestinationCategory, tmax: number[], rain: number[]): ClimateRow => ({ category, tmax, rain });

/** Keyed by city IATA code (the codes Travelpayouts returns as destinations). */
export const CLIMATE: Readonly<Record<string, ClimateRow>> = {
  // Greece and Cyprus
  ATH: row("city", [14, 14, 17, 20, 25, 30, 33, 33, 29, 23, 19, 15], [8, 7, 7, 5, 3, 1, 1, 1, 2, 5, 7, 8]),
  SKG: row("city", [10, 11, 14, 19, 24, 29, 32, 32, 27, 21, 15, 11], [6, 6, 7, 7, 7, 4, 3, 2, 4, 5, 7, 7]),
  RHO: row("beach", [15, 16, 17, 20, 24, 28, 31, 31, 28, 24, 20, 17], [10, 8, 6, 4, 2, 0, 0, 0, 1, 4, 7, 10]),
  HER: row("beach", [16, 16, 18, 21, 24, 28, 29, 29, 27, 24, 21, 18], [10, 8, 7, 4, 2, 0, 0, 0, 1, 4, 6, 9]),
  CHQ: row("beach", [15, 16, 18, 21, 25, 29, 31, 31, 28, 24, 20, 17], [12, 10, 8, 5, 2, 1, 0, 0, 2, 5, 8, 12]),
  KGS: row("beach", [15, 15, 17, 20, 24, 29, 31, 31, 28, 24, 20, 17], [10, 8, 6, 4, 2, 0, 0, 0, 1, 4, 7, 10]),
  CFU: row("beach", [14, 15, 16, 19, 24, 28, 31, 31, 28, 23, 19, 15], [12, 11, 9, 8, 5, 2, 1, 2, 5, 9, 12, 13]),
  JTR: row("beach", [14, 14, 16, 19, 23, 27, 29, 29, 26, 23, 19, 16], [9, 8, 6, 3, 1, 0, 0, 0, 1, 3, 6, 9]),
  JMK: row("beach", [14, 14, 16, 18, 22, 26, 27, 27, 25, 22, 18, 15], [9, 8, 6, 3, 1, 0, 0, 0, 1, 3, 6, 9]),
  LCA: row("beach", [17, 18, 20, 23, 27, 31, 33, 33, 31, 28, 23, 19], [8, 7, 5, 3, 1, 0, 0, 0, 0, 2, 4, 7]),
  PFO: row("beach", [17, 17, 19, 22, 25, 28, 31, 31, 30, 27, 23, 19], [9, 8, 6, 3, 1, 0, 0, 0, 0, 3, 5, 8]),
  // Turkey, Georgia, Caucasus
  IST: row("city", [9, 9, 12, 16, 21, 26, 28, 29, 25, 20, 15, 11], [12, 10, 9, 6, 5, 3, 2, 2, 4, 7, 9, 12]),
  AYT: row("beach", [15, 16, 18, 21, 26, 31, 34, 34, 31, 27, 21, 17], [11, 9, 7, 5, 3, 1, 0, 0, 1, 4, 6, 10]),
  BJV: row("beach", [15, 16, 18, 21, 25, 30, 33, 33, 30, 26, 21, 17], [11, 9, 7, 5, 2, 0, 0, 0, 1, 4, 7, 11]),
  DLM: row("beach", [15, 16, 19, 22, 27, 32, 35, 35, 31, 26, 21, 16], [11, 10, 8, 6, 3, 1, 0, 0, 1, 4, 7, 11]),
  TBS: row("city", [7, 9, 14, 19, 24, 29, 32, 32, 27, 20, 13, 8], [4, 5, 6, 8, 10, 8, 5, 5, 5, 5, 5, 4]),
  BUS: row("beach", [11, 11, 13, 16, 20, 24, 27, 27, 24, 21, 17, 13], [14, 13, 13, 11, 10, 11, 11, 12, 13, 12, 12, 14]),
  EVN: row("city", [1, 4, 12, 19, 24, 30, 34, 33, 29, 21, 12, 4], [4, 5, 6, 8, 9, 5, 3, 2, 2, 4, 4, 4]),
  GYD: row("city", [7, 7, 10, 16, 22, 27, 30, 30, 25, 19, 14, 10], [6, 6, 6, 4, 3, 1, 1, 1, 2, 4, 6, 6]),
  // Central and Eastern Europe
  BUD: row("city", [5, 7, 12, 19, 23, 27, 29, 29, 23, 17, 11, 5], [6, 6, 6, 6, 8, 7, 6, 6, 6, 7, 7, 7]),
  PRG: row("city", [1, 3, 8, 14, 19, 22, 24, 24, 19, 13, 6, 2], [7, 6, 7, 6, 8, 9, 9, 8, 6, 6, 7, 7]),
  VIE: row("city", [3, 5, 10, 16, 21, 24, 27, 26, 21, 15, 8, 4], [7, 6, 8, 7, 8, 9, 9, 8, 7, 6, 7, 7]),
  BER: row("city", [3, 5, 9, 15, 19, 22, 25, 24, 20, 14, 8, 4], [10, 8, 8, 7, 8, 8, 8, 8, 7, 7, 9, 10]),
  MUC: row("city", [3, 5, 10, 14, 19, 22, 24, 24, 19, 14, 8, 4], [9, 8, 9, 10, 12, 13, 12, 11, 9, 8, 9, 10]),
  FRA: row("city", [4, 6, 11, 15, 20, 23, 25, 25, 20, 15, 9, 5], [9, 8, 9, 8, 9, 9, 9, 8, 8, 9, 9, 10]),
  WAW: row("city", [0, 2, 7, 14, 20, 23, 25, 24, 19, 13, 6, 1], [8, 7, 8, 7, 8, 8, 8, 7, 7, 7, 8, 9]),
  KRK: row("city", [1, 3, 8, 14, 19, 22, 24, 24, 19, 13, 7, 2], [7, 7, 8, 8, 10, 10, 10, 9, 8, 7, 8, 8]),
  BUH: row("city", [2, 5, 11, 18, 23, 27, 29, 29, 24, 17, 10, 4], [6, 6, 6, 7, 8, 8, 7, 5, 5, 5, 6, 7]),
  SOF: row("city", [3, 5, 11, 16, 21, 24, 27, 27, 22, 17, 10, 4], [7, 7, 8, 9, 10, 9, 7, 5, 5, 6, 7, 8]),
  BEG: row("city", [5, 7, 13, 18, 24, 27, 29, 30, 25, 19, 12, 6], [7, 7, 7, 8, 9, 9, 6, 5, 6, 5, 7, 8]),
  BOJ: row("beach", [6, 7, 11, 16, 21, 26, 29, 29, 25, 19, 13, 8], [6, 5, 6, 6, 7, 6, 4, 3, 3, 5, 6, 7]),
  VAR: row("beach", [6, 7, 11, 16, 21, 26, 29, 29, 25, 19, 13, 8], [6, 5, 6, 6, 6, 6, 4, 3, 3, 5, 6, 7]),
  TIV: row("beach", [12, 13, 15, 18, 23, 27, 30, 30, 26, 21, 17, 13], [12, 11, 11, 10, 8, 5, 3, 4, 7, 10, 13, 13]),
  SPU: row("beach", [11, 12, 15, 18, 23, 27, 30, 30, 26, 21, 16, 12], [11, 10, 10, 10, 9, 6, 4, 4, 7, 9, 12, 12]),
  DBV: row("beach", [12, 13, 15, 18, 22, 26, 29, 29, 26, 22, 17, 14], [11, 10, 10, 11, 9, 6, 4, 5, 7, 10, 13, 12]),
  LJU: row("nature", [3, 6, 11, 16, 21, 24, 27, 26, 21, 15, 9, 4], [11, 10, 12, 14, 15, 15, 12, 12, 12, 13, 14, 13]),
  // Alps
  ZRH: row("city", [3, 6, 10, 14, 19, 22, 24, 24, 19, 14, 8, 4], [10, 9, 11, 10, 12, 12, 11, 11, 9, 9, 10, 10]),
  GVA: row("city", [5, 6, 11, 15, 19, 23, 26, 25, 21, 15, 9, 5], [10, 9, 10, 9, 11, 9, 8, 9, 8, 10, 10, 10]),
  SZG: row("city", [3, 5, 10, 14, 19, 22, 24, 24, 19, 15, 8, 4], [11, 10, 12, 13, 15, 16, 16, 15, 12, 10, 11, 12]),
  INN: row("ski", [3, 6, 11, 16, 20, 23, 25, 24, 21, 16, 8, 3], [8, 7, 8, 9, 12, 15, 15, 13, 10, 8, 8, 9]),
  TRN: row("city", [7, 9, 13, 16, 21, 25, 28, 27, 23, 17, 11, 7], [5, 4, 6, 9, 10, 8, 5, 6, 5, 7, 7, 5]),
  // Italy, Malta
  ROM: row("city", [12, 14, 16, 19, 24, 28, 31, 31, 27, 22, 17, 13], [7, 7, 7, 7, 5, 3, 2, 2, 5, 7, 9, 8]),
  MIL: row("city", [6, 9, 14, 17, 22, 26, 29, 28, 24, 18, 11, 6], [6, 5, 6, 8, 8, 7, 5, 6, 5, 7, 7, 6]),
  VCE: row("city", [7, 9, 13, 17, 22, 26, 28, 28, 24, 18, 12, 8], [6, 5, 6, 8, 8, 8, 5, 5, 6, 6, 6, 6]),
  FLR: row("city", [11, 13, 16, 20, 24, 29, 32, 32, 27, 21, 15, 11], [7, 7, 7, 8, 7, 4, 2, 4, 5, 7, 9, 8]),
  NAP: row("city", [13, 14, 16, 19, 23, 27, 30, 30, 27, 22, 18, 14], [9, 9, 8, 8, 5, 3, 2, 3, 5, 8, 10, 10]),
  CTA: row("beach", [15, 16, 18, 20, 24, 29, 32, 32, 29, 24, 20, 16], [7, 6, 5, 4, 2, 1, 0, 1, 3, 5, 6, 7]),
  MLA: row("beach", [16, 16, 18, 20, 24, 28, 31, 32, 28, 25, 21, 17], [9, 8, 5, 3, 1, 0, 0, 1, 3, 6, 8, 10]),
  // Western Europe
  PAR: row("city", [7, 9, 13, 16, 20, 23, 26, 25, 21, 16, 11, 8], [10, 9, 10, 9, 9, 8, 7, 7, 7, 9, 10, 11]),
  NCE: row("beach", [13, 14, 15, 17, 21, 24, 27, 27, 24, 21, 16, 14], [6, 5, 6, 7, 6, 4, 2, 3, 5, 7, 7, 7]),
  LON: row("city", [8, 9, 12, 15, 18, 21, 24, 23, 20, 16, 11, 9], [11, 9, 9, 9, 8, 8, 8, 8, 8, 10, 10, 10]),
  DUB: row("city", [8, 9, 11, 13, 16, 18, 20, 19, 17, 14, 10, 8], [13, 11, 11, 10, 10, 9, 10, 10, 10, 12, 12, 13]),
  AMS: row("city", [6, 7, 10, 14, 17, 20, 22, 22, 19, 15, 10, 7], [12, 10, 11, 9, 9, 9, 10, 10, 11, 12, 13, 12]),
  BRU: row("city", [6, 7, 11, 15, 19, 21, 23, 23, 20, 15, 10, 6], [12, 10, 11, 10, 10, 10, 10, 10, 10, 11, 12, 12]),
  CPH: row("city", [3, 3, 6, 11, 16, 19, 21, 21, 17, 12, 8, 5], [10, 8, 8, 7, 7, 8, 8, 9, 9, 10, 11, 11]),
  // Iberia, Canaries
  BCN: row("city", [14, 15, 17, 19, 22, 26, 28, 29, 26, 22, 17, 15], [5, 4, 5, 6, 6, 4, 2, 4, 5, 6, 5, 5]),
  MAD: row("city", [10, 12, 16, 18, 22, 28, 32, 31, 26, 19, 13, 10], [6, 5, 4, 6, 5, 2, 1, 1, 3, 6, 6, 6]),
  PMI: row("beach", [15, 15, 17, 19, 23, 27, 30, 31, 27, 23, 19, 16], [6, 5, 5, 5, 4, 2, 1, 2, 5, 6, 6, 7]),
  AGP: row("beach", [17, 18, 20, 22, 25, 29, 31, 31, 28, 24, 20, 18], [6, 5, 5, 5, 3, 1, 0, 1, 2, 5, 6, 7]),
  LIS: row("city", [15, 16, 19, 20, 23, 27, 28, 29, 27, 23, 18, 16], [10, 8, 7, 8, 5, 2, 1, 1, 3, 8, 9, 10]),
  OPO: row("city", [14, 15, 17, 18, 20, 23, 25, 25, 24, 21, 17, 14], [13, 11, 10, 11, 9, 4, 2, 3, 6, 11, 12, 13]),
  LPA: row("beach", [21, 21, 22, 22, 23, 24, 25, 26, 26, 25, 23, 22], [3, 3, 2, 1, 0, 0, 0, 0, 1, 2, 3, 4]),
  // Red Sea, Gulf
  SSH: row("beach", [22, 23, 26, 30, 34, 37, 38, 38, 35, 32, 28, 24], [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
  AQJ: row("beach", [21, 23, 26, 30, 35, 38, 39, 39, 37, 33, 27, 22], [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
  DXB: row("beach", [24, 25, 29, 33, 38, 40, 41, 41, 39, 35, 30, 26], [2, 2, 2, 1, 0, 0, 0, 0, 0, 0, 1, 2]),
  AUH: row("city", [24, 26, 29, 33, 38, 40, 41, 42, 39, 35, 30, 26], [2, 2, 2, 1, 0, 0, 0, 0, 0, 0, 1, 2]),
  // Long haul
  BKK: row("city", [32, 33, 34, 35, 34, 33, 33, 33, 33, 32, 32, 32], [2, 2, 3, 6, 15, 16, 17, 19, 21, 16, 6, 1]),
  HKT: row("beach", [32, 33, 33, 33, 32, 31, 31, 31, 30, 31, 31, 31], [4, 3, 5, 11, 20, 20, 20, 21, 23, 21, 15, 7]),
  GOI: row("beach", [32, 32, 33, 33, 33, 31, 29, 29, 30, 32, 33, 33], [0, 0, 0, 0, 2, 20, 27, 24, 13, 6, 2, 0]),
  MLE: row("beach", [30, 31, 31, 32, 31, 31, 30, 30, 30, 30, 30, 30], [6, 3, 5, 9, 15, 13, 13, 13, 15, 15, 13, 12]),
  ZNZ: row("beach", [32, 32, 32, 30, 29, 29, 28, 28, 29, 30, 31, 32], [8, 7, 13, 19, 15, 6, 6, 6, 6, 8, 13, 12]),
  TYO: row("city", [10, 11, 14, 19, 23, 26, 30, 31, 27, 22, 17, 12], [5, 6, 10, 10, 11, 12, 11, 8, 11, 10, 7, 5]),
  NYC: row("city", [4, 6, 10, 17, 22, 27, 29, 29, 25, 18, 12, 6], [11, 9, 11, 11, 11, 10, 10, 9, 9, 9, 9, 11]),
};

/** Comfortable daytime-high band per category, °C. */
const IDEAL: Readonly<Record<DestinationCategory, { lo: number; hi: number; perDegree: number; perRainDay: number }>> = {
  beach: { lo: 26, hi: 32, perDegree: 10, perRainDay: 4 },
  city: { lo: 16, hi: 26, perDegree: 6, perRainDay: 3 },
  nature: { lo: 15, hi: 25, perDegree: 6, perRainDay: 3 },
  // Snow, not sun: the colder months score, and precipitation is not held against a ski trip.
  ski: { lo: -8, hi: 6, perDegree: 8, perRainDay: 0 },
};

export interface WeatherFit {
  /** 0-100: 100 = the daytime high is inside the category's comfortable band and it rarely rains. */
  score: number;
  category: DestinationCategory;
  tmaxC: number;
  rainDays: number;
  /** Always true: see the file header. */
  approximate: true;
}

/**
 * Weather fit for a city in a month (1-12), or null when the city is not in the table (never guessed).
 * score = 100 - perDegree x (degrees outside the band) - perRainDay x (rain days), clamped to 0..100.
 */
export function weatherFit(cityCode: string, month: number): WeatherFit | null {
  const c = CLIMATE[cityCode.toUpperCase()];
  if (!c || !Number.isInteger(month) || month < 1 || month > 12) return null;
  const tmax = c.tmax[month - 1] as number;
  const rain = c.rain[month - 1] as number;
  const band = IDEAL[c.category];
  const off = tmax < band.lo ? band.lo - tmax : tmax > band.hi ? tmax - band.hi : 0;
  const score = Math.max(0, Math.min(100, Math.round(100 - band.perDegree * off - band.perRainDay * rain)));
  return { score, category: c.category, tmaxC: tmax, rainDays: rain, approximate: true };
}
