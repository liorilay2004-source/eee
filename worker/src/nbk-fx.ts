export const NBK_RATES_URL='https://nationalbank.kz/rss/rates_all.xml';
/** Official KZT per quoted quantity of ILS; reciprocal yields ILS per one KZT. */
export function parseNbkKzt(xml:string,now:Date):{date:string;rateToIls:number}|null{
 if(xml.length>32000||!Number.isFinite(now.getTime())||/<!DOCTYPE|<!ENTITY/i.test(xml))return null;
 const items=[...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];if(items.length>100)return null;
 const ils=items.filter(item=>/<title>\s*ILS\s*<\/title>/.test(item[1]??''));if(ils.length!==1)return null;
 const item=ils[0]![1]??'';
 const value=/<description>\s*(\d+(?:\.\d+)?)\s*<\/description>/.exec(item)?.[1];
 const quantity=/<quant>\s*(\d+)\s*<\/quant>/.exec(item)?.[1];
 const match=/<pubDate>\s*(\d{2})\.(\d{2})\.(\d{4})\s*<\/pubDate>/.exec(item);
 if(!value||!quantity||!match)return null;
 const price=Number(value),units=Number(quantity),date=`${match[3]}-${match[2]}-${match[1]}`;
 if(!Number.isFinite(price)||price<=0||price>1e9||!Number.isSafeInteger(units)||units<1||units>1000||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)return null;
 const age=(Date.parse(now.toISOString().slice(0,10))-Date.parse(date))/86400000;
 if(age<0||age>7)return null;
 return {date,rateToIls:units/price};
}
