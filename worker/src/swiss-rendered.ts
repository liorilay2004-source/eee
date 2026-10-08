import { loadRenderedLhgAnchors } from "./brussels-rendered";
import { parseSwissAdvertisements } from "./swiss-advertisements";
import type { Env } from "./types";

export const SWISS_TEL_AVIV_PAGE = "https://www.swiss.com/lhg/ch/en/o-d/cy-cy/zurich-tel-aviv";

/** Public dated advertisements, preserving their direction and original CHF. */
export async function loadRenderedSwiss(browser: NonNullable<Env["BROWSER"]>, now: Date) {
  return parseSwissAdvertisements(await loadRenderedLhgAnchors(browser, SWISS_TEL_AVIV_PAGE), now);
}
