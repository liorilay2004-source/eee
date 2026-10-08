import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowLeft, CheckCircle2, CircleAlert, Compass, ExternalLink, Eye, History, Hourglass, Info, Link2, MapPinned, Moon, PencilLine, RefreshCw,
  Share2, WifiOff, X,
} from "lucide-react";
import { Builder } from "../components/Builder";
import { FlyFindDiscover, FlyFindHeader, FlyFindHero } from "../components/FlyFind";
import "../flyfind.css";
import { SiteFooter, SiteHeader } from "../components/Chrome";
import { BoardingPass, CompactCard, FlightDetailsCard, PassSkeleton } from "../components/OfferCards";
import { WatchPanel } from "../components/WatchPanel";
import { metaNotes, staleBadge } from "../lib/cards";
import { clearPrefillNotice, peekPrefillNotice } from "../lib/prefill";
import { fetchFlightLinks, fetchSources, RequestError, saveFlightLink, searchFlights } from "../api/client";
import type { CardView, FlightLinkMemory, SearchRequest, SearchResponse, SourceRegistryEntry, SourceRegistryStatus, SourceStatus } from "../api/contract";
import { he } from "../copy/he";
import { PRODUCT_NAME } from "../config";
import {
  NO_FIELD_ERRORS, describeFailure, firstErrorQuestion, isMinimumPrice, mapFieldErrors, nightsText,
  passengersLabel, placeLabel, priceText, questionsTouchedBy, clearQuestionErrors, rangeLabel, scanGaps, sourceNote,
  withNearby, emptySearchCopy, type Failure, type FailureView, type FieldErrors, type Question,
} from "../lib/builder";
import { demoResult } from "../lib/demo";
import { exactVacationForm } from "../lib/date-selection";
import {MAX_REFRESH_POLLS,refreshPollDelay} from "../lib/refresh-wait";
import {
  emptyForm, formatShortDate, isFillOnly, loadStoredForm, readSearchUrl, sameRequest, storeForm,
  toRequest, todayISO, updateSearchUrl, validateForm, type SearchForm,
} from "../lib/search";

/** Results are always bound to the search that produced them, never to the live form. */
interface Submitted { form: SearchForm; request: SearchRequest }

type Run =
  | { status: "idle" }
  | { status: "loading"; submitted: Submitted }
  | { status: "done"; submitted: Submitted; response: SearchResponse }
  | { status: "failed"; submitted: Submitted; failure: FailureView; retryAt: number | null; refreshAttempt?:number }
  | { status: "cancelled"; submitted: Submitted };

const SEARCH_TIMEOUT_MS = 25_000;

