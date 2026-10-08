import { airlineOfficialUrl } from "../../../worker/src/airlines/official-links";
import { useId } from "react";
import { ArrowLeft, BaggageClaim, Clock3, ExternalLink, Info, Plane, Split, TriangleAlert } from "lucide-react";
import type { CardView, Leg, Offer, RecKind, SearchRequest } from "../api/contract";
import {
  KIND_REASONS, KIND_TITLES, bagView, isMinimumPrice, nightsBetween, originalPriceLabel, partyPriceLine, totalPassengers,
} from "../lib/builder";
import { formatDuration, formatILS, formatShortDate } from "../lib/search";
import { SUSPICIOUS_BADGE, SUSPICIOUS_TEXT, airlineLabels, cardAirlines, freshnessLine, freshnessTone, isSuspicious, type AirlineLabel } from "../lib/cards";
import { PartyCheckBox } from "./PartyCheck";

interface CardProps {
  card: CardView;
  request: SearchRequest;
  /** Display names for the searched places (shown only when the offer uses that exact code). */
  originLabel: string;
  destinationLabel: string;
  demo?: boolean;
  /** meta.partyCheck.available: offer the automatic "together or one by one?" check on this card (absent = no). */
  autoCheck?: boolean;
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
    <div className="leg-head"><span className="leg-title">{title}</span><span className="leg-date num" dir="ltr">{formatShortDate(date)}/{date.slice(0, 4)}</span></div>
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

/** Official airline links; a homepage is explicitly distinguished from a prefilled offer. */
function publishedPriceLink(source: string, link: string | null): string | null {
  const host = source === "american" ? "www.aa.com" : source === "aer_lingus" ? "www.aerlingus.com" : source === "gol" ? "www.voegol.com.br" : source === "sky_express" ? "www.skyexpress.gr" : source === "elal" ? "www.elal.com" : source === "air_canada" ? "www.aircanada.com" : source === "aegean" ? "flights.aegeanair.com" : source === "tap" ? "www.flytap.com" : source === "ethiopian" ? "www.ethiopianairlines.com" : source === "air_europa" ? "www.aireuropa.com" : source === "philippine" ? "flights.philippineairlines.com" : source === "virgin_atlantic" ? "flights.virginatlantic.com" : source === "air_new_zealand" ? "www.airnewzealand.com" : source === "air_baltic" ? "www.airbaltic.com" : null;
  if (!host || !link) return null;
  try {
    const url = new URL(link);
    const pathAllowed = source === "american" ? url.pathname === "/en-us/flights-from-los-angeles-to-mexico-city" : source === "aer_lingus" ? url.pathname === "/en-ie/flights-from-dublin" : source === "gol" ? url.pathname === "/en/flights-from-sao-paulo" : source === "sky_express" ? url.pathname === "/en/flights-from-athens" : source === "elal" ? url.pathname === "/flight-deals/en-il/" : source === "air_baltic" ? ["/en/flight-deals/flights-from-israel", "/en/flight-deals/flights-from-riga-to-tel-aviv"].includes(url.pathname) : source === "tap" && url.pathname === "/en_il/flights-from-tel-aviv" ? true : source === "air_new_zealand" ? url.pathname === "/flights/en-us/flights-from-los-angeles" : source === "air_canada" && url.pathname === "/en-ca/flights-from-tel-aviv" ? true : source === "virgin_atlantic" ? url.pathname === "/en-il/flights-from-tel-aviv" : source === "philippine" ? url.pathname === "/en-ph/flights-from-manila-to-bangkok" : source === "air_europa" ? url.pathname === "/en-il/flight-deals-from-tel-aviv-to-spain" : source === "ethiopian" ? url.pathname === "/en-il/" : /^\/(en-ca|he|en|en_pt)\/flights-from-[a-z-]+-to-[a-z-]+$/.test(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password || url.port || url.search || url.hash || !pathAllowed) return null;
    return url.href;
  } catch { return null; }
}
export function BookingActions({ card, demo, compact }: { card: CardView; demo?: boolean; compact?: boolean }) {
  const offer = card.offer;
  if (demo) return <p className="booking-demo"><Info size={16} aria-hidden="true" />בדוגמה אין קישור הזמנה. חפשו מסלול אמיתי כדי לקבל מחיר.</p>;
  const published = publishedPriceLink(offer.source, offer.deeplink);
  if (offer.source === "direct_combination") {
    const directions = [
      { title: "הלוך", code: offer.outbound.airlines[0], link: offer.deeplink },
      { title: "חזור", code: offer.inbound.airlines[0], link: offer.returnDeeplink },
    ].map(d => {
      const sourceByCarrier: Record<string, Offer["source"]> = { A3: "aegean", AC: "air_canada", TP: "tap", ET: "ethiopian", UX: "air_europa", PR: "philippine", VS: "virgin_atlantic", NZ: "air_new_zealand", BT: "air_baltic", GQ: "sky_express", G3: "gol", AA: "american", EI: "aer_lingus", LY: "elal" };
      const source = sourceByCarrier[d.code ?? ""];
      return { ...d, url: source ? publishedPriceLink(source, d.link ?? null) : d.code === "FR" && d.link === "https://www.ryanair.com/" ? d.link : null };
    });
    return <div className="booking official-booking">
      {directions.filter(d => d.url).map(d => <a key={d.title} className="btn btn-book btn-wide" href={d.url!} target="_blank" rel="noopener noreferrer">לאתר החברה · {d.title}<ExternalLink size={16} aria-hidden="true" /><NewTab /></a>)}
      <small>שני כרטיסים נפרדים מחברות שונות. יש לבחור בכל אתר את הכיוון והתאריך המוצגים ולאמת זמינות ומחיר סופי; הקישורים אינם הזמנה שמורה.</small>
    </div>;
  }
  const publishedReturn = publishedPriceLink(offer.source, offer.returnDeeplink ?? null);
  if (published) return <div className="booking official-booking">
    <a className={compact ? "btn btn-secondary" : "btn btn-book btn-wide"} href={published} target="_blank" rel="noopener noreferrer">למחיר שפורסם באתר החברה{offer.ticketStructure === "split" && " · הלוך"}<ExternalLink size={16} aria-hidden="true" /><NewTab /></a>
    {offer.ticketStructure === "split" && publishedReturn && <a className="btn btn-secondary" href={publishedReturn} target="_blank" rel="noopener noreferrer">למחיר שפורסם · חזור<ExternalLink size={16} aria-hidden="true" /><NewTab /></a>}
    <small>עמוד מחירים רשמי. יש לבחור את המסלול והתאריכים ולאמת זמינות ומחיר סופי; הקישור אינו הזמנה שמורה.</small>
  </div>;
  const airlines = cardAirlines(card).map(a => ({ ...a, url: airlineOfficialUrl(a.code) })).filter(a => a.url);
  if (!airlines.length) return <p className="booking-missing">המקור לא מסר חברת תעופה עם קישור רשמי להצעה הזו.</p>;
  const button = compact ? "btn btn-secondary" : "btn btn-book btn-wide";
  return <div className="booking official-booking">
    {airlines.map(a => <a key={a.code} className={button} href={a.url!} target="_blank" rel="noopener noreferrer">לפרטים ולהזמנה באתר {a.name || a.code}<ExternalLink size={16} aria-hidden="true" /><NewTab /></a>)}
    <small>הקישור פותח את אתר החברה. יש לבחור שם את המסלול והתאריכים המוצגים ולאמת את המחיר.</small>
    {offer.ticketStructure === "split" && <small>ההלוך והחזור הם כרטיסים נפרדים.</small>}
  </div>;
}
/** Actual returned details, followed by the airline's official website. */
export function FlightDetailsCard({ card, request, originLabel, destinationLabel }: CardProps) {
  const offer = card.offer;
  const minimum = isMinimumPrice(offer, request);
  const airlines = cardAirlines(card);
  const bag = bagView(offer, request);
  return <article className="flight-details-card">
    <header><div><h3><Airlines items={airlines} />{!airlines.length && "פרטי הטיסה"}</h3><p>{originLabel || offer.origin} <ArrowLeft size={17} aria-hidden="true" /> {destinationLabel || offer.destination}</p></div><div className="flight-details-price"><strong dir="ltr">{minimum ? "החל מ־ " : ""}{formatILS(offer.totalIls)}</strong><small>{partyPriceLine(offer.totalIls, totalPassengers(request), minimum)}</small></div></header>
    {offer.priceCurrency !== "ILS" && <p className="flight-details-freshness">{originalPriceLabel(offer.extrasAmountIls)}: <span dir="ltr">{offer.priceAmount.toLocaleString("en-US", { maximumFractionDigits: 2 })} {offer.priceCurrency}</span></p>}
    {offer.ticketPrices && <p className="flight-details-freshness">מחירי הכרטיסים בנפרד: הלוך <span dir="ltr">{offer.ticketPrices.outbound.amount.toFixed(2)} {offer.ticketPrices.outbound.currency}</span> · חזור <span dir="ltr">{offer.ticketPrices.inbound.amount.toFixed(2)} {offer.ticketPrices.inbound.currency}</span></p>}
    <div className="flight-details-legs"><LegRow title="הלוך" date={offer.departDate} leg={offer.outbound} names={card.airlineNames} /><LegRow title="חזור" date={offer.returnDate} leg={offer.inbound} names={card.airlineNames} /></div>
    {totalPassengers(request) > 1 && <p className="flight-details-freshness">המחיר לכמה נוסעים הוא הערכה לפי המחיר למבוגר.</p>}
    <p className="flight-details-bag"><BaggageClaim size={18} aria-hidden="true" />{bag.text}</p>
    {offer.ticketStructure === "split" && <p className="note note-warn">שני כרטיסים נפרדים. שינוי בכיוון אחד אינו מבטיח הגנה לכיוון השני.</p>}
    {offer.source === "ryanair" && <p className="note note-warn">מחיר מלוח המחירים הרשמי של Ryanair למבוגר אחד. יש לבדוק זמינות ומחיר סופי באתר החברה.</p>}
    {offer.source === "aegean" && <p className="note note-warn">מחיר שפורסם באתר Aegean למבוגר אחד בתאריכים המוצגים. זמינות ומחיר סופי נבדקים באתר החברה.</p>}
    {offer.source === "direct_combination" && <p className="note note-warn">שילוב שני מחירי כיוון אחד שפורסמו באתרים הרשמיים, למבוגר אחד בלבד. יש לאמת כל כרטיס בנפרד; שינוי בכיוון אחד אינו מבטיח הגנה לכיוון השני.</p>}
    {offer.source === "air_canada" && <p className="note note-warn">מחיר שפורסם באתר Air Canada למבוגר אחד בתאריכים המוצגים. זמינות ומחיר סופי נבדקים באתר החברה.</p>}
    {offer.source === "tap" && <p className="note note-warn">מחיר שפורסם באתר TAP למבוגר אחד בתאריכים המוצגים. זמינות ומחיר סופי נבדקים באתר החברה.</p>}
    {offer.source === "elal" && <p className="note note-warn">מחיר מבצע שפורסם באתר אל על למבוגר אחד בתאריכים המוצגים. הנתונים נטענו למאגר בבדיקה נקודתית; יש לאמת זמינות ומחיר סופי באתר החברה.</p>}
    {offer.source === "air_serbia" && <p className="note note-warn">מחירי לוח למבוגר אחד, בשני כרטיסים נפרדים. המחירים נמצאו באתר החברה במהלך 24 השעות האחרונות ועלולים להשתנות בהזמנה.</p>}
    {offer.source === "american" && <p className="note note-warn">מחיר הלוך וחזור שפורסם באתר American Airlines למבוגר אחד בתאריכים המוצגים. המחיר עשוי להיות בתעריף בסיסי; יש לאמת זמינות ומחיר סופי באתר החברה.</p>}
    {offer.source === "gol" && <p className="note note-warn">מחיר תיירים שפורסם באתר GOL למבוגר אחד בתאריכים המוצגים. יש לאמת שדה תעופה, זמינות ומחיר סופי באתר החברה.</p>}
    {offer.source === "sky_express" && <p className="note note-warn">מחיר תיירים שפורסם באתר SKY express למבוגר אחד בתאריכים המוצגים. יש לאמת זמינות ומחיר סופי באתר החברה.</p>}
    {offer.source === "air_baltic" && <p className="note note-warn">מחיר שפורסם באתר airBaltic למבוגר אחד בתאריכים המוצגים. זמינות, מפעיל הטיסה ותנאי הכרטיס נבדקים באתר החברה.</p>}
    {offer.source === "air_new_zealand" && <p className="note note-warn">מחיר הלוך ושוב שפורסם באתר Air New Zealand למבוגר אחד בתאריכים המוצגים. זמינות, מפעיל הטיסה וחיובים נוספים נבדקים באתר החברה.</p>}
    {offer.source === "virgin_atlantic" && <p className="note note-warn">מחיר תיירים שפורסם באתר Virgin Atlantic למבוגר אחד בתאריכים המוצגים. ייתכנו טיסות שותפים; זמינות, המפעיל והמחיר הסופי נבדקים באתר החברה.</p>}
    {offer.source === "philippine" && <p className="note note-warn">מחיר שפורסם באתר Philippine Airlines למבוגר אחד. אינו כולל מס נסיעות פיליפיני למי שחייב בו. זמינות, חיובים והמחיר הסופי נבדקים באתר החברה.</p>}
    {offer.source === "air_europa" && <p className="note note-warn">מחיר שפורסם באתר Air Europa למבוגר אחד בתאריכים המוצגים. זמינות ומחיר סופי נבדקים באתר החברה.</p>}
    {offer.source === "ethiopian" && <p className="note note-warn">מחיר שפורסם באתר Ethiopian למבוגר אחד בתאריכים המוצגים. זמינות ומחיר סופי נבדקים באתר החברה.</p>}
    {isSuspicious(card) && <p className="note note-warn">{SUSPICIOUS_TEXT}</p>}
    <p className="flight-details-freshness">{freshnessLine(card)}</p>
    <BookingActions card={card} />
  </article>;
}

/** The hero: the cheapest offer as a boarding pass. */
export function BoardingPass({ card, request, originLabel, destinationLabel, demo, autoCheck }: CardProps) {
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
    <PartyCheckBox card={card} autoCheck={autoCheck} demo={demo} />
  </article>;
}

/** The other recommendations, smaller, each with a one-line reason. */
export function CompactCard({ card, request, demo, autoCheck }: CardProps) {
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
      <PartyCheckBox card={card} autoCheck={autoCheck} demo={demo} />
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

