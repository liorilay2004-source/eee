import { describe, expect, it } from "vitest";
import {
  bagView, clearQuestionErrors, describeFailure, emptySearchCopy, firstErrorQuestion, firstMonthOffset, hasTruncation, inferWhen, isMinimumPrice, mapFieldErrors, monthOptions,
  nextMonthWindow, originalPriceLabel, otherDuration, pairCheck, partyPriceLine, passengersLabel, placeLabel,
  pricePerPerson, priceText, questionForField, questionsTouchedBy, scanGaps, shorterWindow, sourceNote, stayLabel, stayPresetFor,
  STAY_PRESETS, toggleMonth, waitText, whenLabel, widenWindow, windowForMonths, withNearby,
} from "./builder";
import { countValidPairs, emptyForm } from "./search";
import type { SourceStatus } from "../api/contract";

const TODAY = "2026-09-29";

describe("month chips -> window", () => {
  it("skips a nearly finished current month and offers the next six", () => {
    const months = monthOptions(TODAY);
    expect(months.map((m) => m.key)).toEqual(["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]);
    expect(months[0].label).toBe("אוקטובר");
    expect(months[3]).toMatchObject({ label: "ינואר", year: 2027, showYear: true });
    expect(months[0].showYear).toBe(false);
  });

  it("keeps the current month when enough of it is left", () => {
    expect(monthOptions("2026-10-05")[0].key).toBe("2026-10");
    expect(monthOptions("2026-10-25")[0].key).toBe("2026-11");
    expect(monthOptions("2026-10-31")[0].key).toBe("2026-11");
    expect(firstMonthOffset("2026-10-31")).toBe(1);
    expect(firstMonthOffset("2026-10-21")).toBe(0);
    expect(firstMonthOffset("2026-10-22")).toBe(1);
  });

  it("maps one or two consecutive months to a window, clamped to today", () => {
    expect(windowForMonths(["2026-11"], TODAY)).toEqual({ windowStart: "2026-11-01", windowEnd: "2026-11-30" });
    expect(windowForMonths(["2026-12", "2026-11"], TODAY)).toEqual({ windowStart: "2026-11-01", windowEnd: "2026-12-31" });
    expect(windowForMonths(["2026-10"], "2026-10-05")).toEqual({ windowStart: "2026-10-05", windowEnd: "2026-10-31" });
    expect(windowForMonths(["2027-02"], TODAY)).toEqual({ windowStart: "2027-02-01", windowEnd: "2027-02-28" });
    expect(windowForMonths([], TODAY)).toBeNull();
  });

  it("never produces a window longer than 120 days", () => {
    const w = windowForMonths(["2026-11", "2026-12"], TODAY)!;
    expect((Date.parse(w.windowEnd) - Date.parse(w.windowStart)) / 86_400_000).toBeLessThanOrEqual(120);
  });

  it("allows one month or two consecutive months", () => {
    expect(toggleMonth([], "2026-11")).toEqual(["2026-11"]);
    expect(toggleMonth(["2026-11"], "2026-12")).toEqual(["2026-11", "2026-12"]);
    expect(toggleMonth(["2026-11"], "2026-10")).toEqual(["2026-10", "2026-11"]);
    expect(toggleMonth(["2026-12"], "2027-01")).toEqual(["2026-12", "2027-01"]);
    expect(toggleMonth(["2026-11"], "2027-01")).toEqual(["2027-01"]);
    expect(toggleMonth(["2026-11", "2026-12"], "2027-01")).toEqual(["2027-01"]);
    expect(toggleMonth(["2026-11", "2026-12"], "2026-11")).toEqual(["2026-12"]);
    expect(toggleMonth(["2026-11"], "2026-11")).toEqual([]);
  });

  it("offers the coming month as tomorrow + 30 days", () => {
    expect(nextMonthWindow(TODAY)).toEqual({ windowStart: "2026-09-30", windowEnd: "2026-10-29" });
  });

  it("recognises which chip produced a stored window", () => {
    expect(inferWhen("", "", TODAY)).toEqual({ mode: "none" });
    expect(inferWhen("2026-09-30", "2026-10-29", TODAY)).toEqual({ mode: "next30" });
    expect(inferWhen("2026-11-01", "2026-12-31", TODAY)).toEqual({ mode: "months", keys: ["2026-11", "2026-12"] });
    expect(inferWhen("2026-11-03", "2026-11-20", TODAY)).toEqual({ mode: "exact" });
    expect(whenLabel("2026-11-01", "2026-12-31", TODAY)).toBe("נובמבר–דצמבר");
    expect(whenLabel("2026-09-30", "2026-10-29", TODAY)).toBe("בחודש הקרוב");
    expect(whenLabel("2026-11-03", "2026-11-20", TODAY)).toBe("03/11 – 20/11");
  });

  it("prefers the month chip when 'the coming month' is exactly the next 30-day month", () => {
    for (const [today, month, end] of [["2026-10-31", "2026-11", "2026-11-30"], ["2027-03-31", "2027-04", "2027-04-30"], ["2026-05-31", "2026-06", "2026-06-30"], ["2026-08-31", "2026-09", "2026-09-30"]]) {
      const w = windowForMonths([month], today)!;
      expect(w).toEqual({ windowStart: `${month}-01`, windowEnd: end });
      expect(nextMonthWindow(today)).toEqual(w); // the collision this guards against
      expect(inferWhen(w.windowStart, w.windowEnd, today)).toEqual({ mode: "months", keys: [month] });
    }
    expect(whenLabel("2026-11-01", "2026-11-30", "2026-10-31")).toBe("נובמבר");
    // Tapping the neighbouring month now extends to two months instead of replacing the range.
    const choice = inferWhen("2026-11-01", "2026-11-30", "2026-10-31");
    const keys = toggleMonth(choice.mode === "months" ? choice.keys : [], "2026-12");
    expect(windowForMonths(keys, "2026-10-31")).toEqual({ windowStart: "2026-11-01", windowEnd: "2026-12-31" });
  });
});

describe("duration presets", () => {
  it("defines the four presets with the agreed night ranges", () => {
    expect(STAY_PRESETS.map((p) => [p.key, p.min, p.max])).toEqual([
      ["weekend", 2, 3], ["short", 3, 5], ["week", 6, 8], ["twoWeeks", 12, 15],
    ]);
  });

  it("maps a stay range back to its preset or to custom", () => {
    expect(stayPresetFor(6, 8)).toBe("week");
    expect(stayPresetFor(12, 15)).toBe("twoWeeks");
    expect(stayPresetFor(4, 9)).toBe("custom");
    expect(stayLabel(2, 3)).toBe("סופ״ש · 2–3 לילות");
    expect(stayLabel(7, 7)).toBe("7 לילות");
    expect(stayLabel(1, 1)).toBe("לילה אחד");
  });

  it("counts the pairs to be checked and flags more than 400", () => {
    const november = { windowStart: "2026-11-01", windowEnd: "2026-11-30" };
    expect(pairCheck({ ...november, stayMin: 6, stayMax: 8 })).toEqual({ count: countValidPairs("2026-11-01", "2026-11-30", 6, 8), status: "ok" });
    expect(pairCheck({ windowStart: "2026-11-01", windowEnd: "2026-12-31", stayMin: 1, stayMax: 30 }).status).toBe("too_many");
    expect(pairCheck({ windowStart: "2026-11-01", windowEnd: "2026-11-04", stayMin: 6, stayMax: 8 })).toEqual({ count: 0, status: "empty" });
    expect(pairCheck({ windowStart: "", windowEnd: "", stayMin: 6, stayMax: 8 }).status).toBe("none");
  });
});

describe("400 field mapping", () => {
  it("routes every server field to the chip that owns it", () => {
    expect(questionForField("origin")).toBe("from");
    expect(questionForField("destination")).toBe("to");
    expect(questionForField("windowStart")).toBe("when");
    expect(questionForField("windowEnd")).toBe("when");
    expect(questionForField("stayMin")).toBe("stay");
    expect(questionForField("stayMax")).toBe("stay");
    expect(questionForField("adults")).toBe("who");
    expect(questionForField("children")).toBe("who");
    expect(questionForField("infants")).toBe("who");
    for (const other of ["cabin", "checkedBag", "outHours", "retHours", "maxStops", "nearbyAirports", "body", "anything"]) {
      expect(questionForField(other)).toBe("general");
    }
  });

  it("translates server messages into Hebrew and groups them", () => {
    const mapped = mapFieldErrors({
      windowEnd: "too many date combinations (450, max 400): shorten the window or narrow the stay range",
      stayMin: "no trip of this length fits inside the window",
      infants: "at most one infant per adult",
      destination: "must differ from origin",
      body: "must be a JSON object",
      cabin: "only economy fares are available at the moment",
    }, true);
    expect(mapped.byQuestion.when).toContain("צירופי תאריכים");
    expect(mapped.byQuestion.stay).toContain("אין טיול");
    expect(mapped.byQuestion.who).toContain("תינוק");
    expect(mapped.byQuestion.to).toBe("היעד צריך להיות שונה מהמוצא.");
    expect(mapped.general).toHaveLength(2);
    expect(Object.values(mapped.byQuestion).every((m) => !/[a-z]{4,}/i.test(m!))).toBe(true);
    expect(firstErrorQuestion(mapped)).toBe("to");
  });

  it("clears the stale error of the other chip when dates or stay change", () => {
    // "Too many pairs" lives on "when" but is fixed from the "stay" sheet (and "no trip fits" the other way round).
    const errors = mapFieldErrors({ dates: "יותר מדי צירופים", passengers: "עד 9 נוסעים" }, false);
    const fromStay = clearQuestionErrors(errors, questionsTouchedBy(["stayMin"], "stay"));
    expect(fromStay.byQuestion).toEqual({ who: "עד 9 נוסעים" });
    expect([...questionsTouchedBy(["windowEnd"], null)].sort()).toEqual(["stay", "when"]);
    expect([...questionsTouchedBy(["checkedBag"], "who")]).toEqual(["who"]);
    expect([...questionsTouchedBy(["destination", "destinationLabel"], null)]).toEqual(["to"]);
    expect(clearQuestionErrors(errors, questionsTouchedBy(["origin"], null))).toBe(errors);
  });

  it("keeps client (already Hebrew) messages as they are", () => {
    const mapped = mapFieldErrors({ dates: "בחרו מתי טסים.", passengers: "אפשר לחפש עד 9 נוסעים." }, false);
    expect(mapped.byQuestion).toEqual({ when: "בחרו מתי טסים.", who: "אפשר לחפש עד 9 נוסעים." });
    expect(firstErrorQuestion(mapFieldErrors({}, false))).toBeNull();
  });
});

describe("error-state mapping", () => {
  it("uses retryAfterSec only when the server sent it", () => {
    const withWait = describeFailure({ type: "http", status: 429, code: "rate_limited", retryAfterSec: 240 });
    expect(withWait).toMatchObject({ kind: "rate_limited", retryAfterSec: 240 });
    expect(withWait.body).toContain("4 דקות");
    const noWait = describeFailure({ type: "http", status: 429, code: "request_failed" });
    expect(noWait).toMatchObject({ kind: "rate_limited", retryAfterSec: null, body: "נסו שוב בעוד כמה דקות." });
    expect(waitText(30)).toContain("פחות מדקה");
    expect(waitText(60)).toContain("כדקה");
  });

  it("describes an unavailable source neutrally, never as 'not connected'", () => {
    const view = describeFailure({ type: "http", status: 503, code: "source_unavailable" });
    expect(view.kind).toBe("source_unavailable");
    expect(view.title).toBe("מקור המחירים לא זמין כרגע");
    // The live region reads "title. body": the body must not repeat the title.
    expect(view.body).not.toContain(view.title);
    expect(`${view.title}. ${view.body}`).toBe("מקור המחירים לא זמין כרגע. נסו שוב בקרוב. החיפוש שלכם שמור.");
    expect(`${view.title} ${view.body}`).not.toMatch(/חובר|מחובר|Cloudflare|Travelpayouts/);
  });

  it("maps 400 responses to field errors and blocks a blind retry", () => {
    const view = describeFailure({ type: "http", status: 400, code: "invalid_request", fields: { stayMax: "must be at least stayMin", adults: "at most 9 passengers in total" } });
    expect(view.kind).toBe("invalid");
    expect(view.canRetry).toBe(false);
    expect(view.fields.byQuestion.stay).toBeTruthy();
    expect(view.fields.byQuestion.who).toBe("אפשר לחפש עד 9 נוסעים.");
    const bare = describeFailure({ type: "http", status: 400, code: "invalid_json" });
    expect(bare.fields.general).toHaveLength(1);
  });

  it("covers offline, timeout, network, fx and unknown errors", () => {
    expect(describeFailure({ type: "offline" }).kind).toBe("offline");
    expect(describeFailure({ type: "timeout" }).kind).toBe("timeout");
    expect(describeFailure({ type: "network" }).kind).toBe("error");
    expect(describeFailure({ type: "http", status: 503, code: "fx_unavailable" }).title).toContain("לשקלים");
    expect(describeFailure({ type: "http", status: 404, code: "not_found" })).toMatchObject({ kind: "error", canRetry: true });
  });
});

describe("results helpers", () => {
  const source = (error: string | null, ok = true): SourceStatus => ({ name: "travelpayouts", enabled: true, ok, calls: 3, offers: 5, error });

  it("detects truncation notes even when the source is ok", () => {
    expect(hasTruncation([source("truncated: 4 of 30 planned requests skipped (limit 26)")])).toBe(true);
    expect(hasTruncation([source("not searchable at Travelpayouts: VDA-ATH")])).toBe(false);
    expect(hasTruncation([source(null)])).toBe(false);
    expect(sourceNote("truncated: 4 of 30 planned requests skipped").text).toBe("4 מתוך 30 בדיקות מתוכננות לא בוצעו הפעם");
    expect(sourceNote("not searchable at Travelpayouts: VDA-ATH")).toEqual({ text: "מסלולים שהמקור לא תומך בהם:", codes: "VDA-ATH" });
  });

  it("never shows a raw English source note in the Hebrew UI", () => {
    expect(sourceNote("Travelpayouts is not configured").text).toBe("המקור לא זמין כרגע");
    expect(sourceNote("Travelpayouts: too many searches right now").text).toContain("עמוס");
    expect(sourceNote("upstream 502").text).toBe("המקור דיווח על בעיה בבדיקה הזו");
    for (const raw of ["Travelpayouts is not configured", "Travelpayouts: too many searches right now", "upstream 502", "truncated: 4 of 30 planned requests skipped"]) {
      expect(sourceNote(raw).text).not.toMatch(/[A-Za-z]/);
      expect(sourceNote(raw).codes).toBeUndefined();
    }
  });

  it("reports scan gaps: truncation (even with ok:true) and failed enabled sources", () => {
    expect(scanGaps([source("truncated: 4 of 30 planned requests skipped")])).toEqual({ truncated: true, failed: false });
    expect(scanGaps([source("upstream 502", false)])).toEqual({ truncated: false, failed: true });
    expect(scanGaps([source(null), { ...source("not configured", false), name: "ignav", enabled: false }])).toEqual({ truncated: false, failed: false });
  });

  it("shows the server's storage allowance retry without suggesting different dates", () => {
    const view = describeFailure({ type: "http", status: 503, code: "storage_daily_limit", retryAfterSec: 120 });
    expect(view.kind).toBe("source_unavailable");
    expect(view.retryAfterSec).toBe(120);
    expect(view.body).toContain("2 דקות");
    expect(view.body).toContain("התאריכים שבחרתם שמורים");
  });

  it("explains exhausted daily live search instead of promising a retry in minutes", () => {
    const sources = [source(null), { ...source("SerpApi: today's share of the free quota used up", false), name: "serpapi" }];
    const copy = emptySearchCopy(sources);
    expect(copy.body).toContain("מכסה מתחדשת בחצות UTC");
    expect(copy.body).toContain("התאריכים שבחרתם נשמרו ללא שינוי");
    expect(copy.body).not.toContain("כמה דקות");
    expect(sourceNote(sources[1].error!).text).toContain("המכסה היומית");
    expect(copy.body).toContain("או שלא ניתן לבדוק אותה כרגע");
  });

  it("does not claim absent flights or blame unavailable sources for an empty result", () => {
    const copy = emptySearchCopy([source(null), { ...source("not configured", false), enabled: false }]);
    expect(copy.title).toBe("לא נמצא מחיר לתאריכים שבחרתם");
    expect(copy.body).toContain("זה לא אומר שאין טיסות");
    expect(emptySearchCopy([source("upstream 502", false)]).title).toBe("בדיקת המחירים לא הושלמה");
  });

  it("computes an average per-person price", () => {
    expect(pricePerPerson(2001, 2)).toBe(1001);
    expect(pricePerPerson(null, 2)).toBeNull();
    expect(pricePerPerson(900, 0)).toBeNull();
    expect(passengersLabel(2, 1, 1)).toBe("2 מבוגרים, ילד אחד, תינוק אחד");
    expect(passengersLabel(1, 0, 0)).toBe("מבוגר אחד");
  });

  it("labels places by choice, known city, or code", () => {
    expect(placeLabel("ATH", "")).toBe("אתונה");
    expect(placeLabel("XYZ", "")).toBe("XYZ");
    expect(placeLabel("LCA", "לרנקה")).toBe("לרנקה");
  });
});

describe("price and bag copy", () => {
  const offer = (tags: string[], extras: number, checkedBag?: boolean) => ({ tags, extrasAmountIls: extras, includes: checkedBag === undefined ? {} : { checkedBag } });
  const withBag = { checkedBag: true };
  const noBag = { checkedBag: false };

  it("says when a known bag fee is inside the price and the rest is not", () => {
    const partial = bagView(offer(["bag_fee_unknown"], 450), withBag);
    expect(partial.tone).toBe("warn");
    expect(partial.text).toContain("₪450");
    expect(partial.text).toContain("כולל הערכה");
    expect(partial.text).toContain("לא כלולה");
    const none = bagView(offer(["bag_fee_unknown"], 0), withBag);
    expect(none.text).toBe("עלות המזוודה לא ידועה לטיסות האלה, והיא לא כלולה במחיר");
    expect(bagView(offer([], 300), withBag)).toMatchObject({ text: "כולל הערכה של ₪300 למזוודות", tone: "plain" });
  });

  it("says an included bag is included, with or without a requested bag", () => {
    expect(bagView(offer([], 0, true), withBag)).toMatchObject({ text: "מזוודה נגררת כלולה במחיר", tone: "good" });
    expect(bagView(offer(["bonus_checked_bag"], 0, true), noBag)).toMatchObject({ tone: "good" });
    expect(bagView(offer([], 0), noBag).text).toBe("המחיר בלי מזוודה נגררת");
    expect(bagView(offer([], 0), withBag).tone).toBe("warn");
  });

  it("marks a minimum price everywhere it is shown, per person included", () => {
    expect(isMinimumPrice({ tags: ["bag_fee_unknown"] }, withBag)).toBe(true);
    expect(isMinimumPrice({ tags: ["bag_fee_unknown"] }, noBag)).toBe(false);
    expect(priceText(3000, true)).toBe("לפחות ₪3,000");
    expect(priceText(3000, false)).toBe("₪3,000");
    expect(priceText(null, true)).toBe("מחיר לא זמין");
    expect(partyPriceLine(3000, 3, true)).toBe("לכל 3 הנוסעים · לפחות ₪1,000 לנוסע");
    expect(partyPriceLine(3300, 3, false)).toBe("לכל 3 הנוסעים · כ־₪1,100 לנוסע");
    expect(partyPriceLine(null, 3, false)).toBe("לכל 3 הנוסעים");
    expect(partyPriceLine(900, 1, false)).toBe("לנוסע אחד, הלוך וחזור");
  });

  it("labels the original fare as bag-free when bag fees were added", () => {
    expect(originalPriceLabel(0)).toBe("המחיר המקורי");
    expect(originalPriceLabel(450)).toBe("מחיר הכרטיס המקורי (בלי מזוודות)");
  });
});

describe("empty-state suggestions", () => {
  const base = { ...emptyForm(), destination: "ATH", windowStart: "2026-11-01", windowEnd: "2026-11-30", stayMin: 6, stayMax: 8 };

  it("widens the window without breaking the 120-day and 400-pair limits", () => {
    const wider = widenWindow(base)!;
    expect(wider.windowEnd > base.windowEnd).toBe(true);
    expect(countValidPairs(wider.windowStart, wider.windowEnd, wider.stayMin, wider.stayMax)).toBeLessThanOrEqual(400);
    expect(widenWindow({ ...base, windowEnd: "2027-03-01" })).toBeNull();
  });

  it("offers nearby airports only when not already on", () => {
    expect(withNearby(base)?.nearbyAirports).toBe(true);
    expect(withNearby({ ...base, nearbyAirports: true })).toBeNull();
  });

  it("suggests a shorter window after truncation, still able to fit the stay", () => {
    const wide = { ...base, windowStart: "2026-11-01", windowEnd: "2027-01-31" };
    const shorter = shorterWindow(wide)!;
    expect(shorter.windowStart).toBe(wide.windowStart);
    expect(shorter.windowEnd < wide.windowEnd).toBe(true);
    expect(countValidPairs(shorter.windowStart, shorter.windowEnd, shorter.stayMin, shorter.stayMax))
      .toBeLessThan(countValidPairs(wide.windowStart, wide.windowEnd, wide.stayMin, wide.stayMax));
    expect(countValidPairs(shorter.windowStart, shorter.windowEnd, shorter.stayMin, shorter.stayMax)).toBeGreaterThan(0);
    expect(shorterWindow({ ...base, windowEnd: "2026-11-12" })).toBeNull(); // already about as short as the stay allows
  });

  it("loosens the stay range within the limits", () => {
    const other = otherDuration(base)!;
    expect([other.stayMin, other.stayMax]).toEqual([5, 10]);
    expect(countValidPairs(other.windowStart, other.windowEnd, other.stayMin, other.stayMax)).toBeLessThanOrEqual(400);
  });
});
