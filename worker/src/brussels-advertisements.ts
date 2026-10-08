/** Public, dated Brussels Airlines advertisements, not checkout-confirmed quotes. */
export interface BrusselsAdvertisement {
  origin: string; destination: string; departDate: string; returnDate: string;
  amount: number; currency: "EUR"; bookingUrl: string; checkedAt: string;
  pricing: "published_advertisement"; carrier: null;
}
function day(value: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const parsed = new Date(iso);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}
/** Input is visible anchor text and its href; unrelated schedule JSON must never supply a carrier. */
export function parseBrusselsAdvertisements(
  anchors: readonly { text: string; url: string }[],
  route: { origin: string; destination: string }, now: Date,
): BrusselsAdvertisement[] {
  return parseLhgAdvertisements(anchors, route, now, {origin:"https://www.brusselsairlines.com",market:"be"});
}

/** Observed public LHG anchor format, with a caller-selected official origin and market. */
export function parseLhgAdvertisements(
  anchors: readonly { text: string; url: string }[],
  route: { origin: string; destination: string }, now: Date,
  site: {origin:"https://www.brusselsairlines.com"|"https://www.lufthansa.com";market:"be"|"gr"},
): BrusselsAdvertisement[] {
  if (anchors.length > 500 || !/^[A-Z]{3}$/.test(route.origin) || !/^[A-Z]{3}$/.test(route.destination)) return [];
  const prices = new Map<string, BrusselsAdvertisement>();
  const conflicts = new Set<string>();
  for (const anchor of anchors) {
    let url: URL;
    try { url = new URL(anchor.url, site.origin); } catch { continue; }
    if (url.origin !== site.origin || url.search || url.hash || url.username || url.password) continue;
    const m = /^\/aircore\/deeplink\/redirect\/en\/(be|gr)\/([A-Z]{3})\/([A-Z]{3})\/(\d{2}\.\d{2}\.\d{4})\/(\d{2}\.\d{2}\.\d{4})\/RT$/.exec(url.pathname);
    if (!m || m[1] !== site.market || m[2] !== route.origin || m[3] !== route.destination) continue;
    const departDate = day(m[4]!), returnDate = day(m[5]!);
    if (!departDate || !returnDate || departDate < now.toISOString().slice(0, 10) || returnDate <= departDate) continue;
    // Calendar labels are whole-euro advertisements. Reject ambiguous or fractional formats.
    const matches = [...anchor.text.matchAll(/\bfrom\s+(\d+)\s*(?:EUR\b|€)/gi)];
    if (matches.length !== 1) continue;
    const amount = Number(matches[0]![1]);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000) continue;
    const key = `${departDate}|${returnDate}`;
    if (prices.has(key) && prices.get(key)!.amount !== amount) conflicts.add(key);
    prices.set(key, { ...route, departDate, returnDate, amount, currency: "EUR", bookingUrl: url.href,
      checkedAt: now.toISOString(), pricing: "published_advertisement", carrier: null });
  }
  return [...prices.entries()].filter(([key]) => !conflicts.has(key)).map(([, price]) => price);
}
