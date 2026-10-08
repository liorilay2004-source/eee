/** Event-driven, local-only extraction of a visible fare candidate from a user-selected airline page. */
(() => {
  "use strict";
  const EEE = /** @type {any} */ (globalThis)[Symbol.for("eee.extension")] ??= {};
  const DATE_KEYS = ["departure", "depart", "departdate", "departuredate", "outbounddate", "ddate", "dateout"];
  const RETURN_KEYS = ["return", "returndate", "inbounddate", "rdate", "dateback"];
  const CURRENCY = new Map([
    ["€", "EUR"], ["EUR", "EUR"], ["£", "GBP"], ["GBP", "GBP"], ["₪", "ILS"], ["ILS", "ILS"],
    ["CHF", "CHF"], ["JPY", "JPY"], ["¥", "JPY"], ["KRW", "KRW"], ["TWD", "TWD"], ["CNY", "CNY"],
    ["INR", "INR"], ["AED", "AED"], ["TRY", "TRY"], ["PLN", "PLN"], ["CAD", "CAD"], ["AUD", "AUD"],
    ["USD", "USD"], ["US$", "USD"], ["CA$", "CAD"], ["A$", "AUD"], ["$", "USD"],
  ]);
  const CURRENCY_PATTERN = "US\\$|CA\\$|A\\$|USD|EUR|GBP|CHF|JPY|KRW|TWD|CNY|INR|AED|TRY|PLN|CAD|AUD|ILS|€|£|₪|¥|\\$";
  const MONEY_BEFORE = new RegExp(`(${CURRENCY_PATTERN})\\s*([0-9][0-9.,\\u00a0\\u202f '\u2019]{0,16})`, "gi");
  const MONEY_AFTER = new RegExp(`([0-9][0-9.,\\u00a0\\u202f '\u2019]{0,16})\\s*(${CURRENCY_PATTERN})`, "gi");

  function normalizeDate(raw) {
    const value = String(raw ?? "").trim();
    let m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(value);
    if (!m) return null;
    const day = Number(m[1]); const month = Number(m[2]); const year = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function urlValue(params, keys) {
    for (const [key, value] of params) if (keys.includes(key.toLowerCase())) return value;
    return null;
  }

  function routeFromUrl(url) {
    const params = [...url.searchParams];
    const from = urlValue(params, ["origin", "originairport", "originairportcode", "from", "departureairport", "dep"]);
    const to = urlValue(params, ["destination", "destinationairport", "destinationairportcode", "to", "arrivalairport", "arr"]);
    let origin = /^[A-Za-z]{3}$/.test(from ?? "") ? from.toUpperCase() : null;
    let destination = /^[A-Za-z]{3}$/.test(to ?? "") ? to.toUpperCase() : null;
    if (!origin || !destination) {
      const route = urlValue(params, ["route", "itinerary", "flightroute", "segment"])
        ?? url.pathname.match(/(?:^|\/)([A-Za-z]{3}[-_/]?[A-Za-z]{3})(?:\/|$)/)?.[1]
        ?? null;
      const compact = route?.replace(/[-_/]/g, "") ?? "";
      if (/^[A-Za-z]{6}$/.test(compact)) {
        origin ??= compact.slice(0, 3).toUpperCase();
        destination ??= compact.slice(3, 6).toUpperCase();
      }
    }
    return { origin, destination };
  }

  function amount(raw) {
    let value = String(raw).replace(/[\s\u00a0\u202f'\u2019]/g, "");
    const comma = value.lastIndexOf(","); const dot = value.lastIndexOf(".");
    const decimal = Math.max(comma, dot);
    if (decimal >= 0) {
      const decimals = value.length - decimal - 1;
      if (decimals === 1 || decimals === 2) {
        const whole = value.slice(0, decimal).replace(/[.,]/g, "");
        value = `${whole}.${value.slice(decimal + 1)}`;
      } else value = value.replace(/[.,]/g, "");
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 250000 ? Math.round(parsed * 100) / 100 : null;
  }

  function moneyCandidates(text) {
    const out = [];
    const add = (currencyToken, numberText) => {
      const currency = CURRENCY.get(currencyToken.toUpperCase()) ?? CURRENCY.get(currencyToken);
      const priceAmount = amount(numberText);
      if (!currency || priceAmount === null || out.some((x) => x.currency === currency && x.priceAmount === priceAmount)) return;
      out.push({ currency, priceAmount });
    };
    for (const m of text.matchAll(MONEY_BEFORE)) add(m[1], m[2]);
    for (const m of text.matchAll(MONEY_AFTER)) add(m[2], m[1]);
    return out.slice(0, 8);
  }

  function parsePage(href, priceTexts = [], bodyText = "") {
    let url;
    try { url = new URL(href); } catch { return []; }
    if (url.protocol !== "https:") return [];
    const route = routeFromUrl(url);
    const params = [...url.searchParams];
    const departDate = normalizeDate(urlValue(params, DATE_KEYS));
    const returnDate = normalizeDate(urlValue(params, RETURN_KEYS));
    const sources = priceTexts.length ? priceTexts : [String(bodyText).slice(0, 30000)];
    const candidates = [];
    for (const text of sources) {
      for (const price of moneyCandidates(String(text).slice(0, 500))) {
        const candidate = {
          ...route,
          departDate,
          returnDate,
          ...price,
        };
        const key = [candidate.origin, candidate.destination, departDate, returnDate, candidate.currency, candidate.priceAmount].join("|");
        if (!candidates.some((item) => item.key === key)) candidates.push({ key, candidate });
      }
    }
    return candidates.slice(0, 5).map((item) => item.candidate);
  }

  EEE.siteObserver = Object.freeze({ parsePage, normalizeDate, moneyCandidates });
})();
