import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft, CalendarRange, CircleAlert, Compass, Eye, History, Hourglass, Info, MapPinned, Moon, PencilLine, RefreshCw,
  Share2, WifiOff, X,
} from "lucide-react";
import { Builder } from "../components/Builder";
import { SiteFooter, SiteHeader } from "../components/Chrome";
import { BoardingPass, CompactCard, PassSkeleton } from "../components/OfferCards";
import { WatchPanel } from "../components/WatchPanel";
import { metaNotes, staleBadge } from "../lib/cards";
import { autoCheckAvailable } from "../lib/partycheck";
import { clearPrefillNotice, peekPrefillNotice } from "../lib/prefill";
import { RequestError, searchFlights } from "../api/client";
import type { CardView, SearchRequest, SearchResponse, SourceStatus } from "../api/contract";
import { he } from "../copy/he";
import { PRODUCT_NAME } from "../config";
import {
  NO_FIELD_ERRORS, describeFailure, firstErrorQuestion, isMinimumPrice, mapFieldErrors, nightsText, otherDuration,
  passengersLabel, placeLabel, priceText, questionsTouchedBy, clearQuestionErrors, rangeLabel, scanGaps, shorterWindow, sourceNote, widenWindow,
  withNearby, type Failure, type FailureView, type FieldErrors, type Question,
} from "../lib/builder";
import { demoResult } from "../lib/demo";
import {
  clearStoredForm, emptyForm, formatShortDate, isFillOnly, loadStoredForm, readSearchUrl, sameRequest, storeForm,
  toRequest, todayISO, updateSearchUrl, validateForm, type SearchForm,
} from "../lib/search";

/** Results are always bound to the search that produced them, never to the live form. */
interface Submitted { form: SearchForm; request: SearchRequest }

type Run =
  | { status: "idle" }
  | { status: "loading"; submitted: Submitted }
  | { status: "done"; submitted: Submitted; response: SearchResponse }
  | { status: "failed"; submitted: Submitted; failure: FailureView; retryAt: number | null }
  | { status: "cancelled"; submitted: Submitted };

const SEARCH_TIMEOUT_MS = 25_000;

function initialForm(): { form: SearchForm; fromUrl: boolean; fillOnly: boolean } {
  const fromUrl = readSearchUrl();
  // A fill-only link (from the explore screen) fills the form but does not run it.
  if (fromUrl) return { form: fromUrl, fromUrl: true, fillOnly: isFillOnly(location.search) };
  return { form: loadStoredForm() ?? emptyForm(), fromUrl: false, fillOnly: false };
}

const FILLED_FALLBACK = "מילאנו את החיפוש ממצב הגילוי. בדקו מי טס ולחצו על החיפוש כדי לבדוק מחיר לכל הנוסעים.";

type FocusTarget = "results" | "demo-open";

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/**
 * Moves focus after React has committed. For the results heading, the summary bar (if shown) is scrolled into view
 * with it, so "שינוי חיפוש" stays visible above the results.
 */
function moveFocus(target: FocusTarget) {
  window.requestAnimationFrame(() => {
    if (target === "demo-open") {
      document.getElementById("demo-open")?.focus();
      return;
    }
    const heading = document.getElementById("results-heading");
    if (!heading) return;
    heading.focus({ preventScroll: true });
    const summary = document.querySelector(".summary");
    (summary ?? heading).scrollIntoView({ block: "start", behavior: scrollBehavior() });
  });
}

function toFailure(error: unknown, timedOut: boolean): Failure {
  if (timedOut) return { type: "timeout" };
  if (error instanceof RequestError) return { type: "http", status: error.status, code: error.code, retryAfterSec: error.retryAfterSec, fields: error.fields };
  if (!navigator.onLine) return { type: "offline" };
  return { type: "network" };
}

