import {cacheRequest,createPublicFareCache,type PublicFareCache} from "./public-fare-cache";
export interface FareStoreNamespace {
 getByName(name:string):{read(key:string):Promise<string|null>;write(key:string,payload:string):Promise<void>};
}
/** Sharded by validated official page/calendar, with original expiry preserved across regions. */
export function createSharedFareCache(namespace:FareStoreNamespace|undefined,edge:Pick<Cache,"match"|"put">,now:Date,ttlMs?:number):PublicFareCache {
 const local=createPublicFareCache(edge,now,ttlMs);
 if(!namespace)return local;
 const storage={
  async match(request:Request):Promise<Response|undefined>{
   const key=decodeURIComponent(new URL(request.url).pathname.split("/").at(-1)!);
   const body=await namespace.getByName(request.url).read(key);
   return body===null?undefined:new Response(body);
  },
  async put(request:Request,response:Response):Promise<void>{
   const key=decodeURIComponent(new URL(request.url).pathname.split("/").at(-1)!);
   await namespace.getByName(request.url).write(key,await response.text());
  },
 };
 const shared=createPublicFareCache(storage as Pick<Cache,"match"|"put">,now,ttlMs);
 return {
  async get<T>(key:string){
   try{cacheRequest(key);}catch{return null;}
   return await local.get<T>(key)??await shared.get<T>(key);
  },
  async put<T>(key:string,fares:T[]){await shared.put(key,fares);await local.put(key,fares);},
 };
}
