/**
 * Guided phone test: is the user's voice detectable while the app plays speech, with echoCancellation on and off?
 * Per mode, three timed phases: (a) playback + silent user, (b) playback + user says the commands, (c) user speaks, no playback.
 * Measures VAD-active fraction (the v2 `recorder.mjs` rule) and levels per phase, optionally STT of (b) and (c), then sends one report with the relay `log` op.
 */
import {createZulip, createEvents} from './zulip.mjs';
import {createVoice} from './voice.mjs';

const PHASES = [
  {id: 'a', play: true, ms: 8000, say: false, text: 'Playing. Stay SILENT.'},
  {id: 'b', play: true, ms: 8000, say: true, text: 'Playing. SAY: "pause, next, resume" (repeat)'},
  {id: 'c', play: false, ms: 5000, say: true, text: 'No playback. SAY: "pause, next, resume" (repeat)'},
];
const SETTLE_MS = 2500, TARGET_HZ = 16000, MIN_LEVEL = 0.012;
const WORKLET = `registerProcessor('cap', class extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) { const ch = inputs[0][0]; if (!ch) return true;
    for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === 2048) { this.port.postMessage(this.buf.slice()); this.n = 0; } }
    return true; }
});`;
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = [];
const log = (cat, msg) => out.push(`${new Date().toISOString().slice(11, 23)} ${cat} ${msg}`);

const cfg = JSON.parse(localStorage.getItem('zulip-voice-account') || 'null');
const zulip = cfg?.relayStreamId ? createZulip(cfg, log) : null;
const voice = zulip && createVoice({zulip, cfg, log});
const audio = $('tts');
audio.setAttribute('playsinline', '');

const pct = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
const dbOf = v => 20 * Math.log10(v + 1e-9);

/** Mono 16-bit WAV at 16 kHz from float frames recorded at `hz` (box-average resampling). */
function wavOf(frames, hz) {
  const flat = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) { flat.set(f, at); at += f.length; }
  const n = Math.floor(flat.length * TARGET_HZ / hz), view = new DataView(new ArrayBuffer(44 + 2 * n)), ratio = hz / TARGET_HZ;
  const ascii = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, 36 + 2 * n, true); ascii(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_HZ, true); view.setUint32(28, TARGET_HZ * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, 2 * n, true);
  for (let i = 0; i < n; i++) {
    const from = Math.floor(i * ratio), to = Math.max(from + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j++) sum += flat[j];
    view.setInt16(44 + 2 * i, Math.max(-1, Math.min(1, sum / (to - from))) * 32767, true);
  }
  return new Blob([view], {type: 'audio/wav'});
}

/** Opens the mic with all processing flags = `aec`; resolves to `{track settings, setPhase(id), close()}` collecting frames per phase. */
async function openMic(aec) {
  try { navigator.audioSession.type = 'play-and-record'; } catch { /* unsupported */ }
  const ctx = new AudioContext();
  const resumed = ctx.resume();
  const stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: aec, noiseSuppression: aec, autoGainControl: aec}});
  await resumed;
  const url = URL.createObjectURL(new Blob([WORKLET], {type: 'text/javascript'}));
  await ctx.audioWorklet.addModule(url);
  const node = new AudioWorkletNode(ctx, 'cap'), source = ctx.createMediaStreamSource(stream);
  const sink = ctx.createGain(); sink.gain.value = 0;   // keep the graph pulled without playing the mic
  node.connect(sink); sink.connect(ctx.destination); source.connect(node);
  stream.getAudioTracks()[0].addEventListener('ended', () => log('mic', 'track ended (route change?)'));
  const frames = {}, state = {phase: null};
  node.port.onmessage = ({data}) => { if (state.phase) (frames[state.phase] ??= []).push(data); };
  return {
    settings: stream.getAudioTracks()[0].getSettings?.() ?? {}, hz: ctx.sampleRate, frames,
    setPhase: id => { state.phase = id; },
    state: () => ctx.state,
    close: () => { node.disconnect(); source.disconnect(); stream.getTracks().forEach(t => t.stop()); ctx.close().catch(() => {}); try { navigator.audioSession.type = 'playback'; } catch { /* unsupported */ } },
  };
}

