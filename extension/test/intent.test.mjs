/**
 * When does a Google search make the card appear? Silence is the default: a query needs a flight word, and any sign
 * that it is about something else (a film, airplane mode, a flight's status, an accident, a duration...) silences it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EEE, analyze, summary } from "./helpers.mjs";

/** [query, expected]. Today is 2026-09-30, so "no month" means 2026-10. */
const POSITIVE = [
  ["טיסות לאתונה", "ROUTE TLV-ATH 2026-10"],
  ["טיסה לאתונה", "ROUTE TLV-ATH 2026-10"],
  ["טיסות זולות ליוון בנובמבר", "ROUTE TLV-ATH 2026-11"],
  ["כרטיס טיסה לרומא", "ROUTE TLV-ROM 2026-10"],
  ["כרטיסי טיסה לברלין בדצמבר", "ROUTE TLV-BER 2026-12"],
  ["טסים לבודפשט", "ROUTE TLV-BUD 2026-10"],
  ["לטוס לפראג במרץ", "ROUTE TLV-PRG 2027-03"],
  ["מחיר טיסה ללונדון", "ROUTE TLV-LON 2026-10"],
  ["כמה עולה טיסה לפריז", "ROUTE TLV-PAR 2026-10"],
  ["אתונה טיסות", "ROUTE TLV-ATH 2026-10"],
  ["flights to athens", "ROUTE TLV-ATH 2026-10"],
  ["cheap flights to rome", "ROUTE TLV-ROM 2026-10"],
  ["athens flights", "ROUTE TLV-ATH 2026-10"],
  ["airfare tel aviv to london", "ROUTE TLV-LON 2026-10"],
  ["plane tickets to paris november", "ROUTE TLV-PAR 2026-11"],
  ["fly to budapest", "ROUTE TLV-BUD 2026-10"],
  ["flight to Larnaca", "ROUTE TLV-LCA 2026-10"],
  ["flights TLV ATH", "ROUTE TLV-ATH 2026-10"],
  ["flights to nice", "ROUTE TLV-NCE 2026-10"],
  ["טיסה למלגה", "ROUTE TLV-AGP 2026-10"],
  ["טיסות מאילת לבודפשט", "ROUTE ETM-BUD 2026-10"],
  ["flights from eilat to budapest", "ROUTE ETM-BUD 2026-10"],
  ["טיסות מרמון לקפריסין", "ROUTE ETM-LCA 2026-10"],
  ["flights ETM to Paphos", "ROUTE ETM-PFO 2026-10"],
  ["טיסה לאתונה 10-17.11", "ROUTE TLV-ATH 2026-11 2026-11-10 2026-11-17"],
  ["Flights to ATH from TLV on 2026-11-10 through 2026-11-17", "ROUTE TLV-ATH 2026-11 2026-11-10 2026-11-17"],
  ["טיסות לסופ\"ש בברלין", "ROUTE TLV-BER 2026-10"],
  ["טיסה לילית לאתונה", "ROUTE TLV-ATH 2026-10"],
  ["טיסות לאתונה ל-5 ימים", "ROUTE TLV-ATH 2026-10"],
  // explore: flight intent, no destination
  ["טיסות זולות", "EXPLORE TLV 2026-10"],
  ["לאן לטוס בנובמבר", "EXPLORE TLV 2026-11"],
  ["טיסות", "EXPLORE TLV 2026-10"],
  ["cheap flights", "EXPLORE TLV 2026-10"],
  ["flights", "EXPLORE TLV 2026-10"],
  ["טיסות זולות לחו\"ל", "EXPLORE TLV 2026-10"],
  ["טיסות בדצמבר", "EXPLORE TLV 2026-12"],
  ["טיסות זולות מאילת", "EXPLORE ETM 2026-10"],
  ["last minute flights from tel aviv", "EXPLORE TLV 2026-10"],
  ["טיסות זולות עד 500 שקל", "EXPLORE TLV 2026-10"],
  ["טיסות עד 500 ש\"ח", "EXPLORE TLV 2026-10"],
  ["טיסות לאתונה עד 1000 שקל", "ROUTE TLV-ATH 2026-10"],
  ["flights under 300 dollars", "EXPLORE TLV 2026-10"],
  ["דילים של טיסות לסוף שבוע", "EXPLORE TLV 2026-10"],
];

