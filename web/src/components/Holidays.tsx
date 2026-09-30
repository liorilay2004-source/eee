import { CalendarHeart, Lightbulb } from "lucide-react";
import type { CalendarInsights } from "../api/contract";
import { holidayCreditText, holidayText, insightLines, insightsBasisText, vacationDaysText } from "../lib/holidays";

/** The holiday chip and the vacation-days line on an explore card; renders nothing when both are unknown. */
export function TripHolidays({ holidayHe, vacationDaysUsed }: { holidayHe?: string | null; vacationDaysUsed?: number | null }) {
  const holiday = holidayText(holidayHe);
  const vacation = vacationDaysText(vacationDaysUsed);
  if (!holiday && !vacation) return null;
  return <p className="xholiday">
    {holiday && <span className="holiday-chip"><CalendarHeart size={14} aria-hidden="true" /><span className="sr-only">חג בזמן הטיול: </span>{holiday}</span>}
    {vacation && <span className="vacation-days">{vacation}</span>}
  </p>;
}

/** Hebcal's CC BY 4.0 credit, shown wherever holiday names are. */
export function HolidayCredit({ attribution }: { attribution?: string | null }) {
  return <p className="holiday-credit">{holidayCreditText(attribution)}</p>;
}

/** Cheapest weekday and trip length above the calendar; nothing when the response has no insights. */
export function CalendarInsightsBlock({ insights }: { insights?: CalendarInsights | null }) {
  const lines = insightLines(insights);
  if (lines.length === 0 || !insights) return null;
  return <section className="pcal-insights" aria-label="תובנות מחיר">
    <ul>
      {lines.map((l) => <li key={l.key}><Lightbulb size={14} aria-hidden="true" /><span>{l.text}</span></li>)}
    </ul>
    <p className="pcal-insights-basis">{insightsBasisText(insights.labelHe)}</p>
  </section>;
}
