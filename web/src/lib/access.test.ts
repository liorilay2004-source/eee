import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_CHECK_TIMEOUT_MS, RequestError, checkAccess, createWatch, deleteWatch, fetchCalendar, fetchDeals, fetchExplore, findAirports, getWatch, searchFlights,
} from "../api/client";
import type { SearchRequest } from "../api/contract";
import {
  gateReducer, initialGate, initialLockForm, isFieldError, lockFormReducer, lockMessageText, lockScreenMode, logout, startupCheck, submitKey,
  type GateEvent, type GateState, type LockMessage,
} from "./access";
import {
  ACCESS_KEY_STORAGE, clearAccessKey, getAccessKey, hasAccessKey, isAccessKeyFormat, onAccessEvent, setAccessKey, subscribeAccessKey, type AccessEvent,
} from "./access-key";

const KEY = "Zq9vN3tXk2pL8sR4wY7eB1cD5fG0hJ6m";
const OTHER_KEY = "Other-key_0123456789-abcdefghij";
const PAGE_ORIGIN = "https://eee-web-bly.pages.dev";

class MemoryStore {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

/** setItem refuses (Safari private mode, a full quota); reading still works. */
class FullStore extends MemoryStore {
  override setItem(): void { throw new DOMException("full", "QuotaExceededError"); }
}

class BrokenStore {
  getItem(): string | null { throw new DOMException("denied", "SecurityError"); }
  setItem(): void { throw new DOMException("denied", "SecurityError"); }
  removeItem(): void { throw new DOMException("denied", "SecurityError"); }
}

interface Sent { url: string; method: string; authorization: string | null; body: string | null }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let store: MemoryStore;
let sent: Sent[];
let events: AccessEvent[];
let stopEvents: () => void;

/** Stubs fetch: `answer` gets each request (after it is recorded) and returns the response. */
function stubFetch(answer: (url: URL, n: number) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    sent.push({
      url: url.toString(),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("Authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return answer(url, sent.length);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const signal = () => new AbortController().signal;
const SEARCH: SearchRequest = {
  origin: "TLV", destination: "ATH", windowStart: "2026-11-10", windowEnd: "2026-11-20", stayMin: 3, stayMax: 5, adults: 1, children: 0, infants: 0,
  cabin: "economy", checkedBag: false, outHours: null, retHours: null, maxStops: null, nearbyAirports: false,
};

beforeEach(() => {
  store = new MemoryStore();
  sent = [];
  events = [];
  vi.stubGlobal("localStorage", store);
  vi.stubGlobal("location", { origin: PAGE_ORIGIN });
  clearAccessKey();
  stopEvents = onAccessEvent((e) => events.push(e));
});

afterEach(() => {
  stopEvents();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- storage -----------------------------------------------------------------------------------------------

describe("the key on this device", () => {
  it("lives in localStorage under eee.accessKey, and logout-style clearing removes it", () => {
    expect(ACCESS_KEY_STORAGE).toBe("eee.accessKey");
    expect(getAccessKey()).toBeNull();
    setAccessKey(KEY);
    expect(store.getItem("eee.accessKey")).toBe(KEY);
    expect(getAccessKey()).toBe(KEY);
    expect(hasAccessKey()).toBe(true);
    clearAccessKey();
    expect(store.getItem("eee.accessKey")).toBeNull();
    expect(getAccessKey()).toBeNull();
  });

  it("blocked storage: kept in memory for this page only", () => {
    vi.stubGlobal("localStorage", new BrokenStore());
    setAccessKey(KEY);
    expect(getAccessKey()).toBe(KEY);
    clearAccessKey();
    expect(getAccessKey()).toBeNull();
  });

  it("storage whose very access throws (blocked site data): memory too", () => {
    vi.stubGlobal("localStorage", undefined);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } });
    try {
      expect(getAccessKey()).toBeNull();
      setAccessKey(KEY);
      expect(getAccessKey()).toBe(KEY);
      clearAccessKey();
      expect(getAccessKey()).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    }
  });

  it("a full storage never brings back an older stored key", () => {
    const full = new FullStore();
    full.data.set(ACCESS_KEY_STORAGE, OTHER_KEY);
    vi.stubGlobal("localStorage", full);
    setAccessKey(KEY);
    expect(getAccessKey()).toBe(KEY);
    expect(full.getItem(ACCESS_KEY_STORAGE)).toBeNull();
  });

  it("a damaged stored value is no key", () => {
    for (const bad of ["", "has a space", "מפתח", "x".repeat(257), "too-short-19-chars-"]) {
      store.setItem(ACCESS_KEY_STORAGE, bad);
      expect(getAccessKey(), bad.slice(0, 10)).toBeNull();
    }
  });

  it("isAccessKeyFormat: 20-256 visible ASCII characters, no spaces (the Worker's own limits)", () => {
    expect(isAccessKeyFormat(KEY)).toBe(true);
    expect(isAccessKeyFormat("~".repeat(256))).toBe(true);
    expect(isAccessKeyFormat("x".repeat(20))).toBe(true);
    for (const bad of ["", " ", "a b", "x".repeat(19), "short", "x".repeat(257), "מפתח", "tab\there", `${"x".repeat(20)} y`, null, 5]) {
      expect(isAccessKeyFormat(bad), String(bad)).toBe(false);
    }
  });

  it("tells subscribers when the key changes", () => {
    const seen = vi.fn();
    const stop = subscribeAccessKey(seen);
    setAccessKey(KEY);
    clearAccessKey();
    expect(seen).toHaveBeenCalledTimes(2);
    stop();
    setAccessKey(KEY);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

// --- the client -------------------------------------------------------------------------------------------

/** Calls every API function once. */
async function callEverything() {
  await findAirports("תל", signal());
  await searchFlights(SEARCH, signal());
  await fetchExplore({ origin: "TLV", month: "2026-11" }, signal());
  await fetchCalendar({ origin: "TLV", destination: "ATH", month: "2026-11" }, signal());
  await fetchDeals(signal());
  await createWatch({ ...SEARCH, targetPriceIls: 1500 }, signal());
  await getWatch("A".repeat(43), signal());
  await deleteWatch("A".repeat(43), signal());
}

describe("every API call carries the stored key in the Authorization header, and only there", () => {
  it("with a key: `Bearer <key>` on every call, and the key in no URL", async () => {
    stubFetch(() => json({ deleted: true }));
    setAccessKey(KEY);
    await callEverything();
    expect(sent).toHaveLength(8);
    for (const s of sent) {
      expect(s.authorization, s.url).toBe(`Bearer ${KEY}`);
      expect(s.url, s.url).not.toContain(KEY);
      expect(decodeURIComponent(s.url)).not.toContain(KEY);
      expect(s.body ?? "").not.toContain(KEY);
      expect(s.url.startsWith(`${PAGE_ORIGIN}/api/`)).toBe(true);
    }
    expect(sent.map((s) => s.method)).toEqual(["GET", "POST", "GET", "GET", "GET", "POST", "GET", "DELETE"]);
  });

  it("without a key: no Authorization header at all (requests stay as they were before the lock)", async () => {
    stubFetch(() => json({ deleted: true }));
    await callEverything();
    expect(sent).toHaveLength(8);
    for (const s of sent) expect(s.authorization, s.url).toBeNull();
  });

  it("the auth check sends the key only in the header too", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    await checkAccess(KEY);
    await checkAccess(null);
    expect(sent.map((s) => [s.url, s.authorization])).toEqual([
      [`${PAGE_ORIGIN}/api/auth/check`, `Bearer ${KEY}`],
      [`${PAGE_ORIGIN}/api/auth/check`, null],
    ]);
  });
});

describe("a call that meets the lock", () => {
  it("401: the stored key is cleared and the app is told to show the lock screen", async () => {
    stubFetch(() => json({ error: { code: "unauthorized", message: "Access key required" } }, 401));
    setAccessKey(KEY);
    const error = await fetchDeals(signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ status: 401, code: "unauthorized" });
    expect(getAccessKey()).toBeNull();
    expect(store.getItem(ACCESS_KEY_STORAGE)).toBeNull();
    expect(events).toEqual([{ type: "lock", reason: { kind: "unauthorized", hadKey: true } }]);
    // the key saved here was refused: not "wrong" (nothing was typed) but out of date
    expect(gateReducer({ view: "app", generation: 0 }, events[0] as AccessEvent & { type: "lock" })).toEqual({ view: "locked", message: { kind: "stale_key" } });
  });

  it("401 without a stored key: the lock screen, with no error message", async () => {
    stubFetch(() => json({ error: { code: "unauthorized", message: "Access key required" } }, 401));
    await expect(fetchExplore({}, signal())).rejects.toMatchObject({ status: 401 });
    expect(events).toEqual([{ type: "lock", reason: { kind: "unauthorized", hadKey: false } }]);
    expect(gateReducer({ view: "app", generation: 0 }, events[0] as AccessEvent & { type: "lock" })).toEqual({ view: "locked", message: null });
  });

  it("401 with an unreadable body still locks", async () => {
    stubFetch(() => new Response("nope", { status: 401 }));
    setAccessKey(KEY);
    await expect(searchFlights(SEARCH, signal())).rejects.toMatchObject({ status: 401 });
    expect(getAccessKey()).toBeNull();
    expect(events).toHaveLength(1);
  });

  it("an old 401 for a key that was replaced meanwhile changes nothing", async () => {
    setAccessKey(OTHER_KEY);
    stubFetch(() => {
      setAccessKey(KEY); // the user logged in again while the request was out
      return json({ error: { code: "unauthorized", message: "Access key required" } }, 401);
    });
    await expect(fetchDeals(signal())).rejects.toMatchObject({ status: 401 });
    expect(getAccessKey()).toBe(KEY);
    expect(events).toEqual([]);
  });

  it("429 too_many_attempts: the wait, and the key is kept", async () => {
    stubFetch(() => json({ error: { code: "too_many_attempts", message: "x", retryAfterSec: 480 } }, 429, { "Retry-After": "480" }));
    setAccessKey(KEY);
    await expect(fetchDeals(signal())).rejects.toMatchObject({ status: 429, code: "too_many_attempts", retryAfterSec: 480 });
    expect(getAccessKey()).toBe(KEY);
    expect(events).toEqual([{ type: "lock", reason: { kind: "too_many_attempts", retryAfterSec: 480 } }]);
    const locked = gateReducer({ view: "app", generation: 0 }, events[0] as AccessEvent & { type: "lock" });
    expect(locked.view === "locked" && locked.message && lockMessageText(locked.message)).toBe("יותר מדי ניסיונות, נסו שוב בעוד 8 דקות");
  });

  it("the search's own 429 (rate_limited) is the page's business, not the lock's", async () => {
    stubFetch(() => json({ error: { code: "rate_limited", message: "x", retryAfterSec: 60 } }, 429));
    setAccessKey(KEY);
    await expect(searchFlights(SEARCH, signal())).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(events).toEqual([]);
    expect(getAccessKey()).toBe(KEY);
  });

  it("503 access_misconfigured: the lock screen with the owner's message; other 503s are the pages' business", async () => {
    stubFetch((_, n) => n === 1
      ? json({ error: { code: "access_misconfigured", message: "x", reason: "too_short" } }, 503)
      : json({ error: { code: "deals_unavailable", message: "x" } }, 503));
    setAccessKey(KEY);
    await expect(fetchDeals(signal())).rejects.toMatchObject({ status: 503 });
    await expect(fetchDeals(signal())).rejects.toMatchObject({ status: 503, code: "deals_unavailable" });
    expect(events).toEqual([{ type: "lock", reason: { kind: "misconfigured", reason: "too_short" } }]);
    expect(getAccessKey()).toBe(KEY);
  });
});

describe("checkAccess: what GET /api/auth/check says", () => {
  const cases: [Response | (() => never), unknown][] = [
    [new Response(null, { status: 204 }), { kind: "open" }],
    [json({ error: { code: "not_found", message: "Not found" } }, 404), { kind: "no_lock" }],
    [json({ error: { code: "unauthorized", message: "x" } }, 401), { kind: "unauthorized" }],
    [json({ error: { code: "too_many_attempts", message: "x", retryAfterSec: 90 } }, 429), { kind: "too_many_attempts", retryAfterSec: 90 }],
    [new Response("", { status: 429, headers: { "Retry-After": "30" } }), { kind: "too_many_attempts", retryAfterSec: 30 }],
    [new Response("", { status: 429 }), { kind: "too_many_attempts", retryAfterSec: null }],
    [json({ error: { code: "access_misconfigured", message: "x", reason: "too_short" } }, 503), { kind: "misconfigured", reason: "too_short" }],
    [json({ error: { code: "access_misconfigured", message: "x" } }, 503), { kind: "misconfigured", reason: null }],
    [json({ error: { code: "internal_error", message: "x" } }, 500), { kind: "error", status: 500 }],
    [() => { throw new TypeError("Failed to fetch"); }, { kind: "network" }],
  ];
  for (const [answer, expected] of cases) {
    it(`${JSON.stringify(expected)}`, async () => {
      stubFetch(() => (typeof answer === "function" ? answer() : answer));
      expect(await checkAccess(KEY)).toEqual(expected);
      expect(events).toEqual([]); // it only reports to its caller
    });
  }

  it("an abort is passed on, not turned into a network error", async () => {
    stubFetch(() => { throw new DOMException("aborted", "AbortError"); });
    await expect(checkAccess(null)).rejects.toMatchObject({ name: "AbortError" });
  });
});

// --- the gate ----------------------------------------------------------------------------------------------

const settle = async (start: GateState) => {
  const event = await startupCheck();
  if (!event) throw new Error("startupCheck dropped its answer");
  return gateReducer(start, event);
};

describe("startup", () => {
  it("no key, 204 (the lock is off): the app; no key is stored", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    expect(initialGate(false)).toEqual({ view: "checking" });
    expect(await settle(initialGate(false))).toEqual({ view: "app", generation: 0 });
    expect(getAccessKey()).toBeNull();
  });

  it("no key, 401: the lock screen, no message", async () => {
    stubFetch(() => json({ error: { code: "unauthorized", message: "x" } }, 401));
    expect(await settle(initialGate(false))).toEqual({ view: "locked", message: null });
  });

  it("a stored key: the app shows at once; 204 keeps it", async () => {
    setAccessKey(KEY);
    expect(initialGate(hasAccessKey())).toEqual({ view: "app", generation: 0 });
    stubFetch(() => new Response(null, { status: 204 }));
    expect(await settle({ view: "app", generation: 0 })).toEqual({ view: "app", generation: 0 });
    expect(sent[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(getAccessKey()).toBe(KEY);
  });

  it("a stored key the API refuses (rotated): forgotten, and the lock screen says the saved key is out of date", async () => {
    setAccessKey(KEY);
    stubFetch(() => json({ error: { code: "unauthorized", message: "x" } }, 401));
    expect(await settle({ view: "app", generation: 0 })).toEqual({ view: "locked", message: { kind: "stale_key" } });
    expect(getAccessKey()).toBeNull();
  });

  it("an API from before the lock (404 on /api/auth/check): the app, as before", async () => {
    stubFetch(() => json({ error: { code: "not_found", message: "Not found" } }, 404));
    expect(await settle(initialGate(false))).toEqual({ view: "app", generation: 0 });
  });

  it("network trouble: the app (its own screens say the service is unreachable); the key is kept", async () => {
    stubFetch(() => { throw new TypeError("Failed to fetch"); });
    expect(await settle(initialGate(false))).toEqual({ view: "app", generation: 0 });
    setAccessKey(KEY);
    expect(await settle({ view: "app", generation: 0 })).toEqual({ view: "app", generation: 0 });
    expect(getAccessKey()).toBe(KEY);
  });

  it("a stored key that an API from before the lock refuses in CORS: the key is dropped so the site keeps working", async () => {
    setAccessKey(KEY);
    // With the header the browser's preflight fails (a network error); without it the old API answers 404.
    stubFetch((_, n) => {
      if (n === 1) throw new TypeError("Failed to fetch");
      return json({ error: { code: "not_found", message: "Not found" } }, 404);
    });
    // ...and the pages start over (a new generation), since every request they sent meanwhile carried the key and failed
    expect(await settle({ view: "app", generation: 0 })).toEqual({ view: "app", generation: 1 });
    expect(sent.map((s) => s.authorization)).toEqual([`Bearer ${KEY}`, null]);
    expect(getAccessKey()).toBeNull();
  });

  it("...but a real outage or a locked API keeps the key", async () => {
    for (const probe of [() => { throw new TypeError("Failed to fetch"); }, () => json({ error: { code: "unauthorized", message: "x" } }, 401)]) {
      setAccessKey(KEY);
      sent = [];
      stubFetch((_, n) => {
        if (n === 1) throw new TypeError("Failed to fetch");
        return probe();
      });
      expect(await settle({ view: "app", generation: 0 })).toEqual({ view: "app", generation: 0 });
      expect(getAccessKey()).toBe(KEY);
    }
  });

  it("429 and a misconfigured lock: the lock screen with the reason", async () => {
    stubFetch(() => json({ error: { code: "too_many_attempts", message: "x", retryAfterSec: 30 } }, 429));
    expect(await settle(initialGate(false))).toEqual({ view: "locked", message: { kind: "too_many_attempts", retryAfterSec: 30 } });
    stubFetch(() => json({ error: { code: "access_misconfigured", message: "x", reason: "too_short" } }, 503));
    expect(await settle(initialGate(false))).toEqual({ view: "locked", message: { kind: "misconfigured", reason: "too_short" } });
  });

  it("an answer about a key that changed meanwhile (a login or logout) is dropped: it can neither lock nor clear anything", async () => {
    setAccessKey(OTHER_KEY);
    stubFetch(() => {
      setAccessKey(KEY); // the user logged in with the new key while the check of the old one was out
      return json({ error: { code: "unauthorized", message: "x" } }, 401);
    });
    expect(await startupCheck()).toBeNull();
    expect(getAccessKey()).toBe(KEY);

    setAccessKey(KEY);
    stubFetch((_, n) => {
      if (n === 1) throw new TypeError("Failed to fetch");
      clearAccessKey(); // logged out while the probe was out
      return json({ error: { code: "not_found", message: "Not found" } }, 404);
    });
    sent = [];
    expect(await startupCheck()).toBeNull();
  });

  it("other server errors: the app (a locked API would still answer 401 to its first call)", async () => {
    stubFetch(() => json({ error: { code: "internal_error", message: "x" } }, 500));
    expect(await settle(initialGate(false))).toEqual({ view: "app", generation: 0 });
  });
});

describe("the lock screen's כניסה", () => {
  it("an empty field asks for the key and sends nothing", async () => {
    const fetchFn = stubFetch(() => new Response(null, { status: 204 }));
    for (const input of ["", "   ", "\n"]) expect(await submitKey(input)).toEqual({ unlocked: false, message: { kind: "empty" } });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // Review finding (ux-compat 11): a truncated paste used to cost one of the 20 attempts the Worker allows an address.
  it("something that cannot be a key is wrong without asking the server: too short, too long, spaces, Hebrew", async () => {
    const fetchFn = stubFetch(() => new Response(null, { status: 204 }));
    for (const input of ["two words", "מפתח-סודי-ארוך-מאוד-מאוד", "x".repeat(257), "short", KEY.slice(0, 19), `  ${KEY.slice(0, 19)}\n`]) {
      expect(await submitKey(input)).toEqual({ unlocked: false, message: { kind: "wrong_key" } });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("the right key (a paste with whitespace is fine): unlocked, and kept on this device", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    expect(await submitKey(`  ${KEY}\n`)).toEqual({ unlocked: true });
    expect(sent).toEqual([{ url: `${PAGE_ORIGIN}/api/auth/check`, method: "GET", authorization: `Bearer ${KEY}`, body: null }]);
    expect(store.getItem("eee.accessKey")).toBe(KEY);
    expect(gateReducer({ view: "locked", message: null }, { type: "unlocked" })).toEqual({ view: "app", generation: 0 });
  });

  it("a wrong key: המפתח שגוי, and nothing is stored", async () => {
    stubFetch(() => json({ error: { code: "unauthorized", message: "x" } }, 401));
    const outcome = await submitKey(OTHER_KEY);
    expect(outcome).toEqual({ unlocked: false, message: { kind: "wrong_key" } });
    expect(lockMessageText({ kind: "wrong_key" })).toBe("המפתח שגוי");
    expect(getAccessKey()).toBeNull();
  });

  it("too many attempts, a misconfigured lock, no connection, a server error: said in Hebrew, nothing stored", async () => {
    const answers: [() => Response, string][] = [
      [() => json({ error: { code: "too_many_attempts", message: "x", retryAfterSec: 480 } }, 429), "יותר מדי ניסיונות, נסו שוב בעוד 8 דקות"],
      [() => json({ error: { code: "access_misconfigured", message: "x", reason: "too_short" } }, 503), "האתר לא מוגדר נכון (המפתח קצר מדי)"],
      [() => { throw new TypeError("Failed to fetch"); }, "לא הצלחנו להתחבר לשירות. בדקו את החיבור ונסו שוב."],
      [() => json({ error: { code: "internal_error", message: "x" } }, 500), "משהו השתבש. נסו שוב בעוד רגע."],
    ];
    for (const [answer, text] of answers) {
      stubFetch(answer);
      const outcome = await submitKey(KEY);
      expect(outcome.unlocked).toBe(false);
      expect(!outcome.unlocked && lockMessageText(outcome.message)).toBe(text);
      expect(getAccessKey()).toBeNull();
    }
  });

  it("an API from before the lock (404): in, but the key is not kept (that API would refuse the header)", async () => {
    stubFetch(() => json({ error: { code: "not_found", message: "Not found" } }, 404));
    expect(await submitKey(KEY)).toEqual({ unlocked: true });
    expect(getAccessKey()).toBeNull();
  });
});

describe("logout (יציאה)", () => {
  it("forgets the key on this device and asks the gate to check again", () => {
    setAccessKey(KEY);
    logout();
    expect(getAccessKey()).toBeNull();
    expect(store.getItem(ACCESS_KEY_STORAGE)).toBeNull();
    expect(events).toEqual([{ type: "recheck" }]);
    expect(gateReducer({ view: "app", generation: 0 }, { type: "recheck" })).toEqual({ view: "checking" });
  });
});

describe("gateReducer", () => {
  it("a lock screen already up stays up (it owns its messages); unlock and recheck always apply", () => {
    const locked: GateState = { view: "locked", message: { kind: "wrong_key" } };
    expect(gateReducer(locked, { type: "lock", reason: { kind: "too_many_attempts", retryAfterSec: 5 } })).toBe(locked);
    expect(gateReducer(locked, { type: "checked", result: { kind: "open" }, hadKey: true })).toBe(locked);
    expect(gateReducer(locked, { type: "unlocked" })).toEqual({ view: "app", generation: 0 });
    expect(gateReducer(locked, { type: "recheck" })).toEqual({ view: "checking" });
    expect(gateReducer({ view: "checking" }, { type: "lock", reason: { kind: "misconfigured", reason: "too_long" } })).toEqual({
      view: "locked", message: { kind: "misconfigured", reason: "too_long" },
    });
  });
});

describe("lockMessageText", () => {
  it("words every message in Hebrew", () => {
    const cases: [LockMessage, string][] = [
      [{ kind: "empty" }, "הזינו את המפתח"],
      [{ kind: "wrong_key" }, "המפתח שגוי"],
      [{ kind: "too_many_attempts", retryAfterSec: 480 }, "יותר מדי ניסיונות, נסו שוב בעוד 8 דקות"],
      [{ kind: "too_many_attempts", retryAfterSec: 61 }, "יותר מדי ניסיונות, נסו שוב בעוד 2 דקות"],
      [{ kind: "too_many_attempts", retryAfterSec: 60 }, "יותר מדי ניסיונות, נסו שוב בעוד דקה"],
      [{ kind: "too_many_attempts", retryAfterSec: 5 }, "יותר מדי ניסיונות, נסו שוב בעוד דקה"],
      [{ kind: "too_many_attempts", retryAfterSec: null }, "יותר מדי ניסיונות, נסו שוב בעוד כמה דקות"],
      [{ kind: "misconfigured", reason: "too_short" }, "האתר לא מוגדר נכון (המפתח קצר מדי)"],
      [{ kind: "misconfigured", reason: null }, "האתר לא מוגדר נכון (המפתח קצר מדי)"],
      [{ kind: "misconfigured", reason: "invalid_characters" }, "האתר לא מוגדר נכון (המפתח לא תקין)"],
      [{ kind: "network" }, "לא הצלחנו להתחבר לשירות. בדקו את החיבור ונסו שוב."],
      [{ kind: "error" }, "משהו השתבש. נסו שוב בעוד רגע."],
    ];
    for (const [message, text] of cases) expect(lockMessageText(message)).toBe(text);
  });
});

// --- review findings (ux-compat), one block each -------------------------------------------------------------

describe("the access check cannot hang (ux-compat 1)", () => {
  /** A connection that never answers: the request ends only when it is aborted. */
  function stallFetch() {
    const fn = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it(`no answer within ${ACCESS_CHECK_TIMEOUT_MS / 1000} seconds counts as unreachable`, async () => {
    expect(ACCESS_CHECK_TIMEOUT_MS).toBe(8_000);
    stallFetch();
    let result: unknown = "pending";
    const pending = checkAccess(null).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(ACCESS_CHECK_TIMEOUT_MS - 1);
    expect(result).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(result).toEqual({ kind: "network" });
  });

  it("a body that stalls after the status line is covered too", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      },
    }), { status: 429 })));
    const pending = checkAccess(KEY);
    await vi.advanceTimersByTimeAsync(ACCESS_CHECK_TIMEOUT_MS);
    expect(await pending).toEqual({ kind: "network" });
  });

  it("so the gate shows the app (whose pages say the service is unreachable) instead of staying on בודקים גישה", async () => {
    stallFetch();
    const pending = startupCheck();
    await vi.advanceTimersByTimeAsync(ACCESS_CHECK_TIMEOUT_MS);
    const event = await pending;
    expect(event).toEqual({ type: "checked", result: { kind: "network" }, hadKey: false });
    expect(gateReducer(initialGate(false), event as GateEvent)).toEqual({ view: "app", generation: 0 });
  });

  it("the lock screen's כניסה has the same limit: a stalled check says so instead of spinning", async () => {
    stallFetch();
    const pending = submitKey(KEY);
    await vi.advanceTimersByTimeAsync(ACCESS_CHECK_TIMEOUT_MS);
    expect(await pending).toEqual({ unlocked: false, message: { kind: "network" } });
    expect(getAccessKey()).toBeNull();
  });

  it("the caller's own abort is still an abort (a newer check took over), not a network error", async () => {
    stallFetch();
    const controller = new AbortController();
    const pending = checkAccess(null, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const fetchFn = stallFetch();
    await expect(checkAccess(null, controller.signal)).rejects.toMatchObject({ name: "AbortError" }); // already aborted: nothing sent
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a quick answer leaves no timer behind", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    expect(await checkAccess(KEY)).toEqual({ kind: "open" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a retry when typing a key cannot help (ux-compat 3)", () => {
  it("misconfigured always, too many attempts when the key is stored here; otherwise the key field", () => {
    expect(lockScreenMode({ kind: "misconfigured", reason: "too_short" }, false)).toBe("retry");
    expect(lockScreenMode({ kind: "misconfigured", reason: null }, true)).toBe("retry");
    expect(lockScreenMode({ kind: "too_many_attempts", retryAfterSec: 60 }, true)).toBe("retry");
    expect(lockScreenMode({ kind: "too_many_attempts", retryAfterSec: 60 }, false)).toBe("form");
    const others: (LockMessage | null)[] = [null, { kind: "empty" }, { kind: "wrong_key" }, { kind: "stale_key" }, { kind: "network" }, { kind: "error" }];
    for (const message of others) {
      expect(lockScreenMode(message, true), JSON.stringify(message)).toBe("form");
      expect(lockScreenMode(message, false), JSON.stringify(message)).toBe("form");
    }
  });

  it("a stored key blocked for a while is kept, and the retry checks again with it", async () => {
    setAccessKey(KEY);
    stubFetch((_, n) => (n === 1 ? json({ error: { code: "too_many_attempts", message: "x", retryAfterSec: 60 } }, 429) : new Response(null, { status: 204 })));
    const blocked = await settle(initialGate(true));
    expect(blocked).toEqual({ view: "locked", message: { kind: "too_many_attempts", retryAfterSec: 60 } });
    expect(getAccessKey()).toBe(KEY);
    const checking = gateReducer(blocked, { type: "recheck" }); // what the retry button does
    expect(checking).toEqual({ view: "checking" });
    expect(await settle(checking)).toEqual({ view: "app", generation: 0 });
    expect(sent.map((s) => s.authorization)).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
  });
});

describe("every answer on the lock screen is announced, the same one twice too (ux-compat 4)", () => {
  it("a new try clears the old message and counts the attempt, which keys the alert", () => {
    let state = initialLockForm(null);
    expect(state).toEqual({ busy: false, message: null, attempt: 0, retryAt: null });
    state = lockFormReducer(state, { type: "submit" });
    expect(state).toEqual({ busy: true, message: null, attempt: 1, retryAt: null });
    state = lockFormReducer(state, { type: "failed", message: { kind: "wrong_key" }, at: 1_000 });
    expect(state).toEqual({ busy: false, message: { kind: "wrong_key" }, attempt: 1, retryAt: null });
    state = lockFormReducer(state, { type: "submit" });
    expect(state.message).toBeNull(); // the alert leaves while the key is checked...
    state = lockFormReducer(state, { type: "failed", message: { kind: "wrong_key" }, at: 2_000 });
    expect(state).toEqual({ busy: false, message: { kind: "wrong_key" }, attempt: 2, retryAt: null }); // ...and the same answer is a new alert
  });

  it("the gate's own message opens the form as attempt 0; a named wait ends that many seconds after the answer", () => {
    expect(initialLockForm({ kind: "stale_key" })).toEqual({ busy: false, message: { kind: "stale_key" }, attempt: 0, retryAt: null });
    expect(initialLockForm({ kind: "too_many_attempts", retryAfterSec: 480 }, 5_000).retryAt).toBe(485_000);
    expect(initialLockForm({ kind: "too_many_attempts", retryAfterSec: null }, 5_000).retryAt).toBeNull();
    const failed = lockFormReducer(initialLockForm(null), { type: "failed", message: { kind: "too_many_attempts", retryAfterSec: 60 }, at: 10_000 });
    expect(failed.retryAt).toBe(70_000);
    expect(lockFormReducer(failed, { type: "submit" }).retryAt).toBeNull();
  });
});

describe("only errors about what was typed mark the field invalid (ux-compat 5)", () => {
  it("empty and wrong_key; not the saved key, the network, the server, or a wait", () => {
    expect(isFieldError({ kind: "empty" })).toBe(true);
    expect(isFieldError({ kind: "wrong_key" })).toBe(true);
    const notTheField: (LockMessage | null)[] = [
      null, { kind: "stale_key" }, { kind: "network" }, { kind: "error" }, { kind: "misconfigured", reason: "too_short" }, { kind: "too_many_attempts", retryAfterSec: 60 },
    ];
    for (const message of notTheField) expect(isFieldError(message), JSON.stringify(message)).toBe(false);
  });
});

describe("a saved key that stopped working is said so, not called wrong (ux-compat 6)", () => {
  it("in Hebrew, asking for the current key", () => {
    expect(lockMessageText({ kind: "stale_key" })).toBe("המפתח שנשמר במכשיר הזה כבר לא תקף. הזינו את המפתח העדכני.");
  });

  it("from the startup check and from any API call; a key typed on the lock screen and refused is still just wrong", async () => {
    setAccessKey(KEY);
    stubFetch(() => json({ error: { code: "unauthorized", message: "x" } }, 401));
    expect(await settle(initialGate(true))).toEqual({ view: "locked", message: { kind: "stale_key" } });
    setAccessKey(KEY);
    await expect(fetchDeals(signal())).rejects.toMatchObject({ status: 401 });
    expect(gateReducer({ view: "app", generation: 0 }, events.at(-1) as AccessEvent & { type: "lock" })).toEqual({ view: "locked", message: { kind: "stale_key" } });
    expect(await submitKey(OTHER_KEY)).toEqual({ unlocked: false, message: { kind: "wrong_key" } });
  });
});

describe("after a rollback to an API without the lock, the pages start over without the key (ux-compat 7)", () => {
  it("the dropped key is reported, and the gate gives the pages a new generation (a remount)", async () => {
    setAccessKey(KEY);
    stubFetch((_, n) => {
      if (n === 1) throw new TypeError("Failed to fetch"); // the old API's preflight refuses the Authorization header
      return json({ error: { code: "not_found", message: "Not found" } }, 404);
    });
    const event = await startupCheck();
    expect(event).toEqual({ type: "checked", result: { kind: "no_lock" }, hadKey: true, droppedKey: true });
    expect(getAccessKey()).toBeNull();
    expect(gateReducer({ view: "app", generation: 0 }, event as GateEvent)).toEqual({ view: "app", generation: 1 });
  });

  it("any other answer leaves the pages alone: the very same state, so nothing remounts", () => {
    const shown: GateState = { view: "app", generation: 3 };
    for (const result of [{ kind: "open" }, { kind: "no_lock" }, { kind: "network" }, { kind: "error", status: 500 }] as const) {
      expect(gateReducer(shown, { type: "checked", result, hadKey: true })).toBe(shown);
    }
  });
});