export function SearchPage() {
  const [initial] = useState(initialForm);
  // Refreshed whenever the tab comes back and before every search, so a tab left open past midnight (UTC) never
  // clamps month chips or validates against yesterday.
  const [today, setToday] = useState(todayISO);
  const [form, setForm] = useState<SearchForm>(initial.form);
  const [run, setRun] = useState<Run>({ status: "idle" });
  const [editing, setEditingState] = useState(false);
  // True only when the user opened the builder while results were on screen: those results are then from the
  // previous search. Editing during loading does not mark the (matching) results that arrive as stale.
  const [editedAfterResults, setEditedAfterResults] = useState(false);
  const editingRef = useRef(false);
  const setEditing = useCallback((value: boolean) => {
    editingRef.current = value;
    setEditingState(value);
    if (!value) setEditedAfterResults(false);
  }, []);
  const [demo, setDemo] = useState(false);
  const [openQuestion, setOpenQuestion] = useState<Question | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>(NO_FIELD_ERRORS);
  const [rawErrors, setRawErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const [online, setOnline] = useState(() => navigator.onLine);
  const [copied, setCopied] = useState(false);
  // Set when the explore screen filled this search (read once, then forgotten).
  // The notice text rides in sessionStorage; the search itself comes in the URL, so it arrives even when storage is blocked.
  const [prefilled, setPrefilled] = useState(() => (initial.fillOnly ? peekPrefillNotice() ?? FILLED_FALLBACK : null));
  useEffect(() => { clearPrefillNotice(); }, []);
  const controller = useRef<AbortController | null>(null);
  const searchSeq = useRef(0);
  const autoRan = useRef(false);

  useEffect(() => { document.title = `${PRODUCT_NAME} · מוצאים את הטיסה הזולה`; }, []);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") setToday(todayISO()); };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => { document.removeEventListener("visibilitychange", refresh); window.removeEventListener("focus", refresh); };
  }, []);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);

  // Focus moves only after React has committed the new state.
  const [focusRequest, setFocusRequest] = useState<{ target: FocusTarget; n: number } | null>(null);
  const requestFocus = useCallback((target: FocusTarget) => setFocusRequest((r) => ({ target, n: (r?.n ?? 0) + 1 })), []);
  const requestResultsFocus = useCallback(() => {
    // Someone who is editing the search keeps their place in the builder when a response lands.
    if (!editingRef.current) requestFocus("results");
  }, [requestFocus]);
  useEffect(() => { if (focusRequest) moveFocus(focusRequest.target); }, [focusRequest]);

  const announce = (text: string) => {
    setAnnouncement("");
    window.setTimeout(() => setAnnouncement(text), 60);
  };

  const patch = useCallback((changes: Partial<SearchForm>) => {
    setForm((current) => ({ ...current, ...changes }));
    setPrefilled(null);
    setDemo(false);
    // Clear the errors this change resolves (see questionsTouchedBy): never leave a stale message on another chip.
    const touched = questionsTouchedBy(Object.keys(changes), openQuestion);
    setFieldErrors((current) => clearQuestionErrors(current, touched));
    if ("outHoursPreset" in changes || "retHoursPreset" in changes || "customOut" in changes || "customRet" in changes) {
      setRawErrors((current) => { const next = { ...current }; delete next.outHours; delete next.retHours; return next; });
    }
  }, [openQuestion]);

  const runSearch = useCallback(async (nextForm: SearchForm) => {
    controller.current?.abort();
    const seq = ++searchSeq.current;
    const submitted: Submitted = { form: nextForm, request: toRequest(nextForm) };
    setToday(todayISO());
    setForm(nextForm);
    setDemo(false);
    setEditing(false);
    setOpenQuestion(null);
    setPrefilled(null);
    setFieldErrors(NO_FIELD_ERRORS);
    setRawErrors({});
    updateSearchUrl(nextForm);
    storeForm(nextForm);

    if (!navigator.onLine) {
      const failure = describeFailure({ type: "offline" });
      setRun({ status: "failed", submitted, failure, retryAt: null });
      announce(`${failure.title}. ${failure.body}`);
      requestResultsFocus();
      return;
    }

    const abort = new AbortController();
    controller.current = abort;
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; abort.abort(); }, SEARCH_TIMEOUT_MS);
    setRun({ status: "loading", submitted });
    announce("מחפשים את המחיר הזול ביותר…");
    requestResultsFocus();
    try {
      const response = await searchFlights(submitted.request, abort.signal);
      if (seq !== searchSeq.current) return;
      setRun({ status: "done", submitted, response });
      const cheapest = response.cards.find((c) => c.kinds.includes("cheapest")) ?? response.cards[0];
      announce(response.cards.length
        ? `נמצאו ${response.cards.length === 1 ? "הצעה אחת" : `${response.cards.length} הצעות`}. הזולה ביותר: ${priceText(cheapest.offer.totalIls, isMinimumPrice(cheapest.offer, submitted.request))}.`
        : "לא נמצאו מחירים בטווח הזה.");
      requestResultsFocus();
    } catch (error) {
      if (seq !== searchSeq.current) return;
      if (abort.signal.aborted && !timedOut) {
        setRun({ status: "cancelled", submitted });
        announce("החיפוש בוטל.");
        requestResultsFocus();
        return;
      }
      const failure = describeFailure(toFailure(error, timedOut));
      const retryAt = failure.retryAfterSec !== null ? Date.now() + failure.retryAfterSec * 1000 : null;
      setRun({ status: "failed", submitted, failure, retryAt });
      const wasEditing = editingRef.current;
      if (failure.kind === "invalid") {
        setFieldErrors(failure.fields);
        setEditing(true);
      }
      announce(`${failure.title}. ${failure.body}`);
      if (!wasEditing) requestFocus("results");
    } finally {
      window.clearTimeout(timer);
      if (controller.current === abort) controller.current = null;
    }
  }, [requestFocus, requestResultsFocus, setEditing]);

  /** Shows client validation errors on their chips and opens the first question that needs fixing. */
  const showValidation = useCallback((errors: Record<string, string>) => {
    const mapped = mapFieldErrors(errors, false);
    setFieldErrors(mapped);
    setRawErrors(errors);
    const first = firstErrorQuestion(mapped);
    const count = Object.keys(mapped.byQuestion).length + mapped.general.length + (errors.outHours || errors.retHours ? 1 : 0);
    announce(count === 1 ? "צריך להשלים פרט אחד לפני החיפוש." : `צריך להשלים ${count} פרטים לפני החיפוש.`);
    // Keep the messages clear of the sticky CTA bar (html scroll-padding-bottom reserves its height).
    window.requestAnimationFrame(() => document.querySelector(".chip-errors")?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() }));
    if (first) setOpenQuestion(first);
  }, []);

  /** Validates against a fresh "today" and either searches or sends the user to the chip that needs fixing. */
  const trySearch = useCallback((nextForm: SearchForm) => {
    const now = todayISO();
    setToday(now);
    const errors = validateForm(nextForm, now);
    if (Object.keys(errors).length) {
      setForm(nextForm);
      setEditing(true);
      showValidation(errors);
      return;
    }
    void runSearch(nextForm);
  }, [runSearch, setEditing, showValidation]);

  // A shared link (or reload) with a search in the URL runs it once.
  useEffect(() => {
    if (!initial.fromUrl || initial.fillOnly || autoRan.current) return;
    const errors = validateForm(initial.form, todayISO());
    if (Object.keys(errors).length) return;
    // Marked inside the timer: StrictMode's mount-unmount-mount clears the first timer, and the second mount must still run it.
    const timer = window.setTimeout(() => { autoRan.current = true; void runSearch(initial.form); }, 0);
    return () => window.clearTimeout(timer);
  }, [initial, runSearch]);

  function submit() {
    const now = todayISO();
    setToday(now);
    const errors = validateForm(form, now);
    if (Object.keys(errors).length) { showValidation(errors); return; }
    void runSearch(form);
  }

  function editSearch() {
    setEditing(true);
    setEditedAfterResults(run.status === "done");
    setOpenQuestion(null);
    window.requestAnimationFrame(() => {
      const title = document.getElementById("builder-title");
      title?.setAttribute("tabindex", "-1");
      title?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });
  }

  function cancelEdit() {
    setEditing(false);
    setOpenQuestion(null);
    requestResultsFocus();
  }

  function cancelSearch() { controller.current?.abort(); }

  async function share() {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      announce("הקישור לחיפוש הועתק.");
      window.setTimeout(() => setCopied(false), 2000);
    } catch { announce("לא הצלחנו להעתיק. אפשר להעתיק את הכתובת משורת הדפדפן."); }
  }

  function clearSaved() {
    clearStoredForm();
    history.replaceState(null, "", location.pathname);
    controller.current?.abort();
    searchSeq.current += 1;
    setForm(emptyForm());
    setRun({ status: "idle" });
    setEditing(false);
    setDemo(false);
    setFieldErrors(NO_FIELD_ERRORS);
    setRawErrors({});
    announce("החיפוש השמור נמחק מהמכשיר הזה.");
  }

  function closeDemo() {
    setDemo(false);
    announce("הדוגמה נסגרה.");
    requestFocus("demo-open");
  }

  function showDemo() {
    setDemo(true);
    announce("מוצגת דוגמה להמחשה. אלה לא מחירים אמיתיים.");
    requestResultsFocus();
  }

  const hasSubmitted = run.status !== "idle";
  const invalid = run.status === "failed" && run.failure.kind === "invalid";
  const showBuilder = !hasSubmitted || editing || invalid;
  const stale = run.status === "done" && ((editing && editedAfterResults) || !sameRequest(toRequest(form), run.submitted.request));
  const formChanged = run.status === "done" && !sameRequest(toRequest(form), run.submitted.request);

  return <>
    <div className={`app ${showBuilder ? "has-cta" : ""} ${showBuilder && editing && run.status === "done" ? "cta-tall" : ""}`} inert={openQuestion !== null}>
      <SiteHeader current="/" />
      {!online && <p className="offline-bar" role="status"><WifiOff size={16} aria-hidden="true" />אין חיבור לאינטרנט כרגע.</p>}
      <main id="main" className="main">
        {showBuilder && prefilled && <p className="prefill-note" role="status"><Compass size={18} aria-hidden="true" /><span>{prefilled}</span></p>}
        {showBuilder && <Builder
          form={form} patch={patch} today={today} errors={fieldErrors} rawErrors={rawErrors}
          openQuestion={openQuestion} setOpenQuestion={setOpenQuestion} onSubmit={submit}
          editing={editing && run.status === "done"} onCancelEdit={cancelEdit}
        />}
        {!showBuilder && hasSubmitted && <SummaryBar submitted={run.submitted} onEdit={editSearch} onShare={() => void share()} copied={copied} />}

        <section className="results" aria-labelledby="results-heading">
          {stale && <div className="stale-banner">
            <Info size={18} aria-hidden="true" /><span>{he.stale}.</span>
            {formChanged && <button type="button" className="btn btn-small" onClick={submit}>חפשו עם השינויים</button>}
          </div>}
          {run.status === "idle" && (demo ? <DemoResults today={today} onClose={closeDemo} /> : <IdleIntro onDemo={showDemo} />)}
          {run.status === "loading" && <Loading onCancel={cancelSearch} />}
          {run.status === "cancelled" && <StateCard icon={<X size={24} aria-hidden="true" />} title="החיפוש בוטל" body="אפשר לחפש שוב, או לשנות את פרטי החיפוש.">
            <button type="button" className="btn btn-primary" onClick={() => trySearch(run.submitted.form)}><RefreshCw size={18} aria-hidden="true" />חיפוש שוב</button>
            <button type="button" className="btn btn-ghost" onClick={editSearch}><PencilLine size={18} aria-hidden="true" />שינוי חיפוש</button>
          </StateCard>}
          {run.status === "failed" && <FailureCard failure={run.failure} retryAt={run.retryAt} onRetry={() => trySearch(run.submitted.form)} onEdit={editSearch} showEdit={!showBuilder} />}
          {run.status === "done" && (run.response.cards.length
            ? <Results submitted={run.submitted} response={run.response} dimmed={stale} announce={announce} />
            : <EmptyState submitted={run.submitted} response={run.response} onTry={trySearch} onEdit={editSearch} />)}
        </section>
      </main>
      <SiteFooter>
        <button type="button" className="link-button" onClick={clearSaved}>מחקו חיפוש שמור במכשיר הזה</button>
      </SiteFooter>
    </div>
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
  </>;
}

