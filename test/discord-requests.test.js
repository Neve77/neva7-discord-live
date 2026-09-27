const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { loadModule } = require('./helpers');
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (status, body = {}, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: name => headers[name] ?? null }, json: async () => body
});

test('envio preserva a causa Discord no primeiro 403 e durante o intervalo de espera', async () => {
  let calls = 0;
  const { DiscordSelfbot } = loadModule('src/discord.js', {}, {
    fetch: async () => { calls++; return response(403, { code: 50013, message: 'Missing Permissions' }); }
  });
  const client = new DiscordSelfbot('secret', { bot: true });
  for (let i = 0; i < 2; i++) await assert.rejects(client.sendMessage('1356269888917868746', 'teste'), error => {
    assert.equal(error.code, 403); assert.equal(error.discordCode, 50013);
    assert.match(error.message, /Enviar mensagens/);
    assert.match(error.message, /1356269888917868746/);
    assert.ok(!error.message.includes('secret'));
    if (i) assert.match(error.message, /Aguarde/);
    return true;
  });
  assert.equal(calls, 1);
});

test('erros de acesso, AutoMod, verificação e membro desconhecido não viram 403 genérico', async () => {
  const { discordRestError } = require('../src/discord-errors');
  assert.match(discordRestError(403, { code: 50001 }, '/channels/1/messages', 'POST').message, /não tem acesso/);
  assert.match(discordRestError(400, { code: 200000 }, '/channels/1/messages', 'POST').message, /AutoMod/);
  assert.match(discordRestError(400, { captcha_key: ['captcha-required'] }, '/channels/1/messages', 'POST').message, /aplicativo oficial/);
  const absent = discordRestError(404, { code: 10007 }, '/guilds/g/members/id', 'GET');
  assert.equal(absent.discordCode, 10007);
  assert.match(absent.message, /pessoa não foi encontrada/);
});

test('401 encerra a conexão e cancela requisições enfileiradas sem reenviar o token', async () => {
  let calls = 0, signal;
  const { DiscordSelfbot } = loadModule('src/discord.js', {}, {
    fetch: async (url, options) => { calls++; signal = options.signal; return response(401); }
  });
  const client = new DiscordSelfbot('secret', { bot: true });
  const first = client.rest('/channels/1/messages');
  const queued = client.rest('/channels/1/messages');
  const outcomes = await Promise.allSettled([first, queued]);
  assert.ok(outcomes.every(item => item.status === 'rejected' && item.reason.code === 401));
  await assert.rejects(client.rest('/users/@me'), { code: 401 });
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  assert.equal(client.destroyed, true);
  assert.ok(!client.loginError.includes('secret'));
});

test('Kill Switch impede mensagem pendente na fila REST sem derrubar leitura do painel', async () => {
  let release,calls=0;
  const {DiscordSelfbot}=loadModule('src/discord.js',{}, {fetch:async()=>{calls++;if(calls===1)await new Promise(r=>release=r);return response(200);}});
  const client=new DiscordSelfbot('test',{bot:true});let blocked=false;client.activityBlocked=()=>blocked;
  const first=client.sendMessage('1','primeira');const queued=client.sendMessage('1','segunda');
  const pending=Promise.allSettled([first,queued]);await tick();blocked=true;release();
  const outcomes=await pending;assert.ok(outcomes.every(x=>x.status==='rejected' && /segurança/.test(x.reason.message)));
  assert.equal(calls,1);await client.rest('/users/@me');assert.equal(calls,2);client.destroy();
});

test('exigência de verificação e restrição de envio param a automação sem novas tentativas', async () => {
  for (const code of [40002, 40004, 40012]) {
    let calls = 0, stopped;
    const { DiscordSelfbot } = loadModule('src/discord.js', {}, {
      fetch: async () => { calls++; return response(403, { code }); }
    });
    const client = new DiscordSelfbot('test', { bot: true });
    client.on('connectionStopped', error => { stopped = error; });
    await assert.rejects(client.rest('/test'), { discordCode: code });
    await assert.rejects(client.rest('/another'), { discordCode: code });
    assert.equal(stopped.discordCode, code);
    assert.equal(calls, 1);
  }
});

