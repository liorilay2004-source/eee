import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowDownUp, ArrowLeft, ArrowLeftRight, ArrowUpRight, BadgeCheck, BaggageClaim, CalendarDays,
  Check, ChevronDown, CircleAlert, Clock3, Compass, ExternalLink, Info, LoaderCircle, MapPin,
  Plane, Search, Share2, ShieldCheck, SlidersHorizontal, Sparkles, X,
} from "lucide-react";
import { AirportCombobox } from "../components/AirportCombobox";
import { Stepper } from "../components/Stepper";
import { RequestError, searchFlights } from "../api/client";
import type { CardView, RecKind, SearchResponse, SourceStatus } from "../api/contract";
import { he } from "../copy/he";
import { LIMITS, PRODUCT_NAME } from "../config";
import {
  countValidPairs, emptyForm, formatDate, formatDuration, formatILS, readSearchUrl,
  toRequest, trustedBookingUrl, updateSearchUrl, validateForm, type SearchForm,
} from "../lib/search";

type ScreenState = "idle" | "loading" | "success" | "empty" | "error" | "offline" | "cancelled";
type Recommendation = { key: RecKind; title: string; icon: typeof Sparkles };
const recommendationLabels: Record<RecKind, Recommendation> = {
  cheapest: { key: "cheapest", title: "הכי זול", icon: Sparkles },
  best_value: { key: "best_value", title: "התמורה הטובה ביותר", icon: BadgeCheck },
  my_times: { key: "my_times", title: "מתאים לשעות שלי", icon: Clock3 },
};

const presets = [
  ["morning", "בוקר · 06–12"], ["afternoon", "צהריים · 12–17"], ["evening", "ערב · 17–23"], ["night", "לילה · 23–06"], ["custom", "בחירת שעות"],
] as const;

function savedForm(): SearchForm {
  const fromUrl = readSearchUrl();
  if (Object.keys(fromUrl).length) return { ...emptyForm(), ...fromUrl };
  try {
    const stored = localStorage.getItem("eee.lastSearch.v1");
    if (stored) return { ...emptyForm(), ...(JSON.parse(stored) as Partial<SearchForm>) };
  } catch { /* storage is optional */ }
  return emptyForm();
}

function stopLabel(stops: number | null): string {
  if (stops === null) return "מספר העצירות לא ידוע";
  return stops === 0 ? "טיסה ישירה" : stops === 1 ? "עצירה אחת" : `${stops} עצירות`;
}

function safeDateRange(start: string, end: string): string {
  if (!start || !end) return "";
  return `${formatDate(start)} – ${formatDate(end)}`;
}

function HourControl({ label, preset, onPreset, custom, onCustom, error }: {
  label: string; preset: string; onPreset: (value: string) => void;
  custom: [number, number]; onCustom: (value: [number, number]) => void; error?: string;
}) {
  return <div className="hour-control">
    <label className="field-label">{label}</label>
    <select value={preset} onChange={(event) => onPreset(event.target.value)} aria-label={label}>
      <option value="none">ללא העדפה</option>
      {presets.map(([key, title]) => <option value={key} key={key}>{title}</option>)}
    </select>
    {preset === "custom" && <div className="custom-hours" dir="ltr">
      <select value={custom[0]} aria-label={`${label}, משעה`} onChange={(event) => onCustom([Number(event.target.value), custom[1]])}>
        {Array.from({ length: 25 }, (_, n) => <option value={n} key={n}>{String(n).padStart(2, "0")}:00</option>)}
      </select><span>עד</span>
      <select value={custom[1]} aria-label={`${label}, עד שעה`} onChange={(event) => onCustom([custom[0], Number(event.target.value)])}>
        {Array.from({ length: 25 }, (_, n) => <option value={n} key={n}>{String(n).padStart(2, "0")}:00</option>)}
      </select>
    </div>}
    {error && <span className="field-error">{error}</span>}
  </div>;
}

function FlightLeg({ title, date, leg, icon }: { title: string; date: string; leg: CardView["offer"]["outbound"]; icon: "out" | "in" }) {
  return <div className="flight-leg">
    <div className="leg-icon" aria-hidden="true">{icon === "out" ? <ArrowUpRight size={16} /> : <ArrowLeft size={16} />}</div>
    <div className="leg-main">
      <div className="leg-heading"><strong>{title}</strong><span dir="ltr">{formatDate(date)}</span></div>
      <div className="leg-time" dir="ltr">{leg.departTime || "--:--"}<span className="leg-line" aria-hidden="true"><Plane size={13} /></span>{leg.arriveTime || "--:--"}</div>
      <div className="leg-meta"><span>{leg.departTime ? "שעת המראה" : "שעת המראה תופיע באתר ההזמנה"}</span><span>{stopLabel(leg.stops)}</span><span>{formatDuration(leg.durationMin)}</span></div>
      {!!leg.airlines.length && <div className="airline-codes" dir="ltr">{leg.airlines.join(" · ")}</div>}
    </div>
  </div>;
}