function SummaryBar({ submitted, onEdit, onShare, copied }: { submitted: Submitted; onEdit: () => void; onShare: () => void; copied: boolean }) {
  const { form, request } = submitted;
  return <section className="summary" aria-label="החיפוש שבוצע">
    <div className="summary-main">
      <p className="summary-route">
        <span>{placeLabel(form.origin, form.originLabel)}</span>
        <ArrowLeft size={18} aria-hidden="true" /><span className="sr-only">אל</span>
        <span>{placeLabel(form.destination, form.destinationLabel)}</span>
      </p>
      <div className="dots"><p className="dots-row summary-meta">
        <span className="num">{rangeLabel(request.windowStart, request.windowEnd)}</span>
        <span>{nightsText(request.stayMin, request.stayMax)}</span>
        <span>{passengersLabel(request.adults, request.children, request.infants)}</span>
        {request.checkedBag && <span>עם מזוודה</span>}
      </p></div>
    </div>
    <div className="summary-actions">
      <button type="button" className="btn btn-secondary" onClick={onEdit}><PencilLine size={18} aria-hidden="true" />שינוי חיפוש</button>
      <button type="button" className="btn btn-ghost" onClick={onShare}><Share2 size={18} aria-hidden="true" />{copied ? "הועתק" : "שיתוף"}</button>
    </div>
  </section>;
}

