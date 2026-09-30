/**
 * A one-time note for the search page after another screen (explore) filled the search. Kept in sessionStorage, so it
 * never travels in a URL and disappears with the tab. Every access is guarded: storage may be unavailable.
 */
const KEY = "eee.prefillNotice.v1";

export function setPrefillNotice(text: string): void {
  try { sessionStorage.setItem(KEY, text.slice(0, 200)); } catch { /* optional */ }
}

/** Read without removing (safe in a state initializer, which StrictMode runs twice); clear it from an effect. */
export function peekPrefillNotice(): string | null {
  try {
    const text = sessionStorage.getItem(KEY);
    return text && text.trim() ? text : null;
  } catch { return null; }
}

export function clearPrefillNotice(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* optional */ }
}
