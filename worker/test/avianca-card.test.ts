import {describe,expect,it} from "vitest";
import {parseAviancaCard} from "../src/avianca-card";
const now=new Date("2026-10-08T00:00:00Z");
const observed='<div class="hh-rtcard undefined"><div class="hh-rtcard-title">Round trip</div><div class="hh-rtcard-row"><img alt=""><span>Sat, Nov 07, 2026</span></div><div class="hh-rtcard-row"><img alt=""><span>Sat, Nov 14, 2026</span></div><span class="hh-rtcard-currency">USD</span><span class="hh-rtcard-amount">330</span><button type="button" class="hh-rtcard-cta">Book now</button><button type="button" class="hh-rtcard-clear">Clear selection</button></div>';
describe("Avianca complete rendered cash card",()=>{
 it("preserves the observed exact round-trip dates and total",()=>{expect(parseAviancaCard(observed,now)).toMatchObject([{airline:"AV",origin:"MIA",destination:"CLO",departDate:"2026-11-07",returnDate:"2026-11-14",amount:330,currency:"USD"}]);});
 it("rejects partial outbound cards, expired dates, miles and malformed calendar dates",()=>{
  for(const text of [observed.replace('Sat, Nov 14, 2026','Select return'),observed.replace('USD','Miles'),observed.replace('Nov 07, 2026','Nov 07, 2025'),observed.replace('Nov 14, 2026','Nov 31, 2026'),observed.replace('>330<','>0<')])expect(parseAviancaCard(text,now)).toEqual([]);
 });
 it("rejects the observed loading state with two dates but the outbound-only amount",()=>{
  const header="<div>Round trip from 330 USD</div>";
  expect(parseAviancaCard(header+observed.replace(">330<",">165<"),now)).toEqual([]);
  expect(parseAviancaCard(header+observed,now)).toHaveLength(1);
 });
 it("does not use headline, JSON-LD minima or script-generated fake markup",()=>{
  expect(parseAviancaCard('Round trip from 330 USD',now)).toEqual([]);
  expect(parseAviancaCard(`<script>${observed}</script>`,now)).toEqual([]);
  expect(parseAviancaCard(observed.replace('Round trip','One way'),now)).toEqual([]);
 });
});
