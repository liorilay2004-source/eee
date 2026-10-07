import { useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { LIMITS } from "../config";
import { addDays } from "../lib/builder";
import { buildCalendarGrid, shiftMonth, WEEKDAYS_SHORT } from "../lib/calendar";
import { nightsBetween, selectVacationDate } from "../lib/date-selection";
import type { SearchForm } from "../lib/search";
import type { Patch } from "./Questions";

export function VacationDates({ form, patch, today, dateTarget = "departure" }: { form: SearchForm; patch: Patch; today: string; dateTarget?: "departure" | "return" }) {
  const [selecting, setSelecting] = useState<"departure" | "return">(() => dateTarget === "return" && form.windowStart ? "return" : "departure");
  const [month, setMonth] = useState(() => dateTarget === "return" && form.windowEnd >= today ? form.windowEnd.slice(0, 7) : form.windowStart >= today ? form.windowStart.slice(0, 7) : today.slice(0, 7));
  const [flexible, setFlexible] = useState(() => Boolean(form.windowStart && form.windowEnd && (form.stayMin !== form.stayMax || nightsBetween(form.windowStart, form.windowEnd) !== form.stayMin)));
  const maxStart = addDays(today, LIMITS.maxAdvanceDays);
  const limit = flexible ? LIMITS.maxWindowDays : LIMITS.maxStayNights;
  const pickingReturn = selecting === "return" && Boolean(form.windowStart);
  const maxDate = pickingReturn ? addDays(form.windowStart, limit) : maxStart;
  const fullDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const valid = form.windowStart && form.windowEnd && nightsBetween(form.windowStart, form.windowEnd) > 0;
  const pick = (date: string) => {
    const result = selectVacationDate(pickingReturn ? { ...form, windowEnd: "" } : { ...form, windowStart: "", windowEnd: "" }, date, flexible);
    patch(result);
    setSelecting(result.windowEnd ? "departure" : "return");
  };
  const manuallyPick = (start: string, end: string) => {
    const nights = nightsBetween(start, end);
    if (start < today || start > maxStart) { patch({ windowStart: "", windowEnd: "" }); setSelecting("departure"); return; }
    if (start && end && nights > 0 && nights <= limit) { patch({ windowStart: start, windowEnd: end, ...(!flexible ? { stayMin: nights, stayMax: nights } : {}) }); setSelecting("departure"); }
    else { patch({ windowStart: start, windowEnd: "" }); setSelecting(start ? "return" : "departure"); }
  };
  return <section className="vacation-dates" aria-label="בחירת תאריכי חופשה">
    <p className="q-help">{flexible ? "בחרו תחילת וסוף טווח. נמצא את החופשה הזולה בתוכו לפי מספר הלילות שבחרתם." : "בחרו יום יציאה ואז יום חזרה. נחפש חופשה בתאריכים שבחרתם."}</p>
    <div className="date-pair">
      <label className="date-field"><span>{flexible ? "תחילת טווח" : "תאריך יציאה"}</span><input type="date" min={today} max={maxStart} value={form.windowStart} onChange={e => { manuallyPick(e.target.value, form.windowEnd); if (e.target.value) setMonth(e.target.value.slice(0, 7)); }} /></label>
      <label className="date-field"><span>{flexible ? "סוף טווח" : "תאריך חזרה"}</span><input type="date" disabled={!form.windowStart} min={form.windowStart ? addDays(form.windowStart, 1) : today} max={form.windowStart ? addDays(form.windowStart, limit) : maxStart} value={form.windowEnd} onChange={e => manuallyPick(form.windowStart, e.target.value)} /></label>
    </div>
    <div className="vacation-month"><button type="button" aria-label="החודש הקודם" disabled={month <= today.slice(0, 7)} onClick={() => setMonth(shiftMonth(month, -1))}><ChevronRight aria-hidden="true" /></button><h3 aria-live="polite">{new Date(`${month}-01T12:00:00Z`).toLocaleDateString("he-IL", { month: "long", year: "numeric", timeZone: "UTC" })}</h3><button type="button" aria-label="החודש הבא" disabled={month >= maxDate.slice(0, 7)} onClick={() => setMonth(shiftMonth(month, 1))}><ChevronLeft aria-hidden="true" /></button></div>
    <p className="vacation-prompt" aria-live="polite">{pickingReturn ? "בחרו יום חזרה" : valid ? "התאריכים נבחרו · לחצו על יום כדי לבחור מחדש" : "בחרו יום יציאה"}</p>
    <div className="vacation-grid" role="group" aria-label="ימי החודש">
      {WEEKDAYS_SHORT.map(day => <span key={day} className="vacation-weekday">{day}</span>)}
      {buildCalendarGrid(month, [], today).flat().map((cell, i) => cell.date ? <button key={cell.date} type="button" disabled={cell.date < today || cell.date > maxDate} aria-label={fullDate(cell.date)} aria-pressed={cell.date === form.windowStart || cell.date === form.windowEnd} aria-current={cell.date === today ? "date" : undefined} className={`${cell.date === form.windowStart || cell.date === form.windowEnd ? "is-selected" : ""} ${form.windowStart && form.windowEnd && cell.date > form.windowStart && cell.date < form.windowEnd ? "in-range" : ""}`} onClick={() => pick(cell.date!)}>{cell.day}</button> : <span key={`pad-${i}`} />)}
    </div>
    <div className="resolved" aria-live="polite"><CalendarDays size={18} aria-hidden="true" />{valid ? <span>{fullDate(form.windowStart)} – {fullDate(form.windowEnd)}<br /><small>{flexible ? "נמצא תאריכים בתוך הטווח" : `${nightsBetween(form.windowStart, form.windowEnd)} לילות · תאריכים מדויקים`}</small></span> : <span>{pickingReturn ? "כעת בחרו את תאריך החזרה" : "בחרו תאריכים לחופשה"}</span>}</div>
    <label className="vacation-flex"><input type="checkbox" checked={flexible} onChange={e => { setFlexible(e.target.checked); const nights = nightsBetween(form.windowStart, form.windowEnd); if (!e.target.checked && nights > 0) { if (nights <= LIMITS.maxStayNights) patch({ stayMin: nights, stayMax: nights }); else patch({ windowEnd: "" }); } }} />התאריכים שלי גמישים · מצאו את הזול ביותר בטווח</label>
    <small>אפשר לבחור חופשה של עד {LIMITS.maxStayNights} לילות{flexible ? ` בתוך טווח של עד ${LIMITS.maxWindowDays} ימים` : ""}.</small>
  </section>;
}
