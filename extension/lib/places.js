/**
 * Places in a query: cities, airports and countries, in Hebrew or English, with Hebrew prefixes ("לאתונה" = to
 * Athens, "מאילת" = from Eilat), niqqud and geresh variants, and airport codes typed in capitals ("TLV", "ATH",
 * "לBCN").
 *
 * The data is the bundled index (data/index.json, made by scripts/gen-index.mjs from the Worker's own datasets), passed
 * in by the caller, so this file stays pure and testable. Index shape:
 *   c: city code -> [Hebrew name or "", English name, country code]
 *   a: airport code -> city code (only airports whose code differs from their city's)
 *   k: country code -> [Hebrew name, top airport, city of that airport] (the top airport is ordered like
 *      worker/src/countries/search.ts: seen with a direct flight from TLV first, then by city popularity)
 *   n: normalized name -> "ATH" (city) | "#LHR" (airport) | "@GR" (country)
 */
(() => {
  "use strict";
  const EEE = /** @type {any} */ ((/** @type {any} */ (globalThis))[Symbol.for("eee.extension")] ??= {});
  if (EEE.places) return;

  /** Longest place name in words ("איחוד האמירויות הערביות", "ho chi minh city"). */
  const MAX_WORDS = 5;
  const HOME = "IL";

  /**
   * Place names that are also everyday words or people's names. They count only right after "to"/"from"/"ל"/"מ"/"ב"
   * ("flights to nice" yes, "nice flights" no; "טיסה למלגה" yes, "מלגה לטיסה" no; "flight denzel washington" no).
   */
  const WEAK_NAMES = new Set(
    [
      "nice", "split", "male", "tours", "mobile", "sale", "page", "reading", "bath", "cork", "hope", "la", "us", "mar",
      "deal", "best", "cheap", "hue", "amazon", "cali", "midway", "hobby", "chopin",
      "jordan", "washington", "victoria", "charlotte", "austin", "madison", "hamilton",
      // Hebrew words and first names that are also place names in the dataset
      "מלגה", "בר", "אן", "לה", "בוש", "גדה", "קטר", "ליל", "פרג", "פרת", "פרו", "אורלי", "בובה", "דובי", "הובי",
      "חניה", "טורף", "ירדן", "פונה", "צילה", "קובה", "קונה", "בארי", "גנבה", "אספן",
      "בקו", "קניה", "עובדה", "קרבי", "סבו", "מרידה", "לבנון", "ארובה", "דוחה", "ליאון", "ליון", "מרסי", "פאס",
      "קולו", "קוס", "קורק", "שרגה", "גגו", "סופיה",
    ].map((w) => /** @type {any} */ (EEE.text).normalizeName(w)),
  );

  /**
   * Upper-case words that are not meant as airport codes even though some airport has that code.
   */
  const CODE_STOP = new Set([
    "THE", "AND", "FOR", "ALL", "NEW", "BIG", "TOP", "LOW", "OFF", "OUT", "WAY", "DAY", "ONE", "TWO", "BUY", "GET", "HOW",
    "WHY", "YOU", "NOW", "BAG", "CAR", "BUS", "SEA", "SUN", "SKI", "USD", "EUR", "ILS", "NIS", "GBP", "VIP", "CEO", "FAQ",
    "PDF", "USB", "ATM", "DIY", "LOL", "OMG", "TBD", "SUV", "GPS", "API", "BBC", "CNN", "ETA", "AIR", "FLY", "JET",
  ]);

  /**
   * Everyday three-letter English words. In a query typed all in capitals ("CAN I GET CHEAP FLIGHTS", "CHEAP FLIGHTS
   * FOR HER") they are words, not the airport codes CAN / HER; in a normal query a capitalized "MAD" is Madrid.
   */
  const SHOUTED_WORDS = new Set([
    "ARE", "BUT", "NOT", "ANY", "CAN", "HAD", "HER", "WAS", "OUR", "GOT", "HAS", "HIM", "HIS", "MAN", "MEN", "OLD", "SEE",
    "WHO", "BOY", "DID", "ITS", "LET", "PUT", "SAY", "SHE", "TOO", "USE", "DAD", "MOM", "SON", "BAD", "YES", "YET", "AGO",
    "EAT", "FAT", "FUN", "HOT", "CAT", "DOG", "PEN", "SAW", "SIT", "SET", "MRS", "MAD", "SIN", "WIN", "WON", "WAR", "TEA",
    "VIA", "PER", "PAY", "FEE", "TAX", "VAT", "MAX", "MIN", "AGE", "AID", "AIM", "ARM", "ART", "ASK", "BAR", "BED", "BET",
    "BIT", "BOX", "CAP", "CUP", "CUT", "DIE", "DRY", "DUE", "EAR", "EGG", "END", "EYE", "FAR", "FEW", "FIT", "FIX", "FOX",
    "GAS", "GOD", "GUN", "GUY", "HAT", "HIT", "ICE", "ILL", "JOB", "JOY", "KEY", "KID", "LAB", "LAP", "LAW", "LAY", "LEG",
    "LIE", "LIP", "LOT", "MIX", "MUD", "NET", "NOR", "NUT", "ODD", "OIL", "OWN", "PAN", "PET", "PIE", "PIG", "PIN", "PIT",
    "POP", "POT", "PRO", "RAW", "RED", "RID", "ROW", "RUB", "RUN", "SAD", "SAT", "SEX", "SHY", "SKY", "SPA", "SPY", "SUM",
    "TAB", "TAG", "TIE", "TIN", "TIP", "TOE", "TON", "TOY", "TRY", "VAN", "VET", "WET", "ZIP", "ZOO", "HEY", "WOW", "YOU",
  ]);

  const CODE = /^[A-Z]{3}$/;
  /** A code glued to a Hebrew prefix, as typed in a Hebrew query: "לBCN", "מTLV". */
  const PREFIXED_CODE = /^([א-ת]{1,2})([A-Z]{3})$/;
  const ARTICLES = new Set(["the", "a", "an"]);

  /**
   * @typedef {{ c: Record<string, [string, string, string]>, a: Record<string, string>, k: Record<string, [string, string, string]>, n: Record<string, string> }} PlaceIndex
   * @typedef {{ type: "city" | "airport" | "country", code: string, apiCode: string, cityCode: string, cc: string, nameHe: string, nameEn: string, countryHe: string | null }} Place
   * @typedef {"to" | "from" | "in" | "via" | null} Role
   * @typedef {Place & { role: Role, start: number, end: number, via: "name" | "code", weak: boolean, byPrefix: boolean }} PlaceHit
   *   weak: the name is also an everyday word; byPrefix: its direction came from a Hebrew prefix glued to it ("לקניה")
   */

  /** @param {unknown} index */
  function isIndex(index) {
    const i = /** @type {any} */ (index);
    return !!i && typeof i === "object" && !!i.c && !!i.a && !!i.k && !!i.n;
  }

  /**
   * @param {PlaceIndex} index
   * @param {string} code
   * @returns {{ code: string, nameHe: string, nameEn: string, cc: string } | null}
   */
  function cityInfo(index, code) {
    if (typeof code !== "string" || !Object.hasOwn(index.c, code)) return null;
    const row = index.c[code];
    if (!Array.isArray(row)) return null;
    return { code, nameHe: row[0] || "", nameEn: row[1] || "", cc: row[2] || "" };
  }

  /**
   * @param {PlaceIndex} index
   * @param {string} cc
   * @returns {string | null}
   */
  function countryNameHe(index, cc) {
    if (typeof cc !== "string" || !Object.hasOwn(index.k, cc)) return null;
    return index.k[cc]?.[0] || null;
  }

  /**
   * A city or airport by code (either kind), or null.
   * @param {PlaceIndex} index
   * @param {string} code
   * @returns {Place | null}
   */
  function placeOfCode(index, code) {
    if (typeof code !== "string" || !CODE.test(code)) return null;
    const city = cityInfo(index, code);
    if (city) return { type: "city", code, apiCode: code, cityCode: code, cc: city.cc, nameHe: city.nameHe, nameEn: city.nameEn, countryHe: null };
    const cityCode = Object.hasOwn(index.a, code) ? index.a[code] : undefined;
    const parent = cityCode ? cityInfo(index, cityCode) : null;
    if (!parent) return null;
    return { type: "airport", code, apiCode: code, cityCode: parent.code, cc: parent.cc, nameHe: parent.nameHe, nameEn: parent.nameEn, countryHe: null };
  }

  /**
   * The city an airport or city code belongs to (the code itself when the index does not know it).
   * @param {PlaceIndex} index
   * @param {string} code
   */
  const cityOfCode = (index, code) => placeOfCode(index, code)?.cityCode ?? code;

  /**
   * A normalized name -> place, or null.
   * @param {PlaceIndex} index
   * @param {string} norm
   * @returns {Place | null}
   */
  function placeOfName(index, norm) {
    if (typeof norm !== "string" || norm === "" || !Object.hasOwn(index.n, norm)) return null;
    const target = index.n[norm];
    if (typeof target !== "string") return null;
    if (target.startsWith("@")) {
      const cc = target.slice(1);
      const row = Object.hasOwn(index.k, cc) ? index.k[cc] : undefined;
      if (!row) return null;
      const city = cityInfo(index, row[2]);
      if (!city) return null;
      return { type: "country", code: cc, apiCode: city.code, cityCode: city.code, cc, nameHe: city.nameHe, nameEn: city.nameEn, countryHe: row[0] || null };
    }
    if (target.startsWith("#")) return placeOfCode(index, target.slice(1));
    return placeOfCode(index, target);
  }

  /**
   * The direction the word before a place gives it. "via" / "דרך" mark a stop on the way, not the destination.
   * @param {{ norm: string } | undefined} token
   * @returns {Role}
   */
  function roleWord(token) {
    if (!token) return null;
    switch (token.norm) {
      case "to":
      case "into":
      case "ל":
      case "אל":
        return "to";
      case "from":
      case "מ":
      case "מנ":
        return "from";
      case "in":
      case "ב":
        return "in";
      case "via":
      case "דרכ":
        return "via";
      default:
        return null;
    }
  }

  /**
   * true for a query typed all in capitals ("CHEAP FLIGHTS TO ROME"): more than one Latin word, all upper case, and
   * not just airport codes ("TLV ATH" is two codes, not shouting).
   * @param {readonly { raw: string }[]} tokens
   */
  function isShouting(tokens) {
    const latin = tokens.filter((t) => /[A-Za-z]/.test(t.raw));
    return latin.length >= 2 && latin.every((t) => t.raw === t.raw.toUpperCase()) && latin.some((t) => t.raw.replace(/[^A-Za-z]/g, "").length > 3);
  }

  /**
   * Every place in the query, left to right, longest name first. Weak names without a direction word are skipped.
   * @param {readonly { raw: string, norm: string }[]} tokens
   * @param {PlaceIndex} index
   * @returns {PlaceHit[]}
   */
  function findPlaces(tokens, index) {
    const T = /** @type {any} */ (EEE.text);
    /** @type {PlaceHit[]} */
    const hits = [];
    if (!isIndex(index)) return hits;
    const shouting = isShouting(tokens);
    /** @param {string} code */
    const codeWord = (code) => CODE.test(code) && !CODE_STOP.has(code) && !(shouting && SHOUTED_WORDS.has(code));
    for (let i = 0; i < tokens.length; ) {
      // "from the UK": the direction word may stand before an article.
      const before = tokens[i - 1];
      const ctxRole = roleWord(before) ?? (before && ARTICLES.has(before.norm) ? roleWord(tokens[i - 2]) : null);
      /** @type {PlaceHit | null} */
      let found = null;
      for (let n = Math.min(MAX_WORDS, tokens.length - i); n >= 1 && !found; n--) {
        const words = tokens.slice(i, i + n).map((t) => t.norm);
        for (const { prefix, rest } of T.prefixReadings(words[0])) {
          const phrase = [rest, ...words.slice(1)].join(" ");
          const place = placeOfName(index, phrase);
          if (!place) continue;
          const prefixRole = prefix ? T.roleOfPrefix(prefix) : null;
          const role = prefixRole ?? ctxRole;
          const weak = WEAK_NAMES.has(phrase);
          if (weak && role === null) continue;
          found = { ...place, role, start: i, end: i + n, via: "name", weak, byPrefix: prefixRole !== null };
          break;
        }
      }
      const tok = /** @type {{ raw: string, norm: string }} */ (tokens[i]);
      if (!found && codeWord(tok.raw)) {
        const place = placeOfCode(index, tok.raw);
        if (place) found = { ...place, role: ctxRole, start: i, end: i + 1, via: "code", weak: false, byPrefix: false };
      }
      if (!found) {
        const m = PREFIXED_CODE.exec(tok.raw);
        const prefixRole = m ? T.roleOfPrefix(/** @type {string} */ (m[1])) : null;
        const place = m && prefixRole && codeWord(/** @type {string} */ (m[2])) ? placeOfCode(index, /** @type {string} */ (m[2])) : null;
        if (place) found = { ...place, role: prefixRole, start: i, end: i + 1, via: "code", weak: false, byPrefix: true };
      }
      if (found) {
        hits.push(found);
        i = found.end;
      } else i += 1;
    }
    return hits;
  }

  /** @param {Place} place */
  const isHome = (place) => place.cc === HOME;

  EEE.places = Object.freeze({ MAX_WORDS, WEAK_NAMES, CODE_STOP, SHOUTED_WORDS, isIndex, cityInfo, countryNameHe, placeOfCode, cityOfCode, placeOfName, roleWord, isShouting, findPlaces, isHome });
})();
