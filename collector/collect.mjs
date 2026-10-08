import {chromium} from 'playwright';
import {EXTERNAL_FARE_PAGES} from '../worker/src/external-fare-catalog.ts';
const endpoint=process.env.COLLECTOR_ENDPOINT;
const key=process.env.COLLECTOR_KEY;
if(endpoint!=='https://eee-api.liorilay2004.workers.dev/api/internal/public-fares'||!/^[a-f0-9]{64}$/.test(key??''))throw new Error('Collector configuration missing');
const browser=await chromium.launch({headless:true});let failed=0;
try{for(const entry of EXTERNAL_FARE_PAGES){const page=await browser.newPage({viewport:{width:1280,height:900}});
 try{const checkedAt=new Date().toISOString();await page.goto(entry.page,{waitUntil:'domcontentloaded',timeout:30000});await page.locator('a[href*="/aircore/deeplink/redirect/"]').first().waitFor({state:'attached',timeout:20000});
 const anchors=await page.locator('a[href*="/aircore/deeplink/redirect/"]').evaluateAll(nodes=>nodes.slice(0,500).map(a=>({text:a.innerText,url:a.href})));
 const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({source:entry.source,page:entry.page,checkedAt,anchors}),signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error(`Ingest HTTP ${response.status}`);const result=await response.json();console.log(JSON.stringify({source:entry.source,fares:result.fares,checkedAt:result.checkedAt}));
 }catch{failed++;console.error(JSON.stringify({source:entry.source,status:'collection_failed'}));}finally{await page.close();}
}}finally{await browser.close();}
if(failed)process.exitCode=1;