/** Metrics for one phase: VAD-active fraction by the v2 rule (floor carried over from the previous settle period via `noise`), level percentiles in dBFS. */
function measure(frames, hz, noise0) {
  let noise = noise0, on = 0;
  const levels = frames.map(f => Math.sqrt(f.reduce((s, v) => s + v * v, 0) / f.length));
  for (const l of levels) { const speaking = l > Math.max(MIN_LEVEL, noise * 3); if (speaking) on++; else noise = noise * 0.98 + l * 0.02; }
  const sorted = [...levels].sort((x, y) => x - y);
  return {vadFraction: on / levels.length, medianDb: dbOf(pct(sorted, 0.5)), p90Db: dbOf(pct(sorted, 0.9)), maxDb: dbOf(sorted.at(-1) ?? 0), floor: noise, n: levels.length};
}

async function countdown(text, ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) { $('prompt').textContent = `${text}  ${Math.ceil((end - performance.now()) / 1000)}s`; await sleep(100); }
}

async function runMode(aec, plan) {
  const name = aec ? 'echoCancellation ON' : 'echoCancellation OFF';
  const mic = await openMic(aec);
  const mode = {name, aec, settings: mic.settings, hz: mic.hz, phases: {}, clips: {}};
  let noise = 0.004;
  mic.setPhase('settle0'); await countdown(`${name}: get ready, quiet`, SETTLE_MS);
  for (const ph of PHASES) {
    audio.currentTime = 0;
    mic.setPhase('settle'); await countdown(`${name}: next phase ${ph.id.toUpperCase()}, stay quiet`, 1200);
    mic.setPhase(ph.id);
    if (ph.play) audio.play().catch(e => log('audio', 'play() rejected ' + e.name));
    await countdown(`${name} ${ph.id.toUpperCase()}: ${ph.text}`, ph.ms);
    mic.setPhase(null); audio.pause();
    const quiet = mic.frames.settle ?? [];
    if (quiet.length) { noise = measure(quiet, mic.hz, noise).floor; mic.frames.settle = []; }
    mode.phases[ph.id] = measure(mic.frames[ph.id] ?? [], mic.hz, ph.play ? 0.004 : noise);
    if (ph.say && mic.frames[ph.id]?.length) mode.clips[ph.id] = wavOf(mic.frames[ph.id], mic.hz);
    else if (ph.say) log('mic', `no frames in phase ${ph.id} (mic stalled? ctx ${mic.state()})`);
    render(plan);
  }
  mic.close();
  return mode;
}

const f = n => (n * 100).toFixed(0) + '%', d = n => n.toFixed(1);
function modeLine(m) {
  const P = m.phases, row = id => P[id] ? `${id}: VAD ${f(P[id].vadFraction)}, level median ${d(P[id].medianDb)} p90 ${d(P[id].p90Db)} dBFS` : `${id}: -`;
  const margin = P.c && P.a ? `speech-vs-echo margin (c p90 - a p90): ${d(P.c.p90Db - P.a.p90Db)} dB; b p90 - a p90: ${P.b ? d(P.b.p90Db - P.a.p90Db) : '-'} dB` : '';
  const stt = Object.entries(m.transcripts ?? {}).map(([id, t]) => `stt ${id}: "${t}"`).join(' | ');
  return `${m.name}  (sampleRate ${m.hz}; settings ${JSON.stringify(m.settings)})\n  ${row('a')}\n  ${row('b')}\n  ${row('c')}\n  ${margin}${stt ? '\n  ' + stt : ''}`;
}

