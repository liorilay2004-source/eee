import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { ChevronDown, CircleAlert, Clock3, Compass, MapPinned, Search, SlidersHorizontal } from "lucide-react";
import { Sheet } from "./Sheet";
import { FromQuestion, PairHint, ToQuestion, WhenQuestion, StayQuestion, WhoQuestion, type Patch } from "./Questions";
import {
  QUESTIONS, QUESTION_TITLES, placeLabel, rangeLabel, stayLabel, whenLabel, whoLabel,
  type FieldErrors, type Question,
} from "../lib/builder";
import { hasHourPreferences, type SearchForm } from "../lib/search";

interface Props {
  form: SearchForm;
  patch: Patch;
  today: string;
  errors: FieldErrors;
  /** Client validation keys (for the advanced hour pickers). */
  rawErrors: Record<string, string>;
  openQuestion: Question | null;
  setOpenQuestion: (q: Question | null) => void;
  onSubmit: () => void;
  editing: boolean;
  onCancelEdit: () => void;
}

const sheetId = (q: Question) => `sheet-${q}`;
const errorId = (q: Question) => `error-${q}`;

const SHORT: Record<Question, string> = { from: "מאיפה", to: "לאן", when: "מתי", stay: "לכמה זמן", who: "מי טס" };

const HOUR_CHOICES: [string, string][] = [
  ["none", "ללא העדפה"], ["morning", "בוקר 06–12"], ["afternoon", "צהריים 12–17"], ["evening", "ערב 17–23"], ["night", "לילה 23–06"], ["custom", "שעות אחרות"],
];

function HourPicker({ legend, preset, custom, error, onPreset, onCustom, name }: {
  legend: string; preset: string; custom: [number, number]; error?: string; name: string;
  onPreset: (value: string) => void; onCustom: (value: [number, number]) => void;
}) {
  const hours = Array.from({ length: 25 }, (_, n) => n);
  return <fieldset className="adv-group">
    <legend>{legend}</legend>
    <div className="pill-row">
      {HOUR_CHOICES.map(([key, label]) => <button type="button" key={key} className={`pill ${preset === key ? "is-on" : ""}`} aria-pressed={preset === key} onClick={() => onPreset(key)}>{label}</button>)}
    </div>
    {preset === "custom" && <div className="hour-range">
      <label><span>משעה</span><select value={custom[0]} onChange={(e) => onCustom([Number(e.target.value), custom[1]])} name={`${name}-from`}>{hours.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}</select></label>
      <label><span>עד שעה</span><select value={custom[1]} onChange={(e) => onCustom([custom[0], Number(e.target.value)])} name={`${name}-to`}>{hours.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}</select></label>
    </div>}
    {error && <p className="q-error"><CircleAlert size={16} aria-hidden="true" />{error}</p>}
  </fieldset>;
}