function IdleIntro({ onDemo }: { onDemo: () => void }) {
  return <div className="idle">
    <h2 id="results-heading" tabIndex={-1}>איך זה עובד</h2>
    <ol className="steps">
      <li><span className="step-n num">1</span><span><strong>עונים על כמה שאלות קצרות.</strong> יעד, חודש, כמה לילות ומי טס.</span></li>
      <li><span className="step-n num">2</span><span><strong>אנחנו משווים עשרות צירופי תאריכים.</strong> כולל שני כרטיסים נפרדים כשזה זול יותר.</span></li>
      <li><span className="step-n num">3</span><span><strong>מזמינים ישירות באתר Aviasales.</strong> המחיר הסופי מופיע שם.</span></li>
    </ol>
    <p className="honest"><Info size={16} aria-hidden="true" />המחירים מגיעים ממטמון של Aviasales ועשויים להשתנות. אנחנו לא מוכרים כרטיסים.</p>
    <button type="button" id="demo-open" className="btn btn-ghost" onClick={onDemo}><Eye size={18} aria-hidden="true" />איך נראית תוצאה? הצגת דוגמה</button>
  </div>;
}

function DemoResults({ today, onClose }: { today: string; onClose: () => void }) {
  const [demo] = useState(() => demoResult(today));
  const [hero, ...rest] = demo.cards;
  return <div className="results-body demo-results">
    <div className="demo-banner">
      <strong>דוגמה להמחשה בלבד</strong>
      <p>כך תיראה תוצאה. המספרים כאן מומצאים, אינם מחירים ואי אפשר להזמין אותם.</p>
      <button type="button" className="btn btn-small" onClick={onClose}>סגירת הדוגמה</button>
    </div>
    <h2 id="results-heading" tabIndex={-1} className="results-title">דוגמה: תל אביב – אתונה</h2>
    <BoardingPass card={hero} request={demo.request} originLabel="תל אביב" destinationLabel="אתונה" demo />
    <div className="minis">{rest.map((card, i) => <CompactCard key={i} card={card} request={demo.request} originLabel="תל אביב" destinationLabel="אתונה" demo />)}</div>
  </div>;
}

