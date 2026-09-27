const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { loadModule, deferred } = require('./helpers');

function setup(options = {}) {
  const generation = deferred(), sent = [];
  let calls = 0;
  const discord = new EventEmitter();
  discord.connected = true;
  discord.me = { id: 'bot' };
  discord.sendMessage = async (...args) => sent.push(args);
  const { AliveSystem } = loadModule('src/alive.js', {
    './llm': { think: async () => { calls++; return generation.promise; } },
    './config': { getSystemPrompt: () => 'Converse.' }
  }, { setInterval: () => 1, clearInterval() {} });
  const alive = new AliveSystem(discord, { channels: ['channel'], ghostRate: 0, ...options });
  alive.recentMsgs.set('channel', Array.from({ length: 3 }, () => ({ author: 'pessoa', content: 'oi', time: Date.now() - 31000 })));
  alive.start();
  return { alive, discord, generation, sent, calls: () => calls };
}

test('vida própria inicia desligada mesmo com contexto e canais cadastrados', async () => {
  const s = setup();
  await s.alive.tick();
  assert.equal(s.alive.enabled, false);
  assert.equal(s.calls(), 0);
  assert.deepEqual(s.sent, []);
  s.alive.stop();
});

test('ciclos sobrepostos geram uma única mensagem; desligar durante geração impede envio tardio', async () => {
  for (const mode of ['stop', 'disable', 'disconnect', 'remove']) {
    const s = setup({ enabled: true });
    const first = s.alive.tick();
    await s.alive.tick();
    assert.equal(s.calls(), 1);
    if (mode === 'stop') s.alive.stop();
    if (mode === 'disable') s.alive.enabled = false;
    if (mode === 'disconnect') s.discord.connected = false;
    if (mode === 'remove') s.alive.removeChannel('channel');
    s.generation.resolve('Comentário que ficou pendente.');
    await first;
    assert.deepEqual(s.sent, []);
    s.alive.stop();
  }
});

test('mensagens do próprio bot e de outros bots não alimentam respostas espontâneas', () => {
  const s = setup();
  s.alive.recentMsgs.clear();
  s.discord.emit('message', { channel_id: 'channel', author: { id: 'bot' }, content: 'minha mensagem' });
  s.discord.emit('message', { channel_id: 'channel', author: { id: 'another', bot: true }, content: 'outro bot' });
  assert.equal(s.alive.recentMsgs.size, 0);
  s.alive.stop();
});
