import {parseLhgAdvertisements} from "./brussels-advertisements";
/** Verified ATH–TLV marketing page only; never invert it into TLV–ATH fares. */
export function parseLufthansaAdvertisements(anchors: readonly {text:string;url:string}[],now:Date) {
  return parseLhgAdvertisements(anchors,{origin:"ATH",destination:"TLV"},now,{origin:"https://www.lufthansa.com",market:"gr"});
}
