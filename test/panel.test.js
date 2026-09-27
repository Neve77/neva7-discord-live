const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const { PanelController } = require('../src/panel-controller');
const { TerminalPanel, menuText } = require('../src/terminal-panel');

function setup() {
  const sent = [], played = [], saved = [];
  const servers = [{ id: 'first', name: 'Meu servidor' }, { id: 'second', name: 'Outro servidor' }];
  const channels = {
    first: [{ id: 'text-1', name: 'geral', type: 0 }, { id: 'voice-1', name: 'Call principal', type: 2 }],
    second: [{ id: 'text-2', name: 'outro-chat', type: 0 }, { id: 'voice-2', name: 'Outra call', type: 2 }]
  };
  const discord = {
    connected: true, me: { id: 'bot', username: 'Bot de teste' },
    users: new Map([['123456789012345678', { username: 'Ana', global_name: 'Ana Lua' }]]),
    async rest(path) {
      if (path.startsWith('/users/@me/guilds')) return servers;
      if (path.startsWith('/guilds/first/members/search')) return [{ nick: 'Ana', user: { id: '123456789012345678', username: 'Ana', global_name: 'Ana Lua' } }];
      if (path === '/guilds/first/members/123456789012345678') return { nick: 'Ana', user: { id: '123456789012345678', username: 'Ana', global_name: 'Ana Lua' } };
      if (path.endsWith('/channels')) return channels[path.split('/')[2]];
      return [{ author: { username: 'pessoa' }, content: 'olá' }];
    },
    async resolveVoiceChannelOf() { return 'voice-1'; },
    async sendMessage(channel, text, options) { sent.push({ channel, text }); this.lastSendOptions = options; }
  };
  const voice = {
    active: new Map(), get(guild) { return this.active.get(guild); },
    async join(guild, channelId) { this.active.set(guild, { channelId, deaf: false, speechVol: 1, tracks: [] }); },
    async leave(guild) { this.active.delete(guild); },
    setVolumes(guild, volumes) { this.get(guild).speechVol = volumes.speech; },
    setListen(guild, on) { this.get(guild).deaf = !on; },
    musicQueue(guild) { return this.get(guild).tracks; },
    stopMusic() { return true; }
  };
  const state = { ttsVoice: 'thalita', ttsSpeed: 1, interaction: '' };
  const config = { autoJoinOnMention: true, replyInTextToo: true };
  const settings = {
    state, config, getCurrent: () => 'natural', getInteraction: () => state.interaction, listEmotions: () => ['natural', 'feliz'],
    listVoices: () => ['thalita', 'francisca'], setEmotion: name => ['natural', 'feliz'].includes(name),
    setCustom(text) { state.custom = text; saved.push(['custom', text]); },
    setInteraction(text) { state.interaction = text; saved.push(['interaction', text]); },
    setVoice(name) { state.ttsVoice = name; saved.push(['voice', name]); },
    setSpeed(value) { state.ttsSpeed = value; saved.push(['speed', value]); },
    setOption(name, value) { config[name] = value; saved.push([name, value]); }
  };
  const alive = { enabled: false, channels: new Set(), addChannel(id) { this.channels.add(id); }, removeChannel(id) { this.channels.delete(id); } };
  const controller = new PanelController({
    discord, voice, alive, settings, ownerId: 'owner', defaultGuildId: 'first', defaultTextChannelId: 'text-1',
    llmInfo: { chatProvider: 'Groq', chatModel: 'teste' },
    clearTopicContext: guildId => guildId === 'first',
    sayInVoice: async (guild, text, language, options) => { played.push({ guild, text, language, options }); return true; },
    summarizeChannel: async lines => lines.join('\n')
  });
  return { controller, discord, voice, alive, settings, servers, channels, sent, played, saved };
}