/** Queries that must never show anything. */
const NEGATIVE = [
  "אתונה",
  "מזג אוויר ביוון",
  "athens hotels",
  "טיסה 5 סרט",
  "טיסה 5",
  "flight 93",
  "flight 1549 movie",
  "מלונות ברומא",
  "flight simulator",
  "microsoft flight simulator 2024",
  "מצב טיסה באייפון",
  "airplane mode",
  "flight mode iphone",
  "flight status LY315",
  "LY315",
  "LY 315 טיסה",
  "סטטוס טיסה LY001",
  "flightradar24",
  "flight attendant",
  "דיילת טיסה משכורת",
  "טיסה נעימה",
  "have a nice flight",
  "nice flights",
  "flights may be cancelled",
  "טיסות לאתונה בוטלו",
  "ביטוח נסיעות לטיסה ליוון",
  "כמה זמן טיסה לתאילנד",
  "how long is the flight to bangkok",
  "flight time to new york",
  "פחד טיסה טיפול",
  "fear of flying course",
  "טיסה לחלל",
  "space flight",
  "התרסקות טיסה",
  "plane crash",
  "flights of stairs",
  "wine flight",
  "Flight of the Conchords",
  "טיסות לאילת",
  "flights to tel aviv",
  "טיסות מלונדון לרומא",
  "flights from paris",
  "flights from the UK",
  "טיסות לאטלנטיס",
  "cheap flights to europe",
  "טיסות אל על",
  "wizz air flights",
  "מלגה לטיסה",
  "delayed flight compensation",
  "check in flight el al",
  "טיסה לנתב\"ג המראות",
  "flight tracker",
  "A320 flight",
  "שיר טיסה",
  "flight lyrics",
  "טיסות לאתונה בנובמבר 2027",
  "טיסות לאתונה 10/11/2025",
  "",
  "   ",
];

/**
 * Found in review (privacy and parsing-adversary passes): queries that used to show a card and must not.
 * News and trivia about flights, departure boards, domestic trips, regions, stops on the way, trips that do not start
 * in Israel, everyday words that are also place names, products and tabs.
 */
