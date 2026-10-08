import type { PublishedFare } from "./sources/published-fares";
export const AVIANCA_PAGE = "https://www.avianca.com/us/en/flights-from-miami-to-cali";
const months: Record<string,string> = {Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12"};
function exactDate(value: string): string | null {
  const m = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([A-Z][a-z]{2}) (\d{2}), (\d{4})$/.exec(value.trim());
  if(!m || !months[m[1]!]) return null;
  const iso = `${m[3]}-${months[m[1]!]}-${m[2]}`;
  return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().slice(0,10) === iso ? iso : null;
}
/** Only the complete rendered cash card on the verified fixed route. No headline minima. */
export function parseAviancaCard(html: string, now: Date): PublishedFare[] {
  if(html.length>2_000_000) throw new Error("Official page too large");
  const clean=html.replace(/<script\b[\s\S]*?<\/script>/gi,"").replace(/<style\b[\s\S]*?<\/style>/gi,"");
  const card=/<div\b[^>]*class="hh-rtcard(?:\s[^"]*)?"[^>]*>([\s\S]*?)<button\b[^>]*class="hh-rtcard-clear"[^>]*>/i.exec(clean)?.[1];
  if(!card || !/class="hh-rtcard-title"[^>]*>Round trip<\/div>/.test(card)) return [];
  const dates=[...card.matchAll(/class="hh-rtcard-row"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/g)].map(m=>exactDate(m[1]!));
  const currency=/class="hh-rtcard-currency"[^>]*>(USD)<\/span>/.exec(card)?.[1];
  const amountText=/class="hh-rtcard-amount"[^>]*>(\d+(?:\.\d{1,2})?)<\/span>/.exec(card)?.[1];
  const amount=Number(amountText);
  const visible=clean.replace(/<[^>]*>/g," ").replace(/\s+/g," ");
  const minimumText=/Round trip from (\d+(?:\.\d{1,2})?) USD/.exec(visible)?.[1];
  const minimum=Number(minimumText);
  // React may insert the return date before replacing the outbound-only amount.
  if(minimumText && Number.isFinite(minimum) && amount < minimum) return [];
  if(dates.length!==2 || !dates[0] || !dates[1] || dates[1]<=dates[0] || dates[0]<now.toISOString().slice(0,10) || currency!=="USD" || !amountText || !Number.isFinite(amount) || amount<=0 || !/class="hh-rtcard-cta"[^>]*>Book now<\/button>/.test(card)) return [];
  return [{airline:"AV",origin:"MIA",destination:"CLO",departDate:dates[0],returnDate:dates[1],amount,currency,structure:"roundtrip",sourceUrl:AVIANCA_PAGE,checkedAt:now.toISOString(),pricing:"published_advertisement"}];
}
