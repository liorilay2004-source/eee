import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CardView, PartyCheckResult, SearchRequest } from "../api/contract";
import { AutoCheckView, PartyCheckBox, PartyVerdict } from "../components/PartyCheck";
import { BoardingPass, CompactCard } from "../components/OfferCards";
import { demoResult } from "./demo";
import {
  AUTO_CHECK_LABEL, CHILDREN_TEXT, COMPARE_NOTE, DOWNSIDES, FLIGHT_CAVEAT, MALFORMED_TEXT, PARTY_TITLE, PARTY_TITLE_GROUP, SEPARATE_REMINDER, WHY_TEXT, WHY_TITLE,
  WHY_TITLE_CHILDREN,
  autoCheckAvailable, canAutoCheck, partyBoxView, partyCheckFailureText, partyCheckFailureView, partyCheckRequest, partyInstruction, partyTitle, partyToken,
  readPartyCheckResult, verdictFlightText, verdictLineText, verdictView,
} from "./partycheck";

const demo = demoResult("2026-09-30");
const base: CardView = demo.cards[0];
const SINGLE = "https://www.aviasales.com/search/TLV3010ATH03111?marker=m";
const PARTY = "https://www.aviasales.com/search/TLV3010ATH03112?marker=m";
/** A card token as a newer API sends it when the automatic check can run (the shape only: the worker checks the signature). */
const TOKEN = `v1.1790000000.${"Ab_-".repeat(10)}xyz`;
const request: SearchRequest = { ...demo.request, adults: 2 };

