import {it,expect,vi} from "vitest";
import {loadRenderedLhgAnchors} from "../src/brussels-rendered";
import {loadRenderedLufthansa,LUFTHANSA_ATHENS_TEL_AVIV_PAGE} from "../src/lufthansa-rendered";
import type {Env} from "../src/types";
import {loadRenderedSwiss,SWISS_TEL_AVIV_PAGE} from "../src/swiss-rendered";
const now=new Date("2026-10-08T03:50:00Z");
const browser=(quickAction:unknown)=>({quickAction}) as NonNullable<Env["BROWSER"]>;
it("does not navigate to caller supplied or unverified fare URLs",async()=>{
 const quickAction=vi.fn();
 await expect(loadRenderedLhgAnchors(browser(quickAction),"https://evil.example/")).rejects.toThrow("Unsupported official fare page");
 expect(quickAction).not.toHaveBeenCalled();
});
it("uses the observed official Lufthansa page without account credentials",async()=>{
 const quickAction=vi.fn(async()=>new Response("",{status:503}));
 await expect(loadRenderedLufthansa(browser(quickAction),now)).rejects.toThrow("Official rendering failed");
 expect(quickAction).toHaveBeenCalledWith("content",{
 url:LUFTHANSA_ATHENS_TEL_AVIV_PAGE,gotoOptions:{waitUntil:"domcontentloaded",timeout:15000},
 waitForTimeout:2000,rejectResourceTypes:["image","font","media"],
 });
});
it("rejects unsuccessful renderer envelopes",async()=>{
 await expect(loadRenderedLufthansa(browser(async()=>Response.json({success:false,result:"challenge"})),now)).rejects.toThrow("Invalid rendering response");
});
it("renders only the observed Swiss official route page",async()=>{
 const quickAction=vi.fn(async()=>new Response("",{status:503}));
 await expect(loadRenderedSwiss(browser(quickAction),now)).rejects.toThrow("Official rendering failed");
 expect(quickAction).toHaveBeenCalledWith("content",{
 url:SWISS_TEL_AVIV_PAGE,gotoOptions:{waitUntil:"domcontentloaded",timeout:15000},
 waitForTimeout:2000,rejectResourceTypes:["image","font","media"],
 });
});
it("bounds the public rendered response before HTML parsing",async()=>{
 await expect(loadRenderedLufthansa(browser(async()=>new Response(new Uint8Array(4_000_001))),now)).rejects.toThrow("Rendering payload too large");
});
