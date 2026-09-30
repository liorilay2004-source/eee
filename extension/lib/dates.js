/**
 * When does the user want to fly? Reads dates and months from a query ("בנובמבר", "10/11", "10-17.11",
 * "november 10", "2026-11-10", "בקיץ", "בעוד חודשיים") and nothing else. Pure: "today" is always passed in.
 *
 * Rules (stated, because they are guesses about what people mean):
 *  - Numeric dates are day first (10/11 = 10 November), the Israeli way.
 *  - A date or month without a year is the next time it comes (today counts).
 *  - Holidays ("בחנוכה") and "סופ״ש"/weekend are not read: they say nothing about the month we can trust.
 *  - A season ("בקיץ", "in winter") is the first month of that season from next month on ("בקיץ" in September 2026
 *    = June 2027); "החופש הגדול" is July.
 *  - The first exact date is the departure, a later one the return. Ranges: "10-17.11", "10 עד 17 בנובמבר",
 *    "מה-5 עד ה-12 בנובמבר", "בין ה-5 ל-12 בנובמבר", "5 to 12 november", "between 5 and 12 november", "nov 5 to 12".
 *  - Nothing found -> month null (the caller uses next month).
 *  - The answer is INVALID (the extension stays silent rather than guess another month) for: a month the price
 *    calendar cannot show (ended already, or starting more than MAX_ADVANCE_DAYS ahead); a date that looks like a date
 *    but does not exist ("31/11", "29/2" in a common year, "35 בנובמבר"); a month-first date ("12/25"); a period we
 *    cannot pin to one month ("next year", "בשנה הבאה").
 *  - Numbers that are not dates are skipped: decimals with a unit ("3.5 אלף", "2.5 שעות", "1.5k", "4.5 כוכבים"),
 *    "24/7", and number pairs that cannot be a date at all ("99.99").
 */
