/**
 * Text helpers shared by the content scripts, the background service worker, the index generator and the Node tests.
 *
 * Loading: a classic script (content scripts) and an ES module (service worker, Node) at the same time, so it has no
 * import/export and only attaches itself to the extension's namespace, globalThis[Symbol.for("eee.extension")].
 * The key is a symbol on purpose: a page element named or id'd like a string key ("<form name=EEE>") would shadow a
 * string-keyed global in the content scripts' world (named access on window), a symbol cannot be shadowed that way.
 * Pure: no DOM, no network, no clock.
 *
 * Everything here reads only what the USER typed (a search query, a URL parameter, a page title). Nothing reads page
 * content or prices.
 */
(() => {
  "use strict";
  const EEE = /** @type {any} */ ((/** @type {any} */ (globalThis))[Symbol.for("eee.extension")] ??= {});
  if (EEE.text) return;

  // --- normalization (the same rules as worker/src/airports/resolve.ts normalizeQuery) -------------------------

  /** Bidi marks, zero-width characters, variation selectors: invisible, so they vanish. */
  const INVISIBLE = /[\p{Cf}\uFE00-\uFE0F]/gu;
  /** Geresh, gershayim and every quote/apostrophe look-alike: dropped, so ארה"ב = ארהב and צ'כיה = צכיה. */
  const QUOTES = /['"`´ʼ׳״‘’“”′]/g;
  /** Niqqud and cantillation (U+0591-U+05C7). The maqaf (U+05BE) inside the range becomes a space first. */
  const HEBREW_POINTS = /[\u0591-\u05C7]/g;
  const MAQAF = /\u05BE/g;
  const COMBINING_MARKS = /[\u0300-\u036F]/g;
  const LATIN_FOLD_RE = /[øæœßłđı]/g;
  /** @type {Record<string, string>} */
  const LATIN_FOLD = { ø: "o", æ: "ae", œ: "oe", ß: "ss", ł: "l", đ: "d", ı: "i" };
  const HEBREW_FINALS_RE = /[ךםןףץ]/g;
  /** @type {Record<string, string>} */
  const HEBREW_FINALS = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };
  const NOT_WORD = /[^\p{L}\p{M}\p{N}\s]/gu;
  const WHITESPACE = /\s+/g;

  /** Longest input ever looked at: a longer "query" is not someone typing a flight search. */
  const MAX_INPUT_LEN = 300;

  /**
   * Canonical form of a name or query: no niqqud, no quotes/geresh, lower case, Hebrew final letters folded
   * (ך->כ ...), punctuation to spaces, single spaces. Total: any input yields a string.
   * @param {unknown} s
   * @returns {string}
   */
  function normalizeName(s) {
    if (typeof s !== "string" || s === "") return "";
    return s
      .replace(INVISIBLE, "")
      .replace(QUOTES, "")
      .normalize("NFKD")
      .replace(MAQAF, " ")
      .replace(HEBREW_POINTS, "")
      .toLowerCase()
      .replace(COMBINING_MARKS, "")
      .replace(LATIN_FOLD_RE, (c) => LATIN_FOLD[c] ?? c)
      .replace(HEBREW_FINALS_RE, (c) => HEBREW_FINALS[c] ?? c)
      .replace(NOT_WORD, " ")
      .replace(WHITESPACE, " ")
      .trim();
  }

  /**
   * A lighter form for date parsing: invisible marks and niqqud removed, compatibility forms folded (full-width
   * "１０/１１" -> "10/11", "ﬂ" -> "fl"), quote look-alikes unified to ' and ", maqaf and dashes to "-", single spaces.
   * Letter case, digits and / . - stay (the date patterns are case-insensitive; the case is kept so that what is left
   * can still be read as airport codes).
   * @param {unknown} s
   * @returns {string}
   */
  function lightText(s) {
    if (typeof s !== "string" || s === "") return "";
    return s
      .slice(0, MAX_INPUT_LEN)
      .replace(INVISIBLE, "")
      .normalize("NFKC")
      .replace(/[\u0591-\u05BD\u05BF-\u05C7]/g, "")
      .replace(/[\u05BE\u2010-\u2015\u2212]/g, "-")
      .replace(/[״“”„]/g, '"')
      .replace(/[׳‘’`´ʼ′]/g, "'")
      .replace(/''/g, '"')
      .replace(WHITESPACE, " ")
      .trim();
  }

  /**
   * @typedef {{ raw: string, norm: string }} Token
   * raw keeps the letter case as typed (an all-caps "ATH" is an airport code, "ath" is not); norm is normalizeName(raw).
   */

  /**
   * Words of a query, in order.
   * @param {unknown} s
   * @returns {Token[]}
   */
  function tokenize(s) {
    if (typeof s !== "string" || s === "") return [];
    const cleaned = s
      .slice(0, MAX_INPUT_LEN)
      .replace(INVISIBLE, "")
      .replace(QUOTES, "")
      .normalize("NFKD")
      .replace(MAQAF, " ")
      .replace(HEBREW_POINTS, "")
      .replace(COMBINING_MARKS, "")
      .replace(NOT_WORD, " ");
    /** @type {Token[]} */
    const out = [];
    for (const raw of cleaned.split(WHITESPACE)) {
      if (raw === "") continue;
      const norm = normalizeName(raw);
      if (norm !== "") out.push({ raw, norm });
    }
    return out;
  }

  // --- Hebrew prefixes --------------------------------------------------------------------------------------

  /**
   * Letters that attach to the next word: ו (and), ה (the), ב (in), ל (to), מ (from), ש (that), and the usual
   * two-letter combinations. Shortest first: "להודו" is ל + הודו, never לה + ודו.
   */
  const HE_PREFIXES = ["ו", "ה", "ב", "ל", "מ", "ש", "ול", "ומ", "וב", "וה", "של", "שמ", "שב"];

  /**
   * The ways to read a word as (prefix, rest), the word itself first.
   * @param {string} norm a normalized token
   * @returns {{ prefix: string, rest: string }[]}
   */
  function prefixReadings(norm) {
    const out = [{ prefix: "", rest: norm }];
    if (!/^[א-ת]/.test(norm)) return out;
    for (const p of HE_PREFIXES) {
      if (norm.length - p.length >= 2 && norm.startsWith(p)) out.push({ prefix: p, rest: norm.slice(p.length) });
    }
    return out;
  }

  /**
   * The direction a prefix gives the place after it: ל = to, מ = from, ב = in; anything else says nothing.
   * @param {string} prefix
   * @returns {"to" | "from" | "in" | null}
   */
  function roleOfPrefix(prefix) {
    const last = prefix.slice(-1);
    return last === "ל" ? "to" : last === "מ" ? "from" : last === "ב" ? "in" : null;
  }

  // --- phrase sets ------------------------------------------------------------------------------------------

  /**
   * A set of normalized phrases (one to four words) with a matcher over token lists.
   * @param {readonly string[]} phrases
   */
  function phraseSet(phrases) {
    /** @type {Map<number, Set<string>>} */
    const byLen = new Map();
    let longest = 1;
    for (const p of phrases) {
      const n = normalizeName(p);
      if (n === "") continue;
      const len = n.split(" ").length;
      longest = Math.max(longest, len);
      let set = byLen.get(len);
      if (!set) byLen.set(len, (set = new Set()));
      set.add(n);
    }
    return {
      /** @param {string} norm */
      has: (norm) => byLen.get(norm.split(" ").length)?.has(norm) === true,
      /**
       * Length (in tokens) of the longest phrase starting at tokens[i], or 0.
       * @param {readonly Token[]} tokens
       * @param {number} i
       */
      matchAt(tokens, i) {
        for (let len = Math.min(longest, tokens.length - i); len >= 1; len--) {
          const set = byLen.get(len);
          if (!set) continue;
          const text = tokens.slice(i, i + len).map((t) => t.norm).join(" ");
          if (set.has(text)) return len;
        }
        return 0;
      },
    };
  }

  /**
   * Words that make a Google search a flight search. Hebrew forms with ב/ל/ה prefixes are left out on purpose:
   * "בטיסה" / "לטיסה" / "הטיסה שלי" are about a flight someone already has (what to pack, a delay), not a fare.
   * So are the verbs "טס" / "טסה" ("X flies to Y"): they are news about someone else's flight ("ראש הממשלה טס
   * לוושינגטון", "הנבחרת טסה לאמסטרדם"), not a fare search.
   */
  const INTENT = phraseSet([
    "טיסה", "טיסות", "טיסת", "וטיסה", "וטיסות", "הטיסות", "והטיסות", "לטוס", "ולטוס", "טסים",
    "כרטיס טיסה", "כרטיסי טיסה", "כרטיס טיסות", "כרטיסי טיסות", "כרטיס לטיסה",
    "flight", "flights", "airfare", "airfares", "air fare", "air fares", "plane ticket", "plane tickets", "air ticket",
    "air tickets", "airline ticket", "airline tickets", "flight ticket", "flight tickets", "fly to", "flying to",
    "fly from", "flying from", "where to fly",
  ]);

  /**
   * Words that make a query with a flight word NOT a fare search: films, songs, airplane mode, flight status, boards
   * and trackers, crews, accidents and news (landed, delayed, cancelled, strikes, resumed, rescue flights, the air
   * force), refunds, insurance, check-in, durations and flight paths, lessons, simulators, space, parking, vouchers,
   * stopovers and domestic flights (not a trip from Israel we can price)...
   * Any of them silences the extension for that query (the Hebrew ones behind prefixes too: "בחירום", "והשביתה").
   */
  const NEGATIVE = phraseSet([
    // Hebrew
    "סרט", "סרטים", "סדרה", "סדרת", "פרק", "פרקים", "שיר", "שירים", "מילים", "אקורדים", "ספר", "ספרים", "משחק",
    "משחקים", "סימולטור", "סימולציה", "מצב טיסה", "מצב", "סטטוס", "סטאטוס", "מעקב", "המראות", "נחיתות", "לוח טיסות",
    "לוח המראות", "מספר טיסה", "דייל", "דיילת", "דיילות", "דיילים", "טייס", "טייסת", "טייסים", "פחד", "חרדת", "חרדה",
    "התרסקות", "תאונה", "תאונת", "חטיפה", "חטיפת", "ביטוח", "ביטול", "בוטלה", "בוטלו", "מבוטלת", "מבוטלות",
    "עיכוב", "עיכובים", "מתעכבת", "פיצוי", "פיצויים", "החזר", "החזרים", "זכויות", "צק אין", "צקאין", "כמה זמן",
    "כמה שעות", "שעות טיסה", "זמן טיסה", "משך", "מרחק", "משקל", "מטוס פרטי", "רחפן", "רחפנים", "כדור פורח", "צניחה",
    "קורס", "שיעור", "שיעורי", "מבחן", "אימון", "ויקיפדיה", "חדשות", "כתבה", "חלום", "פירוש", "חלל", "ירח",
    "מאדים", "טיל", "טילים", "יירוט", "אזעקה", "אזעקות", "מלחמה", "מלחמת", "מונית", "הסעה",
    "ביקורת", "ביקורות", "ארוחה", "מושב", "מושבים", "טרקלין", "תמונות", "סיוט",
    // Hebrew news about flights: cancelled, landed, delayed, strikes, suspended or resumed, emergencies, rescues
    "ביטולים", "ביטולי", "ביטלה", "ביטלו", "מבטלת", "מבטלות", "מבטלים", "מבטל", "בוטל", "יבוטלו", "נדחו", "נדחתה",
    "נדחות", "דחייה", "דחיית",
    "נחתה", "נחתו", "נוחתת", "נוחתות", "נחיתה", "נחיתת", "המריאה", "המריאו", "ממריאות", "יוצאות", "נכנסות",
    "התעכבה", "התעכבו", "מתעכבות", "מתעכבים", "איחור", "איחורים", "מאחרת",
    "שביתה", "שביתת", "שובתים", "עיצומים", "חודשו", "חודשה", "חידוש", "מתחדשות", "יחודשו", "חזרו", "חוזרות",
    "הושהו", "מושהות", "הושעו", "מושעות", "הופסקו", "הפסקת", "נעצרו", "הוקפאו", "מוקפאות", "סגור", "סגורות",
    "נסגר", "נסגרו", "סגירת", "חירום", "טרור", "פיגוע", "הרוגים", "פצועים", "נפגעים", "תקרית",
    "חילוץ", "פינוי", "הצלה", "הודעה", "הודעת", "הנחיות", "אזהרת מסע", "התרעה", "התרעת",
    "חיל האוויר", "חיל אוויר", "צבאי", "צבאית", "צבאיות", "מטוסי קרב", "תקיפה", "תקיפת", "הפצצה",
    // Hebrew: durations, paths, parking, vouchers, connections, domestic flights, videos, the body in flight
    "שעות", "שעה", "דקות", "נתיב", "נתיב טיסה", "מסלול טיסה", "חניה", "חנייה", "חניון", "שובר", "שוברים",
    "זיכוי", "זיכויים", "הונאה", "קונקשן", "טיסת המשך", "טיסות המשך", "עצירת ביניים", "פנים", "טיסות פנים",
    "טיסת פנים", "טרמינל", "סרטון", "סרטונים", "בחילה", "אוזניים", "ראלי",
    // English
    "movie", "movies", "film", "films", "series", "episode", "episodes", "song", "songs", "lyrics", "chords", "novel",
    "game", "games", "simulator", "sim", "mode", "status", "tracker", "tracking", "track", "radar", "flightradar",
    "flightradar24", "flightaware", "arrivals", "arrival", "departure board", "departures board", "attendant",
    "attendants", "crew", "pilot", "pilots", "crash", "crashes", "accident", "hijack", "hijacked", "hijacking", "delay",
    "delayed", "delays", "cancelled", "canceled", "cancellation", "cancellations", "compensation", "refund", "refunds",
    "insurance", "checkin", "check in", "allowance", "how long", "duration", "distance", "private jet", "drone",
    "drones", "balloon", "space", "spacex", "fear", "anxiety", "phobia", "wiki", "wikipedia", "news", "meme", "memes",
    "lego", "toy", "toys", "costume", "jacket", "suit", "school", "training", "lesson", "lessons", "deck", "stairs",
    "club", "risk", "controller", "stick", "wine", "beer", "whiskey", "tasting", "number", "flight time", "flight of",
    "flights of", "review", "reviews", "meal", "meals", "wifi", "seat map", "lounge", "photos", "nightmare",
    // English news, boards, durations, paths and the rest
    "cancel", "canceling", "cancelling", "landed", "landing", "landings", "emergency", "turbulence", "diverted",
    "diversion", "grounded", "strike", "strikes", "suspended", "suspension", "resumed", "resume", "resumes",
    "resuming", "halted", "banned", "ban", "evacuation", "evacuate", "rescue", "repatriation", "incident", "military",
    "air force", "fighter", "departures", "departure", "gate", "terminal", "hours", "hour", "minutes", "what time",
    "path", "paths", "route map", "voucher", "vouchers", "gift", "scam", "scams", "stopover", "stopovers", "layover",
    "layovers", "transit", "connecting", "domestic", "internal", "inland", "parking", "video", "videos", "lost",
    "shorts", "sneakers", "shoes", "rally",
  ]);

  /** Words that ask for the cheapest destinations rather than one place ("טיסות זולות", "לאן לטוס"). */
  const EXPLORE_CUE = phraseSet([
    "זול", "זולה", "זולות", "זולים", "הזול", "הזולה", "הזולות", "הזולים", "בזול", "מוזל", "מוזלת", "מוזלות",
    "מוזלים", "מבצע", "מבצעים", "דיל", "דילים", "לאן", "לאנשהו", "אנשהו", "חול", "לחול", "בחול", "רגע אחרון",
    "ברגע האחרון", "לאסט מינוט", "יעדים", "ליעדים",
    "cheap", "cheaper", "cheapest", "deal", "deals", "last minute", "anywhere", "everywhere", "abroad", "budget",
    "where to", "low cost", "lowcost", "low fare", "low fares", "bargain",
  ]);

  /**
   * Words that carry no destination and no doubt about intent: they may surround a flight word in a query that
   * still asks "what is cheap" ("כמה עולה טיסה הלוך חזור לזוג"). A query made only of these, intent words, cues,
   * dates and an Israeli origin is an explore query. (Seasons are read as dates, lib/dates.js; luggage words are not
   * here on purpose: "flight bag" is a product, not a fare search.)
   */
  const NEUTRAL = phraseSet([
    "ל", "מ", "ב", "ה", "ו", "של", "עם", "אל", "את", "הכי", "כמה", "עולה", "עולות", "עולים", "מחיר", "מחירי",
    "מחירים", "המחיר", "המחירים", "הלוך", "חזור", "הלוך חזור", "ושוב", "ישירה", "ישירות", "ישיר", "בלי", "ללא",
    "עצירות", "עצירה", "זוג", "לזוג", "משפחה", "למשפחה", "ילדים", "לילדים", "לשניים", "סופש", "לסופש", "בסופש",
    "סוף שבוע", "בסוף שבוע", "לסוף שבוע", "שבוע", "לשבוע", "בשבוע", "השבוע", "הבא", "הבאה", "חופשה", "לחופשה",
    "חופשת", "היום", "מחר", "למחר", "חודש", "בחודש", "החודש", "לחודש", "הקרוב", "הקרובה", "הקרובים", "ימים", "יום",
    "לילות", "לילה", "שבועות", "שבועיים", "חג", "חגים", "בחג", "בחגים", "לחג", "לחגים", "פסח", "בפסח", "לפסח",
    "סוכות", "בסוכות", "לסוכות", "חנוכה", "בחנוכה", "לחנוכה", "ראש השנה", "בראש השנה", "לראש השנה", "פורים",
    "בפורים", "אונליין", "באינטרנט", "השוואת", "השוואה", "השוואת מחירים", "הזמנה", "להזמין", "הזמנת", "אתר",
    "אתרי", "באתר", "חיפוש", "מבוגר", "מבוגרים", "למבוגר", "נוסע", "נוסעים", "לנוסע", "הכי טוב", "טובות", "עכשיו",
    "השנה", "בשנה", "הארץ", "מהארץ", "עד", "שקל", "שקלים", "שח", "דולר", "יורו", "תקציב", "בתקציב", "במיוחד", "ממש",
    "סופר", "בינלאומיות", "בינלאומית",
    "to", "from", "the", "a", "an", "for", "in", "on", "and", "or", "with", "without", "round", "trip", "roundtrip",
    "return", "one", "way", "oneway", "direct", "nonstop", "non", "stop", "stops", "ticket", "tickets", "price",
    "prices", "cost", "costs", "how", "much", "is", "are", "book", "booking", "online", "compare", "comparison",
    "search", "week", "weekend", "weekends", "month", "next", "this", "today", "tomorrow", "days", "day", "nights",
    "night", "weeks", "family", "couple", "kids", "holiday", "holidays", "vacation", "adult", "adults", "passenger",
    "passengers", "best", "top", "find", "now", "year", "me", "my", "i", "we", "under", "below", "nis", "ils",
    "shekel", "shekels", "usd", "dollars", "euro", "euros", "international", "worldwide", "really", "very", "super",
  ]);

  /**
   * Words that qualify a place as a region of it ("south america", "north korea", "צפון איטליה", "new england",
   * "אמריקה הלטינית"). A query that holds one besides a place asks about somewhere we cannot pin to one airport.
   */
  const REGION = phraseSet([
    "צפון", "דרום", "מזרח", "מערב", "מרכז", "צפונית", "דרומית", "מזרחית", "מערבית", "לטינית", "התיכון", "ניו",
    "north", "south", "east", "west", "northern", "southern", "eastern", "western", "central", "latin", "middle",
    "northeast", "northwest", "southeast", "southwest", "new", "upper", "lower",
  ]);

  /** "Now" words: without a cue word they make a query about today's departures board, not fares ("טיסות עכשיו"). */
  const BOARD_NOW = phraseSet(["עכשיו", "now"]);

  /**
   * Words right after a number that make it a trip length, a party size or a budget, not a flight number
   * ("5 ימים", "2 adults", "500 שקל").
   */
  const COUNT_UNIT = phraseSet([
    "ימים", "יום", "לילות", "לילה", "שבועות", "שבוע", "אנשים", "נוסעים", "מבוגרים", "ילדים", "חודשים",
    "שקל", "שקלים", "שח", "דולר", "יורו",
    "days", "day", "nights", "night", "weeks", "week", "people", "persons", "passengers", "adults", "kids", "months",
    "nis", "ils", "shekel", "shekels", "usd", "dollars", "euro", "euros",
  ]);

  /** Units after which a number is money, not a year ("עד 2030 שקל"). */
  const MONEY_UNIT = phraseSet(["שקל", "שקלים", "שח", "דולר", "יורו", "nis", "ils", "shekel", "shekels", "usd", "dollars", "euro", "euros"]);

  EEE.text = Object.freeze({
    MAX_INPUT_LEN,
    normalizeName,
    lightText,
    tokenize,
    prefixReadings,
    roleOfPrefix,
    phraseSet,
    INTENT,
    NEGATIVE,
    EXPLORE_CUE,
    NEUTRAL,
    REGION,
    BOARD_NOW,
    COUNT_UNIT,
    MONEY_UNIT,
  });
})();
