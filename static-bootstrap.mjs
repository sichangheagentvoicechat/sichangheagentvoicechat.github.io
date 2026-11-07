/** Unpublished static mode: credentials remain on this browser origin. */
import {createBrowserZulip} from './browser-zulip.mjs';
import {createBrowserRelay} from './browser-relay.mjs';
const nativeFetch=window.fetch.bind(window),storageKey='zulip-voice-account';
window.voiceBrowserOnly=true;
let config;try{config=JSON.parse(localStorage.getItem(storageKey));}catch{}
async function login(previous){
  const dialog=document.createElement('dialog');
  dialog.innerHTML='<form><h2>Voice</h2><p>A personal client. Paste your zuliprc once. Your key stays in this browser storage.</p><label>Account configuration<textarea name="zuliprc" required autocomplete="off" spellcheck="false"></textarea></label><p role="status"></p><button>Connect</button></form>';
  document.body.append(dialog);dialog.showModal();const form=dialog.querySelector('form');
  for(const [key,value] of Object.entries(previous||{site:'https://shagent.zulipchat.com',streamId:642517,botId:1212502}))if(form.elements.namedItem(key))form.elements.namedItem(key).value=value;
  return new Promise(resolve=>{form.onsubmit=async event=>{event.preventDefault();const values={};let section='';for(const line of form.elements.zuliprc.value.split(/\r?\n/)){const text=line.trim();if(text.startsWith('[')){section=text;continue;}const match=text.match(/^(site|email|key)\s*=\s*(.+)$/);if(section==='[api]'&&match)values[match[1]]=match[2].trim();}try{const site=new URL(values.site);if(site.protocol!=='https:')throw new Error('Use an HTTPS Zulip site.');const result=await nativeFetch(site.origin+'/api/v1/users/me',{headers:{Authorization:'Basic '+btoa(values.email+':'+values.key)},signal:AbortSignal.timeout(15000)});const me=await result.json();if(!result.ok||me.is_bot!==false)throw new Error('Use your human Zulip API credentials.');const next={...values,site:site.origin,humanId:me.user_id,streamId:642517,botId:1212502};localStorage.setItem(storageKey,JSON.stringify(next));dialog.remove();resolve(next);}catch(error){form.querySelector('[role=status]').textContent=error.message;}};});
}
if(!config)config=await login();
let adapter=createBrowserZulip(config,{fetch:nativeFetch,storage:localStorage});
if((await adapter.verify()).error){config=await login(config);adapter=createBrowserZulip(config,{fetch:nativeFetch,storage:localStorage});}
const relay=createBrowserRelay(adapter,nativeFetch);
const account=document.createElement('button');account.textContent='Account';account.onclick=()=>{localStorage.removeItem(storageKey);location.reload();};document.querySelector('header').append(account);
window.fetch=async(input,options={})=>{
  const path=typeof input==='string'?input:new URL(input.url).pathname;
  if(path==='/api/audio-ack'){await relay.release(JSON.parse(options.body).id);return new Response('{}',{headers:{'Content-Type':'application/json'}});}
  if(path.startsWith('/api/tts')||path.startsWith('/api/stt'))return relay.fetch(path,options);
  if(path.startsWith('/api/'))return adapter.fetch(path,options);
  return nativeFetch(input,options);
};
