import {expect,it} from 'vitest';
import {refreshPollDelay} from './refresh-wait';
it('bounds confirmed background polling to three checks and at most ninety seconds per wait',()=>{
  expect(refreshPollDelay('refresh_pending',0,61000,1000)).toBe(60000);
  expect(refreshPollDelay('refresh_pending',2,1e9,1000)).toBe(90000);
  expect(refreshPollDelay('refresh_pending',2,500,1000)).toBe(0);
  for(const attempt of [-1,3,4,NaN,0.5])expect(refreshPollDelay('refresh_pending',attempt,61000,1000)).toBeNull();
});
it('does not automatically retry ordinary errors or malformed polling times',()=>{
  for(const kind of ['timeout','offline','source_unavailable','error'])expect(refreshPollDelay(kind,0,61000,1000)).toBeNull();
  for(const retryAt of [null,NaN,Infinity])expect(refreshPollDelay('refresh_pending',0,retryAt,1000)).toBeNull();
});
