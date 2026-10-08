import {loadRenderedLhgAnchors} from "./brussels-rendered";
import {parseAustrianAdvertisements} from "./austrian-advertisements";
import type {Env} from "./types";

export const AUSTRIAN_TEL_AVIV_PAGE="https://www.austrian.com/lhg/at/en/o-d/cy-cy/vienna-tel-aviv";

export async function loadRenderedAustrian(browser:NonNullable<Env["BROWSER"]>,now:Date) {
  return parseAustrianAdvertisements(await loadRenderedLhgAnchors(browser,AUSTRIAN_TEL_AVIV_PAGE),now);
}
