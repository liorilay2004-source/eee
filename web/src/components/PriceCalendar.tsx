import { useEffect, useId, useState } from "react";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import { fetchCalendar } from "../api/client";
import type { CalendarResponse } from "../api/contract";
import {
  LEVEL_LABELS, WEEKDAYS_SHORT, buildCalendarGrid, calendarFailureText, calendarKey, calendarParams, calendarStatusText, cellLabel, datesForCell,
  shiftMonth, type CalendarCell,
} from "../lib/calendar";
import { monthName } from "../lib/explore";
import { isAbort, toApiFailure } from "../lib/failure";
import { nightsText } from "../lib/builder";
import type { SearchForm } from "../lib/search";

type Dates = Pick<SearchForm, "windowStart" | "windowEnd" | "stayMin" | "stayMax">;

interface Props {
  form: SearchForm;
  today: string;
  /** The months the user may browse (the month chips' range). */
  months: readonly string[];
  initialMonth: string;
  /**
   * The stay range the calendar prices, fixed when the question opens: tapping a day sets an exact stay, and the
   * calendar must not then re-price itself for that one length under the user's finger.
   */
  stay: readonly [number, number];
  onPick: (dates: Dates) => void;
}

/** Same parameters within a few minutes = the same answer: flipping months back and forth costs no new requests. */
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; data: CalendarResponse }>();
const DEBOUNCE_MS = 350;

type Load =
  | { status: "loading"; key: string }
  | { status: "done"; key: string; data: CalendarResponse }
  | { status: "failed"; key: string; text: string };

function cached(key: string): CalendarResponse | null {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < CACHE_MS ? hit.data : null;
}

/**
 * A month of cached prices as a heat-map, inside the "when" question. Asked for only when origin and destination are
 * chosen, debounced, and never in the way: when it fails, a calm line says so and the question works as before.
 */
