import { useId } from "react";
import { ArrowLeft, BaggageClaim, Clock3, ExternalLink, Info, Plane, Split, TriangleAlert } from "lucide-react";
import type { CardView, Leg, RecKind, SearchRequest } from "../api/contract";
import {
  KIND_REASONS, KIND_TITLES, bagView, isMinimumPrice, nightsBetween, originalPriceLabel, partyPriceLine, totalPassengers,
} from "../lib/builder";
import { formatDuration, formatILS, formatShortDate, trustedBookingUrl } from "../lib/search";
import { SUSPICIOUS_BADGE, SUSPICIOUS_TEXT, airlineLabels, cardAirlines, freshnessLine, freshnessTone, isSuspicious, type AirlineLabel } from "../lib/cards";

interface CardProps {
  card: CardView;
  request: SearchRequest;
  /** Display names for the searched places (shown only when the offer uses that exact code). */
  originLabel: string;
  destinationLabel: string;
  demo?: boolean;
}

function stopsText(stops: number | null): string {
  if (stops === null) return "מספר העצירות לא ידוע";
  return stops === 0 ? "טיסה ישירה" : stops === 1 ? "עצירה אחת" : `${stops} עצירות`;
}

/** Hebrew airline names where the API knows them; an unknown code is shown as the code, left to right. */
function Airlines({ items }: { items: AirlineLabel[] }) {
  return <>{items.map((a, i) => <span key={a.code}>
    {i > 0 && " · "}
    {a.name ? <span title={a.code}>{a.name}</span> : <span dir="ltr">{a.code}</span>}
  </span>)}</>;
}

function primaryKind(kinds: RecKind[]): RecKind {
  return kinds.includes("cheapest") ? "cheapest" : kinds[0] ?? "cheapest";
}

function LegRow({ title, date, leg, names }: { title: string; date: string; leg: Leg; names: Record<string, string> | undefined }) {
  const airlines = airlineLabels(leg.airlines, names);
  const times = leg.departTime && leg.arriveTime ? `${leg.departTime} – ${leg.arriveTime}` : leg.departTime ? `המראה ${leg.departTime}` : null;
  return <div className="leg">
    <div className="leg-head"><span className="leg-title">{title}</span><span className="leg-date num" dir="ltr">{formatShortDate(date)}</span></div>
    <div className="leg-time">{times ? <span className="num">{times}</span> : <span className="leg-unknown"><Clock3 size={15} aria-hidden="true" />השעה תופיע באתר ההזמנה</span>}</div>
    <div className="leg-meta">
      <span>{stopsText(leg.stops)}</span>
      {leg.durationMin !== null && <span>{formatDuration(leg.durationMin)}</span>}
      {airlines.length > 0 && <span><span className="sr-only">חברות תעופה: </span><span className="leg-airlines"><Airlines items={airlines} /></span></span>}
    </div>
  </div>;
}

function NewTab() {
  return <span className="sr-only"> (נפתח בחלון חדש)</span>;
}

/** Booking buttons. A split ticket always explains both halves; a missing return link is said out loud. */
export function BookingActions({ card, demo, compact }: { card: CardView; demo?: boolean; compact?: boolean }) {
  const offer = card.offer;
  if (demo) return <p className="booking-demo"><Info size={16} aria-hidden="true" />בדוגמה אין קישור הזמנה. חפשו מסלול אמיתי כדי לקבל מחיר.</p>;
  const out = trustedBookingUrl(offer.deeplink);
  const back = trustedBookingUrl(offer.returnDeeplink);
  const verify = trustedBookingUrl(offer.verifyLink);
  const btn = compact ? "btn btn-secondary" : "btn btn-book btn-wide";
  if (offer.ticketStructure === "split") {
    return <div className="booking split">
      {out ? <a className={btn} href={out} target="_blank" rel="sponsored noopener noreferrer">כרטיס הלוך<ExternalLink size={16} aria-hidden="true" /><NewTab /></a>
        : <p className="booking-missing">קישור לכרטיס ההלוך לא זמין כרגע.</p>}
      {back ? <a className={btn} href={back} target="_blank" rel="sponsored noopener noreferrer">כרטיס חזור<ExternalLink size={16} aria-hidden="true" /><NewTab /></a>
        : <div className="booking-missing">
          <p>קישור לכרטיס החזור לא זמין כרגע. צריך להזמין אותו בנפרד.</p>
          {verify && <a className="btn btn-ghost" href={verify} target="_blank" rel="sponsored noopener noreferrer">חיפוש החזור באתר <span className="brand-word">Aviasales</span><ExternalLink size={16} aria-hidden="true" /><NewTab /></a>}
        </div>}
    </div>;
  }
  if (out) return <div className="booking"><a className={btn} href={out} target="_blank" rel="sponsored noopener noreferrer">להזמנה באתר <span className="brand-word">Aviasales</span><ExternalLink size={16} aria-hidden="true" /><NewTab /></a></div>;
  if (verify) return <div className="booking"><a className={compact ? "btn btn-ghost" : "btn btn-secondary btn-wide"} href={verify} target="_blank" rel="sponsored noopener noreferrer">לבדיקת המחיר באתר <span className="brand-word">Aviasales</span><ExternalLink size={16} aria-hidden="true" /><NewTab /></a></div>;
  return <p className="booking-missing">קישור הזמנה לא זמין כרגע להצעה הזו.</p>;
}

