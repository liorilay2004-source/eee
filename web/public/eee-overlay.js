(() => {
  const origin = "https://eee-web-bly.pages.dev";
  const id = "eee-flight-overlay-frame";
  const old = document.getElementById(id);
  if (old) {
    old.remove();
    return;
  }
  const frame = document.createElement("iframe");
  frame.id = id;
  frame.title = "מנוע קומבינציות טיסה";
  const src = new URL(`${origin}/overlay`);
  src.searchParams.set("src", location.href);
  src.searchParams.set("title", document.title.slice(0, 120));
  frame.src = src.toString();
  Object.assign(frame.style, {
    position: "fixed",
    inset: "16px 16px auto auto",
    width: "min(420px, calc(100vw - 32px))",
    height: "min(680px, calc(100vh - 32px))",
    zIndex: "2147483647",
    border: "0",
    borderRadius: "24px",
    boxShadow: "0 24px 80px rgba(0,0,0,.32)",
    background: "white",
    colorScheme: "light dark",
  });
  window.addEventListener("message", (event) => {
    if (event.origin !== origin) return;
    if (event.data && event.data.type === "eee-overlay-close") frame.remove();
  });
  document.documentElement.appendChild(frame);
})();
