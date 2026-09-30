import raw from "./openflights-airlines.json";

export interface OpenFlightsAirline {
  name: string;
  iata: string | null;
  icao: string | null;
  callsign: string | null;
  country: string | null;
  active: boolean;
}

const data = raw as { airlines: OpenFlightsAirline[] };
const byIata = new Map<string, OpenFlightsAirline>();
const byIcao = new Map<string, OpenFlightsAirline>();
const byName = new Map<string, OpenFlightsAirline>();

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

for (const row of data.airlines) {
  if (row.iata && !byIata.has(row.iata)) byIata.set(row.iata, row);
  if (row.icao && !byIcao.has(row.icao)) byIcao.set(row.icao, row);
  byName.set(norm(row.name), row);
}

export function openFlightsCount(): number {
  return data.airlines.length;
}

export function airlineByDesignator(code: string): OpenFlightsAirline | null {
  const upper = code.toUpperCase();
  return (upper.length === 2 ? byIata.get(upper) : upper.length === 3 ? byIcao.get(upper) : undefined) ?? null;
}

function byNamePhrase(phrase: string, fuzzy: boolean): OpenFlightsAirline | null {
  const normalized = norm(phrase);
  if (!normalized) return null;
  const exact = byName.get(normalized);
  if (exact) return exact;
  if (!fuzzy || normalized.length < 4) return null;
  for (const [name, row] of byName) {
    if (name.length >= 4 && (normalized.includes(name) || name.includes(normalized))) return row;
  }
  return null;
}

export function airlineFromTokens(tokens: readonly string[], preferredPhrases: readonly string[] = []): OpenFlightsAirline | null {
  for (const phrase of preferredPhrases) {
    const byPhrase = byNamePhrase(phrase, true);
    if (byPhrase) return byPhrase;
  }
  for (const token of tokens) {
    const byPhrase = byNamePhrase(token, false);
    if (byPhrase) return byPhrase;
  }
  for (const token of tokens) {
    const upper = token.toUpperCase();
    // Lowercase two-letter path pieces such as /il/en/ are usually locale/country codes, not airline designators.
    if (/^[A-Z0-9]{2}$/.test(token) || /^[A-Z0-9]{3}$/.test(token)) {
      const byCode = airlineByDesignator(upper);
      if (byCode) return byCode;
    }
  }
  return null;
}