function RecommendationCard({ card, adults, childPassengers, infants, checkedBag }: {
  card: CardView; adults: number; childPassengers: number; infants: number; checkedBag: boolean;
}) {
  const offer = card.offer;
  const isSplit = offer.ticketStructure === "split";
  const outUrl = trustedBookingUrl(offer.deeplink);
  const returnUrl = trustedBookingUrl(offer.returnDeeplink ?? null);
  const totalPassengers = adults + childPassengers + infants;
  const tags = new Set(offer.tags);
  const unknownBag = checkedBag && tags.has("bag_fee_unknown");
  const badges = card.kinds.map((kind) => recommendationLabels[kind]).filter(Boolean);
  return <article className="offer-card">
    <div className="offer-card-top">
      <div className="recommendations">{badges.map(({ key, title, icon: Icon }) => <span className={`recommendation-tag tag-${key}`} key={key}><Icon size={14} />{title}</span>)}</div>
      <span className="freshness"><span className="freshness-dot" />{card.ageHours < 1 ? "נבדק עכשיו" : `נבדק לפני ${Math.floor(card.ageHours)} שע׳`}</span>
    </div>
    <div className="offer-price-row">
      <div>
        <div className="offer-price" dir="ltr">{unknownBag && <span className="minimum-price">לפחות </span>}{formatILS(offer.totalIls)}</div>
        <div className="offer-price-detail" dir="ltr">{offer.priceCurrency !== "ILS" ? `${Math.ceil(offer.priceAmount).toLocaleString("en-US")} ${offer.priceCurrency}` : "מחיר כולל לנוסעים"}{totalPassengers > 1 && " · הערכה לפי מספר הנוסעים"}</div>
      </div>
      <div className="route-code"><span dir="ltr">{offer.origin}</span><ArrowLeftRight size={18} /><span dir="ltr">{offer.destination}</span></div>
    </div>
    <div className="trip-dates"><CalendarDays size={16} /><span>{safeDateRange(offer.departDate, offer.returnDate)}</span><span className="date-separator">·</span><span>{Math.max(0, Math.round((Date.parse(`${offer.returnDate}T00:00:00Z`) - Date.parse(`${offer.departDate}T00:00:00Z`)) / 86_400_000))} לילות</span></div>
    <div className="flight-legs">
      <FlightLeg title="הלוך" date={offer.departDate} leg={offer.outbound} icon="out" />
      <div className="leg-divider" />
      <FlightLeg title="חזור" date={offer.returnDate} leg={offer.inbound} icon="in" />
    </div>
    <div className="offer-notes">
      {tags.has("bonus_checked_bag") && <span className="note positive"><BaggageClaim size={15} />כולל מזוודה</span>}
      {checkedBag && offer.extrasAmountIls > 0 && <span className="note"><BaggageClaim size={15} />עלות המזוודה משוערת</span>}
      {unknownBag && <span className="note warning"><CircleAlert size={15} />עלות המזוודה לא ידועה לחלק מהטיסות; המחיר כולל רק עלויות ידועות</span>}
      {offer.source === "travelpayouts" && totalPassengers > 1 && <span className="note"><Info size={15} />מחיר הנוסעים הוא הערכה לפי מחיר למבוגר</span>}
      {offer.outbound.departTime === null && <span className="note"><Clock3 size={15} />שעת המראה בהלוך תופיע באתר ההזמנה</span>}
      {offer.inbound.departTime === null && <span className="note"><Clock3 size={15} />שעת המראה בחזור תופיע באתר ההזמנה</span>}
      {isSplit && <span className="note warning"><CircleAlert size={15} />שני כרטיסים נפרדים — מזמינים כל אחד בנפרד. כללי כבודה ושינויים חלים בנפרד, ואין הגנה אם אחד מהם משתנה או מתבטל.</span>}
      {card.savingsVsRoundtripIls !== null && <span className="note positive">חסכת {formatILS(card.savingsVsRoundtripIls)} לעומת הלוך־חזור</span>}
    </div>
    <div className="offer-card-bottom">
      <span className="source-caption">{offer.source === "travelpayouts" ? "מחיר מ־Travelpayouts" : "מחיר מ־Google Flights"}</span>
      <div className="booking-actions">
        {outUrl ? <a className="book-button" href={outUrl} target="_blank" rel="sponsored noopener noreferrer">{isSplit ? "הזמנת הלוך" : "לצפייה ולהזמנה"}<ExternalLink size={15} /></a> : <span className="booking-disabled">קישור הזמנה לא זמין כרגע</span>}
        {isSplit && returnUrl && <a className="book-button secondary-book" href={returnUrl} target="_blank" rel="sponsored noopener noreferrer">הזמנת חזור<ExternalLink size={15} /></a>}
      </div>
    </div>
  </article>;
}

