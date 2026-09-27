require('dotenv').config();
const fs = require('fs');
const { DiscordSelfbot } = require('./discord');
const { ZeroVoiceManager } = require('./voice');
const { config, state, listEmotions, getSystemPrompt, setEmotion, setCustom, getInteraction, setInteraction, getCurrent, setVoice, setSpeed, setOption, getBotPresence, setBotPresence } = require('./config');
const { think, thinkStream, transcribe, speak, speakStream, summarizeChannel, chatOnce, flushMemory, llmInfo, listVoices, listVoiceProfiles, getTtsInfo } = require('./llm');
const { AliveSystem } = require('./alive');
const { PanelController } = require('./panel-controller');
const { TerminalPanel } = require('./terminal-panel');
const { WebPanel } = require('./web-panel');
const { LatencyMetrics } = require('./metrics');
const { ConnectionSettings } = require('./connection-settings');
const { SocialHub } = require('./social-hub');
const { createSpeechPipeline } = require('./speech-pipeline');
const { LiveService } = require('./live/service');
const { detectTextLanguage } = require('./languages');
const log = require('./logger');

// --- Pesquisa web simples via DuckDuckGo HTML ---
async function searchWeb(query, numResults = 5) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0' }
    });
    const html = await res.text();
    const results = [];
    // Extrai títulos e snippets do HTML
    const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = resultRegex.exec(html)) && results.length < numResults) {
      const href = match[1];
      const title = match[2].replace(/<[^>]*>/g, '').trim();
      const snippet = match[3].replace(/<[^>]*>/g, '').trim();
      if (title && snippet) results.push({ title, snippet, url: href });
    }
    return results;
  } catch (e) {
    console.error('[pesquisa] erro:', e.message);
    return [];
  }
}

// --- Contexto ativo por guild ---
const activeContexts = new Map(); // guildId -> { topic, summary, sources, timestamp }

function clearTopicContext(guildId) {
  return activeContexts.delete(guildId);
}

const connectionSettings = new ConnectionSettings({ env: process.env });
const TOKEN = connectionSettings.active.token;
const BOT_MODE = connectionSettings.active.mode === 'bot';
const WEB_ENABLED = process.env.WEB_PANEL !== '0' && !process.argv?.includes('--no-panel');
if (!BOT_MODE) {
  console.log('[aviso] selfbot ativo: automações e respostas contínuas ficam bloqueadas por segurança. Use só comandos manuais e locais.');
}
if (!process.env.GROQ_API_KEY && !process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) console.log('Configure GEMINI_API_KEY, GROQ_API_KEY ou OPENAI_API_KEY no .env para habilitar as respostas de IA.');

const PREFIX = config.prefix || '!';
const BOT_NAME = String(config.botName || 'neva7').trim() || 'neva7';
const DEFAULT_WAKE_WORDS = ['neve', 'nevas', 'neva7'];
const configuredWakeWords = process.env.WAKE_WORDS || (Array.isArray(config.wakeWords) ? config.wakeWords.join(',') : config.wakeWords);
const WAKE_WORDS = String(configuredWakeWords || DEFAULT_WAKE_WORDS.join(','))
  .split(',').map(word => word.trim().toLocaleLowerCase('pt-BR')).filter(Boolean);
const OWNER_ID = (process.env.OWNER_ID || '').trim(); // seu id de usuário (modo bot: só você configura)
const initialBotPresence = typeof getBotPresence === 'function'
  ? getBotPresence()
  : { status: 'online', type: 0, name: 'Conversando no Discord', state: '', url: '' };
const discord = new DiscordSelfbot(TOKEN, {
  bot: BOT_MODE,
  presence: process.env.BOT_ACTIVITY ? { ...initialBotPresence, name: process.env.BOT_ACTIVITY } : initialBotPresence
});
discord.loginError = connectionSettings.active.error || (!TOKEN ? 'Informe o token no cartão Conexão com o Discord.' : '');
const lastTextChannel = new Map(); // guildId -> channelId
const lastMention = new Map(); // userId -> timestamp (anti-spam)
const recentReplies = []; // timestamps p/ teto global de msgs
const voiceIdleTimer = new Map(); // guildId -> timeout
let terminalPanel = null;
let webPanel = null;
let panelController = null;
let shuttingDown = false;
let liveService = null;
const metrics = new LatencyMetrics();
const social = new SocialHub();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isAbortError = (error) => {
  if (!error) return false;
  const message = String(error.message || error).toLowerCase();
  return error.name === 'AbortError' || /abort|cancel/i.test(message);
};

const { resolveTrack } = require('./music');

// teto: no máximo 20 respostas a cada 10 min (gente não flooda)
function overLimit() {
  const now = Date.now();
  while (recentReplies.length && now - recentReplies[0] > 10 * 60 * 1000) recentReplies.shift();
  return recentReplies.length >= 20;
}

function armIdleLeave(guildId, minutes = 12) {
  clearTimeout(voiceIdleTimer.get(guildId));
  voiceIdleTimer.set(guildId, setTimeout(async () => {
    try {
      const session = voice.get(guildId);
      if (session?.musicBusy || session?.playing || session?.tracks?.length || voice.recordings?.isActive(guildId)) {
        armIdleLeave(guildId, minutes);
        return;
      }
      await voice.leave(guildId);
      console.log(`[voz] saí por inatividade (${minutes}min)`);
    } catch {}
  }, minutes * 60 * 1000));
}

function prepareSpeech(text, lang, signal) {
  const abort = new AbortController();
  const synthesisSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  const provider = getTtsInfo?.().provider;
  const startedAt = Date.now();
  let generated, file, disposed = false, generationSettled = false;
  const removeFile = () => {
    if (file) { try { fs.unlinkSync(file); } catch {} file = null; }
  };
  const markSettled = () => { generationSettled = true; };
  const ready = Promise.resolve().then(async () => {
    if (synthesisSignal.aborted) throw new Error('Síntese cancelada.');
    if (provider === 'gemini') {
      generated = speakStream(text, lang, { signal: synthesisSignal });
      generated.done.then(markSettled, markSettled).catch(() => {});
      return { generated };
    }
    file = await speak(text, lang, { signal: synthesisSignal });
    if (disposed || synthesisSignal.aborted) {
      removeFile();
      throw new Error('Síntese cancelada.');
    }
    markSettled();
    metrics.observe('tts', Date.now() - startedAt);
    return { file };
  });
  ready.catch(() => {});
  return {
    ready, provider, startedAt,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!generationSettled) {
        abort.abort();
      }
      generated?.cancel();
      removeFile();
    }
  };
}

