/** Poll only a confirmed background request; never retry ordinary failures automatically. */
export const MAX_REFRESH_POLLS=3;
export function refreshPollDelay(kind:string,attempt:number,retryAt:number|null,now:number):number|null{
  if(kind!=="refresh_pending"||!Number.isSafeInteger(attempt)||attempt<0||attempt>=MAX_REFRESH_POLLS
    ||retryAt===null||!Number.isFinite(retryAt)||!Number.isFinite(now))return null;
  return Math.min(90_000,Math.max(0,retryAt-now));
}
