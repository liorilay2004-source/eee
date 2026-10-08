import {DurableObject} from "cloudflare:workers";
import {cacheRequest,publicFareMaximumAge} from "./public-fare-cache";
/** One bounded snapshot per official page/calendar. No search logs, credentials or passengers. */
export class FareStore extends DurableObject<Record<string,unknown>> {
 constructor(ctx:DurableObjectState,env:Record<string,unknown>){
  super(ctx,env);
  ctx.blockConcurrencyWhile(async()=>{
   ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK(id=1), source_key TEXT NOT NULL, payload TEXT NOT NULL, stored_at INTEGER NOT NULL, expires INTEGER NOT NULL)");
  });
 }
 async read(key:string):Promise<string|null>{
  cacheRequest(key);
  const rows=this.ctx.storage.sql.exec<{payload:string}>("SELECT payload FROM snapshot WHERE id=1 AND source_key=? AND expires>?",key,Date.now()).toArray();
  return rows[0]?.payload??null;
 }
 async write(key:string,payload:string):Promise<void>{
  cacheRequest(key);
  if(typeof payload!=="string"||new TextEncoder().encode(payload).byteLength>500000)throw new Error("Invalid public fare snapshot");
  const data=JSON.parse(payload),now=Date.now();
  if(!Number.isFinite(data.storedAt)||data.storedAt>now||!Number.isFinite(data.expires)||data.expires<=now||data.expires>data.storedAt+publicFareMaximumAge(key)||!Array.isArray(data.fares)||data.fares.length>500)throw new Error("Invalid public fare lifetime");
  const previous=this.ctx.storage.sql.exec<{stored_at:number}>("SELECT stored_at FROM snapshot WHERE id=1").toArray()[0];
  if(previous&&previous.stored_at>data.storedAt)return;
  this.ctx.storage.sql.exec("INSERT INTO snapshot (id,source_key,payload,stored_at,expires) VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_key=excluded.source_key,payload=excluded.payload,stored_at=excluded.stored_at,expires=excluded.expires",key,payload,data.storedAt,data.expires);
 }
}
