import type {BrusselsAdvertisement,LhgAdvertisement} from "./brussels-advertisements";
export type LhgSnapshotSource="lufthansa"|"brussels_airlines"|"swiss";
const route=(source:LhgSnapshotSource)=>source==="swiss"?{origin:"ZRH",destination:"TLV"}:source==="lufthansa"?{origin:"ATH",destination:"TLV"}:{origin:"BRU",destination:"ATH"};
const MAX_BYTES=100_000;
/** One current row per month, rather than indexed price history for every advertisement. */
export async function saveLhgSnapshots(db:D1Database,source:LhgSnapshotSource,fares:readonly LhgAdvertisement<"EUR"|"CHF">[],now:Date):Promise<number> {
 const expected=route(source);const groups=new Map<string,LhgAdvertisement<"EUR"|"CHF">[]>();
 if(fares.length>500)throw new Error("Too many LHG advertisements");
 for(const fare of fares){
  if(fare.origin!==expected.origin||fare.destination!==expected.destination||fare.checkedAt!==now.toISOString())throw new Error("Unexpected snapshot route or timestamp");
  if(fare.currency!==(source==="swiss"?"CHF":"EUR"))throw new Error("Unexpected snapshot currency");
  const month=fare.departDate.slice(0,7);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw new Error("Invalid snapshot month");
  const group=groups.get(month)??[];group.push(fare);groups.set(month,group);
 }
 const statements:D1PreparedStatement[]=[];
 for(const [month,group] of groups){
  const json=JSON.stringify(group);if(new TextEncoder().encode(json).byteLength>MAX_BYTES)throw new Error("LHG snapshot too large");
  statements.push(db.prepare("INSERT INTO public_calendar_snapshots (source,origin,destination,month,fares_json,checked_at) VALUES (?,?,?,?,?,?) ON CONFLICT(source,origin,destination,month) DO UPDATE SET fares_json=excluded.fares_json,checked_at=excluded.checked_at")
   .bind(source,expected.origin,expected.destination,month,json,now.toISOString()));
 }
 for(let i=0;i<statements.length;i+=50)await db.batch(statements.slice(i,i+50));
 return statements.length;
}
/** Caller validates every advertisement's dates, currency, amount and official link before use. */
export function readLhgSnapshot(db:D1Database,source:"swiss",month:string,now:Date):Promise<LhgAdvertisement<"CHF">[]>;
export function readLhgSnapshot(db:D1Database,source:"lufthansa"|"brussels_airlines",month:string,now:Date):Promise<BrusselsAdvertisement[]>;
export async function readLhgSnapshot(db:D1Database,source:LhgSnapshotSource,month:string,now:Date):Promise<LhgAdvertisement<"EUR"|"CHF">[]> {
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return [];
 const expected=route(source);
 const row=await db.prepare("SELECT fares_json,checked_at FROM public_calendar_snapshots WHERE source=? AND origin=? AND destination=? AND month=?")
  .bind(source,expected.origin,expected.destination,month).first<{fares_json:string;checked_at:string}>();
 if(!row||typeof row.fares_json!=="string"||new TextEncoder().encode(row.fares_json).byteLength>MAX_BYTES)return [];
 const age=now.getTime()-Date.parse(row.checked_at);if(!Number.isFinite(age)||age<0||age>36*3600000)return [];
 let parsed:unknown;try{parsed=JSON.parse(row.fares_json);}catch{return [];}
 if(!Array.isArray(parsed)||parsed.length>500)return [];
 return parsed.filter((f):f is LhgAdvertisement<"EUR"|"CHF">=>f&&typeof f==="object"&&f.currency===(source==="swiss"?"CHF":"EUR")&&f.origin===expected.origin&&f.destination===expected.destination&&typeof f.departDate==="string"&&f.departDate.startsWith(month+"-")&&f.checkedAt===row.checked_at);
}
