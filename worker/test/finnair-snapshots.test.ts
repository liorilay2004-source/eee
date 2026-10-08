import { describe, it, expect, vi } from "vitest";
import { saveFinnairSnapshots, readFinnairSnapshot } from "../src/finnair-snapshots";
import { createFinnairCachedSource } from "../src/sources/finnair-cached";
import { parseFinnairFares } from "../src/finnair-fares";
import { createTestD1 } from "./helpers/d1";

const now = new Date("2026-10-08T00:00:00Z");
const fares = parseFinnairFares('<script id="fcom-ux-state">' + JSON.stringify([
  {from:"HEL",to:"RIX",fromDate:"2027-06-01",toDate:"2027-06-05",currency:"EUR",travelClassPrices:[{price:96,travelClass:"Economy"}]},
  {from:"HEL",to:"RIX",fromDate:"2027-07-01",toDate:"2027-07-05",currency:"EUR",travelClassPrices:[{price:100,travelClass:"Economy"}]},
  {from:"HEL",to:"ATH",fromDate:"2027-06-01",toDate:"2027-06-05",currency:"EUR",travelClassPrices:[{price:200,travelClass:"Economy"}]},
]) + '</script>', now);
const query = {origin:"HEL",destination:"RIX",departDate:"2027-06-01",returnDate:"2027-06-05",party:{adults:1,children:0,infants:0}};
describe("compact durable official prices", () => {
  it("preserves every dated price and uses one record per route and departure month", async () => {
    const db = createTestD1();
    expect(await saveFinnairSnapshots(db, fares, now)).toBe(3);
    expect(await readFinnairSnapshot(db, "RIX", "2027-06", now)).toEqual([fares[2]]); // parser traverses its input backwards
    expect((await db.prepare("SELECT count(*) AS n FROM prices").first<{n:number}>())?.n).toBe(0);
    const prepare = vi.spyOn(db, "prepare");
    const source = createFinnairCachedSource(undefined, db, now);
    expect(await source.quote(query)).toMatchObject([{priceAmount:96,checkedAt:now.toISOString()}]);
    expect(await source.quote({...query,returnDate:"2027-06-06"})).toEqual([]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(source.callCount()).toBe(0);
  });
  it("does not refresh old timestamps or return future, stale or malformed data", async () => {
    const db = createTestD1();
    await saveFinnairSnapshots(db, fares, now);
    expect(await readFinnairSnapshot(db,"RIX","2027-06",new Date(now.getTime()+37*3600000))).toEqual([]);
    expect(await readFinnairSnapshot(db,"RIX","2027-06",new Date(now.getTime()-1))).toEqual([]);
    await db.prepare("UPDATE public_calendar_snapshots SET fares_json=? WHERE destination=? AND month=?")
      .bind(JSON.stringify([{...fares[2],amount:-1},{...fares[2],sourceUrl:"https://example.com/"},{...fares[2],departDate:"2027-06-31"}]),"RIX","2027-06").run();
    expect(await readFinnairSnapshot(db,"RIX","2027-06",now)).toEqual([]);
  });
  it("replaces a monthly snapshot without accumulating append-only history", async () => {
    const db=createTestD1();
    await saveFinnairSnapshots(db,fares,now);
    const later=new Date(now.getTime()+3600000);
    await saveFinnairSnapshots(db,fares.map(f=>({...f,amount:f.amount+1,checkedAt:later.toISOString()})),later);
    expect((await db.prepare("SELECT count(*) AS n FROM public_calendar_snapshots").first<{n:number}>())?.n).toBe(3);
    expect(await readFinnairSnapshot(db,"RIX","2027-06",later)).toMatchObject([{amount:97,checkedAt:later.toISOString()}]);
  });
});
