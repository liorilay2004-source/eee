import {it,expect} from 'vitest';import {parseNbkKzt} from '../src/nbk-fx';
const now=new Date('2026-10-08T10:00:00Z'),item='<item><title>ILS</title><pubDate>08.10.2026</pubDate><description>145.72</description><quant>1</quant></item>';
it('inverts the official quoted quantity rather than guessing currency conversion',()=>{
 expect(parseNbkKzt(`<rss>${item}</rss>`,now)).toEqual({date:'2026-10-08',rateToIls:1/145.72});
 expect(parseNbkKzt(item.replace('<quant>1','<quant>10'),now)?.rateToIls).toBe(10/145.72);
});
it('rejects future, expired, duplicate, invalid and non-ILS rates',()=>{
 for(const xml of [item.replace('08.10.2026','09.10.2026'),item.replace('08.10.2026','30.09.2026'),item+item,item.replace('145.72','0'),item.replace('ILS','USD'),item.replace('08.10.2026','31.02.2026'),'<!DOCTYPE rss>'+item])expect(parseNbkKzt(xml,now)).toBeNull();
});
