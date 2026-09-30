/**
 * Google Flights: the route the user set up, read from the address only (tfs, then q), then from the page title.
 * Fixtures are hand-built protobuf messages shaped like Google's (length-delimited legs holding "2026-11-10" and
 * {1: 1, 2: "TLV"} airport messages); nothing here ever talks to Google.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CTX, EEE, INDEX, encodeMessage, leg, search, summary, toTfs } from "./helpers.mjs";

const Q = EEE.query;
const F = EEE.tfs;
const flights = (/** @type {string} */ query) => `https://www.google.com/travel/flights/search?${query}`;
const tfsOf = (/** @type {any[]} */ fields) => toTfs(encodeMessage(fields));
/** City ids of the shape Google Flights stores for a city picked by name (made up here, never looked up). */
const [TLV_ID, ATH_ID, PAR_ID, ROM_ID, BER_ID, AMS_ID] = ["/m/07qzv", "/m/0n2z", "/m/05qtj", "/m/06c62", "/m/0156q", "/m/0k3p"];
/** A leg between two cities picked by name: {2: date, 13: {1: 2, 2: id}, 14: {1: 2, 2: id}}. */
const cityLeg = (/** @type {string} */ date, /** @type {string} */ from, /** @type {string} */ to) =>
  /** @type {[number, any][]} */ ([
    [2, date],
    [13, [[1, 2], [2, from]]],
    [14, [[1, 2], [2, to]]],
  ]);

describe("tfs decoding", () => {
  it("base64url with or without padding, - and _; garbage is refused", () => {
    const bytes = Uint8Array.from([0xfb, 0xff, 0xbf, 0x01]);
    const b64 = Buffer.from(bytes).toString("base64"); // "+/+/AQ=="
    assert.deepEqual([...(/** @type {Uint8Array} */ (F.base64UrlToBytes(b64)))], [...bytes]);
    assert.deepEqual([...(/** @type {Uint8Array} */ (F.base64UrlToBytes(toTfs(bytes))))], [...bytes]);
    assert.equal(F.base64UrlToBytes("abc$"), null);
    assert.equal(F.base64UrlToBytes("a"), null);
    assert.equal(F.base64UrlToBytes(""), null);
    assert.equal(F.base64UrlToBytes("A".repeat(F.MAX_TFS_LEN + 1)), null);
  });

  it("a round trip: two legs with dates and airport codes", () => {
    const tfs = tfsOf(search([leg("2026-11-10", "TLV", "ATH"), leg("2026-11-17", "ATH", "TLV")]));
    assert.deepEqual(F.decodeLegs(tfs), [
      { date: "2026-11-10", from: ["TLV"], to: ["ATH"], fromIds: [], toIds: [] },
      { date: "2026-11-17", from: ["ATH"], to: ["TLV"], fromIds: [], toIds: [] },
    ]);
  });

  it("several airports on one side are all kept, in order", () => {
    const multi = [[2, "2026-11-10"], [13, [[1, 1], [2, "TLV"]]], [13, [[1, 1], [2, "ETM"]]], [14, [[1, 1], [2, "LHR"]]], [14, [[1, 1], [2, "LGW"]]]];
    assert.deepEqual(F.decodeLegs(tfsOf([[3, multi]])), [{ date: "2026-11-10", from: ["TLV", "ETM"], to: ["LHR", "LGW"], fromIds: [], toIds: [] }]);
  });

  it("does not rely on field numbers: codes in other fields are read in order of appearance", () => {
    const odd = [[7, "2026-12-01"], [21, [[5, "TLV"]]], [22, [[5, "BCN"]]]];
    assert.deepEqual(F.decodeLegs(tfsOf([[4, odd]])), [{ date: "2026-12-01", from: ["TLV"], to: ["BCN"], fromIds: [], toIds: [] }]);
    const flat = [[2, "2026-12-01"], [9, "TLV"], [10, "BCN"]];
    assert.deepEqual(F.decodeLegs(tfsOf([[3, flat]])), [{ date: "2026-12-01", from: ["TLV"], to: ["BCN"], fromIds: [], toIds: [] }]);
  });

  it("cities chosen by name are Freebase / Knowledge Graph ids, not codes: kept as ids, no codes", () => {
    const mid = [[2, "2026-11-10"], [13, [[1, 2], [2, "/m/07qzv"]]], [14, [[1, 2], [2, "/g/11bc6f2k0b"]]]];
    assert.deepEqual(F.decodeLegs(tfsOf(search([mid]))), [{ date: "2026-11-10", from: [], to: [], fromIds: ["/m/07qzv"], toIds: ["/g/11bc6f2k0b"] }]);
    const unknownLayout = [[2, "2026-11-10"], [21, [[5, "/m/07qzv"]]], [22, [[5, "ATH"]]]];
    assert.deepEqual(F.decodeLegs(tfsOf([[3, unknownLayout]])), [{ date: "2026-11-10", from: [], to: ["ATH"], fromIds: ["/m/07qzv"], toIds: [] }]);
  });

  it("a chosen flight's own segments inside a leg are not extra legs", () => {
    const segment = [[1, "TLV"], [2, "2026-11-10"], [3, "ATH"], [5, "LY"], [6, "541"]];
    const withSegments = [...leg("2026-11-10", "TLV", "ATH"), [4, segment]];
    assert.equal(F.decodeLegs(tfsOf(search([withSegments, leg("2026-11-17", "ATH", "TLV")]))).length, 2);
  });

  it("truncated, corrupt or random input never throws and yields no legs", () => {
    const good = encodeMessage(search([leg("2026-11-10", "TLV", "ATH")]));
    assert.deepEqual(F.decodeLegs(toTfs(good.subarray(0, 20))), []); // cut inside the leg
    assert.deepEqual(F.decodeLegs(toTfs(good.subarray(0, good.length - 1))), []); // cut inside the last field
    assert.deepEqual(F.decodeLegs(toTfs(Uint8Array.from([0x0b, 0x01]))), []); // a group: not supported
    assert.deepEqual(F.decodeLegs(/** @type {any} */ (null)), []);
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) % 256;
    for (let i = 0; i < 300; i++) {
      const junk = Uint8Array.from({ length: 1 + (i % 90) }, rnd);
      assert.doesNotThrow(() => F.decodeLegs(toTfs(junk)));
    }
  });

  it("deep nesting is bounded", () => {
    /** @type {any[]} */
    let msg = leg("2026-11-10", "TLV", "ATH");
    for (let i = 0; i < 20; i++) msg = [[1, msg]];
    assert.deepEqual(F.decodeLegs(tfsOf(msg)), []);
  });
});

