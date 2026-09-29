import project from "../../config/project.json";

export const PRODUCT_NAME = project.display_name_he;
export const API_BASE = (import.meta.env.DEV ? "" : import.meta.env.VITE_API_BASE || "https://eee-api.liorilay2004.workers.dev").replace(/\/$/, "");

export const LIMITS = {
  maxWindowDays: 120,
  maxAdvanceDays: 365,
  maxStayNights: 30,
  maxPassengers: 9,
  maxValidPairs: 400,
} as const;
