/** Limit this page's authenticated API starts, leaving budget for other clients. */
export function budgetRequests(network,{perMinute=100,burst=6}={}){
  let tokens=burst,lastMs=Date.now(),tail=Promise.resolve();
  return async(input,options={})=>{
    const url=new URL(typeof input==='string'?input:input.url);
    if(url.origin!=='https://shagent.zulipchat.com'||!url.pathname.startsWith('/api/v1/'))return network(input,options);
    const start=tail.then(async()=>{
      for(;;){
        if(options.signal?.aborted)throw new DOMException('Cancelled','AbortError');
        const now=Date.now();tokens=Math.min(burst,tokens+(now-lastMs)*perMinute/60000);lastMs=now;
        if(tokens>=1){tokens--;return;}
        await new Promise(resolve=>setTimeout(resolve,Math.ceil((1-tokens)*60000/perMinute)));
      }
    });
    tail=start.catch(()=>{});await start;return network(input,options);
  };
}
