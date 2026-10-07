import { useRef, type FormEvent, type ReactNode, type RefObject } from "react";
import { ChevronDown, CircleAlert, Compass, Search } from "lucide-react";
import { Sheet } from "./Sheet";
import { FlyFindFields, FlyFindTabs } from "./FlyFind";
import { FromQuestion, PairHint, ToQuestion, WhenQuestion, StayQuestion, WhoQuestion, type Patch } from "./Questions";
import {
  QUESTIONS, QUESTION_TITLES, placeLabel, rangeLabel, stayLabel, whenLabel, whoLabel,
  type FieldErrors, type Question,
} from "../lib/builder";
import { type SearchForm } from "../lib/search";

interface Props {
  flyFind?: boolean;
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

export function Builder({ form, patch, today, errors, openQuestion, setOpenQuestion, onSubmit, editing, onCancelEdit, flyFind = false }: Props) {
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
  const chip = (q: Question) => <Chip q={q} {...values[q]} open={openQuestion === q} error={errors.byQuestion[q]} chipRef={flyFind ? { current: null } : refs[q]} onOpen={() => setOpenQuestion(q)} />;

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
    {flyFind && <FlyFindTabs />}
    <div className="builder-head" hidden={flyFind}>
      <p className="kicker">חיפוש גמיש · שאלה אחת בכל פעם</p>
      <h1 id="builder-title">{editing ? "מה משנים?" : "לאן בא לכם לטוס?"}</h1>
      <p className="builder-sub">הקישו על כל חלק במשפט כדי לבחור. אנחנו נמצא את הצירוף הזול ביותר.</p>
      {!editing && <a className="explore-link" href="/explore"><Compass size={18} aria-hidden="true" /><span>לא יודע לאן? <strong>גלו יעדים זולים</strong></span></a>}
    </div>

    {flyFind && <FlyFindFields form={form} open={setOpenQuestion} refs={refs} openQuestion={openQuestion} errors={errors} swap={() => patch({ origin: form.destination, originLabel: form.destinationLabel, destination: form.origin, destinationLabel: form.originLabel })} />}
    <div className="sentence" role="group" aria-label="פרטי החיפוש" hidden={flyFind}>
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

    <div className="cta-bar">
      <button type="submit" className="btn btn-cta"><Search size={22} aria-hidden="true" />{flyFind ? "חפש טיסות" : "מצאו לי את הזול ביותר"}</button>
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
