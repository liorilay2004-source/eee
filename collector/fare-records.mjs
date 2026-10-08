/** Preserve upstream Fare records verbatim; normalization happens again on the server. */
export function fareRecords(html){
 const script=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].find(match=>/\bid\s*=\s*["']__NEXT_DATA__["']/i.test(match[1]));
 if(!script)return [];
 const queue=[JSON.parse(script[2])],records=[];let visited=0;
 while(queue.length){if(++visited>100000)throw new Error('Page data too complex');const node=queue.pop();if(!node||typeof node!=='object')continue;if(node.__typename==='Fare'){records.push(node);if(records.length>500)throw new Error('Too many fare records');}else queue.push(...Object.values(node));}
 return records;
}
