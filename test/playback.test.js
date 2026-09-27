const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { playResource } = require('../src/playback');

function player() {
  const p = new EventEmitter();
  p.play = () => {};
  p.stop = () => { p.stopped = true; };
  p.on('error', () => {});
  p.state = status => p.emit('stateChange', {}, { status });
  return p;
}

test('reprodução só confirma sucesso depois de Playing e Idle', async () => {
  const p = player();
  const done = playResource(p, {});
  p.state('buffering'); p.state('playing'); p.state('idle');
  assert.equal(await done, true);
  assert.equal(p.listenerCount('stateChange'), 0);
});

test('buffer vazio e erro de player são falhas, não conclusão silenciosa', async () => {
  const p = player();
  const empty = playResource(p, {});
  p.state('buffering'); p.state('idle');
  await assert.rejects(empty, /sem começar/);
  const failed = playResource(p, {});
  p.emit('error', new Error('FFmpeg falhou'));
  await assert.rejects(failed, /FFmpeg falhou/);
  assert.equal(p.stopped, true);
});

test('parar durante buffering cancela imediatamente e remove listeners', async () => {
  const p = player(), abort = new AbortController();
  const done = playResource(p, {}, { signal: abort.signal });
  p.state('buffering'); abort.abort();
  assert.equal(await done, false);
  assert.equal(p.stopped, true);
  assert.equal(p.listenerCount('stateChange'), 0);
  assert.equal(p.listenerCount('error'), 1);
});
