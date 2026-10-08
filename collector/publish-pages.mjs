// A failed public page must not prevent refreshing unrelated approved pages.
export async function publishPages(pages, publish, checkpoint) {
  const receipts=[];
  for (const page of pages) {
    try { receipts.push({page,ok:true,result:await publish(page)}); }
    catch (error) {
      // Authentication and configuration failures affect every page: stop.
      if (error.fatal) throw error;
      receipts.push({page,ok:false,error:String(error.message)});
    }
    await checkpoint(receipts);
  }
  return receipts;
}