export function PriceCalendar({ form, today, months, initialMonth, stay, onPick }: Props) {
  const titleId = useId();
  const [month, setMonth] = useState(initialMonth);
  const params = calendarParams({ origin: form.origin, destination: form.destination, stayMin: stay[0], stayMax: stay[1] }, month);
  const key = params ? calendarKey(params) : null;
  const [load, setLoad] = useState<Load | null>(null);

  useEffect(() => {
    if (!key) return;
    const [origin, destination, m, minNights, maxNights] = key.split("|");
    const query = { origin, destination, month: m, minNights, maxNights };
    const hit = cached(key);
    if (hit) {
      const timer = window.setTimeout(() => setLoad({ status: "done", key, data: hit }), 0);
      return () => window.clearTimeout(timer);
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoad({ status: "loading", key });
      fetchCalendar(query, controller.signal)
        .then((data) => {
          cache.set(key, { at: Date.now(), data });
          setLoad({ status: "done", key, data });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || isAbort(error)) return;
          setLoad({ status: "failed", key, text: calendarFailureText(toApiFailure(error, navigator.onLine)) });
        });
    }, DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [key]);

  if (!params) {
    return <section className="pcal is-empty" aria-labelledby={titleId}>
      <h3 className="q-subtitle" id={titleId}>לוח מחירים</h3>
      <p className="q-help"><Info size={16} aria-hidden="true" />בחרו מאיפה ולאן טסים, ונראה כאן את המחיר השמור הזול ביותר לכל יום יציאה.</p>
    </section>;
  }

  const current = load && load.key === key ? load : { status: "loading" as const, key };
  const index = months.indexOf(month);
  const prev = index > 0 ? months[index - 1] : null;
  const next = index >= 0 && index < months.length - 1 ? months[index + 1] : index < 0 ? shiftMonth(month, 1) : null;
  const data = current.status === "done" ? current.data : null;
  const weeks = data ? buildCalendarGrid(month, data.days, today, data.meta.cheapest?.date ?? null) : null;
  const priced = data ? data.days.filter((d) => d.fare).length : 0;
  const hasLevels = data ? data.days.some((d) => d.fare?.level) : false;

  const selected = (cell: CalendarCell) => cell.kind === "priced" && cell.date === form.windowStart && cell.returnDate === form.windowEnd;
  const status = calendarStatusText(monthName(month), current.status === "done" ? { status: "done", priced } : current);
  // aria-disabled rather than disabled: a disabled button drops the keyboard focus it holds (to <body>) at the last month.
  const go = (target: string | null) => { if (target) setMonth(target); };

  return <section className="pcal" aria-labelledby={titleId}>
    <div className="pcal-head">
      <h3 className="q-subtitle" id={titleId}>לוח מחירים · <span>{monthName(month)}</span></h3>
      <div className="pcal-nav">
        <button type="button" className="icon-button" aria-label="החודש הקודם" aria-disabled={!prev} onClick={() => go(prev)}><ChevronRight size={20} aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label="החודש הבא" aria-disabled={!next} onClick={() => go(next)}><ChevronLeft size={20} aria-hidden="true" /></button>
      </div>
    </div>
    <p className="pcal-basis">המחיר השמור הזול ביותר בשקלים, הלוך־חזור למבוגר אחד, לטיול של {nightsText(Number(params.minNights), Number(params.maxNights))}. הקישו על יום כדי לבחור בדיוק את התאריכים שלו.</p>

    {/* One persistent region (never mounted with its text), so every month change and load result is announced. */}
    <p className="sr-only" role="status" aria-live="polite">{status}</p>

    {current.status === "failed" && <p className="pcal-fail"><Info size={16} aria-hidden="true" />{current.text}</p>}

    {current.status !== "failed" && <>
      {hasLevels && <ul className="pcal-legend" aria-label="מקרא">
        {(["low", "mid", "high"] as const).map((level) => <li key={level}><span className={`pcal-swatch lvl-${level}`} aria-hidden="true" />{LEVEL_LABELS[level]}</li>)}
        <li><span className="pcal-swatch lvl-none" aria-hidden="true" />אין מחיר שמור</li>
      </ul>}
      <div className="pcal-grid" role="group" aria-labelledby={titleId} aria-busy={current.status === "loading"}>
        {WEEKDAYS_SHORT.map((d) => <span key={d} className="pcal-wd" aria-hidden="true">{d}</span>)}
        {weeks
          ? weeks.flat().map((cell, i) => <Cell key={cell.date ?? `pad-${i}`} cell={cell} selected={selected(cell)} onPick={onPick} />)
          : Array.from({ length: 35 }, (_, i) => <span key={i} className="pcal-cell sk" aria-hidden="true" />)}
      </div>
      {data && <div className="pcal-foot">
        {priced === 0 && <p className="pcal-empty">אין מחירים שמורים לחודש הזה במסלול הזה. זה לא אומר שאין טיסות: אפשר עדיין לחפש.</p>}
        {data.meta.unavailableHe && <p className="pcal-empty">{data.meta.unavailableHe}</p>}
        <p className="pcal-notice">{data.meta.noticeHe}</p>
      </div>}
    </>}
  </section>;
}

function Cell({ cell, selected, onPick }: { cell: CalendarCell; selected: boolean; onPick: (dates: Dates) => void }) {
  if (cell.kind === "pad") return <span className="pcal-cell is-pad" aria-hidden="true" />;
  const label = cellLabel(cell);
  const dates = datesForCell(cell);
  if (!dates) {
    return <span className={`pcal-cell is-${cell.kind}`} role="img" aria-label={label}>
      <span className="pcal-day num">{cell.day}</span>
      <span className="pcal-mark" aria-hidden="true">{cell.kind === "unknown" ? "?" : "–"}</span>
    </span>;
  }
  return <button type="button" className={`pcal-cell is-priced lvl-${cell.level ?? "none"} ${cell.cheapest ? "is-cheapest" : ""} ${selected ? "is-on" : ""}`} aria-pressed={selected} aria-label={label} onClick={() => onPick(dates)}>
    {selected && <span className="pcal-check" aria-hidden="true">✓</span>}
    <span className="pcal-day num">{cell.day}</span>
    <span className="pcal-price num" dir="ltr">{Math.ceil(cell.priceIls as number).toLocaleString("en-US")}</span>
    {cell.level && <span className="pcal-level" aria-hidden="true">{LEVEL_LABELS[cell.level]}</span>}
  </button>;
}
