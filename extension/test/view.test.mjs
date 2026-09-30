/** The card's words and links (lib/view.js): a pure function of the lookup and the checked API data. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CTX, EEE, INDEX, TODAY, analyze, fixture, read } from "./helpers.mjs";

const V = EEE.view;
const A = EEE.api;
const calendar = () => A.sanitizeCalendar(fixture("calendar.json"), { kind: "calendar", origin: "TLV", destination: "ATH", month: "2026-11" });
const explore = () => A.sanitizeExplore(fixture("explore.json"), { kind: "explore", origin: "TLV", month: "2026-11" });
const route = (/** @type {string} */ q) => /** @type {any} */ (analyze(q));
const build = (/** @type {any} */ lookup, /** @type {any} */ data) => /** @type {any} */ (V.build(lookup, data, { today: TODAY, index: INDEX }));

describe("route card", () => {
  it("the cheapest fare of the month, its dates, the API's insight, the fixed disclaimer, the API's notice", () => {
    const vm = build(route("טיסות לאתונה בנובמבר"), calendar());
    assert.equal(vm.kind, "route");
    assert.equal(vm.title, "✈ הכי זול שמצאנו: ₪351");
    assert.deepEqual(vm.lines, [
      "תל אביב – אתונה · נובמבר 2026",
      "יציאה 10/11 · חזרה 20/11 · 10 לילות · טיסה ישירה",
      "יציאה ביום ג׳ זולה בממוצע ב-26% מיציאה ביום ה׳",
    ]);
    assert.equal(vm.disclaimer, "לנוסע אחד, הלוך־חזור, מחיר שמור מלפני כמה ימים — המחיר הסופי באתר ההזמנה");
    assert.match(vm.notice, /^המחירים הם מחירים שמורים/);
    assert.equal(vm.noticeSummary, "עוד על המחיר");
    assert.equal(vm.ariaLabel, "מנוע מחירי טיסות: מחיר טיסה זול, תל אביב – אתונה");
    assert.equal(vm.announce, "מנוע מחירי טיסות: הכי זול שמצאנו לאתונה: ₪351");
  });

  it("says it comes from this extension (on a Google page it must not pass for Google's own box)", () => {
    const manifest = JSON.parse(read("manifest.json"));
    assert.equal(V.BRAND, manifest.short_name);
    for (const vm of [build(route("טיסות לאתונה בנובמבר"), calendar()), build(route("טיסות זולות בנובמבר"), explore())]) {
      assert.equal(vm.brand, "מנוע מחירי טיסות · תוסף לדפדפן");
      assert.ok(vm.ariaLabel.startsWith(`${V.BRAND}:`));
      assert.ok(vm.announce.startsWith(`${V.BRAND}:`));
    }
  });

  it("an affiliate booking link (the API's `marker` parameter) says so under the buttons; a plain one says nothing", () => {
    assert.equal(build(route("טיסות לאתונה בנובמבר"), calendar()).affiliateNote, null); // the fixture's links carry no marker
    const data = /** @type {any} */ (calendar());
    data.days = data.days.map((/** @type {any} */ d) => ({ ...d, book: d.book ? `${d.book}&marker=12345` : null }));
    const vm = build(route("טיסות לאתונה בנובמבר"), data);
    assert.equal(vm.affiliateNote, "„להזמנה” הוא קישור שותפים: אם תזמינו דרכו, ייתכן שהאתר יקבל עמלה, בלי תוספת למחיר שלכם.");
    const ex = /** @type {any} */ (explore());
    ex.results = ex.results.map((/** @type {any} */ r) => ({ ...r, book: r.book ? `${r.book}?marker=12345` : null }));
    assert.equal(build(route("טיסות זולות בנובמבר"), ex).affiliateNote, V.AFFILIATE_NOTE);
    assert.equal(V.isAffiliateLink("https://www.aviasales.com/search/X?marker=1"), true);
    assert.equal(V.isAffiliateLink("https://www.aviasales.com/search/X?t=1"), false);
    assert.equal(V.isAffiliateLink(null), false);
  });

  it("a chosen return that differs from the cached fare's is said plainly", () => {
    // 02/11-17/11 chosen; the cached fare that leaves on 02/11 comes back on 10/11.
    const vm = build(route("טיסה לאתונה 2/11-17/11"), calendar());
    assert.deepEqual(vm.lines.slice(2, 4), ["ביציאה ב־02/11: ₪384, אבל עם חזרה ב־10/11 (לא 17/11)", "יציאה ב־10/11 זולה ב־₪33"]);
    // The cheapest day chosen, with another return: not "the cheapest we found" without a word about the return.
    const cheapestDay = build(route("טיסה לאתונה 10/11-14/11"), calendar());
    assert.ok(!cheapestDay.lines.includes("התאריך שבחרתם הוא הזול ביותר שמצאנו בחודש הזה"));
    assert.ok(cheapestDay.lines.includes("ביציאה ב־10/11: ₪351, אבל עם חזרה ב־20/11 (לא 14/11)"));
  });

  it("buttons: the API's own booking link, then the website's search filled for the month (not run)", () => {
    const vm = build(route("טיסות לאתונה בנובמבר"), calendar());
    assert.deepEqual(vm.actions.map((/** @type {any} */ a) => [a.label, a.primary]), [["להזמנה", true], ["לכל התאריכים באתר", false]]);
    assert.equal(vm.actions[0].url, "https://www.aviasales.com/search/TLV1011ATH20111?t=fixture-c");
    const site = new URL(vm.actions[1].url);
    assert.equal(site.origin + site.pathname, "https://eee-web-bly.pages.dev/");
    assert.deepEqual(Object.fromEntries(site.searchParams), { o: "TLV", d: "ATH", ws: "2026-11-01", we: "2026-11-30", ol: "תל אביב", dl: "אתונה", fill: "1" });
  });

  it("a chosen date that is not the cheapest: its price and the saving", () => {
    const vm = build(route("טיסה לאתונה 2/11"), calendar());
    assert.deepEqual(vm.lines.slice(2, 4), ["בתאריך שבחרתם (02/11): ₪384 · חזרה 10/11", "יציאה ב־10/11 זולה ב־₪33"]);
  });

  it("a chosen date that is the cheapest says so; one without a cached fare adds nothing", () => {
    assert.ok(build(route("טיסה לאתונה 10/11"), calendar()).lines.includes("התאריך שבחרתם הוא הזול ביותר שמצאנו בחודש הזה"));
    const noFare = build(route("טיסה לאתונה 20/11"), calendar());
    assert.equal(noFare.lines.length, 3); // route, fare, insight
  });

  it("exact dates fill the website's search with those dates and that stay", () => {
    const vm = build(route("טיסה לאתונה 10-17.11"), calendar());
    const site = new URL(vm.actions[vm.actions.length - 1].url);
    assert.equal(site.searchParams.get("ws"), "2026-11-10");
    assert.equal(site.searchParams.get("we"), "2026-11-17");
    assert.equal(site.searchParams.get("n"), "7-7");
  });

  it("without a trusted booking link there is no booking button, and the website button leads", () => {
    const data = /** @type {any} */ (calendar());
    data.days = data.days.map((/** @type {any} */ d) => ({ ...d, book: null }));
    const vm = build(route("טיסות לאתונה בנובמבר"), data);
    assert.deepEqual(vm.actions.map((/** @type {any} */ a) => [a.label, a.primary]), [["לכל התאריכים באתר", true]]);
  });

  it("a country search names the country; stops are described", () => {
    const vm = build(route("טיסות ליוון בנובמבר"), calendar());
    assert.equal(vm.lines[0], "תל אביב – אתונה (יוון) · נובמבר 2026");
    const data = /** @type {any} */ (calendar());
    data.days = [{ date: "2026-11-12", priceIls: 457.73, returnDate: "2026-11-15", nights: 3, stops: 1, returnStops: 0, book: null }];
    assert.equal(build(route("טיסות לאתונה בנובמבר"), data).lines[1], "יציאה 12/11 · חזרה 15/11 · 3 לילות · עד עצירה אחת");
  });

  it("nothing to show -> no card", () => {
    const data = /** @type {any} */ (calendar());
    assert.equal(V.build(route("טיסות לאתונה בנובמבר"), { ...data, days: [] }, CTX), null);
    assert.equal(V.build(route("טיסות לאתונה בנובמבר"), data, { today: "2026-11-25" }), null); // every fare already left
    assert.equal(V.build(route("טיסות לאתונה בנובמבר"), null, CTX), null);
    assert.equal(V.build(route("טיסות לאתונה בנובמבר"), explore(), CTX), null); // wrong kind
  });

  it("the website window starts today inside the current month, and is dropped when too short", () => {
    const url = (/** @type {string} */ today) => new URL(V.siteSearchUrl({ origin: "TLV", originLabel: "תל אביב", destination: "ATH", destLabel: "אתונה", month: "2026-09", today }));
    assert.equal(url("2026-09-10").searchParams.get("ws"), "2026-09-10");
    assert.equal(url("2026-09-30").searchParams.get("ws"), null);
    assert.equal(url("2026-09-30").searchParams.get("fill"), "1");
  });
});

