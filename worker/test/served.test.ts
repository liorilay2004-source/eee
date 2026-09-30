import { describe, expect, it } from "vitest";
import cities from "../src/airports/cities.json";
import served from "../src/airports/served.json";
import { directSeen, noScheduledService, orderPairsByService } from "../src/airports/served";

const p = (origin: string, dest: string) => ({ origin, dest });
const bundled = new Set((cities as Array<{ airports: Array<{ iata: string }> }>).flatMap((c) => c.airports.map((a) => a.iata)));

describe("bundled route hints (src/airports/served.json)", () => {
  it("has a plausible TLV direct list: IATA codes, sorted, unique, without TLV itself", () => {
    const list = served.directFrom.TLV;
    expect(list.length).toBeGreaterThanOrEqual(30);
    for (const code of list) expect(code).toMatch(/^[A-Z]{3}$/);
    expect([...list].sort()).toEqual(list);
    expect(new Set(list).size).toBe(list.length);
    expect(list).not.toContain("TLV");
    for (const hub of ["LHR", "ATH", "LCA", "JFK", "ETM"]) expect(list, hub).toContain(hub);
  });

  it("records the flight-board window it came from", () => {
    expect(served.window.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(served.window.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(served.window.from <= served.window.to).toBe(true);
    expect(served.window.flights).toBeGreaterThan(100);
  });

  it("prunes only bundled airports, never the Israeli airports people fly from", () => {
    for (const code of served.noScheduledService) expect(bundled.has(code), code).toBe(true);
    expect(served.noScheduledService).toContain("VDA");
    for (const code of ["TLV", "ETM", "HFA"]) expect(noScheduledService(code), code).toBe(false);
  });
});

describe("directSeen / noScheduledService", () => {
  it("is direction-free and case-insensitive", () => {
    expect(directSeen("TLV", "LTN")).toBe(true);
    expect(directSeen("ltn", "tlv")).toBe(true);
    expect(directSeen("TLV", "LCY")).toBe(false);
    expect(directSeen("LHR", "CDG")).toBe(false); // no data away from Israel: never claimed
    expect(noScheduledService("vda")).toBe(true);
    expect(noScheduledService("ZZZ")).toBe(false); // unknown is never pruned
  });
});

describe("orderPairsByService", () => {
  it("keeps the primary first and moves direct pairs ahead of the rest, stable within each group", () => {
    const input = [p("TLV", "LIN"), p("TLV", "LCY"), p("TLV", "MXP"), p("TLV", "SEN"), p("TLV", "BGY")];
    expect(orderPairsByService(input)).toEqual([p("TLV", "LIN"), p("TLV", "MXP"), p("TLV", "BGY"), p("TLV", "LCY"), p("TLV", "SEN")]);
  });

  it("drops pairs touching an airport without scheduled service when others remain, and the next pair becomes primary", () => {
    expect(orderPairsByService([p("VDA", "BCN"), p("ETM", "BCN"), p("VDA", "AQJ")])).toEqual([p("ETM", "BCN")]);
  });

  it("keeps everything when every pair would be dropped (the user asked for that airport)", () => {
    const input = [p("VDA", "BCN"), p("VDA", "GRO")];
    expect(orderPairsByService(input)).toEqual(input);
  });

  it("never adds pairs, never mutates its input, and handles empty and single lists", () => {
    const input = [p("TLV", "LCY"), p("TLV", "SEN"), p("TLV", "LHR")];
    const copy = input.map((x) => ({ ...x }));
    const out = orderPairsByService(input);
    expect(input).toEqual(copy);
    expect(out).toHaveLength(3);
    expect(new Set(out)).toEqual(new Set(input));
    expect(orderPairsByService([])).toEqual([]);
    expect(orderPairsByService([p("TLV", "BCN")])).toEqual([p("TLV", "BCN")]);
  });

  it("leaves pairs without any Israeli airport in their original order", () => {
    const input = [p("LHR", "CDG"), p("LHR", "BVA"), p("LGW", "ORY"), p("STN", "CDG")];
    expect(orderPairsByService(input)).toEqual(input);
  });
});
