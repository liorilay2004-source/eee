import { describe,it,expect } from "vitest";
import { createLufthansaCachedSource } from "../src/sources/lufthansa-cached";
import { parseLufthansaAdvertisements } from "../src/lufthansa-advertisements";
import type { PublicFareCache } from "../src/public-fare-cache";
const now = new Date("2026-10-08T03:40:00Z");
const fares = parseLufthansaAdvertisements([{text:"from 304 €",url:"/aircore/deeplink/redirect/en/gr/ATH/TLV/05.06.2027/19.06.2027/RT"}],now);
const cache = {get:async()=>({fares,expires:now.getTime()+10000}),put:async()=>{}} as PublicFareCache;
const q = {origin:"ATH",destination:"TLV",departDate:"2027-06-05",returnDate:"2027-06-19",party:{adults:1,children:0,infants:0}};
describe("Lufthansa cached prices",()=>{
 it("rejects malformed cached price values",async()=>{
  const malformed={get:async()=>({fares:[{...fares[0],amount:"304"}],expires:now.getTime()+10000}),put:async()=>{}} as PublicFareCache;
  expect(await createLufthansaCachedSource(now,malformed).quote(q)).toEqual([]);
 });
 it("returns dated advertised price with unknown carrier and no vendor calls",async()=>{
  const source=createLufthansaCachedSource(now,cache);
  expect(await source.quote(q)).toMatchObject([{source:"lufthansa",priceAmount:304,priceCurrency:"EUR",checkedAt:now.toISOString(),outbound:{airlines:[],stops:null},tags:["published_advertisement"]}]);
  expect(source.callCount()).toBe(0);
 });
 it("does not substitute nearby dates or airports",async()=>{
  const source=createLufthansaCachedSource(now,cache);
  expect(await source.quote({...q,returnDate:"2027-06-20"})).toEqual([]);
  expect(await source.quote({...q,origin:"TLV"})).toEqual([]);
 });
 it("cannot scale one-adult advertisements to families",async()=>{
  expect(await createLufthansaCachedSource(now,cache).quote({...q,party:{adults:2,children:0,infants:0}})).toEqual([]);
 });
 it("rejects expired prices even if the cache remains present",async()=>{
  expect(await createLufthansaCachedSource(new Date(now.getTime()+37*3600000),cache).quote(q)).toEqual([]);
 });
 it("has no price when collection has not populated the cache",async()=>{
  expect(await createLufthansaCachedSource(now).quote(q)).toEqual([]);
 });
});
