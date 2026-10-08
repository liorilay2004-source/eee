import { describe,it,expect } from "vitest";
import { createBrusselsCachedSource } from "../src/sources/brussels-cached";
import { parseBrusselsAdvertisements } from "../src/brussels-advertisements";
import type { PublicFareCache } from "../src/public-fare-cache";
const now = new Date("2026-10-08T03:40:00Z");
const fares = parseBrusselsAdvertisements([{text:"from 184 €",url:"/aircore/deeplink/redirect/en/be/BRU/ATH/04.06.2027/18.06.2027/RT"}],{origin:"BRU",destination:"ATH"},now);
const cache = {get:async()=>({fares,expires:now.getTime()+10000}),put:async()=>{}} as PublicFareCache;
const q = {origin:"BRU",destination:"ATH",departDate:"2027-06-04",returnDate:"2027-06-18",party:{adults:1,children:0,infants:0}};
describe("Brussels cached prices",()=>{
 it("returns dated advertised price with unknown carrier and no vendor calls",async()=>{
  const source=createBrusselsCachedSource(now,cache);
  expect(await source.quote(q)).toMatchObject([{source:"brussels_airlines",priceAmount:184,priceCurrency:"EUR",checkedAt:now.toISOString(),outbound:{airlines:[],stops:null},tags:["published_advertisement"]}]);
  expect(source.callCount()).toBe(0);
 });
 it("does not substitute nearby dates or airports",async()=>{
  const source=createBrusselsCachedSource(now,cache);
  expect(await source.quote({...q,returnDate:"2027-06-19"})).toEqual([]);
  expect(await source.quote({...q,origin:"TLV"})).toEqual([]);
 });
 it("cannot scale one-adult advertisements to families",async()=>{
  expect(await createBrusselsCachedSource(now,cache).quote({...q,party:{adults:2,children:0,infants:0}})).toEqual([]);
 });
 it("rejects expired prices even if the cache remains present",async()=>{
  expect(await createBrusselsCachedSource(new Date(now.getTime()+37*3600000),cache).quote(q)).toEqual([]);
 });
 it("has no price when collection has not populated the cache",async()=>{
  expect(await createBrusselsCachedSource(now).quote(q)).toEqual([]);
 });
});
