import {aegeanCalendarUrl,parseAegeanCalendar,type AegeanCalendarTrip,type AegeanCalendarText} from "./aegean-lowfare";
import type {Env} from "./types";

/** Reads only ordinary public calendar DOM text; no security cookies or session data. */
export async function loadRenderedAegeanCalendar(browser:NonNullable<Env["BROWSER"]>,trip:AegeanCalendarTrip,now:Date) {
  const response=await browser.quickAction("content",{
    url:aegeanCalendarUrl(trip),gotoOptions:{waitUntil:"domcontentloaded",timeout:20000},
    waitForTimeout:4000,rejectResourceTypes:["image","font","media"],
  });
  if(!response.ok||!response.body)throw new Error("Aegean calendar rendering failed");
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
  try {for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>4_000_000)throw new Error("Calendar payload too large");chunks.push(part.value);}}
  finally {await reader.cancel();}
  const joined=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}
  const envelope=JSON.parse(new TextDecoder().decode(joined)) as {success?:unknown;result?:unknown};
  if(envelope.success!==true||typeof envelope.result!=="string")throw new Error("Invalid calendar rendering response");
  return parseAegeanCalendar(await extractAegeanCalendarText(envelope.result),trip,now);
}

export async function extractAegeanCalendarText(html:string):Promise<AegeanCalendarText> {
  if(new TextEncoder().encode(html).byteLength>4_000_000)throw new Error("Calendar payload too large");
  const text:AegeanCalendarText={outboundRows:[],inboundRows:[],outboundMonths:[],inboundMonths:[],summaries:[]};
  const handler=(rows:string[],max:number)=>{
    let index:number|null=null;
    return {
      element(e:Element){if(rows.length>=max)throw new Error("Too many calendar elements");index=rows.length;rows.push("");e.onEndTag(()=>{index=null;});},
      text(chunk:Text){if(index!==null){rows[index]+=chunk.text;if(rows[index]!.length>2000)throw new Error("Calendar text too large");}},
    };
  };
  await new HTMLRewriter()
    .on("#lowFareCalendar .outboundFares td",handler(text.outboundRows,42))
    .on("#lowFareCalendar .returnFares td",handler(text.inboundRows,42))
    .on("#lowFareCalendar .outboundFares li.selected",handler(text.outboundMonths,2))
    .on("#lowFareCalendar .returnFares li.selected",handler(text.inboundMonths,2))
    .on("#lowFareCalendar .tripOverview",handler(text.summaries,2))
    .transform(new Response(html)).text();
  return text;
}
