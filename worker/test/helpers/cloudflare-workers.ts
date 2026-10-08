/** Node unit-test stand-in only; runtime RPC/SQLite are verified separately in workerd. */
export class DurableObject<T=Record<string,unknown>> {
 constructor(protected ctx:DurableObjectState,protected env:T){}
}
