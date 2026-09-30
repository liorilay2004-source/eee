/**
 * The app's side of the private-use lock (worker/src/access.ts). Pure where it can be (the gate and the lock screen's form
 * are reducers), so it is unit tested without a browser; components/LockScreen.tsx only wires it to React.
 *
 * Startup: GET /api/auth/check. 204 -> the app. 401 -> the lock screen (a stored key that failed is forgotten). 404 -> an
 * API from before the lock: the app, as before. Network trouble, or no answer within ACCESS_CHECK_TIMEOUT_MS -> the app,
 * whose own screens say the service is unreachable. With a key already stored the app shows at once and the check runs
 * behind it (the owner's common case); without one the check comes first, so a visitor never sees the app flash before
 * the lock screen.
 */
import { checkAccess, type AccessCheck } from "../api/client";
import { clearAccessKey, emitAccessEvent, getAccessKey, isAccessKeyFormat, setAccessKey, type LockReason } from "./access-key";

/** What the lock screen tells the user. */
export type LockMessage =
  | { kind: "empty" }
  | { kind: "wrong_key" }
  /** The key saved on this device was refused (the owner changed it): nothing was typed, so "wrong" would be misleading. */
  | { kind: "stale_key" }
  | { kind: "too_many_attempts"; retryAfterSec: number | null }
  | { kind: "misconfigured"; reason: string | null }
  | { kind: "network" }
  | { kind: "error" };

/**
 * `generation` changes only when the pages must start over while the app stays up: the stored key was dropped because the
 * API turned out to predate the lock, and every request the pages had sent with it failed.
 */
export type GateState = { view: "checking" } | { view: "app"; generation: number } | { view: "locked"; message: LockMessage | null };

export type GateEvent =
  /** droppedKey: the stored key was just forgotten because the API has no lock (see startupCheck). */
  | { type: "checked"; result: AccessCheck; hadKey: boolean; droppedKey?: boolean }
  | { type: "lock"; reason: LockReason }
  | { type: "unlocked" }
  | { type: "recheck" };

export const initialGate = (keyStored: boolean): GateState => (keyStored ? { view: "app", generation: 0 } : { view: "checking" });

/** undefined = nothing stops the app; otherwise the lock screen, with this message (null = none, just the screen). */
function lockOf(result: AccessCheck, hadKey: boolean): LockMessage | null | undefined {
  switch (result.kind) {
    case "open":
    case "no_lock":
    case "network":
    case "error":
      return undefined;
    case "unauthorized":
      return hadKey ? { kind: "stale_key" } : null;
    case "too_many_attempts":
      return { kind: "too_many_attempts", retryAfterSec: result.retryAfterSec };
    case "misconfigured":
      return { kind: "misconfigured", reason: result.reason };
  }
}

function lockFromReason(reason: LockReason): LockMessage | null {
  switch (reason.kind) {
    case "unauthorized":
      return reason.hadKey ? { kind: "stale_key" } : null;
    case "too_many_attempts":
      return { kind: "too_many_attempts", retryAfterSec: reason.retryAfterSec };
    case "misconfigured":
      return { kind: "misconfigured", reason: reason.reason };
  }
}

export function gateReducer(state: GateState, event: GateEvent): GateState {
  switch (event.type) {
    case "checked": {
      // A lock screen already up (an API call met the lock meanwhile) stays: it owns its messages from here on.
      if (state.view === "locked") return state;
      const message = lockOf(event.result, event.hadKey);
      if (message !== undefined) return { view: "locked", message };
      if (state.view !== "app") return { view: "app", generation: 0 };
      // Already showing: start the pages over only when their requests carried a key that has just been dropped.
      return event.droppedKey ? { view: "app", generation: state.generation + 1 } : state;
    }
    case "lock":
      return state.view === "locked" ? state : { view: "locked", message: lockFromReason(event.reason) };
    case "unlocked":
      return { view: "app", generation: 0 };
    case "recheck":
      return { view: "checking" };
  }
}

/** Errors about what was typed in the field: only these mark it invalid (aria-invalid and the red border). */
export const isFieldError = (message: LockMessage | null): boolean => message?.kind === "empty" || message?.kind === "wrong_key";

/**
 * What the lock screen offers. "retry" when typing a key cannot help: the server's key is misconfigured (any key is refused
 * until the owner fixes it), or the key stored here is fine but this address must wait (too many failed attempts from it).
 * Then a "נסו שוב" button checks again with what is stored. Otherwise the key field.
 */
export function lockScreenMode(message: LockMessage | null, keyStored: boolean): "form" | "retry" {
  if (message?.kind === "misconfigured") return "retry";
  if (message?.kind === "too_many_attempts" && keyStored) return "retry";
  return "form";
}

/**
 * The lock screen's form. `attempt` keys the alert, so the same sentence twice is still a new alert that is announced.
 * `retryAt` (ms): when the wait the server named is over (too many attempts), else null.
 */
export interface LockFormState {
  busy: boolean;
  message: LockMessage | null;
  attempt: number;
  retryAt: number | null;
}

