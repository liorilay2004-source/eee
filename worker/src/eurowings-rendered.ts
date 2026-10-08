import type { Env } from "./types";
import type { PublicFareCache } from "./public-fare-cache";
import { parseEurowingsRenderedCalendar, type EurowingsCalendarFare, type EurowingsDestination } from "./eurowings-calendar";

export const EUROWINGS_PAGE = "https://www.eurowings.com/en/booking/flights/low-fare-calendar.html";
export const EUROWINGS_API = "https://www.eurowings.com/services/centrallowfare.version1.ccen.originLHR.destinationDUS.promo.airlinecodesEW.showalternativesfalse.showNumberOfRoutes0.radius0.json";
export const eurowingsCacheKey = (month: string, destination: EurowingsDestination = "DUS") => `${EUROWINGS_PAGE}?month=${month}${destination === "ATH" ? "&destination=ATH" : ""}`;

/** Fixed public URL observed in the official calendar's own ordinary request. */
export async function loadRenderedEurowings(browser: NonNullable<Env["BROWSER"]>, now: Date, destination: EurowingsDestination = "DUS"): Promise<EurowingsCalendarFare[]> {
  if (!["DUS","ATH"].includes(destination)) throw new Error("Unsupported calendar route");
  const response = await browser.quickAction("content", {
    url: destination === "DUS" ? EUROWINGS_API : EUROWINGS_API.replace("destinationDUS", "destinationATH"), gotoOptions: { waitUntil: "domcontentloaded", timeout: 15000 },
    waitForTimeout: 3000, rejectResourceTypes: ["image", "font", "media"],
  });
  if (!response.ok || !response.body) throw new Error("Official calendar rendering failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1_000_000) throw new Error("Calendar rendering too large");
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  const envelope = JSON.parse(new TextDecoder().decode(joined)) as { success?: unknown; result?: unknown };
  if (envelope.success !== true || typeof envelope.result !== "string") throw new Error("Invalid calendar rendering");
  return parseEurowingsRenderedCalendar(envelope.result, now, destination);
}

/** At most 24 small monthly snapshots, rather than a price-history row per day. */
export async function collectRenderedEurowings(deps: {env: Pick<Env, "BROWSER" | "DB" | "EUROWINGS_RENDERED_ENABLED">; now: Date; cache?: PublicFareCache; destination?: EurowingsDestination}) {
  if (deps.env.EUROWINGS_RENDERED_ENABLED !== "true" || !deps.env.BROWSER) return {ok:true,fares:0,skipped:true};
  try {
    const destination = deps.destination ?? "DUS";
    const fares = await loadRenderedEurowings(deps.env.BROWSER, deps.now, destination);
    if (!fares.length) return {ok:false,fares:0};
    const groups = new Map<string, EurowingsCalendarFare[]>();
    for (const fare of fares) {
      const month = fare.date.slice(0,7);
      const group = groups.get(month) ?? [];
      group.push(fare);
      groups.set(month, group);
    }
    for (const [month, rows] of groups) await deps.cache?.put(eurowingsCacheKey(month, destination), rows);
    try {
      await deps.env.DB.batch([...groups].map(([month, rows]) => deps.env.DB.prepare(
        "INSERT INTO public_calendar_snapshots (source,origin,destination,month,fares_json,checked_at) VALUES (?,?,?,?,?,?) " +
        "ON CONFLICT(source,origin,destination,month) DO UPDATE SET fares_json=excluded.fares_json,checked_at=excluded.checked_at",
      ).bind("eurowings","LHR",destination,month,JSON.stringify(rows),deps.now.toISOString())));
      return {ok:true,fares:fares.length,months:groups.size};
    } catch { return {ok:true,fares:fares.length,months:groups.size,historyUnavailable:true}; }
  } catch { return {ok:false,fares:0}; }
}