(() => {
  "use strict";
  const EEE = /** @type {any} */ ((/** @type {any} */ (globalThis))[Symbol.for("eee.extension")] ??= {});
  if (EEE.dates) return;

  /** The API's limit (worker/src/validate.ts MAX_ADVANCE_DAYS): a month must start within this many days. */
  const MAX_ADVANCE_DAYS = 365;
  const DAY_MS = 86_400_000;
  const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
  const ISO_MONTH = /^(\d{4})-(\d{2})$/;

  /** Hebrew month names, with the usual abbreviations (always written with a geresh: "נוב'", "דצמ׳"). */
  const HE_MONTHS = [
    ["ינואר", "ינו'"], ["פברואר", "פבר'"], ["מרץ", "מרס"], ["אפריל", "אפר'"], ["מאי"], ["יוני", "יונ'", "יון'"],
    ["יולי", "יול'"], ["אוגוסט", "אוג'"], ["ספטמבר", "ספט'"], ["אוקטובר", "אוק'"], ["נובמבר", "נוב'"], ["דצמבר", "דצמ'"],
  ];
  const EN_MONTHS = [
    ["january", "jan"], ["february", "feb"], ["march", "mar"], ["april", "apr"], ["may"], ["june", "jun"], ["july", "jul"],
    ["august", "aug"], ["september", "sept", "sep"], ["october", "oct"], ["november", "nov"], ["december", "dec"],
  ];
  /** Hebrew month names for display, index 0 = January. */
  const MONTH_NAMES_HE = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];

  /** @type {Map<string, number>} lower-case name -> month index 0-11 */
  const MONTH_INDEX = new Map();
  for (const [i, names] of HE_MONTHS.entries()) for (const n of names) MONTH_INDEX.set(n, i);
  for (const [i, names] of EN_MONTHS.entries()) for (const n of names) MONTH_INDEX.set(n, i);

  /** Seasons of the northern hemisphere, the Israeli way. */
  const SEASONS = /** @type {const} */ ({ winter: [12, 1, 2], spring: [3, 4, 5], summer: [6, 7, 8], autumn: [9, 10, 11], bigVacation: [7, 8] });
  /** @type {Record<string, keyof typeof SEASONS>} */
  const SEASON_OF = { חורף: "winter", אביב: "spring", קיץ: "summer", סתיו: "autumn", winter: "winter", spring: "spring", summer: "summer", autumn: "autumn", fall: "autumn" };

  /** Number words for "בעוד שלושה חודשים" / "in three months". */
  /** @type {Record<string, number>} */
  const COUNT_WORDS = { שני: 2, שלושה: 3, ארבעה: 4, חמישה: 5, שישה: 6, a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

  const byLength = (/** @type {string[]} */ list) => [...list].sort((a, b) => b.length - a.length).join("|");
  const HE_ALT = byLength(HE_MONTHS.flat());
  const EN_ALT = byLength(EN_MONTHS.flat());
  const EN_ALT_NO_MAY = byLength(EN_MONTHS.flat().filter((n) => n !== "may"));
  /**
   * Not a letter or digit of the scripts a query is read in (Latin and Hebrew). An explicit class rather than
   * \p{L}\p{N}: the patterns below are case-insensitive, and case-folding the whole Unicode letter class made the
   * first read of a page three to four times slower (all these patterns are compiled on first use).
   */
  const NB = "(?<![A-Za-z0-9À-ɏא-ת])";
  const NA = "(?![A-Za-z0-9À-ɏא-ת])";
  const ORD = "(?:st|nd|rd|th)?";
  const YEAR = "(20\\d{2})";
  /** What a number is when this follows it: money, thousands, hours, stars, distance, a percentage. */
  const UNIT_AFTER = /^\s?(?:אלף|אלפים|מיליון|שעות|שעה|כוכבים|כוכב|קילו|שקלים|שקל|ש"ח|שח|דולר|יורו|אחוז|k|m|million|hours?|hrs?|h|stars?|km|kg|nis|ils|usd|eur|euros?|dollars?|%|₪|\$|€)(?![A-Za-z0-9À-ɏא-ת])/iu;
  const CURRENCY_BEFORE = /[₪$€]\s?$/u;

  // --- calendar arithmetic (UTC, so the process time zone never matters) --------------------------------------

  const pad2 = (/** @type {number} */ n) => String(n).padStart(2, "0");
  const daysIn = (/** @type {number} */ y, /** @type {number} */ m1) => new Date(Date.UTC(y, m1, 0)).getUTCDate();
  const iso = (/** @type {number} */ y, /** @type {number} */ m1, /** @type {number} */ d) => `${y}-${pad2(m1)}-${pad2(d)}`;

  /**
   * @param {unknown} s
   * @returns {boolean} true for a real calendar day "YYYY-MM-DD"
   */
  function isIsoDay(s) {
    if (typeof s !== "string") return false;
    const m = ISO_DAY.exec(s);
    if (!m) return false;
    const mo = Number(m[2]);
    const d = Number(m[3]);
    return mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(Number(m[1]), mo);
  }

  /** @param {unknown} s */
  const isIsoMonth = (s) => typeof s === "string" && ISO_MONTH.test(s) && Number(s.slice(5, 7)) >= 1 && Number(s.slice(5, 7)) <= 12;

  /**
   * "YYYY-MM" plus n months.
   * @param {string} month
   * @param {number} n
   */
  function addMonths(month, n) {
    const idx = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
    return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`;
  }

  /** @param {string} day "YYYY-MM-DD" */
  const dayNumber = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
  /** @param {number} n */
  const dayOfNumber = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

  /**
   * @param {string} day "YYYY-MM-DD"
   * @param {number} n
   */
  const addDays = (day, n) => dayOfNumber(dayNumber(day) + n);

  /** @param {string} month "YYYY-MM" */
  const monthEnd = (month) => iso(Number(month.slice(0, 4)), Number(month.slice(5, 7)), daysIn(Number(month.slice(0, 4)), Number(month.slice(5, 7))));

  /**
   * Today's date where the browser is, as "YYYY-MM-DD" (a user in Israel at 01:00 means the Israeli day).
   * @param {Date} [now]
   */
  function localToday(now = new Date()) {
    return iso(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  /**
   * true when the API's price calendar can show this month: not over yet, and starting within MAX_ADVANCE_DAYS.
   * @param {string} month
   * @param {string} today
   */
  function monthInRange(month, today) {
    if (!isIsoMonth(month) || !isIsoDay(today)) return false;
    if (monthEnd(month) < today) return false;
    return dayNumber(`${month}-01`) <= dayNumber(today) + MAX_ADVANCE_DAYS;
  }

  /**
   * "2026-11" -> "נובמבר 2026".
   * @param {string} month
   */
  function monthLabelHe(month) {
    if (!isIsoMonth(month)) return "";
    return `${MONTH_NAMES_HE[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
  }

  // --- matching ---------------------------------------------------------------------------------------------

  /**
   * @typedef {{ d: number, m: number, y: number | null }} DayMonth
   * @typedef {{ start: number, end: number } & (
   *   { kind: "dates", dates: DayMonth[] } |
   *   { kind: "month", month: { m: number, y: number | null } } |
   *   { kind: "rel", rel: number } |
   *   { kind: "day", offset: number } |
   *   { kind: "season", season: keyof typeof SEASONS, y: number | null } |
   *   { kind: "ignore" } | { kind: "invalid" }
   * )} Hit
   */

  /**
   * Year for a day/month typed without one: the next time that date comes, today included.
   * @param {number} d
   * @param {number} m1
   * @param {string} today
   */
  function inferYear(d, m1, today) {
    const y = Number(today.slice(0, 4));
    return iso(y, m1, Math.min(d, daysIn(y, m1))) >= today ? y : y + 1;
  }

  /** @param {string | undefined} s two or four digits */
  const fullYear = (s) => (s === undefined ? null : s.length === 2 ? 2000 + Number(s) : Number(s));

  /**
   * A day and month typed as numbers, or what they are instead: a decimal/amount (ignore), a month-first date or a day
   * that does not exist (invalid), or two numbers that cannot be a date (ignore).
   * @param {number} d
   * @param {number} m
   * @param {string} sep "/" or "." (or "-")
   * @param {boolean} hasYear
   * @param {string} before text before the match
   * @param {string} after text after the match
   * @returns {"date" | "ignore" | "invalid"}
   */
  function numericKind(d, m, sep, hasYear, before, after) {
    if (sep === "." && !hasYear && (UNIT_AFTER.test(after) || CURRENCY_BEFORE.test(before))) return "ignore";
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return "date";
    if (sep === "/" && d >= 1 && d <= 12 && m >= 13 && m <= 31) return "invalid"; // 12/25: month first, not ours
    return "ignore";
  }

  /**
   * @param {string} text lightText output
   * @returns {Hit[]} non-overlapping, in text order
   */
  function findHits(text) {
    /** @type {Hit[]} */
    const hits = [];
    /**
     * @param {RegExp} re
     * @param {(m: RegExpExecArray, start: number, end: number) => any} build a hit without start/end, or null
     */
    const scan = (re, build) => {
      for (const m of text.matchAll(re)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        if (hits.some((h) => start < h.end && end > h.start)) continue;
        const hit = build(/** @type {RegExpExecArray} */ (m), start, end);
        if (hit) hits.push({ start, end, ...hit });
      }
    };
    const monthOf = (/** @type {string} */ name) => MONTH_INDEX.get(name.toLowerCase());
    /**
     * Dates named with a month word: a day that month cannot have makes the whole answer invalid.
     * @param {(string | undefined)[]} days
     * @param {(number | undefined)[]} months month indexes 0-11, one per day
     * @param {number | null} y
     */
    const named = (days, months, y) => {
      /** @type {DayMonth[]} */
      const out = [];
      for (const [i, raw] of days.entries()) {
        if (raw === undefined) continue;
        const mi = months[i];
        if (mi === undefined) return null;
        const d = Number(raw);
        if (d < 1 || d > 31) return { kind: "invalid" };
        out.push({ d, m: mi + 1, y });
      }
      return { kind: "dates", dates: out };
    };

    // 24/7: "always", never a date.
    scan(/(?<![\d./])24\s?\/\s?7(?![\d./])/g, () => ({ kind: "ignore" }));
    // 2026-11-10, 2026/11/10, 2026.11.10
    scan(/(?<![\d./])(20\d{2})([-/.])(\d{1,2})\2(\d{1,2})(?![\d./])/g, (m) => {
      const mo = Number(m[3]);
      const d = Number(m[4]);
      return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? { kind: "dates", dates: [{ d, m: mo, y: Number(m[1]) }] } : { kind: "invalid" };
    });
    // 10-17 בנובמבר, 10 עד 17 לנובמבר, מה-5 עד ה-12 בנובמבר, בין ה-5 ל-12 בנובמבר, 10 בנובמבר 2026
    scan(
      new RegExp(
        `(?<!\\d)(\\d{1,2})(?:\\s?-\\s?(\\d{1,2})|\\s?(?:עד|ל)\\s?-?\\s?(?:ה\\s?-?\\s?)?(\\d{1,2}))?\\s?(?:ב|ל|של\\s)?-?\\s?(${HE_ALT})(?:\\s${YEAR})?${NA}`,
        "giu",
      ),
      (m) => {
        const mi = monthOf(/** @type {string} */ (m[4]));
        return named([m[1], m[2] ?? m[3]], [mi, mi], fullYear(m[5]));
      },
    );
    // 10 november, 10th of nov 2026, 10-17 may, 5 to 12 november, between 5 and 12 november, 5th to the 12th of nov
    scan(
      new RegExp(
        `(?<!\\d)(\\d{1,2})${ORD}(?:\\s?(?:-|to|until|till|through|thru|and)\\s?(?:the\\s)?(\\d{1,2})${ORD})?\\s(?:of\\s)?(${EN_ALT})\\.?(?:,?\\s${YEAR})?${NA}`,
        "giu",
      ),
      (m) => {
        const mi = monthOf(/** @type {string} */ (m[3]));
        return named([m[1], m[2]], [mi, mi], fullYear(m[4]));
      },
    );
    // november 10, nov 10-17, nov 5 to 12, november 28 to december 3, may 10, 2026
    scan(
      new RegExp(
        `${NB}(${EN_ALT})\\.?\\s(\\d{1,2})${ORD}(?:\\s?(?:-|to|until|till|through|thru)\\s?(?:(${EN_ALT})\\.?\\s)?(\\d{1,2})${ORD})?(?:,?\\s${YEAR})?${NA}`,
        "giu",
      ),
      (m) => {
        const mi = monthOf(/** @type {string} */ (m[1]));
        const mi2 = m[3] ? monthOf(m[3]) : mi;
        return named([m[2], m[4]], [mi, mi2], fullYear(m[5]));
      },
    );
    // 10-17/11, 10-17.11.26
    scan(/(?<![\d./])(\d{1,2})\s?-\s?(\d{1,2})([./])(\d{1,2})(?:\3(\d{4}|\d{2}))?(?![\d./])/g, (m, start, end) => {
      const [d1, d2, mo] = [Number(m[1]), Number(m[2]), Number(m[4])];
      const kinds = [numericKind(d1, mo, /** @type {string} */ (m[3]), m[5] !== undefined, text.slice(0, start), text.slice(end)), numericKind(d2, mo, /** @type {string} */ (m[3]), m[5] !== undefined, "", text.slice(end))];
      if (kinds.includes("invalid")) return { kind: "invalid" };
      if (kinds.includes("ignore")) return { kind: "ignore" };
      const y = fullYear(m[5]);
      return { kind: "dates", dates: [{ d: d1, m: mo, y }, { d: d2, m: mo, y }] };
    });
    // 11/2026 (a month)
    scan(/(?<![\d./])(\d{1,2})[./](20\d{2})(?![\d./])/g, (m) => {
      const mo = Number(m[1]);
      return mo >= 1 && mo <= 12 ? { kind: "month", month: { m: mo, y: Number(m[2]) } } : { kind: "ignore" };
    });
    // 10/11, 10.11.2026, 10/11/26 (but not 3.5 אלף, 1.5k, ₪2.5, 99.99)
    scan(/(?<![\d./])(\d{1,2})([./])(\d{1,2})(?:\2(\d{4}|\d{2}))?(?![\d./])/g, (m, start, end) => {
      const kind = numericKind(Number(m[1]), Number(m[3]), /** @type {string} */ (m[2]), m[4] !== undefined, text.slice(0, start), text.slice(end));
      if (kind !== "date") return { kind };
      return { kind: "dates", dates: [{ d: Number(m[1]), m: Number(m[3]), y: fullYear(m[4]) }] };
    });
    // relative months: בעוד חודשיים, בעוד 3 חודשים, בעוד שלושה חודשים, in 2 months, in two months
    scan(new RegExp(`${NB}(?:בעוד\\sחודשיים|in\\stwo\\smonths)${NA}`, "giu"), () => ({ kind: "rel", rel: 2 }));
    scan(new RegExp(`${NB}(?:בעוד|in)\\s(\\d{1,2}|${Object.keys(COUNT_WORDS).join("|")})\\s(?:חודשים|months?)${NA}`, "giu"), (m) => {
      const word = /** @type {string} */ (m[1]).toLowerCase();
      const n = /^\d+$/.test(word) ? Number(word) : COUNT_WORDS[word];
      return n !== undefined && n >= 1 && n <= 12 ? { kind: "rel", rel: n } : { kind: "invalid" };
    });
    scan(new RegExp(`${NB}(?:[וב]?ה?חודש הבא|בעוד חודש|next month|in a month|in one month)${NA}`, "giu"), () => ({ kind: "rel", rel: 1 }));
    scan(new RegExp(`${NB}(?:בעוד שנה|in a year)${NA}`, "giu"), () => ({ kind: "rel", rel: 12 }));
    // a period that is not one month
    scan(new RegExp(`${NB}(?:next year|[וב]?ה?שנה הבאה)${NA}`, "giu"), () => ({ kind: "invalid" }));
    // בנובמבר, ובדצמבר 2026, בנוב' (Hebrew prefixes ו ב ל מ ה, up to two)
    scan(new RegExp(`${NB}[ובלמה]{0,2}(${HE_ALT})(?:\\s${YEAR})?${NA}`, "giu"), (m) => {
      const mi = monthOf(/** @type {string} */ (m[1]));
      return mi === undefined ? null : { kind: "month", month: { m: mi + 1, y: fullYear(m[2]) } };
    });
    // november, nov 2026 ("may" only in "in may" / "may 2027": otherwise it is the verb)
    scan(new RegExp(`${NB}(${EN_ALT_NO_MAY})\\.?(?:\\s${YEAR})?${NA}`, "giu"), (m) => {
      const mi = monthOf(/** @type {string} */ (m[1]));
      return mi === undefined ? null : { kind: "month", month: { m: mi + 1, y: fullYear(m[2]) } };
    });
    scan(new RegExp(`${NB}(?:(?:in|for|during|early|late|mid|end of|beginning of)\\s(may)|(may)\\s${YEAR})${NA}`, "giu"), (m) => ({
      kind: "month",
      month: { m: 5, y: fullYear(m[3]) },
    }));
    // seasons: "החופש הגדול" (July), בקיץ / לחורף / חופשת קיץ 2027; "אביב" / "סתיו" are also first names (and תל אביב!),
    // so they count only with ב/ל/ה, after "חופשת", or before a year / "הקרוב" / "הבא"
    scan(new RegExp(`${NB}[ובלה]{0,2}(?:ה)?חופש הגדול${NA}`, "giu"), () => ({ kind: "season", season: "bigVacation", y: null }));
    scan(new RegExp(`${NB}(?:חופשת\\s)?[ובלה]{0,2}(קיץ|חורף)(?:\\s(?:הקרוב|הבא|הזה))?(?:\\s${YEAR})?${NA}`, "giu"), (m) => ({
      kind: "season",
      season: SEASON_OF[/** @type {string} */ (m[1])],
      y: fullYear(m[2]),
    }));
    scan(
      new RegExp(
        `${NB}(?<!תל[\\s-]{0,3})(?:חופשת\\s(?:ה)?(אביב|סתיו)|[ובלה]{1,2}(אביב|סתיו)|(אביב|סתיו)(?=\\s(?:הקרוב|הבא|20\\d{2})))(?:\\s(?:הקרוב|הבא|הזה))?(?:\\s${YEAR})?${NA}`,
        "giu",
      ),
      (m) => ({ kind: "season", season: SEASON_OF[/** @type {string} */ (m[1] ?? m[2] ?? m[3])], y: fullYear(m[4]) }),
    );
    scan(new RegExp(`${NB}(?:(?:in|for|during|this|next|the|early|late|mid)\\s){0,2}(summer|winter|spring|autumn)(?:\\s${YEAR})?${NA}`, "giu"), (m) => ({
      kind: "season",
      season: SEASON_OF[/** @type {string} */ (m[1]).toLowerCase()],
      y: fullYear(m[2]),
    }));
    scan(new RegExp(`${NB}(?:(?:in the|during the|this|next|in)\\s(fall)(?:\\s${YEAR})?|(fall)\\s${YEAR})${NA}`, "giu"), (m) => ({
      kind: "season",
      season: "autumn",
      y: fullYear(m[2] ?? m[4]),
    }));
    // this month, today, tomorrow
    scan(new RegExp(`${NB}(?:[וב]?החודש|this month)${NA}`, "giu"), () => ({ kind: "rel", rel: 0 }));
    scan(new RegExp(`${NB}(?:[וב]?היום|today)${NA}`, "giu"), () => ({ kind: "day", offset: 0 }));
    scan(new RegExp(`${NB}(?:[וב]?מחר|למחר|tomorrow)${NA}`, "giu"), () => ({ kind: "day", offset: 1 }));
    return hits.sort((a, b) => a.start - b.start);
  }

  /**
   * The first month of a season from next month on (optionally in a given year), or null.
   * @param {keyof typeof SEASONS} season
   * @param {number | null} y
   * @param {string} today
   */
  function seasonMonth(season, y, today) {
    const first = addMonths(today.slice(0, 7), 1);
    for (let i = 0; i < 13; i++) {
      const month = addMonths(first, i);
      const [yy, mm] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
      if (/** @type {readonly number[]} */ (SEASONS[season]).includes(mm) && (y === null || yy === y)) return month;
    }
    return null;
  }

  /**
   * @typedef {{ month: string | null, depart: string | null, ret: string | null, spans: [number, number][], invalid: boolean, relativeDay: boolean }} When
   */

  /**
   * Dates and month in `text` (already passed through EEE.text.lightText).
   * @param {string} text
   * @param {string} today "YYYY-MM-DD"
   * @returns {When}
   */
  function parseWhen(text, today) {
    /** @type {When} */
    const none = { month: null, depart: null, ret: null, spans: [], invalid: false, relativeDay: false };
    if (typeof text !== "string" || text === "" || !isIsoDay(today)) return none;
    const hits = findHits(text);
    const spans = /** @type {[number, number][]} */ (hits.map((h) => [h.start, h.end]));
    const invalid = { ...none, spans, invalid: true };
    if (hits.some((h) => h.kind === "invalid")) return invalid;

    /** @type {string[]} */
    const days = [];
    for (const h of hits) {
      if (h.kind !== "dates") continue;
      let prev = days.length > 0 ? /** @type {string} */ (days[days.length - 1]) : null;
      for (const { d, m, y } of h.dates) {
        let year = y ?? inferYear(d, m, today);
        if (d > daysIn(year, m)) return invalid; // 31/11, 29/2 in a common year
        let day = iso(year, m, d);
        // A return typed without a year that would fall before the departure is next year's ("28/12 - 3/1").
        if (y === null && prev !== null && day < prev) {
          year += 1;
          if (d > daysIn(year, m)) return invalid;
          day = iso(year, m, d);
        }
        days.push(day);
        prev = day;
      }
    }

    const depart = days[0] ?? null;
    let ret = days.find((d) => depart !== null && d > depart) ?? null;
    let month = depart ? depart.slice(0, 7) : null;
    if (depart !== null && depart < today) return invalid;

    if (month === null) {
      const current = today.slice(0, 7);
      const first = hits.find((h) => h.kind === "month" || h.kind === "rel" || h.kind === "day" || h.kind === "season");
      if (first?.kind === "month") {
        const { m, y } = first.month;
        const thisYear = Number(today.slice(0, 4));
        const year = y ?? (m >= Number(today.slice(5, 7)) ? thisYear : thisYear + 1);
        month = `${year}-${pad2(m)}`;
      } else if (first?.kind === "rel") month = addMonths(current, first.rel);
      else if (first?.kind === "day") month = addDays(today, first.offset).slice(0, 7);
      else if (first?.kind === "season") {
        month = seasonMonth(first.season, first.y, today);
        if (month === null) return invalid;
      }
    }
    if (month !== null && !monthInRange(month, today)) return invalid;
    if (ret !== null && dayNumber(ret) - dayNumber(/** @type {string} */ (depart)) > 30) ret = null; // not one trip
    return { month, depart, ret, spans, invalid: false, relativeDay: hits.some((h) => h.kind === "day") };
  }

  /**
   * The text with the given spans replaced by spaces (so dates are not read again as words or flight numbers).
   * @param {string} text
   * @param {readonly [number, number][]} spans
   */
  function blankSpans(text, spans) {
    let out = text;
    for (const [s, e] of spans) out = out.slice(0, s) + " ".repeat(e - s) + out.slice(e);
    return out;
  }

  EEE.dates = Object.freeze({
    MAX_ADVANCE_DAYS,
    MONTH_NAMES_HE,
    isIsoDay,
    isIsoMonth,
    addMonths,
    addDays,
    dayNumber,
    monthEnd,
    localToday,
    monthInRange,
    monthLabelHe,
    parseWhen,
    blankSpans,
  });
})();
