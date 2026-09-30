/**
 * Every request to the API must carry the private-use lock's key, and only api/client.ts adds it: apiCall() for the API's
 * routes, checkAccess() for the lock's own check. A fetch() anywhere else, or a new one in client.ts that does not send the
 * key (say, a call another branch added as `fetch(...)` + `readJson(response)`, kept through a merge), would go out without
 * it and answer 401 once the lock is on. This fails first. (Review finding ux-compat 12.)
 */
import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true });

/** The source without comments, so prose that mentions fetch() is not mistaken for a call. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** Each call `name(` in a file, with the rest of its line (enough to see what it sends). */
function callsOf(name: string): { file: string; line: string }[] {
  const pattern = new RegExp(`(?<![\\w.$]|function\\s)${name}\\s*(<[^>]*>)?\\(`);
  const found: { file: string; line: string }[] = [];
  for (const [file, source] of Object.entries(sources)) {
    for (const line of code(source).split("\n")) {
      if (pattern.test(line) || new RegExp(`\\.\\s*${name}\\s*\\(`).test(line)) found.push({ file, line: line.trim() });
    }
  }
  return found;
}

describe("API requests go through the client that adds the access key", () => {
  it("the guard sees the whole app", () => {
    expect(Object.keys(sources)).toContain("../api/client.ts");
    expect(Object.keys(sources).length).toBeGreaterThan(20);
  });

  it("fetch() is called only in api/client.ts, and every call there sends withAccessKey(...)", () => {
    const calls = callsOf("fetch");
    expect(calls.map((c) => c.file)).toEqual(["../api/client.ts", "../api/client.ts"]); // apiCall and checkAccess
    for (const call of calls) expect(call.line, call.line).toMatch(/headers: withAccessKey\(key\b/);
  });

  it("readJson() is only used by apiCall, with the key that apiCall sent", () => {
    const calls = callsOf("readJson").filter((c) => !/async function readJson/.test(c.line));
    expect(calls).toEqual([{ file: "../api/client.ts", line: "return readJson<T>(response, key);" }]);
  });
});
