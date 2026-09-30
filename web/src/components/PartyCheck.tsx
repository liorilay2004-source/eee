import { useEffect, useRef, useState } from "react";
import { Ban, CircleCheck, CircleHelp, ExternalLink, LoaderCircle, SearchCheck, TriangleAlert, Users } from "lucide-react";
import { checkParty } from "../api/client";
import type { CardView, PartyCheckResult } from "../api/contract";
import { isAbort, toApiFailure } from "../lib/failure";
import {
  AUTO_CHECK_LABEL, AUTO_CHECK_NOTE, CHILDREN_TEXT, COMPARE_NOTE, DOWNSIDES, DOWNSIDES_TITLE, FLIGHT_CAVEAT, LIVE_PRICES_NOTE, MALFORMED_TEXT, SPLIT_INSTRUCTION,
  WHY_TEXT, WHY_TITLE, WHY_TITLE_CHILDREN,
  canAutoCheck, partyBoxView, partyButtonLabel, partyCheckFailureView, partyCheckRequest, partyInstruction, partyTitle, readPartyCheckResult,
  singleButtonLabel, verdictView,
} from "../lib/partycheck";

function NewTab() {
  return <span className="sr-only"> (נפתח בחלון חדש)</span>;
}

/** The answer of an automatic check. The separate price is always worded as an estimate (see verdictView). */
export function PartyVerdict({ result, airlineNames }: { result: PartyCheckResult; airlineNames?: Readonly<Record<string, string>> }) {
  const view = verdictView(result, airlineNames);
  return <div className={`party-verdict tone-${view.tone}`}>
    <p className="party-verdict-title"><strong>{view.title}</strong></p>
    {view.lines.length > 0 && <ul>{view.lines.map((line) => <li key={line.label}>
      {line.label}: <span dir="ltr" className="num">{line.amount}</span>
      {line.original && <> <span dir="ltr" className="num">({line.original})</span></>}
      {line.perPerson && <>, כ־<span dir="ltr" className="num">{line.perPerson}</span> לנוסע</>}
    </li>)}</ul>}
    {view.flight && <p className="party-flight">
      הטיסה שהושוותה:{" "}
      {view.flight.outbound && <>הלוך ב־<span dir="ltr" className="num">{view.flight.outbound}</span></>}
      {view.flight.outbound && view.flight.inbound && ", "}
      {view.flight.inbound && <>חזור ב־<span dir="ltr" className="num">{view.flight.inbound}</span></>}
      {view.flight.airlines && <>{(view.flight.outbound || view.flight.inbound) && ", "}{view.flight.airlines}</>}
      {!view.flight.outbound && !view.flight.inbound && !view.flight.airlines && "פרטי הטיסה לא ידועים"}
      . {FLIGHT_CAVEAT}
    </p>}
    {view.note && <p>{view.note}</p>}
    {view.reminder && <p><strong>{view.reminder}</strong></p>}
  </div>;
}

export type AutoCheckState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; result: PartyCheckResult }
  /** `retry: false` when trying again cannot help now (the button then stays off); absent = it may. */
  | { status: "error"; text: string; retry?: boolean };

/**
 * The automatic check's button and its outcome (no state of its own, so every state can be rendered in a test). ONE button through
 * every state, made inactive with aria-disabled (never `disabled`, which would drop the keyboard focus it holds to <body>): busy
 * while the check runs, and for good once there is an answer (a second click would spend two more of the source's free
 * searches for an answer already on screen) or a failure that a new try cannot fix. The live region is always rendered, so
 * what lands in it is announced.
 */
export function AutoCheckView({ state, onRun, airlineNames }: { state: AutoCheckState; onRun?: () => void; airlineNames?: Readonly<Record<string, string>> }) {
  const loading = state.status === "loading";
  const done = state.status === "done";
  const closed = state.status === "error" && state.retry === false;
  const inactive = loading || done || closed;
  const label = loading ? "בודקים עכשיו…" : done ? "הבדיקה הושלמה" : closed ? "הבדיקה האוטומטית לא זמינה" : state.status === "error" ? "נסו שוב" : AUTO_CHECK_LABEL;
  const icon = loading
    ? <LoaderCircle size={18} className="spin" aria-hidden="true" />
    : done ? <CircleCheck size={18} aria-hidden="true" />
      : closed ? <Ban size={18} aria-hidden="true" />
        : <SearchCheck size={18} aria-hidden="true" />;
  return <div className="party-auto">
    <button type="button" className="btn btn-primary" aria-disabled={inactive || undefined} onClick={() => { if (!inactive) onRun?.(); }}>
      {icon}{label}
    </button>
    <p className="party-note">{AUTO_CHECK_NOTE}</p>
    <div aria-live="polite" className="party-auto-out">
      {loading && <p className="sr-only">בודקים עכשיו. זה לוקח כמה שניות.</p>}
      {state.status === "done" && <PartyVerdict result={state.result} airlineNames={airlineNames} />}
      {state.status === "error" && <p className="party-error"><TriangleAlert size={16} aria-hidden="true" /><span>{state.text}</span></p>}
    </div>
  </div>;
}

