import { describe, expect, it, vi } from "vitest";
import { COPA_PAGE, loadRenderedCopa } from "../src/copa-rendered";
const now = new Date("2026-10-08T00:00:00Z");
const fare = { __typename: "Fare", originAirportCode: "PTY", destinationAirportCode: "MCO", departureDate: "2027-03-15", returnDate: "2027-03-19", totalPrice: 619.99, currencyCode: "USD", travelClass: "Economy", flightType: "ROUND_TRIP" };
describe("bounded official Copa rendering", () => {
  it("reads the observed dated cash fare with one fixed background navigation", async () => {
    const quickAction = vi.fn(async () => Response.json({ success: true, result: `<script id="__NEXT_DATA__">${JSON.stringify({ fares: [fare] })}</script>` }));
    expect(await loadRenderedCopa({quickAction}, now)).toMatchObject([{ airline: "CM", amount: 619.99, departDate: fare.departureDate, returnDate: fare.returnDate }]);
    expect(quickAction).toHaveBeenCalledExactlyOnceWith("content", expect.objectContaining({url: COPA_PAGE, gotoOptions: {waitUntil: "networkidle2", timeout: 10000}}));
  });
  it("rejects unsuccessful envelopes and bounded oversized responses", async () => {
    await expect(loadRenderedCopa({quickAction: vi.fn(async () => Response.json({success:false,result:""}))},now)).rejects.toThrow("Invalid rendering response");
    await expect(loadRenderedCopa({quickAction: vi.fn(async () => new Response("x".repeat(4_000_001)))},now)).rejects.toThrow("too large");
    await expect(loadRenderedCopa({quickAction: vi.fn(async () => new Response("",{status:403}))},now)).rejects.toThrow("rendering failed");
  });
});
