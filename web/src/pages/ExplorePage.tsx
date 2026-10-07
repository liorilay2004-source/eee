import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, CalendarDays, Compass, ExternalLink, Info, Search, Sparkles, SunMedium, WifiOff } from "lucide-react";
import { SiteFooter, SiteHeader } from "../components/Chrome";
import { FailureBox, LiveRegion } from "../components/Notice";
import { HolidayCredit, TripHolidays } from "../components/Holidays";
import { resultsNeedHolidayCredit } from "../lib/holidays";
import { fetchExplore } from "../api/client";
import type { ExploreResponse, ExploreResult } from "../api/contract";
import { PRODUCT_NAME } from "../config";
import {
  EXPLORE_MAX_TEXT, EXPLORE_NIGHTS, EXPLORE_ORIGINS, buildExploreParams, climateText, describeExploreFailure, destinationName, destinationTitle,
  emptyExploreInput, exploreMonths, foundAgeText, prefillFromExplore, previewText, scoreParts, sortFailureText, sortResults,
  stopsLabel, understoodSummary, type ExploreField, type ExploreInput, type ExploreSort,
} from "../lib/explore";
import { isAbort, retryAtFrom, toApiFailure, type FailureNotice } from "../lib/failure";
import { useAnnouncer, useOnline } from "../lib/hooks";
import { setPrefillNotice } from "../lib/prefill";
import { emptyForm, fillSearchHref, formatILS, formatShortDate, loadStoredForm, todayISO, trustedBookingUrl } from "../lib/search";

const TIMEOUT_MS = 20_000;
const EXAMPLES = ["יש לי 4 ימים בנובמבר", "סופ״ש בחודש הבא", "שבוע בדצמבר"];

type Run =
  | { status: "idle" }
  | { status: "loading"; sort: ExploreSort }
  /** `sorting`: a re-sort is on its way (the results stay on screen); `sortError`: the last re-sort failed. */
  | { status: "done"; sort: ExploreSort; response: ExploreResponse; sorting: ExploreSort | null; sortError: string | null }
  | { status: "failed"; notice: FailureNotice; lines: string[]; retryAt: number | null };

const CATEGORY_HE: Record<string, string> = { beach: "חופים", city: "עיר", ski: "סקי", nature: "טבע" };

