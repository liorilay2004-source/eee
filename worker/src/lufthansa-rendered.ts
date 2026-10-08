import type {Env} from "./types";
import {loadRenderedLhgAnchors} from "./brussels-rendered";
import {parseLufthansaAdvertisements} from "./lufthansa-advertisements";
export const LUFTHANSA_ATHENS_TEL_AVIV_PAGE="https://www.lufthansa.com/lhg/gr/en/o-d/cy-cy/athens-tel-aviv";
export async function loadRenderedLufthansa(browser:NonNullable<Env["BROWSER"]>,now:Date) {
  return parseLufthansaAdvertisements(await loadRenderedLhgAnchors(browser,LUFTHANSA_ATHENS_TEL_AVIV_PAGE),now);
}
