import { ArrowUpDown, BedDouble, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Compass, FileText, Globe2, Headphones, Heart, Luggage, MapPin, Palmtree, Plane, ShieldCheck, Tag, UserCircle } from "lucide-react";
import type { SearchForm } from "../lib/search";
import type { FieldErrors, Question } from "../lib/builder";
import { nightsText } from "../lib/builder";
import type { ReactNode, RefObject } from "react";

export function FlyFindHeader({ children }: { children?: ReactNode }) {
  const active = typeof location === "undefined" ? "/" : location.pathname;
  return <header className="fly-header">
    <a className="skip-link" href="#main">דילוג לתוכן</a>
    <a href="/" className="fly-logo" dir="ltr"><Plane fill="currentColor" strokeWidth={1.4} /><span><strong>FlyFind</strong><small>More Travel. For Less.</small></span></a>
    <nav aria-label="ניווט ראשי">{[["/privacy", "מידע לנוסע"], ["/explore", "השראה"], ["/deals", "מבצעים"], ["/overlay", "השוואת מקורות"], ["/alerts", "התראות"], ["/", "טיסות"]].map(([href, label]) => <a key={href} href={href} aria-current={active === href ? "page" : undefined}>{label}</a>)}</nav>
    <div className="fly-header-actions"><span><Globe2 size={19} aria-hidden="true" />עברית</span><a href="/alerts" aria-label="התראות וטיסות שמורות"><Heart size={23} aria-hidden="true" /></a><a className="fly-login" href="/alerts"><UserCircle size={19} aria-hidden="true" />ההתראות שלי</a></div>{children && <div className="fly-header-extra">{children}</div>}
  </header>;
}

export function FlyFindHero() {
  return <section className="fly-hero"><div><h1>העולם מחכה לך</h1><p>חפש, השווה, וטוס במחיר הטוב ביותר</p></div></section>;
}

export function FlyFindTabs() {
  return <div className="fly-tabs" aria-label="סוג השירות"><span className="selected"><Plane />טיסות</span><a href="https://www.booking.com/" target="_blank" rel="noopener noreferrer"><BedDouble />מלונות</a><a href="/deals"><Palmtree />מבצעים</a></div>;
}

export function FlyFindFields({ form, open, openDates, swap, refs, openQuestion, errors }: { form: SearchForm; open: (q: Question) => void; openDates: (target: "departure" | "return") => void; swap: () => void; refs: Record<Question, RefObject<HTMLButtonElement | null>>; openQuestion: Question | null; errors: FieldErrors }) {
  const date = (value: string) => value ? new Date(`${value}T12:00:00`).toLocaleDateString("he-IL") : "בחר תאריך";
  const dialogProps = (q: Question) => ({ "aria-haspopup": "dialog" as const, "aria-expanded": openQuestion === q, "aria-controls": `sheet-${q}`, "aria-invalid": Boolean(errors.byQuestion[q]), "aria-describedby": errors.byQuestion[q] ? `error-${q}` : undefined });
  return <>
    <div className="fly-trip-type"><span><i />הלוך ושוב</span><button ref={refs.stay} {...dialogProps("stay")} type="button" onClick={() => open("stay")}><i />משך השהייה · {nightsText(form.stayMin, form.stayMax)}</button><a href="/explore"><i />גילוי יעדים</a></div>
    <div className="fly-fields">
      <div className="fly-route"><button ref={refs.from} {...dialogProps("from")} type="button" onClick={() => open("from")}><MapPin aria-hidden="true" /><span><small>מוצא</small><strong>{form.originLabel || form.origin} ({form.origin})</strong></span></button><button className="fly-swap" type="button" disabled={!form.destination} onClick={swap} aria-label="החלפת מוצא ויעד"><ArrowUpDown size={20} aria-hidden="true" /></button><button ref={refs.to} {...dialogProps("to")} type="button" onClick={() => open("to")}><span><small>יעד</small><strong>{form.destinationLabel || form.destination || "לאן טסים?"}</strong></span></button></div>
      <div className="fly-dates"><button ref={refs.when} {...dialogProps("when")} type="button" onClick={() => openDates("departure")}><CalendarDays aria-hidden="true" /><span><small>תאריך יציאה</small><strong>{date(form.windowStart)}</strong></span></button><button {...dialogProps("when")} type="button" onClick={(event) => { refs.when.current = event.currentTarget; openDates("return"); }}><CalendarDays aria-hidden="true" /><span><small>תאריך חזרה</small><strong>{date(form.windowEnd)}</strong></span></button></div>
      <button ref={refs.who} {...dialogProps("who")} className="fly-passengers" type="button" onClick={() => open("who")}><UserCircle aria-hidden="true" /><span><small>נוסעים ומחלקה</small><strong>{form.adults + form.children + form.infants === 1 ? "1 נוסע" : `${form.adults + form.children + form.infants} נוסעים`}, מחלקת תיירים</strong></span><ChevronDown size={18} aria-hidden="true" /></button>
    </div>
  </>;
}