test('selecionar servidor limpa o destino anterior e evita envio no servidor errado', async () => {
  const s = setup();
  await s.controller.initialize();
  await s.controller.send('mensagem A');
  await s.controller.selectServer(s.servers[1]);
  await assert.rejects(s.controller.send('não enviar'), /canal de texto/);
  assert.throws(() => s.controller.selectTextChannel(s.channels.first[0]), /deste servidor/);
  s.controller.selectTextChannel(s.channels.second[0]);
  await s.controller.send('mensagem B');
  assert.deepEqual(s.sent, [{ channel: 'text-1', text: 'mensagem A' }, { channel: 'text-2', text: 'mensagem B' }]);
});

test('ações de voz exigem call, restringem servidor e informam voz ocupada', async () => {
  const s = setup();
  await s.controller.initialize();
  await assert.rejects(s.controller.say('oi'), /Entre em uma call/);
  await assert.rejects(s.controller.join('voice-2'), /deste servidor/);
  await s.controller.join();
  await s.controller.say('teste');
  assert.equal(s.played[0].guild, 'first');
  assert.deepEqual(s.played[0].options, { interruptMusic: true });
  s.controller.sayInVoice = async () => false;
  await assert.rejects(s.controller.say('teste'), /ocupada/);
  s.discord.connected = false;
  await assert.rejects(s.controller.join(), /desconectado/);
});

test('volume zero, decimal com vírgula e limites das configurações', async () => {
  const s = setup();
  await s.controller.initialize();
  await s.controller.join('voice-1');
  s.controller.setVolume('0');
  assert.equal(s.voice.get('first').speechVol, 0);
  s.controller.setSpeed('1,25');
  assert.equal(s.settings.state.ttsSpeed, 1.25);
  for (const value of ['', 'NaN', 'Infinity', '201', '-1', '100abc']) assert.throws(() => s.controller.setVolume(value));
  for (const value of ['', '5', '0,1', '2abc']) assert.throws(() => s.controller.setSpeed(value));
  assert.throws(() => s.controller.setVoice('não existe'));
  s.controller.setVoice('francisca');
  s.controller.toggleOption('autoJoinOnMention');
  assert.equal(s.settings.state.ttsVoice, 'francisca');
  assert.equal(s.settings.config.autoJoinOnMention, false);
});

test('painel salva ajustes de interação e personalidade personalizada com limites', () => {
  const s = setup();
  assert.equal(s.controller.setInteraction('Seja acolhedora e pergunte antes de mudar de assunto.'), 'Ajustes de interação salvos.');
  assert.equal(s.controller.status().interaction, 'Seja acolhedora e pergunte antes de mudar de assunto.');
  assert.equal(s.controller.setInteraction(''), 'Ajustes de interação removidos.');
  assert.equal(s.controller.setCustomEmotion('Fale como uma narradora curiosa.'), 'Personalidade personalizada salva.');
  assert.equal(s.settings.state.custom, 'Fale como uma narradora curiosa.');
  assert.throws(() => s.controller.setInteraction('x'.repeat(701)), /700 caracteres/);
  assert.throws(() => s.controller.setCustomEmotion('x'.repeat(701)), /700 caracteres/);
});

test('painel busca membro do servidor, menciona só a pessoa selecionada e limpa contexto', async () => {
  const s = setup();
  await s.controller.initialize();
  const members = await s.controller.searchMembers('ana');
  assert.deepEqual(members, [{ id: '123456789012345678', name: 'Ana', username: 'Ana', displayName: 'Ana Lua', nickname: 'Ana' }]);
  const result = await s.controller.mention(members[0].id, 'oi, pode ver isso?');
  assert.match(result, /Ana foi mencionado/);
  assert.deepEqual(s.sent, [{ channel: 'text-1', text: '<@123456789012345678> oi, pode ver isso?' }]);
  assert.deepEqual(s.discord.lastSendOptions, { allowedMentions: { parse: [], users: ['123456789012345678'] } });
  await assert.rejects(s.controller.mention('999999999999999999', 'não deve enviar'), /Busque e selecione/);
  assert.equal(s.controller.clearContext(), 'Contexto da conversa removido.');
  await assert.rejects(s.controller.searchMembers('a'), /ao menos 2/);
});

