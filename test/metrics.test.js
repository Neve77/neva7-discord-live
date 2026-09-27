const test = require('node:test');
const assert = require('node:assert/strict');
const { LatencyMetrics } = require('../src/metrics');

test('métricas mantêm janela curta e ignoram valores inválidos', () => {
  const metrics = new LatencyMetrics(2);
  metrics.observe('llm', 100.4);
  metrics.observe('llm', 200.4);
  metrics.observe('llm', 300.4);
  metrics.observe('tts', -1);
  metrics.observe('não-existe', 10);
  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.llm, { last: 300, average: 250, p50: 200, p95: 300, max: 300, samples: 2 });
  assert.deepEqual(snapshot.tts, { last: null, average: null, p50: null, p95: null, max: null, samples: 0 });
});

test('percentis expõem a cauda de latência sem alterar a última amostra', () => {
  const metrics = new LatencyMetrics();
  for (let n = 20; n >= 1; n--) metrics.observe('voiceReply', n * 100);
  assert.deepEqual(metrics.snapshot().voiceReply, { last: 100, average: 1050, p50: 1000, p95: 1900, max: 2000, samples: 20 });
  for (const name of ['firstToken', 'firstSentence', 'textVoiceReply']) {
    metrics.observe(name, 0);
    assert.equal(metrics.snapshot()[name].p95, 0);
  }
});
