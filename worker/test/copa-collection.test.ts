import { describe, expect, it, vi } from "vitest";
import { collectRenderedCopa, COPA_PAGE } from "../src/copa-rendered";
import { createCopaCachedSource } from "../src/sources/copa-cached";
import type { Env } from "../src/types";
const now = new Date("2026-10-08T00:00:00Z");
const fare = { __typename:"Fare", originAirportCode:"PTY", destinationAirportCode:"MCO", departureDate:"2027-03-15", returnDate:"2027-03-19", totalPrice:619.99, currencyCode:"USD", travelClass:"Economy", flightType:"ROUND_TRIP" };
const html = `<script id="__NEXT_DATA__">${JSON.stringify({ fares:[fare] })}</script>`;
describe("background Copa rendering", () => {
  it("unwraps actual HTML and persists exact fares with one bounded render", async () => {
    const quickAction = vi.fn(async () => Response.json({success:true,result:html}));
    const savePrices = vi.fn(); const put = vi.fn();
    const env = {COPA_RENDERED_ENABLED:"true",BROWSER:{quickAction}} as unknown as Env;
    expect(await collectRenderedCopa({env,repo:{savePrices},now,cache:{put,get:vi.fn()}})).toMatchObject({ok:true,fares:1,saved:1});
    expect(quickAction).toHaveBeenCalledTimes(1);
    expect(quickAction).toHaveBeenCalledWith("content",expect.objectContaining({url:COPA_PAGE,gotoOptions:{waitUntil:"networkidle2",timeout:10000}}));
    expect(savePrices.mock.calls[0]![0]).toMatchObject([{source:"copa",priceAmount:619.99,departDate:fare.departureDate,returnDate:fare.returnDate}]);
    expect(put).toHaveBeenCalledTimes(1);
  });
  it("skips disabled source and contains rendering failures", async () => {
    const quickAction = vi.fn().mockRejectedValue(new Error("render failure"));
    const savePrices = vi.fn(); const env = {BROWSER:{quickAction}} as unknown as Env;
    expect(await collectRenderedCopa({env,repo:{savePrices},now})).toMatchObject({skipped:true});
    expect(quickAction).not.toHaveBeenCalled();
    expect(await collectRenderedCopa({env:{...env,COPA_RENDERED_ENABLED:"true"},repo:{savePrices},now})).toMatchObject({ok:false});
    expect(savePrices).not.toHaveBeenCalled();
  });
  it("user search never renders and matches cached dates exactly", async () => {
    const source = createCopaCachedSource({put:vi.fn(),get:vi.fn(async () => ({expires:now.getTime()+600000,fares:[{airline:"CM",origin:"PTY",destination:"MCO",departDate:fare.departureDate,returnDate:fare.returnDate,amount:619.99,currency:"USD",structure:"roundtrip",sourceUrl:COPA_PAGE,checkedAt:now.toISOString(),pricing:"published_advertisement"}]})) as any});
    const q = {origin:"PTY",destination:"MCO",departDate:fare.departureDate,returnDate:fare.returnDate,party:{adults:1,children:0,infants:0}};
    expect(await source.quote(q)).toMatchObject([{source:"copa",priceAmount:619.99}]);
    expect(await source.quote({...q,returnDate:"2026-12-15"})).toEqual([]);
    expect(source.callCount()).toBe(0); expect(source.nextQuoteRequests!(q)).toBe(0);
  });
});
