const configKey='zulip-voice-browser-config';
export function saveBrowserConfig(config,storage=localStorage){storage.setItem(configKey,JSON.stringify(config));}
export function loadBrowserConfig(storage=localStorage){try{return JSON.parse(storage.getItem(configKey)||'null');}catch{return null;}}

/** Direct human API transport for the dedicated static origin. No third-party code. */
export function createBrowserZulip(config,{fetch:network=globalThis.fetch,storage=globalThis.localStorage,now=Date.now}={}){
  const site=new URL(config.site);
  if(site.protocol!=='https:'||site.pathname!=='/'||site.search||site.hash||site.username||site.password)throw Error('Expected Zulip HTTPS origin');
  const scope=site.origin+':'+config.humanId+':'+config.streamId;
  const authorization='Basic '+btoa(String.fromCharCode(...new TextEncoder().encode(config.email+':'+config.key)));
  let conversations=[];
  let serverOffsetMs=null;
  const latestIds=new Map();
  const pending=new Map();
  async function request(method,path,fields={}){
    const query=new URLSearchParams(fields);
    try{
      const response=await network(site.origin+'/api/v1/'+path+(method==='GET'?'?'+query:''),{method,redirect:'error',headers:{Authorization:authorization,...(method==='GET'?{}:{'Content-Type':'application/x-www-form-urlencoded'})},body:method==='GET'?undefined:query,signal:AbortSignal.timeout(15000)});
      const serverMs=Date.parse(response.headers.get('date')||'');
      if(Number.isFinite(serverMs))serverOffsetMs=serverMs-now();
      const data=await response.json();
      if(!response.ok||data.result!=='success')return {error:'Zulip rejected the request.',uncertain:response.status>=500};
      return {data};
    }catch{return {error:'Zulip connection failed or timed out.',uncertain:true};}
  }
  async function refresh(){
    const result=await request('GET',`users/me/${config.streamId}/topics`);
    if(result.error)return result;
    conversations=result.data.topics.sort((a,b)=>b.max_id-a.max_id).map(t=>({id:t.name,name:t.name}));
    for(const topic of result.data.topics)latestIds.set(topic.name,Math.max(latestIds.get(topic.name)||0,topic.max_id));
    return {data:conversations};
  }
  function route(text){
    let switchTo=null,notice=null;
    text=text.split('\n').filter(line=>{const match=line.match(/^\[switch: (.+)\]$/);if(!match)return true;const target=match[1].replace(/\.md$/,'');if(conversations.some(c=>c.id===target))switchTo=target;else notice='Unknown conversation: '+match[1];return false;}).join('\n').trim();
    return {text,switchTo,notice};
  }
  const narrow=agent=>[{operator:'stream',operand:config.streamId},...(agent?[{operator:'topic',operand:agent}]:[])];
  async function messages(fields){const r=await request('GET','messages',{apply_markdown:'false',...fields});if(r.data)for(const m of r.data.messages)latestIds.set(m.subject,Math.max(latestIds.get(m.subject)||0,m.id));return r;}
  const receiptKey=id=>'zulip-voice-receipt:'+scope+':'+id;
  const uncertain={error:'Delivery uncertain. Reconnect to reconcile this submission before retrying.',uncertain:true};
  // 🧑 "The client also needs to be able to handle connection drops in intermittently"
  async function send(input){
    const key=receiptKey(input.id);let record;
    try{record=JSON.parse(storage.getItem(key)||'null');}catch{return uncertain;}
    if(record&&(record.agent!==input.agent||record.text!==input.text))return {error:'Submission ID already used for different content.'};
    if(record?.receipt)return {data:record.receipt};
    if(record){
      const result=await messages({anchor:'newest',num_before:100,num_after:0,narrow:JSON.stringify([...narrow(input.agent),{operator:'sender',operand:config.humanId}])});
      if(result.error)return uncertain;
      const recent=result.data.messages;
      if(!Number.isFinite(record.serverSeconds)||!Number.isSafeInteger(record.baselineId))return uncertain;
      const candidates=recent.filter(m=>m.sender_id===config.humanId&&m.subject===input.agent&&m.content===input.text&&m.id>record.baselineId);
      const match=candidates.filter(m=>m.timestamp>=record.serverSeconds-5);
      if(match.length===1&&candidates.length===1)return complete(record,match[0].id);
      if(candidates.length)return uncertain;
      // An incomplete page cannot establish absence; neither can an in-flight send.
      if(now()-record.startedSeconds*1000<20000||(!result.data.found_oldest&&recent.length>=100&&recent[0].id>record.baselineId))return uncertain;
    }
    record={...input,startedSeconds:Math.floor(now()/1000),serverSeconds:serverOffsetMs===null?null:Math.floor((now()+serverOffsetMs)/1000),baselineId:latestIds.get(input.agent)||0};
    try{storage.setItem(key,JSON.stringify(record));}catch{return {error:'Cannot save delivery receipt. No message sent.'};}
    const result=await request('POST','messages',{type:'stream',to:String(config.streamId),topic:input.agent,content:input.text});
    if(result.error||!Number.isSafeInteger(result.data?.id))return uncertain;
    return complete(record,result.data.id);
  }
  function complete(record,messageId){
    const receipt={id:record.id,agent:record.agent,text:record.text,mock:false,messageId};
    latestIds.set(record.agent,Math.max(latestIds.get(record.agent)||0,messageId));
    try{storage.setItem(receiptKey(record.id),JSON.stringify({...record,receipt}));}catch{return uncertain;}
    return {data:receipt};
  }
  async function dispatch(path,options={}){
    const url=new URL(path,'https://local.invalid');const method=options.method||'GET';
    const agent=url.searchParams.get('agent');
    if(url.pathname==='/api/mode')return {data:{mock:false,scope}};
    if(!conversations.length){const r=await refresh();if(r.error)return r;}
    if(url.pathname==='/api/conversations')return refresh();
    if(agent&&!conversations.some(c=>c.id===agent))return {error:'Unknown agent'};
    if(url.pathname==='/api/messages'){
      const anchor=url.searchParams.get('anchor')||'newest';
      const r=await messages({anchor,num_before:anchor==='newest'?30:15,num_after:anchor==='newest'?0:15,narrow:JSON.stringify(narrow(agent))});
      if(r.error)return r;
      return {data:r.data.messages.filter(m=>[config.humanId,config.botId].includes(m.sender_id)).map(m=>({id:m.id,sender:m.sender_id===config.humanId?'human':'agent',text:m.sender_id===config.botId?route(m.content).text:m.content,unread:!m.flags?.includes('read')}))};
    }
    if(url.pathname==='/api/unread'){
      const r=await messages({anchor:'oldest',num_before:0,num_after:100,narrow:JSON.stringify([...narrow(agent),{operator:'sender',operand:config.botId},{operator:'is',operand:'unread'}])});
      return r.error?r:{data:r.data.messages.filter(m=>m.sender_id===config.botId).map(m=>({id:m.id,agent:m.subject,unread:true,...route(m.content)}))};
    }
    if(url.pathname==='/api/events'){
      const topics=await refresh();if(topics.error)return topics;
      const after=url.searchParams.has('after')?Number(url.searchParams.get('after')):null;
      const r=await messages({anchor:after===null?'newest':after,num_before:after===null?1:0,num_after:after===null?0:100,include_anchor:after===null?'true':'false',narrow:JSON.stringify(narrow())});
      if(r.error)return r;
      const list=r.data.messages.filter(m=>after===null||m.id>after).sort((a,b)=>a.id-b.id);
      return {data:{cursor:list.at(-1)?.id??after??0,conversations,events:after===null?[]:list.filter(m=>m.sender_id===config.botId&&conversations.some(c=>c.id===m.subject)).map(m=>({id:m.id,agent:m.subject,...route(m.content)}))}};
    }
    if(method==='POST'){
      let input;try{input=JSON.parse(options.body);}catch{return {error:'Invalid JSON'};}
      if(url.pathname==='/api/read'){
        if(!Number.isSafeInteger(input?.id)||input.id<1)return {error:'Invalid message ID'};
        const r=await request('POST','messages/flags',{messages:JSON.stringify([input.id]),op:'add',flag:'read'});return r.error?r:{data:{ok:true}};
      }
      if(url.pathname==='/api/send'){
        if(!input||typeof input.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)||!conversations.some(c=>c.id===input.agent)||typeof input.text!=='string'||!input.text.trim()||input.text.length>8000)return {error:'Invalid message or recipient'};
        const running=pending.get(input.id);
        if(running)return running.agent===input.agent&&running.text===input.text?running.result:{error:'Submission ID already used for different content.'};
        const result=(globalThis.navigator?.locks?globalThis.navigator.locks.request(receiptKey(input.id),()=>send(input)):send(input)).finally(()=>pending.delete(input.id));
        pending.set(input.id,{agent:input.agent,text:input.text,result});
        return result;
      }
    }
    return {error:'Not found'};
  }
  return {config,request,async verify(){const r=await request('GET','users/me');return r.error?r:r.data.user_id===config.humanId&&r.data.is_bot===false?{data:true}:{error:'Credentials must belong to the configured human.'};},async fetch(path,options){const r=await dispatch(path,options);return new Response(JSON.stringify(r.error?r:r.data),{status:r.error?409:200,headers:{'Content-Type':'application/json'}});}};
}
