const test = require('node:test');
const assert = require('node:assert/strict');
const { DiscordSelfbot } = require('../src/discord');

test('cache de nomes mantém apelidos por servidor e acompanha mudanças e saídas', () => {
  const client = new DiscordSelfbot('test', { bot: true });
  const user = { id: '123456789012345678', username: 'ana', global_name: 'Ana Lua' };
  const packet = (t, d) => client.onPacket({ op: 0, t, d });
  packet('VOICE_STATE_UPDATE', { guild_id: 'a', user_id: user.id, member: { user, nick: 'Lua', roles: [] } });
  packet('GUILD_MEMBER_ADD', { guild_id: 'b', user, nick: 'Ana Gamer', roles: [] });
  assert.equal(client.guildMembers.get('a').get(user.id).nick, 'Lua');
  assert.equal(client.guildMembers.get('b').get(user.id).nick, 'Ana Gamer');
  packet('GUILD_MEMBER_UPDATE', { guild_id: 'a', user, nick: null, roles: [] });
  assert.equal(client.guildMembers.get('a').get(user.id).nick, null);
  assert.equal(client.guildMembers.get('a').get(user.id).user.global_name, 'Ana Lua');
  packet('GUILD_MEMBER_REMOVE', { guild_id: 'a', user });
  assert.equal(client.guildMembers.get('a').has(user.id), false);
  assert.equal(client.guildMembers.get('b').has(user.id), true);
  packet('GUILD_DELETE', { id: 'b' });
  assert.equal(client.guildMembers.has('b'), false);
});

test('identify solicita membros e estados de voz, não webhooks', () => {
  const client = new DiscordSelfbot('test', { bot: true });
  const packets = [];
  client.send = (op, data) => packets.push({ op, data });
  client.identify();
  assert.equal(packets[0].op, 2);
  assert.equal(packets[0].data.intents & (1 << 7), 128);
  assert.equal(packets[0].data.intents & (1 << 1), 2);
  assert.equal(packets[0].data.intents & (1 << 5), 0);
  assert.equal(packets[0].data.intents, 33411);
  assert.deepEqual(packets[0].data.presence.activities, [{ name: 'Conversando no Discord', type: 0 }]);
});

test('bot publica a atividade configurada assim que fica pronto', () => {
  const client = new DiscordSelfbot('test', { bot: true, activity: 'Ajudando na call' });
  const packets = [];
  client.send = (op, data) => packets.push({ op, data });
  client.connected = true;
  client.startPresenceRotation();
  assert.deepEqual(packets, [{ op: 3, data: { since: 0, status: 'online', afk: false, activities: [{ name: 'Ajudando na call', type: 0 }] } }]);
});

test('conta pessoal não inicia rotação de atividades fictícias', () => {
  const client = new DiscordSelfbot('test', { bot: false });
  client.connected = true;
  client.send = () => assert.fail('não deve alterar presença');
  client.startPresenceRotation();
  assert.equal(client.presenceTimer, null);
});

test('mensagem automática não dispara menções e confirmação de leitura não usa REST', async () => {
  const client = new DiscordSelfbot('test', { bot: true });
  const requests = [];
  client.rest = async (...args) => requests.push(args);
  await client.sendMessage('channel', '@everyone <@123456789012345678>');
  assert.deepEqual(requests[0][2].allowed_mentions, { parse: [], replied_user: false });
  await client.ack('channel', 'message');
  assert.equal(requests.length, 1);
});

test('mensagem pode limitar a menção a uma pessoa selecionada', async () => {
  const client = new DiscordSelfbot('test', { bot: true });
  let request;
  client.rest = async (...args) => { request = args; };
  await client.sendMessage('canal', '<@123456789012345678> oi @everyone', {
    allowedMentions: { parse: [], users: ['123456789012345678'] }
  });
  assert.deepEqual(request, ['/channels/canal/messages', 'POST', {
    content: '<@123456789012345678> oi @everyone', tts: false,
    allowed_mentions: { parse: [], users: ['123456789012345678'] }
  }]);
});

test('desligar encerra timers e impede uma nova conexão', () => {
  const client = new DiscordSelfbot('test', { bot: true });
  let closed = false;
  client.ws = { close() { closed = true; } };
  client.heartbeatTimer = setInterval(() => {}, 10000);
  client.reconnectTimer = setTimeout(() => assert.fail('não deve reconectar'), 10000);
  client.destroy();
  assert.equal(closed, true);
  assert.equal(client.connected, false);
  assert.equal(client.destroyed, true);
  client.connect();
  assert.equal(client.ws.readyState, undefined);
});

test('descobre a call pelo endpoint de voice state e guarda o resultado', async () => {
  const client = new DiscordSelfbot('test', { bot: true });
  const calls = [];
  client.rest = async path => {
    calls.push(path);
    return { channel_id: 'call', session_id: 'session' };
  };
  assert.equal(await client.resolveVoiceChannelOf('guild', 'person'), 'call');
  assert.equal(await client.resolveVoiceChannelOf('guild', 'person'), 'call');
  assert.deepEqual(calls, ['/guilds/guild/voice-states/person']);
});

test('usuário fora da call retorna null, falta de permissão preserva o erro', async () => {
  const client = new DiscordSelfbot('test', { bot: true });
  client.rest = async () => { throw Object.assign(new Error('not found'), { code: 404 }); };
  assert.equal(await client.resolveVoiceChannelOf('guild', 'person'), null);
  client.rest = async () => { throw Object.assign(new Error('forbidden'), { code: 403 }); };
  await assert.rejects(client.resolveVoiceChannelOf('guild', 'person'), { code: 403 });
});

test('eventos de saída removem a call do cache', () => {
  const client = new DiscordSelfbot('test', { bot: true });
  client.onPacket({ op: 0, t: 'VOICE_STATE_UPDATE', d: { guild_id: 'guild', user_id: 'person', channel_id: 'call' } });
  assert.equal(client.getVoiceChannelOf('guild', 'person'), 'call');
  client.onPacket({ op: 0, t: 'VOICE_STATE_UPDATE', d: { guild_id: 'guild', user_id: 'person', channel_id: null } });
  assert.equal(client.getVoiceChannelOf('guild', 'person'), null);
});

test('heartbeat de reconexão não fecha o socket por ACK da sessão anterior', () => {
  const client = new DiscordSelfbot('test', { bot: true });
  let closed = false;
  client.ws = { close() { closed = true; } };
  client.send = () => true;
  client.heartbeatAck = false;
  try {
    client.startHeartbeat(45000);
    assert.equal(closed, false);
    assert.equal(client.heartbeatAck, false);
  } finally { clearInterval(client.heartbeatTimer); }
});
