/** On-phone checks for what desktop tests cannot show. Each step returns a detail string or throws; results are copyable. */
import {createZulip, createEvents} from './zulip.mjs?v=e7878dbf3a';
import {createVoice} from './voice.mjs?v=e7878dbf3a';
import {createRecorder} from './recorder.mjs?v=e7878dbf3a';

const cfg = JSON.parse(localStorage.getItem('zulip-voice-account') || 'null');
const results = [];
const out = [];
const log = (cat, msg) => out.push(`${new Date().toISOString().slice(11, 23)} ${cat} ${msg}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
let zulip, voice, events, evState = [];
if (cfg) {
  zulip = createZulip(cfg, log);
  voice = createVoice({zulip, cfg, log});
}
const need = () => { if (!cfg?.relayStreamId) throw Error('No stored account; open the app and sign in first'); };
const clip = async text => { const r = await voice.tts(text); if (!r.ok) throw Error(r.error); return r.clip; };
const audioEl = () => Object.assign(new Audio(), {preload: 'auto'});
const playUrl = (el, url) => new Promise((resolve, reject) => {
  el.src = url; el.onended = () => resolve(performance.now()); el.onerror = () => reject(Error('media error ' + el.error?.code));
  el.play().catch(reject);
});
const T = (t0) => Math.round(performance.now() - t0) + 'ms';
const ensureEvents = () => {
  if (events) return;
  events = createEvents({zulip, log, eventTypes: ['message'], onInit() {}, onEvent: e => { if (e.type === 'message') voice.onMessage(e.message); }, onState: i => { if (evState.at(-1) !== i.state) evState.push(i.state); }});
  events.start();
};
/** Posts a ping and resolves with ms until its result arrives over the event queue. */
const pingViaEvents = async () => { const t0 = performance.now(); const r = await voice.ping(); if (!r.ok) throw Error(r.error); return T(t0); };
const waitState = async (pred, ms, what) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(200)) if (pred()) return; throw Error('timeout: ' + what); };
let gestureEls;
if (cfg?.relayStreamId) ensureEvents();

const steps = [
  {name: '1. Account and relay ping', hint: 'Zulip login plus a round trip to the voice service.', async run() {
    need();
    const me = await zulip.call('GET', 'users/me');
    if (!me.ok) throw Error(me.error);
    const t0 = performance.now(); const p = await voice.ping();
    if (!p.ok) throw Error(p.error);
    return `user ${me.data.user_id}; ping ${T(t0)}; stt=${p.workers.stt} tts=${p.workers.tts}; relay up ${p.uptimeS}s`;
  }},
  {name: '2. Audio unlock after tap', hint: 'Primes two audio elements in this tap, then plays on them 3 s later with no tap. Must be allowed.', async run() {
    need();
    gestureEls = [audioEl(), audioEl()];
    for (const el of gestureEls) { el.src = SILENCE; await el.play(); el.pause(); }
    const c = await clip('Audio unlock check.');
    const url = (await voice.clipUrl(c)).url;
    await sleep(3000);
    const t0 = performance.now();
    await playUrl(gestureEls[1], url);
    return `second element played without a tap; ${T(t0)}`;
  }},
  {name: '3. Speech round trip and playback', hint: 'Asks the server for speech and plays it. You should hear a sentence.', async run() {
    need();
    const t0 = performance.now();
    const c = await clip('This is a speech round trip test from the server.');
    const ready = T(t0);
    const el = gestureEls?.[0] ?? audioEl();
    const t1 = performance.now();
    await playUrl(el, (await voice.clipUrl(c)).url);
    return `audio ready ${ready}; played ${T(t1)}; relay durationMs=${c.durationMs}`;
  }},
  {name: '4. Two clips, second element stall', hint: 'Plays clip A while loading clip B on a second element, as the old player did. Reports the longest freeze of A and the gap to B.', async run() {
    need();
    const [a, b] = await Promise.all([clip('The first clip is playing while the second one loads on another element.'), clip('Now the second clip follows the first.')]);
    const [ua, ub] = [(await voice.clipUrl(a)).url, (await voice.clipUrl(b)).url];
    const A = gestureEls?.[0] ?? audioEl(), B = gestureEls?.[1] ?? audioEl();
    let last = performance.now(), maxFreeze = 0, lastT = -1;
    const timer = setInterval(() => { const now = performance.now(); if (A.currentTime !== lastT) { lastT = A.currentTime; last = now; } else if (!A.ended && !A.paused) maxFreeze = Math.max(maxFreeze, now - last); }, 100);
    setTimeout(() => { B.src = ub; B.load(); }, 1000);
    const endA = await playUrl(A, ua);
    clearInterval(timer);
    B.src = ub;
    const startB = performance.now();
    await playUrl(B, ub);
    const loadWhilePlayingFreeze = Math.round(maxFreeze);
    return `A froze up to ${loadWhilePlayingFreeze}ms while B loaded (over 700 = stall); next clip started within ${Math.round(startB - endA)}ms of A ending`;
  }, failIf: d => /froze up to (\d+)/.test(d) && +d.match(/froze up to (\d+)/)[1] > 700},
  {name: '5. Microphone, recording and transcription', hint: 'Allow the microphone, then say a short sentence and pause. Records 8 s.', async run() {
    need();
    const clips = [], texts = [];
    const rec = createRecorder({log, onClip: b => clips.push(b), onLevel() {}});
    const t0 = performance.now();
    const s = await rec.start();
    if (!s.ok) throw Error(s.error);
    const permMs = T(t0);
    await sleep(8000);
    rec.stop();
    if (!clips.length) throw Error('recorded no speech (mic started in ' + permMs + ')');
    for (const c of clips) { const t1 = performance.now(); const r = await voice.stt(c); if (!r.ok) throw Error(r.error); texts.push(`"${r.text}" (${T(t1)})`); }
    return `mic start ${permMs}; ${clips.length} clip(s) ${clips.map(c => c.size + 'B').join(',')}; ${texts.join(' ')}`;
  }},
  {name: '6. Reconnect after airplane mode', hint: 'Tap Run, then turn airplane mode ON for ~10 s and OFF again. Waits up to 90 s.', async run() {
    need(); ensureEvents(); evState = [];
    await waitState(() => events.info().state === 'live', 20000, 'connection live before test');
    await waitState(() => evState.some(s => s !== 'live'), 60000, 'app noticing the network loss (did you enable airplane mode?)');
    const t0 = performance.now();
    await waitState(() => events.info().state === 'live', 60000, 'live again after the network returned');
    const back = T(t0);
    return `live again ${back} after network returned; ping over event queue ${await pingViaEvents()}`;
  }},
  {name: '7. Background / lock resume', hint: 'Tap Run, then lock the phone (or switch app) for 20 s and come back. Waits up to 120 s.', async run() {
    need(); ensureEvents();
    await waitState(() => events.info().state === 'live', 20000, 'connection live before test');
    await waitState(() => document.visibilityState === 'hidden', 60000, 'page being hidden (lock or switch app)');
    await waitState(() => document.visibilityState === 'visible', 120000, 'coming back');
    const t0 = performance.now();
    await waitState(() => events.info().state === 'live' && events.info().lastOkAgoMs < 4000, 30000, 'event loop live after resume');
    return `event loop live ${T(t0)} after return; ping over event queue ${await pingViaEvents()}`;
  }},
];

const root = document.getElementById('steps');
steps.forEach((step, i) => {
  const el = document.createElement('div'); el.className = 'step';
  el.innerHTML = `<h2></h2><small></small><button>Run</button><div class="res"></div>`;
  el.querySelector('h2').textContent = step.name; el.querySelector('small').textContent = step.hint;
  const btn = el.querySelector('button'), res = el.querySelector('.res');
  btn.onclick = async () => {
    btn.disabled = true; res.className = 'res run'; res.textContent = 'running…';
    const t0 = performance.now();
    let r;
    try { const d = await step.run(); r = {pass: !step.failIf?.(d), detail: d}; }
    catch (e) { r = {pass: false, detail: e.message}; }
    r.ms = Math.round(performance.now() - t0); r.name = step.name; results[i] = r;
    log('step', `${step.name}: ${r.pass ? 'PASS' : 'FAIL'} ${r.detail}`);
    voice?.sendLog('selftest', report()).then(x => { res.dataset.sent = x.ok ? 'sent' : 'unsent'; });
    res.className = 'res ' + (r.pass ? 'pass' : 'fail');
    res.textContent = `${r.pass ? 'PASS' : 'FAIL'} (${r.ms}ms)\n${r.detail}`;
    btn.disabled = false; btn.textContent = 'Run again';
  };
  root.append(el);
});
const report = () => `voice self-test ${new Date().toISOString()}\n${navigator.userAgent}\n` + steps.map((s, i) => results[i] ? `${results[i].pass ? 'PASS' : 'FAIL'} ${s.name} (${results[i].ms}ms) ${results[i].detail}` : `SKIP ${s.name}`).join('\n') + '\n\n' + out.slice(-60).join('\n');
document.getElementById('all').onclick = async e => {
  const text = report();
  voice?.sendLog('selftest-manual', text);
  try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; } catch { prompt('Copy:', text); }
  setTimeout(() => { e.target.textContent = 'Copy / send results'; }, 2000);
};
window.__selftest = {results, out};