test('parar tudo cancela a resposta, a fala e a música na call atual', async () => {
  const s = setup();
  await s.controller.initialize();
  await s.controller.join('voice-1');
  const session = s.voice.get('first');
  const stopped = [];
  session.responseAbort = { abort: () => stopped.push('response') };
  session.synthesisAbort = { abort: () => stopped.push('synthesis') };
  session.speechAbort = { abort: () => stopped.push('speech') };
  session.pendingSpeech = [{ userId: 'pending' }];
  const capture = { stream: { destroy() { stopped.push('capture'); } } };
  session.captures = new Map([['person', capture]]);
  session.player = { stop: value => stopped.push(`player:${value}`) };
  assert.match(s.controller.stopAll(), /Áudio parado/);
  assert.deepEqual(stopped, ['response', 'synthesis', 'speech', 'capture', 'player:true']);
  assert.equal(session.pendingSpeech.length, 0);
  assert.equal(capture.cancelled, true);
});

test('menção revalida membro e descarta validação atrasada após trocar servidor', async () => {
  const { deferred } = require('./helpers');
  const s = setup(); await s.controller.initialize();
  const [member] = await s.controller.searchMembers('ana');
  const previous = s.discord.rest, pending = deferred();
  s.discord.rest = async path => path.endsWith('/members/' + member.id) ? pending.promise : previous(path);
  const result = s.controller.mention(member.id, 'teste');
  const rejected = assert.rejects(result, /servidor ou a lista mudou/);
  await s.controller.selectServer(s.servers[1]);
  s.controller.selectTextChannel(s.channels.second[0]);
  pending.resolve({ user: { id: member.id } });
  await rejected;
  assert.equal(s.sent.length, 0);
});

test('menção não envia quando a pessoa saiu do servidor desde a busca', async () => {
  const s = setup(); await s.controller.initialize();
  const [member] = await s.controller.searchMembers('ana');
  s.discord.rest = async () => { throw Object.assign(new Error('Esta pessoa saiu do servidor.'), { code: 404, discordCode: 10007 }); };
  await assert.rejects(s.controller.mention(member.id, 'teste'), { discordCode: 10007 });
  assert.equal(s.sent.length, 0);
});

test('anúncio envia texto e fala; painel repete a última frase e expõe diagnóstico', async () => {
  const s = setup();
  await s.controller.initialize();
  await s.controller.join('voice-1');
  await assert.rejects(s.controller.repeatLastSpeech(), /Ainda não há/);
  const result = await s.controller.announce('Atenção, a música vai começar.');
  assert.match(result, /enviado.*falado/);
  assert.deepEqual(s.sent, [{ channel: 'text-1', text: 'Atenção, a música vai começar.' }]);
  assert.deepEqual(s.played.map(item => item.text), ['Atenção, a música vai começar.']);
  assert.deepEqual(s.played[0].options, { interruptMusic: true });
  await s.controller.repeatLastSpeech();
  assert.deepEqual(s.played.map(item => item.text), ['Atenção, a música vai começar.', 'Atenção, a música vai começar.']);
  const diagnosis = s.controller.diagnostics();
  assert.match(diagnosis, /DIAGNÓSTICO RÁPIDO/);
  assert.match(diagnosis, /Groq \/ teste/);
  assert.match(diagnosis, /Última fala: Atenção/);
});