async function sayInVoice(guildId, text, lang = 'pt', { interruptMusic = false, signal, onPlaying = () => {}, prepared } = {}) {
  if (liveService?.settings.value.killed || liveService?.settings.value.safeMode) return false;
  if (signal?.aborted) return false;
  let conn = voice.get(guildId);
  // Uma fila sem reprodução ativa é resíduo de uma tentativa cancelada/falha; não deve
  // impedir o bot de voltar a falar para sempre.
  if (conn && !conn.musicBusy && !conn.currentTrack && conn.tracks?.length) {
    voice.stopMusic(guildId);
    console.log('[voz] fila de música órfã removida antes da fala');
    conn = voice.get(guildId);
  }
  // Só ações manuais interrompem música. Conversas automáticas seguem respeitando a fila.
  if (interruptMusic && conn && (conn.musicBusy || conn.currentTrack || conn.tracks?.length)) {
    const stopped = voice.stopMusic(guildId);
    if (stopped) {
      console.log('[voz] música interrompida para uma fala solicitada manualmente');
      // O abort da música é assíncrono; aguarda a limpeza da fila antes de iniciar o TTS.
      const musicDone = conn.musicDone;
      if (musicDone) await Promise.race([Promise.resolve(musicDone).catch(() => {}), sleep(2000)]);
      conn = voice.get(guildId);
    }
  }
  if (signal?.aborted) return false;
  if (!conn || conn.synthesizing || conn.playing || conn.musicBusy) {
    console.log(`[voz] sayInVoice bloqueado: conn=${!!conn} syn=${conn?.synthesizing} play=${conn?.playing} music=${conn?.musicBusy}`);
    return false;
  }
  conn.synthesizing = true;
  const abort = new AbortController();
  const synthesisSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  conn.synthesisAbort = abort;
  const audio = prepared || prepareSpeech(text, lang, synthesisSignal);
  const cancelAudio = () => audio.dispose();
  synthesisSignal.addEventListener('abort', cancelAudio, { once: true });
  let mp3;
  const synthesisStarted = audio.startedAt;
  try {
    console.log(`[voz] sayInVoice: gerando áudio para "${text.slice(0, 50)}..."`);
    // O Gemini entrega PCM em blocos. Começar a tocar após um buffer curto elimina a
    // espera pela frase inteira; Edge continua no caminho já estável de arquivo.
    if (audio.provider === 'gemini') {
      let generated, playback, started = false;
      try {
        ({ generated } = await audio.ready);
        playback = voice.playPcmStream(guildId, generated.stream, {
          signal: synthesisSignal,
          onPlaying: () => { started = true; onPlaying(); }
        }).then(played => { if (!played) generated.cancel(); return played; });
        const [played, generatedResult] = await Promise.all([playback, generated.done]);
        metrics.observe('tts', generatedResult.generationMs ?? Date.now() - synthesisStarted);
        if (Number.isFinite(generatedResult.firstAudioMs)) metrics.observe('firstAudio', generatedResult.firstAudioMs);
        return !!played;
      } catch (error) {
        generated?.cancel();
        await Promise.allSettled([playback, generated?.done]);
        // O fallback não desativa streaming e não repete uma frase já parcialmente falada.
        if (synthesisSignal.aborted || started || (process.env.TTS_FALLBACK || 'none') !== 'edge') throw error;
        console.error('[tts] Gemini indisponível; usando Edge:', error.message);
        const fallbackStarted = Date.now();
        mp3 = await speak(text, lang, { provider: 'edge', signal: synthesisSignal });
        metrics.observe('tts', Date.now() - fallbackStarted);
      }
    } else {
      ({ file: mp3 } = await audio.ready);
    }
    console.log(`[voz] sayInVoice: arquivo gerado: ${mp3}`);
    // Verifica se ainda tá na call antes de tocar
    const stillHere = voice.get(guildId);
    if (synthesisSignal.aborted || !stillHere || stillHere !== conn || stillHere.playing || stillHere.musicBusy || stillHere.tracks?.length) {
      console.log('[voz] sayInVoice: cancelado após síntese (saiu da call ou ocupado)');
      return false;
    }
    console.log('[voz] sayInVoice: reproduzindo...');
    const played = await voice.playFiles(guildId, [mp3], { signal: synthesisSignal, onPlaying });
    return played !== false;
  } catch (error) {
    if (synthesisSignal.aborted || isAbortError(error)) return false;
    console.error('[voz] sayInVoice erro:', error.message);
    throw error;
  } finally {
    synthesisSignal.removeEventListener('abort', cancelAudio);
    audio.dispose();
    conn.synthesizing = false;
    conn.synthesisAbort = null;
    // Arquivos preparados pertencem a audio; só o fallback é criado aqui.
    if (mp3 && audio.provider === 'gemini') { try { fs.unlinkSync(mp3); } catch {} }
  }
}

// A LLM pode terminar enquanto a primeira frase já está tocando. Esta fila preserva
// a ordem dos trechos sem fazer a geração da LLM esperar o TTS ou a reprodução.
function createSpeechQueue(guildId, lang, { signal, ready, onFirstPlaying = () => {} } = {}) {
  let firstPlaying = true;
  let session;
  return createSpeechPipeline({
    signal,
    ready: Promise.resolve(ready).then(() => { session = voice.get(guildId); }),
    canPlay: () => !!session && voice.get(guildId) === session &&
      !session.deaf && !session.musicBusy && !session.synthesizing && !session.playing,
    prepare: (text, synthesisSignal) => prepareSpeech(text, lang, synthesisSignal),
    play: (text, prepared, playbackSignal) => sayInVoice(guildId, text, lang, {
      signal: playbackSignal, prepared,
      onPlaying: () => {
        if (!firstPlaying) return;
        firstPlaying = false;
        onFirstPlaying();
      }
    }),
    onError(error) {
      if (isAbortError(error)) return;
      console.error('[voz] trecho falhou:', error.message);
    },
  });
}

//Helper: nomes das pessoas na call
function getCallMembers(guildId) {
  const session = voice.get(guildId);
  if (!session) return '';
  const myCh = discord.getVoiceChannelOf(guildId, discord.me.id) || session.channelId;
  if (!myCh) return '';
  const names = [];
  for (const [k, v] of discord.voiceStates) {
    if (k.startsWith(guildId + ':') && v.channelId === myCh) {
      const uid = k.split(':')[1];
      if (uid !== discord.me.id) {
        const u = discord.users.get(uid);
        names.push(u?.global_name || u?.username || 'alguém');
      }
    }
  }
  return names.join(', ');
}

