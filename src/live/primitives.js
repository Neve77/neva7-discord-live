const { PassThrough } = require('node:stream');

function rms(pcm) {
  let energy = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2;
  return pcm.length ? Math.sqrt(energy / (pcm.length / 2)) : 0;
}
function endpointDelay(text, options, otherSpeaking = false) {
  const unfinished = /(?:\b(?:e|mas|porque|que|se|então|tipo|para|de|um|uma|eu|quando|y|pero|aunque|si|cuando|yo|and|but|because|if|when|so|the|a|an|to|i)|[,;:]|…|\.\.\.)\s*$/iu.test(text.trim());
  return otherSpeaking || unfinished ? options.incompleteMs : options.silenceMs;
}
class AudioBuffer {
  constructor({ prebufferMs, maxBufferMs }) {
    this.stream = new PassThrough({ highWaterMark: 12000 });
    this.stream.on('error', () => {});
    this.prebuffer = prebufferMs * 48;
    this.max = maxBufferMs * 48;
    this.pending = [];
    this.bytes = 0;
    this.started = false;
  }
  get size() { return this.bytes + this.stream.readableLength + this.stream.writableLength; }
  push(pcm) {
    if (this.stream.destroyed) return false;
    // A websocket producer cannot be paused safely: cancel the turn at the cap,
    // rather than buffering unlimited audio or dropping syllables mid-sentence.
    if (this.size + pcm.length > this.max) return false;
    if (this.started) this.stream.write(pcm);
    else {
      this.pending.push(pcm); this.bytes += pcm.length;
      if (this.bytes >= this.prebuffer) this.flush();
    }
    return true;
  }
  flush() {
    this.started = true;
    if (this.bytes) this.stream.write(Buffer.concat(this.pending, this.bytes));
    this.pending = []; this.bytes = 0;
  }
  end() { this.flush(); this.stream.end(); }
  destroy() { this.pending = []; this.bytes = 0; this.stream.destroy(); }
}
class Telemetry {
  constructor(now = Date.now) { this.now = now; this.events = []; this.samples = {}; this.counters = {}; this.seq = 0; }
  event(type, data = {}) {
    // Only technical metadata; no provider payloads, transcripts, audio or keys.
    const event = { id: ++this.seq, at: this.now(), type };
    for (const key of ['userId','responseId','state','reason','bytes','ms','epoch']) if (data[key] !== undefined) event[key] = data[key];
    this.events.push(event); if (this.events.length > 300) this.events.shift();
  }
  count(name, n = 1) { this.counters[name] = (this.counters[name] || 0) + n; }
  observe(name, ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    const items = this.samples[name] ||= [];
    items.push(Math.round(ms)); if (items.length > 200) items.shift();
  }
  snapshot() {
    const latency = Object.fromEntries(Object.entries(this.samples).map(([key, values]) => {
      const sorted = [...values].sort((a,b) => a-b);
      const p = n => sorted[Math.max(0, Math.ceil(sorted.length * n) - 1)];
      return [key, { samples: sorted.length, last: values.at(-1), p50:p(.5), p95:p(.95), p99:p(.99) }];
    }));
    return { counters: { ...this.counters }, latency, events: this.events.slice() };
  }
}
module.exports = { rms, endpointDelay, AudioBuffer, Telemetry };