/** The hero: the cheapest offer as a boarding pass. */
export function BoardingPass({ card, request, originLabel, destinationLabel, demo }: CardProps) {
  const offer = card.offer;
  const people = totalPassengers(request);
  const nights = nightsBetween(offer.departDate, offer.returnDate);
  const bag = bagView(offer, request);
  const atLeast = isMinimumPrice(offer, request);
  const titleId = useId();
  const split = offer.ticketStructure === "split";
  const originName = offer.origin === request.origin ? originLabel : "";
  const destinationName = offer.destination === request.destination ? destinationLabel : "";
  const kind = primaryKind(card.kinds);
  const alsoKinds = card.kinds.filter((k) => k !== kind);
  const suspicious = !demo && isSuspicious(card);
  return <article className={`pass ${demo ? "is-demo" : ""}`} aria-labelledby={titleId}>
    {demo && <div className="demo-ribbon">דוגמה להמחשה · לא מחיר אמיתי</div>}
    <div className="pass-top">
      <div className="pass-badges">
        <h3 className="badge badge-accent pass-title" id={titleId}>{KIND_TITLES[kind]}</h3>
        {alsoKinds.map((k) => <span className="badge" key={k}>גם {KIND_TITLES[k]}</span>)}
        {suspicious && <span className="badge badge-warn"><TriangleAlert size={14} aria-hidden="true" />{SUSPICIOUS_BADGE}</span>}
      </div>
      <span className={`freshness tone-${freshnessTone(card)}`}>{demo ? "נתוני דוגמה" : freshnessLine(card)}</span>
    </div>

    <div className="pass-route">
      <div className="pass-place"><span className="pass-code" dir="ltr">{offer.origin}</span>{originName && <span className="pass-city">{originName}</span>}</div>
      <div className="pass-path" aria-hidden="true"><span className="pass-dash" /><Plane size={22} className="pass-plane" /><span className="pass-dash" /></div>
      <div className="pass-place"><span className="pass-code" dir="ltr">{offer.destination}</span>{destinationName && <span className="pass-city">{destinationName}</span>}</div>
    </div>
    <p className="sr-only">{`מ־${originName || offer.origin} אל ${destinationName || offer.destination}`}</p>

    <div className="pass-price-block">
      <div className="pass-price num">{atLeast && <span className="price-prefix">לפחות </span>}<span dir="ltr">{formatILS(offer.totalIls)}</span></div>
      <div className="pass-price-detail num">{partyPriceLine(offer.totalIls, people, atLeast)}</div>
      {offer.priceCurrency !== "ILS" && <div className="pass-original" dir="rtl">{originalPriceLabel(offer.extrasAmountIls)}: <span dir="ltr" className="num">{Math.ceil(offer.priceAmount).toLocaleString("en-US")} {offer.priceCurrency}</span></div>}
    </div>

    <dl className="pass-facts">
      <div><dt>יוצאים</dt><dd className="num">{formatShortDate(offer.departDate)}</dd></div>
      <div><dt>חוזרים</dt><dd className="num">{formatShortDate(offer.returnDate)}</dd></div>
      <div><dt>לילות</dt><dd className="num">{nights}</dd></div>
    </dl>

    <div className="perforation" aria-hidden="true" />

    <div className="pass-legs">
      <LegRow title="הלוך" date={offer.departDate} leg={offer.outbound} names={card.airlineNames} />
      <LegRow title="חזור" date={offer.returnDate} leg={offer.inbound} names={card.airlineNames} />
    </div>

    <ul className="pass-notes">
      {suspicious && <li className="note note-warn"><TriangleAlert size={16} aria-hidden="true" /><span>{SUSPICIOUS_TEXT}</span></li>}
      <li className={`note note-${bag.tone}`}><BaggageClaim size={16} aria-hidden="true" />{bag.text}</li>
      {split && <li className="note note-warn"><Split size={16} aria-hidden="true" /><span><strong>שני כרטיסים נפרדים.</strong> מזמינים כל כיוון בנפרד. אם טיסה אחת משתנה או מתבטלת, השנייה לא מוגנת.</span></li>}
      {card.savingsVsRoundtripIls !== null && card.savingsVsRoundtripIls > 0 && <li className="note note-good">זול ב־{formatILS(card.savingsVsRoundtripIls)} מהלוך־חזור הזול ביותר</li>}
      {people > 1 && <li className="note note-plain"><Info size={16} aria-hidden="true" />המחיר לכמה נוסעים מחושב לפי מחיר למבוגר, והוא הערכה</li>}
    </ul>

    <BookingActions card={card} demo={demo} />
  </article>;
}

