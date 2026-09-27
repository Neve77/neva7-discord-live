const test = require('node:test');
const assert = require('node:assert/strict');
const { gaussianJitter, retryAfterMs } = require('../src/jitter');
const { loadModule } = require('./helpers');

test('jitter gaussiano possui média e dispersão esperadas sem atrasos negativos', () => {
  let seed = 12345;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const values = Array.from({ length: 20000 }, () => gaussianJitter({ random }));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / values.length);
  assert.ok(values.every(n => n >= 0 && n <= 1000));
  assert.ok(mean > 347 && mean < 353, mean);
  assert.ok(sd > 97 && sd < 103, sd);
  assert.throws(() => gaussianJitter({ stddev: 0 }), /inválidos/);
});

test('Retry-After preserva prazo longo, zero e datas HTTP; usa maior prazo válido', () => {
  const response = value => ({ headers: { get: () => value } });
  assert.equal(retryAfterMs(response('65'), { retry_after: 64.57 }), 65000);
  assert.equal(retryAfterMs(response(null), { retry_after: 0 }), 0);
  assert.equal(retryAfterMs(response('bad'), {}), 2000);
  assert.equal(retryAfterMs(response('Fri, 18 Sep 2026 23:00:30 GMT'), {}, Date.parse('2026-09-18T23:00:00Z')), 30000);
});

test('REST do bot roda rotas distintas em paralelo, sem atraso global artificial', async () => {
  let now = 100000;
  const times = [], delays = [];
  class FakeDate extends Date { static now() { return now; } }
  const { DiscordSelfbot } = loadModule('src/discord.js', { './jitter': { retryAfterMs, gaussianJitter: () => 350 } }, {
    Date: FakeDate,
    fetch: async url => {
      times.push({ url, at: now });
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    },
    setTimeout(callback, delay) { delays.push(delay); now += delay; queueMicrotask(callback); }
  });
  const client = new DiscordSelfbot('fake', { bot: true });
  await Promise.all([client.rest('/channels/1/messages', 'POST'), client.rest('/channels/2/messages', 'POST')]);
  assert.equal(times.length, 2);
  assert.equal(times[1].at - times[0].at, 0);
  assert.deepEqual(delays, []);
});

test('429 global bloqueia a próxima rota pelo Retry-After completo', async () => {
  let now = 100000, attempts = 0;
  const times = [], delays = [];
  class FakeDate extends Date { static now() { return now; } }
  const { DiscordSelfbot } = loadModule('src/discord.js', { './jitter': { retryAfterMs, gaussianJitter: () => 350 } }, {
    Date: FakeDate,
    fetch: async url => {
      times.push({ url, at: now });
      if (++attempts === 1) return { status: 429, headers: { get: () => '65' }, json: async () => ({ retry_after: 64.57, global: true }) };
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    },
    setTimeout(callback, delay) { delays.push(delay); now += delay; queueMicrotask(callback); }
  });
  const client = new DiscordSelfbot('fake', { bot: true });
  await assert.rejects(client.rest('/first', 'GET', null, 1), { code: 429 });
  await client.rest('/second');
  assert.equal(times.length, 2);
  assert.ok(times[1].at - times[0].at >= 65350);
  assert.ok(delays.every(ms => ms <= 60000));
});

test('esgotar tentativas preserva cooldown para a próxima chamada da fila', async () => {
  let now = 100000, calls = 0;
  const times = [];
  class FakeDate extends Date { static now() { return now; } }
  const { DiscordSelfbot } = loadModule('src/discord.js', { './jitter': { retryAfterMs, gaussianJitter: () => 350 } }, {
    Date: FakeDate,
    fetch: async () => {
      times.push(now);
      if (++calls === 1) return { status: 429, json: async () => ({ retry_after: 30 }) };
      return { status: 204, ok: true };
    },
    setTimeout(callback, delay) { now += delay; queueMicrotask(callback); }
  });
  const client = new DiscordSelfbot('fake', { bot: true });
  await assert.rejects(client.rest('/first', 'GET', null, 1), { code: 429 });
  await client.rest('/first');
  assert.ok(times[1] - times[0] >= 30350);
});
