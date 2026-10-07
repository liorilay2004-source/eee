/** Official website collector run outside Workers. No account/key/payment required.
 * Stores one exact date pair in the existing shared history; production reads it.
 * Usage: node scripts/collect-ryanair.mjs STN DUB 2027-06-01 2027-06-05
 */
import { writeFile, mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [origin, destination, depart, ret] = process.argv.slice(2);
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
if (![origin, destination].every(value => /^[A-Z]{3}$/.test(value ?? '')) || origin === destination || !validDate(depart) || !validDate(ret) || ret <= depart) throw new Error('Expected airport codes and exact outward/return ISO dates');
const checkedAt = new Date().toISOString();
async function fare(from, to, date) {
  const url = `https://services-api.ryanair.com/farfnd/v4/oneWayFares/${from}/${to}/cheapestPerDay?outboundMonthOfDate=${date.slice(0,7)}-01&currency=EUR`;
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Official calendar HTTP ${response.status}`);
  const data = await response.json();
  const row = data.outbound?.fares?.find(row => row.day === date);
  if (!row || row.unavailable || row.soldOut || row.price?.currencyCode !== 'EUR' || !Number.isFinite(row.price?.value) || row.price.value <= 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(row.departureDate ?? '') || row.departureDate.slice(0,10) !== date) return null;
  return row;
}
const [out, back] = await Promise.all([fare(origin, destination, depart), fare(destination, origin, ret)]);
if (!out || !back) { console.log('No priced exact-date pair returned; nothing written.'); process.exit(0); }
const leg = row => ({ departTime: row.departureDate.slice(11,16), arriveTime: typeof row.arrivalDate === 'string' ? row.arrivalDate.slice(11,16) : null, stops: 0, durationMin: null, airlines: ['FR'] });
const amount = Math.round((out.price.value + back.price.value)*100)/100;
const quote = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const values = [origin,destination,depart,ret,amount,'EUR','ryanair','split',JSON.stringify(['FR']),JSON.stringify({outbound:leg(out),inbound:leg(back),returnDeeplink:'https://www.ryanair.com/'}),'{}','https://www.ryanair.com/',null,checkedAt];
const sql = `INSERT INTO prices (origin,destination,depart_date,return_date,price_amount,price_currency,source,ticket_structure,airlines_json,legs_json,includes_json,deeplink,verify_link,checked_at) VALUES (${values.map(quote).join(',')});`;
const dir = await mkdtemp(join(tmpdir(),'eee-ryanair-'));
const path = join(dir,'prices.sql');
try {
  await writeFile(path,sql);
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli,'d1','execute','eee-db','--remote','--config','wrangler.toml','--file',path], { stdio:'inherit' });
  if (result.status !== 0) throw new Error('Price persistence failed');
  console.log(JSON.stringify({origin,destination,depart,ret,amount,currency:'EUR',checkedAt,pricing:'advertised_one_adult'}));
} finally { await unlink(path).catch(() => undefined); await rmdir(dir); }
