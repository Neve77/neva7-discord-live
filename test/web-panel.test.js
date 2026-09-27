const test = require('node:test');
const assert = require('node:assert/strict');
const { WebPanel } = require('../src/web-panel');
const { ConnectionSettings } = require('../src/connection-settings');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse } = require('dotenv');

function controller() {
  const calls = [];
  const settings = {
    listEmotions: () => ['natural'], listVoices: () => ['aoede'],
    listVoiceProfiles: () => [{ id: 'aoede', name: 'Aoede', timbre: 'feminino', style: 'Leve' }]
  };
  return {
    settings, calls,
    status: () => ({ online: true, guild: 'Servidor', guildId: 'g', channel: 'geral', textChannelId: 't', call: 'call', tts: 'Gemini Native', voice: 'aoede', speed: 1, volume: 100, emotion: 'natural', music: 'parada', autoJoin: true, replyInText: true, alive: false, aliveChannels: 0, metrics: { stt: { last: 120 }, llm: { last: 260 }, firstAudio: { last: 180 }, reply: { last: 320 } } }),
    async listServers() { return [{ id: 'g', name: 'Servidor' }]; },
    textChannels: () => [{ id: 't', name: 'geral' }], voiceChannels: () => [{ id: 'v', name: 'call' }],
    async selectServer(value) { calls.push(['server', value.id]); }, selectTextChannel(value) { calls.push(['text', value.id]); },
    async say(value) { calls.push(['say', value]); return 'Falando.'; },
    setInteraction(value) { calls.push(['interaction', value]); return 'Ajustes salvos.'; },
    setCustomEmotion(value) { calls.push(['customEmotion', value]); return 'Personalidade salva.'; },
    async searchMembers(query) { calls.push(['members', query]); return [{ id: '123456789012345678', name: 'Ana' }]; },
    async listSoundEffects() { return [{ id: 'bum.mp3', name: 'bum', filename: 'bum.mp3', size: 123, kind: 'audio/mpeg' }]; },
    async importSoundEffect(value) { calls.push(['soundImport', value]); return `Efeito salvo: ${value.name || 'som'}`; },
    async playSoundEffect(value) { calls.push(['soundPlay', value]); return 'Efeito tocado.'; }
  };
}

test('central web serve a interface local e executa ações do controlador', async () => {
  const api = controller();
  const panel = new WebPanel(api, { port: 0 });
  const url = await panel.start();
  try {
    const page = await fetch(url);
    assert.equal(page.status, 200);
    const markup = await page.text();
    assert.match(markup, /Painel único/);
    assert.equal(await (await fetch(url + '/live')).text(), markup);
    assert.match(markup, /panel-classic.js/);
    assert.match(markup, /id="textChannel"/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    const client = await (await fetch(url + '/app.js')).text();
    assert.equal(client, await (await fetch(url + '/live.js')).text());
    const classic = await (await fetch(url + '/panel-classic.js')).text();
    assert.match(classic, /Timbre e ritmo/);
    assert.match(classic, /Emoção e interação/);
    assert.match(classic, /Criar uma personalidade do zero/);
    assert.match(classic, /renderVoiceOptions/);
    assert.doesNotMatch(client, /class WebPanel/);
    const members = await (await fetch(url + '/api/members?q=ana')).json();
    assert.deepEqual(members, { members: [{ id: '123456789012345678', name: 'Ana' }] });
    const catalog = await (await fetch(url + '/api/catalog')).json();
    assert.equal(catalog.servers[0].name, 'Servidor');
    assert.deepEqual(catalog.voiceProfiles, [{ id: 'aoede', name: 'Aoede', timbre: 'feminino', style: 'Leve' }]);
    assert.match(catalog.voiceProfileNote, /não gênero/);
    const action = await fetch(url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'say', value: { text: 'Olá, call!' } }) });
    assert.deepEqual(await action.json(), { ok: true, message: 'Falando.', status: api.status() });
    const interaction = await fetch(url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'interaction', value: { text: 'Seja breve.' } }) });
    assert.equal((await interaction.json()).message, 'Ajustes salvos.');
    const custom = await fetch(url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'customEmotion', value: { text: 'Uma persona nova.' } }) });
    assert.equal((await custom.json()).message, 'Personalidade salva.');
    assert.deepEqual(api.calls, [['members', 'ana'], ['say', 'Olá, call!'], ['interaction', 'Seja breve.'], ['customEmotion', 'Uma persona nova.']]);
  } finally { await panel.stop(); }
});