function initialForm(): { form: SearchForm; fromUrl: boolean; fillOnly: boolean } {
  const fromUrl = readSearchUrl();
  const visibleForm = (value: SearchForm): SearchForm => exactVacationForm({ ...value, outHoursPreset: "none", retHoursPreset: "none", useCustomOut: false, useCustomRet: false, maxStops: null });
  // A fill-only link (from the explore screen) fills the form but does not run it.
  if (fromUrl) return { form: visibleForm(fromUrl), fromUrl: true, fillOnly: isFillOnly(location.search) };
  return { form: visibleForm(loadStoredForm() ?? emptyForm()), fromUrl: false, fillOnly: false };
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
  const [knownSources, setKnownSources] = useState<SourceRegistryEntry[]>([]);
  // Set when the explore screen filled this search (read once, then forgotten).
  // The notice text rides in sessionStorage; the search itself comes in the URL, so it arrives even when storage is blocked.
  const [prefilled, setPrefilled] = useState(() => (initial.fillOnly ? peekPrefillNotice() ?? FILLED_FALLBACK : null));
  useEffect(() => { clearPrefillNotice(); }, []);
  const controller = useRef<AbortController | null>(null);
  const searchSeq = useRef(0);
  const autoRan = useRef(false);
  useEffect(()=>()=>{
    searchSeq.current++;
    controller.current?.abort();
    controller.current=null;
  },[]);

  useEffect(() => { document.title = `${PRODUCT_NAME} · מוצאים את הטיסה הזולה`; }, []);

  useEffect(() => {
    const abort = new AbortController();
    void fetchSources(abort.signal).then((res) => setKnownSources(res.sources), () => undefined);
    return () => abort.abort();
  }, []);

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
    setForm((current) => exactVacationForm({ ...current, ...changes }));
    setPrefilled(null);
    setDemo(false);
    // Clear the errors this change resolves (see questionsTouchedBy): never leave a stale message on another chip.
    const touched = questionsTouchedBy(Object.keys(changes), openQuestion);
    setFieldErrors((current) => clearQuestionErrors(current, touched));
    if ("outHoursPreset" in changes || "retHoursPreset" in changes || "customOut" in changes || "customRet" in changes) {
      setRawErrors((current) => { const next = { ...current }; delete next.outHours; delete next.retHours; return next; });
    }
  }, [openQuestion]);

  const runSearch = useCallback(async (nextForm: SearchForm,refreshAttempt=0) => {
    nextForm = exactVacationForm(nextForm);
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
      if (response.meta.sourceRegistry) setKnownSources(response.meta.sourceRegistry);
      setRun({ status: "done", submitted, response });
      const cheapest = response.cards.find((c) => c.kinds.includes("cheapest")) ?? response.cards[0];
      announce(response.cards.length
        ? `נמצאו ${response.cards.length === 1 ? "הצעה אחת" : `${response.cards.length} הצעות`}. הזולה ביותר: ${priceText(cheapest.offer.totalIls, isMinimumPrice(cheapest.offer, submitted.request))}.`
        : emptySearchCopy(response.meta.sources).body);
      requestResultsFocus();
    } catch (error) {
      if (seq !== searchSeq.current) return;
      if (abort.signal.aborted && !timedOut) {
        setRun({ status: "cancelled", submitted });
        announce("החיפוש בוטל.");
        requestResultsFocus();
        return;
      }
      let failure = describeFailure(toFailure(error, timedOut));
      if(failure.kind==="refresh_pending"&&refreshAttempt>=MAX_REFRESH_POLLS)failure={...failure,title:"הבדיקה עדיין לא הושלמה",body:"עדיין אין מחיר שאפשר להציג לתאריכים שבחרתם. אפשר לנסות שוב בהמשך או לשנות את החיפוש."};
      const retryAt = failure.retryAfterSec !== null ? Date.now() + failure.retryAfterSec * 1000 : null;
      setRun({ status: "failed", submitted, failure, retryAt,refreshAttempt });
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

  useEffect(()=>{
    if(run.status!=="failed"||!online||editing)return;
    const delay=refreshPollDelay(run.failure.kind,run.refreshAttempt??0,run.retryAt,Date.now());
    if(delay===null)return;
    const timer=window.setTimeout(()=>{void runSearch(run.submitted.form,(run.refreshAttempt??0)+1);},delay);
    return ()=>window.clearTimeout(timer);
  },[run,online,editing,runSearch]);

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
    if (first) setOpenQuestion(first === "stay" ? "when" : first);
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
    if(run.status==="failed"&&run.failure.kind==="refresh_pending")setRun({status:"cancelled",submitted:run.submitted});
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

  function cancelSearch() {
    controller.current?.abort();
    if(run.status==="failed"&&run.failure.kind==="refresh_pending"){
      searchSeq.current++;
      setRun({status:"cancelled",submitted:run.submitted});
      announce("ההמתנה בוטלה.");
    }
  }

  async function share() {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      announce("הקישור לחיפוש הועתק.");
      window.setTimeout(() => setCopied(false), 2000);
    } catch { announce("לא הצלחנו להעתיק. אפשר להעתיק את הכתובת משורת הדפדפן."); }
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
  const landing = run.status === "idle" && !demo;

  return <>
    <div className={`app ${landing || showBuilder ? "flyfind" : ""} ${!landing && showBuilder ? "is-editing" : ""} ${showBuilder ? "has-cta" : ""} ${showBuilder && editing && run.status === "done" ? "cta-tall" : ""}`} inert={openQuestion !== null}>
      {landing ? <FlyFindHeader /> : <SiteHeader current="/" />}
      {landing && <FlyFindHero />}
      {!online && <p className="offline-bar" role="status"><WifiOff size={16} aria-hidden="true" />אין חיבור לאינטרנט כרגע.</p>}
      <main id="main" className="main">
        {showBuilder && prefilled && <p className="prefill-note" role="status"><Compass size={18} aria-hidden="true" /><span>{prefilled}</span></p>}
        {showBuilder && <Builder
          flyFind
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
          {run.status === "idle" && (demo ? <DemoResults today={today} onClose={closeDemo} /> : landing ? <FlyFindDiscover onDestination={(destination, destinationLabel) => { patch({ destination, destinationLabel }); setOpenQuestion("when"); }} /> : <IdleIntro onDemo={showDemo} knownSources={knownSources} />)}
          {run.status === "loading" && <Loading onCancel={cancelSearch} />}
          {run.status === "cancelled" && <StateCard icon={<X size={24} aria-hidden="true" />} title="החיפוש בוטל" body="אפשר לחפש שוב, או לשנות את פרטי החיפוש.">
            <button type="button" className="btn btn-primary" onClick={() => trySearch(run.submitted.form)}><RefreshCw size={18} aria-hidden="true" />חיפוש שוב</button>
            <button type="button" className="btn btn-ghost" onClick={editSearch}><PencilLine size={18} aria-hidden="true" />שינוי חיפוש</button>
          </StateCard>}
          {run.status === "failed" && <FailureCard failure={run.failure} retryAt={run.retryAt} onRetry={() => trySearch(run.submitted.form)} onEdit={editSearch} showEdit={!showBuilder} onCancel={run.failure.kind==="refresh_pending"&&(run.refreshAttempt??0)<MAX_REFRESH_POLLS?cancelSearch:undefined} />}
          {run.status === "done" && (run.response.cards.length
            ? <Results submitted={run.submitted} response={run.response} dimmed={stale} announce={announce} knownSources={knownSources} />
            : <EmptyState submitted={run.submitted} response={run.response} knownSources={knownSources} onTry={trySearch} onEdit={editSearch} />)}
        </section>
      </main>
      <SiteFooter />
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

const SOURCE_STATUS_LABEL: Record<SourceRegistryStatus, string> = {
  active: "פעיל",
  api: "API מוכן",
  "manual-link": "קישור אתר",
  planned: "מתוכנן",
  browser: "דורש דפדפן",
  blocked: "חסום כרגע",
};

const SOURCE_STATUS_ORDER: readonly SourceRegistryStatus[] = ["active", "api", "manual-link", "planned", "browser", "blocked"];

function sourceRegistrySummary(sources: SourceRegistryEntry[]) {
  const byStatus = Object.fromEntries(SOURCE_STATUS_ORDER.map((status) => [status, sources.filter((s) => s.status === status).length])) as Record<SourceRegistryStatus, number>;
  const live = sources.filter((s) => s.capabilities.livePrice).length;
  const api = byStatus.api + byStatus.active;
  const manualLinks = byStatus["manual-link"];
  return { total: sources.length, live, api, manualLinks, byStatus };
}

function prioritizedRegistry(sources: SourceRegistryEntry[], statuses: readonly SourceRegistryStatus[], limit: number): SourceRegistryEntry[] {
  const allowed = new Set<SourceRegistryStatus>(statuses);
  return sources
    .filter((source) => allowed.has(source.status))
    .sort((a, b) => Number(b.routeRelevant === true) - Number(a.routeRelevant === true) || b.priority - a.priority || a.name.localeCompare(b.name, "he"))
    .slice(0, limit);
}

function SourceRegistryPanel({ sources, compact = false }: { sources: SourceRegistryEntry[]; compact?: boolean }) {
  if (sources.length === 0) return null;
  const shown = prioritizedRegistry(sources, ["active", "api", "manual-link", "planned", "blocked"], compact ? 12 : 24);
  const summary = sourceRegistrySummary(sources);
  const groups = SOURCE_STATUS_ORDER
    .map((status) => ({ status, items: shown.filter((source) => source.status === status) }))
    .filter((group) => group.items.length > 0);
  return <div className="known-sources">
    <h3>{compact ? "אתרים לבדיקה ידנית" : "מקורות ואתרי חברות במנוע"}</h3>
    <p>{compact
      ? "אין מחיר ודאי? פותחים את אתר החברה הרשמי, בודקים שם, ואפשר לשמור את הקישור למטה."
      : <>מחיר מוצג רק ממקור שנבדק בחיפוש הזה. שאר המקורות הם API מוכן להפעלה או קישור רשמי לאתר החברה. במנוע יש <span className="num">{summary.total}</span> מקורות.</>}</p>
    {groups.map((group) => <section className="source-group" key={group.status} aria-label={SOURCE_STATUS_LABEL[group.status]}>
      <h4>{SOURCE_STATUS_LABEL[group.status]}</h4>
      <ul className="source-chips">
        {group.items.map((source) => <li key={source.id} className={`source-chip is-${source.status}`}>
          <a href={source.homeUrl} target="_blank" rel="noreferrer">{source.name}</a>
          <small>{source.routeRelevant ? "רלוונטי למסלול" : source.status === "api" && source.capabilities.livePrice ? "מחיר חי כשיש מפתח" : source.status === "manual-link" ? "פתיחה באתר" : SOURCE_STATUS_LABEL[source.status]}</small>
        </li>)}
      </ul>
    </section>)}
  </div>;
}

function OfficialAirlineLinks({ sources }: { sources: SourceRegistryEntry[] }) {
  if (sources.length === 0) return null;
  const routeAirlines = prioritizedRegistry(
    sources.filter((source) => source.kind === "airline" && source.routeRelevant && source.status !== "blocked"),
    ["active", "api", "manual-link", "planned"],
    18,
  );
  const airlines = routeAirlines.length > 0
    ? routeAirlines
    : prioritizedRegistry(sources.filter((source) => source.kind === "airline" && source.status !== "blocked"), ["active", "api", "manual-link", "planned"], 18);
  if (airlines.length === 0) return null;
  return <section className="official-airline-links" aria-labelledby="official-airline-links-title">
    <div>
      <h3 id="official-airline-links-title"><Link2 size={18} aria-hidden="true" />בדיקה באתרי חברות התעופה עצמן</h3>
      <p>לא מצאנו מחיר במנוע כרגע. פתחו את אתרי החברות הרשמיים שמתאימות למסלול, הזינו את אותם תאריכים ונוסעים, ואז אפשר לשמור אצלנו את הקישור שמצאתם.</p>
    </div>
    <ul>
      {airlines.map((source) => <li key={source.id}>
        <a href={source.homeUrl} target="_blank" rel="noreferrer">{source.name}</a>
        <small>{source.routeReasonHe ?? source.noteHe}</small>
      </li>)}
    </ul>
  </section>;
}

function IdleIntro({ onDemo, knownSources }: { onDemo: () => void; knownSources: SourceRegistryEntry[] }) {
  const sourceSummary = sourceRegistrySummary(knownSources);
  return <div className="idle">
    <h2 id="results-heading" tabIndex={-1}>איך זה עובד</h2>
    <ol className="steps">
      <li><span className="step-n num">1</span><span><strong>עונים על כמה שאלות קצרות.</strong> יעד, חודש, כמה לילות ומי טס.</span></li>
      <li><span className="step-n num">2</span><span><strong>אנחנו משווים עשרות צירופי תאריכים.</strong> כולל שני כרטיסים נפרדים כשזה זול יותר.</span></li>
      <li><span className="step-n num">3</span><span><strong>מזמינים באתר שבו נמצא המחיר.</strong> כשהמקור הוא רק קישור ידני, נפתח את החיפוש באתר שלו.</span></li>
    </ol>
    <p className="honest"><Info size={16} aria-hidden="true" />המנוע מכיר {sourceSummary.total || "עשרות"} מקורות. {sourceSummary.live > 0 && <>מתוכם <span className="num">{sourceSummary.api}</span> API/מקורות פעילים בקוד, ו־<span className="num">{sourceSummary.manualLinks}</span> קישורים רשמיים לאתרי חברות.</>} אנחנו לא מוכרים כרטיסים.</p>
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

function FailureCard({ failure, retryAt, onRetry, onEdit, showEdit,onCancel }: { failure: FailureView; retryAt: number | null; onRetry: () => void; onEdit: () => void; showEdit: boolean;onCancel?:()=>void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt === null || retryAt <= Date.now()) return;
    const timer = window.setTimeout(() => setNow(Date.now()), retryAt - Date.now() + 50);
    return () => window.clearTimeout(timer);
  }, [retryAt]);
  const waiting = retryAt !== null && now < retryAt;
  const icon = failure.kind === "offline" ? <WifiOff size={24} aria-hidden="true" />
    : failure.kind === "refresh_pending" ? <Hourglass size={24} aria-hidden="true" />
    : failure.kind === "rate_limited" ? <Hourglass size={24} aria-hidden="true" />
      : failure.kind === "source_unavailable" ? <Moon size={24} aria-hidden="true" />
        : <CircleAlert size={24} aria-hidden="true" />;
  return <StateCard icon={icon} title={failure.title} body={failure.body} tone={failure.kind === "invalid" || failure.kind === "error" ? "warn" : "neutral"}>
    {failure.canRetry && <button type="button" className="btn btn-primary" onClick={onRetry} disabled={waiting}><RefreshCw size={18} aria-hidden="true" />{waiting ? "אפשר לנסות שוב בקרוב" : "נסו שוב"}</button>}
    {onCancel&&<button type="button" className="btn btn-ghost" onClick={onCancel}><X size={18} aria-hidden="true" />ביטול המתנה</button>}
    {showEdit && <button type="button" className="btn btn-ghost" onClick={onEdit}><PencilLine size={18} aria-hidden="true" />שינוי חיפוש</button>}
  </StateCard>;
}

function EmptyState({ submitted, response, knownSources, onTry, onEdit }: { submitted: Submitted; response: SearchResponse; knownSources: SourceRegistryEntry[]; onTry: (form: SearchForm) => void; onEdit: () => void }) {
  const nearby = withNearby(submitted.form);
  const { title, body } = emptySearchCopy(response.meta.sources);
  const registry = response.meta.sourceRegistry ?? knownSources;
  return <StateCard icon={<Compass size={24} aria-hidden="true" />} title={title} body={body}>
    <div className="suggestions">
      {nearby && <button type="button" className="suggestion" onClick={() => onTry(nearby)}>
        <MapPinned size={20} aria-hidden="true" /><span><strong>גם שדות תעופה קרובים</strong><small>במוצא וביעד</small></span></button>}
    </div>
    <OfficialAirlineLinks sources={registry} />
    <button type="button" className="btn btn-ghost" onClick={onEdit}><PencilLine size={18} aria-hidden="true" />שינוי חיפוש</button>
  </StateCard>;
}


function flightLinkRoute(link: FlightLinkMemory): string {
  const route = [link.origin, link.destination].filter(Boolean).join(" → ");
  if (route) return route;
  if (link.departDate || link.returnDate) return [link.departDate, link.returnDate].filter(Boolean).join(" – ");
  return link.host;
}

function checkedAtText(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "נשמר";
  const diff = Math.max(0, Date.now() - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "עכשיו";
  if (minutes < 60) return `לפני ${minutes} דק׳`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `לפני ${hours} שעות`;
  return new Intl.DateTimeFormat("he-IL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

function FlightLinkMemoryPanel({ request, announce }: { request: SearchRequest; announce: (text: string) => void }) {
  const [url, setUrl] = useState("");
  const [links, setLinks] = useState<FlightLinkMemory[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "saved" | "failed">("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    setStatus("loading");
    void fetchFlightLinks(abort.signal).then((res) => {
      setLinks(res.links);
      setStatus("idle");
    }, () => setStatus("idle"));
    return () => abort.abort();
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) {
      setMessage("הדביקו קישור לטיסה או לעמוד חיפוש.");
      return;
    }
    setStatus("saving");
    setMessage(null);
    try {
      const res = await saveFlightLink({ url: trimmed, search: request });
      setLinks(res.links);
      setUrl("");
      setStatus("saved");
      const text = `שמרנו את הקישור מ־${res.saved.sourceName}.`;
      setMessage(text);
      announce(text);
    } catch (error) {
      const text = error instanceof RequestError && error.fields?.url ? error.fields.url : "לא הצלחנו לשמור את הקישור. נסו קישור אחר.";
      setStatus("failed");
      setMessage(text);
      announce(text);
    }
  };

  return <section className="flight-link-memory" aria-labelledby="flight-link-memory-title">
    <div className="flight-link-head">
      <div>
        <h3 id="flight-link-memory-title"><Link2 size={18} aria-hidden="true" />זוכרים קישור שבדקתם</h3>
        <p>הדביקו קישור מאתר חברת תעופה או חיפוש. נשמור מאיזה אתר זה, מתי בדקתם, ומה הצלחנו להבין מהקישור.</p>
      </div>
    </div>
    <form className="flight-link-form" onSubmit={submit}>
      <label className="sr-only" htmlFor="flight-link-url">קישור לטיסה</label>
      <input id="flight-link-url" type="url" inputMode="url" placeholder="https://..." value={url} onChange={(e) => setUrl(e.target.value)} disabled={status === "saving"} />
      <button type="submit" className="btn btn-secondary" disabled={status === "saving"}>{status === "saving" ? "שומר…" : "שמירה"}</button>
    </form>
    {message && <p className={`flight-link-message ${status === "failed" ? "is-error" : ""}`}>{status === "saved" && <CheckCircle2 size={16} aria-hidden="true" />}{message}</p>}
    {links.length > 0 && <ul className="flight-link-list">
      {links.map((link) => <li key={link.id}>
        <div>
          <strong>{link.sourceName}</strong>
          <span>{flightLinkRoute(link)}{link.airlineName ? ` · ${link.airlineName}` : ""}</span>
        </div>
        <div className="flight-link-meta">
          <time dateTime={link.checkedAt}>{checkedAtText(link.checkedAt)}</time>
          <a href={link.url} target="_blank" rel="noreferrer">פתיחה</a>
        </div>
      </li>)}
    </ul>}
  </section>;
}

function sourceName(source: SourceStatus): string {
  const names: Record<string, string> = { travelpayouts: "Aviasales (דרך Travelpayouts)", google_flights: "Google Flights", ignav: "Ignav", wego: "Wego", searchapi: "SearchApi", serpapi: "SerpApi", duffel: "Duffel", hasdata: "HasData" };
  return names[source.name] ?? source.name;
}

function AirlinePriceLinksPanel({ response }: { response: SearchResponse }) {
  const links = response.meta.airlinePriceLinks ?? [];
  if (links.length === 0) return null;
  return <section className="airline-price-links" aria-labelledby="airline-price-links-title">
    <div className="airline-price-head">
      <div>
        <h3 id="airline-price-links-title"><Link2 size={18} aria-hidden="true" />אתרי חברות התעופה לפי המחיר שמצאנו</h3>
        <p>מסודר מהזול ליקר לפי המחיר הכולל של הטיול שבו החברה משתתפת. בקומבינציה המחיר כולל את כל החברות, ולא רק את הכרטיס של החברה שבקישור. הקישור נפתח באתר הרשמי.</p>
      </div>
    </div>
    <ol>
      {links.map((item) => <li key={item.code}>
        <a href={item.homeUrl} target="_blank" rel="noreferrer">
          <span>
            <strong>{item.nameHe ?? item.nameEn ?? item.code}</strong>
            <small><span dir="ltr">{item.code}</span> · <span className="num" dir="ltr">{formatShortDate(item.departDate)} – {formatShortDate(item.returnDate)}</span></small>
            {item.participatingAirlines && <small>מחיר הטיול כולו · חברות משתתפות: <span dir="ltr">{item.participatingAirlines.join(" + ")}</span></small>}
          </span>
          <span className="airline-price-amount num" dir="ltr">{priceText(item.priceIls, false)}</span>
          <ExternalLink size={16} aria-hidden="true" />
        </a>
      </li>)}
    </ol>
  </section>;
}

function Results({ submitted, response, dimmed, announce, knownSources }: { submitted: Submitted; response: SearchResponse; dimmed: boolean; announce: (text: string) => void; knownSources: SourceRegistryEntry[] }) {
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
  const registry = response.meta.sourceRegistry ?? knownSources;
  const known = sourceRegistrySummary(registry);
  const sourceById = new Map(registry.map((s) => [s.id, s]));
  return <div className={`results-body ${dimmed ? "is-stale" : ""}`}>
    <h2 id="results-heading" tabIndex={-1} className="results-title">
      {cards.length === 1 ? "מצאנו הצעה אחת" : `מצאנו ${cards.length} הצעות`}
    </h2>
    {cachedAnswer && <div className="cached-note">
      <span className="badge-soft"><History size={16} aria-hidden="true" />{cachedAnswer.badge}</span>
      {cachedAnswer.detail && <p>{cachedAnswer.detail}</p>}
    </div>}
    {truncated && <p className="calm-note"><Info size={18} aria-hidden="true" /><span>{he.truncated}</span></p>}
    <FlightDetailsCard card={hero} request={request} originLabel={originLabel} destinationLabel={destinationLabel} />
    <AirlinePriceLinksPanel response={response} />
    {others.length > 0 && <>
      <h3 className="minis-title">עוד אפשרויות ששווה להכיר</h3>
      <div className="flight-details-list">{others.map((card) => <FlightDetailsCard key={`${card.offer.departDate}-${card.offer.returnDate}-${card.kinds.join("-")}`} card={card} request={request} originLabel={originLabel} destinationLabel={destinationLabel} />)}</div>
    </>}
    {/* Keyed by the search: a new search starts a fresh alert form. */}
    <WatchPanel key={JSON.stringify(request)} request={request} originLabel={originLabel} destinationLabel={destinationLabel} announce={announce} />
    <FlightLinkMemoryPanel request={request} announce={announce} />
    <p className="disclaimer"><Info size={16} aria-hidden="true" />{he.priceDisclaimer}</p>
    {response.meta.fxSource.includes("open.er-api.com") && <p className="disclaimer">המרת המטבע לפי <a href="https://www.exchangerate-api.com/" target="_blank" rel="noopener noreferrer">ExchangeRate-API</a> · תאריך השער <span dir="ltr">{response.meta.fxDate}</span>.</p>}
    <details className="data-details">
      <summary>על הנתונים של החיפוש הזה</summary>
      <dl className="details-grid">
        <div><dt>מקור המחירים</dt><dd>מקורות פעילים וקישורי חיפוש מתוכננים. מחיר יכול להשתנות באתר ההזמנה.</dd></div>
        <div><dt>הסריקה שלנו</dt><dd>{scanAge < 1 ? "בוצעה לפני פחות משעה" : `בוצעה לפני כ־${scanAge} שעות`}{response.meta.fromCache ? ", והתשובה נשמרה אצלנו" : ""}. זה הזמן של הבדיקה שלנו, לא של המחיר.</dd></div>
        <div><dt>צירופי תאריכים</dt><dd className="num">{response.meta.candidatePairs}</dd></div>
        <div><dt>מקורות במנוע</dt><dd><span className="num">{known.total}</span> מוכרים · <span className="num">{known.api}</span> API/פעילים · <span className="num">{known.manualLinks}</span> קישור אתר</dd></div>
        <div><dt>שער המטבע</dt><dd>{response.meta.fxSource} · <span dir="ltr" className="num">{response.meta.fxDate}</span></dd></div>
      </dl>
      {extraNotes.length > 0 && <ul className="source-list meta-notes">{extraNotes.map((n) => <li key={n}>{n}</li>)}</ul>}
      <ul className="source-list">
        {response.meta.sources.map((source) => {
          const note = source.error ? sourceNote(source.error) : null;
          return <li key={source.name}>
            <strong>{sourceName(source)}</strong>
            <span>{!source.enabled ? "לא פעיל" : source.ok ? `${source.offers} מחירים` : "לא ענה הפעם"}</span>
            {sourceById.get(source.name)?.noteHe && <small>{sourceById.get(source.name)?.noteHe}</small>}
            {note && <small>{note.text}{note.codes && <> <span dir="ltr">{note.codes}</span></>}</small>}
          </li>;
        })}
      </ul>
<SourceRegistryPanel sources={registry} />
    </details>
  </div>;
}
