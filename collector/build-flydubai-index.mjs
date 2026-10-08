import {readFile,writeFile} from 'node:fs/promises';
import {flydubaiIndex} from './flydubai-index.mjs';
const input=process.argv[2]??'flydubai-page-observations.json',output=process.argv[3]??'flydubai-fare-index.json';
const rows=JSON.parse(await readFile(input,'utf8')),now=new Date(),index=flydubaiIndex(rows,now);
await writeFile(output,JSON.stringify({builtAt:now.toISOString(),...index},null,2));
console.log(JSON.stringify({oneWayKeys:Object.keys(index.byDate).length,roundtripKeys:Object.keys(index.roundTrips).length}));
