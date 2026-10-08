import {readdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {FRONTIER_PUBLISHED_PAGES} from '../worker/src/frontier-published-catalog.ts';
export async function frontierPublicationSummary(directory,now=new Date(),approved=[...new Set(FRONTIER_PUBLISHED_PAGES.map(p=>p.sourceUrl))]){
 if(!Number.isFinite(now.getTime()))throw new Error('Invalid summary time');
 const expected=new Set(approved),seen=new Set(),receipts=[];
 const dirs=(await readdir(directory,{withFileTypes:true})).filter(d=>d.isDirectory()&&/^frontier-publication-\d+$/.test(d.name));
 if(!dirs.length||dirs.length>64)throw new Error('Missing publication artifacts');
 for(const dir of dirs){
  const text=await readFile(join(directory,dir.name,'frontier-publication-receipts.json'),'utf8');
  if(Buffer.byteLength(text)>2000000)throw new Error('Receipt size limit');
  const rows=JSON.parse(text);if(!Array.isArray(rows)||rows.length>60)throw new Error('Invalid receipts');
  for(const row of rows){
   if(!expected.has(row.page)||seen.has(row.page)||typeof row.ok!=='boolean')throw new Error('Invalid or duplicate page receipt');
   seen.add(row.page);
   if(row.ok){const result=row.result,at=Date.parse(result?.checkedAt);if(result?.page!==row.page||!Number.isSafeInteger(result.fares)||result.fares<0||!Number.isFinite(at)||at>now.getTime()||result.expiresAfterSeconds!==600)throw new Error('Invalid publication receipt');}
   receipts.push(row);
  }
 }
 const success=receipts.filter(r=>r.ok),fresh=success.filter(r=>now.getTime()-Date.parse(r.result.checkedAt)<600000);
 return {checkedAt:now.toISOString(),expectedPages:expected.size,attemptedPages:seen.size,missingPages:expected.size-seen.size,publishedPages:success.length,failedPages:receipts.filter(r=>!r.ok).map(r=>r.page),clearedPages:success.filter(r=>r.result.fares===0).length,freshPages:fresh.length,freshAdvertisedPrices:fresh.reduce((n,r)=>n+r.result.fares,0),allAttempted:seen.size===expected.size,allPublished:success.length===expected.size,allFresh:fresh.length===expected.size};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const result=await frontierPublicationSummary(process.argv[2]);
 await writeFile(process.argv[3],JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