test('painel completo seleciona call, fala, envia mensagem e desliga sem alterar Discord real', async () => {
  const s = setup();
  const answers = ['3', '2', '5', '16', 'mensagem do painel', '14', '1,25', '13', '2', '19', 'inválido', '0', '99'];
  let output = '', shutdowns = 0;
  const consoleObject = { log() {}, info() {}, warn() {}, error() {} };
  const originalLog = consoleObject.log;
  class Interface extends EventEmitter {
    question(prompt, callback) {
      output += prompt;
      assert.ok(answers.length, 'o menu não deve pedir entradas extras');
      setImmediate(() => callback(answers.shift()));
    }
    prompt() {}
    close() { this.emit('close'); }
  }
  const panel = new TerminalPanel(s.controller, {
    input: { isTTY: true }, output: { isTTY: true, columns: 88, write(text) { output += text; } },
    consoleObject, createInterface: () => new Interface(), onShutdown: () => { shutdowns++; }
  });
  await panel.start();
  assert.equal(shutdowns, 1);
  assert.equal(panel.running, false);
  assert.equal(consoleObject.log, originalLog);
  assert.match(output, /PAINEL DO BOT/);
  assert.match(output, /Opção inválida/);
  assert.equal(s.played.length, 1);
  assert.deepEqual(s.sent, [{ channel: 'text-1', text: 'mensagem do painel' }]);
  assert.equal(s.settings.state.ttsSpeed, 1.25);
  assert.equal(s.settings.state.ttsVoice, 'francisca');
});

test('readline real aceita entrada e encerra pelo menu', { timeout: 3000 }, async () => {
  const s = setup();
  const input = new PassThrough();
  input.isTTY = true;
  let text = '', answered = false, shutdowns = 0;
  const output = new Writable({ write(chunk, encoding, callback) {
    text += chunk.toString();
    if (!answered && text.includes('Escolha >')) {
      answered = true;
      setImmediate(() => input.write('99\r'));
    }
    callback();
  } });
  output.isTTY = true; output.columns = 88;
  const panel = new TerminalPanel(s.controller, { input, output,
    consoleObject: { log() {}, info() {}, warn() {}, error() {} }, onShutdown: () => { shutdowns++; }
  });
  try {
    await panel.start();
    assert.equal(shutdowns, 1);
    assert.match(text, /Escolha >/);
  } finally { panel.stop(); input.destroy(); output.destroy(); }
});

test('fechar entrada cancela pergunta pendente; sem TTY não abre painel', async () => {
  const s = setup();
  const skipped = new TerminalPanel(s.controller, { input: { isTTY: false }, output: { isTTY: false } });
  assert.equal(skipped.start(), undefined);
  const panel = new TerminalPanel(s.controller);
  panel.running = true;
  panel.rl = { question() {}, close() {} };
  const pending = panel.ask('teste');
  panel.stop();
  assert.equal(await pending, null);
});

test('menu neutraliza códigos de controle em nomes externos', () => {
  const s = setup().controller.status();
  s.username = '\x1b[2Jnome';
  const text = menuText(s, 70);
  assert.ok(!text.includes('\x1b'));
  assert.match(text, /nome/);
  assert.match(text, /99  Desligar o bot/);
  assert.match(text, /23  Diagnóstico rápido/);
});

test('atualização do painel preserva entrada parcial e guarda logs sem despejá-los na tela', { timeout: 3000 }, async () => {
  const s = setup();
  const input = new PassThrough();
  input.isTTY = true;
  let text = '';
  const output = new Writable({ write(chunk, encoding, callback) { text += chunk.toString(); callback(); } });
  output.isTTY = true; output.columns = 88; output.rows = 24;
  const consoleObject = { log() {}, info() {}, warn() {}, error() {} };
  const panel = new TerminalPanel(s.controller, { input, output, consoleObject });
  try {
    const done = panel.start();
    await new Promise(resolve => setImmediate(resolve));
    input.write('9');
    const before = text;
    consoleObject.log('faixa começou');
    assert.equal(text, before);
    panel.render(true);
    assert.equal(panel.rl.line, '9');
    assert.match(text, /faixa começou/);
    assert.ok(panel.logs.includes('faixa começou'));
    input.write('9\r');
    await done;
    assert.equal(panel.running, false);
  } finally { panel.stop(); input.destroy(); output.destroy(); }
});