const REVIEW_NEGATIVE = [
  // someone else's flight in the news ("X טס/טסה ל-Y" is news, not a fare search)
  "ראש הממשלה טס לוושינגטון", "נבחרת ישראל טסה לאמסטרדם", "מכבי תל אביב טסה למדריד", "וויז אייר טסה לאתונה",
  "נתניהו טס לוושינגטון", "ביבי טס לארה\"ב", "לאן טסה כנף ציון", "לאן טס המטוס",
  // cancelled, landed, delayed, strikes, resumed, suspended, emergencies, rescues, announcements
  "הטיסות לאתונה חזרו", "טיסות חילוץ לישראלים ביוון", "אל על ביטלה טיסות לאתונה", "וויז מבטלת טיסות לאתונה",
  "ריינאייר מבטלת טיסות לרומא", "טיסה לאתונה נחתה בשלום", "טיסה נחתה בחירום באתונה", "טיסת ישראייר לאתונה נחתה בנתב\"ג",
  "טיסה לאתונה התעכבה", "איחור טיסה לאתונה", "שביתה טיסות לאתונה", "טיסות לאתונה חודשו", "טיסות לאתונה מושהות",
  "הודעה על טיסות לדובאי", "אל על דוחה טיסות", "הטיסות לאילת נדחו", "טיסות חיל האוויר בלבנון", "טיסות מעל לבנון",
  "טיסות חילוץ מבצע עם כלביא", "טיסות לחו\"ל נתב\"ג סגור", "flight emergency landing athens", "turbulence flight singapore",
  "flights to athens suspended", "flights to rome resumed", "what is the cheapest flight ever",
  // departure boards, domestic trips, Israel as the only place
  "טיסות נתב\"ג", "טיסות נתב\"ג היום", "טיסות היום", "flights today", "טיסות עכשיו", "טיסות יוצאות מנתב\"ג",
  "טיסות אילת", "eilat flights", "טיסות זולות אילת", "טיסה תל אביב אילת", "טיסות בישראל", "flights in israel",
  "טיסות פנים בתאילנד", "domestic flights in japan", "internal flights vietnam",
  // durations, paths, boards, parking, vouchers, products, a rally
  "flight hours to new york", "how many hours flight to thailand", "flight departures athens", "flight path from tel aviv to london",
  "טיסה לאתונה 2.5 שעות", "חניה זולה נתב\"ג טיסות", "טיסות לחניה", "flight bag", "flight deals scam", "cheap flight voucher",
  "cheap flights with bags", "טיסות עם מזוודה", "flight denzel washington", "jordan flight shorts", "air jordan 1 flight",
  "טיסות ראלי דקאר", "9/11 flights",
  // everyday Hebrew words that are also place names, without a direction ("בקו" = on a line, "קניה" = buying)
  "טיסות בקו ישיר", "קניה טיסות אונליין", "טיפים לקניה של טיסה זולה", "טיסה קרבי", "טיסות סבו וסבתא", "טיסה מרידה",
  "טיסות דוחה", "טיסות סופיה",
  // a destination we cannot resolve, whatever cue is around it
  "cheap flights to the caribbean", "cheap flights to the moon", "cheap flights europe", "טיסות זולות לאירופה",
  "טיסות זולות לאטלנטיס", "לאן לטוס באירופה", "flights to the moon",
  // a region of a place, not the place
  "flights to south america", "flights to latin america", "flights to central america", "טיסה זולה לדרום אמריקה",
  "טיסות לאמריקה הלטינית", "flights to north korea", "טיסות לצפון קפריסין", "flights to northern cyprus",
  "flights to northern ireland", "flights to new england", "flights to new mexico", "טיסות לצפון איטליה",
  "טיסות לצפון יוון", "flights to south of france", "flights to the middle east",
  // two destinations, or a trip that does not start in Israel (no "from" needed to see it)
  "london to paris flights", "new york to london flights", "flights LHR to CDG", "טיסות לונדון לפריז", "טיסה רומא אתונה",
  "flights paris to rome", "טיסות פריז רומא", "london new york flights", "טיסה בנגקוק פוקט", "flights to ontario canada",
  "טיסות לאתונה או לרומא", "flights to athens or rome", "טיסה לאתונה ומשם לרומא", "באלי טיסה לאתונה",
  // into Israel: a foreign place before the Israeli one, and no word saying which way
  "אתונה תל אביב טיסות", "athens tel aviv flights",
  // a stop on the way
  "flights to rome via athens", "flights from tel aviv via istanbul", "טיסות דרך איסטנבול", "טיסות לרומא דרך אתונה",
  "stopover in athens flight",
  // a year we are not showing, a period that is not one month, a date that does not exist or is month-first
  "טיסות לאתונה 2027", "flights to rome next year", "טיסות לאתונה בשנה הבאה", "flights to rome 12/25", "טיסה לרומא 31/11",
  "טיסות לאתונה 29/2",
  // typed all in capitals: "CAN", "HER", "MAD" are words there, not airport codes
  "CAN I GET CHEAP FLIGHTS", "CHEAP FLIGHTS FOR HER", "CHEAP FLIGHTS, MAD DEALS", "FLIGHTS TLV MAD",
];

