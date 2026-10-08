import type { Env } from "./types";
import type { PublicFareCache } from "./public-fare-cache";
import { parseBrusselsAdvertisements, type BrusselsAdvertisement } from "./brussels-advertisements";
export const BRUSSELS_ATHENS_PAGE = "https://www.brusselsairlines.com/lhg/be/en/o-d/cy-cy/brussels-athens";

export async function collectRenderedBrussels(deps: { env: Env; now: Date; cache?: PublicFareCache }) {
  if(deps.env.BRUSSELS_RENDERED_ENABLED !== "true" || !deps.env.BROWSER) return {source:"brussels_airlines",ok:true,skipped:true,fares:0};
  try {
    const fares = await loadRenderedBrussels(deps.env.BROWSER,deps.now);
    if (!fares.length) return {source:"brussels_airlines",ok:false,fares:0};
    if (!deps.cache) return {source:"brussels_airlines",ok:false,fares:fares.length,cacheUnavailable:true};
    await deps.cache.put(BRUSSELS_ATHENS_PAGE,fares);
    return {source:"brussels_airlines",ok:true,fares:fares.length};
  } catch { return {source:"brussels_airlines",ok:false,fares:0}; }
}

/** Reads public rendered anchors only. No account, passenger data or session tokens are retained. */
export async function loadRenderedBrussels(browser: NonNullable<Env["BROWSER"]>, now: Date): Promise<BrusselsAdvertisement[]> {
  return parseBrusselsAdvertisements(await loadRenderedLhgAnchors(browser, BRUSSELS_ATHENS_PAGE), { origin: "BRU", destination: "ATH" }, now);
}

export async function loadRenderedLhgAnchors(browser: NonNullable<Env["BROWSER"]>, page: string): Promise<{text:string;url:string}[]> {
  if (![BRUSSELS_ATHENS_PAGE,"https://www.lufthansa.com/lhg/gr/en/o-d/cy-cy/athens-tel-aviv"].includes(page)) throw new Error("Unsupported official fare page");
  const response = await browser.quickAction("content", {
    url: page, gotoOptions: { waitUntil: "domcontentloaded", timeout: 15000 },
    waitForTimeout: 2000, rejectResourceTypes: ["image", "font", "media"],
  });
  if (!response.ok || !response.body) throw new Error("Official rendering failed");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > 4_000_000) throw new Error("Rendering payload too large");
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  const joined = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  const envelope = JSON.parse(new TextDecoder().decode(joined)) as { success?: unknown; result?: unknown };
  if (envelope.success !== true || typeof envelope.result !== "string") throw new Error("Invalid rendering response");
  const anchors: { text: string; url: string }[] = [];
  let current: { text: string; url: string } | null = null;
  const transformed = new HTMLRewriter().on('a[href*="/aircore/deeplink/redirect/"]', {
    element(element) {
      if (anchors.length >= 500) throw new Error("Too many fare anchors");
      current = { text: "", url: element.getAttribute("href") ?? "" }; anchors.push(current);
      element.onEndTag(() => { current = null; });
    },
    text(chunk) { if (current) { current.text += chunk.text; if (current.text.length > 2000) throw new Error("Fare label too large"); } },
  }).transform(new Response(envelope.result));
  await transformed.text();
  return anchors;
}
