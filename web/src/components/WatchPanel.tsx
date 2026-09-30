import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { BellRing, CircleAlert, ExternalLink, Info, Send } from "lucide-react";
import { createWatch } from "../api/client";
import type { CreateWatchResponse, SearchRequest } from "../api/contract";
import { FailureBox } from "./Notice";
import { isAbort, retryAtFrom, toApiFailure, type FailureNotice } from "../lib/failure";
import {
  DROP_CHOICES, WATCH_MAX_PER_CLIENT, addStoredWatch, describeCreateWatchFailure, parseAlertRules, rulesSummary, safeTelegramLink,
  watchLabel,
} from "../lib/watches";

interface Props {
  /** The request that produced the results on screen (never the live, possibly edited form). */
  request: SearchRequest;
  originLabel: string;
  destinationLabel: string;
  announce: (text: string) => void;
}

type State =
  | { status: "closed" }
  | { status: "open"; error: string | null }
  | { status: "saving" }
  | { status: "failed"; notice: FailureNotice; retryAt: number | null }
  | { status: "saved"; link: string | null; storedOnDevice: boolean };

/**
 * "שמרו חיפוש והתראה": saves the submitted search as a price alert (POST /api/watches) and hands over the Telegram link
 * that activates it. The ownership token is kept in localStorage only (see lib/watches.ts).
 */
