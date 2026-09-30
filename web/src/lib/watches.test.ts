import { describe, expect, it } from "vitest";
import { toApiFailure } from "./failure";
import {
  DEFAULT_DROP_PCT, WATCH_STORAGE_KEY, addStoredWatch, describeCreateWatchFailure, describeWatchDeleteFailure, describeWatchLookupFailure, isWatchToken,
  loadStoredWatches, neighbourToken,
  parseAlertRules, removeStoredWatch, rulesSummary, safeTelegramLink,
} from "./watches";

class MemoryStore {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

class BrokenStore {
  getItem(): string | null { throw new Error("SecurityError"); }
  setItem(): void { throw new Error("QuotaExceededError"); }
  removeItem(): void { throw new Error("SecurityError"); }
}

const TOKEN_A = "A".repeat(43);
const TOKEN_B = "b_-".repeat(14) + "c";

describe("watch token storage", () => {
  it("keeps valid tokens only, newest first, without duplicates", () => {
    const store = new MemoryStore();
    expect(isWatchToken(TOKEN_B)).toBe(true);
    expect(addStoredWatch({ token: TOKEN_A, savedAt: "2026-09-30T10:00:00Z", label: "תל אביב – אתונה" }, store)).toBe(true);
    expect(addStoredWatch({ token: TOKEN_B, savedAt: "2026-09-30T11:00:00Z", label: "תל אביב – רומא" }, store)).toBe(true);
    expect(addStoredWatch({ token: TOKEN_A, savedAt: "2026-09-30T12:00:00Z", label: "תל אביב – אתונה" }, store)).toBe(true);
    expect(loadStoredWatches(store).map((w) => w.token)).toEqual([TOKEN_A, TOKEN_B]);
    expect(addStoredWatch({ token: "short", savedAt: "", label: "" }, store)).toBe(false);
  });

  it("drops damaged entries and survives garbage", () => {
    const store = new MemoryStore();
    store.setItem(WATCH_STORAGE_KEY, JSON.stringify([{ token: TOKEN_A, savedAt: "nope", label: 5 }, { token: "<script>" }, "x", null]));
    expect(loadStoredWatches(store)).toEqual([{ token: TOKEN_A, savedAt: "1970-01-01T00:00:00.000Z", label: "" }]);
    store.setItem(WATCH_STORAGE_KEY, "{not json");
    expect(loadStoredWatches(store)).toEqual([]);
  });

  it("removes one token and clears the key when none are left", () => {
    const store = new MemoryStore();
    addStoredWatch({ token: TOKEN_A, savedAt: "2026-09-30T10:00:00Z", label: "" }, store);
    addStoredWatch({ token: TOKEN_B, savedAt: "2026-09-30T10:00:00Z", label: "" }, store);
    expect(removeStoredWatch(TOKEN_A, store).map((w) => w.token)).toEqual([TOKEN_B]);
    removeStoredWatch(TOKEN_B, store);
    expect(store.getItem(WATCH_STORAGE_KEY)).toBeNull();
  });

  it("never throws when storage is blocked or missing", () => {
    const broken = new BrokenStore();
    expect(loadStoredWatches(broken)).toEqual([]);
    expect(addStoredWatch({ token: TOKEN_A, savedAt: "", label: "" }, broken)).toBe(false);
    expect(removeStoredWatch(TOKEN_A, broken)).toEqual([]);
    expect(loadStoredWatches(null)).toEqual([]);
    expect(addStoredWatch({ token: TOKEN_A, savedAt: "", label: "" }, null)).toBe(false);
  });
});

describe("alert rules", () => {
  it("parses an optional whole-party target and drop", () => {
    expect(parseAlertRules("", null)).toEqual({ ok: true, value: {} });
    expect(parseAlertRules(" ₪1,500 ", 10)).toEqual({ ok: true, value: { targetPriceIls: 1500, dropPct: 10 } });
    expect(parseAlertRules("20", null).ok).toBe(false);
    expect(parseAlertRules("1500.5", null).ok).toBe(false);
    expect(parseAlertRules("", 95).ok).toBe(false);
  });

  it("describes what will trigger a message, as the Worker applies the defaults", () => {
    expect(rulesSummary({})).toContain(`${DEFAULT_DROP_PCT}%`);
    expect(rulesSummary({ targetPriceIls: 1500 })).not.toContain("%");
    expect(rulesSummary({ targetPriceIls: 1500, dropPct: 20 })).toContain("₪1,500");
  });

  it("accepts only real t.me start links", () => {
    expect(safeTelegramLink(`https://t.me/EeeFlightsBot?start=${TOKEN_A}`)).toBe(`https://t.me/EeeFlightsBot?start=${TOKEN_A}`);
    expect(safeTelegramLink("https://t.me.evil.example/x?start=a")).toBeNull();
    expect(safeTelegramLink("http://t.me/EeeFlightsBot?start=abc")).toBeNull();
    expect(safeTelegramLink("https://t.me/EeeFlightsBot")).toBeNull();
    expect(safeTelegramLink("javascript:alert(1)")).toBeNull();
  });
});

describe("watch errors", () => {
  const http = (status: number, code: string, fields: Record<string, string> = {}) => toApiFailure({ status, code, fields }, true);

  it("says plainly when the Telegram channel is not configured", () => {
    const notice = describeCreateWatchFailure(http(503, "alerts_unavailable"));
    expect(notice.title).toBe("התראות מחירים עוד לא פעילות");
    expect(notice.body).toContain("לא הוגדר");
    expect(notice.canRetry).toBe(false);
  });

  it("maps limits, bad rules and rate limits", () => {
    expect(describeCreateWatchFailure(http(409, "watch_limit")).title).toContain("3");
    expect(describeCreateWatchFailure(http(400, "invalid_request", { targetPriceIls: "must be between 50 and 200000" })).title).toBe("בדקו את מחיר היעד");
    expect(describeCreateWatchFailure(http(400, "invalid_request", { windowStart: "must not be in the past" })).body).toContain("התאריכים");
    expect(describeCreateWatchFailure(toApiFailure({ status: 429, code: "rate_limited", retryAfterSec: 600 }, true)).retryAfterSec).toBe(600);
  });

  it("treats a 404 lookup as gone from the server", () => {
    expect(describeWatchLookupFailure(http(404, "not_found")).gone).toBe(true);
    expect(describeWatchLookupFailure(http(503, "storage_unavailable")).gone).toBe(false);
  });
});

describe("deleting an alert", () => {
  const http = (status: number, code: string, retryAfterSec?: number) => toApiFailure({ status, code, fields: {}, retryAfterSec }, true);

  it("says the alert was NOT deleted and still sends messages, never lookup copy", () => {
    const notice = describeWatchDeleteFailure(http(503, "storage_unavailable"));
    expect(notice.title).toBe("לא הצלחנו למחוק את ההתראה");
    expect(notice.body).toContain("ההתראה לא נמחקה והיא עדיין קיימת");
    expect(notice.body).toContain("/stop");
    expect(notice.title).not.toContain("לבדוק");
    expect(notice.canRetry).toBe(true);
    expect(notice.gone).toBe(false);
    expect(describeWatchDeleteFailure({ type: "offline" }).body).toContain("אין חיבור");
    expect(describeWatchDeleteFailure(http(429, "rate_limited", 90)).retryAfterSec).toBe(90);
    expect(describeWatchDeleteFailure({ type: "network" }).title).toBe("לא הצלחנו למחוק את ההתראה");
  });

  it("treats 404 as already gone", () => {
    expect(describeWatchDeleteFailure(http(404, "not_found")).gone).toBe(true);
  });

  it("hands focus to the next card, else the previous one, else none", () => {
    const list = [{ token: "a" }, { token: "b" }, { token: "c" }];
    expect(neighbourToken(list, "a")).toBe("b");
    expect(neighbourToken(list, "b")).toBe("c");
    expect(neighbourToken(list, "c")).toBe("b");
    expect(neighbourToken([{ token: "a" }], "a")).toBeNull();
    expect(neighbourToken(list, "zz")).toBeNull();
  });
});
