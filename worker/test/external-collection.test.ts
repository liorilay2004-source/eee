import {it,expect} from 'vitest';
import {usesExternalPublishedCollector} from '../src/external-collection';
it('suppresses only verified Copa and Iberia browser collectors when migration is enabled',()=>{
 for(const source of ['copa','iberia']){expect(usesExternalPublishedCollector({EXTERNAL_PUBLISHED_COLLECTOR:'true'},source)).toBe(true);expect(usesExternalPublishedCollector({},source)).toBe(false);expect(usesExternalPublishedCollector({EXTERNAL_PUBLISHED_COLLECTOR:'false'},source)).toBe(false);}
 for(const source of ['lufthansa','finnair','turkish','aeromexico','klm'])expect(usesExternalPublishedCollector({EXTERNAL_PUBLISHED_COLLECTOR:'true'},source)).toBe(false);
});