describe("explore card", () => {
  it("top three destinations with prices, dates and links; the website's explore page", () => {
    const vm = build(route("טיסות זולות בנובמבר"), explore());
    assert.equal(vm.kind, "explore");
    assert.equal(vm.title, "✈ הכי זול שמצאנו: ₪178");
    assert.deepEqual(vm.lines, ["היעדים הזולים ביותר מתל אביב · נובמבר 2026"]);
    assert.deepEqual(
      vm.items.map((/** @type {any} */ i) => [i.name, i.price, i.dates, i.urlLabel]),
      [
        ["לרנקה, קפריסין", "₪178", "08/11–13/11 · 5 לילות", "להזמנה"],
        ["פלרמו, איטליה", "₪276", "14/11–16/11 · 2 לילות", "להזמנה"],
        ["פאפוס, קפריסין", "₪298", "06/11–13/11 · 7 לילות", "באתר"],
      ],
    );
    assert.equal(vm.items[0].url, "https://www.aviasales.com/search/TLV0811LCA13111");
    const site = new URL(vm.items[2].url);
    assert.deepEqual([site.searchParams.get("d"), site.searchParams.get("ws"), site.searchParams.get("we"), site.searchParams.get("n")], ["PFO", "2026-11-06", "2026-11-13", "7-7"]);
    assert.deepEqual(vm.actions, [{ label: "לכל היעדים באתר", url: "https://eee-web-bly.pages.dev/explore", primary: false }]);
    assert.match(vm.notice, /^המחירים הם מחירי מטמון/);
  });

  it("from Eilat the heading says so", () => {
    const vm = build(route("טיסות זולות מאילת בנובמבר"), explore());
    assert.equal(vm.lines[0], "היעדים הזולים ביותר מאילת · נובמבר 2026");
  });
});

