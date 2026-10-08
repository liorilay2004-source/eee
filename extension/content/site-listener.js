/** Injected only after the user clicks the toolbar action on a recognized airline domain. */
(() => {
  "use strict";
  const KEY = Symbol.for("eee.airlineSiteListener");
  const current = /** @type {any} */ (globalThis)[KEY];
  if (current?.stop) {
    current.stop();
    return;
  }
  const EEE = /** @type {any} */ (globalThis)[Symbol.for("eee.extension")];
  if (!EEE?.siteObserver || location.protocol !== "https:") return;

  const host = document.createElement("div");
  host.setAttribute("aria-label", "FlyFind site listener");
  host.style.cssText = "position:fixed;z-index:2147483647;inset:auto 16px 16px auto;max-width:min(360px,calc(100vw - 32px));font:14px/1.45 system-ui,sans-serif;color:#12203a";
  const shadow = host.attachShadow({ mode: "closed" });
  const panel = document.createElement("section");
  panel.style.cssText = "background:#fff;border:1px solid #cbd7e6;border-radius:14px;box-shadow:0 8px 30px #0b1b3440;padding:14px;direction:rtl";
  const title = document.createElement("strong");
  title.textContent = "FlyFind מאזין לשינויים בעמוד";
  const status = document.createElement("p");
  status.style.cssText = "margin:8px 0;color:#42526b";
  status.textContent = "ממתין לתוצאת מחיר שתופיע בעמוד…";
  const detail = document.createElement("p");
  detail.style.cssText = "margin:8px 0;font-weight:700";
  const note = document.createElement("p");
  note.style.cssText = "margin:8px 0;color:#586980;font-size:12px";
  note.textContent = "זיהוי מתוך העמוד הגלוי בלבד. הנתון נשמר במכשיר ומחייב אימות באתר.";
  const stop = document.createElement("button");
  stop.type = "button";
  stop.textContent = "הפסק האזנה";
  stop.style.cssText = "border:0;border-radius:9px;padding:9px 12px;background:#10244d;color:#fff;font:inherit;font-weight:700;cursor:pointer";
  panel.append(title, status, detail, note, stop);
  shadow.append(panel);
  document.documentElement.append(host);

  let timer = 0;
  let lastKey = "";
  let alive = true;
  const scan = () => {
    if (!alive || !document.body) return;
    const nodes = document.querySelectorAll('[data-price], [data-testid*="price" i], [data-qa*="price" i], [class*="price" i], [aria-label*="price" i]');
    const priceTexts = [];
    for (const node of nodes) {
      if (priceTexts.length >= 80) break;
      const text = [node.getAttribute("data-price"), node.getAttribute("aria-label"), node.textContent].filter(Boolean).join(" ").trim();
      if (text && text.length <= 500) priceTexts.push(text);
    }
    const candidates = EEE.siteObserver.parsePage(location.href, priceTexts, document.body.innerText ?? document.body.textContent ?? "");
    const candidate = candidates.find((item) => item.origin && item.destination && item.departDate && item.returnDate) ?? candidates[0];
    if (!candidate) return;
    const key = [location.hostname, candidate.origin, candidate.destination, candidate.departDate, candidate.returnDate, candidate.currency, candidate.priceAmount].join("|");
    if (key === lastKey) return;
    lastKey = key;
    const route = candidate.origin && candidate.destination ? `${candidate.origin} → ${candidate.destination}` : "המסלול לא זוהה";
    const dates = candidate.departDate && candidate.returnDate ? `${candidate.departDate} – ${candidate.returnDate}` : "התאריכים לא זוהו";
    status.textContent = "הופיע מועמד למחיר בעמוד — זוהה בעקבות שינוי בעמוד";
    detail.textContent = `${route} · ${dates} · ${candidate.priceAmount} ${candidate.currency}`;
    if (candidate.origin && candidate.destination && candidate.departDate && candidate.returnDate) {
      try { chrome.runtime.sendMessage({ type: "siteObservation", observation: candidate }); } catch { /* the page display remains local */ }
    }
  };
  const onMutation = () => {
    clearTimeout(timer);
    timer = setTimeout(scan, 300);
  };
  const observer = new MutationObserver(onMutation);
  if (document.body) observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-label", "data-price", "class"] });
  const onNavigation = () => onMutation();
  window.addEventListener("popstate", onNavigation);
  window.addEventListener("hashchange", onNavigation);
  window.addEventListener("pageshow", onNavigation);
  const stopListening = () => {
    if (!alive) return;
    alive = false;
    clearTimeout(timer);
    observer.disconnect();
    window.removeEventListener("popstate", onNavigation);
    window.removeEventListener("hashchange", onNavigation);
    window.removeEventListener("pageshow", onNavigation);
    host.remove();
    delete /** @type {any} */ (globalThis)[KEY];
  };
  stop.addEventListener("click", stopListening);
  /** @type {any} */ (globalThis)[KEY] = { stop: stopListening };
  scan();
})();
