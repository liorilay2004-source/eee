import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Link2, RefreshCw, Sparkles, X } from "lucide-react";
import { RequestError, saveFlightLink } from "../api/client";
import type { FlightLinkMemory } from "../api/contract";
import { PRODUCT_NAME } from "../config";
import { emptyForm, searchParamsFor, type SearchForm } from "../lib/search";

const IATA = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function params(): URLSearchParams {
  return new URLSearchParams(location.search);
}

function tokenParts(raw: string): string[] {
  try {
    const url = new URL(raw);
    return [...url.pathname.split(/[\/_.~:-]+/), ...[...url.searchParams.entries()].flat()].flatMap((x) => x.split(/[^A-Za-z0-9-]+/)).filter(Boolean);
  } catch {
    return [];
  }
}

function parseUrl(raw: string): Partial<SearchForm> {
  const tokens = tokenParts(raw);
  const codes: string[] = [];
  const dates: string[] = [];
  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (IATA.test(upper) && !codes.includes(upper)) codes.push(upper);
    if (/^[A-Z]{6}$/.test(upper)) for (const code of [upper.slice(0, 3), upper.slice(3, 6)]) if (!codes.includes(code)) codes.push(code);
    const date = token.match(/\d{4}-\d{2}-\d{2}|\d{8}/)?.[0];
    if (date) {
      const iso = date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
      if (DATE.test(iso) && !dates.includes(iso)) dates.push(iso);
    }
  }
  return {
    origin: codes[0],
    destination: codes[1],
    windowStart: dates[0],
    windowEnd: dates[1] ?? dates[0],
  };
}

function hrefForCombo(link: FlightLinkMemory | null, fallback: Partial<SearchForm>): string {
  const base = { ...emptyForm(), ...fallback };
  if (link?.origin) base.origin = link.origin;
  if (link?.destination) base.destination = link.destination;
  if (link?.departDate) base.windowStart = link.departDate;
  if (link?.returnDate) base.windowEnd = link.returnDate;
  if (base.origin === "TLV") base.originLabel = "תל אביב";
  if (base.destination) base.destinationLabel = base.destination;
  const search = searchParamsFor(base);
  search.set("fill", "1");
  return `/${search.toString() ? `?${search.toString()}` : ""}`;
}

function closeOverlay() {
  window.parent?.postMessage({ type: "eee-overlay-close" }, "*");
}

export function OverlayPage() {
  const src = params().get("src") ?? "";
  const title = params().get("title") ?? "אתר חברת תעופה";
  const guessed = useMemo(() => parseUrl(src), [src]);
  const [saved, setSaved] = useState<FlightLinkMemory | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => { document.title = `Overlay · ${PRODUCT_NAME}`; }, []);

  async function save() {
    setStatus("saving");
    setMessage(null);
    try {
      const response = await saveFlightLink({ url: src, search: { origin: guessed.origin, destination: guessed.destination, windowStart: guessed.windowStart, windowEnd: guessed.windowEnd } });
      setSaved(response.saved);
      setStatus("saved");
      setMessage(`נשמר: ${response.saved.sourceName}${response.saved.airlineName ? ` · ${response.saved.airlineName}` : ""}`);
    } catch (error) {
      setStatus("failed");
      setMessage(error instanceof RequestError && error.fields?.url ? error.fields.url : "לא הצלחנו לשמור את הקישור הזה.");
    }
  }

  const comboHref = hrefForCombo(saved, guessed);
  const bookmarklet = "javascript:(()=>{const s=document.createElement('script');s.src='https://eee-web-bly.pages.dev/eee-overlay.js?v=1';s.async=true;document.documentElement.appendChild(s);})();";

  return <main className="overlay-page" dir="rtl">
    <div className="overlay-top">
      <div>
        <p className="kicker">קומבינציות על האתר הנוכחי</p>
        <h1>שכבת {PRODUCT_NAME}</h1>
      </div>
      <button type="button" className="icon-button" onClick={closeOverlay} aria-label="סגירה"><X size={20} aria-hidden="true" /></button>
    </div>
    <section className="overlay-card">
      <h2><Link2 size={18} aria-hidden="true" />האתר שנבדק</h2>
      <p>{title}</p>
      <small dir="ltr">{src}</small>
      <div className="overlay-actions">
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={status === "saving"}>
          {status === "saving" ? <RefreshCw size={18} aria-hidden="true" /> : <Link2 size={18} aria-hidden="true" />}
          {status === "saving" ? "שומר…" : "שמור בדיקה"}
        </button>
        <a className="btn btn-secondary" href={comboHref} target="_blank" rel="noreferrer"><Sparkles size={18} aria-hidden="true" />בנה קומבינציות</a>
      </div>
      {message && <p className={`flight-link-message ${status === "failed" ? "is-error" : ""}`}>{message}</p>}
      {(saved || guessed.origin || guessed.destination) && <dl className="overlay-facts">
        <div><dt>מסלול</dt><dd dir="ltr">{saved ? `${saved.origin ?? "?"} → ${saved.destination ?? "?"}` : `${guessed.origin ?? "?"} → ${guessed.destination ?? "?"}`}</dd></div>
        <div><dt>תאריכים</dt><dd dir="ltr">{saved ? `${saved.departDate ?? "?"} – ${saved.returnDate ?? "?"}` : `${guessed.windowStart ?? "?"} – ${guessed.windowEnd ?? "?"}`}</dd></div>
        {saved?.airlineName && <div><dt>חברה</dt><dd>{saved.airlineName}</dd></div>}
      </dl>}
    </section>
    <section className="overlay-card overlay-install">
      <h2><ExternalLink size={18} aria-hidden="true" />התקנה מהירה</h2>
      <p>שמרו את הכפתור הזה במועדפים. בכל אתר חברת תעופה לוחצים עליו והוא פותח את החלונית הזו מעל האתר.</p>
      <a className="btn btn-ghost" href={bookmarklet}>EEE Overlay</a>
    </section>
  </main>;
}

