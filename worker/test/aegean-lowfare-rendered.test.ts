import {it,expect,vi} from "vitest";
import {loadRenderedAegeanCalendar} from "../src/aegean-lowfare-rendered";
import {aegeanCalendarUrl} from "../src/aegean-lowfare";
import type {Env} from "../src/types";
const q={origin:"TLV",destination:"ATH",departDate:"2027-06-01",returnDate:"2027-06-05"};
const now=new Date("2026-10-08T04:32:00Z");
const browser=(quickAction:unknown)=>({quickAction}) as NonNullable<Env["BROWSER"]>;
it("navigates only to the observed public calendar with exact dates",async()=>{
 const quickAction=vi.fn(async()=>new Response("",{status:403}));
 await expect(loadRenderedAegeanCalendar(browser(quickAction),q,now)).rejects.toThrow("Aegean calendar rendering failed");
 expect(quickAction).toHaveBeenCalledWith("content",{url:aegeanCalendarUrl(q),gotoOptions:{waitUntil:"domcontentloaded",timeout:20000},waitForTimeout:4000,rejectResourceTypes:["image","font","media"]});
});
it("rejects malformed route codes before browser navigation",async()=>{
 const quickAction=vi.fn();
 await expect(loadRenderedAegeanCalendar(browser(quickAction),{...q,destination:"FCO?"},now)).rejects.toThrow("Unsupported collected");
 expect(quickAction).not.toHaveBeenCalled();
});
it("rejects unsuccessful envelopes and oversized responses",async()=>{
 await expect(loadRenderedAegeanCalendar(browser(async()=>Response.json({success:false,result:"challenge"})),q,now)).rejects.toThrow("Invalid calendar rendering response");
 await expect(loadRenderedAegeanCalendar(browser(async()=>new Response(new Uint8Array(4_000_001))),q,now)).rejects.toThrow("Calendar payload too large");
});