test('403 não se repete na mesma rota por um minuto e não bloqueia canais permitidos', async () => {
  let now = 100000, calls = 0;
  class FakeDate extends Date { static now() { return now; } }
  const { DiscordSelfbot } = loadModule('src/discord.js', {}, {
    Date: FakeDate,
    fetch: async url => { calls++; return response(url.includes('/channels/1/') ? 403 : 200); }
  });
  const client = new DiscordSelfbot('test', { bot: true });
  await assert.rejects(client.rest('/channels/1/messages?limit=5'), { code: 403 });
  await assert.rejects(client.rest('/channels/1/messages?limit=30'), { code: 403 });
  assert.equal(calls, 1);
  await client.rest('/channels/2/messages');
  assert.equal(calls, 2);
  now += 60001;
  await assert.rejects(client.rest('/channels/1/messages'), { code: 403 });
  assert.equal(calls, 3);
});

test('cabeçalhos de limite em resposta bem-sucedida adiam a próxima chamada antes do 429', async () => {
  let now = 100000;
  const calls = [];
  class FakeDate extends Date { static now() { return now; } }
  const { DiscordSelfbot } = loadModule('src/discord.js', {}, {
    Date: FakeDate,
    fetch: async url => {
      calls.push({ url, at: now });
      return response(200, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '1.25' });
    },
    setTimeout(callback, delay) { now += delay; queueMicrotask(callback); }
  });
  const client = new DiscordSelfbot('test', { bot: true });
  await client.rest('/channels/1/messages');
  await client.rest('/channels/2/messages');
  assert.equal(calls[1].at, calls[0].at);
  await client.rest('/channels/1/messages');
  assert.ok(calls[2].at - calls[0].at >= 1250);
});

test('desligar durante Retry-After cancela a espera sem consultar a API', async () => {
  let calls = 0;
  const { DiscordSelfbot } = loadModule('src/discord.js', {}, {
    fetch: async () => { calls++; return response(200); },
    setTimeout: () => 123, clearTimeout() {}
  });
  const client = new DiscordSelfbot('test', { bot: true });
  client.restBlockedUntil = Date.now() + 60000;
  const waiting = client.rest('/test');
  const rejected = assert.rejects(waiting, /encerrada/);
  await tick();
  client.destroy();
  await rejected;
  assert.equal(calls, 0);
});

test('gateway não reconecta após erros fatais de token e configuração', () => {
  for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
    const timers = [];
    class Socket extends EventEmitter { close() {} }
    const { DiscordSelfbot } = loadModule('src/discord.js', { ws: Socket }, {
      setTimeout(callback) { timers.push(callback); return 1; }, clearTimeout() {}
    });
    const client = new DiscordSelfbot('test', { bot: true });
    client.connect();
    client.ws.emit('close', code, Buffer.from('closed'));
    assert.equal(client.destroyed, true);
    assert.equal(timers.length, 0);
    assert.equal(client.stopError.code, code);
  }
});

test('heartbeat segue intervalo do servidor e atende pedido imediato', () => {
  const timers = [], packets = [];
  const { DiscordSelfbot } = loadModule('src/discord.js', {}, {
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {}
  });
  const client = new DiscordSelfbot('test', { bot: true });
  client.send = (...args) => packets.push(args);
  client.seq = 42;
  client.startHeartbeat(45000);
  assert.ok(timers[0].delay >= 0 && timers[0].delay < 45000);
  timers[0].callback();
  assert.equal(timers[1].delay, 45000);
  client.onPacket({ op: 11 });
  timers[1].callback();
  assert.equal(timers[2].delay, 45000);
  client.onPacket({ op: 1 });
  assert.deepEqual(packets, [[1, 42], [1, 42], [1, 42]]);
  client.destroy();
});
