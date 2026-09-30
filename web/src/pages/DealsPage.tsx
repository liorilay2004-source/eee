import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, Hourglass, Info, Search, TrendingDown, TriangleAlert } from "lucide-react";
import { SiteFooter, SiteHeader } from "../components/Chrome";
import { FailureBox, LiveRegion } from "../components/Notice";
import { fetchDeals } from "../api/client";
import type { DealsResponse, RouteDeal, RouteDealsView } from "../api/contract";
import { PRODUCT_NAME } from "../config";
import { nightsBetween } from "../lib/builder";
import {
  STATUS_TAG_HE, checkedAgoText, dealSearchHref, describeDealsFailure, emptyStateLines, readinessOf, routeName, sortRoutes, statusCounts, statusLabel,
} from "../lib/deals";
import { isAbort, retryAtFrom, toApiFailure, type FailureNotice } from "../lib/failure";
import { useAnnouncer } from "../lib/hooks";
import { formatILS, formatShortDate } from "../lib/search";

type Load =
  | { status: "loading" }
  | { status: "done"; data: DealsResponse }
  | { status: "failed"; notice: FailureNotice; retryAt: number | null };

export function DealsPage() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [announcement, announce] = useAnnouncer();
  const controller = useRef<AbortController | null>(null);

  useEffect(() => { document.title = `מבצעים · ${PRODUCT_NAME}`; }, []);

  const run = useCallback(() => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setLoad({ status: "loading" });
    fetchDeals(abort.signal)
      .then((data) => {
        if (abort.signal.aborted) return;
        setLoad({ status: "done", data });
        const found = data.routes.reduce((n, r) => n + r.deals.length, 0);
        announce(found ? `נמצאו ${found} מחירים נמוכים במיוחד.` : "כרגע אין מבצעים להצגה.");
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted || isAbort(error)) return;
        const notice = describeDealsFailure(toApiFailure(error, navigator.onLine));
        setLoad({ status: "failed", notice, retryAt: retryAtFrom(notice) });
        announce(`${notice.title}. ${notice.body}`);
      });
  }, [announce]);

  useEffect(() => {
    const timer = window.setTimeout(run, 0);
    return () => { window.clearTimeout(timer); controller.current?.abort(); };
  }, [run]);

  return <>
    <div className="app">
      <SiteHeader current="/deals" />
      <main id="main" className="main">
        <header className="page-head">
          <p className="kicker">מחירים נמוכים ביחס להיסטוריה</p>
          <h1>מבצעים במסלולים שאנחנו עוקבים אחריהם</h1>
          <p className="builder-sub">מחיר מסומן כמבצע רק כשהוא נמוך בהרבה ממה שראינו לאותם תאריכים בעבר. לזה צריך היסטוריה: אנחנו בודקים מסלול אחד בכל שעה ואוספים מחירים לאורך ימים, ולכן בהתחלה רוב המסלולים יהיו ריקים או במצב ״אוספים היסטוריה״. זה צפוי.</p>
        </header>

        <section className="results" aria-labelledby="deals-heading">
          {load.status === "loading" && <div className="loading">
            <h2 id="deals-heading">טוענים את המסלולים…</h2>
            <div className="routes" aria-hidden="true">{[0, 1, 2, 3].map((i) => <div key={i} className="route skeleton"><div className="sk sk-text" /><div className="sk sk-row" /></div>)}</div>
          </div>}
          {load.status === "failed" && <FailureBox notice={load.notice} retryAt={load.retryAt} onRetry={run} headingId="deals-heading" />}
          {load.status === "done" && <DealsBody data={load.data} />}
        </section>
      </main>
      <SiteFooter />
    </div>
    <LiveRegion text={announcement} />
  </>;
}

function DealsBody({ data }: { data: DealsResponse }) {
  const routes = sortRoutes(data.routes, data.thresholds);
  const counts = statusCounts(data.routes);
  const withDeals = routes.filter((r) => r.status === "deals");
  const rest = routes.filter((r) => r.status !== "deals");
  const emptyLines = withDeals.length ? [] : emptyStateLines(counts, data.thresholds);
  return <div className="results-body">
    <h2 id="deals-heading" className="results-title">
      {withDeals.length ? `${withDeals.length === 1 ? "מסלול אחד" : `${withDeals.length} מסלולים`} עם מחיר נמוך במיוחד` : "כרגע אין מבצעים להצגה"}
    </h2>
    <ul className="status-chips" aria-label="מצב המסלולים">
      {(["deals", "insufficient_data", "no_deal", "no_recent_data", "stale", "not_computed"] as const).filter((s) => counts[s] > 0).map((s) =>
        <li key={s} className={`status-chip st-${s}`}><span className="num">{counts[s]}</span> {STATUS_TAG_HE[s]}</li>)}
    </ul>
    {emptyLines.length > 0 && <div className="calm-note"><Hourglass size={18} aria-hidden="true" />
      <ul className="calm-lines">{emptyLines.map((line) => <li key={line}>{line}</li>)}</ul>
    </div>}

    {withDeals.length > 0 && <div className="routes">{withDeals.map((r) => <RouteCard key={`${r.origin}-${r.destination}`} route={r} data={data} />)}</div>}

    {rest.length > 0 && <>
      <h3 className="minis-title">{withDeals.length ? "שאר המסלולים" : "המסלולים שאנחנו עוקבים אחריהם"}</h3>
      <div className="routes">{rest.map((r) => <RouteCard key={`${r.origin}-${r.destination}`} route={r} data={data} />)}</div>
    </>}

    <p className="disclaimer"><Info size={16} aria-hidden="true" />{data.noteHe}</p>
  </div>;
}

