/** Rate-limiter helpers: who counts as one client, the salt, and the in-memory fallback. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIdentity, createMemoryLimiter, limiterSalt } from "../src/ratelimit";

describe("clientIdentity", () => {
  it("leaves IPv4 addresses alone", () => {
    expect(clientIdentity("203.0.113.7")).toBe("203.0.113.7");
    expect(clientIdentity(" 203.0.113.7 ")).toBe("203.0.113.7");
  });

  it("cuts an IPv6 address to its /64: the low 64 bits are the client's to rotate", () => {
    const id = clientIdentity("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(id).toBe("2001:db8:1:2::/64");
    expect(clientIdentity("2001:0DB8:0001:0002::1")).toBe(id); // case, leading zeros and :: do not matter
    expect(clientIdentity("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe(id);
    expect(clientIdentity("2001:db8:1:3::1")).not.toBe(id); // the next /64 is somebody else
  });

  it("expands :: in the network part too", () => {
    expect(clientIdentity("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientIdentity("::1")).toBe("0:0:0:0::/64");
    expect(clientIdentity("::")).toBe("0:0:0:0::/64");
    expect(clientIdentity("fe80::1%eth0")).toBe("fe80:0:0:0::/64"); // zone id dropped
  });

  it("treats IPv4-mapped IPv6 as the IPv4 address", () => {
    expect(clientIdentity("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientIdentity("::FFFF:cb00:7107")).toBe("203.0.113.7");
    expect(clientIdentity("0:0:0:0:0:ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("converts a dotted IPv4 tail inside a normal IPv6 address", () => {
    expect(clientIdentity("64:ff9b::203.0.113.7")).toBe("64:ff9b:0:0::/64");
  });

  it("uses anything it cannot parse as it is (still hashed by the caller), never throwing", () => {
    for (const odd of ["unknown", "", "1:2:3:4:5:6:7:8:9", "2001:db8::1::2", "gggg::1", "::ffff:999.1.1.1", "12345::1", "1:2:3"]) {
      expect(() => clientIdentity(odd)).not.toThrow();
    }
    expect(clientIdentity("unknown")).toBe("unknown");
    expect(clientIdentity("2001:db8::1::2")).toBe("2001:db8::1::2");
    expect(clientIdentity("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
  });
});

describe("limiterSalt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("prefers RATE_LIMIT_SALT", () => {
    expect(limiterSalt({ RATE_LIMIT_SALT: " abc ", TRAVELPAYOUTS_TOKEN: "tok" })).toBe("abc");
  });

  it("derives one from the Travelpayouts token, without putting the token itself into the value that is hashed alone", () => {
    const salt = limiterSalt({ TRAVELPAYOUTS_TOKEN: "tok-123" });
    expect(salt).not.toBe("tpe-rate-limit-v1"); // the old public constant
    expect(salt).toContain("tok-123"); // it is derived from the secret (and only ever used as hash input)
    expect(limiterSalt({ RATE_LIMIT_SALT: "  ", TRAVELPAYOUTS_TOKEN: "tok-123" })).toBe(salt);
  });

  it("with nothing configured uses a random per-isolate salt and says so once, never the old public constant", async () => {
    vi.resetModules();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fresh = await import("../src/ratelimit");
    const a = fresh.limiterSalt({});
    const b = fresh.limiterSalt({ RATE_LIMIT_SALT: "" });
    expect(a).toBe(b); // stable within the isolate
    expect(a).not.toBe("tpe-rate-limit-v1");
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]?.[0])).toContain("RATE_LIMIT_SALT");
    vi.resetModules();
    const other = await import("../src/ratelimit");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(other.limiterSalt({})).not.toBe(a); // another isolate, another salt
  });
});

describe("createMemoryLimiter", () => {
  const T = Date.UTC(2026, 10, 1, 12, 0, 30); // 30s into a 60s window

  it("allows up to the limit per window, then denies with the time left", () => {
    const l = createMemoryLimiter(3, 60);
    expect([1, 2, 3, 4, 5].map(() => l.check("a", T).allowed)).toEqual([true, true, true, false, false]);
    expect(l.check("a", T).retryAfterSec).toBe(30);
  });

  it("starts over in the next window and keeps keys apart", () => {
    const l = createMemoryLimiter(1, 60);
    expect(l.check("a", T).allowed).toBe(true);
    expect(l.check("a", T).allowed).toBe(false);
    expect(l.check("b", T).allowed).toBe(true);
    expect(l.check("a", T + 30_000).allowed).toBe(true);
  });

  it("stays bounded when a client rotates identities: it never holds more than maxKeys", () => {
    const l = createMemoryLimiter(5, 60, 100);
    for (let i = 0; i < 10_000; i++) {
      l.check(`k${i}`, T);
      expect(l.size()).toBeLessThanOrEqual(100);
    }
    // once a window has passed, expired keys are the first to go
    l.check("late", T + 60_000);
    expect(l.size()).toBeLessThanOrEqual(100);
    // ...while a key that is being hammered is still counted
    for (let i = 0; i < 5; i++) l.check("hammer", T);
    expect(l.check("hammer", T).allowed).toBe(false);
  });
});
