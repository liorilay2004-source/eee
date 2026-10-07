import type { Resolver } from "./airports/types";
import type { SearchRequest, SourceRegistryEntry, SourceRegistryStatus } from "./types";

const active = {
  livePrice: true,
  cachedPrice: true,
  bookingLink: true,
  directBooking: false,
  combinations: true,
} as const;

const manual = {
  livePrice: false,
  cachedPrice: false,
  bookingLink: true,
  directBooking: true,
  combinations: false,
} as const;

const planned = {
  livePrice: false,
  cachedPrice: false,
  bookingLink: false,
  directBooking: true,
  combinations: false,
} as const;

const HOME_URLS: Readonly<Record<string, string>> = Object.freeze({
  travelpayouts: "https://www.aviasales.com/",
  searchapi: "https://www.searchapi.io/",
  serpapi: "https://serpapi.com/",
  hasdata: "https://hasdata.com/",
  wego: "https://www.wego.com/",
  ignav: "https://ignav.com/",
  google_flights: "https://www.google.com/travel/flights",

  duffel: "https://duffel.com/",
  amadeus: "https://developers.amadeus.com/",
  travelport: "https://developer.travelport.com/",
  sabre: "https://developer.sabre.com/",
  elal: "https://www.elal.com/",
  arkia: "https://www.arkia.com/",
  israir: "https://www.israir.co.il/",
  turkish: "https://www.turkishairlines.com/",
  pegasus: "https://www.flypgs.com/",
  aegean: "https://en.aegeanair.com/",
  wizz: "https://wizzair.com/",
  ryanair: "https://www.ryanair.com/",
  easyjet: "https://www.easyjet.com/",
  lufthansa: "https://www.lufthansa.com/",
  swiss: "https://www.swiss.com/",
  austrian: "https://www.austrian.com/",
  airfrance: "https://wwws.airfrance.com/",
  klm: "https://www.klm.com/",
  emirates: "https://www.emirates.com/",
  etihad: "https://www.etihad.com/",
  qatar: "https://www.qatarairways.com/",
  british_airways: "https://www.britishairways.com/",
  ita: "https://www.ita-airways.com/",
  iberia: "https://www.iberia.com/",
  tap: "https://www.flytap.com/",
  vueling: "https://www.vueling.com/",
  lot: "https://www.lot.com/",
  sas: "https://www.flysas.com/",
  finnair: "https://www.finnair.com/",
  norwegian: "https://www.norwegian.com/",
  icelandair: "https://www.icelandair.com/",
  aer_lingus: "https://www.aerlingus.com/",
  brussels: "https://www.brusselsairlines.com/",
  eurowings: "https://www.eurowings.com/",
  air_europa: "https://www.aireuropa.com/",
  transavia: "https://www.transavia.com/",
  sunexpress: "https://www.sunexpress.com/",
  jet2: "https://www.jet2.com/",
  volotea: "https://www.volotea.com/",
  air_baltic: "https://www.airbaltic.com/",
  flydubai: "https://www.flydubai.com/",
  air_arabia: "https://www.airarabia.com/",
  gulf_air: "https://www.gulfair.com/",
  oman_air: "https://www.omanair.com/",
  saudia: "https://www.saudia.com/",
  royal_jordanian: "https://www.rj.com/",
  kuwait: "https://www.kuwaitairways.com/",
  egyptair: "https://www.egyptair.com/",
  ethiopian: "https://www.ethiopianairlines.com/",
  kenya: "https://www.kenya-airways.com/",
  south_african: "https://www.flysaa.com/",
  royal_air_maroc: "https://www.royalairmaroc.com/",
  air_canada: "https://www.aircanada.com/",
  american: "https://www.aa.com/",
  delta: "https://www.delta.com/",
  united: "https://www.united.com/",
  southwest: "https://www.southwest.com/",
  alaska: "https://www.alaskaair.com/",
  jetblue: "https://www.jetblue.com/",
  spirit: "https://www.spirit.com/",
  frontier: "https://www.flyfrontier.com/",
  hawaiian: "https://www.hawaiianairlines.com/",
  aeromexico: "https://aeromexico.com/",
  latam: "https://www.latamairlines.com/",
  avianca: "https://www.avianca.com/",
  copa: "https://www.copaair.com/",
  azul: "https://www.voeazul.com.br/",
  gol: "https://www.voegol.com.br/",
  air_china: "https://www.airchina.com/",
  china_eastern: "https://www.ceair.com/",
  china_southern: "https://www.csair.com/",
  hainan: "https://www.hainanairlines.com/",
  cathay: "https://www.cathaypacific.com/",
  singapore: "https://www.singaporeair.com/",
  scoot: "https://www.flyscoot.com/",
  malaysia: "https://www.malaysiaairlines.com/",
  thai: "https://www.thaiairways.com/",
  vietnam: "https://www.vietnamairlines.com/",
  philippine: "https://www.philippineairlines.com/",
  garuda: "https://www.garuda-indonesia.com/",
  jal: "https://www.jal.co.jp/",
  ana: "https://www.ana.co.jp/",
  korean: "https://www.koreanair.com/",
  asiana: "https://flyasiana.com/",
  eva: "https://www.evaair.com/",
  china_airlines: "https://www.china-airlines.com/",
  air_india: "https://www.airindia.com/",
  indigo: "https://www.goindigo.in/",
  qantas: "https://www.qantas.com/",
  virgin_australia: "https://www.virginaustralia.com/",
  air_new_zealand: "https://www.airnewzealand.com/",
  virgin_atlantic: "https://www.virginatlantic.com/",
  air_serbia: "https://www.airserbia.com/",
  croatia: "https://www.croatiaairlines.com/",
  tarom: "https://www.tarom.ro/",
  bulgaria_air: "https://www.air.bg/",
  georgian: "https://georgian-airways.com/",
  azerbaijan: "https://www.azal.az/",
  uzbekistan: "https://www.uzairways.com/",
  air_astana: "https://airastana.com/",
  ukraine_international: "https://www.flyuia.com/",
  smartwings: "https://www.smartwings.com/",
});


