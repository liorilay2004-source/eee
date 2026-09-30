/**
 * manifest.json: minimal permissions, Google Search/Flights only, no remote code, a strict CSP, every file present.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { EEE, EXT, read } from "./helpers.mjs";

const manifest = JSON.parse(read("manifest.json"));
const project = JSON.parse(read("../config/project.json"));
const exists = (/** @type {string} */ rel) => existsSync(new URL(rel, EXT));

/** Every file the browser loads (not the tests, not the build scripts). */
function runtimeFiles() {
  /** @type {string[]} */
  const out = ["manifest.json", "background.js"];
  for (const dir of ["lib", "content", "popup"]) for (const f of readdirSync(new URL(`${dir}/`, EXT))) out.push(`${dir}/${f}`);
  return out;
}

describe("permissions", () => {
  it("storage only, the API host only, nothing optional or exposed", () => {
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, ["storage"]);
    assert.deepEqual(manifest.host_permissions, ["https://eee-api.liorilay2004.workers.dev/*"]);
    for (const key of ["optional_permissions", "optional_host_permissions", "externally_connectable", "web_accessible_resources", "update_url", "key", "oauth2", "declarative_net_request", "chrome_url_overrides", "devtools_page", "sandbox"]) {
      assert.equal(manifest[key], undefined, key);
    }
    const text = JSON.stringify(manifest);
    for (const bad of ["<all_urls>", "\"tabs\"", "\"cookies\"", "\"history\"", "\"webRequest\"", "\"scripting\"", "\"activeTab\"", "*://*/*", "http://"]) {
      assert.ok(!text.includes(bad), bad);
    }
  });

  it("the API host in the manifest is the one the code calls", () => {
    assert.equal(`${EEE.api.API_BASE}/*`, manifest.host_permissions[0]);
  });
});

describe("content scripts", () => {
  const [entry] = manifest.content_scripts;

  it("one entry, on Google Search results and Google Flights only, exactly the hosts the code knows", () => {
    assert.equal(manifest.content_scripts.length, 1);
    const expected = [...EEE.query.SEARCH_HOSTS.map((/** @type {string} */ h) => `https://${h}/search*`), ...EEE.query.FLIGHTS_HOSTS.map((/** @type {string} */ h) => `https://${h}/travel/flights*`)];
    assert.deepEqual(entry.matches, expected);
    for (const m of entry.matches) assert.match(m, /^https:\/\/www\.google\.[a-z.]+\/(search|travel\/flights)\*$/);
    assert.ok(entry.matches.includes("https://www.google.co.il/search*"));
    assert.ok(entry.matches.includes("https://www.google.com/travel/flights*"));
    assert.equal(entry.all_frames, undefined);
    assert.equal(entry.match_about_blank, undefined);
    assert.equal(entry.world, undefined); // the isolated world, never the page's
    assert.equal(entry.run_at, "document_idle");
  });

  it("scripts exist and load in dependency order", () => {
    assert.deepEqual(entry.js, ["lib/text.js", "lib/dates.js", "lib/places.js", "lib/tfs.js", "lib/query.js", "lib/view.js", "lib/settings.js", "content/popup.js", "content/main.js"]);
    for (const f of entry.js) assert.ok(exists(f), f);
    assert.equal(entry.css, undefined); // styles live in the closed shadow root
  });

  it("classic scripts: no import/export statements in anything a content script loads", () => {
    for (const f of entry.js) assert.doesNotMatch(read(f), /^\s*(import|export)\s/m, f);
  });
});