/** Asks POST /api/party-check for this card, only on a click, never twice at once. Leaving the page cancels it. */
function AutoCheck({ card, adults }: { card: CardView; adults: number }) {
  const [state, setState] = useState<AutoCheckState>({ status: "idle" });
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);
  const run = async () => {
    if (inFlight.current) return; // one check at a time (the button is inactive meanwhile anyway)
    const controller = new AbortController();
    inFlight.current = controller;
    setState({ status: "loading" });
    try {
      const raw = await checkParty(partyCheckRequest(card, adults), controller.signal);
      if (controller.signal.aborted) return;
      // Never show half-read numbers: an answer that does not read as a whole is reported, not rendered.
      const result = readPartyCheckResult(raw);
      setState(result ? { status: "done", result } : { status: "error", text: MALFORMED_TEXT, retry: false });
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted) return;
      const failure = partyCheckFailureView(toApiFailure(error, navigator.onLine));
      setState({ status: "error", text: failure.text, retry: failure.retry });
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  };
  return <AutoCheckView state={state} onRun={() => void run()} airlineNames={card.airlineNames} />;
}

/**
 * "זוג או בנפרד?" ("ביחד או בנפרד?" from 3 adults): a collapsed box on a card of a search for 2+ adults. Two links (one adult /
 * the whole group) to compare on the booking site, how to compare fairly, why it can matter, the downsides, and, only when the
 * API says it can run and gave this card its token, the automatic check. Nothing at all for one adult, an older API, a demo
 * card, or a link the web would not open.
 */
export function PartyCheckBox({ card, autoCheck = false, demo = false }: { card: CardView; autoCheck?: boolean; demo?: boolean }) {
  const view = demo ? null : partyBoxView(card);
  if (!view) return null;
  const children = view.kind === "children";
  return <details className="party-check">
    <summary><Users size={18} aria-hidden="true" />{partyTitle(view.adults)}</summary>
    <div className="party-body">
      {view.kind === "children" ? <p>{CHILDREN_TEXT}</p> : <>
        <p className="party-do">{partyInstruction(view.adults)}</p>
        <p className="party-note">{COMPARE_NOTE}</p>
        {view.rows.length > 1 && <p className="party-note">{SPLIT_INSTRUCTION}</p>}
        {view.rows.map((row) => <div className="party-links" key={row.label ?? "trip"}>
          {row.label && <span className="party-leg">{row.label}</span>}
          <a className="btn btn-secondary" href={row.single} target="_blank" rel="sponsored noopener noreferrer">{singleButtonLabel()}{row.label && <span className="sr-only">, {row.label}</span>}<ExternalLink size={16} aria-hidden="true" /><NewTab /></a>
          <a className="btn btn-secondary" href={row.party} target="_blank" rel="sponsored noopener noreferrer">{partyButtonLabel(view.adults)}{row.label && <span className="sr-only">, {row.label}</span>}<ExternalLink size={16} aria-hidden="true" /><NewTab /></a>
        </div>)}
        <p className="party-note">{LIVE_PRICES_NOTE}</p>
        {canAutoCheck(card, autoCheck) && <AutoCheck card={card} adults={view.adults} />}
      </>}
      <details className="party-why">
        <summary><CircleHelp size={16} aria-hidden="true" />{children ? WHY_TITLE_CHILDREN : WHY_TITLE}</summary>
        <p>{WHY_TEXT}</p>
      </details>
      <div className="party-downsides">
        <p className="party-downsides-title">{DOWNSIDES_TITLE}</p>
        <ul>{DOWNSIDES.map((d) => <li key={d}>{d}</li>)}</ul>
      </div>
    </div>
  </details>;
}