function Loading({ onCancel }: { onCancel: () => void }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setStep((n) => (n + 1) % he.loadingSteps.length), 2800);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="loading">
    <div className="loading-head">
      <div>
        <h2 id="results-heading" tabIndex={-1}>מחפשים בשבילכם</h2>
        <p className="loading-step">{he.loadingSteps[step]}</p>
      </div>
      <button type="button" className="btn btn-ghost" onClick={onCancel}><X size={18} aria-hidden="true" />ביטול</button>
    </div>
    <PassSkeleton />
  </div>;
}

function StateCard({ icon, title, body, children, tone = "neutral" }: { icon: ReactNode; title: string; body: string; children?: ReactNode; tone?: "neutral" | "warn" }) {
  return <div className={`state state-${tone}`}>
    <div className="state-icon">{icon}</div>
    <h2 id="results-heading" tabIndex={-1}>{title}</h2>
    <p>{body}</p>
    {children && <div className="state-actions">{children}</div>}
  </div>;
}

function FailureCard({ failure, retryAt, onRetry, onEdit, showEdit }: { failure: FailureView; retryAt: number | null; onRetry: () => void; onEdit: () => void; showEdit: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt === null || retryAt <= Date.now()) return;
    const timer = window.setTimeout(() => setNow(Date.now()), retryAt - Date.now() + 50);
    return () => window.clearTimeout(timer);
  }, [retryAt]);
  const waiting = retryAt !== null && now < retryAt;
  const icon = failure.kind === "offline" ? <WifiOff size={24} aria-hidden="true" />
    : failure.kind === "rate_limited" ? <Hourglass size={24} aria-hidden="true" />
      : failure.kind === "source_unavailable" ? <Moon size={24} aria-hidden="true" />
        : <CircleAlert size={24} aria-hidden="true" />;
  return <StateCard icon={icon} title={failure.title} body={failure.body} tone={failure.kind === "invalid" || failure.kind === "error" ? "warn" : "neutral"}>
    {failure.canRetry && <button type="button" className="btn btn-primary" onClick={onRetry} disabled={waiting}><RefreshCw size={18} aria-hidden="true" />{waiting ? "אפשר לנסות שוב בקרוב" : "נסו שוב"}</button>}
    {showEdit && <button type="button" className="btn btn-ghost" onClick={onEdit}><PencilLine size={18} aria-hidden="true" />שינוי חיפוש</button>}
  </StateCard>;
}

