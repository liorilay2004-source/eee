/**
 * Draws the small price card on a Google page: fixed bottom-left, right-to-left Hebrew, inside a CLOSED shadow root so
 * the page's styles do not reach into it (and ours never leak out).
 *
 * The page's scripts are not trusted either:
 *  - the host is a plain <div>. An autonomous custom element ("<eee-card>") can be defined by the page before we create
 *    it, and a page-defined element's ElementInternals.shadowRoot hands over even a closed shadow root. A built-in
 *    element cannot be upgraded by the page, so the closed root stays closed;
 *  - Esc, × and "לא להציג יותר באתר הזה" act only on real user input (event.isTrusted): a page cannot close the card
 *    or mute the extension with a synthetic event.
 *
 * Built with createElement/textContent only (no HTML strings: API text is data, never markup). It never moves focus:
 * the card is announced through a polite live region and is reachable with Tab like any element at the end of the page.
 * Esc or × closes it; it hides itself after a while unless the pointer or the keyboard focus is on it. Colours follow
 * prefers-color-scheme, the entrance animation respects prefers-reduced-motion, fonts are the system's (none downloaded).
 */
(() => {
  "use strict";
  const EEE = /** @type {any} */ ((/** @type {any} */ (globalThis))[Symbol.for("eee.extension")] ??= {});
  if (EEE.popup) return;

  const AUTO_HIDE_MS = 30_000;
  const RESUME_HIDE_MS = 12_000;

  const CSS = `
:host { all: initial; }
.card {
  --bg: #ffffff; --fg: #0f172a; --muted: #475569; --line: #e2e8f0; --accent: #1d4ed8; --accent-fg: #ffffff;
  --soft: #eff6ff; --shadow: 0 12px 32px rgba(15, 23, 42, 0.18), 0 2px 6px rgba(15, 23, 42, 0.12);
  box-sizing: border-box; position: relative; width: min(360px, calc(100vw - 32px)); max-height: calc(100vh - 32px);
  overflow: auto; margin: 0; padding: 12px 16px 10px; border: 1px solid var(--line); border-radius: 14px;
  background: var(--bg); color: var(--fg); box-shadow: var(--shadow); direction: rtl; text-align: right;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Hebrew", "Arial Hebrew", Arial, sans-serif;
  animation: eee-in 0.18s ease-out;
}
.card.still { animation: none; }
@media (prefers-color-scheme: dark) {
  .card { --bg: #0f172a; --fg: #f1f5f9; --muted: #cbd5e1; --line: #334155; --accent: #93c5fd; --accent-fg: #0f172a;
    --soft: #1e293b; --shadow: 0 12px 32px rgba(0, 0, 0, 0.55); }
}
@keyframes eee-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .card { animation: none; } }
* { box-sizing: border-box; }
.brand { margin: 0 0 2px; padding-inline-end: 36px; color: var(--muted); font-size: 12px; font-weight: 600; }
.title { margin: 0 0 4px; padding-inline-end: 36px; font-size: 17px; font-weight: 700; line-height: 1.35; }
.line { margin: 0 0 2px; }
.line.sub { color: var(--muted); }
.list { margin: 8px 0 0; padding: 0; list-style: none; }
.list li { display: grid; grid-template-columns: 1fr auto; gap: 0 8px; padding: 6px 0; border-top: 1px solid var(--line); }
.list .name { font-weight: 600; }
.list .price { font-weight: 700; }
.list .dates { color: var(--muted); font-size: 12px; }
.list a { justify-self: end; font-size: 12px; color: var(--accent); }
.fine { margin: 8px 0 0; color: var(--muted); font-size: 12px; }
.aff { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
details { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
summary { cursor: pointer; width: fit-content; }
details p { margin: 4px 0 0; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 0; }
.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 6px 14px;
  border: 1px solid var(--accent); border-radius: 10px; color: var(--accent); background: transparent;
  font-weight: 600; text-decoration: none; }
.btn.primary { background: var(--accent); color: var(--accent-fg); }
.btn:hover { filter: brightness(1.08); }
.close { position: absolute; top: 8px; inset-inline-end: 8px; width: 32px; height: 32px; padding: 0; border: 0;
  border-radius: 8px; background: transparent; color: var(--muted); font: 22px/1 system-ui, sans-serif; cursor: pointer; }
.close:hover { background: var(--soft); color: var(--fg); }
.mute { display: inline-block; margin: 8px 0 0; padding: 4px 0; border: 0; background: none; color: var(--muted);
  font: inherit; font-size: 12px; text-decoration: underline; cursor: pointer; }
a:focus-visible, button:focus-visible, summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
.sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0);
  white-space: nowrap; border: 0; }
`;

  /**
   * @param {string} tag
   * @param {Record<string, string>} [attrs]
   * @param {(Node | string | null | undefined | false)[]} [children]
   */
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const c of children) if (c) node.append(typeof c === "string" ? document.createTextNode(c) : c);
    return node;
  }

  /**
   * An outgoing link, only for https addresses (the view already checked them; this is the last gate).
   * @param {string} url
   * @param {string} label
   * @param {string} className
   */
  function link(url, label, className) {
    const a = el("a", { class: className, target: "_blank", rel: "noopener noreferrer", referrerpolicy: "no-referrer" }, [label]);
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") return null;
      a.setAttribute("href", u.toString());
    } catch {
      return null;
    }
    return a;
  }

  /**
   * The card's contents for a view (the × and the mute buttons are made once per card and reused).
   * @param {any} vm a View from lib/view.js
   * @param {HTMLElement} close
   * @param {HTMLElement} mute
   * @returns {HTMLElement[]}
   */
  function contents(vm, close, mute) {
    const body = [
      close,
      el("p", { class: "brand" }, [vm.brand]),
      el("p", { class: "title" }, [vm.title]),
      ...vm.lines.map((/** @type {string} */ line, /** @type {number} */ i) => el("p", { class: i === 0 ? "line sub" : "line" }, [line])),
    ];
    if (vm.items.length > 0) {
      body.push(
        el(
          "ol",
          { class: "list" },
          vm.items.map((/** @type {any} */ item) =>
            el("li", {}, [el("span", { class: "name" }, [item.name]), el("span", { class: "price" }, [item.price]), el("span", { class: "dates" }, [item.dates]), link(item.url, item.urlLabel, "")]),
          ),
        ),
      );
    }
    body.push(el("p", { class: "fine" }, [vm.disclaimer]));
    if (vm.notice) body.push(el("details", {}, [el("summary", {}, [vm.noticeSummary]), el("p", {}, [vm.notice])]));
    const actions = /** @type {HTMLElement[]} */ (vm.actions.map((/** @type {any} */ a) => link(a.url, a.label, a.primary ? "btn primary" : "btn")).filter(Boolean));
    if (actions.length > 0) body.push(el("div", { class: "actions" }, actions));
    if (vm.affiliateNote) body.push(el("p", { class: "aff" }, [vm.affiliateNote]));
    body.push(mute);
    return body;
  }

  /**
   * @type {{ host: HTMLElement, card: HTMLElement, close: HTMLElement, mute: HTMLElement, timer: ReturnType<typeof setTimeout> | undefined, onKey: (e: KeyboardEvent) => void } | null}
   */
  let current = null;

  function hide() {
    if (!current) return;
    clearTimeout(current.timer);
    document.removeEventListener("keydown", current.onKey, true);
    current.host.remove();
    current = null;
  }

  /**
   * @param {any} vm a View from lib/view.js
   * @param {{ onClose?: () => void, onHideSite?: () => void }} [handlers]
   */
  function show(vm, handlers = {}) {
    hide();
    if (!vm || !document.documentElement) return;
    const host = document.createElement("div");
    for (const [k, v] of [
      ["all", "initial"],
      ["position", "fixed"],
      ["left", "16px"],
      ["bottom", "16px"],
      ["z-index", "2147483647"],
      ["display", "block"],
    ]) host.style.setProperty(/** @type {string} */ (k), /** @type {string} */ (v), "important");
    const root = host.attachShadow({ mode: "closed" });
    let styled = false;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
      styled = true;
    } catch {
      /* older engines: a <style> element below */
    }
    if (!styled) root.append(el("style", {}, [CSS]));

    const close = el("button", { class: "close", type: "button", "aria-label": "סגירה", title: "סגירה" }, ["×"]);
    const mute = el("button", { class: "mute", type: "button" }, ["לא להציג יותר באתר הזה"]);
    const live = el("p", { class: "sr", role: "status", "aria-live": "polite" });
    const card = el("section", { class: "card", role: "region", "aria-label": vm.ariaLabel, dir: "rtl", lang: "he" }, contents(vm, close, mute));
    root.append(live, card);

    /** @param {number} ms */
    const schedule = (ms) => {
      if (!current) return;
      clearTimeout(current.timer);
      current.timer = setTimeout(hide, ms);
    };
    const onKey = (/** @type {KeyboardEvent} */ e) => {
      // Real key presses only; never stops the event: the page keeps its own Esc.
      if (e.isTrusted && (e.key === "Escape" || e.key === "Esc")) hide();
    };
    close.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      hide();
      handlers.onClose?.();
    });
    mute.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      hide();
      handlers.onHideSite?.();
    });
    card.addEventListener("mouseenter", () => current && clearTimeout(current.timer));
    card.addEventListener("focusin", () => current && clearTimeout(current.timer));
    card.addEventListener("mouseleave", () => schedule(RESUME_HIDE_MS));
    card.addEventListener("focusout", () => schedule(RESUME_HIDE_MS));

    document.documentElement.append(host);
    document.addEventListener("keydown", onKey, true);
    current = { host, card, close, mute, timer: undefined, onKey };
    schedule(AUTO_HIDE_MS);
    // Filled after insertion, so screen readers announce it without the focus moving.
    setTimeout(() => {
      live.textContent = vm.announce;
    }, 100);
  }

  /**
   * New words for the card on screen (same route and month, the user picked other dates): no new card, no animation,
   * the auto-hide timer keeps running.
   * @param {any} vm
   */
  function update(vm) {
    if (!current || !vm) return;
    current.card.classList.add("still");
    current.card.setAttribute("aria-label", vm.ariaLabel);
    current.card.replaceChildren(...contents(vm, current.close, current.mute));
  }

  EEE.popup = Object.freeze({ show, update, hide, isShown: () => current !== null });
})();
