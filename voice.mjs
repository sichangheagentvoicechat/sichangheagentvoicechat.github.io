/** Client of the voice service (`service/protocol.md`): STT, TTS, ping through the relay channel. Results arrive via `onMessage`. */

const URL_TTL_MS = 50000;
const PREPARED_TTL_MS = 14 * 60000;
const newId = prefix => prefix + '_' + Array.from(crypto.getRandomValues(new Uint8Array(9)), b => b.toString(16).padStart(2, '0')).join('');

export function createVoice({zulip, cfg, log}) {
  const pending = new Map();
  const prepared = new Map();
  const unacked = new Set();
  let ackTimer = null;

  /** Feed every event message; consumes this service's results. */
  function onMessage(message) {
    if (message.stream_id !== cfg.relayStreamId || message.sender_id !== cfg.botId) return;
    let body;
    try { body = JSON.parse(message.content); } catch { return; }
    if (body?.voice !== 1 || body.op !== 'result') return;
    const waiter = pending.get(body.id);
    if (waiter) { pending.delete(body.id); waiter(body); }
    else if (body.proactive && body.audioURL) {
      prepared.set(`${body.messageId}:${body.sentence}`, {...body, arrivedMs: Date.now()});
      for (const [key, entry] of prepared) if (Date.now() - entry.arrivedMs > PREPARED_TTL_MS) prepared.delete(key);
    }
  }

  /** Loads clips the service pre-rendered while this client was not connected. */
  async function backfill() {
    const r = await zulip.call('GET', 'messages', {narrow: [{operator: 'stream', operand: cfg.relayStreamId}, {operator: 'topic', operand: 'tts'}], anchor: 'newest', num_before: 100, num_after: 0, apply_markdown: false});
    if (!r.ok) return;
    for (const m of r.data.messages) onMessage(m);
    log('relay', `backfilled ${prepared.size} prepared clips`);
  }

  /** Posts a request and waits for its result: `{ok: true, result}` or `{ok: false, error}`. */
  async function request(op, fields, timeoutMs) {
    const id = newId(op);
    const sentMs = performance.now();
    const waiting = new Promise(resolve => {
      pending.set(id, resolve);
      setTimeout(() => { if (pending.delete(id)) resolve(null); }, timeoutMs);
    });
    const posted = await zulip.call('POST', 'messages', {type: 'stream', to: cfg.relayStreamId, topic: op, content: JSON.stringify({voice: 1, id, op, ...fields})});
    if (!posted.ok) { pending.delete(id); return {ok: false, error: posted.error}; }
    const postedMs = performance.now() - sentMs;
    const result = await waiting;
    const totalMs = Math.round(performance.now() - sentMs);
    if (!result) { log('relay', `${op} ${id} timeout after ${totalMs}ms`); return {ok: false, error: `${op} timed out`}; }
    log('relay', `${op} ${id} ${result.error ? 'ERROR ' + result.error : 'ok'} total=${totalMs}ms post=${Math.round(postedMs)}ms relay queue=${result.timings?.queueMs}ms work=${result.timings?.workMs}ms`);
    return result.error ? {ok: false, error: result.error} : {ok: true, result, totalMs};
  }

  /** `{ok: true, clip}` where `clip = {uri, audioURL, arrivedMs, durationMs}`; uses the pre-rendered clip of agent message chunk `key` when it matches `text`. */
  async function tts(text, key) {
    const hit = key && prepared.get(key);
    if (hit?.text === text) { log('relay', `tts ${key} prepared hit age=${Math.round((Date.now() - hit.arrivedMs) / 1000)}s`); return {ok: true, clip: hit}; }
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await request('tts', {text}, 20000);
      if (r.ok) return {ok: true, clip: {...r.result, arrivedMs: Date.now()}};
      if (r.error !== 'tts timed out' && !/post|network|timeout/i.test(r.error)) return r;
    }
    return {ok: false, error: 'speech service unreachable'};
  }

  /** `{ok: true, text}` for a WAV blob. */
  async function stt(blob) {
    const form = new FormData();
    form.append('file', blob, `dictation-${Date.now()}.wav`);
    const up = await zulip.call('POST', 'user_uploads', form, {timeoutMs: 30000});
    if (!up.ok) return {ok: false, error: up.error};
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await request('stt', {uri: up.data.uri, attachment: `[audio](${up.data.uri})`}, 25000);
      if (r.ok) return {ok: true, text: r.result.text.trim()};
      if (attempt) return r;
    }
  }

  /** A playable URL for `clip`, minting a new one when the old one is about to expire. */
  async function clipUrl(clip, maxAgeMs = URL_TTL_MS) {
    if (Date.now() - clip.arrivedMs < maxAgeMs) return {ok: true, url: clip.audioURL};
    const r = await zulip.call('GET', clip.uri.slice(1));
    if (!r.ok) return {ok: false, error: 'clip expired'};
    Object.assign(clip, {audioURL: new URL(r.data.url, cfg.site).href, arrivedMs: Date.now()});
    return {ok: true, url: clip.audioURL};
  }

  /** Batches deletion of one-off clips on the server. */
  function release(clip) {
    if (clip.proactive || !clip.id) return;
    unacked.add(clip.id);
    ackTimer ??= setTimeout(async () => {
      const ids = [...unacked];
      unacked.clear();
      ackTimer = null;
      await zulip.call('POST', 'messages', {type: 'stream', to: cfg.relayStreamId, topic: 'ack', content: JSON.stringify({voice: 1, id: newId('ack'), op: 'ack', ids})});
    }, 8000);
  }

  async function ping() {
    const r = await request('ping', {t: Date.now()}, 15000);
    return r.ok ? {ok: true, ...r.result, totalMs: r.totalMs} : r;
  }

  return {onMessage, backfill, tts, stt, clipUrl, release, ping, preparedCount: () => prepared.size, pendingCount: () => pending.size};
}
