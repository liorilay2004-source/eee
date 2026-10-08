/** Discover public fare pages actually linked by the official page; never guess routes. */
export function routeLinks(html,sourceUrl){
 const base=new URL(sourceUrl),found=new Set();
 for(const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)){
  try{const url=new URL(match[1].replace(/&amp;/g,'&'),base);
   if(url.origin!==base.origin||url.username||url.password||url.search||url.hash||!/^\/[a-z_-]+\/flights-from-[a-z-]+-to-[a-z-]+\/?$/.test(url.pathname))continue;
   found.add(url.href);if(found.size>=100)break;
  }catch{}
 }
 return [...found];
}
