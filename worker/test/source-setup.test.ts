import { describe, expect, it } from "vitest";
import { sourceSetup } from "../src/source-setup";
import type { Env } from "../src/types";

const baseEnv = {} as Env;

describe("sourceSetup", () => {
  it("lists future official API connectors without exposing values", () => {
    const data = sourceSetup(baseEnv, new Date("2026-10-01T00:00:00.000Z"));
    expect(data.generatedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(data.connectors.map((c) => c.id)).toEqual(expect.arrayContaining(["duffel", "amadeus", "lufthansa_group", "turkish", "airfrance_klm", "british_airways", "emirates", "qatar"]));
    expect(data.summary.configured).toBe(0);
    expect(data.connectors.find((c) => c.id === "duffel")?.missingSecrets).toEqual(["DUFFEL_API_TOKEN"]);
    expect(JSON.stringify(data)).not.toContain("secret-value");
  });

  it("marks a connector configured only when all of its secrets exist", () => {
    const partial = sourceSetup({ ...baseEnv, AMADEUS_CLIENT_ID: "id" }, new Date());
    expect(partial.connectors.find((c) => c.id === "amadeus")?.status).toBe("missing_credentials");
    const ready = sourceSetup({ ...baseEnv, AMADEUS_CLIENT_ID: "id", AMADEUS_CLIENT_SECRET: "secret-value", DUFFEL_API_TOKEN: "duffel-secret" }, new Date());
    expect(ready.connectors.find((c) => c.id === "amadeus")?.status).toBe("configured");
    expect(ready.connectors.find((c) => c.id === "duffel")?.status).toBe("configured");
    expect(JSON.stringify(ready)).not.toContain("secret-value");
    expect(JSON.stringify(ready)).not.toContain("duffel-secret");
  });
});
