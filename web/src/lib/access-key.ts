/**
 * The private-use lock's key on this device (the Worker checks it: worker/src/access.ts).
 *
 * Kept in localStorage under "eee.accessKey", or, where storage is blocked or full (private mode, blocked site data), only
 * in memory for this page. It is only ever sent in the Authorization header of API calls (api/client.ts): never in a URL,
 * never logged, and the service worker never sees it stored (public/sw.js does not touch API requests).
 *
 * Also the small event bus between the API client and the app's gate (components/LockScreen.tsx): any API call that meets
 * the lock says so here, and the gate shows the lock screen. No imports, so client.ts can use it without a cycle.
 */
export const ACCESS_KEY_STORAGE = "eee.accessKey";
/**
 * The Worker's limits (worker/src/access.ts): a shorter configured key makes the whole API refuse (misconfigured), a longer
 * one could never be configured. So a key outside them can never be right, and is not worth one of the few attempts the
 * Worker allows per address.
 */
export const ACCESS_KEY_MIN_LENGTH = 20;
export const ACCESS_KEY_MAX_LENGTH = 256;

/** Visible ASCII without spaces, like the Worker's rule: anything else could not be the key, or could not travel in a header. */
const KEY_CHARS = /^[\x21-\x7e]+$/;

export const isAccessKeyFormat = (value: unknown): value is string =>
  typeof value === "string" && value.length >= ACCESS_KEY_MIN_LENGTH && value.length <= ACCESS_KEY_MAX_LENGTH && KEY_CHARS.test(value);

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** localStorage, or null where there is none or reading it throws. */
function store(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

let memoryKey: string | null = null;
/** True when the key could not be written to storage: then only the in-memory copy counts (never an older stored one). */
let memoryOnly = false;

export function getAccessKey(): string | null {
  if (!memoryOnly) {
    try {
      const s = store();
      if (s) {
        const value = s.getItem(ACCESS_KEY_STORAGE);
        return isAccessKeyFormat(value) ? value : null;
      }
    } catch {
      /* storage blocked: the in-memory copy below */
    }
  }
  return memoryKey;
}

export const hasAccessKey = (): boolean => getAccessKey() !== null;

export function setAccessKey(key: string): void {
  memoryKey = key;
  memoryOnly = true;
  try {
    const s = store();
    if (s) {
      s.setItem(ACCESS_KEY_STORAGE, key);
      memoryOnly = false;
    }
  } catch {
    // Full or blocked: keep it for this page only, and make sure an older stored key cannot come back.
    try { store()?.removeItem(ACCESS_KEY_STORAGE); } catch { /* nothing kept but memory */ }
  }
  notifyKeyListeners();
}

export function clearAccessKey(): void {
  memoryKey = null;
  memoryOnly = false;
  try { store()?.removeItem(ACCESS_KEY_STORAGE); } catch { /* nothing stored */ }
  notifyKeyListeners();
}

const keyListeners = new Set<() => void>();

function notifyKeyListeners(): void {
  for (const listener of [...keyListeners]) listener();
}

/** For useSyncExternalStore: this page's changes, and another tab's (the storage event). */
export function subscribeAccessKey(listener: () => void): () => void {
  keyListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === ACCESS_KEY_STORAGE) listener();
  };
  const win = typeof window === "undefined" ? null : window;
  win?.addEventListener("storage", onStorage);
  return () => {
    keyListeners.delete(listener);
    win?.removeEventListener("storage", onStorage);
  };
}

// --- lock events -------------------------------------------------------------------------------------------

/** Why an API call met the lock (worker/src/access.ts answers). */
export type LockReason =
  | { kind: "unauthorized"; hadKey: boolean }
  | { kind: "too_many_attempts"; retryAfterSec: number | null }
  | { kind: "misconfigured"; reason: string | null };

export type AccessEvent = { type: "lock"; reason: LockReason } | { type: "recheck" };

const accessListeners = new Set<(event: AccessEvent) => void>();

export function onAccessEvent(listener: (event: AccessEvent) => void): () => void {
  accessListeners.add(listener);
  return () => {
    accessListeners.delete(listener);
  };
}

export function emitAccessEvent(event: AccessEvent): void {
  for (const listener of [...accessListeners]) listener(event);
}
