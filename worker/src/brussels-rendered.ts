import type { Env } from "./types";
import { parseBrusselsAdvertisements, type BrusselsAdvertisement } from "./brussels-advertisements";
export const BRUSSELS_ATHENS_PAGE = "https://www.brusselsairlines.com/lhg/be/en/o-d/cy-cy/brussels-athens";

/** Reads public rendered anchors only. No account, passenger data or session tokens are retained. */
export async function loadRenderedBrussels(browser: NonNullable<Env["BROWSER"]>, now: Date): Promise<BrusselsAdvertisement[]> {
  const response = await browser.quickAction("content", {
    url: BRUSSELS_ATHENS_PAGE, gotoOptions: { waitUntil: "domcontentloaded", timeout: 15000 },
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
  return parseBrusselsAdvertisements(anchors, { origin: "BRU", destination: "ATH" }, now);
}