function focusHeading() {
  window.requestAnimationFrame(() => {
    const heading = document.getElementById("explore-results");
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
}

export function ExplorePage() {
  const [today] = useState(todayISO);
  const [input, setInput] = useState<ExploreInput>(emptyExploreInput);
  const [errors, setErrors] = useState<Partial<Record<ExploreField, string>>>({});
  const [run, setRun] = useState<Run>({ status: "idle" });
  /** The request the results belong to, and its answers per sort order (switching back costs no new request). */
  const submitted = useRef<{ input: ExploreInput; bySort: Partial<Record<ExploreSort, ExploreResponse>> } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const lastTried = useRef<{ input: ExploreInput; sort: ExploreSort } | null>(null);
  const [announcement, announce] = useAnnouncer();
  const online = useOnline();
  const textId = useId();
  const previewId = useId();
  const months = exploreMonths(today);
  const preview = previewText(input.text, new Date(`${today}T12:00:00Z`));

  useEffect(() => { document.title = `לא יודע לאן? · ${PRODUCT_NAME}`; }, []);
  useEffect(() => () => controller.current?.abort(), []);

  const set = (changes: Partial<ExploreInput>) => {
    setInput((current) => ({ ...current, ...changes }));
    setErrors((current) => {
      const next = { ...current };
      if ("text" in changes || "month" in changes) { delete next.text; delete next.month; }
      if ("maxPrice" in changes) delete next.maxPrice;
      return next;
    });
  };

  async function load(requestInput: ExploreInput, sort: ExploreSort) {
    const built = buildExploreParams(requestInput, sort);
    if (!built.ok) {
      setErrors(built.errors);
      announce(Object.values(built.errors).join(" "));
      return;
    }
    lastTried.current = { input: requestInput, sort };
    const cached = submitted.current?.input === requestInput ? submitted.current.bySort[sort] : undefined;
    if (cached) { setRun({ status: "done", sort, response: cached, sorting: null, sortError: null }); return; }
    // Another order of results already on screen: they stay there while it loads, and stay if it fails.
    const resort = submitted.current?.input === requestInput && Object.keys(submitted.current.bySort).length > 0;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; abort.abort(); }, TIMEOUT_MS);
    if (resort) {
      setRun((r) => r.status === "done" ? { ...r, sorting: sort, sortError: null } : { status: "loading", sort });
      announce(sort === "score" ? "מסדרים לפי ציון…" : "מסדרים לפי מחיר…");
    } else {
      setRun({ status: "loading", sort });
      announce("מחפשים יעדים…");
    }
    try {
      const response = await fetchExplore(built.params, abort.signal);
      if (controller.current !== abort) return;
      if (submitted.current?.input !== requestInput) submitted.current = { input: requestInput, bySort: {} };
      submitted.current.bySort[sort] = response;
      setRun({ status: "done", sort, response, sorting: null, sortError: null });
      if (resort) {
        announce(sort === "score" ? "התוצאות מסודרות לפי ציון כולל." : "התוצאות מסודרות מהזול ליקר.");
        return;
      }
      announce(response.results.length ? `נמצאו ${response.results.length} יעדים.` : "לא נמצאו יעדים שמתאימים.");
      focusHeading();
    } catch (error) {
      if (controller.current !== abort) return;
      if (isAbort(error) && !timedOut) return;
      const apiFailure = toApiFailure(error, navigator.onLine);
      const failure = timedOut
        ? { title: "הבדיקה לוקחת יותר מדי זמן", body: "נסו שוב בעוד רגע.", retryAfterSec: null, canRetry: true, lines: [] }
        : describeExploreFailure(apiFailure);
      const failed: Run = { status: "failed", notice: failure, lines: failure.lines, retryAt: retryAtFrom(failure) };
      if (resort && run.status === "done") {
        // The results on screen are still right; only their order could not change.
        const text = sortFailureText(timedOut ? { type: "network" } : apiFailure, sort);
        setRun((r) => r.status === "done" ? { ...r, sorting: null, sortError: text } : failed);
        announce(text);
        return;
      }
      setRun(failed);
      announce(`${failure.title}. ${failure.body} ${failure.lines.join(" ")}`);
      focusHeading();
    } finally {
      window.clearTimeout(timer);
      if (controller.current === abort) controller.current = null;
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    submitted.current = null;
    void load(input, "price");
  }

  function changeSort(sort: ExploreSort) {
    if (!submitted.current || run.status === "loading" || (run.status === "done" && run.sorting)) return;
    void load(submitted.current.input, sort);
  }

  /**
   * The search travels in the URL (a fill-only link: filled, not run), so it arrives even when device storage is
   * blocked. Only the optional one-time note uses sessionStorage.
   */
  function fillSearch(result: ExploreResult) {
    const origin = EXPLORE_ORIGINS.find((o) => o.code === result.search.origin)?.label ?? "";
    const form = prefillFromExplore(result, loadStoredForm() ?? emptyForm(), origin);
    setPrefillNotice(`מילאנו את החיפוש: ${destinationName(result.destination)}, ${formatShortDate(result.departDate)}–${formatShortDate(result.returnDate)}. בדקו מי טס ולחצו על החיפוש כדי לבדוק מחיר לכל הנוסעים.`);
    location.assign(fillSearchHref(form));
  }

  const fieldError = (field: ExploreField) => errors[field];

  return <>
    <div className="app">
      <SiteHeader current="/explore" />
      {!online && <p className="offline-bar" role="status"><WifiOff size={16} aria-hidden="true" />אין חיבור לאינטרנט כרגע.</p>}
      <main id="main" className="main">
        <form className="builder explore-form" onSubmit={submit} noValidate aria-labelledby="explore-title">
          <div className="builder-head">
            <p className="kicker">מצב גילוי · יעדים זולים מישראל</p>
            <h1 id="explore-title">לא יודע לאן?</h1>
            <p className="builder-sub">ספרו לנו כמה זמן ומתי, ונראה לאן הכי זול לטוס. אפשר לכתוב במילים שלכם.</p>
          </div>

          <div className="xf-grid">
            <div className="xf-field xf-wide">
              <label htmlFor={textId}>מה בא לכם?</label>
              <input id={textId} type="text" className="xf-input" value={input.text} maxLength={EXPLORE_MAX_TEXT}
                placeholder="יש לי 4 ימים בנובמבר" autoComplete="off" enterKeyHint="search"
                aria-describedby={`${previewId}${fieldError("text") ? " xf-text-error" : ""}`} aria-invalid={fieldError("text") ? true : undefined}
                onChange={(e) => set({ text: e.target.value })} />
              <div className="pill-row xf-examples" role="group" aria-label="דוגמאות">
                {EXAMPLES.map((ex) => <button type="button" key={ex} className="pill" onClick={() => set({ text: ex })}>{ex}</button>)}
              </div>
              <p id={previewId} className="xf-preview" aria-live="polite">
                {preview
                  ? <>{preview.summary && <span><Sparkles size={16} aria-hidden="true" />הבנו: <strong>{preview.summary}</strong></span>}
                    {preview.message && <small>{preview.message}</small>}</>
                  : <small>למשל: ״4 לילות בנובמבר״, ״סופ״ש בחודש הבא״, ״שבועיים בדצמבר״.</small>}
                {(input.month || input.nights) && <small>הבחירות בשדות גוברות על הטקסט: {input.month ? months.find(m => m.key === input.month)?.label : "החודש לפי הטקסט"} · {input.nights ? EXPLORE_NIGHTS.find(n => n.value === input.nights)?.label : "משך החופשה לפי הטקסט"}.</small>}
              </p>
              {fieldError("text") && <p className="q-error" id="xf-text-error"><Info size={16} aria-hidden="true" />{fieldError("text")}</p>}
            </div>

            <fieldset className="xf-field adv-group">
              <legend>מאיפה</legend>
              <div className="pill-row">
                {EXPLORE_ORIGINS.map((o) => <button type="button" key={o.code} className={`pill ${input.origin === o.code ? "is-on" : ""}`} aria-pressed={input.origin === o.code} onClick={() => set({ origin: o.code })}>{o.label} <span dir="ltr" className="pill-code">{o.code}</span></button>)}
              </div>
            </fieldset>

            <div className="xf-field">
              <label htmlFor="xf-month">חודש</label>
              <select id="xf-month" className="xf-select" value={input.month} onChange={(e) => set({ month: e.target.value })}
                aria-invalid={fieldError("month") ? true : undefined} aria-describedby={fieldError("month") ? "xf-month-error" : undefined}>
                <option value="">לפי הטקסט</option>
                {months.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
              {fieldError("month") && <p className="q-error" id="xf-month-error"><Info size={16} aria-hidden="true" />{fieldError("month")}</p>}
            </div>

            <div className="xf-field">
              <label htmlFor="xf-nights">כמה לילות</label>
              <select id="xf-nights" className="xf-select" value={input.nights} onChange={(e) => set({ nights: e.target.value })}>
                {EXPLORE_NIGHTS.map((n) => <option key={n.value} value={n.value}>{n.label}</option>)}
              </select>
            </div>

            <div className="xf-field">
              <label htmlFor="xf-budget">תקציב מקסימלי למבוגר, בשקלים <span className="optional">(לא חובה)</span></label>
              <input id="xf-budget" className="xf-input" inputMode="numeric" dir="ltr" autoComplete="off" placeholder="למשל 1200" value={input.maxPrice}
                aria-invalid={fieldError("maxPrice") ? true : undefined} aria-describedby={fieldError("maxPrice") ? "xf-budget-error" : undefined}
                onChange={(e) => set({ maxPrice: e.target.value })} />
              {fieldError("maxPrice") && <p className="q-error" id="xf-budget-error"><Info size={16} aria-hidden="true" />{fieldError("maxPrice")}</p>}
            </div>
          </div>

          <div className="xf-actions">
            <button type="submit" className="btn btn-cta" disabled={run.status === "loading"}><Compass size={22} aria-hidden="true" />{run.status === "loading" ? "מחפשים…" : "הראו לי לאן"}</button>
            <p className="honest"><Info size={16} aria-hidden="true" />מחירים שמורים (מטמון) מחיפושים של משתמשים, לרוב בני כמה ימים, הלוך־חזור למבוגר אחד. המחיר העדכני נבדק באתר ההזמנה.</p>
          </div>
        </form>

        <section className="results" aria-labelledby="explore-results">
          {run.status === "idle" && <h2 id="explore-results" tabIndex={-1} className="sr-only">תוצאות</h2>}
          {run.status === "loading" && <div className="loading">
            <h2 id="explore-results" tabIndex={-1}>מחפשים יעדים…</h2>
            <div className="xgrid" aria-hidden="true">{[0, 1, 2].map((i) => <div key={i} className="xcard skeleton"><div className="sk sk-text" /><div className="sk sk-price" /><div className="sk sk-row" /></div>)}</div>
          </div>}
          {run.status === "failed" && <FailureBox notice={run.notice} lines={run.lines} retryAt={run.retryAt} headingId="explore-results"
            onRetry={() => void load(lastTried.current?.input ?? input, lastTried.current?.sort ?? "price")} />}
          {run.status === "done" && <ExploreResults response={run.response} sort={run.sort} sorting={run.sorting} sortError={run.sortError} onSort={changeSort} onFill={fillSearch} />}
        </section>
      </main>
      <SiteFooter />
    </div>
    <LiveRegion text={announcement} />
  </>;
}

function ExploreResults({ response, sort, sorting, sortError, onSort, onFill }: {
  response: ExploreResponse; sort: ExploreSort; sorting: ExploreSort | null; sortError: string | null;
  onSort: (s: ExploreSort) => void; onFill: (r: ExploreResult) => void;
}) {
  const { meta } = response;
  const results = sortResults(response.results, sort);
  const understood = meta.understood;
  const summary = understood ? understoodSummary(understood) : "";
  const [now] = useState(() => new Date());
  return <div className="results-body xresults">
    <h2 id="explore-results" tabIndex={-1} className="results-title">
      {results.length ? `${results.length === 1 ? "יעד אחד" : `${results.length} יעדים`} מ${meta.origin.nameHe ?? meta.origin.code}` : "לא מצאנו יעדים שמתאימים"}
    </h2>
    <p className="xmeta num">
      <CalendarDays size={16} aria-hidden="true" />
      <span dir="ltr">{formatShortDate(meta.window.start)} – {formatShortDate(meta.window.end)}</span>
      {meta.nights && <span>· {meta.nights.min === meta.nights.max ? `${meta.nights.min} לילות` : `${meta.nights.min}–${meta.nights.max} לילות`}</span>}
      {meta.maxPriceIls !== null && <span>· עד {formatILS(meta.maxPriceIls)}</span>}
      <span>· {meta.destinationsFound} יעדים עם מחיר שמור בטווח</span>
    </p>

    {understood && <div className="understood">
      <p><Sparkles size={16} aria-hidden="true" /><span>מה הבנו מ״<bdi>{understood.text}</bdi>״: <strong>{summary || "לא הצלחנו לקרוא אורך או חודש"}</strong></span></p>
      {understood.message && <p className="understood-miss">{understood.message}</p>}
    </div>}

    {results.length > 0 && <div className="sort-row" role="group" aria-label="סידור התוצאות" aria-busy={sorting ? true : undefined}>
      <span>סידור:</span>
      <button type="button" className={`pill ${sort === "price" ? "is-on" : ""}`} aria-pressed={sort === "price"} onClick={() => onSort("price")}>הכי זול</button>
      <button type="button" className={`pill ${sort === "score" ? "is-on" : ""}`} aria-pressed={sort === "score"} onClick={() => onSort("score")}>לפי ציון כולל</button>
      {sorting && <span className="sort-busy">מסדרים…</span>}
    </div>}
    {sortError && <p className="sort-error"><Info size={16} aria-hidden="true" /><span>{sortError}</span></p>}

    {results.length > 0 && <ol className="xgrid">
      {results.map((r, i) => <li key={`${r.destination.code}-${r.departDate}-${r.returnDate}`}><ExploreCard result={r} rank={i + 1} now={now} onFill={onFill} /></li>)}
    </ol>}

    {results.length === 0 && <p className="calm-note"><Info size={18} aria-hidden="true" /><span>
      {meta.maxPriceIls !== null && meta.destinationsFound > 0 ? "יש יעדים עם מחיר בטווח, אבל לא בתקציב הזה. נסו תקציב גבוה יותר." : "אין מחירים שמורים שמתאימים לבקשה. נסו חודש אחר, אורך טיול אחר, או לצאת מנמל תעופה אחר."}
    </span></p>}

    {meta.notes.length > 0 && <ul className="xnotes">{meta.notes.map((n) => <li key={n}><Info size={16} aria-hidden="true" /><span>{n}</span></li>)}</ul>}
    {resultsNeedHolidayCredit(results) && <HolidayCredit attribution={meta.holidaysAttribution} />}
  </div>;
}

export function ExploreCard({ result, rank, now, onFill }: { result: ExploreResult; rank: number; now: Date; onFill: (r: ExploreResult) => void }) {
  const titleId = useId();
  const name = destinationName(result.destination);
  const title = destinationTitle(result.destination);
  const book = trustedBookingUrl(result.links.book);
  const climate = climateText(result.climate);
  const found = foundAgeText(result.foundAt, now);
  const parts = scoreParts(result.score);
  return <article className="xcard" aria-labelledby={titleId}>
    <div className="xcard-top">
      <div>
        <h3 id={titleId} className="xcard-title"><span className="xrank num" aria-hidden="true">{rank}</span>{title}</h3>
        <p className="xcard-sub">
          <span dir="ltr" className="num">{result.destination.code}</span>
          {result.destination.category && <span> · {CATEGORY_HE[result.destination.category] ?? ""}</span>}
        </p>
      </div>
      <div className="xprice">
        <div className="xprice-main num" dir="ltr">{formatILS(result.price.ils)}</div>
        <div className="xprice-sub">למבוגר, הלוך־חזור</div>
      </div>
    </div>
    <div className="dots"><p className="dots-row mini-line">
      <span className="nowrap"><span className="num" dir="ltr">{formatShortDate(result.departDate)}</span><ArrowLeft size={14} aria-hidden="true" className="mini-arrow" /><span className="sr-only">עד</span><span className="num" dir="ltr">{formatShortDate(result.returnDate)}</span></span>
      <span>{result.nights === 1 ? "לילה אחד" : `${result.nights} לילות`}</span>
      <span>{stopsLabel(result.stops)}</span>
      {result.departTime && <span>המראה <span className="num" dir="ltr">{result.departTime}</span></span>}
    </p></div>
    {climate && <p className="xline"><SunMedium size={16} aria-hidden="true" />{climate}</p>}
    <TripHolidays holidayHe={result.holidayHe} vacationDaysUsed={result.vacationDaysUsed} />
    <p className="freshness">{found ?? "מחיר שמור מהימים האחרונים"} · עשוי להשתנות</p>

    <details className="score-details">
      <summary><span>ציון כולל <strong className="num">{result.score.total}</strong><span className="sr-only"> מתוך 100</span></span><span className="score-open">פירוט</span></summary>
      <dl className="score-list">
        {parts.map((p) => <div key={p.key}>
          <dt>{p.label} <small>משקל {p.weightPct}%</small></dt>
          <dd>
            {p.value === null
              ? <span className="score-unknown">לא ידוע, לא נכלל בציון</span>
              : <><meter min={0} max={100} value={p.value} aria-label={`${p.label}: ${p.value} מתוך 100`} /><span className="num">{p.value}</span></>}
            <small>{p.hint}</small>
          </dd>
        </div>)}
      </dl>
    </details>

    <div className="xcard-actions">
      <button type="button" className="btn btn-primary" onClick={() => onFill(result)}><Search size={18} aria-hidden="true" />מלאו את החיפוש עם {name}</button>
      {book && <a className="btn btn-ghost" href={book} target="_blank" rel="sponsored noopener noreferrer">לבדיקה באתר <span className="brand-word">Aviasales</span><ExternalLink size={16} aria-hidden="true" /><span className="sr-only"> (נפתח בחלון חדש)</span></a>}
    </div>
  </article>;
}

