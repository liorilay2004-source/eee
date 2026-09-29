/**
 * Helpers for the public API's rate limiter (SPEC §14), kept out of index.ts because the Worker entry module may
 * export nothing but its handler.
 */

// --- who is "one client" --------------------------------------------------------------------------------

const HEXTET = /^[0-9a-f]{1,4}$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Hextets(text: string): [number, number] | null {
  const m = IPV4.exec(text);
  if (!m) return null;
  const o = [m[1], m[2], m[3], m[4]].map(Number);
  if (o.some((n) => !Number.isInteger(n) || n > 255)) return null;
  return [((o[0] as number) << 8) | (o[1] as number), ((o[2] as number) << 8) | (o[3] as number)];
}

/** The eight 16-bit groups of an IPv6 address (`::` expanded, a dotted IPv4 tail converted), or null if malformed. */
function ipv6Groups(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const items = part.split(":");
    for (const [i, item] of items.entries()) {
      if (i === items.length - 1 && item.includes(".")) {
        const tail = ipv4Hextets(item);
        if (!tail) return null;
        out.push(tail[0], tail[1]);
      } else if (HEXTET.test(item)) out.push(parseInt(item, 16));
      else return null;
    }
    return out;
  };
  const head = parse(halves[0] as string);
  const tail = halves.length === 2 ? parse(halves[1] as string) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  return fill >= 1 ? [...head, ...new Array<number>(fill).fill(0), ...tail] : null;
}

/**
 * What identifies a client for rate limiting. An IPv6 client normally controls a whole /64, so the address is cut
 * to that prefix (otherwise cycling through the low 64 bits would hand it a fresh quota per request). IPv4 and
 * IPv4-mapped IPv6 addresses count as the IPv4 address. Anything unparseable is used as it is.
 */
export function clientIdentity(ip: string): string {
  const trimmed = ip.trim().toLowerCase().replace(/%.*$/, ""); // drop a zone id such as %eth0
  if (!trimmed.includes(":")) return trimmed;
  const groups = ipv6Groups(trimmed);
  if (!groups) return trimmed;
  const g = (i: number): number => groups[i] as number;
  if (g(0) === 0 && g(1) === 0 && g(2) === 0 && g(3) === 0 && g(4) === 0 && g(5) === 0xffff) {
    return `${g(6) >> 8}.${g(6) & 255}.${g(7) >> 8}.${g(7) & 255}`; // ::ffff:a.b.c.d is the IPv4 client
  }
  return `${[0, 1, 2, 3].map((i) => g(i).toString(16)).join(":")}::/64`;
}

// --- salt ------------------------------------------------------------------------------------------------

let isolateSalt: string | undefined;
let warnedNoSalt = false;

/**
 * Salt for hashing client addresses. The stored hash of an address must not be reversible by brute force (the
 * IPv4 space is only 2^32), so the salt has to be secret: RATE_LIMIT_SALT, else a value derived from the
 * Travelpayouts token (also a secret, and required for searching anyway). With neither, a random per-isolate salt
 * is used and an error is logged: nothing reversible is stored, but each isolate then counts on its own.
 */
export function limiterSalt(env: { RATE_LIMIT_SALT?: string; TRAVELPAYOUTS_TOKEN?: string }): string {
  const configured = env.RATE_LIMIT_SALT?.trim();
  if (configured) return configured;
  const token = env.TRAVELPAYOUTS_TOKEN?.trim();
  if (token) return `rate-limit|${token}`; // domain-separated, the token itself never appears in a stored value
  if (!warnedNoSalt) {
    warnedNoSalt = true;
    console.error("RATE_LIMIT_SALT is not set: run `wrangler secret put RATE_LIMIT_SALT` (using a per-isolate random salt)");
  }
  return (isolateSalt ??= crypto.randomUUID());
}

// --- fallback limiter --------------------------------------------------------------------------------------

export interface MemoryLimiter {
  check(key: string, nowMs: number): { allowed: boolean; retryAfterSec: number };
  /** Number of keys held (for tests and diagnostics). */
  size(): number;
}

/**
 * Per-isolate fixed-window counter, the fallback when the D1-backed limiter cannot be used (its storage failing
 * must not take the whole API down). Weaker than the shared limiter, since every isolate counts alone, but it
 * keeps a single client's bulk traffic bounded. Memory is bounded too: an address-rotating client cannot grow it.
 */
export function createMemoryLimiter(max: number, windowSec: number, maxKeys = 5000): MemoryLimiter {
  const windowMs = windowSec * 1000;
  const counters = new Map<string, { windowStart: number; count: number }>();
  return {
    check(key, nowMs) {
      const windowStart = Math.floor(nowMs / windowMs) * windowMs;
      let entry = counters.get(key);
      if (!entry || entry.windowStart !== windowStart) {
        if (counters.size >= maxKeys) {
          for (const [k, v] of counters) if (v.windowStart !== windowStart) counters.delete(k);
          if (counters.size >= maxKeys) counters.clear(); // still full of live keys: start over rather than grow
        }
        entry = { windowStart, count: 0 };
        counters.set(key, entry);
      }
      entry.count += 1;
      const allowed = entry.count <= max;
      return { allowed, retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000)) };
    },
    size: () => counters.size,
  };
}
