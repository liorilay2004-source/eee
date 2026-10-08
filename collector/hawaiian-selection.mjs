export function selectHawaiianPages(inventory,requested,offset=0,limit=49){
 if(!Array.isArray(inventory)||inventory.length>100||!Number.isInteger(offset)||offset<0||offset>inventory.length||!Number.isInteger(limit)||limit<1||limit>60)throw new Error('Invalid page selection');
 const pages=requested?JSON.parse(requested):inventory.slice(offset,offset+limit).map(row=>row.url);
 if(!Array.isArray(pages)||!pages.length||pages.length>49||new Set(pages).size!==pages.length)throw new Error('Invalid page selection');
 for(const page of pages){
  const observed=inventory.find(row=>row.url===page);if(!observed)throw new Error('Unapproved page');
  const url=new URL(page),parent=new URL(observed.observedOn);
  if(url.origin!==parent.origin||url.hostname!=='asha.hawaiianairlines.com'||url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||!/^\/en\/flights-from-[a-z-]+$/.test(url.pathname))throw new Error('Invalid observed page');
 }
 return pages;
}