/** The other recommendations, smaller, each with a one-line reason. */
export function CompactCard({ card, request, demo }: CardProps) {
  const offer = card.offer;
  const kind = card.kinds.find((k) => k !== "cheapest") ?? primaryKind(card.kinds);
  const nights = nightsBetween(offer.departDate, offer.returnDate);
  const atLeast = isMinimumPrice(offer, request);
  const people = totalPassengers(request);
  const bag = bagView(offer, request);
  const split = offer.ticketStructure === "split";
  const stops = [offer.outbound.stops, offer.inbound.stops];
  const titleId = useId();
  const suspicious = !demo && isSuspicious(card);
  const airlines = cardAirlines(card);
  return <article className={`mini ${demo ? "is-demo" : ""}`} aria-labelledby={titleId}>
    <div className="mini-top">
      <div>
        <h3 className="mini-title" id={titleId}>{KIND_TITLES[kind]}</h3><p className="mini-reason">{KIND_REASONS[kind]}</p>
        {suspicious && <span className="mini-flag"><TriangleAlert size={14} aria-hidden="true" />{SUSPICIOUS_BADGE}</span>}
      </div>
      <div className="mini-price-block">
        <div className="mini-price num">{atLeast && <span className="price-prefix">לפחות </span>}<span dir="ltr">{formatILS(offer.totalIls)}</span></div>
        <div className="mini-party num">{partyPriceLine(offer.totalIls, people, atLeast)}</div>
      </div>
    </div>
    <div className="dots"><p className="dots-row mini-line">
      <span className="nowrap"><span className="num" dir="ltr">{formatShortDate(offer.departDate)}</span><ArrowLeft size={14} aria-hidden="true" className="mini-arrow" /><span className="sr-only">עד</span><span className="num" dir="ltr">{formatShortDate(offer.returnDate)}</span></span>
      <span>{nights} לילות</span>
      <span>{stops[0] === 0 && stops[1] === 0 ? "ישירות בשני הכיוונים" : `הלוך: ${stopsText(stops[0])}, חזור: ${stopsText(stops[1])}`}</span>
    </p></div>
    <div className="dots"><p className="dots-row mini-line mini-sub">
      {offer.outbound.departTime ? <span>המראה בהלוך <span className="num" dir="ltr">{offer.outbound.departTime}</span></span> : <span>השעות יופיעו באתר ההזמנה</span>}
      {airlines.length > 0 && <span><span className="sr-only">חברות תעופה: </span><Airlines items={airlines} /></span>}
      {split && <strong className="mini-split">שני כרטיסים נפרדים</strong>}
    </p></div>
    <p className={`mini-bag tone-${bag.tone}`}><BaggageClaim size={15} aria-hidden="true" />{bag.text}</p>
    <div className="mini-foot">
      <span className={`freshness tone-${freshnessTone(card)}`}>{demo ? "נתוני דוגמה" : freshnessLine(card)}</span>
      <BookingActions card={card} demo={demo} compact />
    </div>
  </article>;
}

export function PassSkeleton() {
  return <div className="pass skeleton" aria-hidden="true">
    <div className="sk sk-badge" />
    <div className="sk-route"><div className="sk sk-code" /><div className="sk sk-line" /><div className="sk sk-code" /></div>
    <div className="sk sk-price" />
    <div className="sk sk-text" />
    <div className="perforation" />
    <div className="sk sk-row" /><div className="sk sk-row" />
    <div className="sk sk-button" />
  </div>;
}

