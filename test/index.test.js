const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { loadModule, deferred } = require('./helpers');

function setup({ env = {}, llm = {}, loginError } = {}) {
  const ready = deferred();
  const sent = [], played = [], errors = [], removed = [];
  let client, manager, speechHandler;
  const panels = [];
  class Discord extends EventEmitter {
    constructor(token, options) {
      super(); client = this; this.me = { id: 'bot' };
      this.token = token; this.bot = options.bot; this.loginCalls = 0;
      this.voiceStates = new Map(); this.users = new Map();
    }
    async login() { this.loginCalls++; if (loginError) throw loginError; return this.me; }
    destroy() { this.connected = false; }
    async sendMessage(channel, text) { sent.push({ channel, text }); }
    async typing() {}
    async ack() {}
    getVoiceChannelOf() { return 'call'; }
    async resolveVoiceChannelOf() { return 'call'; }
  }
  class Voice {
    constructor(discord, onSpeech) { manager = this; speechHandler = onSpeech; this.active = new Map(); }
    get(guild) { return this.active.get(guild); }
    async join(guild, channelId) {
      await ready.promise;
      const session = { channelId, tracks: [] };
      this.active.set(guild, session);
      return session;
    }
    async playFiles(guild, files, options) { played.push(guild); options?.onPlaying?.(); return true; }
    async leave(guild) { this.active.delete(guild); }
  }
  const logger = new Proxy({}, { get: () => new Proxy(() => {}, { get: (_, name) => name === 'error' ? (...args) => errors.push(args) : () => {} }) });
  loadModule('src/index.js', {
    dotenv: { config() {} },
    fs: { mkdirSync() {}, unlinkSync(file) { removed.push(file); } },
    './discord': { DiscordSelfbot: Discord },
    './voice': { ZeroVoiceManager: Voice, hasFfmpeg: () => true },
    './web-panel': { WebPanel: class {
      constructor(controller) { this.controller = controller; panels.push(this); }
      async start() { this.started = true; return 'http://127.0.0.1:3210'; }
    } },
    './config': {
      config: { prefix: '!', autoJoinOnMention: true, replyInTextToo: true },
      state: { ttsVoice: 'nova', ttsSpeed: 1 }, getCurrent: () => 'natural', getSystemPrompt: () => 'test'
    },
    './llm': {
      think: async () => 'resposta', speak: async () => 'fake.mp3',
      transcribe: async () => ({ text: 'teste de conversa', language: 'pt' }),
      llmInfo: { chatProvider: 'Groq', chatModel: 'model', sttProvider: 'Groq', sttModel: 'stt' },
      ...llm
    },
    './alive': { AliveSystem: class { constructor() { this.channels = new Set(); } start() {} } },
    './logger': logger
  }, {
    process: { env: { BOT_TOKEN: 'test', GROQ_API_KEY: 'test', OWNER_ID: 'owner', PANEL_CHANNEL: 'panel', WEB_PANEL: '0', ...env }, argv: [], uptime: () => 10, exit: code => errors.push(['exit', code]) },
    setInterval: () => 0, clearInterval() {}, clearTimeout() {},
    setTimeout: (callback, delay) => { if (delay < 3000) queueMicrotask(callback); return 0; }
  });
  const message = (content, channel_id = 'text') => ({
    id: 'message', channel_id, guild_id: 'guild', content,
    author: { id: 'owner', username: 'owner' }, mentions: [{ id: 'bot' }]
  });
  return { client, manager, speechHandler, ready, sent, played, errors, removed, message, panels };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('modo explícito selfbot seleciona token da conta mesmo com BOT_TOKEN preenchido', async () => {
  const s = setup({ env: { DISCORD_MODE: 'selfbot', TOKEN: 'personal-token' } });
  await tick();
  assert.equal(s.client.bot, false);
  assert.equal(s.client.token, 'personal-token');
  assert.equal(s.client.loginCalls, 1);
});

test('central abre sem token e não tenta autenticar com outra conta', async () => {
  const s = setup({ env: { DISCORD_MODE: 'selfbot', TOKEN: '', WEB_PANEL: '1' } });
  await tick();
  assert.equal(s.panels[0].started, true);
  assert.equal(s.client.loginCalls, 0);
  assert.equal(s.panels[0].controller.status().connection.mode, 'selfbot');
  assert.deepEqual(await s.panels[0].controller.listServers(), []);
  assert.deepEqual(s.errors, []);
});

test('login inválido mantém a central aberta e não devolve a credencial no erro', async () => {
  const s = setup({ env: { WEB_PANEL: '1' }, loginError: Object.assign(new Error('secret-token'), { status: 401 }) });
  await tick();
  assert.equal(s.panels[0].started, true);
  const status = s.panels[0].controller.status();
  assert.match(status.connectionError, /recusou o token/);
  assert.ok(!JSON.stringify(status).includes('secret-token'));
  assert.ok(!s.errors.some(item => item[0] === 'exit'));
  s.client.emit('invalidToken');
  assert.ok(!s.errors.some(item => item[0] === 'exit'));
});

test('menção do dono responde e aguarda a entrada antes de falar', async () => {
  const s = setup();
  const handled = s.client.listeners('message')[0](s.message('<@bot> fala comigo'));
  await tick();
  assert.ok(s.sent.some(m => m.text.includes('resposta')));
  assert.equal(s.played.length, 0);
  s.ready.resolve();
  await handled;
  await tick();
  assert.deepEqual(s.played, ['guild']);
  assert.deepEqual(s.errors, []);
});

test('texto não espera confirmação de leitura nem consulta lenta da call', async () => {
  const s = setup();
  const lookup = deferred();
  const read = deferred();
  s.client.resolveVoiceChannelOf = () => lookup.promise;
  s.client.ack = () => read.promise;
  const handled = s.client.listeners('message')[0](s.message('<@bot> responde rápido'));
  await tick();
  assert.ok(s.sent.some(m => m.text.includes('resposta')));
  lookup.resolve(null);
  read.resolve();
  await handled;
});

test('neve, nevas e neva7 ativam o bot sem menção', async () => {
  for (const wakeWord of ['neve', 'nevas', 'neva7']) {
    const s = setup();
    s.ready.resolve();
    const message = s.message(`${wakeWord}, responde aí`);
    message.mentions = [];
    await s.client.listeners('message')[0](message);
    assert.ok(s.sent.some(m => m.text.includes('resposta')), wakeWord);
  }
});

test('painel status e logs de inicialização não usam variáveis indefinidas', async () => {
  const s = setup();
  await s.client.listeners('message')[0](s.message('status', 'panel'));
  await tick();
  assert.ok(s.sent.some(m => m.text.includes('Groq model')));
  assert.deepEqual(s.errors, []);
});

test('fala capturada só responde no servidor de origem', async () => {
  const s = setup();
  s.manager.active.set('first', { channelId: 'call', tracks: [] });
  s.manager.active.set('second', { channelId: 'another-call', tracks: [] });
  await s.speechHandler('person', 'fake.wav', 'first');
  assert.deepEqual(s.played, ['first']);
});

test('fala a primeira frase enquanto a LLM ainda transmite o restante', async () => {
  const complete = deferred();
  const s = setup({ llm: {
    thinkStream: async (text, user, prompt, lang, context) => {
      context.onSentence('Primeira frase.');
      await complete.promise;
      context.onSentence('Segunda frase.');
      return 'Primeira frase. Segunda frase.';
    }
  } });
  s.manager.active.set('guild', { channelId: 'call', tracks: [] });
  const replying = s.speechHandler('owner', 'fake.wav', 'guild');
  await tick();
  assert.deepEqual(s.played, ['guild']);
  complete.resolve();
  await replying;
  assert.deepEqual(s.played, ['guild', 'guild']);
});

test('menção começa a voz enquanto a resposta ainda está sendo interpretada e o chat está travado', async () => {
  const complete = deferred(), sending = deferred();
  const s = setup({ llm: {
    thinkStream: async (text, user, prompt, lang, context) => {
      context.onSentence('Primeira frase.');
      await complete.promise;
      context.onSentence('Segunda frase.');
      return 'Primeira frase. Segunda frase.';
    }
  } });
  s.manager.active.set('guild', { channelId: 'call', tracks: [] });
  s.client.sendMessage = () => sending.promise;
  const handling = s.client.listeners('message')[0](s.message('neve, conversa comigo'));
  await tick();
  assert.deepEqual(s.played, ['guild']);
  complete.resolve();
  await tick();
  assert.deepEqual(s.played, ['guild', 'guild']);
  assert.equal(s.manager.get('guild').responseAbort, null);
  sending.resolve();
  await handling;
});

test('falha de IA antes do primeiro trecho ainda permite falar o aviso de erro', async () => {
  const texts = [];
  const s = setup({ llm: {
    thinkStream: async () => { throw new Error('IA indisponível'); },
    speak: async text => { texts.push(text); return 'error.mp3'; }
  } });
  s.manager.active.set('guild', { channelId: 'call', tracks: [] });
  await s.client.listeners('message')[0](s.message('neve, responde'));
  assert.deepEqual(texts, ['opa, travei aqui, fala de novo?']);
  assert.deepEqual(s.played, ['guild']);
});

test('interromper uma resposta de menção cancela também a IA e os próximos trechos', async () => {
  const complete = deferred();
  let signal;
  const s = setup({ llm: {
    thinkStream: async (text, user, prompt, lang, context) => {
      signal = context.signal;
      context.onSentence('Primeira.');
      await complete.promise;
      context.onSentence('Segunda.');
      return 'Primeira. Segunda.';
    }
  } });
  const session = { channelId: 'call', tracks: [] };
  s.manager.active.set('guild', session);
  const handling = s.client.listeners('message')[0](s.message('neve, responde'));
  await tick();
  session.responseAbort.abort();
  assert.equal(signal.aborted, true);
  complete.resolve();
  await handling;
  assert.deepEqual(s.played, ['guild']);
  assert.deepEqual(s.sent, []);
  assert.equal(session.responseAbort, null);
});

test('prepara o próximo arquivo enquanto o anterior toca e remove os dois depois', async () => {
  const playback = deferred();
  const synthesized = [], files = [];
  const s = setup({ llm: {
    thinkStream: async (text, user, prompt, lang, context) => {
      ['Primeira.', 'Segunda.'].forEach(context.onSentence);
      return 'Primeira. Segunda.';
    },
    speak: async text => { synthesized.push(text); return `${text}.mp3`; }
  } });
  s.manager.active.set('guild', { channelId: 'call', tracks: [] });
  s.manager.playFiles = async (guild, paths) => {
    files.push(...paths);
    if (files.length === 1) await playback.promise;
    return true;
  };
  const handling = s.speechHandler('owner', 'fake.wav', 'guild');
  await tick();
  assert.deepEqual(synthesized, ['Primeira.', 'Segunda.']);
  assert.deepEqual(files, ['Primeira..mp3']);
  playback.resolve();
  await handling;
  assert.deepEqual(files, ['Primeira..mp3', 'Segunda..mp3']);
  assert.ok(s.removed.includes('Primeira..mp3'));
  assert.ok(s.removed.includes('Segunda..mp3'));
});

test('interromper limpa arquivo pré-gerado que termina tarde e impede a próxima fala', async () => {
  const playback = deferred(), synthesis = deferred();
  const signals = [], files = [];
  const s = setup({ llm: {
    thinkStream: async (text, user, prompt, lang, context) => {
      ['Primeira.', 'Segunda.'].forEach(context.onSentence);
      return 'Primeira. Segunda.';
    },
    speak: async (text, lang, options) => {
      signals.push(options.signal);
      return text === 'Primeira.' ? 'first.mp3' : synthesis.promise;
    }
  } });
  const session = { channelId: 'call', tracks: [] };
  s.manager.active.set('guild', session);
  s.manager.playFiles = async (guild, paths) => { files.push(...paths); await playback.promise; return false; };
  const handling = s.speechHandler('owner', 'fake.wav', 'guild');
  await tick();
  session.responseAbort.abort();
  assert.ok(signals.every(signal => signal.aborted));
  playback.resolve();
  await handling;
  synthesis.resolve('late.mp3');
  await tick();
  assert.deepEqual(files, ['first.mp3']);
  assert.ok(s.removed.includes('late.mp3'));
});

test('teste de voz avisa falha de reprodução sem anunciar sucesso', async () => {
  const s = setup();
  s.ready.resolve();
  s.manager.playFiles = async () => { throw new Error('FFmpeg falhou'); };
  await s.client.listeners('message')[0](s.message('!teste'));
  assert.ok(s.sent.some(m => /Falhou no teste: FFmpeg falhou/.test(m.text)));
  assert.ok(!s.sent.some(m => m.text.includes('reproduzido')));
});

test('voz começa mesmo com envio da mensagem no chat travado', async () => {
  const s = setup();
  s.ready.resolve();
  await s.client.listeners('message')[0](s.message('!entrar'));
  const sending = deferred();
  s.client.sendMessage = () => sending.promise;
  const replying = s.speechHandler('owner', 'fake.wav', 'guild');
  await tick();
  assert.deepEqual(s.played, ['guild']);
  await replying;
  sending.resolve();
});

test('limite de mensagens de texto não deixa a conversa por voz muda', async () => {
  const s = setup();
  s.ready.resolve();
  await s.client.listeners('message')[0](s.message('!entrar'));
  for (let i = 0; i < 22; i++) await s.speechHandler('owner', 'fake.wav', 'guild');
  assert.equal(s.played.length, 22);
  assert.equal(s.sent.filter(item => item.text === 'resposta').length, 20);
});

test('Gemini começa por streaming mesmo com fallback Edge configurado', async () => {
  const generation = deferred(), playback = deferred(), started = deferred();
  let fileSynthesis = 0;
  const s = setup({ env: { TTS_FALLBACK: 'edge' }, llm: {
    getTtsInfo: () => ({ provider: 'gemini' }),
    speak: async () => { fileSynthesis++; return 'fake.wav'; },
    speakStream: () => ({ stream: {}, done: generation.promise, cancel() {} })
  } });
  s.manager.active.set('guild', { channelId: 'call', tracks: [] });
  s.manager.playPcmStream = async (guild, stream, options) => {
    options.onPlaying(); started.resolve(); await playback.promise; return true;
  };
  const replying = s.speechHandler('owner', 'fake.wav', 'guild', { endedAt: Date.now() - 500 });
  await started.promise;
  assert.equal(fileSynthesis, 0);
  generation.resolve({ firstAudioMs: 100, generationMs: 1000 }); playback.resolve();
  await replying;
  assert.equal(s.manager.get('guild').synthesizing, false);
});

test('Gemini gera o próximo stream durante a fala e toca os streams em ordem', async () => {
  const playback = deferred();
  const generated = [], played = [], disposed = new Set();
  const s = setup({ llm: {
    getTtsInfo: () => ({ provider: 'gemini' }),
    thinkStream: async (text, user, prompt, lang, context) => {
      ['Primeira.', 'Segunda.'].forEach(context.onSentence);
      return 'Primeira. Segunda.';
    },
    speakStream(text) {
      generated.push(text);
      return { stream: { text }, done: Promise.resolve({ firstAudioMs: 100, generationMs: 200 }), cancel: () => disposed.add(text) };
    }
  } });
  s.manager.active.set('guild', { channelId: 'call', tracks: [] });
  s.manager.playPcmStream = async (guild, stream, options) => {
    played.push(stream.text);
    options.onPlaying();
    if (played.length === 1) await playback.promise;
    return true;
  };
  const replying = s.speechHandler('owner', 'fake.wav', 'guild');
  await tick();
  assert.deepEqual(generated, ['Primeira.', 'Segunda.']);
  assert.deepEqual(played, ['Primeira.']);
  playback.resolve();
  await replying;
  assert.deepEqual(played, generated);
  assert.deepEqual([...disposed], generated);
});

test('falha antes do primeiro áudio usa Edge; falha após começar não repete a frase', async () => {
  for (const started of [false, true]) {
    const generation = deferred();
    let fallback = 0;
    const s = setup({ env: { TTS_FALLBACK: 'edge' }, llm: {
      getTtsInfo: () => ({ provider: 'gemini' }),
      speakStream: () => ({ stream: {}, done: generation.promise, cancel() { generation.reject(new Error('cancelada')); } }),
      speak: async (text, lang, options) => { assert.equal(options.provider, 'edge'); fallback++; return 'fake.mp3'; }
    } });
    s.manager.active.set('guild', { channelId: 'call', tracks: [] });
    s.manager.playPcmStream = async (guild, stream, options) => {
      if (started) options.onPlaying();
      throw new Error('stream falhou');
    };
    await s.speechHandler('owner', 'fake.wav', 'guild');
    assert.equal(fallback, started ? 0 : 1);
    assert.equal(s.manager.get('guild').synthesizing, false);
  }
});
