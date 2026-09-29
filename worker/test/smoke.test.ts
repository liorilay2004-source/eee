import { expect, it } from "vitest";
import type { Offer } from "../src/types";

it("toolchain works", () => {
  const o: Pick<Offer, "source"> = { source: "travelpayouts" };
  expect(o.source).toBe("travelpayouts");
});
