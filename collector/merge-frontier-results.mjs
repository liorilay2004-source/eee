import {readdir,readFile,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {frontierSnapshot} from './frontier-snapshot.mjs';
export async function mergeFrontierArtifacts(directory,now=new Date()){
 const dirs=(await readdir(directory,{withFileTypes:true})).filter(d=>d.isDirectory()&&/^frontier-linked-\d+$/.test(d.name));
 if(!dirs.length||dirs.length>64)throw new Error('Invalid Frontier artifacts');
 const rows=[];let bytes=0;
 for(const dir of dirs){
  const file=join(directory,dir.name,'frontier-route-observations.json'),size=(await stat(file)).size;
  bytes+=size;if(size>20000000||bytes>100000000)throw new Error('Artifact size limit');
  const batch=JSON.parse(await readFile(file,'utf8'));
  if(!Array.isArray(batch)||batch.length>60)throw new Error('Invalid observation batch');
  rows.push(...batch);
 }
 const inventory=JSON.parse(await readFile(new URL('./frontier-linked-routes.json',import.meta.url),'utf8'));
 const requested=new Set(inventory.map(r=>r.url)),observed=new Set(rows.map(r=>r?.page).filter(url=>requested.has(url)));
 return {artifacts:dirs.length,expectedPages:requested.size,observedUniquePages:observed.size,missingPages:requested.size-observed.size,collectionComplete:observed.size===requested.size,observedPages:rows.length,failedPages:rows.filter(r=>r?.error).length,...frontierSnapshot(rows,now)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==4)throw new Error('Expected artifact directory and output file');
 const result=await mergeFrontierArtifacts(process.argv[2]);
 await writeFile(process.argv[3],JSON.stringify(result));
 console.log(JSON.stringify({artifacts:result.artifacts,observedPages:result.observedPages,missingPages:result.missingPages,collectionComplete:result.collectionComplete,failedPages:result.failedPages,validPages:result.pages,prices:result.observations.length,freshPrices:result.fresh.length}));
}
