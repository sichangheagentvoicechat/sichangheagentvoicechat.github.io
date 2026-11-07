// 🧑 "Use the server to do STT and TTS instead of the client, i.e., send audio around"
import {resilientFetch} from './resilient-fetch.mjs';
export function createAudio({status,transcribe,clipsChanged=()=>{}}){
  const player=new Audio();let generation=0,controller=null,objectURL=null,unlocked=false,current=null,recordingSession=null;
  const prepared=new Map();
  const clips=[];let nextClip=0,draining=false;
  function notifyClips(){clipsChanged(clips.map(({id,state,error,metadata})=>({id,state,error,metadata})));}
  async function drainClips(){
    if(draining)return;draining=true;
    try{
      while(clips[0]?.state==='ready'){
        const clip=clips[0];
        try{await clip.done(clip.result,clip.metadata);clips.shift();notifyClips();}
        catch(error){clip.state='error';clip.error=error.message;notifyClips();break;}
      }
    }finally{draining=false;}
  }
  async function runClip(clip){
    clip.state='processing';clip.error=null;notifyClips();
    try{clip.result=await transcribe(clip.blob,new AbortController().signal,clip.metadata);clip.state='ready';notifyClips();await drainClips();}
    catch(error){clip.state='error';clip.error=error.message;notifyClips();status('Transcription: '+error.message);clip.failed?.();}
  }
  function retryClip(id){const clip=clips.find(item=>item.id===id);if(clip?.state==='error'){if(clip.result){clip.state='ready';notifyClips();void drainClips();}else void runClip(clip);}}
  async function prepare(text,signal){
    const result=await resilientFetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text}),signal},{retries:0,timeoutMs:10000});
    if(result.error)return {error:result.error};
    if(!result.response.ok)return {error:(await result.response.json()).error};
    if(result.response.headers.get('content-type')?.includes('application/json')){const data=await result.response.json();if(typeof data.audioURL!=='string')return {error:'Invalid audio response.'};const preload=new Audio();preload.preload='auto';preload.src=data.audioURL;return {...data,preload};}
    return {blob:await result.response.blob()};
  }
  function release(item){if(!item)return;item.preload?.pause();item.preload?.removeAttribute('src');if(item.relayId)fetch('/api/audio-ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:item.relayId})}).catch(()=>{});}
  function clearPrepared(){for(const item of prepared.values()){item.controller.abort();item.promise.then(release);}prepared.clear();}
  function prefetch(text){if(!text||prepared.has(text))return;if(prepared.size>=2){const key=prepared.keys().next().value;prepared.get(key).controller.abort();prepared.get(key).promise.then(release);prepared.delete(key);}const controller=new AbortController();prepared.set(text,{controller,promise:prepare(text,controller.signal)});}
  let rate=1;try{rate=Number(localStorage.getItem('voice-speed'))||1;}catch{}
  function setRate(value){rate=Math.round(Math.max(0.5,Math.min(3,value))*10)/10;player.playbackRate=rate;try{localStorage.setItem('voice-speed',String(rate));}catch{}}
  function unlock(){
    if(unlocked||player.src)return;unlocked=true;player.onended=null;player.onerror=null;
    const buffer=new ArrayBuffer(46),view=new DataView(buffer);
    for(const [offset,text] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));
    view.setUint32(4,38,true);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,24000,true);view.setUint32(28,48000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);view.setUint32(40,2,true);
    objectURL=URL.createObjectURL(new Blob([buffer],{type:'audio/wav'}));player.src=objectURL;player.play().catch(()=>{});
  }
  function stop(){generation++;controller?.abort();clearPrepared();player.pause();player.removeAttribute('src');release(current);current=null;if(objectURL)URL.revokeObjectURL(objectURL);objectURL=null;finish();}
  async function speak(text,done,failed,started){
    const token=generation;controller=new AbortController();
    try{
      const cached=prepared.get(text);prepared.delete(text);
      if(cached)controller=cached.controller;
      let result=await(cached?.promise||prepare(text,controller.signal));
      if(cached&&result.error&&token===generation&&!controller.signal.aborted)result=await prepare(text,controller.signal);
      if(result.error)throw new Error(result.error);
      if(token!==generation){release(result);return;}
      current={...result,done,failed,text};
      if(objectURL)URL.revokeObjectURL(objectURL);objectURL=result.blob?URL.createObjectURL(result.blob):null;player.src=result.audioURL||objectURL;
      player.playbackRate=rate;
      player.onloadedmetadata=null;
      player.onended=()=>{if(token===generation){release(current);current=null;done?.();}};
      player.onerror=()=>{if(token===generation){release(current);current=null;status('Audio playback failed. Tap a sentence to retry.');failed?.();}};
      await player.play();
      if(token===generation)started?.();
    }catch(error){if(token!==generation)return;status('Audio: '+error.message);failed?.();}
  }
  // 🧑 "allow another dictation while the previous one is processing"
  async function record(done,failed,metadata,stopped=()=>{}){
    const token=generation;
    try{
      const acquired=await navigator.mediaDevices.getUserMedia({audio:true});
      if(token!==generation){acquired.getTracks().forEach(track=>track.stop());return;}
      const context=new AudioContext(),source=context.createMediaStreamSource(acquired),analyser=context.createAnalyser();
      analyser.fftSize=2048;source.connect(analyser);await context.resume();
      const samples=new Float32Array(analyser.fftSize);
      const session={ended:false,capture:null,interval:null,timeout:null};recordingSession=session;
      function cleanup(){clearInterval(session.interval);clearTimeout(session.timeout);source.disconnect();void context.close();acquired.getTracks().forEach(track=>track.stop());if(recordingSession===session){recordingSession=null;stopped();}}
      function captureChunk(){
        const chunks=[],capture=new MediaRecorder(acquired);session.capture=capture;
        const startMs=performance.now();let lastVoiceMs=startMs;
        capture.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
        capture.onstop=()=>{
          clearInterval(session.interval);
          if(session.ended)cleanup();else captureChunk();
          const blob=new Blob(chunks,{type:capture.mimeType});
          if(blob.size){const clip={id:++nextClip,blob,metadata:{...metadata,id:crypto.randomUUID()},done,failed,state:'processing'};clips.push(clip);void runClip(clip);}
          if(session.ended)status('Transcribing final clip… You can dictate again.');
        };
        capture.start();
        session.interval=setInterval(()=>{
          analyser.getFloatTimeDomainData(samples);let sum=0;for(const value of samples)sum+=value*value;
          const nowMs=performance.now();if(Math.sqrt(sum/samples.length)>0.012)lastVoiceMs=nowMs;
          if(!metadata.confirm&&capture.state==='recording'&&(nowMs-startMs>=8000||(nowMs-startMs>=3000&&nowMs-lastVoiceMs>=450)))capture.stop();
        },50);
      }
      captureChunk();session.timeout=setTimeout(()=>{session.ended=true;if(session.capture.state==='recording')session.capture.stop();},115000);status('Listening. Transcripts appear while you speak.');
    }catch(error){if(token===generation){stopped();status('Microphone: '+error.message);failed();}}
  }
  function finish(){if(recordingSession){recordingSession.ended=true;if(recordingSession.capture?.state==='recording')recordingSession.capture.stop();}}
  function pause(){generation++;controller?.abort();clearPrepared();player.pause();release(current);current=null;}
  return {speak,record,finish,stop,unlock,setRate,pause,prefetch,retryClip,elapsed:()=>current?player.currentTime:0,getRate:()=>rate};
}