function DemoCard({ price, tag, dates, time, stops }: { price: string; tag: string; dates: string; time: string; stops: string }) {
  return <article className="demo-card">
    <span className="demo-card-tag">{tag}</span><div className="demo-price">{price}</div>
    <div className="demo-route"><span>תל אביב</span><ArrowLeftRight size={15} /><span>ברצלונה</span></div>
    <div className="demo-meta"><span><CalendarDays size={14} />{dates}</span><span><Clock3 size={14} />{time}</span><span><Plane size={14} />{stops}</span></div>
    <div className="demo-label">נתוני המחשה בלבד · לא הצעת מחיר</div>
  </article>;
}

function SummaryBar({ form, onEdit, onShare, copied }: { form: SearchForm; onEdit: () => void; onShare: () => void; copied: boolean }) {
  return <div className="summary-bar">
    <div className="summary-route"><span dir="ltr">{form.origin}</span><ArrowLeftRight size={16} /><span dir="ltr">{form.destination}</span></div>
    <span className="summary-detail">{safeDateRange(form.windowStart, form.windowEnd)} · {form.stayMin}–{form.stayMax} לילות · {form.adults + form.children + form.infants} נוסעים</span>
    <div className="summary-actions"><button type="button" className="quiet-button" onClick={onShare} aria-label="העתקת קישור לחיפוש"><Share2 size={16} />{copied ? "הועתק" : "שיתוף"}</button><button type="button" className="quiet-button" onClick={onEdit}>עריכה</button></div>
  </div>;
}

