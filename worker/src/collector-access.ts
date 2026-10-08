import {keyMatches} from "./access";
import type {Env} from "./types";

/** Machine-only authorization, before body reads or storage access. No credentials in URLs. */
export async function collectorAccessStatus(request:Request,env:Pick<Env,"COLLECTOR_KEY"|"LOCAL_COLLECTOR_KEY">):Promise<401|503|null>{
 const keys=[env.COLLECTOR_KEY,env.LOCAL_COLLECTOR_KEY].filter((key):key is string=>typeof key==="string"&&/^[a-f0-9]{64}$/.test(key));
 if(!keys.length)return 503;
 const given=/^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("Authorization")??"")?.[1];
 return given&&(await Promise.all(keys.map(key=>keyMatches(given,key)))).some(Boolean)?null:401;
}
