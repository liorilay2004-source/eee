/**
 * IATA airline code -> Hebrew display name (WEB_APP_SPEC §7.2 `airlineNames`, §7.7 gap 7). Cards print names, not codes.
 *
 * Coverage: the carriers that fly to or from TLV / ETM, the low-cost groups' sister codes (a Wizz Air or easyJet fare can come
 * back under any of their AOC codes), and the carriers most often met on connections from Israel. A code missing here is
 * simply left out of `airlineNames` (the UI then shows the code): a name is never guessed. Only codes whose owner is certain
 * are listed; add new ones here (a test pins that every code in the fixtures and the bag-fee table has a name).
 * The English name is kept beside it for maintenance and for the tests; the API returns the Hebrew one.
 */
import type { Offer } from "./types";

export const AIRLINES: Readonly<Record<string, { he: string; en: string }>> = {
  // Israel
  LY: { he: "אל על", en: "El Al" },
  IZ: { he: "ארקיע", en: "Arkia" },
  "6H": { he: "ישראייר", en: "Israir" },
  // Low-cost groups (every AOC code of the group)
  W6: { he: "וויז אייר", en: "Wizz Air" },
  W4: { he: "וויז אייר", en: "Wizz Air Malta" },
  W9: { he: "וויז אייר", en: "Wizz Air UK" },
  "5W": { he: "וויז אייר", en: "Wizz Air Abu Dhabi" },
  U2: { he: "איזיג'ט", en: "easyJet" },
  EC: { he: "איזיג'ט", en: "easyJet Europe" },
  DS: { he: "איזיג'ט", en: "easyJet Switzerland" },
  FR: { he: "ריינאייר", en: "Ryanair" },
  RK: { he: "ריינאייר", en: "Ryanair UK" },
  AL: { he: "ריינאייר", en: "Malta Air" },
  VY: { he: "וואלינג", en: "Vueling" },
  HV: { he: "טרנסאוויה", en: "Transavia" },
  TO: { he: "טרנסאוויה", en: "Transavia France" },
  PC: { he: "פגסוס", en: "Pegasus Airlines" },
  EW: { he: "יורווינגס", en: "Eurowings" },
  LS: { he: "ג'ט 2", en: "Jet2" },
  V7: { he: "וולוטאה", en: "Volotea" },
  DY: { he: "נורוויג'יאן", en: "Norwegian" },
  D8: { he: "נורוויג'יאן", en: "Norwegian Air International" },
  FZ: { he: "פליידובאי", en: "flydubai" },
  G9: { he: "אייר ערביה", en: "Air Arabia" },
  "3O": { he: "אייר ערביה", en: "Air Arabia Maroc" },
  "5F": { he: "פליי וואן", en: "FlyOne" },
  XZ: { he: "אירואיטליה", en: "Aeroitalia" },
  QS: { he: "סמארטווינגס", en: "Smartwings" },
  // Europe
  A3: { he: "אגאן", en: "Aegean Airlines" },
  OA: { he: "אולימפיק אייר", en: "Olympic Air" },
  GQ: { he: "סקיי אקספרס", en: "Sky Express" },
  BZ: { he: "בלו בירד", en: "Blue Bird Airways" },
  CY: { he: "קפריסין איירווייז", en: "Cyprus Airways" },
  U8: { he: "טוס איירווייז", en: "TUS Airways" },
  AZ: { he: "איטה איירווייז", en: "ITA Airways" },
  NO: { he: "נאוס", en: "Neos" },
  AF: { he: "אייר פראנס", en: "Air France" },
  KL: { he: "KLM", en: "KLM" },
  LH: { he: "לופטהנזה", en: "Lufthansa" },
  LX: { he: "סוויס", en: "Swiss" },
  OS: { he: "אוסטריאן איירליינס", en: "Austrian Airlines" },
  SN: { he: "בריסל איירליינס", en: "Brussels Airlines" },
  "4Y": { he: "דיסקאבר איירליינס", en: "Discover Airlines" },
  DE: { he: "קונדור", en: "Condor" },
  DI: { he: "מרבו", en: "Marabu Airlines" },
  X3: { he: "TUI fly", en: "TUI fly Deutschland" },
  BY: { he: "TUI", en: "TUI Airways" },
  OR: { he: "TUI fly", en: "TUI fly Netherlands" },
  TB: { he: "TUI fly", en: "TUI fly Belgium" },
  XQ: { he: "סאן אקספרס", en: "SunExpress" },
  BA: { he: "בריטיש איירווייז", en: "British Airways" },
  VS: { he: "וירג'ין אטלנטיק", en: "Virgin Atlantic" },
  IB: { he: "איבריה", en: "Iberia" },
  I2: { he: "איבריה אקספרס", en: "Iberia Express" },
  UX: { he: "אייר אירופה", en: "Air Europa" },
  TP: { he: "TAP פורטוגל", en: "TAP Air Portugal" },
  LO: { he: "LOT", en: "LOT Polish Airlines" },
  OK: { he: "צ'כיה איירליינס", en: "Czech Airlines" },
  RO: { he: "טרום", en: "TAROM" },
  FB: { he: "בולגריה אייר", en: "Bulgaria Air" },
  JU: { he: "אייר סרביה", en: "Air Serbia" },
  BT: { he: "אייר בלטיק", en: "airBaltic" },
  AY: { he: "פינאייר", en: "Finnair" },
  SK: { he: "SAS", en: "SAS" },
  KM: { he: "KM מלטה איירליינס", en: "KM Malta Airlines" },
  "6Y": { he: "סמארטלינקס", en: "SmartLynx Airlines" },
  // Former USSR / Caucasus / Central Asia
  PS: { he: "אוקראינה אינטרנשיונל", en: "Ukraine International Airlines" },
  SU: { he: "אירופלוט", en: "Aeroflot" },
  S7: { he: "S7", en: "S7 Airlines" },
  U6: { he: "אוראל איירליינס", en: "Ural Airlines" },
  B2: { he: "בלאוויה", en: "Belavia" },
  A9: { he: "ג'ורג'יאן איירווייז", en: "Georgian Airways" },
  J2: { he: "אזרבייג'ן איירליינס", en: "Azerbaijan Airlines" },
  KC: { he: "אייר אסטנה", en: "Air Astana" },
  HY: { he: "אוזבקיסטן איירווייז", en: "Uzbekistan Airways" },
  // Middle East / Africa
  TK: { he: "טורקיש איירליינס", en: "Turkish Airlines" },
  RJ: { he: "רויאל ג'ורדניאן", en: "Royal Jordanian" },
  MS: { he: "איג'יפט אייר", en: "EgyptAir" },
  SM: { he: "אייר קהיר", en: "Air Cairo" },
  EK: { he: "אמירייטס", en: "Emirates" },
  EY: { he: "איתיחאד", en: "Etihad Airways" },
  GF: { he: "גולף אייר", en: "Gulf Air" },
  ET: { he: "אתיופיאן איירליינס", en: "Ethiopian Airlines" },
  AT: { he: "רויאל אייר מרוק", en: "Royal Air Maroc" },
  HM: { he: "אייר סיישל", en: "Air Seychelles" },
  // Americas / Asia (long haul and connections)
  UA: { he: "יונייטד איירליינס", en: "United Airlines" },
  DL: { he: "דלתא", en: "Delta Air Lines" },
  AA: { he: "אמריקן איירליינס", en: "American Airlines" },
  AC: { he: "אייר קנדה", en: "Air Canada" },
  AI: { he: "אייר אינדיה", en: "Air India" },
  HU: { he: "היינאן איירליינס", en: "Hainan Airlines" },
  CA: { he: "אייר צ'יינה", en: "Air China" },
  KE: { he: "קוריאן אייר", en: "Korean Air" },
  TG: { he: "תאי איירווייז", en: "Thai Airways" },
  VN: { he: "וייטנאם איירליינס", en: "Vietnam Airlines" },
  SQ: { he: "סינגפור איירליינס", en: "Singapore Airlines" },
  CX: { he: "קאתיי פסיפיק", en: "Cathay Pacific" },
  QR: { he: "קטאר איירווייז", en: "Qatar Airways" },
};

/** Hebrew name of one code, or null when the code is not in the table (never guessed). */
export function airlineNameHe(code: string): string | null {
  const key = typeof code === "string" ? code.trim().toUpperCase() : "";
  return Object.hasOwn(AIRLINES, key) ? AIRLINES[key]!.he : null;
}

/**
 * The `airlineNames` of one card: every carrier code on either leg of its offer that the table knows, keyed by the code exactly
 * as it appears in `offer.outbound.airlines` / `offer.inbound.airlines`. Unknown codes are absent, so the object can be empty.
 */
export function airlineNamesFor(offer: Pick<Offer, "outbound" | "inbound">): Record<string, string> {
  const names: Record<string, string> = {};
  for (const code of [...(offer.outbound?.airlines ?? []), ...(offer.inbound?.airlines ?? [])]) {
    if (typeof code !== "string" || Object.hasOwn(names, code)) continue;
    const he = airlineNameHe(code);
    if (he !== null) names[code] = he;
  }
  return names;
}
