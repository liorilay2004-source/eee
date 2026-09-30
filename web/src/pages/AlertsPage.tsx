import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BellRing, ExternalLink, Info, RefreshCw, Send, Trash2 } from "lucide-react";
import { SiteFooter, SiteHeader } from "../components/Chrome";
import { LiveRegion } from "../components/Notice";
import { deleteWatch, getWatch } from "../api/client";
import type { WatchView } from "../api/contract";
import { PRODUCT_NAME } from "../config";
import { passengersLabel } from "../lib/builder";
import { isAbort, toApiFailure, type FailureNotice } from "../lib/failure";
import { useAnnouncer } from "../lib/hooks";
import { formatILS, formatShortDate } from "../lib/search";
import {
  WATCH_STATUS_HE, describeWatchDeleteFailure, describeWatchLookupFailure, loadStoredWatches, neighbourToken, removeStoredWatch, safeTelegramLink,
  watchDatesLine, type StoredWatch,
} from "../lib/watches";

/** What GET /api/watches/<token> said. A delete in progress or a failed delete is tracked apart (see Deletion). */
type Entry =
  | { status: "loading" }
  | { status: "ok"; watch: WatchView; link: string | null }
  | { status: "failed"; notice: FailureNotice & { gone: boolean } };

/** DELETE state per token. A failed delete keeps the watch on the card: it was NOT deleted. */
type Deletion = { status: "busy" } | { status: "failed"; notice: FailureNotice };

function hoursAgo(iso: string | null): number | null {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? Math.max(0, (Date.now() - ms) / 3_600_000) : null;
}

function agoText(iso: string | null): string {
  const h = hoursAgo(iso);
  if (h === null) return "זמן לא ידוע";
  if (h < 1) return "לפני פחות משעה";
  if (h < 48) return `לפני ${Math.round(h)} שעות`;
  return `לפני ${Math.round(h / 24)} ימים`;
}

/**
 * "ההתראות שלי": the alerts saved from this device. Their tokens live in localStorage only; each one is looked up with
 * GET /api/watches/<token> and can be stopped with DELETE.
 */
