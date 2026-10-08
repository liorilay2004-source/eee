import {parsePublishedFares,type PublishedFare} from "./sources/published-fares";
import type {Env} from "./types";
export const TURKISH_ATHENS_PAGE="https://www.turkishairlines.com/en/flights-from-istanbul-to-athens";
/** Public Economy advertisements only; the publisher does not identify an operating carrier. */
export async function loadRenderedTurkish(browser:NonNullable<Env["BROWSER"]>,now:Date):Promise<PublishedFare[]> {
 const response=await browser.quickAction("content",{url:TURKISH_ATHENS_PAGE,gotoOptions:{waitUntil:"domcontentloaded",timeout:20000},waitForTimeout:4000,rejectResourceTypes:["image","font","media"]});
 if(!response.ok||!response.body)throw new Error("Turkish public page rendering failed");
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>4000000)throw new Error("Turkish rendering payload too large");chunks.push(part.value);}}finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 const envelope=JSON.parse(new TextDecoder().decode(bytes)) as {success?:unknown;result?:unknown};
 if(envelope.success!==true||typeof envelope.result!=="string")throw new Error("Invalid Turkish rendering response");
 return parsePublishedFares(envelope.result,{airline:"TK",origin:"IST",destination:"ATH",sourceUrl:TURKISH_ATHENS_PAGE,now});
}
