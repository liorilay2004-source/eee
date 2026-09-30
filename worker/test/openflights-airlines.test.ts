import { describe, expect, it } from "vitest";
import raw from "../src/airlines/openflights-airlines.json";
import { airlineByDesignator, airlineFromTokens, openFlightsCount } from "../src/airlines/openflights";

describe("OpenFlights pasted airline reference", () => {
  it("keeps a large local airline table with useful designators", () => {
    expect(openFlightsCount()).toBeGreaterThan(6000);
    expect(raw.count).toBe(openFlightsCount());
    expect(airlineByDesignator("LH")?.name).toBe("Lufthansa");
    expect(airlineByDesignator("DLH")?.iata).toBe("LH");
    expect(airlineByDesignator("LY")?.name).toBe("El Al Israel Airlines");
  });

  it("detects an airline from pasted-link tokens", () => {
    expect(airlineFromTokens(["flight", "lufthansa", "tlv", "fra"])?.iata).toBe("LH");
    expect(airlineFromTokens(["carrier", "DLH"])?.name).toBe("Lufthansa");
  });
});
