/**
 * Privacy and page-content guarantees, checked in the source:
 *  - Google content scripts never make a network request and read only location/title;
 *  - the user-activated airline listener reads a visible fare candidate and sends only a small tuple to local extension storage;
 *  - the only network code is lib/api.js; the popup and service worker read packaged JSON locally.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CTX, EEE, INDEX, read } from "./helpers.mjs";

const manifest = JSON.parse(read("manifest.json"));
const contentFiles = /** @type {string[]} */ (manifest.content_scripts[0].js);
const code = (/** @type {string} */ f) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("content scripts", () => {
  it("never use the network", () => {
    for (const f of contentFiles) {
      assert.doesNotMatch(code(f), /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|new\s+Image\s*\(|importScripts/, f);
    }
  });

  it("never read the page: no selectors, no text or HTML reads, no cookies or page storage", () => {
    for (const f of contentFiles) {
      assert.doesNotMatch(code(f), /querySelector|getElementById|getElementsBy|innerText|innerHTML|outerHTML|document\.body|document\.cookie|localStorage|sessionStorage|indexedDB|MutationObserver|getSelection|document\.forms|document\.links/, f);
    }
  });

  it("read only the address and, on Google Flights, the title", () => {
    const main = code("content/main.js");
    assert.match(main, /location\.href/);
    assert.match(main, /document\.title/);
    assert.doesNotMatch(main, /document\.referrer|history\.state|navigator\.(?!sendMessage)/);
  });

  it("the user-activated airline listener reads visible price text only, without forms, cookies or network APIs", () => {
    const listener = code("content/site-listener.js");
    assert.match(listener, /new MutationObserver/);
    assert.match(listener, /document\.body\.innerText/);
    assert.match(listener, /chrome\.runtime\.sendMessage\(\{ type: "siteObservation", observation: candidate \}\)/);
    assert.doesNotMatch(listener, /document\.forms|document\.cookie|localStorage|sessionStorage|fetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
    assert.match(listener, /clearTimeout\(timer\)/); // event debounce, no recurring timer
    assert.doesNotMatch(listener, /setInterval\s*\(/);
  });

  it("the card writes text only (textContent), never markup", () => {
    const popup = code("content/popup.js");
    assert.match(popup, /textContent/);
    assert.match(popup, /attachShadow\(\{ mode: "closed" \}\)/);
    assert.doesNotMatch(popup, /\.focus\(/); // never steals focus
  });

  it("the card's host is a plain <div>: a page cannot pre-define it and reach the closed root through ElementInternals", () => {
    // Review finding: with an autonomous custom element ("eee-fare-card") as host, a page that defined that name first
    // got the closed shadow root from attachInternals() and rewrote the booking link.
    const popup = code("content/popup.js");
    assert.match(popup, /const host = document\.createElement\("div"\);/);
    assert.doesNotMatch(popup, /createElement\(\s*["'`][a-z]+-[a-z-]*["'`]/); // no hyphenated (custom element) tag anywhere
    assert.doesNotMatch(popup, /customElements|attachInternals|\bis:\s*["']/);
  });

  it("Esc, × and 'don't show again' act on real input only: a page's synthetic event cannot close or mute", () => {
    const popup = code("content/popup.js");
    assert.match(popup, /const onKey = \(\s*e\) => \{[^}]*e\.isTrusted/); // (code() drops the JSDoc cast)
    const clicks = [...popup.matchAll(/\.addEventListener\("click", \(e\) => \{\s*if \(!e\.isTrusted\) return;/g)];
    assert.equal(clicks.length, 2); // × and mute
    assert.equal([...popup.matchAll(/addEventListener\("click"/g)].length, 2);
  });

  it("the shared namespace is a symbol-keyed global: a page element named or id'd 'EEE' cannot shadow it", () => {
    // Review finding: <form name="EEE"><input name="started"></form> made the content scripts see a form element as
    // their namespace and stop.
    const runtime = ["background.js", "popup/popup.js", ...contentFiles];
    for (const f of runtime) {
      assert.doesNotMatch(read(f), /globalThis\.EEE|window\.EEE|self\.EEE/, f);
      assert.match(read(f), /\[Symbol\.for\("eee\.extension"\)\]/, f);
    }
  });

  it("uses activeTab and scripting only in the toolbar popup, never broad browsing APIs", () => {
    for (const f of [...contentFiles, "content/site-listener.js", "background.js"]) {
      assert.doesNotMatch(code(f), /chrome\.(tabs|cookies|history|webRequest|scripting|identity|downloads|bookmarks|management|debugger)\b/, f);
    }
    assert.match(code("popup/popup.js"), /chrome\.tabs\.query\(\{ active: true, currentWindow: true \}\)/);
    assert.match(code("popup/popup.js"), /chrome\.scripting\.executeScript/);
    assert.doesNotMatch(code("popup/popup.js"), /chrome\.(cookies|history|webRequest|identity|downloads|bookmarks|management|debugger)\b/);
  });
});

describe("network code", () => {
  it("only lib/api.js calls the API; extension contexts fetch only packaged JSON locally", () => {
    const bg = code("background.js");
    const fetches = [...bg.matchAll(/\bfetch\s*\(([^)]*)/g)].map((m) => /** @type {string} */ (m[1]).trim());
    assert.deepEqual(fetches, ["url, init", 'chrome.runtime.getURL("data/index.json"', 'chrome.runtime.getURL("data/airline-sites.json"']);
    const api = code("lib/api.js");
    // Two call sites, both to the API: the lookup, and the popup's key check (through the service worker).
    assert.deepEqual([...api.matchAll(/\bfetch\s*\(/g)].length, 2);
    assert.match(api, /deps\.fetch\(buildUrl\(req\)/);
    assert.match(api, /deps\.fetch\(new URL\(AUTH_CHECK_PATH, API_BASE\)\.toString\(\)/);
    assert.deepEqual([...code("popup/popup.js").matchAll(/\bfetch\s*\(([^)]*)/g)].map((m) => m[1].trim()), ['chrome.runtime.getURL("data/airline-sites.json"']);
    for (const f of [...contentFiles, "content/site-listener.js"]) assert.doesNotMatch(code(f), /\bfetch\s*\(/, f);
  });

  it("no analytics, trackers or error reporters anywhere", () => {
    for (const f of [...contentFiles, "content/site-listener.js", "background.js", "lib/api.js", "popup/popup.js", "popup/popup.html"]) {
      assert.doesNotMatch(read(f), /google-analytics|googletagmanager|gtag\(|sentry|mixpanel|segment\.io|amplitude|posthog|hotjar|datadog|clarity\.ms|telemetry/i, f);
    }
  });

  it("the page -> service worker request holds four fields, whatever the user typed", () => {
    const lookup = /** @type {any} */ (EEE.query.analyze("טיסות זולות לאתונה 10/11 עם הילדים של משה כהן", INDEX, CTX));
    assert.deepEqual(EEE.query.apiRequest(lookup), { kind: "calendar", origin: "TLV", destination: "ATH", month: "2026-11" });
    const explore = /** @type {any} */ (EEE.query.analyze("טיסות זולות בדצמבר", INDEX, CTX));
    assert.deepEqual(EEE.query.apiRequest(explore), { kind: "explore", origin: "TLV", month: "2026-12" });
    const main = code("content/main.js");
    assert.match(main, /send\(\{ type: "lookup", req \}\)/);
    assert.match(main, /const req = Q\.apiRequest\(lookup\)/);
  });

  it("the airline listener sends only extracted fare fields, and the background stores no page URL or content", () => {
    const listener = code("content/site-listener.js");
    for (const field of ["origin", "destination", "departDate", "returnDate", "priceAmount", "currency"]) assert.ok(listener.includes(field));
    assert.doesNotMatch(listener, /pageText|document\.URL|location\.href.*sendMessage|sendMessage.*location\.href/);
    const bg = code("background.js");
    assert.match(bg, /message\.type === "siteObservation"/);
    assert.match(bg, /sender\.frameId !== 0/);
    assert.match(bg, /host === allowed \|\| host\.endsWith/);
    assert.match(bg, /chrome\.storage\.local\.set\(\{ \[SITE_OBSERVATIONS_KEY\]: next \}\)/);
    assert.doesNotMatch(bg, /url:\s*sender\.url|pageText|bodyText/);
  });

  it("the service worker answers only this extension's own scripts: page lookups/observations, key checks only from popup", () => {
    const bg = code("background.js");
    assert.match(bg, /if \(sender\.id !== chrome\.runtime\.id \|\| !message \|\| typeof message !== "object"\) return false;/);
    // Without a tab (the toolbar popup) only "authCheck" is answered; "index" and "lookup" come after the tab check.
    const noTab = bg.indexOf("if (!sender.tab) {");
    assert.ok(noTab > 0);
    const noTabBlock = bg.slice(noTab, bg.indexOf('if (message.type === "index")'));
    assert.match(noTabBlock, /message\.type === "authCheck"/);
    assert.match(noTabBlock, /return false;\s*\}\s*$/);
    assert.doesNotMatch(noTabBlock, /"index"|"lookup"/);
    assert.match(bg, /message\.type === "siteObservation"/);
    assert.equal(manifest.externally_connectable, undefined);
  });

  it("outgoing links from the card carry no referrer", () => {
    const popup = code("content/popup.js");
    assert.match(popup, /rel: "noopener noreferrer"/);
    assert.match(popup, /referrerpolicy: "no-referrer"/);
  });
});
