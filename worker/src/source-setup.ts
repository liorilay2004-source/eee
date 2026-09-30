import type { Env, SourceSetupResponse, SourceSetupStatus } from "./types";

interface ConnectorDef {
  id: string;
  name: string;
  kind: SourceSetupStatus["kind"];
  requiredSecrets: string[];
  officialUrl: string;
  noteHe: string;
}

const CONNECTORS: readonly ConnectorDef[] = Object.freeze([
  { id: "duffel", name: "Duffel", kind: "multi-airline", requiredSecrets: ["DUFFEL_API_TOKEN"], officialUrl: "https://duffel.com/docs/api/offers/get-offers", noteHe: "מועמד חזק לחיפוש הצעות ממספר חברות דרך API אחד." },
  { id: "amadeus", name: "Amadeus", kind: "multi-airline", requiredSecrets: ["AMADEUS_CLIENT_ID", "AMADEUS_CLIENT_SECRET"], officialUrl: "https://developers.amadeus.com/self-service/category/flights/api-doc/flight-offers-search", noteHe: "מועמד חזק ל-Flight Offers Search ו-Price דרך חיבור אחד." },
  { id: "travelport", name: "Travelport", kind: "multi-airline", requiredSecrets: ["TRAVELPORT_CLIENT_ID", "TRAVELPORT_CLIENT_SECRET"], officialUrl: "https://developer.travelport.com/docs/flights", noteHe: "GDS/API רחב, דורש provisioning מסחרי." },
  { id: "sabre", name: "Sabre", kind: "multi-airline", requiredSecrets: ["SABRE_CLIENT_ID", "SABRE_CLIENT_SECRET"], officialUrl: "https://developer.sabre.com/", noteHe: "GDS/Offers and Orders, דורש provisioning." },
  { id: "lufthansa_group", name: "Lufthansa Group", kind: "direct-airline", requiredSecrets: ["LUFTHANSA_CLIENT_ID", "LUFTHANSA_CLIENT_SECRET"], officialUrl: "https://developer.lufthansa.com/Fares_Availability", noteHe: "מכסה Lufthansa, SWISS, Austrian, Eurowings אחרי אישור שימוש." },
  { id: "turkish", name: "Turkish Airlines", kind: "direct-airline", requiredSecrets: ["TURKISH_API_KEY"], officialUrl: "https://developer.apim.turkishairlines.com/", noteHe: "Get Availability / Timetable. ההרשמה כוללת OTP ואישור אפליקציה." },
  { id: "airfrance_klm", name: "Air France-KLM", kind: "direct-airline", requiredSecrets: ["AFKL_API_KEY"], officialUrl: "https://klmprod.mashery.com/Home", noteHe: "NDC/API ל-Air France ו-KLM אחרי הרשמה ואישור." },
  { id: "british_airways", name: "British Airways / IAG", kind: "direct-airline", requiredSecrets: ["BA_NDC_CLIENT_ID", "BA_NDC_CLIENT_SECRET"], officialUrl: "https://ndc.ba.com/", noteHe: "NDC של BA/IAG, דורש onboarding." },
  { id: "emirates", name: "Emirates Gateway", kind: "direct-airline", requiredSecrets: ["EMIRATES_NDC_CLIENT_ID", "EMIRATES_NDC_CLIENT_SECRET"], officialUrl: "https://www.emirates.com/media-centre/emirates-advances-its-distribution-capabilities-with-launch-of-new-ndc-powered-gateway-for-trade-partners/", noteHe: "NDC לשותפי סחר מאושרים." },
  { id: "qatar", name: "Qatar Oryx Connect", kind: "direct-airline", requiredSecrets: ["QATAR_NDC_CLIENT_ID", "QATAR_NDC_CLIENT_SECRET"], officialUrl: "https://www.qatarairways.com/tradeportal/en-gb/QR-NDC/NDC-Onboarding-steps.html", noteHe: "Oryx Direct API לשותפים מאושרים." },
  { id: "easyjet", name: "easyJet Direct API", kind: "direct-airline", requiredSecrets: ["EASYJET_API_KEY"], officialUrl: "https://www.easyjet.com/tr/business/distribution-charter", noteHe: "קיים רק דרך Direct API Agreement או ערוץ מאושר." },
  { id: "ryanair", name: "Ryanair approved access", kind: "direct-airline", requiredSecrets: ["RYANAIR_API_KEY"], officialUrl: "https://investor.ryanair.com/", noteHe: "גישה לנתונים רק דרך הסכמי הפצה/ערוצים מאושרים." },
]);

function hasSecret(env: Env, name: string): boolean {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() !== "";
}

export function sourceSetup(env: Env, generatedAt: Date = new Date()): SourceSetupResponse {
  const connectors = CONNECTORS.map((c): SourceSetupStatus => {
    const missingSecrets = c.requiredSecrets.filter((name) => !hasSecret(env, name));
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      status: missingSecrets.length === 0 ? "configured" : "missing_credentials",
      requiredSecrets: c.requiredSecrets,
      missingSecrets,
      officialUrl: c.officialUrl,
      noteHe: c.noteHe,
    };
  });
  return {
    connectors,
    summary: {
      total: connectors.length,
      configured: connectors.filter((c) => c.status === "configured").length,
      missingCredentials: connectors.filter((c) => c.status === "missing_credentials").length,
    },
    generatedAt: generatedAt.toISOString(),
  };
}