const EUROPE = new Set(["AL", "AD", "AT", "BE", "BA", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IS", "IE", "IT", "LV", "LT", "LU", "MT", "MD", "MC", "ME", "NL", "MK", "NO", "PL", "PT", "RO", "RS", "SK", "SI", "ES", "SE", "CH", "UA", "GB"]);
const MIDDLE_EAST = new Set(["IL", "TR", "AE", "QA", "BH", "OM", "SA", "JO", "KW", "EG", "LB", "CY"]);
const ASIA = new Set(["JP", "CN", "HK", "SG", "MY", "TH", "VN", "PH", "ID", "KR", "TW", "IN", "KZ", "UZ", "AZ", "GE"]);
const AFRICA = new Set(["MA", "EG", "ET", "KE", "ZA"]);
const LATAM = new Set(["MX", "BR", "AR", "CL", "CO", "PA", "PE", "EC", "UY"]);
const OCEANIA = new Set(["AU", "NZ", "FJ"]);

function regionTokens(country: string | null): string[] {
  if (!country) return [];
  const c = country.toUpperCase();
  const out = [c];
  if (c === "IL") out.push("ME");
  if (c === "US") out.push("US");
  if (c === "CA") out.push("CA", "US");
  if (EUROPE.has(c)) out.push("EU");
  if (MIDDLE_EAST.has(c)) out.push("ME");
  if (ASIA.has(c)) out.push("Asia");
  if (AFRICA.has(c)) out.push("Africa");
  if (LATAM.has(c)) out.push("LATAM");
  if (OCEANIA.has(c)) out.push("Oceania");
  if (c === "TR") out.push("TR");
  return [...new Set(out)];
}

function routeTokens(req: Pick<SearchRequest, "origin" | "destination">, resolver: Pick<Resolver, "countryOfAirport">): string[] {
  return [...new Set([...regionTokens(resolver.countryOfAirport(req.origin)), ...regionTokens(resolver.countryOfAirport(req.destination))])];
}

function copy(source: SourceRegistryEntry): SourceRegistryEntry {
  return { ...source, capabilities: { ...source.capabilities }, markets: [...source.markets] };
}

function homeUrl(id: string): string {
  const url = HOME_URLS[id];
  if (!url) throw new Error(`source registry missing homeUrl for ${id}`);
  return url;
}

function entry(
  id: string,
  name: string,
  status: SourceRegistryStatus,
  priority: number,
  markets: string[],
  noteHe: string,
): SourceRegistryEntry {
  return {
    id,
    name,
    kind: "airline",
    status,
    homeUrl: homeUrl(id),
    capabilities: status === "active" || status === "api" ? active : status === "manual-link" ? manual : planned,
    markets,
    priority,
    noteHe,
  };
}

export const SOURCE_REGISTRY: readonly SourceRegistryEntry[] = Object.freeze([
  {
    id: "travelpayouts",
    name: "Aviasales / Travelpayouts",
    kind: "metasearch",
    status: "active",
    homeUrl: homeUrl("travelpayouts"),
    capabilities: active,
    markets: ["global", "IL"],
    priority: 100,
    noteHe: "מקור פעיל למחירי מטמון, קומבינציות וקישורי הזמנה.",
  },
  {
    id: "searchapi",
    name: "SearchApi",
    kind: "metasearch",
    status: "api",
    homeUrl: homeUrl("searchapi"),
    capabilities: active,
    markets: ["global"],
    priority: 91,
    noteHe: "מקור API אופציונלי לאימות מחירים חיים כשמוגדר מפתח.",
  },
  {
    id: "serpapi",
    name: "SerpApi",
    kind: "metasearch",
    status: "api",
    homeUrl: homeUrl("serpapi"),
    capabilities: active,
    markets: ["global"],
    priority: 90,
    noteHe: "מקור API אופציונלי לאימות מחירים חיים כשמוגדר מפתח.",
  },
  {
    id: "hasdata",
    name: "HasData",
    kind: "metasearch",
    status: "api",
    homeUrl: homeUrl("hasdata"),
    capabilities: active,
    markets: ["global"],
    priority: 87,
    noteHe: "מקור API אופציונלי לאימות מחירים חיים כשמוגדר מפתח, עד 55 בקשות בחודש.",
  },
  {
    id: "wego",
    name: "Wego",
    kind: "metasearch",
    status: "api",
    homeUrl: homeUrl("wego"),
    capabilities: active,
    markets: ["global", "ME"],
    priority: 89,
    noteHe: "מקור API אופציונלי עם מכסות קשיחות ושמירת תוצאות.",
  },
  {
    id: "ignav",
    name: "Ignav",
    kind: "metasearch",
    status: "api",
    homeUrl: homeUrl("ignav"),
    capabilities: active,
    markets: ["global"],
    priority: 88,
    noteHe: "מקור API אופציונלי לאימות תאריכים זולים.",
  },

  {
    id: "duffel",
    name: "Duffel",
    kind: "metasearch",
    status: "api",
    homeUrl: homeUrl("duffel"),
    capabilities: active,
    markets: ["global"],
    priority: 87,
    noteHe: "API רב-חברתי פעיל בקוד: עובד עם DUFFEL_API_TOKEN; טוקן live דורש DUFFEL_ALLOW_LIVE=true כדי למנוע עלות לא מכוונת.",
  },
  {
    id: "amadeus",
    name: "Amadeus",
    kind: "metasearch",
    status: "api",
    homeUrl: homeUrl("amadeus"),
    capabilities: planned,
    markets: ["global"],
    priority: 86,
    noteHe: "Flight Offers Search/Price דרך API אחד, אחרי הגדרת AMADEUS credentials.",
  },
  {
    id: "travelport",
    name: "Travelport",
    kind: "metasearch",
    status: "api",
    homeUrl: homeUrl("travelport"),
    capabilities: planned,
    markets: ["global"],
    priority: 85,
    noteHe: "GDS/API רב-חברתי, דורש provisioning ו-credentials.",
  },
  {
    id: "sabre",
    name: "Sabre",
    kind: "metasearch",
    status: "api",
    homeUrl: homeUrl("sabre"),
    capabilities: planned,
    markets: ["global"],
    priority: 84,
    noteHe: "GDS/Offers and Orders, דורש חשבון Sabre ו-provisioning.",
  },
  {
    id: "google_flights",
    name: "Google Flights",
    kind: "metasearch",
    status: "planned",
    homeUrl: homeUrl("google_flights"),
    capabilities: planned,
    markets: ["global"],
    priority: 80,
    noteHe: "משמש כיעד אימות עתידי, לא כמקור הזמנה ישיר כרגע.",
  },

  entry("elal", "El Al", "manual-link", 79, ["IL", "EU", "US", "Asia"], "קישור חיפוש ישיר מתוכנן, בלי קריאת מחיר חיה כרגע."),
  entry("arkia", "Arkia", "manual-link", 78, ["IL", "EU"], "קישור חיפוש ישיר מתוכנן, בלי קריאת מחיר חיה כרגע."),
  entry("israir", "Israir", "manual-link", 77, ["IL", "EU"], "קישור חיפוש ישיר מתוכנן, בלי קריאת מחיר חיה כרגע."),
  entry("turkish", "Turkish Airlines", "manual-link", 76, ["IL", "EU", "Asia", "US"], "מקור עדיפות גבוהה לקונקשנים מישראל."),
  entry("pegasus", "Pegasus Airlines", "manual-link", 75, ["IL", "EU", "Asia"], "מקור עדיפות גבוהה לטיסות זולות דרך טורקיה."),
  { ...entry("aegean", "Aegean Airlines", "manual-link", 74, ["IL", "EU"], "קריאת מחירים שפורסמו בעמודי תל אביב–אתונה בלבד, בהתאמה לשני התאריכים. אין עדיין כיסוי מלא של זמינות חיה."), capabilities: { ...manual, cachedPrice: true, combinations: true } },
  entry("wizz", "Wizz Air", "manual-link", 73, ["IL", "EU"], "מקור לואו קוסט חשוב ליציאה מאזור ישראל."),
  entry("ryanair", "Ryanair", "active", 72, ["EU"], "מחירי לוח רשמי למבוגר אחד, שילוב הלוך וחזור בתאריכים שנבחרו; זמינות ומחיר סופי נבדקים באתר החברה."),
  entry("easyjet", "easyJet", "manual-link", 71, ["EU"], "מקור לואו קוסט לשילובים באירופה."),
  entry("lufthansa", "Lufthansa", "manual-link", 70, ["IL", "EU", "US", "Asia"], "קישור חיפוש ישיר מתוכנן."),
  entry("swiss", "SWISS", "manual-link", 69, ["IL", "EU", "US", "Asia"], "קישור חיפוש ישיר מתוכנן."),
  entry("austrian", "Austrian Airlines", "manual-link", 68, ["IL", "EU", "US", "Asia"], "קישור חיפוש ישיר מתוכנן."),
  entry("airfrance", "Air France", "manual-link", 67, ["IL", "EU", "US", "Asia"], "קישור חיפוש ישיר מתוכנן."),
  entry("klm", "KLM", "manual-link", 66, ["IL", "EU", "US", "Asia"], "קישור חיפוש ישיר מתוכנן."),
  entry("emirates", "Emirates", "manual-link", 65, ["IL", "ME", "Asia", "Oceania"], "מקור עדיפות גבוהה לאסיה ואוקיאניה."),
  entry("etihad", "Etihad Airways", "manual-link", 64, ["IL", "ME", "Asia", "Oceania"], "מקור עדיפות גבוהה לאסיה ואוקיאניה."),
  entry("qatar", "Qatar Airways", "manual-link", 63, ["ME", "Asia", "Oceania"], "מקור עדיפות גבוהה לאסיה ואוקיאניה."),
  entry("british_airways", "British Airways", "planned", 55, ["EU", "US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("ita", "ITA Airways", "planned", 55, ["EU"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("iberia", "Iberia", "planned", 55, ["EU", "LATAM"], "מתוכנן כקישור/אדפטר עתידי."),
  { ...entry("tap", "TAP Air Portugal", "manual-link", 55, ["IL", "EU", "US", "LATAM"], "קריאת מחירים שפורסמו בעמוד תל אביב–ליסבון בלבד, בהתאמה לשני התאריכים. אין עדיין כיסוי מלא של זמינות חיה."), capabilities: { ...manual, cachedPrice: true, combinations: true } },
  entry("vueling", "Vueling", "planned", 54, ["EU"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("lot", "LOT Polish Airlines", "planned", 54, ["EU", "Asia", "US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("sas", "SAS", "planned", 53, ["EU", "US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("finnair", "Finnair", "planned", 53, ["EU", "Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("norwegian", "Norwegian", "planned", 52, ["EU"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("icelandair", "Icelandair", "planned", 52, ["EU", "US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("aer_lingus", "Aer Lingus", "planned", 52, ["EU", "US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("brussels", "Brussels Airlines", "planned", 52, ["EU", "Africa"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("eurowings", "Eurowings", "planned", 51, ["EU"], "מתוכנן כקישור/אדפטר עתידי."),
  { ...entry("air_europa", "Air Europa", "manual-link", 51, ["IL", "EU", "LATAM"], "מחירים מתוארכים שפורסמו למסלולים מתל אביב לספרד. נדרש אימות זמינות ומחיר סופי באתר החברה."), capabilities: { ...manual, cachedPrice: true, combinations: true } },
  entry("transavia", "Transavia", "planned", 51, ["EU"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("sunexpress", "SunExpress", "planned", 51, ["EU", "TR"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("jet2", "Jet2", "planned", 50, ["EU"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("volotea", "Volotea", "planned", 50, ["EU"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("air_baltic", "Air Baltic", "planned", 50, ["EU"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("flydubai", "flydubai", "planned", 49, ["ME", "Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("air_arabia", "Air Arabia", "planned", 49, ["ME", "Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("gulf_air", "Gulf Air", "planned", 48, ["ME", "Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("oman_air", "Oman Air", "planned", 48, ["ME", "Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("saudia", "Saudia", "planned", 48, ["ME", "Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("royal_jordanian", "Royal Jordanian", "planned", 48, ["ME", "EU", "Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("kuwait", "Kuwait Airways", "planned", 47, ["ME", "Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("egyptair", "EgyptAir", "planned", 47, ["ME", "Africa"], "מתוכנן כקישור/אדפטר עתידי."),
  { ...entry("ethiopian", "Ethiopian Airlines", "manual-link", 47, ["IL", "Africa", "Asia"], "קריאת מחירים מתוארכים שפורסמו בעמוד הישראלי, ליעדים מתל אביב בלבד. אין עדיין כיסוי מלא של זמינות חיה."), capabilities: { ...manual, cachedPrice: true, combinations: true } },
  entry("kenya", "Kenya Airways", "planned", 46, ["Africa"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("south_african", "South African Airways", "planned", 46, ["Africa"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("royal_air_maroc", "Royal Air Maroc", "planned", 46, ["Africa", "EU", "US"], "מתוכנן כקישור/אדפטר עתידי."),
  { ...entry("air_canada", "Air Canada", "manual-link", 45, ["IL", "US", "CA"], "קריאת מחירים שפורסמו בעמוד תל אביב–טורונטו בלבד, בהתאמה לשני התאריכים. אין עדיין כיסוי מלא של זמינות חיה."), capabilities: { ...manual, cachedPrice: true, combinations: true } },
  entry("american", "American Airlines", "planned", 45, ["US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("delta", "Delta Air Lines", "planned", 45, ["US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("united", "United Airlines", "planned", 45, ["US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("southwest", "Southwest Airlines", "planned", 44, ["US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("alaska", "Alaska Airlines", "planned", 44, ["US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("jetblue", "JetBlue", "planned", 44, ["US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("spirit", "Spirit Airlines", "planned", 43, ["US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("frontier", "Frontier Airlines", "planned", 43, ["US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("hawaiian", "Hawaiian Airlines", "planned", 43, ["US", "Oceania"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("aeromexico", "Aeromexico", "planned", 42, ["LATAM", "US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("latam", "LATAM Airlines", "planned", 42, ["LATAM"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("avianca", "Avianca", "planned", 42, ["LATAM"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("copa", "Copa Airlines", "planned", 42, ["LATAM"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("azul", "Azul", "planned", 41, ["LATAM"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("gol", "GOL", "planned", 41, ["LATAM"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("air_china", "Air China", "planned", 40, ["Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("china_eastern", "China Eastern Airlines", "planned", 40, ["Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("china_southern", "China Southern Airlines", "planned", 40, ["Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("hainan", "Hainan Airlines", "planned", 40, ["Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("cathay", "Cathay Pacific", "planned", 39, ["Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("singapore", "Singapore Airlines", "planned", 39, ["Asia", "Oceania"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("scoot", "Scoot", "planned", 39, ["Asia", "Oceania"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("malaysia", "Malaysia Airlines", "planned", 38, ["Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("thai", "Thai Airways", "planned", 38, ["Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("vietnam", "Vietnam Airlines", "planned", 38, ["Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("philippine", "Philippine Airlines", "planned", 38, ["Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("garuda", "Garuda Indonesia", "planned", 37, ["Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("jal", "Japan Airlines", "planned", 37, ["Asia", "US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("ana", "ANA", "planned", 37, ["Asia", "US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("korean", "Korean Air", "planned", 37, ["Asia", "US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("asiana", "Asiana Airlines", "planned", 36, ["Asia", "US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("eva", "EVA Air", "planned", 36, ["Asia", "US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("china_airlines", "China Airlines", "planned", 36, ["Asia", "US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("air_india", "Air India", "planned", 35, ["Asia", "EU"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("indigo", "IndiGo", "planned", 35, ["Asia", "ME"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("qantas", "Qantas", "planned", 34, ["Oceania", "Asia", "US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("virgin_australia", "Virgin Australia", "planned", 34, ["Oceania"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("air_new_zealand", "Air New Zealand", "planned", 34, ["Oceania", "US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("virgin_atlantic", "Virgin Atlantic", "planned", 34, ["EU", "US"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("air_serbia", "Air Serbia", "planned", 33, ["EU"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("croatia", "Croatia Airlines", "planned", 33, ["EU"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("tarom", "TAROM", "planned", 33, ["EU"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("bulgaria_air", "Bulgaria Air", "planned", 33, ["EU"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("georgian", "Georgian Airways", "planned", 33, ["EU", "Asia"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("azerbaijan", "Azerbaijan Airlines", "planned", 33, ["Asia", "EU"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("uzbekistan", "Uzbekistan Airways", "planned", 33, ["Asia", "EU"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("air_astana", "Air Astana", "planned", 33, ["Asia", "EU"], "מתוכנן כקישור/אדפטר עתידי."),
  entry("ukraine_international", "Ukraine International Airlines", "blocked", 10, ["EU"], "מקור חסום עד שתהיה זמינות מסחרית/תפעולית ברורה."),
  entry("smartwings", "Smartwings", "planned", 32, ["EU"], "מתוכנן כקישור/אדפטר עתידי."),
]);

export function sourceRegistry(): SourceRegistryEntry[] {
  return SOURCE_REGISTRY.map(copy);
}

export function sourceRegistryForRoute(req: Pick<SearchRequest, "origin" | "destination">, resolver: Pick<Resolver, "countryOfAirport">): SourceRegistryEntry[] {
  const tokens = new Set(routeTokens(req, resolver));
  return SOURCE_REGISTRY.map((source) => {
    const copied = copy(source);
    const matched = source.markets.filter((market) => market === "global" || tokens.has(market));
    copied.routeRelevant = matched.length > 0;
    copied.routeReasonHe = copied.routeRelevant ? (matched.includes("global") ? "מקור גלובלי שמתאים לכל מסלול" : "השוק של המקור מתאים למוצא או ליעד") : null;
    return copied;
  });
}