/** A real (non-demo) round-trip card as a newer API sends it for 2 adults when the automatic check can run. */
const card = (over: Partial<CardView> = {}): CardView => ({
  ...base,
  offer: { ...base.offer, deeplink: PARTY, ticketStructure: "roundtrip" },
  partyCheck: { adults: 2, singleLink: SINGLE, partyLink: PARTY, token: TOKEN },
  ...over,
});

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("the 'זוג או בנפרד?' box", () => {
  it("renders for 2+ adults: the one-sentence instruction, both buttons with the right links, why, downsides, the live-price caveat", () => {
    const out = html(<PartyCheckBox card={card()} />);
    expect(out).toContain(PARTY_TITLE);
    expect(out).toContain("<details");
    expect(out).toContain(partyInstruction(2));
    // The owner's sentence, hedged: a cheaper split is never guaranteed.
    expect(partyInstruction(2)).toBe("פתחו את שני הקישורים ובדקו: אם המחיר לנוסע אחד כפול 2 זול מהמחיר לכולם — ייתכן שכדאי להזמין כל נוסע בנפרד.");
    expect(out).toContain("מחיר לנוסע אחד");
    expect(out).toContain("מחיר ל־2 נוסעים");
    expect(out).toContain(`href="${SINGLE.replace("&", "&amp;")}"`);
    expect(out).toContain(`href="${PARTY.replace("&", "&amp;")}"`);
    expect(out).toContain(WHY_TITLE);
    expect(out).toContain(WHY_TEXT);
    for (const d of DOWNSIDES) expect(out).toContain(d);
    expect(out).toContain("מחירים חיים");
    expect(out).toContain('rel="sponsored noopener noreferrer"');
    expect(out).not.toContain(AUTO_CHECK_LABEL); // the API did not say the automatic check can run
  });

  it("says how to compare honestly: the same flight, what the site's price covers, and check again before each booking", () => {
    const out = html(<PartyCheckBox card={card()} />);
    expect(out).toContain(COMPARE_NOTE);
    expect(COMPARE_NOTE).toContain("אותה טיסה");
    expect(COMPARE_NOTE).toContain("לנוסע אחד או לכל הנוסעים");
    expect(COMPARE_NOTE).toContain("בדקו שוב את המחיר לפני ההזמנה הבאה");
    // Never an unhedged promise.
    for (const n of [2, 3, 9]) expect(partyInstruction(n)).toContain("ייתכן שכדאי");
    expect(partyInstruction(2)).not.toMatch(/— כדאי/);
  });

  it("says N for bigger groups: the title is not 'couple', and only ONE traveller needs a separate booking", () => {
    const out = html(<PartyCheckBox card={card({ partyCheck: { adults: 4, singleLink: SINGLE, partyLink: PARTY } })} />);
    expect(out).toContain("מחיר ל־4 נוסעים");
    expect(out).toContain("כפול 4");
    expect(out).toContain(PARTY_TITLE_GROUP);
    expect(out).not.toContain(PARTY_TITLE);
    expect(partyTitle(2)).toBe("זוג או בנפרד?");
    expect(partyTitle(3)).toBe("ביחד או בנפרד?");
    expect(partyInstruction(3)).toBe("פתחו את שני הקישורים ובדקו: אם המחיר לנוסע אחד כפול 3 זול מהמחיר לכולם — ייתכן שכדאי להזמין נוסע אחד בנפרד ואת השאר יחד.");
  });

  it("is hidden for 1 adult (no field) and for an older API; the cards render as before", () => {
    const { partyCheck: _drop, ...old } = card();
    expect(html(<PartyCheckBox card={old as CardView} />)).toBe("");
    expect(html(<PartyCheckBox card={{ ...card(), partyCheck: null }} />)).toBe("");
    const pass = html(<BoardingPass card={old as CardView} request={{ ...request, adults: 1 }} originLabel="תל אביב" destinationLabel="אתונה" />);
    expect(pass).toContain("pass-price");
    expect(pass).not.toContain(PARTY_TITLE);
    const mini = html(<CompactCard card={old as CardView} request={request} originLabel="" destinationLabel="" />);
    expect(mini).not.toContain(PARTY_TITLE);
  });

  it("with children: the explanation only, no links and no automatic check; the 'why' title says what it explains", () => {
    const kids = card({ partyCheck: { adults: 2, reason: "children" } });
    const out = html(<PartyCheckBox card={kids} autoCheck />);
    expect(out).toContain(PARTY_TITLE);
    expect(out).toContain(CHILDREN_TEXT);
    expect(out).not.toContain("<a ");
    expect(out).not.toContain(AUTO_CHECK_LABEL);
    expect(out).toContain(WHY_TEXT);
    // Right after the children rule, "למה זה קורה?" would read as explaining that rule.
    expect(out).toContain(WHY_TITLE_CHILDREN);
    expect(out).not.toContain(`${WHY_TITLE}</summary>`);
    // The rule: an infant always, a child usually; "without a child or an infant"; one "ולכן".
    expect(CHILDREN_TEXT).toContain("בלי ילד או תינוק");
    expect(CHILDREN_TEXT.match(/לכן/g)).toHaveLength(1);
  });

  it("the downsides fit the box: no children item in an adults-only box, and the per-booking fees are there", () => {
    expect(DOWNSIDES.some((d) => d.includes("ילד") || d.includes("תינוק"))).toBe(false);
    expect(DOWNSIDES.some((d) => d.includes("עמלה על כל הזמנה"))).toBe(true);
    const out = html(<PartyCheckBox card={card()} />);
    expect(out).not.toContain("ילדים ותינוקות");
  });

  it("the 'why' text: price levels, not cabin classes, and 'usually'", () => {
    expect(WHY_TEXT).toContain("דרגות מחיר");
    expect(WHY_TEXT).not.toContain("מחלק");
    expect(WHY_TEXT).toContain("בדרך כלל");
    expect(WHY_TEXT).toContain("אף פעם לא מובטח");
  });

  it("shows the automatic-check button only when meta.partyCheck.available is true, on a round trip with links AND its token", () => {
    expect(html(<PartyCheckBox card={card()} autoCheck />)).toContain(AUTO_CHECK_LABEL);
    expect(html(<PartyCheckBox card={card()} autoCheck={false} />)).not.toContain(AUTO_CHECK_LABEL);
    expect(autoCheckAvailable({ partyCheck: { available: true } })).toBe(true);
    expect(autoCheckAvailable({ partyCheck: { available: false } })).toBe(false);
    expect(autoCheckAvailable({})).toBe(false); // an older API
    expect(autoCheckAvailable(undefined)).toBe(false);
    const split = card({
      offer: { ...base.offer, ticketStructure: "split", deeplink: PARTY, returnDeeplink: PARTY },
      partyCheck: { adults: 2, singleLink: SINGLE, partyLink: PARTY, returnSingleLink: SINGLE, returnPartyLink: PARTY },
    });
    expect(canAutoCheck(split, true)).toBe(false);
    expect(html(<PartyCheckBox card={split} autoCheck />)).not.toContain(AUTO_CHECK_LABEL);
    // A card without its token cannot be checked (only a card of a recent search can): no button, the links stay.
    const untokened = card({ partyCheck: { adults: 2, singleLink: SINGLE, partyLink: PARTY } });
    expect(canAutoCheck(untokened, true)).toBe(false);
    const out = html(<PartyCheckBox card={untokened} autoCheck />);
    expect(out).not.toContain(AUTO_CHECK_LABEL);
    expect(out).toContain("מחיר ל־2 נוסעים");
    for (const token of ["", "v1.x.y", 7, `v2.1790000000.${"A".repeat(43)}`]) expect(partyToken({ partyCheck: { adults: 2, singleLink: SINGLE, partyLink: PARTY, token } })).toBeNull();
  });

  it("passes the flag through the cards: the hero and the compact card", () => {
    const pass = html(<BoardingPass card={card()} request={request} originLabel="" destinationLabel="" autoCheck />);
    expect(pass).toContain(PARTY_TITLE);
    expect(pass).toContain(AUTO_CHECK_LABEL);
    const mini = html(<CompactCard card={card()} request={request} originLabel="" destinationLabel="" />);
    expect(mini).toContain(PARTY_TITLE);
    expect(mini).not.toContain(AUTO_CHECK_LABEL);
    // A demo card never shows it, whatever it carries.
    expect(html(<BoardingPass card={card()} request={request} originLabel="" destinationLabel="" demo autoCheck />)).not.toContain(PARTY_TITLE);
  });

  it("a split ticket: both directions, labelled", () => {
    const split = card({
      offer: { ...base.offer, ticketStructure: "split", deeplink: PARTY, returnDeeplink: PARTY },
      partyCheck: { adults: 2, singleLink: SINGLE, partyLink: PARTY, returnSingleLink: SINGLE, returnPartyLink: PARTY },
    });
    const view = partyBoxView(split);
    expect(view).toEqual({ kind: "links", adults: 2, rows: [{ label: "הלוך", single: SINGLE, party: PARTY }, { label: "חזור", single: SINGLE, party: PARTY }] });
    const out = html(<PartyCheckBox card={split} />);
    expect(out).toContain("הלוך");
    expect(out).toContain("חזור");
    // A split without its return pair gets no box (half a comparison would mislead).
    expect(partyBoxView({ ...split, partyCheck: { adults: 2, singleLink: SINGLE, partyLink: PARTY } })).toBeNull();
  });

  it("never turns an untrusted or malformed field into a button", () => {
    for (const partyCheck of [
      { adults: 2, singleLink: "https://evil.example/x", partyLink: PARTY },
      { adults: 2, singleLink: "javascript:alert(1)", partyLink: PARTY },
      { adults: 2, singleLink: SINGLE.replace("https", "http"), partyLink: PARTY },
      { adults: 1, singleLink: SINGLE, partyLink: PARTY },
      { adults: "2", singleLink: SINGLE, partyLink: PARTY },
      { adults: 2 },
      "yes",
      [],
    ]) {
      expect(partyBoxView({ offer: card().offer, partyCheck }), JSON.stringify(partyCheck)).toBeNull();
    }
  });

  it("the check's body is the card's airports and dates with the search's adults, and the card's token", () => {
    expect(partyCheckRequest(card(), 3)).toEqual({ origin: "TLV", destination: "ATH", departDate: base.offer.departDate, returnDate: base.offer.returnDate, adults: 3, token: TOKEN });
    const { partyCheck: _drop, ...old } = card();
    expect(partyCheckRequest(old, 2)).not.toHaveProperty("token");
  });
});