function Advanced({ form, patch, rawErrors }: { form: SearchForm; patch: Patch; rawErrors: Record<string, string> }) {
  const [open, setOpen] = useState(() => hasHourPreferences(form) || form.nearbyAirports);
  const hours = hasHourPreferences(form);
  const setPreset = (which: "out" | "ret", value: string) => {
    const next: Partial<SearchForm> = which === "out"
      ? { outHoursPreset: value, useCustomOut: value === "custom" }
      : { retHoursPreset: value, useCustomRet: value === "custom" };
    const out = which === "out" ? value : form.outHoursPreset;
    const ret = which === "ret" ? value : form.retHoursPreset;
    if (out === "none" && ret === "none") next.maxStops = null;
    patch(next);
  };
  const stops: [number | null, string][] = [[null, "ללא הגבלה"], [0, "ישירה בלבד"], [1, "עד עצירה אחת"], [2, "עד 2 עצירות"]];
  return <div className="advanced">
    <button type="button" className="adv-toggle" aria-expanded={open} aria-controls="advanced-panel" onClick={() => setOpen(!open)}>
      <SlidersHorizontal size={18} aria-hidden="true" /><span>אפשרויות מתקדמות</span>
      {(hours || form.nearbyAirports) && <span className="adv-count">פעיל</span>}
      <ChevronDown size={18} aria-hidden="true" className="adv-chevron" />
    </button>
    <div id="advanced-panel" className="adv-panel" hidden={!open}>
      <p className="q-help"><Clock3 size={16} aria-hidden="true" />שעות ועצירות משפיעות רק על ההמלצה ״מתאים לשעות שלכם״. ההצעה הזולה ביותר תוצג בכל מקרה.</p>
      <HourPicker legend="שעת המראה בהלוך" name="out" preset={form.outHoursPreset} custom={form.customOut} error={rawErrors.outHours}
        onPreset={(v) => setPreset("out", v)} onCustom={(v) => patch({ customOut: v })} />
      <HourPicker legend="שעת המראה בחזור" name="ret" preset={form.retHoursPreset} custom={form.customRet} error={rawErrors.retHours}
        onPreset={(v) => setPreset("ret", v)} onCustom={(v) => patch({ customRet: v })} />
      <div className="adv-block">
        <fieldset className="adv-group" disabled={!hours} aria-describedby="stops-help">
          <legend>מספר עצירות</legend>
          <div className="pill-row">
            {stops.map(([value, label]) => <button type="button" key={label} className={`pill ${form.maxStops === value ? "is-on" : ""}`} aria-pressed={form.maxStops === value} onClick={() => patch({ maxStops: value })}>{label}</button>)}
          </div>
        </fieldset>
        {/* Outside the (possibly disabled) fieldset: the explanation is text to read, never dimmed. */}
        <p className="q-help" id="stops-help">{hours ? "חל על ההמלצה ״מתאים לשעות שלכם״." : "זמין אחרי שבוחרים שעת המראה מועדפת, כי העצירות נבדקות יחד עם השעות."}</p>
      </div>
      <button type="button" role="switch" aria-checked={form.nearbyAirports} className={`switch-row ${form.nearbyAirports ? "is-on" : ""}`} onClick={() => patch({ nearbyAirports: !form.nearbyAirports })}>
        <span className="switch-icon"><MapPinned size={22} aria-hidden="true" /></span>
        <span className="switch-copy"><strong>גם שדות תעופה קרובים</strong><small>נבדוק גם שדות בסביבת המוצא והיעד.</small></span>
        <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
      </button>
    </div>
  </div>;
}

function Chip({ q, value, empty, open, error, chipRef, onOpen }: {
  q: Question; value: string; empty: boolean; open: boolean; error?: string;
  chipRef: RefObject<HTMLButtonElement | null>; onOpen: () => void;
}) {
  return <button
    ref={chipRef}
    type="button"
    className={`chip ${empty ? "is-empty" : ""} ${error ? "has-error" : ""} ${open ? "is-open" : ""}`}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={sheetId(q)}
    aria-label={`${QUESTION_TITLES[q]} ${empty ? "עוד לא נבחר" : value}`}
    aria-describedby={error ? errorId(q) : undefined}
    onClick={onOpen}
  >
    <span className="chip-q" aria-hidden="true">{SHORT[q]}</span>
    <span className="chip-v">{value}</span>
    <ChevronDown size={18} aria-hidden="true" className="chip-caret" />
  </button>;
}

