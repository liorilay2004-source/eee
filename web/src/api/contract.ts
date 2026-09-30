export type {
  CardView,
  Leg,
  Offer,
  RecKind,
  SearchRequest,
  SearchResponse,
  SourceStatus,
} from "../../../worker/src/types";

export interface AirportSuggestion {
  code: string;
  nameHe: string | null;
  nameEn: string | null;
  countryCode: string;
  kind: "city" | "airport";
  airportCode?: string;
  airportNameHe?: string;
  airportNameEn?: string;
  airports: string[];
}

export interface ApiError {
  error?: {
    code?: string;
    message?: string;
    fields?: Record<string, string>;
    retryAfterSec?: number;
  };
}