function EmptyState({ submitted, response, onTry, onEdit }: { submitted: Submitted; response: SearchResponse; onTry: (form: SearchForm) => void; onEdit: () => void }) {
  const gaps = scanGaps(response.meta.sources);
  // A truncated scan did not check every pair: a shorter window checks them all, a wider one would skip more.
  const shorter = gaps.truncated ? shorterWindow(submitted.form) : null;
  const widened = gaps.truncated ? null : widenWindow(submitted.form);
  const nearby = withNearby(submitted.form);
  const longer = otherDuration(submitted.form);
  const title = gaps.truncated || gaps.failed ? "לא הצלחנו לבדוק את כל התאריכים הפעם" : "לא מצאנו מחירים בטווח הזה";
  const body = gaps.truncated
    ? `${he.truncated} אפשר לנסות אחת מההצעות האלה בלחיצה אחת:`
    : gaps.failed
      ? "חלק מהבדיקות לא הושלמו, ולכן אין לנו מחיר להציג. אפשר לנסות שוב בעוד כמה דקות, או אחת מההצעות האלה:"
      : "במטמון של Aviasales אין כרגע מחיר לצירוף הזה. אפשר לנסות אחת מההצעות האלה בלחיצה אחת:";
  return <StateCard icon={<Compass size={24} aria-hidden="true" />} title={title} body={body}>
    <div className="suggestions">
      {shorter && <button type="button" className="suggestion" onClick={() => onTry(shorter)}>
        <CalendarRange size={20} aria-hidden="true" /><span><strong>טווח תאריכים קצר יותר</strong><small className="num">{rangeLabel(shorter.windowStart, shorter.windowEnd)}</small></span></button>}
      {widened && <button type="button" className="suggestion" onClick={() => onTry(widened)}>
        <CalendarRange size={20} aria-hidden="true" /><span><strong>טווח תאריכים רחב יותר</strong><small>עד <span className="num" dir="ltr">{formatShortDate(widened.windowEnd)}</span></small></span></button>}
      {nearby && <button type="button" className="suggestion" onClick={() => onTry(nearby)}>
        <MapPinned size={20} aria-hidden="true" /><span><strong>גם שדות תעופה קרובים</strong><small>במוצא וביעד</small></span></button>}
      {longer && <button type="button" className="suggestion" onClick={() => onTry(longer)}>
        <Moon size={20} aria-hidden="true" /><span><strong>משך טיול אחר</strong><small>{nightsText(longer.stayMin, longer.stayMax)}</small></span></button>}
    </div>
    <button type="button" className="btn btn-ghost" onClick={onEdit}><PencilLine size={18} aria-hidden="true" />שינוי חיפוש</button>
  </StateCard>;
}

