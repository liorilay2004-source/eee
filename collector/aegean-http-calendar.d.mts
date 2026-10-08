export interface AegeanHttpTrip {origin:string;destination:string;departDate:string;returnDate:string}
export interface AegeanHttpCalendarFare extends AegeanHttpTrip {
 amount:number;currency:'EUR';outboundAmount:number;inboundAmount:number;
 bookingUrl:string;checkedAt:string;pricing:'published_advertisement';carrier:null;
 outboundUpdatedAt:string;inboundUpdatedAt:string;vendorUpdated:{outbound:string;inbound:string};
}
export interface AegeanHttpSnapshot {trip:AegeanHttpTrip;page:string;checkedAt:string;records:unknown;fare:AegeanHttpCalendarFare|null}
export function aegeanHttpCalendarUrl(trip:AegeanHttpTrip):string;
export function aegeanHttpBookingUrl(trip:AegeanHttpTrip):string;
export function parseAegeanHttpCalendar(records:unknown,trip:AegeanHttpTrip,checkedAt:string):AegeanHttpCalendarFare|null;
export function fetchAegeanHttpCalendarSnapshot(trip:AegeanHttpTrip,checkedAt?:string,fetchFn?:typeof fetch):Promise<AegeanHttpSnapshot>;