describe("Google Flights address -> lookup", () => {
  it("round trip from tfs", () => {
    const tfs = tfsOf(search([leg("2026-11-10", "TLV", "ATH"), leg("2026-11-17", "ATH", "TLV")]));
    assert.equal(summary(Q.fromFlightsUrl(flights(`tfs=${tfs}&hl=iw&gl=IL&curr=ILS`), INDEX, CTX)), "ROUTE TLV-ATH 2026-11 2026-11-10 2026-11-17");
    assert.equal(Q.fromFlightsUrl(flights(`tfs=${tfs}`), INDEX, CTX)?.surface, "flights");
  });

  it("one way: the departure date only", () => {
    const tfs = tfsOf(search([leg("2026-12-03", "TLV", "LHR")]));
    assert.equal(summary(Q.fromFlightsUrl(flights(`tfs=${tfs}`), INDEX, CTX)), "ROUTE TLV-LHR 2026-12 2026-12-03");
  });

  it("from Eilat (Ramon)", () => {
    const tfs = tfsOf(search([leg("2026-11-02", "ETM", "PFO"), leg("2026-11-05", "PFO", "ETM")]));
    assert.equal(summary(Q.fromFlightsUrl(flights(`tfs=${tfs}`), INDEX, CTX)), "ROUTE ETM-PFO 2026-11 2026-11-02 2026-11-05");
  });

  it("not from Israel, into Israel, multi-city or a past date: no tfs route", () => {
    const back = tfsOf(search([leg("2026-11-10", "ATH", "TLV")]));
    assert.equal(Q.fromFlightsUrl(flights(`tfs=${back}`), INDEX, CTX), null);
    const domestic = tfsOf(search([leg("2026-11-10", "TLV", "ETM")]));
    assert.equal(Q.fromFlightsUrl(flights(`tfs=${domestic}`), INDEX, CTX), null);
    const multi = tfsOf(search([leg("2026-11-10", "TLV", "ATH"), leg("2026-11-13", "ATH", "ROM"), leg("2026-11-17", "ROM", "TLV")]));
    assert.equal(Q.fromFlightsUrl(flights(`tfs=${multi}`), INDEX, CTX), null);
    const past = tfsOf(search([leg("2026-09-01", "TLV", "ATH")]));
    assert.equal(summary(Q.fromFlightsUrl(flights(`tfs=${past}`), INDEX, CTX)), "ROUTE TLV-ATH 2026-10");
  });

  it("an unknown but well-formed destination code is passed on; Hebrew name falls back to the code", () => {
    const tfs = tfsOf(search([leg("2026-11-10", "TLV", "QQQ")]));
    const r = /** @type {any} */ (Q.fromFlightsUrl(flights(`tfs=${tfs}`), INDEX, CTX));
    assert.equal(r.destination, "QQQ");
    assert.equal(r.destNameHe, "QQQ");
  });

  it("falls back to the q parameter when tfs names cities, not airports (the dates stay tfs's)", () => {
    const mid = tfsOf(search([cityLeg("2026-11-10", TLV_ID, ATH_ID), cityLeg("2026-11-17", ATH_ID, TLV_ID)]));
    const q = encodeURIComponent("Flights to ATH from TLV on 2026-11-10 through 2026-11-17");
    assert.equal(summary(Q.fromFlightsUrl(flights(`tfs=${mid}&q=${q}`), INDEX, CTX)), "ROUTE TLV-ATH 2026-11 2026-11-10 2026-11-17");
    assert.equal(summary(Q.fromFlightsUrl(`https://www.google.co.il/travel/flights?q=${encodeURIComponent("טיסות מתל אביב לרומא")}`, INDEX, CTX)), "ROUTE TLV-ROM 2026-10");
    assert.equal(Q.fromFlightsUrl(flights(`tfs=${mid}`), INDEX, CTX), null);
    // A form still being filled in (only the origin set) is silence, whatever q says.
    const partial = tfsOf(search([[[2, "2026-11-10"], [13, [[1, 2], [2, TLV_ID]]]]]));
    assert.equal(Q.fromFlightsUrl(flights(`tfs=${partial}&q=${q}`), INDEX, CTX), null);
  });

  it("the page title as a last resort, a route only", () => {
    assert.equal(summary(Q.fromFlightsTitle("Tel Aviv to Athens | Google Flights", INDEX, CTX)), "ROUTE TLV-ATH 2026-10");
    assert.equal(summary(Q.fromFlightsTitle("Tel Aviv-Yafo to London - Google Flights", INDEX, CTX)), "ROUTE TLV-LON 2026-10");
    assert.equal(summary(Q.fromFlightsTitle("טיסות מתל אביב לאתונה – Google Flights", INDEX, CTX)), "ROUTE TLV-ATH 2026-10");
    assert.equal(summary(Q.fromFlightsTitle("תל אביב-יפו אל ברלין | Google טיסות", INDEX, CTX)), "ROUTE TLV-BER 2026-10");
    assert.equal(Q.fromFlightsTitle("Google Flights - Find Cheap Flight Options & Track Prices", INDEX, CTX), null);
    assert.equal(Q.fromFlightsTitle("Google Flights", INDEX, CTX), null);
    assert.equal(Q.fromFlightsTitle("Cheap flights | Google Flights", INDEX, CTX), null);
    assert.equal(Q.fromFlightsTitle(/** @type {any} */ (undefined), INDEX, CTX), null);
  });

  it("titles of trips that do not start in Israel are silence", () => {
    for (const t of ["London to Paris | Google Flights", "Paris to Rome | Google Flights", "Paris → Rome | Google Flights", "פריז אל רומא | Google Flights", "Rome – Athens | Google Flights", "London to Tel Aviv-Yafo | Google Flights"]) {
      assert.equal(Q.fromFlightsTitle(t, INDEX, CTX), null, t);
    }
  });
});