const result = (over: Partial<PartyCheckResult> = {}): PartyCheckResult => ({
  source: "wego",
  sourceName: "Wego",
  checkedAt: "2026-10-01T09:00:00.000Z",
  adults: 2,
  matchBasis: "same_flight",
  flight: { outboundDepartTime: "07:05", inboundDepartTime: "18:00", airlines: ["LY"] },
  single: { amount: 100, currency: "USD", ils: 350 },
  together: { amount: 260, currency: "USD", ils: 910, perPersonIls: 455 },
  separateEstimateIls: 805,
  savingIls: 105,
  thresholdIls: 27.3,
  verdict: "separate",
  noteHe: "לפי הערכה, הזמנה נפרדת לכל נוסע עשויה לחסוך כ־₪105. זו הערכה בלבד.",
  fx: { date: "2026-10-01", source: "test" },
  ...over,
});

describe("the automatic check's answer", () => {
  it("separate: worded as an estimate, with both prices and the estimate", () => {
    const view = verdictView(result());
    expect(view.title).toContain("הערכה");
    expect(view.tone).toBe("good");
    expect(view.lines.map(verdictLineText)).toEqual([
      "נוסע אחד לבד: ₪350 (100 USD)",
      "שני הנוסעים בהזמנה אחת: ₪910 (260 USD), כ־₪455 לנוסע",
      "הערכה, כל נוסע בהזמנה נפרדת: ₪805",
    ]);
    const out = html(<PartyVerdict result={result()} />);
    expect(out).toContain('<span dir="ltr" class="num">₪805</span>'); // every amount in its own left-to-right span
    expect(out).toContain('<span dir="ltr" class="num">(260 USD)</span>');
    expect(out).toContain("זו הערכה בלבד");
    expect(out).toContain(SEPARATE_REMINDER); // the downsides come with a "separate" answer
    expect(verdictView(result({ verdict: "same", separateEstimateIls: null })).reminder).toBeUndefined();
    // A shekel price has no second figure.
    expect(verdictView(result({ single: { amount: 350, currency: "ILS", ils: 350 } })).lines[0]?.original).toBeNull();
  });

  it("from 3 adults: 'כל 3 הנוסעים', and the estimate is one traveller alone and the others together", () => {
    const view = verdictView(result({ adults: 3, together: { amount: 390, currency: "USD", ils: 1365, perPersonIls: 455 }, separateEstimateIls: 1260 }));
    expect(view.title).toBe("לפי הערכה, כדאי לבדוק הזמנה נפרדת לנוסע אחד");
    expect(view.lines.map((l) => l.label)).toEqual(["נוסע אחד לבד", "כל 3 הנוסעים בהזמנה אחת", "הערכה, נוסע אחד בנפרד והשאר יחד"]);
  });

  it("names the flight it compared, and says it may not be the card's own; airline names come from the card", () => {
    const view = verdictView(result(), { LY: "אל על" });
    expect(view.flight).toEqual({ outbound: "07:05", inbound: "18:00", airlines: "אל על" });
    expect(verdictFlightText(view.flight!)).toBe(`הטיסה שהושוותה: הלוך ב־07:05, חזור ב־18:00, אל על. ${FLIGHT_CAVEAT}`);
    const out = html(<PartyVerdict result={result()} airlineNames={{ LY: "אל על" }} />);
    expect(out).toContain("הטיסה שהושוותה");
    expect(out).toContain('<span dir="ltr" class="num">07:05</span>');
    expect(out).toContain(FLIGHT_CAVEAT);
    // Cheapest against cheapest has no single flight to name.
    expect(verdictView(result({ matchBasis: "cheapest", flight: null, verdict: "together", separateEstimateIls: null })).flight).toBeNull();
  });

  it("the estimate line is shown for 'separate' only (for any other verdict it would be a cost no booking can reach)", () => {
    for (const verdict of ["together", "same"] as const) {
      const view = verdictView(result({ verdict, separateEstimateIls: 850, savingIls: -50 }));
      expect(view.lines.some((l) => l.label.startsWith("הערכה")), verdict).toBe(false);
      expect(html(<PartyVerdict result={result({ verdict, separateEstimateIls: 850 })} />)).not.toContain("₪850");
    }
  });

  it("together, same and unknown: the unknown title is not repeated by its note, and shows no prices it does not have", () => {
    expect(verdictView(result({ verdict: "together", savingIls: -50, separateEstimateIls: null })).title).toBe("עדיף להזמין את כולם יחד");
    expect(verdictView(result({ verdict: "same", savingIls: 3, separateEstimateIls: null })).title).toContain("אין הבדל משמעותי");
    const unknown = verdictView(result({ verdict: "unknown", matchBasis: null, flight: null, single: null, together: null, separateEstimateIls: null, savingIls: null, thresholdIls: null, noteHe: "" }));
    expect(unknown).toMatchObject({ title: "לא הצלחנו להשוות הפעם", tone: "warn", lines: [], flight: null });
    expect(unknown.note).toContain("שני הקישורים");
    expect(unknown.note).not.toContain("לא הצלחנו להשוות");
  });

  it("unknown WITH prices (the lower single price may be on another flight): both prices, no estimate, no saving, no reminder", () => {
    const view = verdictView(result({
      verdict: "unknown", matchBasis: "cheapest", flight: null, separateEstimateIls: null, savingIls: null, thresholdIls: null,
      single: { amount: 400, currency: "ILS", ils: 400 }, together: { amount: 1000, currency: "ILS", ils: 1000, perPersonIls: 500 },
      noteHe: "המחיר הזול ביותר לנוסע אחד נמוך מהמחיר לנוסע בהזמנה המשותפת הזולה ביותר, אבל הם בטיסות שונות.",
    }));
    expect(view.title).toBe("לא ברור אם הזמנה נפרדת תחסוך");
    expect(view.tone).toBe("warn");
    expect(view.lines.map(verdictLineText)).toEqual(["נוסע אחד לבד: ₪400", "שני הנוסעים בהזמנה אחת: ₪1,000, כ־₪500 לנוסע"]);
    expect(view.reminder).toBeUndefined();
    expect(view.note).toContain("בטיסות שונות");
  });

  it("a malformed answer shows no half-read numbers: never 'undefined' or 'מחיר לא זמין'", () => {
    const broken: unknown[] = [
      null,
      "oops",
      { ...result(), adults: undefined },
      { ...result(), adults: "2" },
      { ...result(), verdict: "maybe" },
      { ...result(), single: { amount: "100", currency: "USD", ils: 350 } },
      { ...result(), together: { amount: 260, currency: "usd", ils: 910, perPersonIls: 455 } },
      { ...result(), together: { amount: 260, currency: "USD", ils: 910, perPersonIls: "455" } },
      { ...result(), separateEstimateIls: null }, // "separate" without its estimate
      { ...result(), verdict: "together", single: null },
      { ...result(), flight: { outboundDepartTime: "7am", inboundDepartTime: null, airlines: [] } },
      { ...result(), noteHe: 5 },
    ];
    for (const raw of broken) {
      expect(readPartyCheckResult(raw), JSON.stringify(raw)).toBeNull();
      const view = verdictView(raw);
      expect(view).toMatchObject({ title: "לא הצלחנו להשוות הפעם", lines: [], flight: null });
      const out = html(<PartyVerdict result={raw as PartyCheckResult} />);
      expect(out).not.toContain("undefined");
      expect(out).not.toContain("מחיר לא זמין");
    }
    expect(readPartyCheckResult(result())).toEqual(result());
    expect(MALFORMED_TEXT).toContain("שני הקישורים");
  });

  it("the button's states: one button throughout, aria-disabled (never disabled, which drops focus), and no second paid check", () => {
    const idle = html(<AutoCheckView state={{ status: "idle" }} />);
    expect(idle).toContain(AUTO_CHECK_LABEL);
    expect(idle).not.toContain("aria-disabled");
    // The live region is there before anything lands in it, so what lands is announced.
    expect(idle).toContain('aria-live="polite"');
    const busy = html(<AutoCheckView state={{ status: "loading" }} />);
    expect(busy).toContain('aria-disabled="true"');
    expect(busy).not.toMatch(/\sdisabled=""/);
    expect(busy).toContain("בודקים עכשיו");
    const done = html(<AutoCheckView state={{ status: "done", result: result() }} />);
    expect(done).toContain("₪910");
    expect(done).toContain('aria-disabled="true"'); // the answer is on screen: another click would spend two more searches
    expect(done).toContain("הבדיקה הושלמה");
    expect(done).not.toContain(AUTO_CHECK_LABEL);
    const retry = html(<AutoCheckView state={{ status: "error", text: "שגיאה לדוגמה", retry: true }} />);
    expect(retry).toContain("שגיאה לדוגמה");
    expect(retry).not.toContain("aria-disabled");
    expect(retry).toContain("נסו שוב");
    const closed = html(<AutoCheckView state={{ status: "error", text: "נגמר", retry: false }} />);
    expect(closed).toContain('aria-disabled="true"');
    expect(html(<AutoCheckView state={{ status: "error", text: "שגיאה לדוגמה" }} />)).not.toContain("aria-disabled");
  });

  it("the stylesheet never hides the live region (a hidden region may not be announced)", async () => {
    // Read from disk: vitest hands CSS imports (even ?raw) to its CSS pipeline, which is off here and yields "". The app's
    // tsconfig has no Node types, hence the untyped dynamic import (the test environment is Node).
    const fsName = "node:fs";
    const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (path: URL, encoding: "utf8") => string };
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    expect(css).toContain(".party-auto-out");
    expect(css).not.toMatch(/\.party-auto-out:empty\s*\{[^}]*display:\s*none/);
    expect(css).not.toMatch(/\.party-auto-out\s*\{[^}]*display:\s*none/);
  });

  it("404, 429 and 503 are explained in Hebrew by their actual cause, and the manual links are always offered", () => {
    const http = (status: number, code: string, retryAfterSec: number | null = null) => ({ type: "http" as const, status, code, retryAfterSec, fields: {} });
    expect(partyCheckFailureText(http(404, "unavailable"))).toContain("לא זמינה כרגע");
    expect(partyCheckFailureText(http(404, "not_found"))).toContain("לא זמינה כרגע"); // an older API without the route
    expect(partyCheckFailureText(http(429, "rate_limited", 300))).toContain("כ־5 דקות");
    expect(partyCheckFailureText(http(503, "daily_limit", 3600))).toContain("להיום נגמרו");
    // A spent cap is not "today's": a monthly one comes back next month, a one-off one never.
    expect(partyCheckFailureText(http(503, "quota_exhausted"))).toContain("המכסה החינמית של מקור המחירים נגמרה");
    expect(partyCheckFailureText(http(503, "quota_exhausted"))).not.toContain("להיום");
    expect(partyCheckFailureText(http(503, "upstream_unavailable"))).toContain("לא ענה");
    // Nothing was asked of the price source: never blame it.
    for (const code of ["fx_unavailable", "storage_unavailable"]) {
      expect(partyCheckFailureText(http(503, code))).toContain("תקלה אצלנו");
      expect(partyCheckFailureText(http(503, code))).not.toContain("מקור המחירים לא ענה");
    }
    expect(partyCheckFailureText(http(400, "offer_expired"))).toContain("חפשו שוב");
    expect(partyCheckFailureText(http(500, "internal_error"))).toContain("השתבש");
    expect(partyCheckFailureText({ type: "offline" })).toContain("אין חיבור");
    for (const status of [404, 503, 400, 500]) expect(partyCheckFailureText(http(status, "x"))).toContain("שני הקישורים");
    // Whether trying again can help now (else the button stays off).
    expect(partyCheckFailureView(http(404, "unavailable")).retry).toBe(false);
    expect(partyCheckFailureView(http(503, "daily_limit")).retry).toBe(false);
    expect(partyCheckFailureView(http(503, "quota_exhausted")).retry).toBe(false);
    expect(partyCheckFailureView(http(400, "invalid_token")).retry).toBe(false);
    expect(partyCheckFailureView(http(429, "rate_limited", 60)).retry).toBe(true);
    expect(partyCheckFailureView(http(503, "upstream_unavailable")).retry).toBe(true);
    expect(partyCheckFailureView({ type: "network" }).retry).toBe(true);
  });
});
