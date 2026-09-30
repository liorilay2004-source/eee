/**
 * The toolbar popup: on/off, default departure airport, re-showing a site the user muted, the version. Every change is
 * saved to chrome.storage.sync at once; the content scripts pick it up through storage.onChanged.
 */
(() => {
  "use strict";
  const S = /** @type {any} */ (globalThis)[Symbol.for("eee.extension")].settings;
  const area = chrome.storage.sync;
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
})();