const voice = new ZeroVoiceManager(discord, async (userId, wavPath, guildId, turn = {}) => {
  const session = voice.get(guildId);
  if (!session) return;
  const responseAbort = turn.abort || new AbortController();
  session.responseAbort = responseAbort;
  const guildIds = [guildId];
  const speechQueues = [];
  try {
    const sttStarted = Date.now();
    const { text, language } = await transcribe(wavPath, { signal: responseAbort.signal });
    metrics.observe('stt', Date.now() - sttStarted);
    if (responseAbort.signal.aborted || voice.get(guildId) !== session) return;
    console.log(`[voz] ouviu (${userId}) [${language}]:`, text);
    if (!text || text.length < 2) return;
    for (const gid of guildIds) lastVoiceActivity.set(gid, Date.now());

    // áudio curto e engraçado (riso, reação): responde rápido e leve
    const isReaction = text.length < 30 && /\b(haha|ahah|kkkk?|eiitta|nossa|pô|uau|caralho|puta|sério|mano|cara)\b/i.test(text);

    const callMembers = getCallMembers(guildIds[0]);
    const prompt = isReaction
      ? `${getSystemPrompt()}\nAlguém acabou de rir ou dar uma reação na call. Reage de forma natural e curta (1 frase, risada, ou comment rápido).`
      : getSystemPrompt();
    const llmStarted = Date.now();
    let firstVoiceStarted = false;
    speechQueues.push(...guildIds.map(gid => createSpeechQueue(gid, language, {
      signal: responseAbort.signal,
      onFirstPlaying: () => {
        if (firstVoiceStarted || !Number.isFinite(turn.endedAt)) return;
        firstVoiceStarted = true;
        const elapsed = Date.now() - turn.endedAt;
        metrics.observe('voiceReply', elapsed);
        console.log(`[voz] fim da fala até áudio na call: ${elapsed}ms`);
      }
    })));
    let firstSentence = true;
    const enqueueSentence = sentence => {
      if (firstSentence) { firstSentence = false; metrics.observe('firstSentence', Date.now() - llmStarted); }
      speechQueues.forEach(queue => queue.enqueue(sentence));
    };
    const voiceContext = {
      callMembers, botName: BOT_NAME, signal: responseAbort.signal,
      conversationId: `${guildId}:${session.channelId}`, responseMode: 'voice',
      onFirstToken: () => metrics.observe('firstToken', Date.now() - llmStarted)
    };
    // Mantém compatibilidade com integrações antigas que ainda expõem somente think.
    const reply = typeof thinkStream === 'function'
      ? await thinkStream(text, userId, prompt, language, {
        ...voiceContext, onSentence: enqueueSentence
      })
      : await think(text, userId, prompt, language, voiceContext);
    metrics.observe('llm', Date.now() - llmStarted);
    if (responseAbort.signal.aborted || voice.get(guildId) !== session) return;
    console.log('[voz] responde:', reply);
    for (const gid of guildIds) {
      const tc = lastTextChannel.get(gid);
      if (tc && config.replyInTextToo && !overLimit()) {
        // Uma fila/429 no chat não pode atrasar a voz na call.
        Promise.resolve().then(() => {
          if (responseAbort.signal.aborted) return;
          recentReplies.push(Date.now());
          return discord.sendMessage(tc, reply);
        }).catch(() => {});
      }
      armIdleLeave(gid, 12);
      // No caminho sem stream, a resposta inteira entra agora como um único trecho.
      const queue = speechQueues[guildIds.indexOf(gid)];
      if (!queue.count) queue.enqueue(reply);
    }
    await Promise.all(speechQueues.map(queue => queue.done()));
  } catch (e) {
    if (responseAbort.signal.aborted) return;
    console.error('[voz] erro transcrever/responder:', e.message);
  } finally {
    speechQueues.forEach(queue => queue.cancel());
    await Promise.all(speechQueues.map(queue => queue.done()));
    if (session.responseAbort === responseAbort) session.responseAbort = null;
  }
});

// avisos da voz (ex: YouTube barrou) vão pro último canal de texto da guild
if (typeof voice.setLiveFactory === 'function') {
  liveService = new LiveService({voice,discord,onSafety:()=>{
    alive.stop();
    for(const [gid,s] of voice.active){s.responseAbort?.abort();s.synthesisAbort?.abort();s.speechAbort?.abort();voice.stopMusic(gid);}
  },onActivity:guildId=>{
    lastVoiceActivity.set(guildId,Date.now()); armIdleLeave(guildId);
  }});
}
voice.sayText = async (guildId, msg) => {
  const tc = lastTextChannel.get(guildId);
  if (tc) { try { await discord.sendMessage(tc, msg); } catch {} }
};

// sai sozinho quando só sobra o bot na call
const aloneTimer = new Map(); // guildId -> timeout
const lastVoiceActivity = new Map(); // guildId -> timestamp (última fala/entrada)
const lastProactive = new Map(); // guildId -> timestamp (último puxão de assunto)
discord.on('voiceStateUpdate', () => {
  try {
    for (const [gid, session] of voice.active) {
      const myCh = discord.getVoiceChannelOf(gid, discord.me.id) || session.channelId;
      if (!myCh) continue;
      let others = 0;
      for (const [k, v] of discord.voiceStates) {
        if (k.startsWith(gid + ':') && v.channelId === myCh && !k.endsWith(':' + discord.me.id)) others++;
      }
      if (others === 0 && !aloneTimer.has(gid)) {
        // Verifica via REST antes de sair (gateway pode não ter voice state do user)
        const OWNER = (process.env.OWNER_ID || '').trim();
        (async () => {
          try {
            if (OWNER && BOT_MODE) {
              const st = await discord.rest(`/guilds/${gid}/voice-states/${OWNER}`);
              if (st?.channel_id === myCh) { others = 1; }
            }
          } catch {}
          if (others > 0 && aloneTimer.has(gid)) {
            clearTimeout(aloneTimer.get(gid));
            aloneTimer.delete(gid);
            return;
          }
          if (others === 0 && !aloneTimer.has(gid)) {
            console.log('[voz] call esvaziou, saindo em 20s...');
            aloneTimer.set(gid, setTimeout(async () => {
              aloneTimer.delete(gid);
              try { await voice.leave(gid); console.log('[voz] saí (call vazia)'); } catch {}
            }, 20000));
          }
        })();
      } else if (others > 0 && aloneTimer.has(gid)) {
        clearTimeout(aloneTimer.get(gid));
        aloneTimer.delete(gid);
      }
    }
  } catch {}
});

discord.on('ready', async (me) => {
  discord.loginError = '';
  console.log(`Logado como ${me.username} (${me.id}) [${BOT_MODE ? 'BOT oficial' : 'Selfbot'}]`);
  console.log(`Emoção atual: ${getCurrent()} | prefixo: ${PREFIX}`);
  try {
    const { hasFfmpeg } = require('./voice');
    if (!hasFfmpeg()) console.log('[aviso] ffmpeg NÃO encontrado — a voz não vai tocar. Instala: winget install ffmpeg (e reabre o terminal)');
  } catch {}
  // sistema de vida própria
  if (BOT_MODE && !liveService?.settings.value.killed && !liveService?.settings.value.safeMode) alive.start();
  else if (!BOT_MODE) console.log('[segurança] auto-vida desativada em selfbot; só o painel manual fica disponível.');
  const controller = getPanelController();
  controller.ownerId = BOT_MODE ? OWNER_ID || me.id : me.id;
  try { await controller.initialize(); }
  catch (error) { console.error('[painel] não carregou a seleção inicial:', error.message); }
  startWebPanel();
  const liveOptions = liveService?.settings.value;
  if (BOT_MODE && liveOptions?.enabled && !liveOptions.killed && !liveOptions.safeMode && liveOptions.autoJoinGuild && liveOptions.autoJoinChannel) {
    voice.join(liveOptions.autoJoinGuild,liveOptions.autoJoinChannel).catch(() => console.error('[live] Entrada automática falhou; confira o canal e as permissões.'));
  }
  // O terminal é opcional; a central web é a interface principal.
  if (!terminalPanel && process.stdin?.isTTY && process.stdout?.isTTY && process.env.TERMINAL_PANEL === '1' && !process.argv.includes('--no-panel')) {
    terminalPanel = new TerminalPanel(controller, { onShutdown: shutdown });
    terminalPanel.start();
  }
});