export function Builder({ form, patch, today, errors, rawErrors, openQuestion, setOpenQuestion, onSubmit, editing, onCancelEdit }: Props) {
  const refs = {
    from: useRef<HTMLButtonElement>(null),
    to: useRef<HTMLButtonElement>(null),
    when: useRef<HTMLButtonElement>(null),
    stay: useRef<HTMLButtonElement>(null),
    who: useRef<HTMLButtonElement>(null),
  } satisfies Record<Question, RefObject<HTMLButtonElement | null>>;

  const when = whenLabel(form.windowStart, form.windowEnd, today);
  const values: Record<Question, { value: string; empty: boolean }> = {
    from: { value: form.origin ? placeLabel(form.origin, form.originLabel) : "מאיפה?", empty: !form.origin },
    to: { value: form.destination ? placeLabel(form.destination, form.destinationLabel) : "איפה?", empty: !form.destination },
    when: { value: when || "מתי?", empty: !when },
    stay: { value: stayLabel(form.stayMin, form.stayMax), empty: false },
    who: { value: whoLabel(form), empty: false },
  };

  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit(); };
  const chip = (q: Question) => <Chip q={q} {...values[q]} open={openQuestion === q} error={errors.byQuestion[q]} chipRef={refs[q]} onOpen={() => setOpenQuestion(q)} />;

  const open = openQuestion;
  const nextQ = open ? QUESTIONS[QUESTIONS.indexOf(open) + 1] : undefined;
  const questionProps = open ? { form, patch, today, error: errors.byQuestion[open], errorId: `${sheetId(open)}-error` } : null;
  let body: ReactNode = null;
  if (open && questionProps) {
    body = open === "from" ? <FromQuestion {...questionProps} />
      : open === "to" ? <ToQuestion {...questionProps} />
        : open === "when" ? <WhenQuestion {...questionProps} />
          : open === "stay" ? <StayQuestion {...questionProps} />
            : <WhoQuestion {...questionProps} />;
  }

  const errorEntries = QUESTIONS.filter((q) => errors.byQuestion[q]);
  return <form className="builder" onSubmit={submit} noValidate aria-labelledby="builder-title">
    <div className="builder-head">
      <p className="kicker">חיפוש גמיש · שאלה אחת בכל פעם</p>
      <h1 id="builder-title">{editing ? "מה משנים?" : "לאן בא לכם לטוס?"}</h1>
      <p className="builder-sub">הקישו על כל חלק במשפט כדי לבחור. אנחנו נמצא את הצירוף הזול ביותר.</p>
      {!editing && <a className="explore-link" href="/explore"><Compass size={18} aria-hidden="true" /><span>לא יודע לאן? <strong>גלו יעדים זולים</strong></span></a>}
    </div>

    <div className="sentence" role="group" aria-label="פרטי החיפוש">
      <span className="unit"><span className="w" aria-hidden="true">מ־</span>{chip("from")}</span>
      <span className="unit"><span className="w" aria-hidden="true">ל־</span>{chip("to")}</span>
      <span className="unit">{chip("when")}</span>
      <span className="unit">{chip("stay")}</span>
      <span className="unit">{chip("who")}</span>
    </div>

    {(errorEntries.length > 0 || errors.general.length > 0) && <div className="chip-errors">
      {errorEntries.map((q) => <p key={q} id={errorId(q)} className="q-error"><CircleAlert size={16} aria-hidden="true" /><span><strong>{SHORT[q]}:</strong> {errors.byQuestion[q]}</span></p>)}
      {errors.general.map((m) => <p key={m} className="q-error"><CircleAlert size={16} aria-hidden="true" />{m}</p>)}
    </div>}

    {form.windowStart && form.windowEnd && <div className="builder-range">
      <span>טווח: <strong className="num">{rangeLabel(form.windowStart, form.windowEnd)}</strong></span>
      <PairHint form={form} />
    </div>}

    <Advanced form={form} patch={patch} rawErrors={rawErrors} />

    <div className="cta-bar">
      <button type="submit" className="btn btn-cta"><Search size={22} aria-hidden="true" />מצאו לי את הזול ביותר</button>
      {editing && <button type="button" className="btn btn-ghost" onClick={onCancelEdit}>חזרה לתוצאות</button>}
    </div>

    {open && <Sheet
      id={sheetId(open)}
      title={QUESTION_TITLES[open]}
      anchor={refs[open]}
      onClose={() => setOpenQuestion(null)}
      footer={<>
        {nextQ
          ? <button type="button" className="btn btn-primary btn-wide" onClick={() => setOpenQuestion(nextQ)}>הבא: {QUESTION_TITLES[nextQ]}</button>
          : <button type="button" className="btn btn-primary btn-wide" onClick={() => setOpenQuestion(null)}>סיום</button>}
      </>}
    >{body}</Sheet>}
  </form>;
}
