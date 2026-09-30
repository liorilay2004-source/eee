import { useState, type ReactNode } from "react";
import { BaggageClaim, CalendarDays, Check, CircleAlert, Info } from "lucide-react";
import { AirportCombobox } from "./AirportCombobox";
import { Stepper } from "./Stepper";
import { LIMITS } from "../config";
import {
  POPULAR_DESTINATIONS, QUICK_ORIGINS, STAY_PRESETS, addDays, inferWhen, monthOptions, nextMonthWindow, nightsText,
  pairCheck, rangeLabel, stayPresetFor, toggleMonth, windowForMonths, type WhenChoice,
} from "../lib/builder";
import type { SearchForm } from "../lib/search";

export type Patch = (patch: Partial<SearchForm>) => void;

interface QuestionProps {
  form: SearchForm;
  patch: Patch;
  error?: string;
  errorId: string;
  today: string;
}

export function QuestionError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return <p className="q-error" id={id}><CircleAlert size={18} aria-hidden="true" />{message}</p>;
}

function ChoiceChip({ pressed, onClick, children, sub, autoFocus }: { pressed: boolean; onClick: () => void; children: ReactNode; sub?: ReactNode; autoFocus?: boolean }) {
  return <button type="button" className={`choice ${pressed ? "is-on" : ""}`} aria-pressed={pressed} onClick={onClick} data-autofocus={autoFocus ? "" : undefined}>
    <span className="choice-main">{pressed && <Check size={16} aria-hidden="true" className="choice-check" />}{children}</span>
    {sub && <span className="choice-sub">{sub}</span>}
  </button>;
}

export function PairHint({ form }: { form: SearchForm }) {
  const check = pairCheck(form);
  if (check.status === "none") return null;
  if (check.status === "empty") return <p className="pair-hint is-bad"><CircleAlert size={16} aria-hidden="true" />אין טיול באורך הזה שנכנס בטווח. בחרו פחות לילות או טווח ארוך יותר.</p>;
  if (check.status === "too_many") return <p className="pair-hint is-bad"><CircleAlert size={16} aria-hidden="true" /><span><span className="num">{check.count}</span> צירופי תאריכים, והמקסימום הוא {LIMITS.maxValidPairs}. נסו חודש אחד במקום שניים, או טווח לילות מצומצם יותר.</span></p>;
  return <p className="pair-hint"><Info size={16} aria-hidden="true" /><span><span className="num">{check.count}</span> צירופי תאריכים ייבדקו</span></p>;
}

export function FromQuestion({ form, patch, error, errorId }: QuestionProps) {
  return <div className="q">
    <QuestionError id={errorId} message={error} />
    <div className="choice-grid" role="group" aria-label="בחירה מהירה">
      {QUICK_ORIGINS.map((p, i) => <ChoiceChip key={p.code} pressed={form.origin === p.code} autoFocus={i === 0} onClick={() => patch({ origin: p.code, originLabel: p.label })} sub={<span dir="ltr">{p.code}</span>}>{p.label}</ChoiceChip>)}
    </div>
    <AirportCombobox label="או חפשו עיר או שדה תעופה" inputId="origin-search" placeholder="למשל: חיפה, לרנקה, LCA" describedBy={error ? errorId : undefined} onSelect={(code, label) => patch({ origin: code, originLabel: label })} />
  </div>;
}

export function ToQuestion({ form, patch, error, errorId }: QuestionProps) {
  const chosenIsPopular = POPULAR_DESTINATIONS.some((p) => p.code === form.destination);
  // On phones, focusing the text field would open the keyboard over the popular destinations.
  const wide = window.matchMedia("(min-width: 720px)").matches;
  return <div className="q">
    <QuestionError id={errorId} message={error} />
    <AirportCombobox label="חפשו עיר, שדה תעופה או קוד" inputId="destination-search" placeholder="למשל: אתונה, ATH" autoFocus={wide} describedBy={error ? errorId : undefined} onSelect={(code, label) => patch({ destination: code, destinationLabel: label })} />
    {form.destination && !chosenIsPopular && <p className="q-picked"><Check size={16} aria-hidden="true" />נבחר: {form.destinationLabel || form.destination} <span dir="ltr" className="num">({form.destination})</span></p>}
    <h3 className="q-subtitle" id="popular-title">יעדים אהובים</h3>
    <div className="choice-grid three" role="group" aria-labelledby="popular-title">
      {POPULAR_DESTINATIONS.map((p) => <ChoiceChip key={p.code} pressed={form.destination === p.code} onClick={() => patch({ destination: p.code, destinationLabel: p.label })} sub={<span dir="ltr">{p.code}</span>}>{p.label}</ChoiceChip>)}
    </div>
  </div>;
}

