/**
 * Card details from the newer, additive API fields: Hebrew airline names, the fare-age line, and the stale /
 * suspicious-price badges. Every field may be missing on an older response, so each helper falls back safely.
 */
import type { CardView, SearchResponse } from "../api/contract";

export interface AirlineLabel { code: string; name: string | null }

/** Each code once, with its Hebrew name when the API knows it; an unknown code stays a code (never guessed). */
export function airlineLabels(codes: readonly string[], names: Readonly<Record<string, string>> | undefined): AirlineLabel[] {
  const seen = new Set<string>();
  const out: AirlineLabel[] = [];
  for (const raw of codes) {
    const code = raw.trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const name = names && Object.hasOwn(names, code) && typeof names[code] === "string" && names[code].trim() ? names[code].trim() : null;
    out.push({ code, name });
  }
  return out;
}

/** Every airline of both legs, for the compact card's one line. */
export function cardAirlines(card: Pick<CardView, "offer" | "airlineNames">): AirlineLabel[] {
  return airlineLabels([...card.offer.outbound.airlines, ...card.offer.inbound.airlines], card.airlineNames);
}

/**
 * The age line under a price. The API's ageLabelHe is written never to imply a live check, so it is used as is;
 * without it, the old generic line.
 */
export function freshnessLine(card: Pick<CardView, "offer"> & Partial<Pick<CardView, "ageLabelHe">>): string {
  const label = typeof card.ageLabelHe === "string" ? card.ageLabelHe.trim() : "";
  if (label) return label;
  return card.offer.source === "travelpayouts" ? "מחיר מהמטמון של Aviasales · עשוי להשתנות" : "מחיר שנשמר לאחרונה · עשוי להשתנות";
}

export function freshnessTone(card: Partial<Pick<CardView, "freshness">>): "plain" | "warn" {
  return card.freshness === "stale" ? "warn" : "plain";
}

export function isSuspicious(card: Pick<CardView, "offer">): boolean {
  return Array.isArray(card.offer.tags) && card.offer.tags.includes("price_suspicious");
}

export const SUSPICIOUS_BADGE = "מחיר חריג, כדאי לוודא";
export const SUSPICIOUS_TEXT = "המחיר נמוך בהרבה מתאריכים סמוכים או מההיסטוריה שלו. ייתכן שהוא כבר לא זמין: בדקו אותו באתר ההזמנה לפני שמתכננים סביבו.";

/**
 * The stale-while-revalidate badge. "מתעדכנות ברקע" only when the server really started a refresh; otherwise it says
 * plainly that these are older results.
 */
export function staleBadge(meta: Pick<SearchResponse["meta"], "stale">): { badge: string; detail: string | null } | null {
  const stale = meta.stale;
  if (!stale) return null;
  const detail = typeof stale.messageHe === "string" && stale.messageHe.trim() ? stale.messageHe.trim() : null;
  return { badge: stale.revalidating ? "תוצאות שמורות, מתעדכנות ברקע" : "תוצאות שמורות מסריקה קודמת", detail };
}

/** Extra lines for the "about this data" panel from meta.priceGuard and meta.recommendations, when present. */
export function metaNotes(meta: Partial<Pick<SearchResponse["meta"], "priceGuard" | "recommendations">>): string[] {
  const notes: string[] = [];
  const guard = meta.priceGuard;
  if (guard && guard.suspicious > 0) {
    notes.push(guard.excluded > 0
      ? `${guard.suspicious} מחירים נראו חשודים (נמוכים מדי ביחס לתאריכים סמוכים ולהיסטוריה), ו־${guard.excluded} מהם לא הוצגו.`
      : `${guard.suspicious} מחירים נראו חשודים ביחס לתאריכים סמוכים או להיסטוריה. הם סומנו בכרטיס.`);
  }
  const excluded = meta.recommendations?.cheapest?.excludedForUnknownBagFee ?? 0;
  if (excluded > 0) notes.push(`${excluded === 1 ? "הצעה אחת זולה יותר לא הוצגה" : `${excluded} הצעות זולות יותר לא הוצגו`} כי עלות המזוודה בהן לא ידועה.`);
  if (meta.recommendations?.bestValue?.status === "flight_details_unknown") {
    notes.push("הצעות בלי זמני המראה, משך טיסה ועצירות לא נכנסו לדירוג התמורה.");
  }
  return notes;
}