/** Found in review: queries that were silent or wrong and are right now. */
const REVIEW_POSITIVE = [
  ["עובדה: טיסות זולות לאתונה", "ROUTE TLV-ATH 2026-10"], // "עובדה" (a fact) is not Ovda without a direction
  ["טיסה לBCN", "ROUTE TLV-BCN 2026-10"],
  ["flights to paris france", "ROUTE TLV-PAR 2026-10"], // a city and its own country: one destination
  ["טיסות לבנגקוק תאילנד", "ROUTE TLV-BKK 2026-10"],
  ["טיסות ליוון אתונה", "ROUTE TLV-ATH 2026-10"],
  ["flights to london heathrow", "ROUTE TLV-LHR 2026-10"], // the most precise name wins
  ["flights from eilat israel to athens", "ROUTE ETM-ATH 2026-10"],
  ["flights tel aviv athens", "ROUTE TLV-ATH 2026-10"], // the Israeli place first: outbound
  ["flights TLV MAD", "ROUTE TLV-MAD 2026-10"], // capitals in a normal query are codes
  ["FLIGHTS TO LHR", "ROUTE TLV-LHR 2026-10"],
  ["טיסה לקניה", "ROUTE TLV-NBO 2026-10"],
  ["טיסות מאילת לקניה", "ROUTE ETM-NBO 2026-10"], // a weak name right after another place still counts
  ["flights to jordan", "ROUTE TLV-AMM 2026-10"],
  ["flights to washington", "ROUTE TLV-WAS 2026-10"],
  ["טיסות לדוחה", "ROUTE TLV-DOH 2026-10"],
  ["טיסה לסופיה", "ROUTE TLV-SOF 2026-10"],
  ["טיסות באלי", "ROUTE TLV-DPS 2026-10"],
  ["flights to south africa", "ROUTE TLV-CPT 2026-10"], // a country whose name starts with a region word
  ["טיסות לניו דלהי", "ROUTE TLV-DEL 2026-10"],
  ["טיסות לצפון מקדוניה", "ROUTE TLV-SKP 2026-10"],
  ["הדרך הכי זולה לטוס לאתונה", "ROUTE TLV-ATH 2026-10"], // "הדרך" (the way) is not "דרך" (via) before a place
  // spellings people type (extension-only aliases, scripts/gen-index.mjs EXTRA_CITY_NAMES / EXTRA_HEBREW)
  ["טיסות לוורשה", "ROUTE TLV-WAW 2026-10"],
  ["טיסות לווגאס", "ROUTE TLV-LAS 2026-10"],
  ["flights to vegas", "ROUTE TLV-LAS 2026-10"],
  ["flights to nyc", "ROUTE TLV-NYC 2026-10"],
  ["טיסות לבודאפשט", "ROUTE TLV-BUD 2026-10"],
  ["טיסות לאמסטרדאם", "ROUTE TLV-AMS 2026-10"],
  ["טיסות לאבודאבי", "ROUTE TLV-AUH 2026-10"],
  ["טיסות לויאטנם", "ROUTE TLV-HAN 2026-10"],
  ["טיסות לטאילנד", "ROUTE TLV-BKK 2026-10"],
  // when
  ["טיסה １０/１１ לאתונה", "ROUTE TLV-ATH 2026-11 2026-11-10"], // full-width digits
  ["טיסות לאתונה בקיץ", "ROUTE TLV-ATH 2027-06"],
  ["flights to athens in the summer", "ROUTE TLV-ATH 2027-06"],
  ["טיסה לרומא מה-5 עד ה-12 בנובמבר", "ROUTE TLV-ROM 2026-11 2026-11-05 2026-11-12"],
  ["flights to rome between 5 and 12 november", "ROUTE TLV-ROM 2026-11 2026-11-05 2026-11-12"],
  ["טיסה לרומא בנוב'", "ROUTE TLV-ROM 2026-11"],
  ["flights to rome 2026/11/10", "ROUTE TLV-ROM 2026-11 2026-11-10"],
  ["טיסה לרומא בעוד חודשיים", "ROUTE TLV-ROM 2026-11"],
  ["טיסות לתאילנד ב-3.5 אלף", "ROUTE TLV-BKK 2026-10"], // an amount, not the 3rd of May
  ["flights to athens under 1.5k", "ROUTE TLV-ATH 2026-10"],
  ["טיסות לאתונה עד 2030 שקל", "ROUTE TLV-ATH 2026-10"], // a budget, not a year
  ["טיסות לאתונה 2026", "ROUTE TLV-ATH 2026-10"],
  // explore
  ["where to fly in december", "EXPLORE TLV 2026-12"],
  ["cheap flights 24/7", "EXPLORE TLV 2026-10"], // "24/7" is not the 24th of July
  ["טיסות זולות היום", "EXPLORE TLV 2026-09"], // a cue word: fares, not the departures board
  ["cheap flights from israel", "EXPLORE TLV 2026-10"],
  ["cheap international flights", "EXPLORE TLV 2026-10"],
  ["טיסות זולות במיוחד", "EXPLORE TLV 2026-10"],
  ["טיסות מאילת", "EXPLORE ETM 2026-10"],
];