describe("Google Flights: the address decides, the title only fills in city names", () => {
  const page = (/** @type {string} */ tfs, /** @type {string | null} */ title) => Q.fromFlightsPage(flights(`tfs=${tfs}`), title, INDEX, CTX);

  it("tfs with airports that we do not price is silence, never the title's guess", () => {
    // Review finding: tfs LHR->CDG was rejected, then "London to Paris" in the title was priced from Tel Aviv.
    const abroad = tfsOf(search([leg("2026-11-10", "LHR", "CDG"), leg("2026-11-17", "CDG", "LHR")]));
    assert.equal(page(abroad, "London to Paris | Google Flights").lookup, null);
    assert.equal(page(tfsOf(search([leg("2026-11-10", "LHR", "ATH")])), "Tel Aviv-Yafo to Athens | Google Flights").lookup, null);
    assert.equal(page(tfsOf(search([leg("2030-01-10", "TLV", "ATH")])), "Tel Aviv-Yafo to Athens | Google Flights").lookup, null); // past the API's range
    const multi = tfsOf(search([leg("2026-11-10", "TLV", "ATH"), leg("2026-11-13", "ATH", "FCO"), leg("2026-11-17", "FCO", "TLV")]));
    assert.equal(page(multi, "Tel Aviv-Yafo to Athens | Google Flights").lookup, null);
  });

  it("two legs are a round trip only when the second comes back (by city)", () => {
    const openJaw = tfsOf(search([leg("2026-11-10", "TLV", "ATH"), leg("2026-11-14", "ATH", "FCO")]));
    assert.equal(page(openJaw, null).lookup, null);
    const otherAirport = tfsOf(search([leg("2026-11-10", "TLV", "LHR"), leg("2026-11-17", "LGW", "TLV")]));
    assert.equal(summary(page(otherAirport, null).lookup), "ROUTE TLV-LHR 2026-11 2026-11-10 2026-11-17");
  });

  it("cities picked by name: the route from the title, the month and dates from tfs", () => {
    // Review finding (e2e): a city search for 20-27/12 was priced for next month (October).
    const paris = tfsOf(search([cityLeg("2026-12-20", TLV_ID, PAR_ID), cityLeg("2026-12-27", PAR_ID, TLV_ID)]));
    const r = page(paris, "Tel Aviv-Yafo to Paris | Google Flights");
    assert.equal(summary(r.lookup), "ROUTE TLV-PAR 2026-12 2026-12-20 2026-12-27");
    assert.equal(r.source, "title");
    assert.equal(r.place, `${TLV_ID}>${PAR_ID}`);
    // A city origin and an airport destination: the airport is kept, and the title must agree with it.
    const mixed = tfsOf(search([[[2, "2026-12-20"], [13, [[1, 2], [2, TLV_ID]]], [14, [[1, 1], [2, "ATH"]]]]]));
    assert.equal(summary(page(mixed, "Tel Aviv-Yafo to Athens | Google Flights").lookup), "ROUTE TLV-ATH 2026-12 2026-12-20");
    assert.equal(page(mixed, "Tel Aviv-Yafo to Rome | Google Flights").lookup, null);
    // Cities abroad, whatever the title says.
    const parisRome = tfsOf(search([cityLeg("2026-11-10", PAR_ID, ROM_ID)]));
    assert.equal(page(parisRome, "Paris to Rome | Google Flights").lookup, null);
    // The second leg must come back to where the first began.
    const notBack = tfsOf(search([cityLeg("2026-12-20", TLV_ID, PAR_ID), cityLeg("2026-12-27", PAR_ID, ROM_ID)]));
    assert.equal(page(notBack, "Tel Aviv-Yafo to Paris | Google Flights").lookup, null);
    // A date the price calendar cannot show.
    assert.equal(page(tfsOf(search([cityLeg("2030-01-10", TLV_ID, PAR_ID)])), "Tel Aviv-Yafo to Paris | Google Flights").lookup, null);
  });

  it("a title that still names the previous cities is recognised (the caller waits for it to change)", () => {
    const berlin = tfsOf(search([cityLeg("2026-11-21", TLV_ID, BER_ID)]));
    const amsterdam = tfsOf(search([cityLeg("2026-11-22", TLV_ID, AMS_ID)]));
    const first = page(berlin, "Tel Aviv to Berlin | Google Flights");
    const seen = { place: first.place, title: "Tel Aviv to Berlin | Google Flights" };
    const stale = page(amsterdam, "Tel Aviv to Berlin | Google Flights");
    assert.equal(Q.titleLags(seen, stale, "Tel Aviv to Berlin | Google Flights"), true);
    const caughtUp = page(amsterdam, "Tel Aviv to Amsterdam | Google Flights");
    assert.equal(Q.titleLags(seen, caughtUp, "Tel Aviv to Amsterdam | Google Flights"), false);
    assert.equal(summary(caughtUp.lookup), "ROUTE TLV-AMS 2026-11 2026-11-22");
    // Same cities, other dates: the title is still right.
    const berlinLater = page(tfsOf(search([cityLeg("2026-11-28", TLV_ID, BER_ID)])), "Tel Aviv to Berlin | Google Flights");
    assert.equal(Q.titleLags(seen, berlinLater, "Tel Aviv to Berlin | Google Flights"), false);
    assert.equal(summary(berlinLater.lookup), "ROUTE TLV-BER 2026-11 2026-11-28");
    // Airports in tfs never depend on the title; the first reading of a page has nothing to compare with.
    const coded = page(tfsOf(search([leg("2026-11-10", "TLV", "ATH")])), "Tel Aviv to Berlin | Google Flights");
    assert.equal(Q.titleLags(seen, coded, "Tel Aviv to Berlin | Google Flights"), false);
    assert.equal(Q.titleLags({ place: null, title: null }, stale, "Tel Aviv to Berlin | Google Flights"), false);
  });

  it("the key of a lookup is its route and month; its dates are kept apart (a card on screen follows them)", () => {
    const a = /** @type {any} */ (page(tfsOf(search([leg("2026-12-06", "TLV", "BCN"), leg("2026-12-13", "BCN", "TLV")])), null).lookup);
    const b = /** @type {any} */ (page(tfsOf(search([leg("2026-12-10", "TLV", "BCN"), leg("2026-12-17", "BCN", "TLV")])), null).lookup);
    assert.equal(Q.lookupKey(a), Q.lookupKey(b));
    assert.notEqual(Q.datesKey(a), Q.datesKey(b));
  });
});