describe("no remote code, strict CSP", () => {
  it("extension pages: scripts from the package only, no eval, no plugins", () => {
    const csp = manifest.content_security_policy.extension_pages;
    assert.match(csp, /(^|;)\s*script-src 'self'\s*(;|$)/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline|wasm|https?:\/\/(?!eee-api\.liorilay2004\.workers\.dev)/);
  });

  it("the service worker is an ES module from the package", () => {
    assert.deepEqual(manifest.background, { service_worker: "background.js", type: "module" });
    for (const m of read("background.js").matchAll(/^import\s+"([^"]+)"/gm)) {
      assert.match(/** @type {string} */ (m[1]), /^\.\/lib\/[a-z]+\.js$/);
      assert.ok(exists(/** @type {string} */ (m[1])), m[1]);
    }
  });

  it("no eval, no Function(), no string timers, no HTML injection, no remote scripts", () => {
    for (const f of runtimeFiles().filter((x) => /\.(js|html)$/.test(x))) {
      const text = read(f);
      assert.doesNotMatch(text, /\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\(\s*["'`]|set(?:Timeout|Interval)\s*\(\s*["'`]|importScripts\s*\(|document\.write|\.innerHTML|\.outerHTML|insertAdjacentHTML|createContextualFragment/, f);
      assert.doesNotMatch(text, /<script[^>]+src=["']?https?:|import\s*\(\s*["'`]https?:|from\s+["']https?:/, f);
    }
  });

  it("every file the browser loads is strict UTF-8 without noncharacters (Chrome refuses such a content script)", () => {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const f of runtimeFiles()) {
      const text = decoder.decode(readFileSync(new URL(f, EXT)));
      for (const ch of text) {
        const cp = /** @type {number} */ (ch.codePointAt(0));
        assert.ok(!((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe), `${f}: noncharacter U+${cp.toString(16)}`);
      }
      // Invisible and combining characters are written as \\u escapes, so the source shows what it does.
      assert.doesNotMatch(text, /[\p{Mn}\p{Me}\p{Cf}\p{Co}\p{Cn}]/u, `${f}: write invisible characters as \\u escapes`);
    }
  });

  it("the toolbar page has no inline script or inline handlers", () => {
    const html = read("popup/popup.html");
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    for (const m of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) {
      const ref = /** @type {string} */ (m[1]);
      if (/^https:\/\/eee-web-bly\.pages\.dev\/?(?:privacy)?$/.test(ref)) continue; // the website and its privacy policy
      assert.ok(exists(new URL(ref, new URL("popup/", EXT)).pathname.slice(new URL(EXT).pathname.length)), ref);
    }
  });

  it("the toolbar page says what is sent, where the settings go, the price source and the affiliate links", () => {
    // Review findings: the text said "settings stay in your browser" (chrome.storage.sync follows the Google account
    // when Chrome Sync is on), did not mention that the server asks the price source about the route and month, nor the
    // affiliate links, and linked no privacy policy.
    const html = read("popup/popup.html");
    for (const needle of ["קוד שדה התעופה ביציאה", "קוד היעד", "החודש", "בלי מילות החיפוש", "chrome.storage.sync", "חשבון Google", "Travelpayouts", "קישור שותפים", "https://eee-web-bly.pages.dev/privacy"]) {
      assert.ok(html.includes(needle), needle);
    }
    assert.ok(!html.includes("ההגדרות נשמרות בדפדפן שלכם"));
  });

  it("every URL written in the code is the API, the website, or the booking-site check", () => {
    const allowed = new Set(["https://eee-api.liorilay2004.workers.dev", "https://eee-web-bly.pages.dev"]);
    // (manifest.json's URLs are its match patterns and the host permission, checked above.)
    for (const f of runtimeFiles().filter((x) => /\.(js|html|css)$/.test(x))) {
      for (const m of read(f).matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)) assert.ok(allowed.has(m[0]), `${f}: ${m[0]}`);
    }
  });
});

describe("package", () => {
  it("name, description and version fit the store rules; the brand comes from config/project.json", () => {
    assert.ok(manifest.name.startsWith(project.display_name_he), "rename the extension in manifest.json too");
    assert.equal(manifest.short_name, project.display_name_he);
    assert.equal(manifest.action.default_title, project.display_name_he);
    assert.ok(manifest.name.length <= 75);
    assert.ok(manifest.description.length <= 132, `${manifest.description.length}`);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(JSON.parse(read("package.json")).version, manifest.version);
  });

  it("icons exist as PNGs of the declared sizes", () => {
    for (const [size, file] of Object.entries(manifest.icons)) {
      const png = readFileSync(new URL(/** @type {string} */ (file), EXT));
      assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], file);
      assert.equal(png.readUInt32BE(16), Number(size));
      assert.equal(png.readUInt32BE(20), Number(size));
    }
    for (const file of Object.values(manifest.action.default_icon)) assert.ok(exists(/** @type {string} */ (file)));
    assert.ok(exists(manifest.action.default_popup));
  });

  it("no npm dependencies, tests run with node --test", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.equal(pkg.type, "module");
    assert.equal(pkg.private, true);
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.devDependencies, undefined);
    assert.match(pkg.scripts.test, /^node --test /);
  });
});