function features() {
  let simd = false;
  try { simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch { /* no */ }
  return {ua: navigator.userAgent, webgl2: !!document.createElement('canvas').getContext('webgl2'), wasmSimd: simd, audioWorklet: !!window.AudioWorklet, webgpu: !!navigator.gpu,
    audioSession: 'audioSession' in navigator, supportedConstraints: navigator.mediaDevices?.getSupportedConstraints?.() ?? null};
}

const modes = [];
const wait = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ok: false, error: 'timeout'}))]);
/** Sends `text` with the relay `log` op until the relay's result arrives (`sendLog` resolves ok only then); shows progress; returns `{ok, tries}`. */
async function deliver(label, text) {
  if (!voice) return {ok: false, tries: 0, error: 'no stored account'};
  let last;
  for (let tries = 1; tries <= 6; tries++) {
    $('delivery').textContent = `Sending "${label}" to server (try ${tries})…`;
    ensureEvents();
    last = await wait(voice.sendLog(label, text), 20000);
    if (last.ok) { $('delivery').textContent = `delivered to server \u2713 (${label}, try ${tries}, ${new Date().toLocaleTimeString()})`; return {ok: true, tries}; }
    log('deliver', `${label} try ${tries} failed: ${last.error}`);
    $('delivery').textContent = `NOT delivered (${label}: ${last.error}); retrying…`;
    await sleep(2000 * tries);
  }
  $('delivery').textContent = `NOT delivered (${label}: ${last.error}). Tap Copy and paste it to the agent.`;
  return {ok: false, tries: 6, error: last.error};
}
document.addEventListener('visibilitychange', () => log('page', 'visibility ' + document.visibilityState));
const reportText = (route, final) => `voicecmd ${final ? 'FINAL' : 'partial'} ${new Date().toISOString()}\noutput route (user says): ${route}\n${JSON.stringify(features())}\n\n${modes.map(modeLine).join('\n')}\n\n${out.slice(-30).join('\n')}`;
function render(route) { $('results').textContent = reportText(route, false); }

let events = null;
function ensureEvents() {
  events ??= createEvents({zulip, log, eventTypes: ['message'], onInit() {}, onEvent: ev => { if (ev.type === 'message') voice.onMessage(ev.message); }, onState() {}});
  events.start();
}

async function start() {
  $('start').disabled = true;
  const route = document.querySelector('input[name=route]:checked').value;
  audio.src = SILENCE; audio.play().then(() => audio.pause(), () => {});   // iOS: prime the element inside the tap
  if (voice) ensureEvents();
  await sleep(300);
  deliver('voicecmd-start', reportText(route, false));
  audio.src = 'speech.m4a'; audio.load();
  try {
    for (const aec of [true, false]) { modes.push(await runMode(aec, route)); }
  } catch (e) {
    log('error', `${e.name} ${e.message}`);
    $('prompt').textContent = `Failed: ${e.name} ${e.message}`;
    $('results').textContent = reportText(route, false);
    await deliver('voicecmd-error', reportText(route, false));
    return;
  }
  $('prompt').textContent = 'Done speaking. Sending measurements, then transcribing…';
  window.__voicecmd.mid = await deliver('voicecmd-measurements', reportText(route, false));
  if (voice) {
    for (const m of modes) {
      m.transcripts = {};
      for (const id of Object.keys(m.clips)) { const r = await wait(voice.stt(m.clips[id]), 30000); m.transcripts[id] = r.ok ? r.text : 'ERROR ' + r.error; render(route); }
    }
  }
  const text = reportText(route, true);
  $('results').textContent = text;
  window.__voicecmd.text = text;
  const sent = await deliver('voicecmd', text);
  $('prompt').textContent = sent.ok ? 'Done. Report delivered to the server (confirmed). Now run again with the other output (speaker / earbuds).' : `Done. NOT delivered (${sent.error}); use Copy.`;
  window.__voicecmd.done = true; window.__voicecmd.sent = sent;
  $('start').disabled = false; $('start').textContent = 'Run again';
}

$('start').onclick = start;
$('copy').onclick = async e => { const text = window.__voicecmd.text ?? reportText('?', false); try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; } catch { window.prompt('Copy:', text); } };
window.__voicecmd = {modes};
$('account').textContent = cfg ? 'Stored account found: results will be sent to the server.' : 'No stored account: open the app and sign in first (results can only be copied).';
