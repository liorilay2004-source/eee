import type { Env } from "./types";
import { type PublishedFare } from "./sources/published-fares";
import { AVIANCA_PAGE, parseAviancaCard } from "./avianca-card";
/** Fixed official origin page. Background caller only; never accepts user URLs. */
export async function loadRenderedAvianca(browser: NonNullable<Env["BROWSER"]>, now: Date): Promise<PublishedFare[]> {
  const response = await browser.quickAction("content", {
    url: AVIANCA_PAGE,
    gotoOptions: { waitUntil: "domcontentloaded", timeout: 10000 },
    waitForSelector: {selector: ".hh-rtcard-dates .hh-rtcard-row:nth-child(2)", timeout: 10000},
    waitForTimeout: 2000,
    rejectResourceTypes: ["image", "font", "media"],
  });
  if (!response.ok) throw new Error("Official rendering failed");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing rendering payload");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4_000_000) throw new Error("Rendering payload too large");
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  const joined = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  const envelope = JSON.parse(new TextDecoder().decode(joined)) as { success?: unknown; result?: unknown };
  if (envelope.success !== true || typeof envelope.result !== "string") throw new Error("Invalid rendering response");
  return parseAviancaCard(envelope.result, now);
}
import type { Repo } from "./types";
import type { PublicFareCache } from "./public-fare-cache";
import { matchPublishedTrip } from "./sources/published-source";
export async function collectRenderedAvianca(deps: { env: Env; repo: Pick<Repo,"savePrices">; now: Date; cache?: PublicFareCache }) {
  const empty = {source: "avianca", ok: true, fares: 0, saved: 0};
  if(deps.env.AVIANCA_RENDERED_ENABLED !== "true" || !deps.env.BROWSER) return {...empty, skipped: true};
  try {
    const fares = await loadRenderedAvianca(deps.env.BROWSER, deps.now);
    await deps.cache?.put(AVIANCA_PAGE, fares);
    const offers = fares.filter(f=>f.structure === "roundtrip" && f.returnDate).flatMap(f=>matchPublishedTrip([f],{origin:f.origin,destination:f.destination,departDate:f.departDate,returnDate:f.returnDate!,party:{adults:1,children:0,infants:0}},{airline:"AV",source:"avianca"}));
    if(!offers.length) return {...empty,ok:false};
    if(offers.length) await deps.repo.savePrices(offers,{skipUnchangedSince:new Date(deps.now.getTime()-3_600_000).toISOString()});
    return {...empty, fares:fares.length, saved:offers.length};
  } catch { return {...empty,ok:false}; }
}