export function WhenQuestion({ form, patch, error, errorId, today }: QuestionProps) {
  // The chip the user tapped is explicit state (seeded from the dates when the sheet opens), so two chips that
  // happen to produce the same window never swap under the user's finger.
  const [choice, setChoice] = useState<WhenChoice>(() => inferWhen(form.windowStart, form.windowEnd, today));
  const exact = choice.mode === "exact";
  const months = monthOptions(today);
  const selected = choice.mode === "months" ? choice.keys : [];
  const next = nextMonthWindow(today);
  const pickMonth = (key: string) => {
    const keys = toggleMonth(selected, key);
    const w = windowForMonths(keys, today);
    setChoice(w ? { mode: "months", keys } : { mode: "none" });
    patch(w ?? { windowStart: "", windowEnd: "" });
  };
  const maxStart = addDays(today, LIMITS.maxAdvanceDays);
  return <div className="q">
    <QuestionError id={errorId} message={error} />
    <p className="q-help">בחרו חודש אחד, או שני חודשים צמודים. נחפש את הצירוף הזול ביותר בתוכם.</p>
    <div className="choice-grid three" role="group" aria-label="חודשים">
      {months.map((m, i) => <ChoiceChip key={m.key} pressed={selected.includes(m.key)} autoFocus={i === 0} onClick={() => pickMonth(m.key)} sub={m.showYear ? <span className="num">{m.year}</span> : undefined}>{m.label}</ChoiceChip>)}
    </div>
    <div className="choice-grid two">
      <ChoiceChip pressed={choice.mode === "next30"} onClick={() => { setChoice({ mode: "next30" }); patch(next); }} sub={<span className="num">{rangeLabel(next.windowStart, next.windowEnd)}</span>}>בחודש הקרוב</ChoiceChip>
      <ChoiceChip pressed={exact} onClick={() => setChoice({ mode: "exact" })} sub="טווח לבחירתכם">תאריכים מדויקים</ChoiceChip>
    </div>
    {exact && <div className="date-pair">
      <label className="date-field"><span>יציאה מוקדמת ביותר</span>
        <input type="date" min={today} max={maxStart} value={form.windowStart} aria-describedby={error ? errorId : undefined}
          onChange={(e) => patch({ windowStart: e.target.value })} />
      </label>
      <label className="date-field"><span>חזרה מאוחרת ביותר</span>
        <input type="date" min={form.windowStart ? addDays(form.windowStart, 1) : today} max={form.windowStart ? addDays(form.windowStart, LIMITS.maxWindowDays) : undefined} value={form.windowEnd} aria-describedby={error ? errorId : undefined}
          onChange={(e) => patch({ windowEnd: e.target.value })} />
      </label>
    </div>}
    <div className="resolved" aria-live="polite">
      <CalendarDays size={18} aria-hidden="true" />
      {form.windowStart && form.windowEnd
        ? <span>טווח החיפוש: <strong className="num">{rangeLabel(form.windowStart, form.windowEnd)}</strong><br /><small>היציאה והחזרה יהיו בתוך הטווח.</small></span>
        : <span>עוד לא נבחר טווח.</span>}
    </div>
    <PairHint form={form} />
  </div>;
}

export function StayQuestion({ form, patch, error, errorId }: QuestionProps) {
  const presetKey = stayPresetFor(form.stayMin, form.stayMax);
  const [custom, setCustom] = useState(presetKey === "custom");
  return <div className="q">
    <QuestionError id={errorId} message={error} />
    <div className="choice-grid two" role="group" aria-label="משך הטיול">
      {STAY_PRESETS.map((p, i) => <ChoiceChip key={p.key} pressed={!custom && presetKey === p.key} autoFocus={i === 0} onClick={() => { setCustom(false); patch({ stayMin: p.min, stayMax: p.max }); }} sub={nightsText(p.min, p.max)}>{p.label}</ChoiceChip>)}
      <ChoiceChip pressed={custom} onClick={() => setCustom(true)} sub="בוחרים מינימום ומקסימום">מותאם</ChoiceChip>
    </div>
    {custom && <div className="stepper-list">
      <Stepper label="לפחות" unit="לילות" value={form.stayMin} min={1} max={form.stayMax} onChange={(v) => patch({ stayMin: v })} />
      <Stepper label="לכל היותר" unit="לילות" value={form.stayMax} min={form.stayMin} max={LIMITS.maxStayNights} onChange={(v) => patch({ stayMax: v })} />
    </div>}
    <PairHint form={form} />
  </div>;
}

export function WhoQuestion({ form, patch, error, errorId }: QuestionProps) {
  const room = LIMITS.maxPassengers - form.adults - form.children - form.infants;
  const multi = form.adults + form.children + form.infants > 1;
  return <div className="q">
    <QuestionError id={errorId} message={error} />
    <div className="stepper-list">
      <Stepper label="מבוגרים" detail="מגיל 12" value={form.adults} min={Math.max(1, form.infants)} max={form.adults + room} onChange={(v) => patch({ adults: v })} />
      <Stepper label="ילדים" detail="גיל 2–11" value={form.children} min={0} max={form.children + room} onChange={(v) => patch({ children: v })} />
      <Stepper label="תינוקות" detail="עד גיל 2, על הברכיים" value={form.infants} min={0} max={Math.min(form.adults, form.infants + room)} onChange={(v) => patch({ infants: v })} />
    </div>
    <p className="q-help">עד {LIMITS.maxPassengers} נוסעים, ותינוק אחד לכל מבוגר.{multi && " המחיר לכמה נוסעים הוא הערכה."}</p>
    <button type="button" role="switch" aria-checked={form.checkedBag} className={`switch-row ${form.checkedBag ? "is-on" : ""}`} onClick={() => patch({ checkedBag: !form.checkedBag })}>
      <span className="switch-icon"><BaggageClaim size={22} aria-hidden="true" /></span>
      <span className="switch-copy"><strong>מזוודה נגררת</strong><small>{form.checkedBag ? "נוסיף עלות מזוודה כשהיא ידועה, ונגיד כשלא." : "המחירים יוצגו בלי מזוודה נגררת."}</small></span>
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
    </button>
  </div>;
}
