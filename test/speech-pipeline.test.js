const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpeechPipeline } = require('../src/speech-pipeline');
const { deferred } = require('./helpers');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('prepara a próxima fala durante a reprodução sem gerar a fila inteira nem inverter trechos', async () => {
  const first = deferred(), second = deferred();
  const prepared = [], played = [], disposed = [];
  const queue = createSpeechPipeline({
    prepare(text) {
      prepared.push(text);
      return { ready: text === 'dois' ? second.promise : Promise.resolve(), dispose: () => disposed.push(text) };
    },
    async play(text) { played.push(text); if (text === 'um') await first.promise; return true; }
  });
  queue.enqueue('um');
  await tick();
  queue.enqueue('dois');
  queue.enqueue('três');
  const done = queue.done();
  await tick();
  assert.deepEqual(prepared, ['um', 'dois']);
  assert.deepEqual(played, ['um']);
  second.resolve();
  await tick();
  assert.deepEqual(played, ['um']);
  first.resolve();
  assert.equal(await done, true);
  assert.deepEqual(played, ['um', 'dois', 'três']);
  assert.deepEqual(disposed, ['um', 'dois', 'três']);
});

test('aguarda a conexão antes de sintetizar e retoma quando chegam novos trechos', async () => {
  const ready = deferred();
  const prepared = [];
  const queue = createSpeechPipeline({
    ready: ready.promise,
    prepare(text) { prepared.push(text); return { ready: Promise.resolve(), dispose() {} }; },
    play: async () => true
  });
  queue.enqueue('primeiro');
  await tick();
  assert.deepEqual(prepared, []);
  ready.resolve();
  await tick();
  queue.enqueue('segundo');
  await queue.done();
  assert.deepEqual(prepared, ['primeiro', 'segundo']);
});

test('interrupção cancela a reprodução e a próxima síntese; não toca conteúdo antigo', async () => {
  const abort = new AbortController(), playback = deferred();
  const prepared = [], played = [], disposed = new Set();
  const queue = createSpeechPipeline({
    signal: abort.signal,
    prepare(text, signal) {
      prepared.push({ text, signal });
      return { ready: Promise.resolve(), dispose: () => disposed.add(text) };
    },
    async play(text) { played.push(text); await playback.promise; return true; }
  });
  ['um', 'dois', 'três'].forEach(text => queue.enqueue(text));
  await tick();
  abort.abort();
  assert.ok(prepared.every(item => item.signal.aborted));
  assert.deepEqual([...disposed], ['um', 'dois']);
  playback.resolve();
  await queue.done();
  assert.deepEqual(played, ['um']);
  assert.equal(prepared.length, 2);
});

test('falha antecipada da próxima síntese é tratada sem rejeição solta nem pular texto', async () => {
  const playback = deferred();
  const errors = [], played = [];
  const queue = createSpeechPipeline({
    prepare(text) {
      return { ready: text === 'dois' ? Promise.reject(new Error('TTS falhou')) : Promise.resolve(), dispose() {} };
    },
    async play(text) { played.push(text); await playback.promise; return true; },
    onError: error => errors.push(error.message)
  });
  ['um', 'dois', 'três'].forEach(text => queue.enqueue(text));
  await tick();
  playback.resolve();
  await queue.done();
  assert.deepEqual(played, ['um']);
  assert.deepEqual(errors, ['TTS falhou']);
});
