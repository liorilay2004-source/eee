/**
 * Loads the extension's shared scripts the way the browser does (in manifest order, each attaching itself to
 * globalThis[Symbol.for("eee.extension")]) and the committed place index. Not a test file itself (the test glob is test/*.test.mjs).
 */
import { readFileSync } from "node:fs";

await import("../lib/text.js");
await import("../lib/dates.js");
await import("../lib/places.js");
await import("../lib/tfs.js");
await import("../lib/query.js");
await import("../lib/view.js");
await import("../lib/settings.js");
await import("../lib/api.js");

/** @type {any} */
export const EEE = /** @type {any} */ (globalThis)[Symbol.for("eee.extension")];
export const EXT = new URL("../", import.meta.url);
export const read = (/** @type {string} */ rel) => readFileSync(new URL(rel, EXT), "utf8");
export const INDEX = JSON.parse(read("data/index.json"));
/** A fixed "today" for every test: 30 September 2026 (a Wednesday). */
export const TODAY = "2026-09-30";
export const CTX = Object.freeze({ today: TODAY, defaultOrigin: "TLV" });
export const fixture = (/** @type {string} */ name) => JSON.parse(read(`test/fixtures/${name}`));

/** "ROUTE TLV-ATH 2026-11", "EXPLORE TLV 2026-10" or "null": compact, readable assertions. */
export function summary(/** @type {any} */ lookup) {
  if (!lookup) return "null";
  if (lookup.kind === "explore") return `EXPLORE ${lookup.origin} ${lookup.month}`;
  const dates = [lookup.depart, lookup.ret].filter(Boolean).join(" ");
  return `ROUTE ${lookup.origin}-${lookup.destination} ${lookup.month}${dates ? ` ${dates}` : ""}`;
}

export const analyze = (/** @type {string} */ q, /** @type {any} */ ctx = CTX) => EEE.query.analyze(q, INDEX, ctx);

/**
 * A protobuf message encoder for hand-built Google Flights `tfs` fixtures.
 * Fields: [number, value] where value is a number (varint), a string (length-delimited UTF-8) or an array of fields
 * (a nested message).
 * @param {[number, number | string | any[]][]} fields
 * @returns {Uint8Array}
 */
export function encodeMessage(fields) {
  /** @type {number[]} */
  const out = [];
  const varint = (/** @type {number} */ n) => {
    let v = n;
    while (v >= 0x80) {
      out.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    out.push(v);
  };
  for (const [no, value] of fields) {
    if (typeof value === "number") {
      varint(no * 8);
      varint(value);
    } else {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : encodeMessage(/** @type {any} */ (value));
      varint(no * 8 + 2);
      varint(bytes.length);
      out.push(...bytes);
    }
  }
  return Uint8Array.from(out);
}

/** URL-safe base64 without padding, the way Google Flights writes `tfs`. */
export function toTfs(/** @type {Uint8Array} */ bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** One leg the way Google Flights encodes it: {2: date, 13: {1: 1, 2: from}, 14: {1: 1, 2: to}}. */
export const leg = (/** @type {string} */ date, /** @type {string} */ from, /** @type {string} */ to) =>
  /** @type {[number, any][]} */ ([
    [2, date],
    [13, [[1, 1], [2, from]]],
    [14, [[1, 1], [2, to]]],
  ]);

/** A whole round-trip search message around the given legs (the other fields mimic real ones). */
export const search = (/** @type {any[][]} */ legs) =>
  /** @type {[number, any][]} */ ([[1, 28], [2, 2], ...legs.map((l) => [3, l]), [8, 1], [9, 1], [14, 1], [16, [[1, 4294967295]]], [19, 1]]);
