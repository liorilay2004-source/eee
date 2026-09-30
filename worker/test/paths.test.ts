import { describe, expect, it } from "vitest";
import { stripTrailingSlashes } from "../src/paths";

/** What the router and the CORS origin used before (a regex that is quadratic on long runs of slashes). */
const viaRegex = (s: string) => s.replace(/\/+$/, "");

describe("stripTrailingSlashes", () => {
  it("drops every trailing slash and nothing else", () => {
    expect(stripTrailingSlashes("/api/deals/")).toBe("/api/deals");
    expect(stripTrailingSlashes("/api/deals///")).toBe("/api/deals");
    expect(stripTrailingSlashes("/api/deals")).toBe("/api/deals");
    expect(stripTrailingSlashes("//api//deals")).toBe("//api//deals");
    expect(stripTrailingSlashes("/")).toBe("");
    expect(stripTrailingSlashes("///")).toBe("");
    expect(stripTrailingSlashes("")).toBe("");
    expect(stripTrailingSlashes("https://eee-web-bly.pages.dev/")).toBe("https://eee-web-bly.pages.dev");
  });

  it("matches the old regex on every string of up to 8 characters over { '/', 'a', '%', '.' }", () => {
    const alphabet = ["/", "a", "%", "."];
    let checked = 0;
    const walk = (s: string) => {
      expect(stripTrailingSlashes(s)).toBe(viaRegex(s));
      checked++;
      if (s.length < 8) for (const c of alphabet) walk(s + c);
    };
    walk("");
    expect(checked).toBe((4 ** 9 - 1) / 3); // 1 + 4 + ... + 4^8
  });

  it("stays linear on a long run of slashes that does not end the string (the regex took seconds here)", () => {
    const hostile = "/".repeat(200_000) + "x";
    const t0 = performance.now();
    expect(stripTrailingSlashes(hostile)).toBe(hostile);
    expect(stripTrailingSlashes("/".repeat(200_000))).toBe("");
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
