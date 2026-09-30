import { Fragment, useCallback, useEffect, useId, useReducer, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, RefreshCw } from "lucide-react";
import { PRODUCT_NAME } from "../config";
import {
  gateReducer, initialGate, initialLockForm, isFieldError, lockFormReducer, lockMessageText, lockScreenMode, startupCheck, submitKey, type LockMessage,
} from "../lib/access";
import { hasAccessKey, onAccessEvent, subscribeAccessKey } from "../lib/access-key";
import { useWaiting } from "../lib/hooks";
import { SiteHeader } from "./Chrome";

/**
 * The private-use lock in front of the whole app (lib/access.ts has the logic). The API refuses every data request without
 * the key anyway (worker/src/access.ts); this only decides what the page shows.
 */
export function AccessGate({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(gateReducer, undefined, () => initialGate(hasAccessKey()));
  const [checkRun, setCheckRun] = useState(0);
  const recheck = useCallback(() => {
    dispatch({ type: "recheck" });
    setCheckRun((n) => n + 1);
  }, []);

  // Any API call that meets the lock, and the footer's logout, reach the gate through here.
  useEffect(() => onAccessEvent((event) => {
    if (event.type === "recheck") recheck();
    else dispatch(event);
  }), [recheck]);

  // The check cannot hang: checkAccess gives up after ACCESS_CHECK_TIMEOUT_MS and answers "network" (the app shows). The
  // rejection handled here is only this effect's own abort, when a newer check replaces this one.
  useEffect(() => {
    const controller = new AbortController();
    startupCheck(controller.signal).then((event) => { if (event) dispatch(event); }, () => { /* aborted: a newer check runs */ });
    return () => controller.abort();
  }, [checkRun]);

  if (state.view === "checking") return <AccessChecking />;
  if (state.view === "locked") {
    return <LockScreen message={state.message} onUnlocked={() => dispatch({ type: "unlocked" })} onRetry={recheck} />;
  }
  // A new generation remounts the pages, so they send their requests again (see GateState).
  return <Fragment key={state.generation}>{children}</Fragment>;
}

/** While the first check runs without a stored key. The text fades in late, so a quick answer shows no flash. */
export function AccessChecking() {
  return <div className="app">
    <SiteHeader />
    <main id="main" className="main lock-main">
      <p className="access-checking" role="status"><LoaderCircle className="spin" size={18} aria-hidden="true" />בודקים גישה…</p>
    </main>
  </div>;
}

export function LockScreen({ message: initialMessage, onUnlocked, onRetry }: {
  message: LockMessage | null; onUnlocked: () => void; onRetry: () => void;
}) {
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [form, dispatch] = useReducer(lockFormReducer, initialMessage, (message) => initialLockForm(message));
  const keyStored = useSyncExternalStore(subscribeAccessKey, hasAccessKey, hasAccessKey);
  const mode = lockScreenMode(form.message, keyStored);
  const waiting = useWaiting(form.retryAt); // a wait the server named: the retry button stays off until it is over
  const inputRef = useRef<HTMLInputElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const errorId = useId();

  useEffect(() => {
    const previous = document.title;
    document.title = `האתר נעול · ${PRODUCT_NAME}`;
    return () => { document.title = previous; };
  }, []);

  useEffect(() => {
    if (mode === "form") inputRef.current?.focus();
    else if (!waiting) retryRef.current?.focus();
  }, [mode, waiting]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); // the key must never become part of a URL or a form post
    if (form.busy) return;
    dispatch({ type: "submit" });
    let outcome: Awaited<ReturnType<typeof submitKey>>;
    try {
      outcome = await submitKey(value);
    } catch {
      outcome = { unlocked: false, message: { kind: "error" } };
    }
    if (outcome.unlocked) {
      onUnlocked();
      return;
    }
    dispatch({ type: "failed", message: outcome.message, at: Date.now() });
    inputRef.current?.focus();
  }

  // Keyed by the attempt: the same sentence after another try is a new alert, so it is announced again.
  const alert = form.message && <p key={form.attempt} id={errorId} className="lock-error" role="alert">{lockMessageText(form.message)}</p>;

  return <div className="app">
    <SiteHeader />
    <main id="main" className="main lock-main">
      <section className="lock-card" aria-labelledby="lock-title">
        <div className="lock-icon"><LockKeyhole size={26} aria-hidden="true" /></div>
        <h1 id="lock-title">האתר נעול לשימוש אישי</h1>
        {mode === "retry" ? <div className="lock-actions">
          {alert}
          <p className="lock-sub">{form.message?.kind === "misconfigured"
            ? "את הסוד ACCESS_KEY מתקנים בהגדרות ה-Worker ב-Cloudflare. אחר כך לוחצים ״נסו שוב״."
            : "המפתח שמור בדפדפן הזה, ואין צורך להזין אותו שוב."}</p>
          <button ref={retryRef} type="button" className="btn btn-primary btn-wide" onClick={onRetry} disabled={waiting}>
            <RefreshCw size={18} aria-hidden="true" />{waiting ? "אפשר לנסות שוב בקרוב" : "נסו שוב"}
          </button>
        </div> : <>
          <p className="lock-sub">כדי להמשיך, הזינו את מפתח הגישה. הוא נשמר רק בדפדפן הזה, ונשלח רק לשרת של האתר.</p>
          <form className="lock-form" onSubmit={submit} noValidate>
            <label className="lock-label" htmlFor={inputId}>מפתח גישה</label>
            <div className="lock-field">
              {/* No name attribute: even a form sent without this script could not carry the key into a URL. */}
              <input
                ref={inputRef}
                id={inputId}
                type={shown ? "text" : "password"}
                dir="ltr"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                aria-invalid={isFieldError(form.message) ? true : undefined}
                aria-describedby={form.message ? errorId : undefined}
              />
              <button type="button" className="lock-toggle" onClick={() => setShown((s) => !s)} aria-pressed={shown} aria-controls={inputId} aria-label="הצגת המפתח">
                {shown ? <EyeOff size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}
              </button>
            </div>
            {alert}
            <button type="submit" className="btn btn-primary btn-wide" disabled={form.busy}>
              <KeyRound size={18} aria-hidden="true" />{form.busy ? "בודקים…" : "כניסה"}
            </button>
          </form>
        </>}
        <p className="lock-note">האתר פתוח רק לבעלים. את המפתח מזינים פעם אחת בכל דפדפן.</p>
      </section>
    </main>
  </div>;
}
