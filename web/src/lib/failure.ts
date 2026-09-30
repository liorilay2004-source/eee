/**
 * One shape for "a request did not work", shared by the explore, calendar, deals and alerts screens.
 * Pure: the caller passes whether the device is online, so it is unit tested without a browser.
 */
import { waitText } from "./builder";

export type ApiFailure =
  | { type: "offline" }
  | { type: "network" }
  | { type: "http"; status: number; code: string; retryAfterSec: number | null; fields: Record<string, string> };

/** Any thrown value -> ApiFailure. A RequestError (or anything shaped like one) is an HTTP answer. */
export function toApiFailure(error: unknown, online: boolean): ApiFailure {
  if (typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number") {
    const e = error as { status: number; code?: unknown; retryAfterSec?: unknown; fields?: unknown };
    const retry = typeof e.retryAfterSec === "number" && Number.isFinite(e.retryAfterSec) && e.retryAfterSec > 0 ? Math.ceil(e.retryAfterSec) : null;
    const fields = typeof e.fields === "object" && e.fields !== null ? Object.fromEntries(
      Object.entries(e.fields as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string> : {};
    return { type: "http", status: e.status, code: typeof e.code === "string" ? e.code : "request_failed", retryAfterSec: retry, fields };
  }
  return online ? { type: "network" } : { type: "offline" };
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** A user-facing message for a failed request. `retryAfterSec` only when the server said so. */
export interface FailureNotice {
  title: string;
  body: string;
  retryAfterSec: number | null;
  canRetry: boolean;
}

/** The parts every screen words the same way: offline, network, rate limit, generic server trouble. */
export function commonNotice(failure: ApiFailure): FailureNotice | null {
  if (failure.type === "offline") return { title: "אין חיבור לאינטרנט", body: "כשהחיבור יחזור, נסו שוב.", retryAfterSec: null, canRetry: true };
  if (failure.type === "network") return { title: "לא הצלחנו להתחבר לשירות", body: "בדקו את החיבור ונסו שוב בעוד רגע.", retryAfterSec: null, canRetry: true };
  if (failure.status === 429 || failure.code === "rate_limited") {
    return { title: "יותר מדי בקשות בזמן קצר", body: waitText(failure.retryAfterSec), retryAfterSec: failure.retryAfterSec, canRetry: true };
  }
  return null;
}

export const GENERIC_NOTICE: FailureNotice = { title: "משהו השתבש אצלנו", body: "נסו שוב בעוד רגע.", retryAfterSec: null, canRetry: true };

const HEBREW = /[֐-׿]/;

/** Server messages are English, except a few that are written for the user in Hebrew: only those are shown as is. */
export function hebrewOrNull(text: string | undefined | null): string | null {
  return typeof text === "string" && HEBREW.test(text) ? text : null;
}

/** When a retry becomes possible (ms), from the server's Retry-After; null when it gave none. */
export function retryAtFrom(notice: Pick<FailureNotice, "retryAfterSec">, now = Date.now()): number | null {
  return notice.retryAfterSec !== null ? now + notice.retryAfterSec * 1000 : null;
}
