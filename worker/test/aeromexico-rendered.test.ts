import { describe, expect, it, vi } from "vitest";
import { AEROMEXICO_PAGE, loadRenderedAeromexico } from "../src/aeromexico-rendered";
const now = new Date("2026-10-08T00:00:00Z");
const fare = { __typename: "Fare", originAirportCode: "LAX", destinationAirportCode: "MEX", departureDate: "2027-06-02", returnDate: "2027-06-09", totalPrice: 431.63, currencyCode: "USD", travelClass: "MAIN_BASIC", flightType: "ROUND_TRIP" };
describe("bounded official Aeromexico rendering", () => {
  it("reads the observed dated cash fare with one fixed background navigation", async () => {
    const quickAction = vi.fn(async () => Response.json({ success: true, result: `<script id="__NEXT_DATA__">${JSON.stringify({ fares: [fare] })}</script>` }));
    expect(await loadRenderedAeromexico({quickAction}, now)).toMatchObject([{ airline: "AM", amount: 431.63, departDate: fare.departureDate, returnDate: fare.returnDate }]);
    expect(quickAction).toHaveBeenCalledExactlyOnceWith("content", expect.objectContaining({url: AEROMEXICO_PAGE, gotoOptions: {waitUntil: "networkidle2", timeout: 10000}}));
  });
  it("rejects unsuccessful envelopes and bounded oversized responses", async () => {
    await expect(loadRenderedAeromexico({quickAction: vi.fn(async () => Response.json({success:false,result:""}))},now)).rejects.toThrow("Invalid rendering response");
    await expect(loadRenderedAeromexico({quickAction: vi.fn(async () => new Response("x".repeat(4_000_001)))},now)).rejects.toThrow("too large");
    await expect(loadRenderedAeromexico({quickAction: vi.fn(async () => new Response("",{status:403}))},now)).rejects.toThrow("rendering failed");
  });
});
