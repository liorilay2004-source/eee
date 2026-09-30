/* EEE flight overlay bookmarklet source. This file is intentionally tiny and has no dependencies. */
(() => {
  const s = document.createElement("script");
  s.src = "https://eee-web-bly.pages.dev/eee-overlay.js?v=1";
  s.async = true;
  document.documentElement.appendChild(s);
})();
