import { useCallback, useEffect, useState } from "react";

/** True until `retryAt` (ms) has passed; re-renders once when it does. */
export function useWaiting(retryAt: number | null): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt === null || retryAt <= Date.now()) return;
    const timer = window.setTimeout(() => setNow(Date.now()), retryAt - Date.now() + 50);
    return () => window.clearTimeout(timer);
  }, [retryAt]);
  return retryAt !== null && now < retryAt;
}

/** Clears then sets the live region text, so the same sentence is announced again. */
export function useAnnouncer(): [string, (text: string) => void] {
  const [text, setText] = useState("");
  const announce = useCallback((next: string) => {
    setText("");
    window.setTimeout(() => setText(next), 60);
  }, []);
  return [text, announce];
}

/** Tracks navigator.onLine. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  return online;
}