// sistema de vida própria (bot manda msg sozinho)
const alive = new AliveSystem(discord, {
  enabled: process.env.ALIVE_ENABLED === '1',
  channels: [], // canais configurados via !viva
  minInterval: 2 * 60 * 1000,
  maxInterval: 8 * 60 * 1000,
  maxPerHour: 8,
  ghostRate: 0.3
});

function getPanelController() {
  if (panelController) return panelController;
  panelController = new PanelController({
    discord, voice, alive, llmInfo, metrics, sayInVoice, resolveTrack, summarizeChannel, clearTopicContext, connectionSettings,
    settings: { config, state, listEmotions, listVoices, listVoiceProfiles, getTtsInfo, getCurrent, getInteraction, setEmotion, setCustom, setInteraction, setVoice, setSpeed, setOption, getBotPresence, setBotPresence },
    ownerId: BOT_MODE ? OWNER_ID || discord.me?.id : discord.me?.id,
    defaultGuildId: process.env.PANEL_GUILD,
    defaultTextChannelId: process.env.PANEL_CHANNEL,
    onJoin: guildId => { lastVoiceActivity.set(guildId, Date.now()); armIdleLeave(guildId); },
    onLeave: guildId => {
      clearTimeout(voiceIdleTimer.get(guildId)); voiceIdleTimer.delete(guildId);
      clearTimeout(aloneTimer.get(guildId)); aloneTimer.delete(guildId);
    },
    onTextChannel: (guildId, channelId) => lastTextChannel.set(guildId, channelId)
  });
  panelController.live = liveService;
  return panelController;
}

function startWebPanel() {
  if (webPanel || !WEB_ENABLED) return;
  const port = Number(process.env.WEB_PANEL_PORT || 3210);
  webPanel = new WebPanel(getPanelController(), {
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3210,
    onShutdown: shutdown
  });
  webPanel.start().then(url => console.log(`[painel] Central web: ${url}`))
    .catch(error => { webPanel = null; console.error('[painel] não iniciou a central web:', error.message); });
}

function stopDiscordActivity(error) {
  discord.loginError = error?.message || 'O Discord recusou o token. Confira a conta no aplicativo oficial e atualize a conexão no painel.';
  console.log(discord.loginError);
  alive.stop?.();
  for (const timer of voiceIdleTimer.values()) clearTimeout(timer);
  for (const timer of aloneTimer.values()) clearTimeout(timer);
  voiceIdleTimer.clear(); aloneTimer.clear();
  for (const gid of new Set([...voice.active.keys(), ...(voice.pending?.keys() || [])])) voice.leave(gid);
  discord.destroy();
  if (!WEB_ENABLED) process.exit(1);
}
discord.on('invalidToken', stopDiscordActivity);
discord.on('connectionStopped', stopDiscordActivity);

// puxa assunto se a call ficar quieta por 5min (com gente, no máx 1x a cada 10min)
const proactiveTimer = setInterval(async () => {
  if (liveService?.settings.value.enabled || liveService?.settings.value.killed || liveService?.settings.value.safeMode) return;
  if (process.env.PROACTIVE_VOICE !== '1' || !discord.connected) return;
  try {
    const now = Date.now();
    for (const [gid] of voice.active) {
      if (voice.get(gid)?.musicBusy) continue;
      const myCh = discord.getVoiceChannelOf(gid, discord.me.id);
      if (!myCh) continue;
      let others = 0;
      for (const [k, v] of discord.voiceStates) {
        if (k.startsWith(gid + ':') && v.channelId === myCh && !k.endsWith(':' + discord.me.id)) others++;
      }
      if (!others) continue;
      if (now - (lastVoiceActivity.get(gid) || now) < 5 * 60 * 1000) continue;
      if (now - (lastProactive.get(gid) || 0) < 10 * 60 * 1000) continue;
      if (overLimit() || Math.random() > 0.6) continue;
      lastProactive.set(gid, now);
      lastVoiceActivity.set(gid, now);
      try {
        const reply = await think('A call tá quieta há um tempo. Comenta algo curto pra puxar assunto com o pessoal.', 'proativa:' + gid, getSystemPrompt());
        if (!discord.connected || !voice.get(gid)) continue;
        const tc = lastTextChannel.get(gid);
        if (tc && config.replyInTextToo) {
          try { await discord.sendMessage(tc, reply); recentReplies.push(Date.now()); } catch {}
        }
        sayInVoice(gid, reply).catch(() => {});
        console.log('[voz] puxei assunto:', reply);
      } catch (e) { console.error('[voz] proativa falhou:', e.message); }
    }
  } catch {}
}, 60 * 1000);

