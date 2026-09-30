/** Settings in chrome.storage.sync: defaults, damaged values, per-site muting. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EEE } from "./helpers.mjs";

const S = EEE.settings;

/** A fake chrome.storage area. */
function area(initial = {}) {
  /** @type {Record<string, unknown>} */
  const data = { ...initial };
  return {
    data,
    get: async (/** @type {string} */ key) => (key in data ? { [key]: data[key] } : {}),
    set: async (/** @type {Record<string, unknown>} */ items) => void Object.assign(data, items),
  };
}

describe("settings", () => {
  it("defaults: on, TLV, shown everywhere", () => {
    assert.deepEqual(S.sanitize(undefined), { enabled: true, origin: "TLV", hiddenOn: [] });
    assert.deepEqual(S.sanitize("junk"), { enabled: true, origin: "TLV", hiddenOn: [] });
  });

  it("keeps only known values", () => {
    assert.deepEqual(S.sanitize({ enabled: false, origin: "ETM", hiddenOn: ["flights", "x", "search", "flights"] }), { enabled: false, origin: "ETM", hiddenOn: ["search", "flights"] });
    assert.deepEqual(S.sanitize({ enabled: "no", origin: "HFA", hiddenOn: "search" }), { enabled: true, origin: "TLV", hiddenOn: [] });
  });

  it("showsOn: the switch and the per-site mute", () => {
    const s = S.sanitize({ hiddenOn: ["search"] });
    assert.equal(S.showsOn(s, "search"), false);
    assert.equal(S.showsOn(s, "flights"), true);
    assert.equal(S.showsOn(S.sanitize({ enabled: false }), "flights"), false);
    assert.equal(S.showsOn(s, null), false);
  });

  it("load and save through a storage area; storage trouble means defaults", async () => {
    const a = area();
    assert.deepEqual(await S.load(a), S.sanitize(null));
    await S.save(a, { enabled: false, origin: "ETM", hiddenOn: ["flights"] });
    assert.deepEqual(a.data[S.KEY], { enabled: false, origin: "ETM", hiddenOn: ["flights"] });
    assert.deepEqual(await S.load(a), { enabled: false, origin: "ETM", hiddenOn: ["flights"] });
    const broken = { get: async () => { throw new Error("gone"); } };
    assert.deepEqual(await S.load(/** @type {any} */ (broken)), S.sanitize(null));
    assert.deepEqual(await S.load(undefined), S.sanitize(null));
  });
});
