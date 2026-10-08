import type {PublishedFare} from "./sources/published-fares";
export const IBERIA_PAGE="https://www.iberia.com/es/cheap-flights/Madrid-Tel-Aviv/";
const validDate=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
/** Read each complete dated card, not the headline or airport travel costs. */
export function parseIberiaFares(html:string,now:Date):PublishedFare[]{
 if(html.length>2000000)throw new Error("Official page too large");
 const clean=html.replace(/<script\b[\s\S]*?<\/script>/gi,"").replace(/<style\b[\s\S]*?<\/style>/gi,"");
 const fares:PublishedFare[]=[];
 for(const card of clean.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)){
 const body=card[1]!;
 const text=(suffix:string)=>new RegExp(`<[^>]+class=["'][^"']*cards-block-column--article__content-${suffix}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`).exec(body)?.[1]?.replace(/<[^>]*>/g," ").trim();
 const depart=text("dates--start"),ret=text("dates--end");
 const iatas=[...body.matchAll(/<span\b[^>]*class=["']iata["'][^>]*>\s*([A-Z]{3})\s*<\/span>/g)].map(m=>m[1]);
 const price=text("price")?.match(/^(\d+(?:[.,]\d{1,2})?)\s*€$/);
 if(iatas[0]!=="MAD"||iatas[1]!=="TLV"||!depart||!ret||!validDate(depart)||!validDate(ret)||ret<=depart||depart<now.toISOString().slice(0,10)||!body.includes("Return flights from")||!price)continue;
 const amount=Number(price[1]!.replace(",","."));if(!(amount>0))continue;
 fares.push({airline:"IB",origin:"MAD",destination:"TLV",departDate:depart,returnDate:ret,amount,currency:"EUR",structure:"roundtrip",sourceUrl:IBERIA_PAGE,checkedAt:now.toISOString(),pricing:"published_advertisement"});
 if(fares.length>500)throw new Error("Too many public fares");
 }
 return fares;
}