describe("formatting", () => {
  it("shekels rounded up with thousands separators, day/month dates, nights and stops in Hebrew", () => {
    assert.equal(V.formatIls(1234.2), "₪1,235");
    assert.equal(V.formatIls(350), "₪350");
    assert.equal(V.shortDate("2026-11-02"), "02/11");
    assert.equal(V.nightsText(1), "לילה אחד");
    assert.equal(V.nightsText(7), "7 לילות");
    assert.equal(V.stopsText(0, 0), "טיסה ישירה");
    assert.equal(V.stopsText(0, 2), "עד 2 עצירות");
    assert.equal(V.stopsText(null, 0), null);
    assert.equal(V.placeLabel("סינגפור", "סינגפור"), "סינגפור");
  });

  it("no view ever shows undefined, null or NaN", () => {
    const views = [build(route("טיסות לאתונה בנובמבר"), calendar()), build(route("טיסה לאתונה 2/11"), calendar()), build(route("טיסות זולות בנובמבר"), explore())];
    for (const vm of views) {
      const visible = [
        vm.brand,
        vm.title,
        ...vm.lines,
        ...vm.items.flatMap((/** @type {any} */ i) => [i.name, i.price, i.dates, i.urlLabel]),
        vm.disclaimer,
        vm.notice,
        vm.noticeSummary,
        ...vm.actions.map((/** @type {any} */ a) => a.label),
        vm.ariaLabel,
        vm.announce,
      ];
      for (const text of visible) {
        assert.equal(typeof text, "string");
        assert.doesNotMatch(text, /undefined|NaN|\bnull\b|\[object/);
        assert.match(text, /[\u05D0-\u05EA]|^₪[\d,]+$/); // Hebrew (or a bare price)
      }
    }
  });
});