discord.on('message', async (m) => {
  try {
    if (liveService?.settings.value.killed || liveService?.settings.value.safeMode) return;
    const authorId = m.author?.id;
    if (!authorId) return;
    const channelId = m.channel_id;
    const guildId = m.guild_id || null;
    const content = m.content || '';
    if (guildId) social.see(guildId, m.author);
    const socialCommand = content.match(/^!(?:neva\s+)?(lembrar|momento|cena|plano|enquete)\s+([\s\S]+)$/i);
    if (guildId && socialCommand) {
      const command = socialCommand[1].toLocaleLowerCase('pt-BR');
      const data = socialCommand[2].trim();
      if (command === 'lembrar') {
        const note = social.remember(guildId, m.author, data);
        await discord.sendMessage(channelId, '🧠 Guardado na memória do servidor: ' + note);
      } else if (command === 'momento') {
        const item = social.moment(guildId, m.author, data);
        await discord.sendMessage(channelId, '✨ Momento salvo: **' + item.title + '**');
      } else if (command === 'cena') {
        const scene = social.scene(guildId, data.toLocaleLowerCase('pt-BR'));
        await discord.sendMessage(channelId, '🎬 Cena ativa: **' + scene.name + '**. ' + scene.prompt);
      } else if (command === 'plano') {
        const item = social.plan(guildId, m.author, data);
        await discord.sendMessage(channelId, '📌 Próximo passo salvo: ' + item.text);
      } else {
        const parts = data.split('|').map(item => item.trim());
        const poll = social.poll(guildId, m.author, parts.shift(), parts);
        await discord.sendMessage(channelId, '🗳️ **' + poll.question + '**\n' + poll.choices.map((item, index) => (index + 1) + '. ' + item).join('\n'));
      }
      return;
    }
    const isOwner = BOT_MODE ? (OWNER_ID && authorId === OWNER_ID) : (authorId === discord.me.id);

    // ---- PAINEL INTERATIVO: só o owner pode usar, em qualquer canal ----
    const PANEL_CHANNEL = process.env.PANEL_CHANNEL || '1550615621954183221';
    if (channelId === PANEL_CHANNEL && isOwner && !content.startsWith(PREFIX)) {
      const send = (t) => discord.sendMessage(channelId, t);
      const args = content.trim().split(/\s+/);
      const cmd = (args.shift() || '').toLowerCase();

      // --- status ---
      if (cmd === 'status' || cmd === 'st') {
        const vc = guildId ? voice.get(guildId) : null;
        const aliveOn = alive.enabled;
        const aliveChs = [...alive.channels].length;
        const uptime = Math.floor(process.uptime());
        const h = Math.floor(uptime / 3600);
        const m2 = Math.floor((uptime % 3600) / 60);
        const s = uptime % 60;
        await send(`📊 **Status da Bot**\n\`\`\`\n🧠 LLM: ${llmInfo.chatProvider} ${llmInfo.chatModel}\n🎤 STT: ${llmInfo.sttProvider} ${llmInfo.sttModel}\n🔊 TTS: ${getTtsInfo?.().label || 'Edge'}\n🎭 Emoção: ${getCurrent()}\n🎵 Voz: ${getTtsInfo?.().voice || state.ttsVoice} (${state.ttsSpeed}x)\n📡 Call: ${vc ? 'conectado ✅' : 'fora ❌'}\n💚 Vida própria: ${aliveOn ? 'ligado ✅' : 'desligado ❌'} (${aliveChs} canais)\n⏱️ Uptime: ${h}h ${m2}m ${s}s\n👤 Guilds: ${discord.voiceStates.size > 0 ? 'conectado' : 'verificando...'}\n\`\`\``);
        return;
      }

      // --- enviar mensagem ---
      if (cmd === 'enviar' || cmd === 'send') {
        const target = args.shift();
        const msg = args.join(' ');
        if (!target || !msg) { await send('Formato: `enviar <channel_id> <mensagem>`'); return; }
        try {
          await discord.sendMessage(target, msg);
          await send(`✅ Enviado em <#${target}>`);
        } catch (e) { await send(`❌ ${e.message?.slice(0, 100)}`); }
        return;
      }

      // --- entrar na call ---
      if (cmd === 'entrar' || cmd === 'join') {
        if (!guildId) { await send('❌ Use num servidor'); return; }
        const ownerVc = await discord.resolveVoiceChannelOf(guildId, authorId);
        if (!ownerVc) { await send('❌ Você não tá em call'); return; }
        try {
          await voice.join(guildId, ownerVc);
          lastVoiceActivity.set(guildId, Date.now());
          await send(`✅ Entrei em <#${ownerVc}>`);
        } catch (e) { await send(`❌ ${e.message?.slice(0, 80)}`); }
        return;
      }

      // --- sair da call ---
      if (cmd === 'sair' || cmd === 'leave') {
        if (guildId) { await voice.leave(guildId); await send('✅ Saí da call'); }
        else await send('❌ Não tô em call');
        return;
      }

      // --- tocar musica ---
      if (cmd === 'toca' || cmd === 'play') {
        if (!guildId) { await send('❌ Use num servidor'); return; }
        const vc = await discord.resolveVoiceChannelOf(guildId, authorId);
        if (!vc) { await send('❌ Entra numa call primeiro'); return; }
        const query = args.join(' ');
        if (!query) { await send('Formato: `toca <link ou nome>`'); return; }
        try {
          const cur = voice.get(guildId);
          if (!cur || cur.channelId !== vc) {
            await voice.join(guildId, vc);
            lastVoiceActivity.set(guildId, Date.now());
          }
          const track = await resolveTrack(query);
          const n = await voice.enqueueMusic(guildId, [track]);
          await send(`📋 Na fila (${n}): **${track.title}**`);
        } catch (e) { await send(`❌ ${e.message?.slice(0, 100)}`); }
        return;
      }

      // --- parar musica ---
      if (cmd === 'para' || cmd === 'stop') {
        if (guildId && voice.stopMusic(guildId)) await send('⏹ Parei');
        else await send('❌ Nada tocando');
        return;
      }

      // --- vida propria ---
      if (cmd === 'viva' || cmd === 'alive') {
        const sub = (args.shift() || '').toLowerCase();
        if (sub === 'on') { alive.enabled = true; await send('✅ Vida própria ligada'); return; }
        if (sub === 'off') { alive.enabled = false; await send('❌ Vida própria desligada'); return; }
        if (sub === 'add') {
          const ch = args[0] || channelId;
          alive.addChannel(ch);
          await send(`✅ <#${ch}> registrado pra vida própria`);
          return;
        }
        if (sub === 'rm') {
          const ch = args[0] || channelId;
          alive.removeChannel(ch);
          await send(`❌ <#${ch}> removido da vida própria`);
          return;
        }
        const chs = [...alive.channels].map(id => `<#${id}>`).join(', ') || 'nenhum';
        await send(`💚 **Vida própria:** ${alive.enabled ? 'ligado ✅' : 'desligado ❌'}\n📡 **Canais:** ${chs}\n\nComandos: \`viva on/off\` \`viva add <#canal>\` \`viva rm <#canal>\``);
        return;
      }

      // --- emoção ---
      if (cmd === 'emo') {
        const sub = (args.shift() || '').toLowerCase();
        if (sub === 'set') {
          const prompt = args.join(' ');
          if (!prompt) { await send('Formato: `emo set <descrição>`'); return; }
          setCustom(prompt);
          await send('✅ Emoção custom ativada');
          return;
        }
        if (setEmotion(sub)) { await send(`✅ Emoção: **${sub}**`); return; }
        await send(`Emoções: ${listEmotions().join(', ')}\nAtual: **${getCurrent()}**`);
        return;
      }

      // --- voz ---
      if (cmd === 'voz' || cmd === 'voice') {
        const v = (args[0] || '').toLowerCase();
        const validas = listVoices();
        if (!validas.includes(v)) { await send(`Vozes: ${validas.join(', ')}\nAtual: **${getTtsInfo?.().voice || state.ttsVoice}**`); return; }
        setVoice(v);
        await send(`✅ Voz: **${v}**`);
        return;
      }

      // --- velocidade ---
      if (cmd === 'velocidade' || cmd === 'speed') {
        const s = parseFloat(args[0]);
        if (isNaN(s) || s < 0.25 || s > 4) { await send('Formato: `velocidade 0.25-4.0`'); return; }
        setSpeed(s);
        await send(`✅ Velocidade: **${s}x**`);
        return;
      }

      // --- resumo do chat ---
      if (cmd === 'resumo') {
        await send('📝 Resumendo...');
        try {
          const hist = await discord.rest(`/channels/${channelId}/messages?limit=30`);
          const r = await summarizeChannel(hist.slice().reverse().map(h => h.content || '').filter(Boolean));
          await send(`📝 **Resumo:** ${r}`);
        } catch (e) { await send(`❌ ${e.message?.slice(0, 100)}`); }
        return;
      }

      // --- muta/desmuta ---
      if (cmd === 'muta') {
        if (guildId) voice.setListen(guildId, false);
        await send('🤫 Mudo na call');
        return;
      }
      if (cmd === 'desmuta') {
        if (guildId) voice.setListen(guildId, true);
        await send('👂 Voltando a ouvir');
        return;
      }

      // --- painel de ajuda ---
      if (cmd === 'ajuda' || cmd === 'help' || !cmd) {
        await send(`🎮 **Painel de Controle**\n\n📤 **Mensagens:**\n\`enviar <canal_id> <msg>\` — envia msg pra qualquer canal\n\n🎵 **Call/Voz:**\n\`entrar\` \`sair\` \`toca <link>\` \`para\`\n\`muta\` \`desmuta\`\n\n🎭 **Personalidade:**\n\`emo <nome>\` \`emo set <desc>\` — trocar emoção\n\`voz <nome>\` — trocar voz\n\`velocidade <0.25-4>\` — velocidade da fala\n\n💚 **Vida Própria:**\n\`viva on/off\` \`viva add <#canal>\` \`viva rm\`\n\n📊 **Info:**\n\`status\` \`resumo\`\n\n💡 Digite \`ajuda\` pra ver isso de novo`);
        return;
      }

      await send(`❓ Comando não entendi. Digite \`ajuda\` pra ver os comandos.`);
      return;
    }

    // ---- comandos (só você) ----
    if (isOwner && content.startsWith(PREFIX)) {
      const args = content.slice(PREFIX.length).trim().split(/\s+/);
      const cmd = (args.shift() || '').toLowerCase();
      const send = (t) => discord.sendMessage(channelId, t);

      if (cmd === 'emo' || cmd === 'emocao') {
        const sub = (args.shift() || '').toLowerCase();
        if (!sub || sub === 'lista' || sub === 'list') {
          await send(`**Emoções:** ${listEmotions().map(e => `\`${e}\``).join(', ')}\nAtual: **${getCurrent()}**\nUso: \`!emo <nome>\` ou \`!emo set <como ela deve falar>\``);
          return;
        }
        if (sub === 'set' || sub === 'custom') {
          const prompt = args.join(' ');
          if (!prompt) { await send('Uso: `!emo set <descreve como ela fala>`'); return; }
          setCustom(prompt);
          await send(`Emoção custom ativada ✅`);
          return;
        }
        if (sub === 'atual') { await send(`Emoção atual: **${getCurrent()}**`); return; }
        if (setEmotion(sub)) await send(`Emoção trocada pra **${sub}** ✅`);
        else await send(`Não conheço \`${sub}\`. Lista: ${listEmotions().join(', ')}`);
        return;
      }
      if (cmd === 'voz' || cmd === 'voice') {
        const v = (args[0] || '').toLowerCase();
        const validas = listVoices();
        if (!validas.includes(v)) { await send(`Vozes: ${validas.join(', ')}`); return; }
        setVoice(v);
        await send(`Voz trocada pra **${v}** ✅`);
        return;
      }
      if (cmd === 'velocidade' || cmd === 'speed') {
        const s = parseFloat(args[0]);
        if (isNaN(s) || s < 0.25 || s > 4) { await send('Uso: `!velocidade 1.0`'); return; }
        setSpeed(s);
        await send(`Velocidade: **${s}** ✅`);
        return;
      }
      if (cmd === 'sair' || cmd === 'leave' || cmd === 'dc') {
        if (guildId) { await voice.leave(guildId); await send('Saí da call 👋'); }
        else await send('Não tô em call.');
        return;
      }
      if (cmd === 'entrar' || cmd === 'join') {
        // !entrar = entra na SUA call atual
        if (!guildId) { await send('❌ Use num servidor'); return; }
        log.msg.command(authorId, cmd, args);

        const ownerVc = await discord.resolveVoiceChannelOf(guildId, authorId);

        if (!ownerVc) { await send('Entra numa call primeiro que eu te sigo.'); return; }
        try {
          log.voz.join(guildId, ownerVc);
          await voice.join(guildId, ownerVc); lastVoiceActivity.set(guildId, Date.now());
          lastTextChannel.set(guildId, channelId);
          await send(`Entrei na call ✅`);
        } catch (e) {
          log.voz.error('join falhou', e.message);
          await send(`Não consegui entrar: ${e.message}`);
        }
        return;
      }
      if (cmd === 'status') {
        const c = guildId ? voice.get(guildId) : null;
        await send(`**Status:**\nEmoção: \`${getCurrent()}\`\nVoz: \`${getTtsInfo?.().voice || state.ttsVoice}\` (${state.ttsSpeed}x)\nCall: ${c ? 'conectado' : 'fora'}`);
        return;
      }
      if (cmd === 'teste' || cmd === 'test' || cmd === 'tts') {
        if (!guildId) { await send('❌ Use num servidor'); return; }
        log.msg.command(authorId, cmd, args);

        const ownerVc = await discord.resolveVoiceChannelOf(guildId, authorId);
        if (!ownerVc) {
          await send('Entra numa call deste servidor primeiro que eu te sigo.');
          return;
        }
        try {
          await send('Testando voz... 🔊');
          await voice.join(guildId, ownerVc); lastVoiceActivity.set(guildId, Date.now());
          lastTextChannel.set(guildId, channelId);
          const played = await sayInVoice(guildId, 'teste de voz, um dois três, tá me ouvindo?', 'pt', { interruptMusic: true });
          await send(played ? 'Teste de voz reproduzido 🔊' : 'A voz está ocupada ou a música ainda está sendo encerrada. Tente de novo em alguns segundos.');
        } catch (e) { await send(`Falhou no teste: ${e.message}`); }
        return;
      }
      if (cmd === 'resumo') {
        try {
          const msgs = await discord.rest(`/channels/${channelId}/messages?limit=30`);
          const lines = (Array.isArray(msgs) ? msgs : []).reverse()
            .filter(x => x.content && x.content.trim())
            .map(x => `${x.author?.global_name || x.author?.username || '?'}: ${x.content.slice(0, 200)}`);
          const r = await summarizeChannel(lines);
          await send(r.slice(0, 1900));
        } catch (e) { await send(`Não consegui ler o chat: ${e.message}`); }
        return;
      }
      if (cmd === 'contexto' || cmd === 'assunto' || cmd === 'pesquisa') {
        const topic = args.join(' ').trim();
        if (!topic) {
          const cur = activeContexts.get(guildId);
          if (cur) {
            await send(`**Contexto ativo:** ${cur.topic}\n${cur.summary.slice(0, 1500)}\n\nFontes: ${cur.sources.map(s => s.title).join(', ')}\n\nUse \`!contexto limpar\` pra remover.`);
          } else {
            await send('Uso: `!contexto <assunto>` — pesquisa na web e guarda o contexto pra conversar sobre.');
          }
          return;
        }
        if (topic === 'limpar' || topic === 'clear') {
          clearTopicContext(guildId);
          await send('Contexto removido ✅');
          return;
        }
        await send(`Pesquisando sobre **${topic}**... 🔍`);
        try {
          const results = await searchWeb(topic, 5);
          if (!results.length) {
            await send('Não achei nada sobre isso. Tenta com outras palavras.');
            return;
          }
          // Junta os snippets e pede pra IA resumir
          const allSnippets = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}`).join('\n\n');
          const summaryPrompt = `Resuma em até 5 linhas o que foi encontrado sobre "${topic}". Seja direto e informativo. Depois, mencione que pode conversar mais sobre o assunto.\n\nResultados:\n${allSnippets}`;
          const summaryRes = await chatOnce(llmInfo.chatModel, [
            { role: 'user', content: summaryPrompt }
          ]);
          const summary = ((summaryRes.choices?.[0]?.message?.content || '').trim()).slice(0, 1800) || allSnippets.slice(0, 1800);
          activeContexts.set(guildId, {
            topic,
            summary: allSnippets,
            sources: results.map(r => ({ title: r.title, url: r.url })),
            timestamp: Date.now()
          });
          await send(`**${topic}**\n${summary}\n\n💬 Agora posso conversar sobre isso. Manda a pergunta!`);
        } catch (e) {
          await send(`Erro na pesquisa: ${e.message}`);
        }
        return;
      }
      if (cmd === 'toca' || cmd === 'play' || cmd === 'p') {
        if (!guildId) return;
        const q = args.join(' ').trim();
        const att = (m.attachments || []).find(a => (a.content_type || '').startsWith('audio/') || /\.mp3$/i.test(a.filename || ''));
        try {
          let vc = voice.get(guildId);
          if (!vc) {
            const ownerVc = await discord.resolveVoiceChannelOf(guildId, authorId);
            if (!ownerVc) { await send('Entra numa call primeiro.'); return; }
            await voice.join(guildId, ownerVc); lastVoiceActivity.set(guildId, Date.now());
            lastTextChannel.set(guildId, channelId);
          }
          const track = await resolveTrack(q, att);
          const n = await voice.enqueueMusic(guildId, [track]);
          await send(`Na fila (${n}): **${track.title}** 🎵`);
        } catch (e) { await send(`Não rolou: ${e.message}`); }
        return;
      }
      if (cmd === 'fila' || cmd === 'queue') {
        const q = guildId ? voice.musicQueue(guildId) : [];
        await send(q.length ? q.map((t, i) => `${i + 1}. ${t.title}`).join('\n').slice(0, 1800) : 'Fila vazia.');
        return;
      }
      if (cmd === 'pula' || cmd === 'skip' || cmd === 'next') {
        await send(guildId && voice.skipTrack(guildId) ? 'Pulando ⏭' : 'Nada tocando.');
        return;
      }
      if (cmd === 'para' || cmd === 'stop') {
        await send(guildId && voice.stopMusic(guildId) ? 'Parei ⏹' : 'Nada tocando.');
        return;
      }
      if (cmd === 'shuffle' || cmd === 'embaralha') {
        await send(guildId && voice.shuffleTracks(guildId) ? 'Fila embaralhada 🔀' : 'Fila vazia.');
        return;
      }
      if (cmd === 'loop' || cmd === 'repete') {
        if (!guildId) return;
        const r = voice.toggleLoop(guildId);
        await send(r ? 'Loop ativado 🔁 (música repete sempre)' : 'Loop desativado ⏹');
        return;
      }
      if (cmd === 'volume' || cmd === 'vol') {
        const v = parseInt(args[0], 10);
        if (isNaN(v) || v < 0 || v > 200) { await send('Uso: `!volume 0-200` (100 = normal)'); return; }
        voice.setVolumes(guildId, { speech: v / 100, music: (v / 100) * 0.7 });
        await send(`Volume: **${v}** 🔊`);
        return;
      }
      if (cmd === 'muta' || cmd === 'mute') {
        if (guildId) voice.setListen(guildId, false);
        await send('Fico quietinha na call, só texto 🤫 (`!desmuta` volta)');
        return;
      }
      if (cmd === 'desmuta' || cmd === 'unmute') {
        if (guildId) voice.setListen(guildId, true);
        await send('Voltei a ouvir 👂');
        return;
      }
      if (cmd === 'viva' || cmd === 'alive') {
        const sub = (args.shift() || '').toLowerCase();
        if (sub === 'on' || sub === 'ligar') {
          alive.enabled = true;
          await send('Modo vida própria ligado ✅');
          return;
        }
        if (sub === 'off' || sub === 'desligar') {
          alive.enabled = false;
          await send('Modo vida própria desligado ❌');
          return;
        }
        if (sub === 'add' || sub === 'adicionar') {
          const chId = args[0] || channelId;
          alive.addChannel(chId);
          await send(`Canal <#${chId}> registrado pra vida própria ✅`);
          return;
        }
        if (sub === 'rm' || sub === 'remover' || sub === 'remove') {
          const chId = args[0] || channelId;
          alive.removeChannel(chId);
          await send(`Canal <#${chId}> removido da vida própria ❌`);
          return;
        }
        if (sub === 'lista' || sub === 'list' || !sub) {
          const chs = [...alive.channels].map(id => `<#${id}>`).join(', ') || 'nenhum';
          await send(`**Vida própria:** ${alive.enabled ? '✅ ligado' : '❌ desligado'}\n**Canais:** ${chs}\n**Intervalo:** ${alive.minInterval/1000}s-${alive.maxInterval/1000}s\n**Máx/hora:** ${alive.maxPerHour}\n\nUso: \`!viva add <#canal>\` \`!viva on/off\` \`!viva rm <#canal>\``);
          return;
        }
        return;
      }
      if (cmd === 'ajuda' || cmd === 'help') {
        await send(`**Comandos:**\n\`!contexto <assunto>\` — pesquisa e guarda contexto\n\`!contexto\` — ver contexto ativo | \`!contexto limpar\`\n\`!emo lista\` \`!emo <nome>\` \`!emo set <texto>\`\n\`!voz <nome>\`\n\`!entrar\` \`!sair\` \`!status\` \`!teste\`\n\`!resumo\` — resume o papo do chat\n\`!toca <link .mp3|nome>\` \`!fila\` \`!pula\` \`!para\`\n\`!shuffle\` \`!loop\` \`!volume 0-200\` \`!muta\` \`!desmuta\`\n\`!viva add\` \`!viva on/off\` — vida própria (msg sozinha)\n\nMarca @bot ou fala o nome dela que ela entra na call e conversa.`);
        return;
      }
      return;
    }

    if (authorId === discord.me.id) return;
    if (m.author?.bot) return;

    // ---- ativação: @marcado OU chamou pelo nome (wake word) ----
    const low = content.toLocaleLowerCase('pt-BR');
    const mentioned = (m.mentions || []).some(u => u.id === discord.me.id)
      || content.includes(`<@${discord.me.id}>`)
      || content.includes(`<@!${discord.me.id}>`)
      || WAKE_WORDS.some(word => low.includes(word));
    if (!mentioned) return;

    // anti-spam: ignora menção repetida do mesmo user em <10s (gente não responde na hora 2x)
    const now = Date.now();
    const last = lastMention.get(authorId) || 0;
    if (now - last < 10000) return;
    lastMention.set(authorId, now);
    if (overLimit()) { console.log('[msg] teto de respostas atingido, ignorando'); return; }

    log.msg.received(m.author?.username || authorId, guildId || 'DM', content.slice(0, 120));
    if (guildId) lastTextChannel.set(guildId, channelId);
    const responseStarted = Date.now();

    const texto = content.replace(/<@!?\d+>/g, '').trim().slice(0, 400) || 'e aí?';
    const nome = (m.member?.nick || m.author?.global_name || m.author?.username || 'alguém').slice(0, 30);

    // A resposta de texto nunca espera a consulta ou a entrada na call.
    // ACK/typing usam a mesma fila REST do Discord e podem atrasar a primeira mensagem.
    let joinPromise = null;
    if (guildId && config.autoJoinOnMention) {
      joinPromise = discord.resolveVoiceChannelOf(guildId, authorId)
        .then(async (vcId) => {
          if (!vcId) {
            log.debug('autojoin', 'Autor fora de call (sem voiceState) — respondo só texto');
            return;
          }
          const cur = voice.get(guildId);
          if (!cur || cur.channelId !== vcId) {
            log.voz.join(guildId, vcId);
            await voice.join(guildId, vcId);
            lastVoiceActivity.set(guildId, Date.now());
            log.voz.ready(guildId);
          }
          armIdleLeave(guildId, 12);
        })
        .catch(error => log.voz.error('não consegui consultar/entrar na call', error.message));
    }

    // A menção usa o mesmo fluxo da call: cada trecho segue para voz assim que chega.
    const responseAbort = new AbortController();
    let speechSession;
    const speechReady = Promise.resolve(joinPromise).then(() => {
      speechSession = guildId ? voice.get(guildId) : null;
      if (!speechSession || speechSession.responseAbort) { speechQueue?.cancel(); return; }
      speechSession.responseAbort = responseAbort;
      speechSession.responseUserId = authorId;
    });
    const textLanguage = detectTextLanguage(texto);
    const speechQueue = guildId ? createSpeechQueue(guildId, textLanguage, {
      signal: responseAbort.signal, ready: speechReady,
      onFirstPlaying: () => metrics.observe('textVoiceReply', Date.now() - responseStarted)
    }) : null;

    // 2) pensa e responde — com contexto de quem fala, quem tá na call, e contexto ativo
    let reply;
    try {
      const callMembers = guildId ? getCallMembers(guildId) : '';
      const ctx = guildId ? activeContexts.get(guildId) : null;
      const extraContext = {};
      if (callMembers) extraContext.callMembers = callMembers;
      if (ctx) {
        extraContext.topicContext = `Contexto ativo: ${ctx.topic}\n${ctx.summary.slice(0, 800)}`;
      }
      const llmStarted = Date.now();
      const context = {
        ...extraContext, botName: BOT_NAME, signal: responseAbort.signal,
        conversationId: `${guildId || 'DM'}:${channelId}`, responseMode: 'text',
        onFirstToken: () => metrics.observe('firstToken', Date.now() - llmStarted)
      };
      let firstSentence = true;
      reply = speechQueue && typeof thinkStream === 'function'
        ? await thinkStream(`[${nome} diz:] ${texto}`, authorId, getSystemPrompt(), textLanguage, {
          ...context, onSentence: sentence => {
            if (firstSentence) { firstSentence = false; metrics.observe('firstSentence', Date.now() - llmStarted); }
            speechQueue.enqueue(sentence);
          }
        })
        : await think(`[${nome} diz:] ${texto}`, authorId, getSystemPrompt(), textLanguage, context);
      metrics.observe('llm', Date.now() - llmStarted);
    } catch (e) {
      if (!responseAbort.signal.aborted) log.ia.error('think falhou', e.message);
      // Não deixa trechos antigos tocando quando a geração falha ou é interrompida.
      if (responseAbort.signal.aborted || speechQueue?.count) speechQueue?.cancel();
      reply = responseAbort.signal.aborted ? '' : 'opa, travei aqui, fala de novo?';
    }
    if (!responseAbort.signal.aborted && (!reply || !reply.trim())) reply = 'opa, tô aqui! fala de novo?';
    if (speechQueue && !speechQueue.count) speechQueue.enqueue(reply);

    // Encerrar a fila é independente do REST de texto, inclusive se ele travar em 429.
    const speechDone = Promise.resolve(speechReady).then(() => speechQueue?.done()).finally(() => {
      if (speechSession?.responseAbort === responseAbort) {
        speechSession.responseAbort = null;
        speechSession.responseUserId = null;
      }
    });
    speechDone.catch(error => log.voz.error('play erro', error.message));

    if (config.replyInTextToo && !responseAbort.signal.aborted) {
      try {
        await discord.sendMessage(channelId, `<@${authorId}> ${reply}`);
        recentReplies.push(Date.now());
        const elapsed = Date.now() - responseStarted;
        metrics.observe('reply', elapsed);
        log.msg.sent(channelId, reply, elapsed);
      } catch (e) { log.msg.error('falhou ao enviar', e.message); }
    }
    // Confirma leitura só depois da resposta, sem disputar a fila REST crítica.
    discord.ack(channelId, m.id).catch(() => {});
    await speechDone;

  } catch (e) {
    console.error('erro message:', e.message);
  }
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  terminalPanel?.stop();
  await webPanel?.stop();
  alive.stop();
  clearInterval(proactiveTimer);
  for (const timer of voiceIdleTimer.values()) clearTimeout(timer);
  for (const timer of aloneTimer.values()) clearTimeout(timer);
  for (const guildId of new Set([...voice.active.keys(), ...voice.pending.keys()])) voice.leave(guildId);
  await voice.recordings?.close();
  discord.destroy();
  await Promise.allSettled([flushMemory?.(), log.flush?.()]);
  console.log('Bot desligado.');
  setTimeout(() => process.exit(0), 250);
}

