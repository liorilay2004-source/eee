import {describe, expect, it, vi} from "vitest";
import {readFxCache, writeFxCache} from "../src/fx-cache";
import {getFxRates} from "../src/fx";
import type {FxRates, Repo} from "../src/types";

const now = new Date("2026-10-08T03:00:00Z");
const fx: FxRates = {date:"2026-10-08",source:"bank_of_israel",ratesToIls:{ILS:1,USD:3.1,GBP:4.2}};
function cache() {
  const entries = new Map<string,Response>();
  return {entries,match:vi.fn(async(request:Request)=>entries.get(request.url)?.clone()),
    put:vi.fn(async(request:Request,response:Response)=>{entries.set(request.url,response.clone());})};
}

describe("public exchange-rate cache", () => {
  it("uses the cached rate with zero D1 reads and zero upstream calls", async () => {
    const storage=cache();
    await writeFxCache(storage,now,fx);
    const getFxRatesFromDb=vi.fn(async()=>{throw new Error("D1 unavailable");});
    const repo={getFxRates:getFxRatesFromDb} as unknown as Repo;
    const fetchFn=vi.fn(async()=>{throw new Error("Must not call upstream");}) as unknown as typeof fetch;
    expect(await getFxRates(repo,fetchFn,now,storage)).toEqual(fx);
    expect(getFxRatesFromDb).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await readFxCache(storage,new Date(now.getTime()+3600000))).toBeNull();
    expect(await readFxCache(storage,new Date("2026-10-09T00:00:00Z"))).toBeNull();
  });
  it("rejects future, invalid, stale-unmarked and unbounded cached rates", async () => {
    for(const invalid of [{...fx,date:"2026-10-09"},{...fx,date:"2026-10-07"},{...fx,ratesToIls:{ILS:1,USD:-1}}, {...fx,date:"2026-02-30"}]) {
      const storage=cache();await writeFxCache(storage,now,invalid);
      expect(storage.put).not.toHaveBeenCalled();
    }
    const storage=cache();await writeFxCache(storage,now,fx);
    const key=[...storage.entries.keys()][0]!;
    storage.entries.set(key,Response.json({storedAt:now.getTime(),expires:now.getTime()+7200000,fx}));
    expect(await readFxCache(storage,now)).toBeNull();
    storage.entries.set(key,new Response("x".repeat(20001)));
    expect(await readFxCache(storage,now)).toBeNull();
  });
  it("coalesces concurrent cache misses into one rate load", async () => {
    const storage=cache();
    const getFromDb=vi.fn(async()=>fx);
    const repo={getFxRates:getFromDb} as unknown as Repo;
    const fetchFn=vi.fn() as unknown as typeof fetch;
    const results=await Promise.all(Array.from({length:10},()=>getFxRates(repo,fetchFn,now,storage)));
    expect(results).toHaveLength(10);
    expect(getFromDb).toHaveBeenCalledTimes(1);
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("preserves stale source dates and degrades when optional storage is unavailable", async () => {
    const storage=cache();const stale={...fx,date:"2026-10-07",source:"ecb:stale"};
    await writeFxCache(storage,now,stale);
    expect(await readFxCache(storage,now)).toEqual(stale);
    const broken={match:async()=>{throw new Error("cache unavailable");},put:async()=>{throw new Error("cache unavailable");}};
    expect(await readFxCache(broken,now)).toBeNull();
    await expect(writeFxCache(broken,now,fx)).resolves.toBeUndefined();
  });
});