describe("which pages", () => {
  it("surfaceOf: Google Search results and Google Flights only, https only", () => {
    assert.equal(Q.surfaceOf("https://www.google.com/search?q=x"), "search");
    assert.equal(Q.surfaceOf("https://www.google.co.il/search?q=x"), "search");
    assert.equal(Q.surfaceOf("https://www.google.de/search?q=x"), "search");
    assert.equal(Q.surfaceOf("https://www.google.com/travel/flights"), "flights");
    assert.equal(Q.surfaceOf("https://www.google.co.il/travel/flights/search?tfs=x"), "flights");
    assert.equal(Q.surfaceOf("https://www.google.com/travel/flightsx"), null);
    assert.equal(Q.surfaceOf("https://www.google.com/searchbyimage?x"), null);
    assert.equal(Q.surfaceOf("https://www.google.com/maps"), null);
    assert.equal(Q.surfaceOf("http://www.google.com/search?q=x"), null);
    assert.equal(Q.surfaceOf("https://www.google.com.evil.example/search?q=x"), null);
    assert.equal(Q.surfaceOf("https://www.bing.com/search?q=x"), null);
    assert.equal(Q.surfaceOf("not a url"), null);
  });

  it("Google Search reads q only, and not on image/news/video tabs", () => {
    const url = (/** @type {string} */ q, extra = "") => `https://www.google.co.il/search?q=${encodeURIComponent(q)}${extra}`;
    assert.equal(summary(Q.fromSearchUrl(url("טיסות לאתונה"), INDEX, CTX)), "ROUTE TLV-ATH 2026-10");
    assert.equal(summary(Q.fromSearchUrl(url("טיסות לאתונה", "&tbm=isch"), INDEX, CTX)), "null");
    // Google's newer tab parameter: only the web results (no udm, or udm=14 "Web") count.
    assert.equal(summary(Q.fromSearchUrl(url("טיסות לאתונה", "&udm=2"), INDEX, CTX)), "null"); // images
    assert.equal(summary(Q.fromSearchUrl(url("טיסות לאתונה", "&udm=7"), INDEX, CTX)), "null"); // videos
    assert.equal(summary(Q.fromSearchUrl(url("טיסות לאתונה", "&udm=28"), INDEX, CTX)), "null");
    assert.equal(summary(Q.fromSearchUrl(url("טיסות לאתונה", "&udm=14"), INDEX, CTX)), "ROUTE TLV-ATH 2026-10");
    assert.equal(summary(Q.fromSearchUrl("https://www.google.com/search?oq=flights+to+athens", INDEX, CTX)), "null");
    assert.equal(summary(Q.fromSearchUrl(`https://www.google.com/travel/flights?q=${encodeURIComponent("flights to athens")}`, INDEX, CTX)), "null");
  });
});