function Bar({ label, have, need, unit, pct }: { label: string; have: number; need: number; unit: string; pct: number }) {
  const id = useId();
  return <div className="bar">
    <div className="bar-head"><span id={id}>{label}</span><span className="num">{have} מתוך {need} {unit}</span></div>
    <progress max={need} value={have} aria-labelledby={id} aria-valuetext={`${have} מתוך ${need} ${unit}`} />
    <span className="sr-only">{pct}%</span>
  </div>;
}

function RouteCard({ route, data }: { route: RouteDealsView; data: DealsResponse }) {
  const titleId = useId();
  const readiness = readinessOf(route, data.thresholds);
  const computedHours = route.computedAt ? (Date.parse(data.asOf) - Date.parse(route.computedAt)) / 3_600_000 : null;
  return <article className={`route st-${route.status}`} aria-labelledby={titleId}>
    <div className="route-top">
      <h3 id={titleId} className="route-title">{routeName(route.origin, route.destination)}</h3>
      <span className={`status-tag st-${route.status}`}>{STATUS_TAG_HE[route.status]}</span>
    </div>
    <p className="route-label">{statusLabel(route)}</p>
    {readiness && <div className="readiness">
      <Bar label="בדיקות מחיר לאותם תאריכים" have={readiness.samples.have} need={readiness.samples.need} unit="בדיקות" pct={readiness.samples.pct} />
      <Bar label="ימים של היסטוריה" have={readiness.span.have} need={readiness.span.need} unit="ימים" pct={readiness.span.pct} />
    </div>}
    {route.deals.length > 0 && <ul className="deal-list">{route.deals.map((d) => <DealRow key={d.bucket} deal={d} route={route} />)}</ul>}
    <p className="route-meta">
      {computedHours !== null && Number.isFinite(computedHours) ? `המסלול נבדק ${checkedAgoText(computedHours).replace(/^נבדק /, "")}` : "המסלול עוד לא נבדק"}
      {route.truncated && " · חלק מההיסטוריה לא נכלל בבדיקה"}
      {route.fx?.stale && " · שער המטבע שבו השתמשנו אינו עדכני"}
    </p>
  </article>;
}

function DealRow({ deal, route }: { deal: RouteDeal; route: RouteDealsView }) {
  const nights = nightsBetween(deal.departDate, deal.returnDate);
  const error = deal.verdict === "error_fare";
  return <li className={`deal ${error ? "is-error" : ""}`}>
    <div className="deal-main">
      <div className="deal-price"><span className="num" dir="ltr">{formatILS(deal.priceIls)}</span><small>לנוסע, הלוך־חזור</small></div>
      <div className="deal-drop"><TrendingDown size={16} aria-hidden="true" />נמוך ב־<span className="num">{Math.floor(deal.dropPct)}%</span> מהרגיל</div>
    </div>
    <div className="dots"><p className="dots-row mini-line">
      <span className="nowrap"><span className="num" dir="ltr">{formatShortDate(deal.departDate)}</span><ArrowLeft size={14} aria-hidden="true" className="mini-arrow" /><span className="sr-only">עד</span><span className="num" dir="ltr">{formatShortDate(deal.returnDate)}</span></span>
      <span>{nights === 1 ? "לילה אחד" : `${nights} לילות`}</span>
      <span><span dir="ltr">{deal.origin}–{deal.destination}</span></span>
    </p></div>
    <p className={`deal-verdict ${error ? "tone-warn" : ""}`}>{error && <TriangleAlert size={15} aria-hidden="true" />}{deal.labelHe}</p>
    <p className="freshness">{checkedAgoText(deal.ageHours)} · מחיר שמור, ייתכן שהשתנה</p>
    <a className="btn btn-secondary" href={dealSearchHref(deal, route.origin, route.destination)}><Search size={18} aria-hidden="true" />חפשו את התאריכים האלה</a>
  </li>;
}
