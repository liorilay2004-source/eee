import {expect,it,vi} from 'vitest';
import {createRepo} from '../src/db';
import {runSearch} from '../src/pipeline';
import type {FareQuoteSource} from '../src/quotes';
import type {Offer,SearchRequest,TravelpayoutsClient} from '../src/types';
import {createTestD1} from './helpers/d1';
const now=new Date('2026-10-08T12:00:00.000Z');
const request:SearchRequest={origin:'TLV',destination:'ATH',windowStart:'2027-07-02',windowEnd:'2027-07-06',stayMin:4,stayMax:4,
 adults:1,children:0,infants:0,cabin:'economy',checkedBag:false,outHours:[0,24],retHours:[0,24],maxStops:null,nearbyAirports:false};
function setup(accepted:boolean,hasPrice=false){
 const repo=createRepo(createTestD1());
 repo.loadRecentOffers=vi.fn().mockRejectedValue(Error('D1_ERROR: daily row read limit exceeded'));
 let pending=false;
 const leg={departTime:null,arriveTime:null,stops:null,durationMin:null,airlines:[]};
 const source:FareQuoteSource={name:'aegean',configured:true,cacheOnly:true,quota:{period:'monthly',cap:0,allowance:0},callCount:()=>0,nextQuoteRequests:()=>0,
  quote:vi.fn(async():Promise<Offer[]>=>{pending=accepted;return hasPrice?[{origin:'TLV',destination:'ATH',departDate:'2027-07-02',returnDate:'2027-07-06',priceAmount:250,
   priceCurrency:'EUR',source:'aegean',ticketStructure:'roundtrip',outbound:leg,inbound:leg,includes:{},deeplink:'https://en.aegeanair.com/',verifyLink:null,
   checkedAt:now.toISOString(),extrasAmountIls:0,totalIls:null,tags:['published_advertisement']}]:[];})};
 const tp:TravelpayoutsClient={configured:false,callCount:()=>0,roundTrips:vi.fn(),oneWays:vi.fn()};
 return {repo,tp,now,fx:{date:'2026-10-08',source:'test',ratesToIls:{ILS:1,EUR:4}},quoteSources:[source],pendingRefresh:()=>pending};
}
it('returns confirmed background pending before a storage failure without promising a fare',async()=>{
 const deps=setup(true);
 await expect(runSearch(deps,request)).rejects.toMatchObject({code:'source_refresh_pending',retryAfterSec:60});
 expect(deps.quoteSources[0]!.quote).toHaveBeenCalledOnce();
});
it('does not hide storage failure when the queue did not accept the request',async()=>{
 await expect(runSearch(setup(false),request)).rejects.toMatchObject({code:'storage_daily_limit'});
});
it('returns an actual price when one is available even with other pending work',async()=>{
 const result=await runSearch(setup(true,true),request);
 expect(result.cards[0]!.offer).toMatchObject({priceAmount:250,priceCurrency:'EUR',totalIls:1000});
});
