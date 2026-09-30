/**
 * From what the user typed to a price lookup, or null (the extension then stays silent).
 *
 *   Google Search:  the `q` URL parameter only (the "All" results page, not the image/news/video tabs).
 *   Google Flights: the route and dates the user set up, read from the `tfs` URL parameter (lib/tfs.js); when tfs
 *                   names cities rather than airports, the route from its `q` parameter or the page title, with the
 *                   dates from tfs. Never the page content, never a price shown by Google.
 *
 * A lookup is one of
 *   { kind: "route",   origin, destination, month, depart?, ret? }  -> the API's price calendar for that month
 *   { kind: "explore", origin, month }                                -> the API's cheapest destinations that month
 * plus Hebrew display names. Only origin, destination and month ever reach the API (see apiRequest).
 *
 * Silence is the default. A query gets nothing when it has no flight word; holds a word that shows it is about
 * something else (a film, airplane mode, a flight's status, news of a landing or a strike, parking...); names a place
 * we cannot resolve, a region of a place ("south america", "צפון איטליה"), a stop on the way ("via istanbul"), two
 * different destinations, or a trip that does not start in Israel ("london to paris", "טיסה רומא אתונה", an Israeli
 * place after a foreign one with no "from"), that ends in Israel, or stays inside it ("טיסות אילת", "טיסות נתב"ג").
 */