describe("flight intent: positives", () => {
  for (const [q, expected] of POSITIVE) {
    it(`"${q}" -> ${expected}`, () => assert.equal(summary(analyze(/** @type {string} */ (q))), expected));
  }
});

describe("review regressions: silence", () => {
  for (const q of REVIEW_NEGATIVE) {
    it(`"${q}" -> nothing`, () => assert.equal(summary(analyze(q)), "null"));
  }
});

describe("review regressions: the right lookup", () => {
  for (const [q, expected] of REVIEW_POSITIVE) {
    it(`"${q}" -> ${expected}`, () => assert.equal(summary(analyze(/** @type {string} */ (q))), expected));
  }
});

describe("flight intent: never for non-flight or unsupported queries", () => {
  for (const q of NEGATIVE) {
    it(`"${q}" -> nothing`, () => assert.equal(summary(analyze(q)), "null"));
  }
});

describe("intent coverage", () => {
  it("has at least 40 intent cases, adversarial ones included", () => {
    assert.ok(POSITIVE.length + NEGATIVE.length >= 40);
    assert.ok(NEGATIVE.length >= 40);
  });

  it("the cheap pre-check (no index) agrees on intent and negatives", () => {
    const Q = EEE.query;
    assert.equal(Q.mightBeFlightSearch("טיסות לאתונה"), true);
    assert.equal(Q.mightBeFlightSearch("flights to athens"), true);
    assert.equal(Q.mightBeFlightSearch("אתונה"), false);
    assert.equal(Q.mightBeFlightSearch("מזג אוויר ביוון"), false);
    assert.equal(Q.mightBeFlightSearch("טיסה 5 סרט"), false);
    assert.equal(Q.mightBeFlightSearch("flight simulator"), false);
    assert.equal(Q.mightBeFlightSearch("x".repeat(500) + " flights"), false);
    assert.equal(Q.mightBeFlightSearch(/** @type {any} */ (null)), false);
    assert.equal(Q.mightBeFlightSearch("ראש הממשלה טס לוושינגטון"), false); // "טס" is not a flight word
    assert.equal(Q.mightBeFlightSearch("אל על ביטלה טיסות לאתונה"), false);
    assert.equal(Q.mightBeFlightSearch("ｆｌｉｇｈｔｓ ｔｏ ａｔｈｅｎｓ"), true); // full-width letters fold like analyze does
  });

  it("the cheap pre-check never blocks a query the full reading would answer", () => {
    for (const [q] of [...POSITIVE, ...REVIEW_POSITIVE]) assert.equal(EEE.query.mightBeFlightSearch(q), true, q);
  });

  it("the Hebrew forms about a flight someone already has are not intent words", () => {
    // "בטיסה" / "לטיסה" / "הטיסה שלי": what to pack, a delay, a seat. Not a fare search.
    assert.equal(summary(analyze("מה מותר להכניס בטיסה")), "null");
    assert.equal(summary(analyze("מזוודה לטיסה")), "null");
    assert.equal(summary(analyze("הטיסה שלי")), "null");
  });

  it("niqqud, geresh variants and invisible marks do not change the answer", () => {
    assert.equal(summary(analyze("טִיסָה לְאַתּוּנָה")), "ROUTE TLV-ATH 2026-10");
    assert.equal(summary(analyze("טיסות לצ'כיה")), "ROUTE TLV-PRG 2026-10");
    assert.equal(summary(analyze("טיסות לצ׳כיה")), "ROUTE TLV-PRG 2026-10");
    assert.equal(summary(analyze("טיסות ל\u200Fאתונה")), "ROUTE TLV-ATH 2026-10");
    assert.equal(summary(analyze("טיסות ל־אתונה")), "ROUTE TLV-ATH 2026-10");
    assert.equal(summary(analyze("טיסות לארה״ב")), "ROUTE TLV-NYC 2026-10");
    assert.equal(summary(analyze("טיסות לארה\"ב")), "ROUTE TLV-NYC 2026-10");
  });

  it("a query too long to be a search is ignored", () => {
    assert.equal(summary(analyze(`טיסות לאתונה ${"א".repeat(300)}`)), "null");
  });
});