/** `at`: when the answer came (Date.now() in the event handler, so rendering stays pure). */
export type LockFormEvent = { type: "submit" } | { type: "failed"; message: LockMessage; at: number };

const retryAtOf = (message: LockMessage | null, at: number): number | null =>
  message?.kind === "too_many_attempts" && message.retryAfterSec !== null && message.retryAfterSec > 0 ? at + message.retryAfterSec * 1000 : null;

export const initialLockForm = (message: LockMessage | null, at = Date.now()): LockFormState =>
  ({ busy: false, message, attempt: 0, retryAt: retryAtOf(message, at) });

export function lockFormReducer(state: LockFormState, event: LockFormEvent): LockFormState {
  switch (event.type) {
    case "submit":
      // The old message goes while the key is checked, so the answer, even an identical one, arrives as a new alert.
      return { busy: true, message: null, attempt: state.attempt + 1, retryAt: null };
    case "failed":
      return { busy: false, message: event.message, attempt: state.attempt, retryAt: retryAtOf(event.message, event.at) };
  }
}

/** The lock screen's sentence for a message (Hebrew). */
export function lockMessageText(message: LockMessage): string {
  switch (message.kind) {
    case "empty":
      return "הזינו את המפתח";
    case "wrong_key":
      return "המפתח שגוי";
    case "stale_key":
      return "המפתח שנשמר במכשיר הזה כבר לא תקף. הזינו את המפתח העדכני.";
    case "too_many_attempts": {
      const sec = message.retryAfterSec;
      if (sec === null || !Number.isFinite(sec) || sec <= 0) return "יותר מדי ניסיונות, נסו שוב בעוד כמה דקות";
      const minutes = Math.max(1, Math.ceil(sec / 60));
      return minutes === 1 ? "יותר מדי ניסיונות, נסו שוב בעוד דקה" : `יותר מדי ניסיונות, נסו שוב בעוד ${minutes} דקות`;
    }
    case "misconfigured":
      return message.reason === null || message.reason === "too_short"
        ? "האתר לא מוגדר נכון (המפתח קצר מדי)"
        : "האתר לא מוגדר נכון (המפתח לא תקין)";
    case "network":
      return "לא הצלחנו להתחבר לשירות. בדקו את החיבור ונסו שוב.";
    case "error":
      return "משהו השתבש. נסו שוב בעוד רגע.";
  }
}

/**
 * The startup check, with the stored key if there is one. A key the API refuses is forgotten. One more case: an API from
 * before the lock does not allow the Authorization header in its CORS preflight, which the browser reports as a network
 * error; if a check WITHOUT the key then finds no lock (404), the stored key can only break things, so it is forgotten too,
 * and the event says so (droppedKey), because the pages shown meanwhile sent it and failed: the gate starts them over.
 * null = the key changed while the check was out (the user logged in or out): the answer is about the old key, so it is
 * dropped rather than allowed to lock or unlock anything.
 */
export async function startupCheck(signal?: AbortSignal): Promise<GateEvent | null> {
  const key = getAccessKey();
  const result = await checkAccess(key, signal);
  if (getAccessKey() !== key) return null;
  if (key !== null && result.kind === "network") {
    const probe = await checkAccess(null, signal);
    if (getAccessKey() !== key) return null;
    if (probe.kind === "no_lock") {
      clearAccessKey();
      return { type: "checked", result: probe, hadKey: true, droppedKey: true };
    }
  }
  if (key !== null && result.kind === "unauthorized") clearAccessKey();
  return { type: "checked", result, hadKey: key !== null };
}

export type SubmitOutcome = { unlocked: true } | { unlocked: false; message: LockMessage };

/** The lock screen's "כניסה": checks the typed key with the API and keeps it on this device only when it works. */
export async function submitKey(input: string, signal?: AbortSignal): Promise<SubmitOutcome> {
  const key = input.trim(); // a paste often brings a newline or spaces along
  if (key === "") return { unlocked: false, message: { kind: "empty" } };
  // Too short or too long, spaces inside, Hebrew letters: never the key (and some could not even be sent). Not worth a
  // request, and above all not worth one of the few failed attempts the Worker allows this address.
  if (!isAccessKeyFormat(key)) return { unlocked: false, message: { kind: "wrong_key" } };
  const result = await checkAccess(key, signal);
  switch (result.kind) {
    case "open":
      setAccessKey(key);
      return { unlocked: true };
    case "no_lock":
      return { unlocked: true }; // nothing to unlock, and sending the header to that API would break its CORS
    case "unauthorized":
      return { unlocked: false, message: { kind: "wrong_key" } };
    case "too_many_attempts":
      return { unlocked: false, message: { kind: "too_many_attempts", retryAfterSec: result.retryAfterSec } };
    case "misconfigured":
      return { unlocked: false, message: { kind: "misconfigured", reason: result.reason } };
    case "network":
      return { unlocked: false, message: { kind: "network" } };
    case "error":
      return { unlocked: false, message: { kind: "error" } };
  }
}

/** The footer's "יציאה": forgets the key on this device, then the gate checks again (the lock screen, if the site is locked). */
export function logout(): void {
  clearAccessKey();
  emitAccessEvent({ type: "recheck" });
}
