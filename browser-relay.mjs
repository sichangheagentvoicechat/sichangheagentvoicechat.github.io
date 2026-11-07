/** Speech attachments in a muted private channel, with topics for each operation. */
export function createBrowserRelay(adapter,nativeFetch){
  const {config}=adapter,pending=new Map();let queue=null,polling=false,registering=null;
  const cleanupKey='voice-relay-cleanup:'+config.site+':'+config.humanId;
  let cleanupJobs;try{cleanupJobs=JSON.parse(localStorage.getItem(cleanupKey)||'{}');}catch{cleanupJobs={};}
  function persist(){try{localStorage.setItem(cleanupKey,JSON.stringify(cleanupJobs));}catch{}}
  function remember(id,job){Object.assign(cleanupJobs[id]??={},job);persist();}
  const auth='Basic '+btoa(config.email+':'+config.key);
  async function api(method,path,fields){
    if(method==='DELETE'){
      const response=await nativeFetch(config.site+'/api/v1/'+path,{method,headers:{Authorization:auth},signal:AbortSignal.timeout(15000)});const data=await response.json();
      if(response.ok&&data.result==='success'||response.status===404||data.code==='BAD_REQUEST'&&/^Invalid (message\(s\)|message|attachment)\.?$/.test(data.msg))return data;
      throw new Error('Relay cleanup failed.');
    }
    const result=await adapter.request(method,path,fields);if(result.error)throw new Error(result.error);return result.data;
  }
  async function send(value){return api('POST','messages',{type:'stream',to:String(config.relayStreamId),topic:value.op,content:JSON.stringify(value)});}
  async function upload(blob,id){const form=new FormData();form.append('file',blob,'voice-recording-'+id);const response=await nativeFetch(config.site+'/api/v1/user_uploads',{method:'POST',headers:{Authorization:auth},body:form,signal:AbortSignal.timeout(15000)});const result=await response.json();if(!response.ok||result.result!=='success')throw new Error('Audio upload failed.');return result.uri;}
  async function removeUpload(uri){const attachments=await api('GET','attachments',{});const item=attachments.attachments.find(a=>uri.endsWith(a.path_id));if(item)await api('DELETE','attachments/'+item.id,{});}
  async function ensureQueue(){if(queue)return;if(!registering)registering=(async()=>{const result=await api('POST','register',{event_types:JSON.stringify(['message']),narrow:JSON.stringify([['stream','voice-relay']]),apply_markdown:'false'});queue={id:result.queue_id,last:result.last_event_id};})().finally(()=>{registering=null;});await registering;}
  const cleaning=new Set();
  async function cleanup(id){const job=cleanupJobs[id];if(!job||!job.complete||cleaning.has(id))return;cleaning.add(id);try{
    if(job.sent&&!job.acked){const ack=await send({voice:1,id,op:'ack'});remember(id,{ackId:ack.id,acked:true});}
    if(job.sent&&!job.reconciled){
      const recent=await api('GET','messages',{narrow:JSON.stringify([{operator:'stream',operand:config.relayStreamId}]),anchor:'newest',num_before:100,num_after:0,apply_markdown:'false'});
      for(const message of recent.messages||[]){if(message.sender_id!==config.humanId)continue;let value;try{value=JSON.parse(message.content);}catch{continue;}if(value.voice===1&&value.id===id&&['stt','tts','ack'].includes(value.op)){await api('DELETE','messages/'+message.id,{});for(const field of ['requestId','ackId'])if(job[field]===message.id)remember(id,{[field]:null});}}
      remember(id,{reconciled:true});
    }
    for(const field of ['requestId','ackId'])if(job[field]){await api('DELETE','messages/'+job[field],{});remember(id,{[field]:null});}
    if(job.uri){await removeUpload(job.uri);remember(id,{uri:null});}
    if(job.uploading){const attachments=await api('GET','attachments',{});for(const item of attachments.attachments.filter(a=>a.name==='voice-recording-'+id))await api('DELETE','attachments/'+item.id,{});remember(id,{uploading:false});}
    delete cleanupJobs[id];persist();
  }catch{}finally{cleaning.delete(id);}}
  for(const id of Object.keys(cleanupJobs)){remember(id,{complete:true,sent:cleanupJobs[id].sent||!!cleanupJobs[id].requestId});cleanup(id);}
  async function poll(){
    if(polling)return;polling=true;
    try{while(pending.size){const result=await api('GET','events',{queue_id:queue.id,last_event_id:String(queue.last),dont_block:'false'});for(const event of result.events){queue.last=Math.max(queue.last,event.id);const message=event.message;if(event.type!=='message'||message.sender_id!==config.botId||message.type!=='stream'||message.stream_id!==config.relayStreamId||!['stt','tts'].includes(message.subject))continue;let response;try{response=JSON.parse(message.content);}catch{continue;}if(response.voice!==1||response.op!=='result')continue;const job=pending.get(response.id);if(job){pending.delete(response.id);job.resolve(response);}}}}
    catch(error){for(const job of pending.values())job.reject(error);pending.clear();queue=null;}finally{polling=false;}
  }
  async function request(path,options){
    if(path==='/api/audio-ack'){const {id}=JSON.parse(options.body);if(cleanupJobs[id]){remember(id,{complete:true});await cleanup(id);}return Response.json({ok:true});}
    const id=crypto.randomUUID(),op=path.endsWith('/stt')?'stt':'tts';let uri,requestId,deferredCleanup=false;
    for(const oldId of Object.keys(cleanupJobs))cleanup(oldId);
    let timer,abort;
    const checkAbort=()=>{if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');};
    try{
    checkAbort();await ensureQueue();checkAbort();
    if(op==='stt'){remember(id,{uploading:true});uri=await upload(options.body,id);remember(id,{uri,uploading:false});}else if(typeof options.body!=='string')throw new Error('Invalid speech text.');
    checkAbort();
    const job={voice:1,id,op,...(uri?{uri,attachment:'[audio]('+uri+')'}:{text:JSON.parse(options.body).text})};
    const waiting=new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});timer=setTimeout(()=>{pending.delete(id);reject(new Error('Voice relay timed out; recording remains saved.'));},20000);abort=()=>{pending.delete(id);reject(new DOMException('Aborted','AbortError'));};options.signal?.addEventListener('abort',abort,{once:true});});
    waiting.catch(()=>{});
      checkAbort();remember(id,{uri,sent:true});requestId=(await send(job)).id;remember(id,{requestId});poll();const result=await waiting;checkAbort();if(result.error)throw new Error(result.error);
      let response;
      if(op==='stt')response=new Response(JSON.stringify({text:result.text}),{headers:{'Content-Type':'application/json'}});
      else{const url=new URL(result.uri,config.site);if(url.origin!==new URL(config.site).origin||!url.pathname.startsWith('/user_uploads/'))throw new Error('Invalid relay attachment.');const temporary=await api('GET',url.pathname.slice(1),{});const signed=new URL(temporary.url,config.site);if(signed.protocol!=='https:'||signed.username||signed.password)throw new Error('Invalid audio URL.');checkAbort();deferredCleanup=true;response=Response.json({audioURL:signed.href,relayId:id});}
      return response;
    }finally{clearTimeout(timer);if(abort)options.signal?.removeEventListener('abort',abort);pending.delete(id);if(cleanupJobs[id]&&!deferredCleanup){remember(id,{complete:true});cleanup(id);}}
  }
  return {fetch:request,async release(id){if(cleanupJobs[id]){remember(id,{complete:true});await cleanup(id);}}};
}
