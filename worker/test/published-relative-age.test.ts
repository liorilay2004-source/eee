import {it,expect} from 'vitest';
import {matchPublishedTrip} from '../src/sources/published-source';
import {fareFreshness} from '../src/freshness';
it('preserves rounded source age separately from original capture',()=>{
 const now=new Date('2026-10-08T10:05:00Z');
 const fare={airline:'KC',origin:'ALA',destination:'LHR',departDate:'2026-11-08',returnDate:'2026-11-13',amount:367687,currency:'KZT',structure:'roundtrip',sourceUrl:'https://bestfares.airastana.com/en-kz/flights-from-almaty-to-london',checkedAt:'2026-10-08T10:00:00Z',upstreamPriceAge:{value:6,unit:'hours'}} as const;
 const [offer]=matchPublishedTrip([fare],{origin:'ALA',destination:'LHR',departDate:fare.departDate,returnDate:fare.returnDate,party:{adults:1,children:0,infants:0}},{airline:'KC',source:'air_astana'});
 expect(offer!.upstreamPriceAge).toEqual(fare.upstreamPriceAge);
 const info=fareFreshness(offer!,now);expect(info.scanAgeMinutes).toBe(5);expect(info.fareFoundAt).toBeNull();expect(info.fareAgeBasis).toBe('unknown');expect(info.ageLabelHe).toContain('6 שעות');expect(info.ageLabelHe).toContain('5 דקות');
});
