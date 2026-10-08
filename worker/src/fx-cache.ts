import type { FxRates } from "./types";

type Storage = Pick<Cache, "match" | "put">;
const TTL = 3_600_000;
const request = (now: Date, variant: "primary" | "ecb" = "primary") => new Request(`https://eee-api.liorilay2004.workers.dev/__public_fx/${variant === "ecb" ? "ecb/" : ""}v1/${now.toISOString().slice(0,10)}`);

function valid(value: unknown, now: Date): value is FxRates {
  if (!value || typeof value !== "object") return false;
  const fx = value as FxRates;
  if (typeof fx.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(fx.date) || !Number.isFinite(Date.parse(fx.date)) ||
      new Date(fx.date).toISOString().slice(0,10) !== fx.date || typeof fx.source !== "string" || fx.source.length > 64 ||
      !fx.ratesToIls || typeof fx.ratesToIls !== "object" || Array.isArray(fx.ratesToIls)) return false;
  const ageDays = (Date.parse(now.toISOString().slice(0,10)) - Date.parse(fx.date)) / 86_400_000;
  if (ageDays < 0 || ageDays > 7 || ageDays > 0 && !fx.source.endsWith(":stale")) return false;
  const entries = Object.entries(fx.ratesToIls);
  return entries.length <= 64 && fx.ratesToIls.ILS === 1 && typeof fx.ratesToIls.USD === "number" &&
    entries.every(([code, rate]) => /^[A-Z]{3}$/.test(code) && typeof rate === "number" && Number.isFinite(rate) && rate > 0);
}

/** Public conversion rates only: no prices, passenger data or credentials. */
export async function readFxCache(storage: Storage | undefined, now: Date, variant: "primary" | "ecb" = "primary"): Promise<FxRates | null> {
  if (!storage) return null;
  try {
    const response = await storage.match(request(now,variant));
    if (!response) return null;
    const text = await response.text();
    if (text.length > 20_000) return null;
    const data = JSON.parse(text) as {storedAt:unknown;expires:unknown;fx:unknown};
    if (typeof data.storedAt !== "number" || !Number.isFinite(data.storedAt) || data.storedAt > now.getTime() ||
        typeof data.expires !== "number" || !Number.isFinite(data.expires) || data.expires <= now.getTime() ||
        data.expires > data.storedAt + TTL || !valid(data.fx, now)) return null;
    return data.fx;
  } catch { return null; }
}

export async function writeFxCache(storage: Storage | undefined, now: Date, fx: FxRates, variant: "primary" | "ecb" = "primary"): Promise<void> {
  if (!storage || !valid(fx, now)) return;
  try {
    await storage.put(request(now,variant), Response.json({storedAt:now.getTime(),expires:now.getTime()+TTL,fx}, {
      headers:{"cache-control":"public, max-age=3600"},
    }));
  } catch { /* Optional cache cannot fail a fare search. */ }
}
