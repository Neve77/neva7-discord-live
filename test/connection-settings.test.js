const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parse } = require('dotenv');
const { ConnectionSettings, resolveDiscordAuth } = require('../src/connection-settings');

function setup(t, source = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-connection-test-'));
  const file = path.join(directory, '.env');
  fs.writeFileSync(file, source);
  t.after(() => {
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  return { file, settings: new ConnectionSettings({ file, env: parse(source) }) };
}

test('modo escolhido não recorre ao token de outra conta; arquivos antigos mantêm seleção', () => {
  assert.deepEqual(resolveDiscordAuth({ DISCORD_MODE: 'selfbot', BOT_TOKEN: 'official', TOKEN: 'personal' }), { mode: 'selfbot', token: 'personal' });
  assert.equal(resolveDiscordAuth({ DISCORD_MODE: 'bot', TOKEN: 'personal' }).token, '');
  assert.equal(resolveDiscordAuth({ BOT_TOKEN: 'official', TOKEN: 'personal' }).mode, 'bot');
  assert.equal(resolveDiscordAuth({ TOKEN: 'personal' }).mode, 'selfbot');
  assert.equal(resolveDiscordAuth({ DISCORD_MODE: 'typo', BOT_TOKEN: 'official' }).token, '');
});

test('salvar alterna modo, preserva outras chaves e nunca devolve tokens ao painel', async t => {
  const s = setup(t, '# configuração\r\nBOT_TOKEN=official-secret\r\nTOKEN=old-personal\r\nGROQ_API_KEY=untouched-secret\r\n');
  const saved = await s.settings.save({ mode: 'selfbot', token: 'new-personal-secret' });
  assert.equal(saved.restartRequired, true);
  assert.equal(saved.activeMode, 'bot');
  assert.equal(saved.mode, 'selfbot');
  assert.equal(saved.hasBotToken, true);
  assert.equal(saved.hasSelfbotToken, true);
  assert.ok(!JSON.stringify(saved).includes('secret'));
  const source = fs.readFileSync(s.file, 'utf8');
  const values = parse(source);
  assert.equal(values.BOT_TOKEN, 'official-secret');
  assert.equal(values.TOKEN, 'new-personal-secret');
  assert.equal(values.GROQ_API_KEY, 'untouched-secret');
  assert.match(source, /^# configuração\r\n/);
  assert.deepEqual(resolveDiscordAuth(values), { mode: 'selfbot', token: 'new-personal-secret' });
  await s.settings.save({ mode: 'bot' });
  assert.equal(s.settings.status().restartRequired, false);
  assert.equal(parse(fs.readFileSync(s.file)).TOKEN, 'new-personal-secret');
  assert.deepEqual(fs.readdirSync(path.dirname(s.file)), ['.env']);
});

test('token com quebra de linha e modo sem credencial não alteram o arquivo', async t => {
  const original = 'BOT_TOKEN=official-secret\n';
  const s = setup(t, original);
  for (const input of [
    { mode: 'selfbot' }, { mode: 'invalid', token: 'value' },
    { mode: 'bot', token: 'secret\nGROQ_API_KEY=replaced' },
    { mode: 'bot', token: 'secret#comment' }, { mode: 'bot', token: 'x'.repeat(513) }
  ]) await assert.rejects(s.settings.save(input));
  assert.equal(fs.readFileSync(s.file, 'utf8'), original);
  assert.equal(s.settings.status().restartRequired, false);
});

test('credencial nova e chaves duplicadas carregam corretamente no próximo início', async t => {
  const s = setup(t, 'DISCORD_MODE=bot\nBOT_TOKEN=one\nBOT_TOKEN=two\n');
  await s.settings.save({ mode: 'bot', token: 'replacement' });
  const restarted = new ConnectionSettings({ file: s.file, env: parse(fs.readFileSync(s.file)) });
  assert.equal(restarted.active.token, 'replacement');
  assert.equal(restarted.status().restartRequired, false);
  assert.deepEqual(fs.readdirSync(path.dirname(s.file)), ['.env']);
});