const destinations = [
  { name: "ניו יורק", code: "NYC", image: "new-york" },
  { name: "פריז", code: "PAR", image: "paris" },
  { name: "לונדון", code: "LON", image: "london" },
  { name: "אתונה", code: "ATH", image: "athens" },
  { name: "דובאי", code: "DXB", image: "dubai" },
  { name: "בנגקוק", code: "BKK", image: "bangkok" },
];

export function FlyFindDiscover({ onDestination }: { onDestination: (code: string, name: string) => void }) {
  return <div className="fly-discover">
    <div className="fly-benefits">
      {[[Tag, "מחפשים את המחיר הטוב ביותר", "משווים בין מקורות"], [ShieldCheck, "הזמנה באתר הספק", "כל פרטי הטיסה במקום אחד"], [Headphones, "החיפוש זמין 24/7", "מוצאים את הטיסה בשבילך"], [Plane, "יותר אפשרויות לטוס", "חברות תעופה מכל העולם"]].map(([Icon, title, text]) => { const Glyph = Icon as typeof Tag; return <div key={String(title)}><Glyph size={36} /><span><strong>{String(title)}</strong><small>{String(text)}</small></span></div>; })}
    </div>
    <section className="fly-popular"><div className="fly-section-heading"><h2>יעדים פופולריים</h2><a href="/explore" aria-label="גלו עוד יעדים"><ChevronLeft /><ChevronRight /></a></div><div className="fly-destination-grid">{destinations.map(d => <button type="button" key={d.code} onClick={() => onDestination(d.code, d.name)}><img src={`/images/${d.image}.jpg`} alt={d.name} /><div><strong>{d.name}</strong><small>גלו את המחיר הטוב ביותר</small><span>חיפוש טיסות</span><i><ChevronLeft size={20} /></i></div></button>)}</div></section>
    <section className="fly-newsletter"><div><h2>מגלים יותר, משלמים פחות</h2><p>קבלו התראות על ירידת מחירים, ועקבו אחרי הטיסה הבאה</p><a href="/alerts"><span>בחרו מסלול להתראת מחיר</span><span className="fly-signup">יצירת התראה</span></a><small><Check size={14} />ההתראות נשמרות במכשיר שלכם</small></div><p className="fly-handwriting" dir="ltr">Good Flights<br />Better Memories</p><Plane className="fly-banner-plane" fill="white" size={48} /></section>
    <nav className="fly-bottom-links" aria-label="מידע נוסף">{[[Plane,"טיפים לטסים","/explore"],[FileText,"תנאי שימוש","/terms"],[Luggage,"מידע על מזוודות","/explore"],[ShieldCheck,"פרטיות ושקיפות","/privacy"],[Compass,"השראה לטיולים","/explore"]].map(([Icon,label,href]) => {const Glyph = Icon as typeof Plane; return <a key={String(label)} href={String(href)}><Glyph size={28}/>{String(label)}</a>;})}</nav>
  </div>;
}