function sourceName(source: SourceStatus): string {
  const names: Record<string, string> = { travelpayouts: "Aviasales (דרך Travelpayouts)", google_flights: "Google Flights", ignav: "Ignav", wego: "Wego", searchapi: "SearchApi", serpapi: "SerpApi" };
  return names[source.name] ?? source.name;
}

function Results({ submitted, response, dimmed, announce }: { submitted: Submitted; response: SearchResponse; dimmed: boolean; announce: (text: string) => void }) {
  const cards = response.cards;
  const heroIndex = Math.max(0, cards.findIndex((c) => c.kinds.includes("cheapest")));
  const hero = cards[heroIndex];
  const others: CardView[] = cards.filter((_, i) => i !== heroIndex);
  const { form, request } = submitted;
  const originLabel = placeLabel(form.origin, form.originLabel);
  const destinationLabel = placeLabel(form.destination, form.destinationLabel);
  const truncated = scanGaps(response.meta.sources).truncated;
  const scanAge = Math.floor(hero.ageHours);
  const cachedAnswer = staleBadge(response.meta);
  const extraNotes = metaNotes(response.meta);
  const autoCheck = autoCheckAvailable(response.meta);
  return <div className={`results-body ${dimmed ? "is-stale" : ""}`}>
    <h2 id="results-heading" tabIndex={-1} className="results-title">
      {cards.length === 1 ? "מצאנו הצעה אחת" : `מצאנו ${cards.length} הצעות`}
    </h2>
    {cachedAnswer && <div className="cached-note">
      <span className="badge-soft"><History size={16} aria-hidden="true" />{cachedAnswer.badge}</span>
      {cachedAnswer.detail && <p>{cachedAnswer.detail}</p>}
    </div>}
    {truncated && <p className="calm-note"><Info size={18} aria-hidden="true" /><span>{he.truncated}</span></p>}
    <BoardingPass card={hero} request={request} originLabel={originLabel} destinationLabel={destinationLabel} autoCheck={autoCheck} />
    {others.length > 0 && <>
      <h3 className="minis-title">עוד אפשרויות ששווה להכיר</h3>
      <div className="minis">{others.map((card) => <CompactCard key={`${card.offer.departDate}-${card.offer.returnDate}-${card.kinds.join("-")}`} card={card} request={request} originLabel={originLabel} destinationLabel={destinationLabel} autoCheck={autoCheck} />)}</div>
    </>}
    {/* Keyed by the search: a new search starts a fresh alert form. */}
    <WatchPanel key={JSON.stringify(request)} request={request} originLabel={originLabel} destinationLabel={destinationLabel} announce={announce} />
    <p className="disclaimer"><Info size={16} aria-hidden="true" />{he.priceDisclaimer}</p>
    <details className="data-details">
      <summary>על הנתונים של החיפוש הזה</summary>
      <dl className="details-grid">
        <div><dt>מקור המחירים</dt><dd>מטמון של Aviasales. מחיר יכול להיות בן כמה ימים.</dd></div>
        <div><dt>הסריקה שלנו</dt><dd>{scanAge < 1 ? "בוצעה לפני פחות משעה" : `בוצעה לפני כ־${scanAge} שעות`}{response.meta.fromCache ? ", והתשובה נשמרה אצלנו" : ""}. זה הזמן של הבדיקה שלנו, לא של המחיר.</dd></div>
        <div><dt>צירופי תאריכים</dt><dd className="num">{response.meta.candidatePairs}</dd></div>
        <div><dt>שער המטבע</dt><dd>{response.meta.fxSource} · <span dir="ltr" className="num">{response.meta.fxDate}</span></dd></div>
      </dl>
      {extraNotes.length > 0 && <ul className="source-list meta-notes">{extraNotes.map((n) => <li key={n}>{n}</li>)}</ul>}
      <ul className="source-list">
        {response.meta.sources.map((source) => {
          const note = source.error ? sourceNote(source.error) : null;
          return <li key={source.name}>
            <strong>{sourceName(source)}</strong>
            <span>{!source.enabled ? "לא פעיל" : source.ok ? `${source.offers} מחירים` : "לא ענה הפעם"}</span>
            {note && <small>{note.text}{note.codes && <> <span dir="ltr">{note.codes}</span></>}</small>}
          </li>;
        })}
      </ul>
    </details>
  </div>;
}
