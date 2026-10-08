import { parseLhgAdvertisements } from "./brussels-advertisements";

/** Observed Austrian calendar links describe VIE–TLV return trips in EUR. */
export function parseAustrianAdvertisements(anchors:readonly {text:string;url:string}[],now:Date) {
  return parseLhgAdvertisements(anchors,{origin:"VIE",destination:"TLV"},now,{origin:"https://www.austrian.com",market:"at"});
}