export function AlertsPage() {
  const [stored, setStored] = useState<StoredWatch[]>(() => loadStoredWatches());
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [deletions, setDeletions] = useState<Record<string, Deletion>>({});
  const [announcement, announce] = useAnnouncer();
  const headings = useRef(new Map<string, HTMLHeadingElement>());
  const emptyHeading = useRef<HTMLHeadingElement>(null);
  // After a card is removed its focused button is gone: focus moves to the next card's heading (the previous one when it
  // was the last), or to the empty state's heading. Runs after React has committed the shorter list.
  const [focusRequest, setFocusRequest] = useState<{ token: string | null; n: number } | null>(null);
  useEffect(() => {
    if (!focusRequest) return;
    const frame = window.requestAnimationFrame(() => {
      const target = focusRequest.token ? headings.current.get(focusRequest.token) : null;
      (target ?? emptyHeading.current)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest]);

  useEffect(() => { document.title = `ההתראות שלי · ${PRODUCT_NAME}`; }, []);

  const lookup = useCallback((token: string, signal?: AbortSignal) => {
    setEntries((e) => ({ ...e, [token]: { status: "loading" } }));
    getWatch(token, signal)
      .then((res) => setEntries((e) => ({ ...e, [token]: { status: "ok", watch: res.watch, link: safeTelegramLink(res.telegramLink) } })))
      .catch((error: unknown) => {
        if (signal?.aborted || isAbort(error)) return;
        setEntries((e) => ({ ...e, [token]: { status: "failed", notice: describeWatchLookupFailure(toApiFailure(error, navigator.onLine)) } }));
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // Once per page load, from the device's list (later changes to it are only removals).
    const timer = window.setTimeout(() => { for (const w of loadStoredWatches()) lookup(w.token, controller.signal); }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [lookup]);

  /** Removes a card from the device's list and moves focus to its neighbour. */
  function dropCard(token: string) {
    const neighbour = neighbourToken(loadStoredWatches(), token);
    setStored(removeStoredWatch(token));
    setDeletions((d) => { const next = { ...d }; delete next[token]; return next; });
    setFocusRequest((r) => ({ token: neighbour, n: (r?.n ?? 0) + 1 }));
  }

  function forget(token: string) {
    dropCard(token);
    announce("ההתראה הוסרה מהמכשיר הזה.");
  }

  async function remove(token: string) {
    if (deletions[token]?.status === "busy") return;
    setDeletions((d) => ({ ...d, [token]: { status: "busy" } }));
    try {
      await deleteWatch(token);
      dropCard(token);
      announce("ההתראה נמחקה. לא יישלחו עוד הודעות עליה.");
    } catch (error) {
      const notice = describeWatchDeleteFailure(toApiFailure(error, navigator.onLine));
      if (notice.gone) {
        dropCard(token);
        announce("ההתראה כבר לא קיימת בשרת, והוסרה מהמכשיר הזה.");
        return;
      }
      setDeletions((d) => ({ ...d, [token]: { status: "failed", notice } }));
      announce(`${notice.title}. ${notice.body}`);
    }
  }

  return <>
    <div className="app">
      <SiteHeader current="/alerts" />
      <main id="main" className="main">
        <header className="page-head">
          <p className="kicker">התראות מחיר בטלגרם</p>
          <h1>ההתראות שלי</h1>
          <p className="builder-sub">ההתראות ששמרתם מהמכשיר הזה. הקישור לניהול שלהן נשמר רק בדפדפן הזה, לא בכתובת ולא בשרת. כדי ליצור התראה, חפשו טיסה ולחצו על ״שמרו חיפוש והתראה״ בתוצאות.</p>
        </header>

        <section className="results" aria-label="רשימת ההתראות">
          {stored.length === 0 && <div className="state state-neutral">
            <div className="state-icon"><BellRing size={24} aria-hidden="true" /></div>
            <h2 ref={emptyHeading} tabIndex={-1}>אין התראות שמורות במכשיר הזה</h2>
            <p>אם שמרתם התראה במכשיר אחר, או מחקתם את נתוני הדפדפן, אפשר לעצור אותה מתוך הבוט בטלגרם עם הפקודה <span dir="ltr">/stop</span>, או לראות אותן עם <span dir="ltr">/list</span>.</p>
            <div className="state-actions"><a className="btn btn-primary" href="/">לחיפוש טיסה</a></div>
          </div>}
          {stored.length > 0 && <ul className="alert-list">
            {stored.map((w) => <li key={w.token}><AlertCard stored={w} entry={entries[w.token] ?? { status: "loading" }} deletion={deletions[w.token] ?? null}
              headingRef={(el) => { if (el) headings.current.set(w.token, el); else headings.current.delete(w.token); }}
              onDelete={() => void remove(w.token)} onForget={() => forget(w.token)} onRetry={() => lookup(w.token)} /></li>)}
          </ul>}
          <p className="disclaimer"><Info size={16} aria-hidden="true" />ההתראות נבדקות בערך פעם ביום לפי מחירים שמורים (מטמון) שעשויים להיות בני כמה ימים. המחיר הסופי נקבע באתר ההזמנה.</p>
        </section>
      </main>
      <SiteFooter />
    </div>
    <LiveRegion text={announcement} />
  </>;
}

function AlertCard({ stored, entry, deletion, headingRef, onDelete, onForget, onRetry }: {
  stored: StoredWatch; entry: Entry; deletion: Deletion | null; headingRef: (el: HTMLHeadingElement | null) => void;
  onDelete: () => void; onForget: () => void; onRetry: () => void;
}) {
  const titleId = useId();
  const watch = entry.status === "ok" ? entry.watch : null;
  const busy = deletion?.status === "busy";
  const canDelete = entry.status === "ok" || (entry.status === "failed" && !entry.notice.gone);
  return <article className="alert-card" aria-labelledby={titleId} aria-busy={busy || undefined}>
    <div className="route-top">
      <h2 id={titleId} className="route-title" tabIndex={-1} ref={headingRef}>{stored.label || "חיפוש שמור"}</h2>
      {watch && <span className={`status-tag wst-${watch.status}`}>{WATCH_STATUS_HE[watch.status]}</span>}
    </div>
    {entry.status === "loading" && <p className="route-label">בודקים את מצב ההתראה…</p>}
    {watch && <>
      <p className="route-label num">{watchDatesLine(watch)} · {passengersLabel(watch.adults, watch.children, watch.infants)}{watch.checkedBag ? " · עם מזוודה" : ""}</p>
      <dl className="details-grid alert-facts">
        <div><dt>מתי נודיע</dt><dd>{[
          watch.targetPriceIls !== null ? `במחיר ${formatILS(watch.targetPriceIls)} או פחות` : null,
          watch.dropPct > 0 ? `בירידה של ${watch.dropPct}% לפחות` : null,
          "במחיר חריג לעומת ההיסטוריה",
        ].filter(Boolean).join(" · ")}</dd></div>
        <div><dt>מחיר שמור אחרון</dt><dd>{watch.lastPriceIls !== null ? <>{formatILS(watch.lastPriceIls)} <small>(נבדק {agoText(watch.lastPriceCheckedAt)}, ייתכן שהשתנה)</small></> : "עוד לא נבדק"}</dd></div>
        <div><dt>בדיקה אחרונה</dt><dd>{watch.lastCheckedAt ? agoText(watch.lastCheckedAt) : "עוד לא"}</dd></div>
        <div><dt>בתוקף עד</dt><dd><span className="num" dir="ltr">{formatShortDate(watch.expiresAt.slice(0, 10))}</span></dd></div>
      </dl>
      {watch.status === "pending" && <p className="calm-note"><Send size={18} aria-hidden="true" /><span>ההתראה עוד לא מחוברת לטלגרם, ולכן לא נשלח הודעות. התראה שלא חוברה תוך 48 שעות נמחקת.</span></p>}
    </>}
    {entry.status === "failed" && <div className="alert-fail">
      <p><strong>{entry.notice.title}.</strong> {entry.notice.body}</p>
    </div>}
    {deletion?.status === "failed" && <div className="alert-fail alert-delete-fail">
      <p><strong>{deletion.notice.title}.</strong> {deletion.notice.body}</p>
    </div>}
    <div className="state-actions">
      {entry.status === "ok" && entry.link && <a className="btn btn-book" href={entry.link} target="_blank" rel="noopener noreferrer"><Send size={18} aria-hidden="true" />חיבור לטלגרם<ExternalLink size={16} aria-hidden="true" /><span className="sr-only"> (נפתח בחלון חדש)</span></a>}
      {/* One button through the whole delete: aria-disabled (not disabled, which would drop its focus) while it runs. */}
      {canDelete && <button type="button" className="btn btn-ghost" aria-disabled={busy || undefined} onClick={() => { if (!busy) onDelete(); }}>
        <Trash2 size={18} aria-hidden="true" />{busy ? "מוחקים…" : deletion?.status === "failed" ? "נסו למחוק שוב" : "מחיקת ההתראה"}
      </button>}
      {entry.status === "failed" && entry.notice.canRetry && <button type="button" className="btn btn-ghost" onClick={onRetry}><RefreshCw size={18} aria-hidden="true" />בדיקה חוזרת של ההתראה</button>}
      {entry.status === "failed" && entry.notice.gone && <button type="button" className="btn btn-ghost" onClick={onForget}><Trash2 size={18} aria-hidden="true" />הסרה מהמכשיר</button>}
    </div>
  </article>;
}
