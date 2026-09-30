/**
 * What the in-page card says: a pure function from (lookup, API data) to Hebrew strings and links, so every word the
 * user sees is unit tested. No DOM here (content/popup.js draws it).
 *
 * Honesty rules: the card says it comes from this extension (on a Google page it must not pass for Google's own box);
 * the price is the cheapest CACHED round trip for one adult (the API's own basis), shown with its dates; the booking
 * link is the API's link or nothing, and an affiliate link says so; "saving" is only claimed between two prices of the
 * same response.
 */
(() => {
  "use strict";
  const EEE = /** @type {any} */ ((/** @type {any} */ (globalThis))[Symbol.for("eee.extension")] ??= {});
  if (EEE.view) return;

  /** The extension's name (manifest.json short_name, config/project.json display_name_he; a test keeps them equal). */
  const BRAND = "מנוע מחירי טיסות";
  const BRAND_LINE = `${BRAND} · תוסף לדפדפן`;
  /** The website (web/, Cloudflare Pages). "לכל התאריכים באתר" opens its search, filled but not run (fill=1). */
  const SITE_BASE = "https://eee-web-bly.pages.dev";
  const DISCLAIMER = "לנוסע אחד, הלוך־חזור, מחיר שמור מלפני כמה ימים — המחיר הסופי באתר ההזמנה";
  const NOTICE_SUMMARY = "עוד על המחיר";
  const AFFILIATE_NOTE = "„להזמנה” הוא קישור שותפים: אם תזמינו דרכו, ייתכן שהאתר יקבל עמלה, בלי תוספת למחיר שלכם.";

  /**
   * "₪1,234" (rounded up, like the website's formatILS).
   * @param {number} n
   */
  const formatIls = (n) => `₪${Math.ceil(n).toLocaleString("en-US")}`;

  /**
   * "2026-11-10" -> "10/11".
   * @param {string} day
   */
  const shortDate = (day) => (typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day.slice(8, 10)}/${day.slice(5, 7)}` : "");

  /** @param {number} n */
  const nightsText = (n) => (n === 1 ? "לילה אחד" : `${n} לילות`);

  /**
   * An affiliate booking link: the API adds Travelpayouts' `marker` parameter to Aviasales links when the owner has set
   * one (worker/src/travelpayouts.ts affiliateLink).
   * @param {unknown} url
   */
  function isAffiliateLink(url) {
    if (typeof url !== "string") return false;
    try {
      return new URL(url).searchParams.has("marker");
    } catch {
      return false;
    }
  }

  /**
   * @param {number | null} out
   * @param {number | null} back
   * @returns {string | null}
   */
  function stopsText(out, back) {
    if (out === null || back === null) return null;
    const worst = Math.max(out, back);
    return worst === 0 ? "טיסה ישירה" : worst === 1 ? "עד עצירה אחת" : `עד ${worst} עצירות`;
  }

  /**
   * "אתונה (יוון)" for a country search, else the city; the country is left out when one name holds the other.
   * @param {string} city
   * @param {string | null} country
   */
  function placeLabel(city, country) {
    if (!country || country.includes(city) || city.includes(country)) return city;
    return `${city} (${country})`;
  }

  /**
   * The website's search for this route, filled and NOT run (fill=1, web/src/lib/search.ts parseSearchParams):
   * exact dates when the user chose them, else the month from today on.
   * @param {{ origin: string, originLabel: string, destination: string, destLabel: string, month: string, depart?: string | null, ret?: string | null, today: string }} p
   */
  function siteSearchUrl(p) {
    const D = /** @type {any} */ (EEE.dates);
    const params = new URLSearchParams();
    params.set("o", p.origin);
    params.set("d", p.destination);
    let ws = null;
    let we = null;
    let n = null;
    if (p.depart && p.ret && p.depart >= p.today && p.ret > p.depart) {
      ws = p.depart;
      we = p.ret;
      const nights = D.dayNumber(p.ret) - D.dayNumber(p.depart);
      if (nights >= 1 && nights <= 30) n = `${nights}-${nights}`;
    } else if (D.isIsoMonth(p.month)) {
      const first = `${p.month}-01`;
      ws = first > p.today ? first : p.today;
      we = D.monthEnd(p.month);
      if (D.dayNumber(we) - D.dayNumber(ws) < 2) ws = we = null; // the website needs a window of at least a day or two
    }
    if (ws && we) {
      params.set("ws", ws);
      params.set("we", we);
    }
    if (n) params.set("n", n);
    if (p.originLabel) params.set("ol", p.originLabel);
    if (p.destLabel) params.set("dl", p.destLabel);
    params.set("fill", "1");
    return `${SITE_BASE}/?${params.toString()}`;
  }

  /**
   * @typedef {{ label: string, url: string, primary: boolean }} Action
   * @typedef {{ name: string, price: string, dates: string, url: string, urlLabel: string }} ListItem
   * @typedef {{ kind: "route" | "explore", brand: string, title: string, lines: string[], items: ListItem[], disclaimer: string, affiliateNote: string | null, notice: string | null, noticeSummary: string, actions: Action[], ariaLabel: string, announce: string }} View
   */

  /**
   * @param {any} lookup RouteLookup (lib/query.js)
   * @param {any} data CalendarData (lib/api.js)
   * @param {{ today: string }} ctx
   * @returns {View | null}
   */
  function buildRouteView(lookup, data, ctx) {
    const days = (Array.isArray(data?.days) ? data.days : []).filter((/** @type {any} */ d) => d.date >= ctx.today && d.date.startsWith(`${lookup.month}-`));
    if (days.length === 0) return null;
    let cheapest = days[0];
    for (const d of days) if (d.priceIls < cheapest.priceIls) cheapest = d;
    const dest = placeLabel(lookup.destNameHe, lookup.destCountryHe);
    const monthLabel = /** @type {any} */ (EEE.dates).monthLabelHe(lookup.month);
    const lines = [
      `${lookup.originNameHe} – ${dest} · ${monthLabel}`,
      [`יציאה ${shortDate(cheapest.date)}`, `חזרה ${shortDate(cheapest.returnDate)}`, nightsText(cheapest.nights), stopsText(cheapest.stops, cheapest.returnStops)]
        .filter(Boolean)
        .join(" · "),
    ];
    if (lookup.depart) {
      const chosen = days.find((/** @type {any} */ d) => d.date === lookup.depart);
      if (chosen && chosen.date === cheapest.date && (!lookup.ret || lookup.ret === chosen.returnDate)) lines.push("התאריך שבחרתם הוא הזול ביותר שמצאנו בחודש הזה");
      else if (chosen) {
        // The cached fare of that day comes back on ITS return date; when the user chose another one, say so.
        lines.push(
          lookup.ret && lookup.ret !== chosen.returnDate
            ? `ביציאה ב־${shortDate(chosen.date)}: ${formatIls(chosen.priceIls)}, אבל עם חזרה ב־${shortDate(chosen.returnDate)} (לא ${shortDate(lookup.ret)})`
            : `בתאריך שבחרתם (${shortDate(chosen.date)}): ${formatIls(chosen.priceIls)} · חזרה ${shortDate(chosen.returnDate)}`,
        );
        const diff = Math.ceil(chosen.priceIls) - Math.ceil(cheapest.priceIls);
        if (diff >= 1) lines.push(`יציאה ב־${shortDate(cheapest.date)} זולה ב־${formatIls(diff)}`);
      }
    }
    if (data.insightHe) lines.push(data.insightHe);
    const title = `✈ הכי זול שמצאנו: ${formatIls(cheapest.priceIls)}`;
    /** @type {Action[]} */
    const actions = [];
    if (cheapest.book) actions.push({ label: "להזמנה", url: cheapest.book, primary: true });
    actions.push({
      label: "לכל התאריכים באתר",
      url: siteSearchUrl({
        origin: lookup.origin,
        originLabel: lookup.originNameHe,
        destination: lookup.destination,
        destLabel: lookup.destNameHe,
        month: lookup.month,
        depart: lookup.depart,
        ret: lookup.ret,
        today: ctx.today,
      }),
      primary: !cheapest.book,
    });
    return {
      kind: "route",
      brand: BRAND_LINE,
      title,
      lines,
      items: [],
      disclaimer: DISCLAIMER,
      affiliateNote: isAffiliateLink(cheapest.book) ? AFFILIATE_NOTE : null,
      notice: data.noticeHe || null,
      noticeSummary: NOTICE_SUMMARY,
      actions,
      ariaLabel: `${BRAND}: מחיר טיסה זול, ${lookup.originNameHe} – ${dest}`,
      announce: `${BRAND}: הכי זול שמצאנו ל${dest}: ${formatIls(cheapest.priceIls)}`,
    };
  }

  /**
   * @param {any} lookup ExploreLookup
   * @param {any} data ExploreData
   * @param {{ today: string, index?: any }} ctx
   * @returns {View | null}
   */
  function buildExploreView(lookup, data, ctx) {
    const results = (Array.isArray(data?.results) ? data.results : []).filter((/** @type {any} */ r) => r.departDate >= ctx.today).slice(0, 3);
    if (results.length === 0) return null;
    const P = /** @type {any} */ (EEE.places);
    /** @type {ListItem[]} */
    const items = results.map((/** @type {any} */ r) => {
      const city = r.nameHe || r.nameEn || r.code;
      const country = r.countryHe || (ctx.index && r.cc ? P.countryNameHe(ctx.index, r.cc) : null);
      const name = !country || country.includes(city) || city.includes(country) ? city : `${city}, ${country}`;
      return {
        name,
        price: formatIls(r.priceIls),
        dates: `${shortDate(r.departDate)}–${shortDate(r.returnDate)} · ${nightsText(r.nights)}`,
        url:
          r.book ||
          siteSearchUrl({ origin: lookup.origin, originLabel: lookup.originNameHe, destination: r.code, destLabel: city, month: lookup.month, depart: r.departDate, ret: r.returnDate, today: ctx.today }),
        urlLabel: r.book ? "להזמנה" : "באתר",
      };
    });
    const min = Math.min(...results.map((/** @type {any} */ r) => r.priceIls));
    const monthLabel = /** @type {any} */ (EEE.dates).monthLabelHe(lookup.month);
    return {
      kind: "explore",
      brand: BRAND_LINE,
      title: `✈ הכי זול שמצאנו: ${formatIls(min)}`,
      lines: [`היעדים הזולים ביותר מ${lookup.originNameHe} · ${monthLabel}`],
      items,
      disclaimer: DISCLAIMER,
      affiliateNote: results.some((/** @type {any} */ r) => isAffiliateLink(r.book)) ? AFFILIATE_NOTE : null,
      notice: data.noticeHe || null,
      noticeSummary: NOTICE_SUMMARY,
      actions: [{ label: "לכל היעדים באתר", url: `${SITE_BASE}/explore`, primary: false }],
      ariaLabel: `${BRAND}: יעדים זולים מ${lookup.originNameHe}`,
      announce: `${BRAND}: הכי זול שמצאנו מ${lookup.originNameHe}: ${formatIls(min)}`,
    };
  }

  /**
   * @param {any} lookup
   * @param {any} data
   * @param {{ today: string, index?: any }} ctx
   * @returns {View | null}
   */
  function build(lookup, data, ctx) {
    if (!lookup || !data || !ctx || typeof ctx.today !== "string") return null;
    if (lookup.kind === "route" && data.kind === "calendar") return buildRouteView(lookup, data, ctx);
    if (lookup.kind === "explore" && data.kind === "explore") return buildExploreView(lookup, data, ctx);
    return null;
  }

  EEE.view = Object.freeze({ BRAND, BRAND_LINE, SITE_BASE, DISCLAIMER, AFFILIATE_NOTE, formatIls, shortDate, nightsText, stopsText, placeLabel, isAffiliateLink, siteSearchUrl, build });
})();
