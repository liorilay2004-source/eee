import { describe, expect, it, vi } from "vitest";
import { collectRenderedAeromexico, AEROMEXICO_PAGE } from "../src/aeromexico-rendered";
import { createAeromexicoCachedSource } from "../src/sources/aeromexico-cached";
import type { Env } from "../src/types";
const now = new Date("2026-10-08T00:00:00Z");
const fare = { __typename:"Fare", originAirportCode:"LAX", destinationAirportCode:"MEX", departureDate:"2026-12-07", returnDate:"2026-12-14", totalPrice:419.17, currencyCode:"USD", travelClass:"MAIN_BASIC", flightType:"ROUND_TRIP" };
const html = `<script id="__NEXT_DATA__">${JSON.stringify({ fares:[fare] })}</script>`;
describe("background Aeromexico rendering", () => {
  it("unwraps actual HTML and persists exact fares with one bounded render", async () => {
    const quickAction = vi.fn(async () => Response.json({success:true,result:html}));
    const savePrices = vi.fn(); const put = vi.fn();
    const env = {AEROMEXICO_RENDERED_ENABLED:"true",BROWSER:{quickAction}} as unknown as Env;
    expect(await collectRenderedAeromexico({env,repo:{savePrices},now,cache:{put,get:vi.fn()}})).toMatchObject({ok:true,fares:1,saved:1});
    expect(quickAction).toHaveBeenCalledTimes(1);
    expect(quickAction).toHaveBeenCalledWith("content",expect.objectContaining({url:AEROMEXICO_PAGE,gotoOptions:{waitUntil:"networkidle2",timeout:10000}}));
    expect(savePrices.mock.calls[0]![0]).toMatchObject([{source:"aeromexico",priceAmount:419.17,departDate:fare.departureDate,returnDate:fare.returnDate}]);
    expect(put).toHaveBeenCalledTimes(1);
  });
  it("skips disabled source and contains rendering failures", async () => {
    const quickAction = vi.fn().mockRejectedValue(new Error("render failure"));
    const savePrices = vi.fn(); const env = {BROWSER:{quickAction}} as unknown as Env;
    expect(await collectRenderedAeromexico({env,repo:{savePrices},now})).toMatchObject({skipped:true});
    expect(quickAction).not.toHaveBeenCalled();
    expect(await collectRenderedAeromexico({env:{...env,AEROMEXICO_RENDERED_ENABLED:"true"},repo:{savePrices},now})).toMatchObject({ok:false});
    expect(savePrices).not.toHaveBeenCalled();
  });
  it("user search never renders and matches cached dates exactly", async () => {
    const source = createAeromexicoCachedSource({put:vi.fn(),get:vi.fn(async () => ({expires:now.getTime()+600000,fares:[{airline:"AM",origin:"LAX",destination:"MEX",departDate:fare.departureDate,returnDate:fare.returnDate,amount:419.17,currency:"USD",structure:"roundtrip",sourceUrl:AEROMEXICO_PAGE,checkedAt:now.toISOString(),pricing:"published_advertisement"}]})) as any});
    const q = {origin:"LAX",destination:"MEX",departDate:fare.departureDate,returnDate:fare.returnDate,party:{adults:1,children:0,infants:0}};
    expect(await source.quote(q)).toMatchObject([{source:"aeromexico",priceAmount:419.17}]);
    expect(await source.quote({...q,returnDate:"2026-12-15"})).toEqual([]);
    expect(source.callCount()).toBe(0); expect(source.nextQuoteRequests!(q)).toBe(0);
  });
});


