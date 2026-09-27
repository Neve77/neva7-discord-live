const METRICS = ['stt', 'llm', 'firstToken', 'firstSentence', 'tts', 'firstAudio', 'reply', 'voiceReply', 'textVoiceReply'];

class LatencyMetrics {
  constructor(limit = 30) {
    this.limit = limit;
    this.values = new Map(METRICS.map(name => [name, []]));
  }

  observe(name, milliseconds) {
    if (!this.values.has(name) || !Number.isFinite(milliseconds) || milliseconds < 0) return;
    const samples = this.values.get(name);
    samples.push(Math.round(milliseconds));
    if (samples.length > this.limit) samples.shift();
  }

  snapshot() {
    return Object.fromEntries([...this.values].map(([name, samples]) => {
      const last = samples.at(-1) ?? null;
      const average = samples.length ? Math.round(samples.reduce((total, value) => total + value, 0) / samples.length) : null;
      const sorted = [...samples].sort((a, b) => a - b);
      const percentile = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
      return [name, { last, average, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null, samples: samples.length }];
    }));
  }
}

module.exports = { LatencyMetrics };
