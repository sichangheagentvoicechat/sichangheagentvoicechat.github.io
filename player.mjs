/**
 * Clip queue on two always-reused `<audio>` elements, alternating. Clips and their URLs are prepared ahead, but the next element is
 * loaded only after the current clip ends: loading a second element while one plays stalls playback in WebKit (measured 1.2 s).
 * iOS lets an element play without a gesture only after it has played once from a gesture, so `unlock()` primes both
 * and nothing else ever creates an element. Cross-origin clips need real media elements (no CORS for fetch/WebAudio).
 *
 * Status: `idle` (nothing queued), `loading` (waiting for audio data), `playing`, `paused`, `blocked` (needs a tap), `error` (will retry).
 */
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const AHEAD = 3;
const URL_FRESH_MS = 25000;
const STALL_MS = 7000;
const MAX_ATTEMPTS = 3;

export function createPlayer({log, voice, onItemStart, onItemEnd, onIdle, onStatus}) {
  const slots = [0, 1].map(() => ({el: Object.assign(new Audio(), {preload: 'auto', playsInline: true}), index: -1, ready: false}));
  for (const slot of slots) { slot.el.setAttribute('playsinline', ''); slot.el.hidden = true; document.body.append(slot.el); }
  let items = [], index = -1, active = null, status = 'idle', gen = 0, unlocked = false, error = '';
  let rate = 1, lastTimeMs = 0, lastProgressMs = 0;
  const clips = new Map();
  try { navigator.audioSession.type = 'playback'; } catch { /* unsupported */ }

  const setStatus = next => { if (next !== status) { log('audio', `${status} -> ${next}${index >= 0 ? ' item ' + index : ''}${next === 'error' ? ' ' + error : ''}`); status = next; } onStatus?.({status, index, error}); };

  /** Starts (or reuses) the request for `i`'s clip: a promise of `{ok, clip}` and its attempt count. */
  function clipFor(i) {
    if (!items[i]) return null;
    let entry = clips.get(i);
    if (!entry) {
      entry = {promise: voice.tts(items[i].text, items[i].key)};
      entry.url = entry.promise.then(r => r.ok ? voice.clipUrl(r.clip, URL_FRESH_MS) : r);
      clips.set(i, entry);
      entry.url.then(r => log('audio', `clip ${i} ${r.ok ? 'ready' : 'failed ' + r.error}`));
    }
    return entry;
  }
  const prefetch = from => { for (let i = from; i < Math.min(items.length, from + AHEAD); i++) clipFor(i); };

  /** Loads item `i` into the idle slot and resolves with it once playable, or `{error}`. */
  async function attach(i, myGen) {
    const r = await clipFor(i).url;
    if (myGen !== gen) return {stale: true};
    if (!r.ok) { clips.delete(i); return {error: r.error}; }
    const slot = slots.find(s => s !== active) ?? slots[0];
    slot.index = i; slot.ready = false;
    slot.el.src = r.url;
    slot.el.playbackRate = rate;
    slot.el.load();
    const loaded = await new Promise(resolve => {
      const done = ok => { slot.el.removeEventListener('canplay', onOk); slot.el.removeEventListener('error', onErr); clearTimeout(timer); resolve(ok); };
      const onOk = () => done(true), onErr = () => done(false);
      const timer = setTimeout(() => done(false), 15000);
      slot.el.addEventListener('canplay', onOk); slot.el.addEventListener('error', onErr);
      if (slot.el.readyState >= 3) done(true);
    });
    if (myGen !== gen) return {stale: true};
    if (!loaded) { clips.delete(i); slot.index = -1; return {error: 'audio failed to load'}; }
    slot.ready = true;
    return {slot};
  }

  async function playIndex(i, attempt = 0) {
    const myGen = ++gen;
    index = i;
    const item = items[i];
    if (!item) { active = null; setStatus('idle'); onIdle?.(); return; }
    if (status !== 'paused') setStatus('loading');
    prefetch(i);
    const r = await attach(i, myGen);
    if (r.stale) return;
    if (r.error) {
      error = r.error;
      setStatus('error');
      if (attempt + 1 < MAX_ATTEMPTS) { await new Promise(res => setTimeout(res, 1000 * 2 ** attempt)); if (myGen === gen) playIndex(i, attempt + 1); }
      return;
    }
    if (status === 'paused') { active = r.slot; return; }
    start(r.slot, myGen);
  }

  function start(slot, myGen) {
    for (const s of slots) if (s !== slot) s.el.pause();
    active = slot;
    slot.el.playbackRate = rate;
    const promise = slot.el.play();
    lastProgressMs = performance.now(); lastTimeMs = 0;
    promise.then(() => {
      if (myGen !== gen) return;
      setStatus('playing');
      onItemStart?.(items[slot.index], slot.index);
      prefetch(slot.index + 1);
    }, err => {
      if (myGen !== gen) return;
      log('audio', `play() rejected: ${err.name}`);
      if (err.name === 'NotAllowedError') setStatus('blocked'); else { error = err.name; setStatus('error'); }
    });
  }

  for (const slot of slots) {
    slot.el.addEventListener('ended', () => {
      if (slot !== active) return;
      const done = slot.index;
      log('audio', `ended ${items[done]?.key}`);
      slot.ready = false; slot.index = -1;
      clips.delete(done);
      voice.release?.(items[done] ?? {});
      const before = gen;
      onItemEnd?.(items[done], done);
      if (gen !== before) return; // `onItemEnd` replaced the queue
      playIndex(done + 1);
    });
    for (const name of ['waiting', 'stalled', 'error', 'suspend', 'emptied']) slot.el.addEventListener(name, () => { if (slot === active) log('audio', `el ${name} t=${slot.el.currentTime.toFixed(2)} rs=${slot.el.readyState}`); });
  }

  setInterval(() => {
    if (status !== 'playing' || !active) return;
    const t = active.el.currentTime;
    if (t !== lastTimeMs) { lastTimeMs = t; lastProgressMs = performance.now(); }
    else if (performance.now() - lastProgressMs > STALL_MS) { log('audio', `stalled ${STALL_MS}ms at item ${index}; reloading`); clips.delete(index); active.index = -1; active.ready = false; playIndex(index); }
  }, 1000);

  return {
    /** Call inside a user gesture. */
    unlock() {
      if (!unlocked) {
        unlocked = true;
        for (const slot of slots) if (slot !== active && !slot.ready) { slot.el.src = SILENCE; slot.el.play().then(() => { if (slot.el.src === SILENCE) slot.el.pause(); }, err => { if (err.name === 'NotAllowedError') unlocked = false; }); }
        log('audio', 'unlocked by gesture');
      }
      if (status === 'blocked') start(active, gen);
    },
    isUnlocked: () => unlocked,
    /** Replaces the queue and plays `startIndex`. */
    play(newItems, startIndex = 0) { items = newItems; clips.clear(); for (const s of slots) { s.index = -1; s.ready = false; } if (status === 'paused') status = 'idle'; playIndex(startIndex); },
    /** Adds items; if the queue had drained, plays the first new one. */
    append(more) { const wasIdle = status === 'idle' && index >= items.length - 1; items = items.concat(more); if (wasIdle && more.length) playIndex(items.length - more.length); else if (status === 'playing') prefetch(index + 1); },
    pause() { if (status === 'playing' || status === 'loading' || status === 'blocked') { active?.el.pause(); setStatus('paused'); } },
    resume() { if (status === 'paused') { if (active?.ready) { setStatus('loading'); const myGen = ++gen; start(active, myGen); } else playIndex(index); } else if (status === 'error') playIndex(index); },
    retry() { if (status === 'error' || status === 'blocked') playIndex(index); },
    stop() { gen++; for (const s of slots) { s.el.pause(); s.index = -1; s.ready = false; } clips.clear(); items = []; index = -1; active = null; setStatus('idle'); },
    setRate(value) { rate = value; for (const s of slots) { s.el.playbackRate = value; s.el.defaultPlaybackRate = value; } },
    position: () => ({index, status, queued: items.length}),
    snapshot: () => ({status, index, queued: items.length, rate, unlocked, slots: slots.map(s => ({index: s.index, ready: s.ready, paused: s.el.paused, t: +s.el.currentTime.toFixed(1), rs: s.el.readyState})), clips: clips.size}),
  };
}