process.once?.('SIGINT', shutdown);
process.once?.('SIGTERM', shutdown);

startWebPanel();
if (!TOKEN) {
  console.log(discord.loginError);
  if (!WEB_ENABLED) process.exit(1);
} else discord.login().then(() => {
  log.sys.start();
  log.sys.config('LLM', `${llmInfo.chatProvider} ${llmInfo.chatModel}`);
  log.sys.config('STT', `${llmInfo.sttProvider} ${llmInfo.sttModel}`);
  log.sys.config('TTS', getTtsInfo ? `${getTtsInfo().label} ${getTtsInfo().model}` : 'Edge');
  log.sys.config('Emoção', getCurrent());
  log.sys.config('Voz', getTtsInfo?.().voice || state.ttsVoice);
  log.sys.config('Owner', OWNER_ID);
  log.sys.config('Painel', process.env.PANEL_CHANNEL || '1550615621954183221');
  log.sys.config('AutoJoin', config.autoJoinOnMention ? 'ligado' : 'desligado');
  log.sys.config('ReplyInText', config.replyInTextToo ? 'ligado' : 'desligado');
}).catch(e => {
  discord.loginError = discord.stopError?.message || (e.status === 401 || e.code === 401
    ? 'O Discord recusou o token. Atualize a conexão no painel e reinicie.'
    : 'Não foi possível conectar ao Discord. Confira o modo, o token e a conexão de rede.');
  log.sys.error('Login falhou', discord.loginError);
  if (!WEB_ENABLED) process.exit(1);
});
