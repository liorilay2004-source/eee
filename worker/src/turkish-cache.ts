import {loadRenderedTurkish,TURKISH_ATHENS_PAGE} from "./turkish-rendered";
import type {PublishedFare} from "./sources/published-fares";
import type {PublicFareCache} from "./public-fare-cache";
import type {Env} from "./types";

const MAX_AGE_MS=3600000;
function validDate(value:unknown):value is string {
  return typeof value==="string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
}
/** Preserve advertised TRY amounts and exact paired dates; no inference about operators. */
export function validateTurkishFare(value:unknown,now:Date):PublishedFare|null {
  if(!value || typeof value!=="object")return null;
  const f=value as PublishedFare;
  if(f.airline!=="TK" || f.origin!=="IST" || f.destination!=="ATH" || f.currency!=="TRY" || f.structure!=="roundtrip" || f.pricing!=="published_advertisement" || f.sourceUrl!==TURKISH_ATHENS_PAGE)return null;
  if(!validDate(f.departDate)||!validDate(f.returnDate)||f.returnDate<=f.departDate||f.departDate<now.toISOString().slice(0,10))return null;
  const age=typeof f.checkedAt==="string"?now.getTime()-Date.parse(f.checkedAt):NaN;
  if(!Number.isFinite(age)||age<0||age>=MAX_AGE_MS||typeof f.amount!=="number"||!Number.isFinite(f.amount)||f.amount<=0||f.amount>1000000)return null;
  return {airline:"TK",origin:"IST",destination:"ATH",departDate:f.departDate,returnDate:f.returnDate,amount:f.amount,currency:"TRY",structure:"roundtrip",sourceUrl:TURKISH_ATHENS_PAGE,checkedAt:f.checkedAt,pricing:"published_advertisement"};
}
export async function readTurkishFares(cache:PublicFareCache|undefined,now:Date):Promise<PublishedFare[]> {
  try {
    const data=await cache?.get<unknown>(TURKISH_ATHENS_PAGE);
    return (data?.fares??[]).slice(0,500).map(f=>validateTurkishFare(f,now)).filter((f):f is PublishedFare=>f!==null);
  }catch{return [];}
}
/** One public browser collection, independent of the price-history database. */
export async function collectTurkishFares(browser:NonNullable<Env["BROWSER"]>,cache:PublicFareCache,now:Date):Promise<number> {
  const fares=(await loadRenderedTurkish(browser,now)).map(f=>validateTurkishFare(f,now)).filter((f):f is PublishedFare=>f!==null);
  if(fares.length)await cache.put(TURKISH_ATHENS_PAGE,fares);
  return fares.length;
}