test('API preserva avisos de busca parcial e diagnóstico só permite origem local', async () => {
  const api = controller();
  const search = { guildId: 'g', members: [], hasMore: true, indexed: 1000, warning: 'Há mais membros.' };
  api.findMembers = async query => { assert.equal(query, 'Ana'); return search; };
  api.checkMessageAccess = async () => { api.calls.push(['access']); return { canSend: false, blockers: ['Enviar mensagens'] }; };
  const panel = new WebPanel(api, { port: 0 }), url = await panel.start();
  try {
    assert.deepEqual(await (await fetch(url + '/api/members?q=Ana')).json(), search);
    assert.equal((await fetch(url + '/api/message-access', { headers: { Origin: 'https://another-site.example' } })).status, 403);
    assert.equal(api.calls.length, 0);
    assert.deepEqual(await (await fetch(url + '/api/message-access')).json(), { canSend: false, blockers: ['Enviar mensagens'] });
    assert.deepEqual(api.calls, [['access']]);
  } finally { await panel.stop(); }
});

test('conexão salva localmente sem devolver token e rejeita gravações de outra origem', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-api-test-'));
  const file = path.join(directory, '.env');
  fs.writeFileSync(file, 'BOT_TOKEN=official-secret\n');
  const api = controller();
  api.connectionSettings = new ConnectionSettings({ file, env: parse(fs.readFileSync(file)) });
  const originalStatus = api.status;
  api.status = () => ({ ...originalStatus(), connection: api.connectionSettings.status() });
  const panel = new WebPanel(api, { port: 0 });
  const url = await panel.start();
  const payload = JSON.stringify({ mode: 'selfbot', token: 'personal-secret' });
  try {
    for (const headers of [
      { 'Content-Type': 'application/json', Origin: 'https://another-site.example' },
      { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      { 'Content-Type': 'text/plain', Origin: url }
    ]) {
      const blocked = await fetch(url + '/api/connection', { method: 'POST', headers, body: payload });
      assert.ok([403, 415].includes(blocked.status));
      assert.equal(parse(fs.readFileSync(file)).TOKEN, undefined);
    }
    const response = await fetch(url + '/api/connection', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: payload
    });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.connection.mode, 'selfbot');
    assert.equal(saved.connection.restartRequired, true);
    assert.ok(!JSON.stringify(saved).includes('secret'));
    assert.equal(parse(fs.readFileSync(file)).TOKEN, 'personal-secret');
    assert.equal(parse(fs.readFileSync(file)).BOT_TOKEN, 'official-secret');
    const status = await (await fetch(url + '/api/status')).text();
    assert.ok(!status.includes('secret'));
    assert.equal(JSON.parse(status).status.connection.hasSelfbotToken, true);
  } finally {
    await panel.stop();
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  }
});

test('painel expõe lista e importação de efeitos sonoros locais', async () => {
  const api = controller();
  const panel = new WebPanel(api, { port: 0 });
  const url = await panel.start();
  try {
    const list = await fetch(url + '/api/sound-effects');
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { effects: [{ id: 'bum.mp3', name: 'bum', filename: 'bum.mp3', size: 123, kind: 'audio/mpeg' }] });

    const importResponse = await fetch(url + '/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'soundImport', value: { name: 'bum', data: Buffer.from('abc').toString('base64'), filename: 'bum.mp3' } })
    });
    assert.equal(importResponse.status, 200);
    assert.equal((await importResponse.json()).message, 'Efeito salvo: bum');
    assert.deepEqual(api.calls.at(-1), ['soundImport', { name: 'bum', data: Buffer.from('abc').toString('base64'), filename: 'bum.mp3' }]);
  } finally {
    await panel.stop();
  }
});
