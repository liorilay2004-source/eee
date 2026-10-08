import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {mergeFrontierArtifacts} from './merge-frontier-results.mjs';
test('merges separate actual batches and counts failed pages without refreshing fare times',async()=>{
 const root=await mkdtemp(join(tmpdir(),'frontier-merge-')),at='2026-10-08T09:00:00Z';
 const row={finalUrl:'https://flights.flyfrontier.com/en/flights-from-denver',checkedAt:at,records:[{__typename:'Fare',travelClass:'ECONOMY',originAirportCode:'DEN',destinationAirportCode:'PHX',departureDate:'2027-01-05',flightType:'ONE_WAY',totalPrice:18.98,currencyCode:'USD'}]};
 for(const [offset,rows] of [[0,[row]],[60,[{error:'HTTP 502'}]]]){const dir=join(root,'frontier-linked-'+offset);await mkdir(dir);await writeFile(join(dir,'frontier-route-observations.json'),JSON.stringify(rows));}
 const result=await mergeFrontierArtifacts(root,new Date('2026-10-08T09:10:00Z'));assert.equal(result.artifacts,2);assert.equal(result.observedPages,2);assert.equal(result.failedPages,1);assert.equal(result.observations[0].checkedAt,'2026-10-08T09:00:00.000Z');assert.equal(result.fresh.length,0);
});
test('does not treat missing or malformed artifacts as a complete collection',async()=>{
 const root=await mkdtemp(join(tmpdir(),'frontier-merge-bad-'));await assert.rejects(mergeFrontierArtifacts(root));
 const dir=join(root,'frontier-linked-0');await mkdir(dir);await writeFile(join(dir,'frontier-route-observations.json'),'{}');await assert.rejects(mergeFrontierArtifacts(root));
});
