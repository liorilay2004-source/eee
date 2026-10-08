import type {Env} from './types';
/** Only browser sources with verified external publication and production search consumption. */
export function usesExternalPublishedCollector(env:Pick<Env,'EXTERNAL_PUBLISHED_COLLECTOR'>,source:string):boolean {
 return env.EXTERNAL_PUBLISHED_COLLECTOR==='true'&&['copa','iberia'].includes(source);
}
