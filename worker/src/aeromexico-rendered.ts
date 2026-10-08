import type { Env } from "./types";
import { parsePublishedFares, type PublishedFare } from "./sources/published-fares";
export const AEROMEXICO_PAGE = "https://www.aeromexico.com/en_us/flights-from-los-angeles";
/** Fixed official origin page. Background caller only; never accepts user URLs. */
export async function loadRenderedAeromexico(browser: NonNullable<Env["BROWSER"]>, now: Date): Promise<PublishedFare[]> {
  const response = await browser.quickAction("content", {
    url: AEROMEXICO_PAGE,
    gotoOptions: { waitUntil: "networkidle2", timeout: 10000 },
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
  return parsePublishedFares(envelope.result, {
    airline: "AM", origin: "LAX", destination: "MEX", allDestinations: true,
    sourceUrl: AEROMEXICO_PAGE, now,
  });
}
