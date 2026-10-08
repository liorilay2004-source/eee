import {parseLhgAdvertisements} from "./brussels-advertisements";
/** Observed Swiss market uses CHF, not euros; advertisements depart from Zurich. */
export function parseSwissAdvertisements(anchors:readonly {text:string;url:string}[],now:Date) {
 return parseLhgAdvertisements(anchors,{origin:"ZRH",destination:"TLV"},now,{origin:"https://www.swiss.com",market:"ch",currency:"CHF"});
}
