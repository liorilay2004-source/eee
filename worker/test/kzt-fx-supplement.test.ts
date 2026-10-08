import {it,expect,vi} from 'vitest';import {supplementKztFx} from '../src/kzt-fx-supplement';
const now=new Date('2026-10-08T10:00:00Z'),base={date:'2026-10-08',source:'bank_of_israel',ratesToIls:{ILS:1,USD:3,EUR:3.5}},xml='<rss><item><title>ILS</title><pubDate>08.10.2026</pubDate><description>145.72</description><quant>1</quant></item></rss>';
it('adds official KZT without overwriting primary rates and coalesces fetches',async()=>{
 const fetchFn=vi.fn(async()=>new Response(xml));const [a,b]=await Promise.all([supplementKztFx(base,['KZT'],fetchFn as any,now),supplementKztFx(base,['KZT'],fetchFn as any,now)]);
 expect(a.ratesToIls).toEqual({...base.ratesToIls,KZT:1/145.72});expect(a).toEqual(b);expect(fetchFn).toHaveBeenCalledTimes(1);
});
it('keeps original dates, never fetches existing rates and tolerates failed feeds',async()=>{
 const fetchFn=vi.fn(async()=>new Response(xml));const older={...base,date:'2026-10-07',source:'bank_of_israel:stale'};
 expect(await supplementKztFx(older,['KZT'],fetchFn as any,now)).toMatchObject({date:'2026-10-07',source:'bank_of_israel+nbk:stale'});
 const ready={...base,ratesToIls:{...base.ratesToIls,KZT:0.007}};const unused=vi.fn();expect(await supplementKztFx(ready,['KZT'],unused as any,now)).toBe(ready);expect(unused).not.toHaveBeenCalled();
 expect(await supplementKztFx(base,['KZT'],vi.fn(async()=>new Response('',{status:503})) as any,now)).toBe(base);
});
