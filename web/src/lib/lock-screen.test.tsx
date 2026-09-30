import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../App";
import { SiteFooter } from "../components/Chrome";
import { AccessGate, LockScreen } from "../components/LockScreen";
import type { LockMessage } from "./access";
import { clearAccessKey, setAccessKey } from "./access-key";

const KEY = "Zq9vN3tXk2pL8sR4wY7eB1cD5fG0hJ6m";

class MemoryStore {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStore());
  clearAccessKey();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const inputTag = (html: string) => /<input[^>]*>/.exec(html)?.[0] ?? "";

describe("the lock screen (Hebrew, RTL page)", () => {
  it("has the title, a password field with a show/hide toggle, and the כניסה button", () => {
    const html = renderToStaticMarkup(<LockScreen message={null} onUnlocked={() => {}} onRetry={() => {}} />);
    expect(html).toContain("האתר נעול לשימוש אישי");
    expect(html).toContain("מפתח גישה");
    expect(html).toMatch(/<button type="submit"[^>]*>.*כניסה<\/button>/);
    const input = inputTag(html);
    expect(input).toContain('type="password"');
    expect(input).toContain('dir="ltr"'); // the key is Latin inside the RTL page
    expect(input).toContain('autoComplete="current-password"');
    expect(input).toContain('spellCheck="false"');
    expect(html).toMatch(/<button type="button" class="lock-toggle" aria-pressed="false" aria-controls="[^"]+" aria-label="הצגת המפתח">/);
    expect(html).not.toContain('role="alert"');
  });

  it("the key field has no name, so no form submission could ever put the key in a URL", () => {
    const html = renderToStaticMarkup(<LockScreen message={null} onUnlocked={() => {}} onRetry={() => {}} />);
    expect(inputTag(html)).not.toMatch(/\bname=/);
    expect(html).not.toMatch(/<form[^>]*\baction=/);
    expect(html).not.toMatch(/method="get"/i);
  });

  it("shows each error as an alert tied to the field; only errors about what was typed mark the field invalid (ux-compat 5)", () => {
    const cases: [LockMessage, string, boolean][] = [
      [{ kind: "wrong_key" }, "המפתח שגוי", true],
      [{ kind: "empty" }, "הזינו את המפתח", true],
      [{ kind: "stale_key" }, "המפתח שנשמר במכשיר הזה כבר לא תקף. הזינו את המפתח העדכני.", false],
      [{ kind: "too_many_attempts", retryAfterSec: 480 }, "יותר מדי ניסיונות, נסו שוב בעוד 8 דקות", false],
      [{ kind: "network" }, "לא הצלחנו להתחבר לשירות. בדקו את החיבור ונסו שוב.", false],
      [{ kind: "error" }, "משהו השתבש. נסו שוב בעוד רגע.", false],
    ];
    for (const [message, text, invalid] of cases) {
      const html = renderToStaticMarkup(<LockScreen message={message} onUnlocked={() => {}} onRetry={() => {}} />);
      const alert = /<p id="([^"]+)" class="lock-error" role="alert">([^<]*)<\/p>/.exec(html);
      expect(alert?.[2], message.kind).toBe(text);
      expect(inputTag(html), message.kind).toContain(`aria-describedby="${alert?.[1]}"`);
      if (invalid) expect(inputTag(html), message.kind).toContain('aria-invalid="true"');
      else expect(inputTag(html), message.kind).not.toContain("aria-invalid");
    }
  });
});

// Review finding (ux-compat 3): the only way on was to type the key, even where no key could help.
describe("the lock screen offers a retry where typing a key cannot help", () => {
  it("a misconfigured server: no key field, what to fix, and a retry", () => {
    const html = renderToStaticMarkup(<LockScreen message={{ kind: "misconfigured", reason: "too_short" }} onUnlocked={() => {}} onRetry={() => {}} />);
    expect(html).not.toContain("<input");
    expect(html).toContain('role="alert">האתר לא מוגדר נכון (המפתח קצר מדי)</p>');
    expect(html).toContain("ACCESS_KEY");
    expect(html).toMatch(/<button type="button" class="btn btn-primary btn-wide">.*נסו שוב<\/button>/);
  });

  it("too many attempts with the key stored here: no key field, and the retry waits for the server's time", () => {
    setAccessKey(KEY);
    const html = renderToStaticMarkup(<LockScreen message={{ kind: "too_many_attempts", retryAfterSec: 480 }} onUnlocked={() => {}} onRetry={() => {}} />);
    expect(html).not.toContain("<input");
    expect(html).toContain("המפתח שמור בדפדפן הזה, ואין צורך להזין אותו שוב.");
    expect(html).toMatch(/<button type="button" class="btn btn-primary btn-wide" disabled="">.*אפשר לנסות שוב בקרוב<\/button>/);
    expect(html).not.toContain(KEY);
    const noWait = renderToStaticMarkup(<LockScreen message={{ kind: "too_many_attempts", retryAfterSec: null }} onUnlocked={() => {}} onRetry={() => {}} />);
    expect(noWait).toMatch(/<button type="button" class="btn btn-primary btn-wide">.*נסו שוב<\/button>/);
  });

  it("too many attempts with no key stored: the key field stays (it is the only way in)", () => {
    const html = renderToStaticMarkup(<LockScreen message={{ kind: "too_many_attempts", retryAfterSec: 480 }} onUnlocked={() => {}} onRetry={() => {}} />);
    expect(inputTag(html)).toContain('type="password"');
    expect(html).not.toContain("נסו שוב</button>");
  });
});

describe("the gate in front of every page", () => {
  it("without a stored key it checks first: the app is not rendered yet", () => {
    const html = renderToStaticMarkup(<AccessGate><p>APP-CONTENT</p></AccessGate>);
    expect(html).toContain("בודקים גישה");
    expect(html).not.toContain("APP-CONTENT");
  });

  it("with a stored key the app shows at once (the check runs behind it)", () => {
    setAccessKey(KEY);
    const html = renderToStaticMarkup(<AccessGate><p>APP-CONTENT</p></AccessGate>);
    expect(html).toContain("APP-CONTENT");
    expect(html).not.toContain(KEY);
  });
});

describe("the footer's יציאה", () => {
  it("is there only while a key is stored on this device, and never shows the key", () => {
    expect(renderToStaticMarkup(<SiteFooter />)).not.toContain("יציאה");
    setAccessKey(KEY);
    const html = renderToStaticMarkup(<SiteFooter />);
    expect(html).toMatch(/<button type="button" class="link-button footer-logout">.*יציאה \(מחיקת המפתח מהמכשיר\)<\/button>/);
    expect(html).not.toContain(KEY);
    clearAccessKey();
    expect(renderToStaticMarkup(<SiteFooter />)).not.toContain("יציאה");
  });
});

// Review finding (ux-compat 14): the privacy page listed what the site keeps on the device, but not the access key.
describe("the privacy page", () => {
  it("says the access key is kept in this browser, where, how it travels, and how to delete it", () => {
    setAccessKey(KEY); // the app shows at once with a stored key; the privacy page is behind the gate like every page
    vi.stubGlobal("location", { pathname: "/privacy", origin: "https://eee-web-bly.pages.dev" });
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("מדיניות פרטיות");
    expect(html).toContain("מפתח הגישה שהזנתם נשמר בדפדפן הזה");
    expect(html).toContain("eee.accessKey");
    expect(html).toContain("בכותרת של כל בקשה ולא בכתובת");
    expect(html).toContain("יציאה (מחיקת המפתח מהמכשיר)");
    expect(html).not.toContain(KEY);
  });
});
