/**
 * The toolbar popup: on/off, default departure airport, re-showing a site the user muted, the version. Every change is
 * saved to chrome.storage.sync at once; the content scripts pick it up through storage.onChanged.
 *
 * And the access key of a locked API (lib/access.js): saved to chrome.storage.LOCAL only (this device, this profile),
 * never shown back (the field is empty on open; "יש מפתח שמור" says one exists), never logged. "בדיקה" asks the
 * service worker to call GET /api/auth/check (this page never talks to the network itself) and shows the outcome.
 */
(() => {
  "use strict";
  const S = /** @type {any} */ (globalThis)[Symbol.for("eee.extension")].settings;
  const K = /** @type {any} */ (globalThis)[Symbol.for("eee.extension")].access;
  const area = chrome.storage.sync;
  const local = chrome.storage.local;
  const byId = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const enabled = /** @type {HTMLInputElement} */ (byId("enabled"));
  const origins = /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name="origin"]'));
  let current = S.sanitize(null);

  function render() {
    enabled.checked = current.enabled;
    for (const r of origins) {
      r.checked = r.value === current.origin;
      r.disabled = !current.enabled;
    }
    byId("hidden").hidden = current.hiddenOn.length === 0;
    byId("hidden-search").hidden = !current.hiddenOn.includes("search");
    byId("hidden-flights").hidden = !current.hiddenOn.includes("flights");
  }

  /** @param {Record<string, unknown>} patch */
  async function update(patch) {
    current = S.sanitize({ ...current, ...patch });
    render();
    try {
      await S.save(area, current);
      byId("status").textContent = "נשמר";
    } catch {
      byId("status").textContent = "לא הצלחנו לשמור. נסו שוב.";
    }
  }

  try {
    const manifest = chrome.runtime.getManifest();
    byId("version").textContent = manifest.version;
    if (manifest.short_name) byId("name").textContent = manifest.short_name;
  } catch {
    /* not critical */
  }

  enabled.addEventListener("change", () => void update({ enabled: enabled.checked }));
  for (const r of origins) r.addEventListener("change", () => r.checked && void update({ origin: r.value }));
  for (const b of document.querySelectorAll("button[data-surface]")) {
    b.addEventListener("click", () => {
      const surface = b.getAttribute("data-surface");
      void update({ hiddenOn: current.hiddenOn.filter((/** @type {string} */ s) => s !== surface) });
    });
  }

  render();
  S.load(area).then((/** @type {any} */ s) => {
    current = s;
    render();
  });

  // --- the access key -----------------------------------------------------------------------------------------
  const keyField = /** @type {HTMLInputElement} */ (byId("access-key"));
  const toggle = /** @type {HTMLButtonElement} */ (byId("access-toggle"));
  const saveBtn = /** @type {HTMLButtonElement} */ (byId("access-save"));
  const checkBtn = /** @type {HTMLButtonElement} */ (byId("access-check"));
  const clearBtn = /** @type {HTMLButtonElement} */ (byId("access-clear"));
  const accessStatus = byId("access-status");
  const accessBox = /** @type {HTMLDetailsElement} */ (byId("access"));
  /** What is stored, as far as this page knows: whether a key exists and whether the API rejected it. Never the key. */
  let stored = { hasKey: false, rejected: false };

  /** @param {string} text @param {boolean} [bad] */
  function say(text, bad = false) {
    accessStatus.textContent = text;
    accessStatus.classList.toggle("bad", bad);
  }

  /** The stored state as a line (used when no action just happened). */
  function describeStored() {
    if (!stored.hasKey) return say("אין מפתח שמור.");
    if (stored.rejected) return say("המפתח נדחה: השרת לא קיבל אותו. בדקו אותו, או הדביקו מפתח עדכני.", true);
    return say("יש מפתח שמור במכשיר הזה.");
  }

  /** @param {{ key: string | null, rejected: boolean }} st */
  function applyStored(st) {
    stored = { hasKey: st.key !== null, rejected: st.rejected };
    clearBtn.disabled = !stored.hasKey;
    if (stored.rejected) accessBox.open = true;
    describeStored();
  }

  // Show/hide is a CSS mask on a text field (popup.css .masked), never type="password": a password field is what
  // Chrome's password manager offers to save, and a saved password syncs to the Google account.
  toggle.addEventListener("click", () => {
    const show = keyField.classList.contains("masked");
    keyField.classList.toggle("masked", !show);
    toggle.textContent = show ? "הסתרה" : "הצגה";
    toggle.setAttribute("aria-pressed", String(show));
  });

  saveBtn.addEventListener("click", async () => {
    const v = K.validate(keyField.value);
    if (!v.ok) return say(v.messageHe, true);
    try {
      await K.save(local, v.key);
      keyField.value = ""; // the field never keeps the key once it is stored
      applyStored({ key: v.key, rejected: false });
      say("המפתח נשמר במכשיר הזה. אפשר ללחוץ „בדיקה”.");
    } catch {
      say("לא הצלחנו לשמור. נסו שוב.", true);
    }
  });

  clearBtn.addEventListener("click", async () => {
    try {
      await K.clear(local);
      keyField.value = "";
      applyStored({ key: null, rejected: false });
      say("המפתח נמחק מהמכשיר הזה.");
    } catch {
      say("לא הצלחנו למחוק. נסו שוב.", true);
    }
  });

  /** @param {{ outcome?: string, retryAfterMin?: number } | undefined} r */
  function describeCheck(r) {
    switch (r?.outcome) {
      case "ok":
        return say("המפתח תקין.");
      case "wrong":
        return say("המפתח שגוי.", true);
      case "no_key":
        return say("האתר נעול וצריך מפתח. הדביקו אותו ולחצו „שמירה”.", true);
      case "unlocked":
        return say("האתר לא נעול, לא צריך מפתח.");
      case "blocked": {
        const n = typeof r?.retryAfterMin === "number" && r.retryAfterMin > 0 ? Math.ceil(r.retryAfterMin) : 1;
        return say(`יותר מדי ניסיונות, נסו שוב בעוד ${n === 1 ? "דקה אחת" : `${n} דקות`}.`, true);
      }
      case "unavailable":
        return say("השרת לא זמין כרגע. נסו שוב מאוחר יותר.", true);
      default:
        return say("אין חיבור.", true);
    }
  }

  checkBtn.addEventListener("click", () => {
    if (keyField.value !== "") return say("יש מפתח בשדה שעוד לא נשמר: לחצו „שמירה” קודם, ואז „בדיקה”.", true);
    checkBtn.disabled = true;
    say("בודקים…");
    // Only the service worker talks to the API; this page asks it and shows the word it answers with.
    new Promise((resolve) => chrome.runtime.sendMessage({ type: "authCheck" }, resolve))
      .then((r) => describeCheck(/** @type {any} */ (r)), () => describeCheck(undefined))
      .finally(() => {
        checkBtn.disabled = false;
        void K.load(local).then((/** @type {any} */ st) => {
          stored = { hasKey: st.key !== null, rejected: st.rejected };
          clearBtn.disabled = !stored.hasKey;
        });
      });
  });

  clearBtn.disabled = true;
  K.load(local).then(applyStored, () => applyStored({ key: null, rejected: false }));
  chrome.storage.onChanged.addListener((changes, which) => {
    if (which !== "local") return;
    if (changes[K.KEY]) applyStored(K.sanitize(changes[K.KEY].newValue));
    if (changes["eee.siteObservations"]) renderSiteObservations(changes["eee.siteObservations"].newValue);
  });

  const siteButton = /** @type {HTMLButtonElement} */ (byId("site-listener-toggle"));
  const siteStatus = byId("site-listener-status");
  const siteRows = byId("site-observations");
  let activeTabId = null;
  function renderSiteObservations(rows) {
    siteRows.replaceChildren();
    if (!Array.isArray(rows) || rows.length === 0) return;
    for (const row of rows.slice(0, 5)) {
      const item = document.createElement("li");
      const route = document.createElement("strong");
      route.textContent = `${row.origin} → ${row.destination}`;
      const details = document.createElement("span");
      details.textContent = `${row.departDate} – ${row.returnDate} · ${row.priceAmount} ${row.currency}`;
      const host = document.createElement("small");
      host.textContent = row.host;
      const share = document.createElement("button");
      share.type = "button";
      share.textContent = row.sharedAt ? "שותף למנוע" : "שלח למנוע";
      share.disabled = Boolean(row.sharedAt);
      share.setAttribute("aria-label", `${share.textContent}: ${row.origin} אל ${row.destination}`);
      share.addEventListener("click", () => {
        share.disabled = true;
        host.textContent = "שולחים תצפית לא מאומתת…";
        chrome.runtime.sendMessage({ type: "shareObservation", key: row.key }, (result) => {
          if (result?.ok) {
            host.textContent = "נשלח למנוע, מסומן כלא מאומת";
            share.textContent = "שותף למנוע";
          } else {
            host.textContent = result?.status === 429 ? "אפשר לשתף תצפית פעם בדקה" : "לא נשלח. בדקו חיבור או מפתח גישה ונסו שוב.";
            share.disabled = false;
          }
        });
      });
      item.append(route, details, host, share);
      if (typeof row.previousPriceAmount === "number") {
        const change = document.createElement("small");
        change.textContent = `המחיר השתנה מ־${row.previousPriceAmount} ${row.currency}`;
        item.append(change);
      }
      siteRows.append(item);
    }
  }
  async function initializeSiteListener() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTabId = typeof tab?.id === "number" ? tab.id : null;
      const url = typeof tab?.url === "string" ? new URL(tab.url) : null;
      const sitesResponse = await fetch(chrome.runtime.getURL("data/airline-sites.json"));
      const sites = sitesResponse.ok ? await sitesResponse.json() : [];
      const supported = url?.protocol === "https:" && Array.isArray(sites)
        && sites.some((site) => url.hostname.replace(/^www\./, "") === site.host.replace(/^www\./, ""));
      siteButton.disabled = !supported || activeTabId === null;
      siteButton.textContent = supported ? "התחל / הפסק האזנה בטאב הזה" : "פתחו עמוד של חברת תעופה";
      siteStatus.textContent = supported ? `עמוד מזוהה: ${url.hostname}` : "ההאזנה זמינה באתרי חברות התעופה שבקטלוג.";
    } catch {
      siteButton.disabled = true;
      siteStatus.textContent = "לא הצלחנו לבדוק את הטאב הנוכחי.";
    }
  }
  siteButton.addEventListener("click", async () => {
    if (activeTabId === null) return;
    siteButton.disabled = true;
    siteStatus.textContent = "מפעילים או מפסיקים את המאזין…";
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        files: ["lib/site-observer.js", "content/site-listener.js"],
      });
      siteStatus.textContent = "פעולת המאזין נשלחה. הסטטוס מופיע בחלונית שעל האתר.";
    } catch {
      siteStatus.textContent = "הדפדפן לא אפשר להפעיל את המאזין בטאב הזה.";
    } finally {
      siteButton.disabled = false;
    }
  });
  void chrome.storage.local.get("eee.siteObservations").then((rows) => renderSiteObservations(rows["eee.siteObservations"]), () => {});
  void initializeSiteListener();
})();