export function WatchPanel({ request, originLabel, destinationLabel, announce }: Props) {
  const [state, setState] = useState<State>({ status: "closed" });
  const [target, setTarget] = useState("");
  const [drop, setDrop] = useState<number | null>(null);
  const headingId = useId();
  const targetId = useId();
  const targetHelpId = useId();
  const failId = useId();
  const resultRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ctaRef = useRef<HTMLButtonElement>(null);
  const resultFrame = useRef(0);
  const parsed = parseAlertRules(target, drop);

  // Opening, cancelling and "back" each unmount the button that was pressed, so focus is moved on purpose after the
  // new state is committed: to the panel heading when it opens, back to the CTA when it closes.
  const [focusRequest, setFocusRequest] = useState<{ to: "heading" | "cta"; n: number } | null>(null);
  useEffect(() => {
    if (!focusRequest) return;
    const frame = window.requestAnimationFrame(() => (focusRequest.to === "cta" ? ctaRef.current : headingRef.current)?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest]);
  const moveFocus = (to: "heading" | "cta") => {
    window.cancelAnimationFrame(resultFrame.current); // the latest request wins
    setFocusRequest((r) => ({ to, n: (r?.n ?? 0) + 1 }));
  };
  const open = () => { setState({ status: "open", error: null }); moveFocus("heading"); };
  const close = () => { setState({ status: "closed" }); moveFocus("cta"); };

  function focusResult() {
    resultFrame.current = window.requestAnimationFrame(() => resultRef.current?.querySelector<HTMLElement>("h2, h3")?.focus());
  }

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (!parsed.ok) { setState({ status: "open", error: parsed.error }); return; }
    setState({ status: "saving" });
    announce("שומרים את ההתראה…");
    try {
      const response: CreateWatchResponse = await createWatch({ ...request, ...parsed.value });
      const stored = addStoredWatch({ token: response.token, savedAt: response.watch.createdAt ?? "", label: watchLabel(request, originLabel, destinationLabel) });
      setState({ status: "saved", link: safeTelegramLink(response.telegramLink), storedOnDevice: stored });
      announce("ההתראה נשמרה. נשאר לחבר אותה לטלגרם.");
    } catch (error) {
      if (isAbort(error)) return;
      const notice = describeCreateWatchFailure(toApiFailure(error, navigator.onLine));
      setState({ status: "failed", notice, retryAt: retryAtFrom(notice) });
      announce(`${notice.title}. ${notice.body}`);
    }
    focusResult();
  }

  if (state.status === "closed") {
    return <section className="watch" aria-label="התראת מחיר">
      <div className="watch-cta">
        <div className="watch-cta-copy">
          <strong>רוצים לדעת כשהמחיר יורד?</strong>
          <span>נבדוק בערך פעם ביום ונשלח הודעה בטלגרם. בלי הרשמה.</span>
        </div>
        <button type="button" className="btn btn-secondary" ref={ctaRef} onClick={open}>
          <BellRing size={18} aria-hidden="true" />שמרו חיפוש והתראה
        </button>
      </div>
    </section>;
  }

  return <section className="watch is-open" aria-labelledby={headingId}>
    <h2 className="watch-title" id={headingId} tabIndex={-1} ref={headingRef}><BellRing size={20} aria-hidden="true" />התראת מחיר לחיפוש הזה</h2>
    <p className="watch-route">{watchLabel(request, originLabel, destinationLabel)}</p>

    {(state.status === "open" || state.status === "saving") && <form className="watch-form" onSubmit={(e) => void save(e)} noValidate>
      <div className="watch-field">
        <label htmlFor={targetId}>מחיר יעד לכל הנוסעים, בשקלים <span className="optional">(לא חובה)</span></label>
        <input id={targetId} inputMode="numeric" autoComplete="off" dir="ltr" placeholder="למשל 1500" value={target}
          aria-describedby={targetHelpId} aria-invalid={state.status === "open" && state.error ? true : undefined}
          onChange={(e) => { setTarget(e.target.value); if (state.status === "open" && state.error) setState({ status: "open", error: null }); }} />
        <small id={targetHelpId}>אותו מחיר כולל שמופיע בכרטיסים.</small>
      </div>
      <fieldset className="adv-group">
        <legend>ירידת מחיר שתעניין אתכם</legend>
        <div className="pill-row">
          {DROP_CHOICES.map((c) => <button type="button" key={c.label} className={`pill ${drop === c.value ? "is-on" : ""}`} aria-pressed={drop === c.value} onClick={() => setDrop(c.value)}>{c.label}</button>)}
        </div>
      </fieldset>
      {parsed.ok && <p className="watch-rules"><Info size={16} aria-hidden="true" /><span>{rulesSummary(parsed.value)}</span></p>}
      {state.status === "open" && state.error && <p className="q-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{state.error}</p>}
      <ul className="watch-facts">
        <li>נבדוק בערך פעם ביום, לפי מחירים שמורים (מטמון) שעשויים להיות בני כמה ימים. זו לא בדיקה בזמן אמת.</li>
        <li>לכל היותר הודעה אחת ביום. ההתראה מסתיימת אחרי 60 יום או כשהתאריכים עוברים.</li>
        <li>בלי חשבון ובלי דוא״ל: נשמרים החיפוש ומזהה הצ׳אט בטלגרם שתחברו. אפשר עד {WATCH_MAX_PER_CLIENT} התראות פעילות.</li>
      </ul>
      <div className="state-actions">
        <button type="submit" className="btn btn-primary" disabled={state.status === "saving"}><BellRing size={18} aria-hidden="true" />{state.status === "saving" ? "שומרים…" : "שמירת ההתראה"}</button>
        <button type="button" className="btn btn-ghost" onClick={close}>ביטול</button>
      </div>
    </form>}

    <div ref={resultRef}>
      {state.status === "failed" && <FailureBox notice={state.notice} retryAt={state.retryAt} onRetry={() => void save()} headingId={failId} compact>
        <button type="button" className="btn btn-ghost" onClick={open}>חזרה להגדרות</button>
      </FailureBox>}

      {state.status === "saved" && <div className="watch-saved">
        <h3 tabIndex={-1}>ההתראה נשמרה. עוד צעד אחד:</h3>
        {state.link ? <>
          <p>פתחו את הבוט בטלגרם ולחצו <strong>Start</strong>. בלי השלב הזה לא נוכל לשלוח הודעות, והתראה שלא חוברה תוך 48 שעות נמחקת.</p>
          <a className="btn btn-book" href={state.link} target="_blank" rel="noopener noreferrer"><Send size={18} aria-hidden="true" />פתיחת הבוט בטלגרם<ExternalLink size={16} aria-hidden="true" /><span className="sr-only"> (נפתח בחלון חדש)</span></a>
        </> : <p>לא קיבלנו קישור תקין לטלגרם. אפשר לנסות לפתוח את ההתראה מעמוד ״ההתראות שלי״.</p>}
        <p className="watch-manage">
          {state.storedOnDevice
            ? <>את ההתראה אפשר לראות ולמחוק ב<a href="/alerts">עמוד ״ההתראות שלי״</a>. הקישור לניהול נשמר רק במכשיר הזה.</>
            : <>לא הצלחנו לשמור את ההתראה במכשיר הזה (אולי הדפדפן במצב פרטי). כדי לעצור אותה בהמשך, שלחו לבוט בטלגרם את הפקודה <span dir="ltr">/stop</span>.</>}
        </p>
      </div>}
    </div>
  </section>;
}
