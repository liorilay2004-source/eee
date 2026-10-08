/** Bounded independent hosts; each official host is fetched sequentially. */
export async function collectByHost(pages, visit, limit=4) {
  if(!Number.isInteger(limit)||limit<1||limit>8) throw new Error('Invalid concurrency');
  const groups=new Map();
  for(const page of pages){const host=new URL(page.sourceUrl).host;if(!groups.has(host))groups.set(host,[]);groups.get(host).push(page);}
  const queue=[...groups.values()];let next=0;
  await Promise.all(Array.from({length:Math.min(limit,queue.length)},async()=>{
    for(;;){const index=next++;if(index>=queue.length)return;for(const page of queue[index])await visit(page);}
  }));
}
