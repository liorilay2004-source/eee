/**
 * Content script entry point (Google Search results and Google Flights only; see manifest.json).
 *
 * Reads the page ADDRESS (and, on Google Flights, the page title) whenever it changes, turns what the user typed into
 * a lookup (lib/query.js), asks the service worker for the cheapest known fare, and shows the card (content/popup.js).
 * It never reads the page's content and never makes a network request itself: the service worker does, with origin,
 * destination and month only.
 *
 * Google Flights is a single-page app: the address changes without a page load, so the address is checked on
 * popstate and once a second while the tab is visible (a string comparison; nothing else runs unless it changed).
 * When the address names cities rather than airports, the route comes from the title; a title that still names the
 * previous search (the address moved to other cities, the title did not change yet) is not used until it catches up.
 *
 * At most one card per route and month per page. While that card is on screen it follows the dates the user picks
 * (its "your date" lines and the website link), from the answer it already has. A failure, an empty answer or a rate
 * limit shows nothing.
 */
(() => {
  "use strict";
  const EEE = /** @type {any} */ (globalThis)[Symbol.for("eee.extension")];
  if (!EEE || !EEE.query || !EEE.popup || EEE.started) return;
  EEE.started = true;

  const Q = EEE.query;
  const S = EEE.settings;
  const POLL_MS = 1000;

  if (!Q.surfaceOf(location.href)) return;

  let settings = S.sanitize(null);
  /** @type {Promise<any> | null} */
  let indexPromise = null;
  /** Routes+months whose card was shown on this page: each appears at most once (closing it means "enough"). */
  const shownKeys = new Set();
  /** Lookups waiting for the service worker (asking again later is free: it answers repeats from its cache). */
  const pending = new Set();
  /** The card on screen: its route+month key, the dates it describes and the answer it was drawn from. */
  let shown = /** @type {{ key: string, dates: string, data: any } | null} */ (null);
  /** The newest lookup the page asked for (its key decides whether a late answer is still wanted). */
  let wanted = /** @type {{ key: string, lookup: any } | null} */ (null);
  /** Google Flights: the cities of the address and the title when they were last read (see Q.titleLags). */
  let flightsSeen = /** @type {{ place: string | null, title: string | null }} */ ({ place: null, title: null });
  let lastSignature = "";
  let alive = true;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let poll;

  const runtimeOk = () => {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };

  /**
   * One message to the service worker; null on any failure (e.g. the extension was reloaded meanwhile).
   * @param {Record<string, unknown>} message
   * @returns {Promise<any>}
   */
  function send(message) {
    return new Promise((resolve) => {
      if (!runtimeOk()) return resolve(null);
      try {
        chrome.runtime.sendMessage(message, (response) => {
          void chrome.runtime.lastError; // read, so Chrome does not log it
          resolve(response ?? null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  /** The place index, asked once per page and only after a query that looks like a flight search. */
  function getIndex() {
    indexPromise ??= send({ type: "index" }).then((x) => (EEE.places.isIndex(x) ? x : null));
    return indexPromise;
  }

  function hideCard() {
    if (EEE.popup.isShown()) EEE.popup.hide();
    shown = null;
  }

  function forget() {
    wanted = null;
    hideCard();
  }

  /** @param {"search" | "flights"} surface */
  async function hideOnThisSite(surface) {
    settings = S.sanitize({ ...settings, hiddenOn: [...settings.hiddenOn, surface] });
    try {
      await S.save(chrome.storage.sync, settings);
    } catch {
      /* the card is gone for this page anyway */
    }
  }

  async function evaluate() {
    const href = location.href;
    const title = document.title;
    const surface = Q.surfaceOf(href);
    if (!surface || !S.showsOn(settings, surface)) return forget();
    const today = EEE.dates.localToday(new Date());
    const ctx = { today, defaultOrigin: settings.origin };

    if (surface === "search") {
      let q = null;
      try {
        q = new URL(href).searchParams.get("q");
      } catch {
        /* no query */
      }
      if (!q || !Q.mightBeFlightSearch(q)) return forget();
    }

    const index = await getIndex();
    if (!index || href !== location.href) return;
    let lookup = null;
    if (surface === "search") lookup = Q.fromSearchUrl(href, index, ctx);
    else {
      const reading = Q.fromFlightsPage(href, title, index, ctx);
      if (Q.titleLags(flightsSeen, reading, title)) return forget(); // wait until the title names the new cities
      flightsSeen = { place: reading.place, title };
      lookup = reading.lookup;
    }
    if (!lookup) return forget();

    const key = Q.lookupKey(lookup);
    const dates = Q.datesKey(lookup);
    wanted = { key, lookup };
    if (shown && shown.key === key) {
      // Same route and month (e.g. only the passengers or the dates changed): the card stays and follows the dates.
      if (shown.dates !== dates && EEE.popup.isShown()) {
        const vm = EEE.view.build(lookup, shown.data, { today, index });
        if (vm) EEE.popup.update(vm);
        shown.dates = dates;
      }
      return;
    }
    if (shown) hideCard(); // another route: the old card no longer applies
    if (shownKeys.has(key) || pending.has(key)) return;
    const req = Q.apiRequest(lookup);
    if (!req) return;
    pending.add(key);
    let data = null;
    try {
      data = await send({ type: "lookup", req });
    } finally {
      pending.delete(key);
    }
    const latest = wanted;
    if (!alive || !latest || latest.key !== key || !S.showsOn(settings, surface)) return; // the user moved on meanwhile
    const vm = EEE.view.build(latest.lookup, data, { today, index }); // the newest dates for this route and month
    if (!vm) return;
    shown = { key, dates: Q.datesKey(latest.lookup), data };
    shownKeys.add(key);
    EEE.popup.show(vm, { onHideSite: () => void hideOnThisSite(surface) });
  }

  function stop() {
    alive = false;
    clearInterval(poll);
    removeEventListener("popstate", tick);
    document.removeEventListener("visibilitychange", tick);
  }

  function tick() {
    if (!alive) return;
    if (!runtimeOk()) return stop(); // the extension was updated or removed: this old copy goes quiet
    if (document.visibilityState !== "visible") return;
    const signature = `${location.href}\n${Q.surfaceOf(location.href) === "flights" ? document.title : ""}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    void evaluate().catch(() => undefined);
  }

  (async () => {
    try {
      settings = await S.load(chrome.storage.sync);
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync" || !changes[S.KEY]) return;
        settings = S.sanitize(changes[S.KEY].newValue);
        const surface = Q.surfaceOf(location.href);
        if (!S.showsOn(settings, surface)) hideCard();
        lastSignature = ""; // re-read the page with the new settings (a card already shown is not shown again)
      });
    } catch {
      /* defaults */
    }
    poll = setInterval(tick, POLL_MS);
    addEventListener("popstate", tick);
    document.addEventListener("visibilitychange", tick);
    tick();
  })();
})();
