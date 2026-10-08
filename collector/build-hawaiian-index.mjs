import {readFile,writeFile} from 'node:fs/promises';
import {hawaiianIndex} from './hawaiian-trips.mjs';
const rows=JSON.parse(await readFile('hawaiian-page-observations.json','utf8'));
const now=new Date(),index=hawaiianIndex(rows,now);
await writeFile('hawaiian-date-index.json',JSON.stringify({builtAt:now.toISOString(),...index}));
console.log(JSON.stringify({attempted:rows.length,failed:rows.filter(r=>r.error).length,dateKeys:Object.keys(index.byDate).length,advertisements:Object.values(index.byDate).reduce((n,rows)=>n+rows.length,0)}));
