const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { makeAdapterCreator } = require('../src/voice-adapter');

function setup() {
  const discord = new EventEmitter();
  discord.me = { id: 'bot' };
  discord.send = () => true;
  const events = [];
  const adapter = makeAdapterCreator(discord, 'guild')({
    onVoiceStateUpdate: data => events.push(['state', data]),
    onVoiceServerUpdate: data => events.push(['server', data]),
    destroy: () => events.push(['destroy'])
  });
  return { discord, adapter, events };
}
const state = { guild_id: 'guild', user_id: 'bot', channel_id: 'call', session_id: 'session' };
const server = { guild_id: 'guild', endpoint: 'voice.test', token: 'test' };

test('participantes e outros servidores não alteram a sessão do bot', () => {
  const { discord, events, adapter } = setup();
  discord.emit('voiceStateUpdate', { ...state, user_id: 'person' });
  discord.emit('voiceStateUpdate', { ...state, guild_id: 'other' });
  discord.emit('voiceServerUpdate', { ...server, guild_id: 'other' });
  assert.equal(events.length, 0);
  discord.emit('voiceStateUpdate', state);
  discord.emit('voiceServerUpdate', server);
  assert.deepEqual(events, [['state', state], ['server', server]]);
  adapter.destroy();
});

test('servidor recebido primeiro aguarda a sessão do próprio bot', () => {
  const { discord, events, adapter } = setup();
  discord.emit('voiceServerUpdate', server);
  assert.equal(events.length, 0);
  discord.emit('voiceStateUpdate', state);
  assert.deepEqual(events, [['state', state], ['server', server]]);
  adapter.destroy();
});

test('adaptador informa gateway indisponível e remove seus listeners', () => {
  const { discord, adapter } = setup();
  discord.send = () => false;
  assert.equal(adapter.sendPayload({ op: 4, d: { channel_id: 'call' } }), false);
  adapter.destroy();
  assert.equal(discord.listenerCount('voiceStateUpdate'), 0);
  assert.equal(discord.listenerCount('voiceServerUpdate'), 0);
});

test('nova entrada não reutiliza eventos de uma conexão anterior', () => {
  const { discord, events, adapter } = setup();
  discord.emit('voiceStateUpdate', state);
  adapter.sendPayload({ op: 4, d: { channel_id: 'new-call' } });
  discord.emit('voiceServerUpdate', server);
  assert.equal(events.length, 1);
  const moved = { ...state, channel_id: 'new-call', session_id: 'new-session' };
  discord.emit('voiceStateUpdate', moved);
  assert.deepEqual(events.slice(1), [['state', moved], ['server', server]]);
  discord.emit('voiceStateUpdate', { ...moved, channel_id: null });
  assert.deepEqual(events.at(-1), ['destroy']);
  adapter.destroy();
});