export function SearchPage() {
  const [form, setForm] = useState<SearchForm>(savedForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [screen, setScreen] = useState<ScreenState>("idle");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [demo, setDemo] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [progressText, setProgressText] = useState<string>(he.loading);
  const [copied, setCopied] = useState(false);
  const [rateCountdown, setRateCountdown] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const didAutoSearch = useRef(false);

  const pairCount = useMemo(() => countValidPairs(form.windowStart, form.windowEnd, form.stayMin, form.stayMax), [form.windowStart, form.windowEnd, form.stayMin, form.stayMax]);
  const totalPassengers = form.adults + form.children + form.infants;
  const hasHours = form.outHoursPreset !== "none" || form.retHoursPreset !== "none";
  const sources = response?.meta.sources ?? [];
  const partial = sources.some((source) => source.enabled && !source.ok);

  useEffect(() => {
    const initial = readSearchUrl();
    if (Object.keys(initial).length && !didAutoSearch.current) {
      didAutoSearch.current = true;
      const restored = { ...emptyForm(), ...initial };
      setForm(restored);
      const timer = window.setTimeout(() => { void runSearch(restored, true); }, 0);
      return () => window.clearTimeout(timer);
    }
  // Initial URL only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!rateCountdown) return;
    const timer = window.setTimeout(() => setRateCountdown((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [rateCountdown]);

  useEffect(() => {
    if (screen === "loading") {
      const timers = [
        window.setTimeout(() => setProgressText("עדיין בודקים — זה יכול לקחת כמה שניות"), 3000),
        window.setTimeout(() => setProgressText("מקורות המחירים איטיים היום. ממשיכים לנסות…"), 10000),
      ];
      return () => timers.forEach(window.clearTimeout);
    }
  }, [screen]);

  function setField<K extends keyof SearchForm>(key: K, value: SearchForm[K]) {
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (key === "outHoursPreset") next.useCustomOut = value === "custom";
      if (key === "retHoursPreset") next.useCustomRet = value === "custom";
      if ((key === "outHoursPreset" && value === "none") || (key === "retHoursPreset" && value === "none")) {
        if (next.outHoursPreset === "none" && next.retHoursPreset === "none") next.maxStops = null;
      }
      return next;
    });
    setDemo(false);
  }

  async function runSearch(nextForm: SearchForm, fromUrl = false) {
    const foundErrors = validateForm(nextForm);
    if (Object.keys(foundErrors).length) {
      setErrors(foundErrors); setScreen("idle");
      window.setTimeout(() => errorSummaryRef.current?.focus(), 0);
      return;
    }
    setErrors({}); setResponse(null); setErrorMessage(""); setErrorCode(""); setDemo(false);
    updateSearchUrl(nextForm);
    try { localStorage.setItem("eee.lastSearch.v1", JSON.stringify(nextForm)); } catch { /* device storage is optional */ }
    if (!fromUrl) setForm(nextForm);
    const controller = new AbortController();
    controllerRef.current = controller;
    let timeout = false;
    setProgressText(he.loading); setScreen("loading");
    const timeoutId = window.setTimeout(() => { timeout = true; controller.abort(); }, 25_000);
    try {
      const result = await searchFlights(toRequest(nextForm), controller.signal);
      setResponse(result);
      setScreen(result.cards.length ? "success" : result.meta.sources.some((source) => source.ok) ? "empty" : "error");
      if (result.cards.length) window.setTimeout(() => resultsRef.current?.focus(), 50);
    } catch (error) {
      if (controller.signal.aborted && !timeout) { setScreen("cancelled"); return; }
      if (timeout) { setErrorCode("timeout"); setErrorMessage("הבדיקה לוקחת יותר מדי זמן. אפשר לנסות שוב או לשנות את החיפוש."); setScreen("error"); return; }
      if (error instanceof RequestError) {
        setErrorCode(error.code);
        if (error.code === "rate_limited") {
          const seconds = error.retryAfterSec ?? 60;
          setRateCountdown(seconds); setErrorMessage(`ביצעתם הרבה חיפושים. אפשר לנסות שוב בעוד ${seconds} שניות.`);
        } else if (error.code === "source_unavailable") {
          setErrorMessage(he.notConnected);
        } else if (error.status === 400 && error.fields) {
          const mapped: Record<string, string> = {};
          for (const key of Object.keys(error.fields)) mapped[key] = "הערך אינו תקין — בדקו את השדה ונסו שוב.";
          setErrors(mapped); setErrorMessage("יש שדות שצריך לתקן לפני החיפוש.");
        } else setErrorMessage(he.unavailable);
        setScreen("error");
      } else if (!navigator.onLine || error instanceof TypeError) {
        setErrorMessage("אין חיבור לאינטרנט. בדקו את החיבור ונסו שוב."); setScreen("offline");
      } else {
        setErrorMessage("משהו השתבש. נסו שוב."); setScreen("error");
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runSearch(form);
  }

  function loadDemo() {
    const demoForm: SearchForm = {
      ...emptyForm(), origin: "TLV", destination: "BCN", windowStart: "2026-11-10", windowEnd: "2026-11-25", stayMin: 5, stayMax: 7,
    };
    setForm(demoForm); setResponse(null); setErrors({}); setScreen("idle"); setDemo(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
  }

  async function shareSearch() {
    try { await navigator.clipboard.writeText(location.href); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    catch { setCopied(false); }
  }

  function retry() { void runSearch(form); }
  function cancelSearch() { controllerRef.current?.abort(); }
  function editSearch() { setResponse(null); setScreen("idle"); setDemo(false); window.scrollTo({ top: 0, behavior: "smooth" }); }
  function clearSaved() {
    try { localStorage.removeItem("eee.lastSearch.v1"); } catch { /* storage is optional */ }
    history.replaceState(null, "", location.pathname);
    setForm(emptyForm()); setErrors({}); setResponse(null); setScreen("idle"); setDemo(false);
  }

  const summary = screen === "success" && response ? <SummaryBar form={form} onEdit={editSearch} onShare={() => void shareSearch()} copied={copied} /> : null;
  return <main className="page-shell">
    <section className="preview-ribbon" aria-label="מצב האתר"><ShieldCheck size={14} />תצוגה מקדימה · מחירים חיים יוצגו לאחר חיבור מקור הנתונים</section>
    <header className="site-header">
      <a className="brand" href="/" aria-label={`${PRODUCT_NAME} — לעמוד החיפוש`}><span className="brand-mark"><Plane size={19} /></span><span className="brand-name">{PRODUCT_NAME}<span className="brand-period">.</span></span></a>
      <nav className="header-nav" aria-label="ניווט ראשי"><a href="#how-it-works">איך זה עובד</a><a href="#about-data">על הנתונים</a><a className="nav-support" href="/accessibility">נגישות</a></nav>
      <span className="beta-chip"><span />גרסת בטא</span>
    </header>

    <div className="hero-grid">
      <div className="hero-copy">
        <div className="eyebrow"><span className="eyebrow-line" />מתחילים לתכנן חכם</div>
        <h1>הטיסה הנכונה<br /><em>במחיר הנכון.</em></h1>
        <p className="hero-description">גמישים בתאריכים? אנחנו נחפש בין הימים והלילות, ונראה לכם את ההצעות שבאמת שווה לבדוק.</p>
        <div className="hero-proof"><span><Check size={15} />טווח תאריכים גמיש</span><span><Check size={15} />השוואה שקופה</span><span><Check size={15} />בלי התחייבות</span></div>
      </div>
      <div className="hero-art" aria-hidden="true">
        <div className="orbit orbit-one" /><div className="orbit orbit-two" />
        <div className="art-sun" /><div className="art-plane"><Plane size={30} /></div>
        <div className="art-cloud cloud-a" /><div className="art-cloud cloud-b" />
        <div className="art-route route-from"><span className="route-dot" /><b>TLV</b><small>תל אביב</small></div>
        <div className="art-route route-to"><span className="route-dot coral" /><b>BCN</b><small>ברצלונה</small></div>
        <div className="art-stamp"><Sparkles size={13} />הדרך שלך<br />מתחילה כאן</div>
      </div>
    </div>

    <section className="search-panel" aria-labelledby="search-heading">
      <div className="panel-heading">
        <div><span className="panel-kicker">חיפוש טיסה</span><h2 id="search-heading">לאן יוצאים?</h2></div>
        <div className="roundtrip-badge"><ArrowLeftRight size={16} />הלוך וחזור</div>
      </div>
      <form onSubmit={submit} noValidate>
        {Object.keys(errors).length > 0 && <div className="error-summary" role="alert" tabIndex={-1} ref={errorSummaryRef}><CircleAlert size={18} /><div><strong>כמעט שם — צריך לתקן כמה פרטים</strong><span>{Object.keys(errors).length} שדות דורשים תשומת לב</span></div></div>}
        <div className="route-row">
          <AirportCombobox inputId="origin" label="מאיפה טסים?" value={form.origin} onChange={(value) => setField("origin", value)} placeholder="עיר או שדה תעופה" error={errors.origin} />
          <div className="route-swap" aria-hidden="true"><ArrowLeftRight size={17} /></div>
          <AirportCombobox inputId="destination" label="לאן טסים?" value={form.destination} onChange={(value) => setField("destination", value)} placeholder="לאן מתחשק?" error={errors.destination} />
        </div>
        <div className="dates-row">
          <div className="field date-field"><label className="field-label" htmlFor="windowStart">יציאה מוקדמת ביותר</label><div className={`input-shell ${errors.windowStart ? "has-error" : ""}`}><CalendarDays size={17} className="field-icon" /><input id="windowStart" type="date" min={new Date().toISOString().slice(0, 10)} value={form.windowStart} aria-invalid={Boolean(errors.windowStart)} onChange={(event) => setField("windowStart", event.target.value)} /></div>{errors.windowStart && <span className="field-error">{errors.windowStart}</span>}</div>
          <div className="field date-field"><label className="field-label" htmlFor="windowEnd">חזרה מאוחרת ביותר</label><div className={`input-shell ${errors.windowEnd ? "has-error" : ""}`}><CalendarDays size={17} className="field-icon" /><input id="windowEnd" type="date" min={form.windowStart || new Date().toISOString().slice(0, 10)} value={form.windowEnd} aria-invalid={Boolean(errors.windowEnd)} onChange={(event) => setField("windowEnd", event.target.value)} /></div>{errors.windowEnd && <span className="field-error">{errors.windowEnd}</span>}</div>
          <div className="stay-group"><span className="field-label">כמה לילות?</span><div className="stay-controls"><label><span className="sr-only">מינימום לילות</span><input type="number" min={1} max={LIMITS.maxStayNights} value={form.stayMin} onChange={(event) => setField("stayMin", Number(event.target.value))} aria-invalid={Boolean(errors.stay)} /><small>מינ׳</small></label><span className="stay-dash">–</span><label><span className="sr-only">מקסימום לילות</span><input type="number" min={1} max={LIMITS.maxStayNights} value={form.stayMax} onChange={(event) => setField("stayMax", Number(event.target.value))} aria-invalid={Boolean(errors.stay)} /><small>מקס׳</small></label></div>{errors.stay && <span className="field-error">{errors.stay}</span>}</div>
        </div>
        <div className="form-helper"><Info size={15} /><span>נחפש מחירים בטווח התאריכים ובמספר הלילות שבחרתם.</span>{pairCount > 0 && <span className="pair-count">{pairCount} צירופים אפשריים</span>}</div>
        {errors.dates && <span className="field-error dates-error">{errors.dates}</span>}

        <div className="form-divider" />
        <div className="traveler-and-bag">
          <div className="travelers-block">
            <div className="mini-section-title"><span className="mini-icon"><Compass size={16} /></span><strong>מי טס?</strong><span className="mini-section-note">עד 9 נוסעים</span></div>
            <div className="steppers-grid">
              <Stepper label="מבוגרים" detail="מגיל 12" value={form.adults} min={1} max={LIMITS.maxPassengers - form.children - form.infants} onChange={(value) => setField("adults", value)} />
              <Stepper label="ילדים" detail="גיל 2–11" value={form.children} min={0} max={LIMITS.maxPassengers - form.adults - form.infants} onChange={(value) => setField("children", value)} />
              <Stepper label="תינוקות" detail="מתחת לגיל 2" value={form.infants} min={0} max={Math.min(form.adults, LIMITS.maxPassengers - form.adults - form.children)} onChange={(value) => setField("infants", value)} />
            </div>
            {totalPassengers > 1 && <p className="estimate-hint"><Info size={14} />מחיר לכמה נוסעים הוא הערכה{form.children + form.infants > 0 ? "; ילדים ותינוקות עשויים לשלם מחיר אחר." : "."}</p>}
            {errors.passengers && <span className="field-error">{errors.passengers}</span>}{errors.infants && <span className="field-error">{errors.infants}</span>}
          </div>
          <div className="bag-block">
            <div className="mini-section-title"><span className="mini-icon"><BaggageClaim size={16} /></span><strong>כבודה</strong></div>
            <label className="bag-option"><input type="checkbox" checked={form.checkedBag} onChange={(event) => setField("checkedBag", event.target.checked)} /><span className="custom-check"><Check size={13} /></span><span><b>מזוודה 23 ק״ג</b><small>לכל נוסע</small></span></label>
            <p className="bag-helper">{he.bagHelper}</p>
          </div>
        </div>

        <div className="collapsible-row"><button type="button" className={`disclosure-button ${preferencesOpen ? "is-open" : ""}`} aria-expanded={preferencesOpen} onClick={() => setPreferencesOpen(!preferencesOpen)}><span className="disclosure-icon"><Clock3 size={16} /></span><span>העדפות לשעות ולעצירות</span><small>לא חובה</small><ChevronDown size={17} className="disclosure-chevron" /></button></div>
        {preferencesOpen && <div className="disclosure-content preferences-content">
          <p className="disclosure-help">{he.timeHelper}</p>
          <div className="hour-grid">
            <HourControl label="שעת יציאה בהלוך" preset={form.outHoursPreset} onPreset={(value) => setField("outHoursPreset", value)} custom={form.customOut} onCustom={(value) => setField("customOut", value)} error={errors.outHours} />
            <HourControl label="שעת יציאה בחזור" preset={form.retHoursPreset} onPreset={(value) => setField("retHoursPreset", value)} custom={form.customRet} onCustom={(value) => setField("customRet", value)} error={errors.retHours} />
            <div className={`hour-control stops-control ${!hasHours ? "is-disabled" : ""}`}><label className="field-label" htmlFor="maxStops">עצירות בהצעת ״מתאים לשעות שלי״</label><select id="maxStops" value={form.maxStops === null ? "any" : form.maxStops} disabled={!hasHours} aria-describedby="stops-help" onChange={(event) => setField("maxStops", event.target.value === "any" ? null : Number(event.target.value))}><option value="any">ללא הגבלה</option><option value="0">טיסה ישירה</option><option value="1">עד עצירה אחת</option><option value="2">עד 2 עצירות</option></select><span className="field-hint" id="stops-help">{hasHours ? "נשפיע רק על התאמה לשעות שבחרתם." : "עצירות משפיעות רק יחד עם שעות מועדפות."}</span></div>
          </div>
        </div>}

        <div className="collapsible-row advanced-row"><button type="button" className={`disclosure-button ${advancedOpen ? "is-open" : ""}`} aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(!advancedOpen)}><span className="disclosure-icon"><SlidersHorizontal size={16} /></span><span>אפשרויות נוספות</span><small>מתקדם</small><ChevronDown size={17} className="disclosure-chevron" /></button></div>
        {advancedOpen && <div className="disclosure-content advanced-content"><label className="bag-option"><input type="checkbox" checked={form.nearbyAirports} onChange={(event) => setField("nearbyAirports", event.target.checked)} /><span className="custom-check"><Check size={13} /></span><span><b>לכלול שדות תעופה קרובים</b><small>נרחיב את החיפוש לשדות תעופה בסביבה</small></span></label></div>}

        <div className="submit-row"><button className="search-button" type="submit" disabled={screen === "loading" || rateCountdown > 0}>{screen === "loading" ? <LoaderCircle className="spin" size={19} /> : <Search size={19} />}{screen === "loading" ? "מחפשים…" : rateCountdown > 0 ? `אפשר לחפש שוב בעוד ${rateCountdown} שניות` : "חפשו את המחיר הזול ביותר"}<ArrowUpRight size={17} className="button-arrow" /></button><span className="secure-note"><ShieldCheck size={14} />חיפוש חינם, בלי התחייבות</span></div>
      </form>
    </section>

    <section className="results-section" ref={resultsRef} tabIndex={-1} aria-labelledby="results-heading">
      {summary}
      {screen === "idle" && !demo && <div className="idle-area"><div className="idle-icon"><Plane size={23} /></div><div><h2 id="results-heading">החיפוש הבא שלכם מתחיל כאן</h2><p>{he.idle}</p><button type="button" className="text-link" onClick={loadDemo}>הציצו בתצוגת דוגמה <ArrowLeft size={15} /></button></div></div>}
      {screen === "loading" && <div className="loading-area" role="status"><div className="loading-orbit"><LoaderCircle size={26} /></div><div><h2 id="results-heading">רגע, בודקים בשבילכם</h2><p>{progressText}</p><div className="loading-progress"><span /></div></div><button type="button" className="cancel-button" onClick={cancelSearch}>ביטול</button></div>}
      {(screen === "error" || screen === "offline") && <div className="state-card error-state" role="alert"><div className="state-symbol"><CircleAlert size={22} /></div><div className="state-copy"><span className="state-kicker">{errorCode === "source_unavailable" ? "מקור הנתונים עדיין לא זמין" : screen === "offline" ? "אין חיבור" : "לא הצלחנו להשלים את החיפוש"}</span><h2 id="results-heading">{errorMessage || he.unavailable}</h2><p>{errorCode === "source_unavailable" ? "הטופס מוכן; כדי לקבל מחירים אמיתיים צריך לחבר את מקור Travelpayouts בהגדרות Cloudflare." : "אפשר לנסות שוב, או לערוך את פרטי החיפוש."}</p></div><div className="state-actions"><button className="retry-button" type="button" onClick={retry} disabled={rateCountdown > 0}><RefreshIcon />נסו שוב</button><button className="quiet-button" type="button" onClick={editSearch}>עריכת חיפוש</button></div></div>}
      {screen === "cancelled" && <div className="state-card"><div className="state-symbol neutral-symbol"><X size={22} /></div><div className="state-copy"><h2 id="results-heading">החיפוש בוטל</h2><p>אפשר לשנות את הפרטים ולחפש שוב.</p></div><button className="quiet-button" type="button" onClick={editSearch}>חזרה לטופס</button></div>}
      {screen === "empty" && <div className="state-card empty-state"><div className="state-symbol"><Compass size={22} /></div><div className="state-copy"><span className="state-kicker">בדקנו את הטווח</span><h2 id="results-heading">{he.noResults}</h2><p>נסו להרחיב את טווח התאריכים, להוסיף לילות או לכלול שדות תעופה קרובים.</p></div><button className="quiet-button" type="button" onClick={editSearch}>שינוי החיפוש</button></div>}
      {screen === "success" && response && <div className="results-content">
        <div className="results-title-row"><div><span className="panel-kicker">מצאנו כמה אפשרויות</span><h2 id="results-heading" tabIndex={-1}>הצעות ששווה לבדוק</h2></div><span className="result-count">{response.cards.length} {response.cards.length === 1 ? "הצעה" : "הצעות"}</span></div>
        {partial && <div className="notice-banner" role="status"><Info size={17} />{he.partial}</div>}
        {response.cards.map((card) => <RecommendationCard key={`${card.offer.origin}-${card.offer.destination}-${card.offer.departDate}-${card.offer.returnDate}`} card={card} adults={form.adults} childPassengers={form.children} infants={form.infants} checkedBag={form.checkedBag} />)}
        <details className="search-details"><summary><span><Info size={16} />פרטי החיפוש והנתונים</span><ChevronDown size={16} /></summary><div className="details-content"><div className="details-grid"><div><small>מקור שער המטבע</small><b>{response.meta.fxSource} · {response.meta.fxDate}</b></div><div><small>צירופים שנבדקו</small><b>{response.meta.candidatePairs}</b></div><div><small>נוצר בתאריך</small><b dir="ltr">{new Date(response.meta.generatedAt).toLocaleString("he-IL")}</b></div><div><small>תוצאות ממטמון</small><b>{response.meta.fromCache ? "כן" : "לא"}</b></div></div><div className="source-list"><strong>מקורות המחירים</strong>{sources.map((source) => <SourceRow source={source} key={source.name} />)}</div></div></details>
        <p className="price-disclaimer"><Info size={14} />{he.priceDisclaimer}</p>
      </div>}
      {demo && <div className="demo-results">
        <div className="demo-disclaimer"><span><Sparkles size={16} />תצוגת המחשה</span><p>אלה נתוני דוגמה בלבד, כדי להראות איך תיראה המערכת. הם אינם מחירים חיים ואינם ניתנים להזמנה.</p><button type="button" aria-label="סגירת הדוגמה" onClick={() => setDemo(false)}><X size={17} /></button></div>
        <div className="results-title-row"><div><span className="panel-kicker">ככה נראות התוצאות</span><h2 id="results-heading">טיסה מתל אביב לברצלונה</h2></div><span className="demo-mode-label">DEMO</span></div>
        <div className="demo-grid"><DemoCard tag="💰 הכי זול" price="₪968" dates="12/11 – 18/11" time="שעה תופיע באתר" stops="עצירה אחת" /><DemoCard tag="⚖️ התמורה הטובה ביותר" price="₪1,140" dates="14/11 – 20/11" time="09:20 – 16:40" stops="ישירה" /><DemoCard tag="🎯 מתאים לשעות שלי" price="₪1,280" dates="16/11 – 22/11" time="08:10 – 15:30" stops="ישירה" /></div>
        <button className="clear-demo" type="button" onClick={() => { setDemo(false); setForm(emptyForm()); }}>חזרה לחיפוש אמיתי</button>
      </div>}
    </section>

    <section className="how-section" id="how-it-works"><div className="section-intro"><span className="panel-kicker">פשוט יותר לתכנן</span><h2>פחות לנחש.<br /><em>יותר לבחור נכון.</em></h2><p>לא צריך לפתוח עשרות תאריכים וחלונות. מסמנים מה גמיש לכם — ומשווים את ההצעות.</p></div><div className="steps-grid"><div className="how-card"><span className="step-number">01</span><div className="how-icon"><MapPin size={20} /></div><h3>בוחרים טווח</h3><p>מספרים לנו מאיפה, לאן, ומה טווח התאריכים שמתאים.</p></div><div className="how-card"><span className="step-number">02</span><div className="how-icon"><ArrowDownUp size={20} /></div><h3>משווים אפשרויות</h3><p>מחפשים הצעות ומסבירים מה ידוע, משוער או חסר.</p></div><div className="how-card"><span className="step-number">03</span><div className="how-icon"><ArrowUpRight size={20} /></div><h3>מזמינים אצל הספק</h3><p>בוחרים הצעה ועוברים לאתר ההזמנה. הכרטיס נקנה אצל הספק.</p></div></div></section>

    <section className="trust-strip" id="about-data"><div className="trust-icon"><ShieldCheck size={22} /></div><div><h2>מחירים שקופים, בלי לנחש</h2><p>כשמידע על שעות, עצירות או כבודה חסר — נכתוב את זה. המחיר הסופי נקבע באתר ההזמנה.</p></div><a href="/privacy" className="text-link">איך אנחנו שומרים על הפרטיות <ArrowLeft size={15} /></a></section>

    <section className="waitlist-cta"><div className="waitlist-spark"><Sparkles size={22} /></div><div><span className="panel-kicker">תצוגה מוקדמת</span><h2>המערכת מתכוננת לחיפוש חי.</h2><p>הטופס והממשק מוכנים. מחירי טיסות יוצגו אחרי חיבור מקור הנתונים.</p></div><a href="#search-heading" className="notify-button">חזרה לחיפוש <ArrowUpRight size={16} /></a></section>

    <footer className="site-footer"><a className="brand footer-brand" href="/"><span className="brand-mark"><Plane size={17} /></span><span className="brand-name">{PRODUCT_NAME}<span className="brand-period">.</span></span></a><p>עוזרים למצוא את הדרך המשתלמת יותר.</p><nav aria-label="מידע משפטי"><a href="/privacy">פרטיות</a><a href="/terms">תנאי שימוש</a><a href="/affiliate">גילוי נאות</a><a href="/accessibility">נגישות</a></nav><span className="copyright">© {new Date().getFullYear()} {PRODUCT_NAME} · גרסת תצוגה</span></footer>
    <button type="button" className="clear-saved" onClick={clearSaved}>מחקו חיפוש שמור במכשיר הזה</button>
  </main>;
}

function SourceRow({ source }: { source: SourceStatus }) {
  return <div className="source-row"><span className={`source-status ${source.ok ? "ok" : "not-ok"}`} /> <span>{source.name === "travelpayouts" ? "Travelpayouts" : "Google Flights"}</span><span>{source.enabled ? source.ok ? `${source.offers} הצעות` : "לא זמין כרגע" : "לא הופעל"}</span></div>;
}

function RefreshIcon() { return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9a7 7 0 0 1 12-2L20 12M4 12l2.5 5a7 7 0 0 0 12-2"/></svg>; }