(() => {
  "use strict";
  const EEE = /** @type {any} */ ((/** @type {any} */ (globalThis))[Symbol.for("eee.extension")] ??= {});
  if (EEE.query) return;

  /** Longer "queries" are not someone typing a flight search. */
  const MAX_QUERY_LEN = 200;
  const ORIGINS = ["TLV", "ETM"];
  /** Airports the API's explore endpoint accepts as origin (worker/src/explore.ts EXPLORE_ORIGINS). */
  const EXPLORE_ORIGINS = ["TLV", "ETM"];
  /** Google Search hosts (must equal the manifest's content_scripts matches; a test checks). */
  const SEARCH_HOSTS = [
    "www.google.com", "www.google.co.il", "www.google.co.uk", "www.google.de", "www.google.fr", "www.google.es",
    "www.google.it", "www.google.nl", "www.google.ca", "www.google.com.au",
  ];
  /** Google Flights hosts (same rule). */
  const FLIGHTS_HOSTS = ["www.google.com", "www.google.co.il"];
  /**
   * Google Search's `udm` values that are still the ordinary web results: none (the "All" tab) and 14 ("Web").
   * Every other tab (2 = images, 7 = videos, ...) and every `tbm` tab (isch, nws, vid, shop, bks) is left alone.
   */
  const WEB_UDM = ["14"];

  /** "LY315", "W62310", "6H881", "A320": a flight number or an aircraft type, never a fare search. */
  const FLIGHT_NUMBER = /^(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{2}\d{1,4}$/;
  const AIRLINE_CODE = /^(?:[A-Z][A-Z0-9]|[0-9][A-Z])$/;
  const DIGITS = /^\d{1,4}$/;
  /** "9/11 flights": the attacks, in an English query (in a Hebrew one "9/11" is the 9th of November). */
  const NINE_ELEVEN = /(?<![\d./-])9\s?\/\s?11(?![\d./-])/;
  const HEBREW_LETTER = /[א-ת]/;

  /**
   * @typedef {{ today: string, defaultOrigin?: string, surface?: "search" | "flights", impliedIntent?: boolean, allowExplore?: boolean }} Ctx
   * @typedef {{ kind: "route", surface: string, origin: string, originNameHe: string, destination: string, destNameHe: string, destCountryHe: string | null, month: string, depart: string | null, ret: string | null }} RouteLookup
   * @typedef {{ kind: "explore", surface: string, origin: string, originNameHe: string, month: string }} ExploreLookup
   * @typedef {RouteLookup | ExploreLookup} Lookup
   */

  /** @param {unknown} href */
  function safeUrl(href) {
    if (typeof href !== "string" || href.length > 8192) return null;
    try {
      const u = new URL(href);
      return u.protocol === "https:" ? u : null;
    } catch {
      return null;
    }
  }

  /**
   * Which Google surface an address is, or null.
   * @param {unknown} href
   * @returns {"search" | "flights" | null}
   */
  function surfaceOf(href) {
    const u = safeUrl(href);
    if (!u) return null;
    if (SEARCH_HOSTS.includes(u.hostname) && u.pathname === "/search") return "search";
    if (FLIGHTS_HOSTS.includes(u.hostname) && (u.pathname === "/travel/flights" || u.pathname.startsWith("/travel/flights/"))) return "flights";
    return null;
  }

  /** @param {string} today */
  const nextMonth = (today) => /** @type {any} */ (EEE.dates).addMonths(today.slice(0, 7), 1);

  /** @param {Ctx} ctx */
  const defaultOriginOf = (ctx) => (ORIGINS.includes(/** @type {string} */ (ctx?.defaultOrigin)) ? /** @type {string} */ (ctx.defaultOrigin) : "TLV");

  /**
   * The API origin for an Israeli place: Eilat/Ramon -> ETM, Haifa -> HFA, Tel Aviv -> TLV, the country -> default.
   * @param {any} place
   * @param {string} fallback
   */
  function originCodeOf(place, fallback) {
    if (!place || place.type === "country") return fallback;
    return place.cityCode === "ETM" ? "ETM" : place.cityCode === "HFA" ? "HFA" : place.cityCode === "TLV" ? "TLV" : fallback;
  }

  /**
   * Cheap first pass, no index needed: does the text contain a flight word and none of the words that rule it out?
   * The content script asks the service worker for the place index only when this says yes.
   * @param {unknown} text
   */
  function mightBeFlightSearch(text) {
    const T = /** @type {any} */ (EEE.text);
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_QUERY_LEN) return false;
    const tokens = T.tokenize(T.lightText(text));
    let intent = false;
    for (let i = 0; i < tokens.length; i++) {
      if (T.INTENT.matchAt(tokens, i) > 0) intent = true;
      if (isNegativeAt(tokens, i)) return false;
    }
    return intent;
  }

  /**
   * @param {{ has(norm: string): boolean, matchAt(tokens: readonly any[], i: number): number }} set
   * @param {readonly { raw: string, norm: string }[]} tokens
   * @param {number} i
   */
  function inSetAt(set, tokens, i) {
    const T = /** @type {any} */ (EEE.text);
    if (set.matchAt(tokens, i) > 0) return true;
    const tok = tokens[i];
    if (!tok) return false;
    // "בסרט", "והשביתה", "לצפון": the same words behind Hebrew prefixes.
    for (const { prefix, rest } of T.prefixReadings(tok.norm)) if (prefix && set.has(rest)) return true;
    return false;
  }

  /**
   * @param {readonly { raw: string, norm: string }[]} tokens
   * @param {number} i
   */
  const isNegativeAt = (tokens, i) => inSetAt(/** @type {any} */ (EEE.text).NEGATIVE, tokens, i);

  /** Airports, then cities, then countries: the most precise name the user gave for the destination. */
  const PRECISION = { airport: 0, city: 1, country: 2 };

  /**
   * Reads a typed query. null = stay silent.
   * @param {unknown} text
   * @param {import("./places.js").PlaceIndex | any} index
   * @param {Ctx} ctx
   * @returns {Lookup | null}
   */
  function analyze(text, index, ctx) {
    const T = /** @type {any} */ (EEE.text);
    const D = /** @type {any} */ (EEE.dates);
    const P = /** @type {any} */ (EEE.places);
    if (typeof text !== "string" || text.trim() === "" || text.length > MAX_QUERY_LEN) return null;
    if (!P.isIndex(index) || !D.isIsoDay(ctx?.today)) return null;
    const defaultOrigin = defaultOriginOf(ctx);

    const light = T.lightText(text);
    // Words that rule the query out count wherever they are, dates included.
    const all = T.tokenize(light);
    for (let i = 0; i < all.length; i++) if (isNegativeAt(all, i)) return null;
    if (NINE_ELEVEN.test(light) && !HEBREW_LETTER.test(light)) return null;
    const when = D.parseWhen(light, ctx.today);
    if (when.invalid) return null;
    const tokens = T.tokenize(D.blankSpans(light, when.spans));
    if (tokens.length === 0 && !ctx.impliedIntent) return null;

    /** @type {("intent" | "cue" | "neutral" | "place" | "unknown")[]} */
    const cat = tokens.map(() => "unknown");
    let intent = ctx.impliedIntent === true;
    let cue = false;
    let now = false;
    /** @type {number[]} */
    const intentEnds = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = /** @type {{ raw: string, norm: string }} */ (tokens[i]);
      const next = tokens[i + 1];
      if (FLIGHT_NUMBER.test(tok.raw)) return null;
      if (AIRLINE_CODE.test(tok.raw) && next && DIGITS.test(next.raw)) return null;
    }
    for (let i = 0; i < tokens.length; ) {
      const n = T.INTENT.matchAt(tokens, i);
      if (n > 0) {
        intent = true;
        for (let j = i; j < i + n; j++) cat[j] = "intent";
        intentEnds.push(i + n);
        i += n;
        continue;
      }
      const c = T.EXPLORE_CUE.matchAt(tokens, i);
      if (c > 0) {
        cue = true;
        for (let j = i; j < i + c; j++) cat[j] = "cue";
        i += c;
        continue;
      }
      if (T.BOARD_NOW.matchAt(tokens, i) > 0) now = true;
      const u = T.NEUTRAL.matchAt(tokens, i);
      if (u > 0) for (let j = i; j < i + u; j++) cat[j] = "neutral";
      i += Math.max(1, u);
    }
    if (!intent) return null;

    // Numbers: a count or a budget ("5 ימים", "2 adults", "עד 2030 שקל") is fine; a year must be the year asked
    // about; a bare number right after the flight word is a flight number or a title ("טיסה 5", "flight 93").
    /** @type {number[]} */
    const years = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = /** @type {{ raw: string, norm: string }} */ (tokens[i]);
      if (!DIGITS.test(tok.raw)) continue;
      const value = Number(tok.raw);
      const unit = T.COUNT_UNIT.matchAt(tokens, i + 1);
      const isYear = value >= 2024 && value <= 2035 && T.MONEY_UNIT.matchAt(tokens, i + 1) === 0;
      if (isYear || unit > 0) {
        if (isYear) years.push(value);
        cat[i] = "neutral";
        for (let j = i + 1; j <= i + unit; j++) cat[j] = "neutral";
      } else if (intentEnds.includes(i)) return null;
    }

    // Places. A weak name ("קניה" = Kenya / buying) behind a Hebrew prefix counts only after a flight word, a cue, a
    // neutral word or another place: "טיסה לקניה" / "טיסות מאילת לקניה" are Kenya, "טיפים לקניה של טיסה" is "tips for
    // buying a flight".
    const found = P.findPlaces(tokens, index);
    for (const p of found) if (!p.weak) for (let j = p.start; j < p.end; j++) cat[j] = "place";
    const places = found.filter((/** @type {any} */ p) => !(p.weak && p.byPrefix && p.start > 0 && cat[p.start - 1] === "unknown"));
    for (const p of places) for (let j = p.start; j < p.end; j++) cat[j] = "place";
    if (places.length > 0) {
      // "south america", "צפון איטליה", "אמריקה הלטינית", "new england": a region, not the place we would price.
      for (let i = 0; i < tokens.length; i++) if (cat[i] !== "place" && inSetAt(T.REGION, tokens, i)) return null;
    }

    // Direction. Israel is never a destination, a trip that starts abroad or stops on the way is not ours to price.
    if (places.some((/** @type {any} */ p) => p.role === "via")) return null;
    if (places.some((/** @type {any} */ p) => P.isHome(p) && p.role === "to")) return null;
    if (places.some((/** @type {any} */ p) => !P.isHome(p) && p.role === "from")) return null;
    const abroad = places.filter((/** @type {any} */ p) => !P.isHome(p));
    const homes = places.filter((/** @type {any} */ p) => P.isHome(p));
    // One destination: every foreign place must be the same city (or airport of it), or the country of that city.
    // Two cities ("london to paris", "טיסה רומא אתונה", "paris or rome") or two countries: not one trip from Israel.
    const cities = new Set(abroad.filter((/** @type {any} */ p) => p.type !== "country").map((/** @type {any} */ p) => p.cityCode));
    const countries = new Set(abroad.map((/** @type {any} */ p) => p.cc));
    if (cities.size > 1 || countries.size > 1) return null;
    // Two Israeli cities ("טיסה תל אביב אילת") are a domestic trip, or two different origins: not one search.
    // ("Israel" next to an Israeli city is that city: "from eilat israel".)
    const homeCities = homes.filter((/** @type {any} */ p) => p.type !== "country");
    if (new Set(homeCities.map((/** @type {any} */ p) => originCodeOf(p, defaultOrigin))).size > 1) return null;
    const dest = [...abroad].sort((/** @type {any} */ x, /** @type {any} */ y) => PRECISION[/** @type {keyof typeof PRECISION} */ (x.type)] - PRECISION[/** @type {keyof typeof PRECISION} */ (y.type)])[0] ?? null;
    // "אתונה תל אביב טיסות" / "athens tel aviv flights": a foreign place before the Israeli one, and no word saying
    // which way, is a flight INTO Israel.
    const firstHome = homes[0] ?? null;
    const outbound = abroad.some((/** @type {any} */ p) => p.role === "to") || homes.some((/** @type {any} */ p) => p.role === "from");
    if (dest && firstHome && !outbound && abroad[0].start < firstHome.start) return null;
    const origin = originCodeOf(homeCities[0] ?? homes[0] ?? null, defaultOrigin);
    const originNameHe = P.cityInfo(index, origin)?.nameHe || origin;
    const month = when.month ?? nextMonth(ctx.today);
    if (!D.monthInRange(month, ctx.today)) return null;
    // "טיסות לאתונה 2027" in 2026: the user named a year we are not showing.
    if (years.some((y) => y !== Number(month.slice(0, 4)))) return null;
    const surface = ctx.surface ?? "search";

    if (dest) {
      return {
        kind: "route",
        surface,
        origin,
        originNameHe,
        destination: dest.apiCode,
        destNameHe: dest.nameHe || dest.nameEn || dest.apiCode,
        destCountryHe: dest.type === "country" ? dest.countryHe : null,
        month,
        depart: when.depart,
        ret: when.ret,
      };
    }

    // No destination: the cheapest destinations, but only for a query that asks exactly that ("טיסות זולות",
    // "לאן לטוס בנובמבר", "flights"): every word known (a cue does not excuse others: "flight deals scam",
    // "cheap flights to the moon", "טיסות זולות לאירופה"), an Israeli place only as the explicit origin ("טיסות
    // מאילת", never "טיסות אילת" / "טיסות נתב"ג" / "flights in israel"), and no "today"/"now" without a cue word
    // ("טיסות נתב"ג היום" is the departures board).
    if (ctx.allowExplore === false || !EXPLORE_ORIGINS.includes(origin)) return null;
    if (cat.some((c) => c === "unknown")) return null;
    if (homes.some((/** @type {any} */ p) => p.role !== "from")) return null;
    if (!cue && (when.relativeDay || now)) return null;
    return { kind: "explore", surface, origin, originNameHe, month };
  }

  /**
   * Google Search: the `q` parameter of a web results page (not the image/news/video/shopping tabs).
   * @param {unknown} href
   * @param {any} index
   * @param {Ctx} ctx
   */
  function fromSearchUrl(href, index, ctx) {
    const u = safeUrl(href);
    if (!u || surfaceOf(href) !== "search" || u.searchParams.has("tbm")) return null;
    const udm = u.searchParams.get("udm");
    if (udm !== null && !WEB_UDM.includes(udm)) return null;
    const q = u.searchParams.get("q");
    if (!q) return null;
    return analyze(q, index, { ...ctx, surface: "search", impliedIntent: false });
  }

  /**
   * @typedef {{ code: string | null, id: string | null }} Side
   * @typedef {{ kind: "none" } | { kind: "reject" } | { kind: "route", lookup: RouteLookup, place: string } |
   *   { kind: "cities", place: string, fromCode: string | null, toCode: string | null, month: string | null, depart: string | null, ret: string | null }} TfsReading
   */

  /**
   * What the Google Flights `tfs` parameter says, before any fallback:
   *   none    unreadable, or no leg yet: the q parameter or the title may say more;
   *   reject  read, and not a trip we price (multi-city, open jaw, starts abroad, domestic, a date the calendar cannot
   *           show, a leg without both ends): silence, whatever q or the title say;
   *   route   airports on both ends: the route and dates, whatever the title says;
   *   cities  cities picked by name (Freebase ids, no codes): the route must come from q or the title, the dates from
   *           here; `place` identifies the cities, so a title that still names the previous search can be caught.
   * @param {unknown} tfs
   * @param {any} index
   * @param {Ctx} ctx
   * @returns {TfsReading}
   */
  function readTfs(tfs, index, ctx) {
    const D = /** @type {any} */ (EEE.dates);
    const P = /** @type {any} */ (EEE.places);
    const legs = /** @type {any} */ (EEE.tfs).decodeLegs(tfs);
    if (!Array.isArray(legs) || legs.length === 0) return { kind: "none" };
    if (legs.length > 2) return { kind: "reject" }; // multi-city: not a round trip
    const [first, second] = legs;
    /** @returns {Side} */
    const side = (/** @type {string[]} */ codes, /** @type {string[]} */ ids) => ({ code: codes[0] ?? null, id: ids[0] ?? null });
    const from = side(first.from, first.fromIds);
    const to = side(first.to, first.toIds);
    if (!(from.code || from.id) || !(to.code || to.id)) return { kind: "reject" }; // the form is not filled in yet
    if (from.id && to.id && from.id === to.id) return { kind: "reject" };
    if (from.code && to.code && from.code === to.code) return { kind: "reject" };
    // Two legs are a round trip only when the second comes back (by city: out of LHR, back into LGW is fine).
    /** @param {Side} a @param {Side} b */
    const same = (a, b) => (a.code && b.code ? P.cityOfCode(index, a.code) === P.cityOfCode(index, b.code) : a.id !== null && a.id === b.id);
    if (second && (!same(side(second.from, second.fromIds), to) || !same(side(second.to, second.toIds), from))) return { kind: "reject" };
    // A known end must already fit: the trip starts in Israel and does not end there.
    const f = from.code ? P.placeOfCode(index, from.code) : null;
    const t = to.code ? P.placeOfCode(index, to.code) : null;
    if (from.code && (!f || !P.isHome(f))) return { kind: "reject" };
    if (t && P.isHome(t)) return { kind: "reject" };
    const depart = D.isIsoDay(first.date) && first.date >= ctx.today ? first.date : null;
    const back = second?.date;
    const ret = depart && D.isIsoDay(back) && back > depart && D.dayNumber(back) - D.dayNumber(depart) <= 30 ? back : null;
    const month = depart ? depart.slice(0, 7) : null;
    if (month && !D.monthInRange(month, ctx.today)) return { kind: "reject" };
    const place = `${from.code ?? from.id}>${to.code ?? to.id}`;
    if (!from.code || !to.code) return { kind: "cities", place, fromCode: from.code, toCode: to.code, month, depart, ret };
    const origin = originCodeOf(f, defaultOriginOf(ctx));
    const routeMonth = month ?? nextMonth(ctx.today);
    if (!D.monthInRange(routeMonth, ctx.today)) return { kind: "reject" };
    return {
      kind: "route",
      place,
      lookup: {
        kind: "route",
        surface: "flights",
        origin,
        originNameHe: P.cityInfo(index, origin)?.nameHe || origin,
        destination: to.code,
        destNameHe: (t && (t.nameHe || t.nameEn)) || to.code,
        destCountryHe: null,
        month: routeMonth,
        depart,
        ret,
      },
    };
  }

  /**
   * Google Flights page title ("Tel Aviv to Athens | Google Flights", "טיסות מתל אביב לאתונה - Google Flights"):
   * a route only, never explore.
   * @param {unknown} title
   * @param {any} index
   * @param {Ctx} ctx
   * @returns {RouteLookup | null}
   */
  function fromFlightsTitle(title, index, ctx) {
    if (typeof title !== "string" || title.length > MAX_QUERY_LEN) return null;
    const core = title
      .replace(/\s*[|\-–—·]\s*Google\s*(?:Flights|טיסות)?\s*$/i, "")
      .replace(/^\s*Google\s*(?:Flights|טיסות)\s*[|\-–—·:]\s*/i, "")
      .trim();
    if (core === "" || /^google/i.test(core)) return null;
    const out = analyze(core, index, { ...ctx, surface: "flights", impliedIntent: true, allowExplore: false });
    return out && out.kind === "route" ? out : null;
  }

  /**
   * @typedef {{ lookup: Lookup | null, source: "tfs" | "q" | "title" | null, place: string | null }} FlightsReading
   */

  /**
   * Google Flights: what the user set up, from the address first.
   *   - tfs names airports: it alone decides; a trip we do not price is silence, never the title's guess;
   *   - tfs names cities: the route from q, else the title (checked against any airport code tfs does have), with
   *     the dates and month from tfs;
   *   - no readable tfs: q, else the title.
   * @param {unknown} href
   * @param {unknown} title
   * @param {any} index
   * @param {Ctx} ctx
   * @returns {FlightsReading}
   */
  function fromFlightsPage(href, title, index, ctx) {
    const P = /** @type {any} */ (EEE.places);
    /** @type {FlightsReading} */
    const none = { lookup: null, source: null, place: null };
    const u = safeUrl(href);
    if (!u || surfaceOf(href) !== "flights" || !P.isIndex(index)) return none;
    const tfs = u.searchParams.get("tfs");
    const read = tfs ? readTfs(tfs, index, ctx) : /** @type {TfsReading} */ ({ kind: "none" });
    if (read.kind === "reject") return none;
    if (read.kind === "route") return { lookup: read.lookup, source: "tfs", place: read.place };
    const q = u.searchParams.get("q");
    /** @type {Lookup | null} */
    let lookup = q ? analyze(q, index, { ...ctx, surface: "flights", impliedIntent: true }) : null;
    /** @type {"q" | "title"} */
    let source = "q";
    if (!lookup) {
      lookup = fromFlightsTitle(title, index, ctx);
      source = "title";
    }
    if (!lookup) return none;
    if (read.kind === "none") return { lookup, source, place: null };
    // tfs named cities: the words must describe that route, and its dates win.
    if (lookup.kind !== "route") return none;
    if (read.toCode && P.cityOfCode(index, read.toCode) !== P.cityOfCode(index, lookup.destination)) return none;
    if (read.fromCode && originCodeOf(P.placeOfCode(index, read.fromCode), defaultOriginOf(ctx)) !== lookup.origin) return none;
    const destination = read.toCode ?? lookup.destination;
    const toPlace = read.toCode ? P.placeOfCode(index, read.toCode) : null;
    return {
      lookup: {
        ...lookup,
        destination,
        destNameHe: toPlace ? toPlace.nameHe || toPlace.nameEn || destination : lookup.destNameHe,
        destCountryHe: toPlace ? null : lookup.destCountryHe,
        month: read.month ?? lookup.month,
        depart: read.month ? read.depart : lookup.depart,
        ret: read.month ? read.ret : lookup.ret,
      },
      source,
      place: read.place,
    };
  }

  /**
   * Google Flights, tfs, else q (the title is read by fromFlightsPage).
   * @param {unknown} href
   * @param {any} index
   * @param {Ctx} ctx
   * @returns {Lookup | null}
   */
  const fromFlightsUrl = (href, index, ctx) => fromFlightsPage(href, null, index, ctx).lookup;

  /**
   * true when a Google Flights reading came from a title that still names the PREVIOUS search: the address moved to
   * other cities (another `place`) while the title stayed exactly as it was. The caller waits for the title to change.
   * @param {{ place: string | null, title: string | null }} previous what was read last time (place and title)
   * @param {FlightsReading} reading
   * @param {unknown} title the title now
   */
  function titleLags(previous, reading, title) {
    return (
      reading.source === "title" &&
      reading.place !== null &&
      previous.title !== null &&
      previous.place !== reading.place &&
      title === previous.title
    );
  }

  /**
   * One key per distinct route and month: the card appears at most once per key and page.
   * @param {Lookup} lookup
   */
  function lookupKey(lookup) {
    return lookup.kind === "route" ? `route|${lookup.origin}|${lookup.destination}|${lookup.month}` : `explore|${lookup.origin}|${lookup.month}`;
  }

  /**
   * The chosen dates of a lookup: a card on screen for the same route and month follows them when they change.
   * @param {Lookup} lookup
   */
  const datesKey = (lookup) => (lookup.kind === "route" ? `${lookup.depart ?? ""}|${lookup.ret ?? ""}` : "");

  /**
   * The only data that leaves the page for the API: origin, destination code and month. Nothing typed, no address.
   * @param {Lookup} lookup
   * @returns {{ kind: "calendar", origin: string, destination: string, month: string } | { kind: "explore", origin: string, month: string } | null}
   */
  function apiRequest(lookup) {
    if (!lookup) return null;
    if (lookup.kind === "route") return { kind: "calendar", origin: lookup.origin, destination: lookup.destination, month: lookup.month };
    if (lookup.kind === "explore" && EXPLORE_ORIGINS.includes(lookup.origin)) return { kind: "explore", origin: lookup.origin, month: lookup.month };
    return null;
  }

  EEE.query = Object.freeze({
    MAX_QUERY_LEN,
    SEARCH_HOSTS,
    FLIGHTS_HOSTS,
    surfaceOf,
    mightBeFlightSearch,
    analyze,
    fromSearchUrl,
    readTfs,
    fromFlightsTitle,
    fromFlightsPage,
    fromFlightsUrl,
    titleLags,
    lookupKey,
    datesKey,
    apiRequest,
  });
})();
