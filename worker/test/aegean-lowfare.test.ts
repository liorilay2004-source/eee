import {it,expect} from "vitest";
import {parseAegeanCalendar,aegeanCalendarUrl,type AegeanCalendarText} from "../src/aegean-lowfare";
const now=new Date("2026-10-08T04:30:00Z");
const q={origin:"TLV",destination:"ATH",departDate:"2027-06-01",returnDate:"2027-06-05"};
const text=():AegeanCalendarText=>({outboundRows:["","1 €104.63","2 €104.63"],inboundRows:["1 €101.74","5 €127.74"],outboundMonths:["Jun from €82.52"],inboundMonths:["Jun from €101.74"],summaries:["Tel Aviv (TLV) to Athens (ATH) 01/06/2027 Athens (ATH) to Tel Aviv (TLV) 05/06/2027 € 232.37Total Book this trip"]});
it("matches the observed selected trip and its two component prices",()=>{
 expect(parseAegeanCalendar(text(),q,now)).toMatchObject({...q,amount:232.37,currency:"EUR",outboundAmount:104.63,inboundAmount:127.74,carrier:null,checkedAt:now.toISOString()});
});
it("does not copy caller metadata into shared public data",()=>{
 const input={...q,party:{adults:1},privateMetadata:"not-public"};
 expect(parseAegeanCalendar(text(),input,now)).not.toHaveProperty("party");
 expect(parseAegeanCalendar(text(),input,now)).not.toHaveProperty("privateMetadata");
});
it("reads the trip overview independently of the booking button",()=>{
 const input=text();input.summaries=input.summaries.map(s=>s.replace(" Book this trip",""));
 input.outboundRows=input.outboundRows.map(s=>`\n${" ".repeat(250)}${s}\n`);
 expect(parseAegeanCalendar(input,q,now)?.amount).toBe(232.37);
});
it("uses only the verified calendar path and query parameters",()=>{
 expect(aegeanCalendarUrl(q)).toBe("https://en.aegeanair.com/flight-deals/low-fare-calendar/?arr=ATH&datedeparture=2027-06-01&datereturn=2027-06-05&dep=TLV&month=2027-06&type=R");
 expect(()=>aegeanCalendarUrl({...q,origin:"ATH",destination:"TLV"})).toThrow();
});
it.each(["2027-06-06","2027-07-05","2027-06-31"])("does not reuse a price for another return date %s",returnDate=>{
 expect(parseAegeanCalendar(text(),{...q,returnDate},now)).toBeNull();
});
it("rejects a mismatched month, total, currency, or duplicate day",()=>{
 for(const change of [{outboundMonths:["Jul from €82.52"]},{summaries:[text().summaries[0]!.replace("232.37","200.00")]},{outboundRows:["1 $104.63"]},{outboundRows:["1 €104.63","1 €100.00"]}])
 expect(parseAegeanCalendar({...text(),...change},q,now)).toBeNull();
});
it("does not treat contextual calendar days as separate one-way tickets",()=>{
 expect(parseAegeanCalendar(text(),{...q,departDate:"2027-06-02"},now)).toBeNull();
});
