const fs = require('fs');
const path = require('path');
const { createHash } = require('node:crypto');
const OpenAI = require('openai');
const { config } = require('./config');
const { speak, speakStream, ttsClean, speechLanguage, listVoices, listVoiceProfiles, getTtsInfo } = require('./tts');
const { getConversationLanguage, detectTextLanguage } = require('./languages');
const { gaussianJitter, retryAfterMs } = require('./jitter');
const { fitReply, createReplyBuffer } = require('./reply-text');

// OpenAI (pago) ou Groq (free, sem cartão) — Groq é OpenAI-compatible
const GROQ_KEY = (process.env.GROQ_API_KEY || '').trim();
const OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();

// Groq/OpenAI continuam disponíveis para transcrição do pipeline clássico.
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;
const ai = GROQ_KEY
  ? new OpenAI({ apiKey: GROQ_KEY, baseURL: 'https://api.groq.com/openai/v1' })
  : openai;

// Gemini pode ser selecionado pelo CHAT_MODEL ou usado como fallback de texto.
const gemini = GEMINI_KEY
  ? new OpenAI({ apiKey: GEMINI_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' })
  : null;

const CHAT_MODEL = process.env.CHAT_MODEL || (GROQ_KEY ? 'openai/gpt-oss-120b' : (GEMINI_KEY ? 'gemini-3.6-flash' : (config.openaiModel || 'gpt-4o-mini')));
const USE_GEMINI_CHAT = /^gemini-/i.test(CHAT_MODEL);
const GEMINI_FALLBACK_MODEL = 'gemini-3.6-flash';
const STT_MODEL = process.env.STT_MODEL || (GROQ_KEY ? 'whisper-large-v3-turbo' : (config.sttModel || 'whisper-1'));
const llmInfo = {
  chatProvider: USE_GEMINI_CHAT ? 'Gemini' : (GROQ_KEY ? 'Groq' : 'OpenAI'), chatModel: CHAT_MODEL,
  sttProvider: GROQ_KEY ? 'Groq' : 'OpenAI', sttModel: STT_MODEL
};
const isGroqOss = model => Boolean(GROQ_KEY) && /^openai\/gpt-oss-(20b|120b)$/.test(model);
// O limite inclui os tokens de raciocínio e é independente dos limites de texto/voz.
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || (isGroqOss(CHAT_MODEL) ? '1024' : '300'), 10);
const requestedEffort = String(process.env.CHAT_REASONING_EFFORT || 'low').trim().toLowerCase();
const REASONING_EFFORT = ['low', 'medium', 'high'].includes(requestedEffort) ? requestedEffort : 'low';
const MAX_HISTORY = 6; // últimas trocas no contexto (o resto vira memória longa)
const MAX_INPUT = 300; // corta texto longo antes de mandar
const VOICE_REPLY_LIMIT = 300;
const TEXT_REPLY_LIMIT = 1800;

console.log(`[ia] cérebro: ${llmInfo.chatProvider} ${CHAT_MODEL}${isGroqOss(CHAT_MODEL) ? ` (raciocínio ${REASONING_EFFORT})` : ''} | fallback: ${gemini && !USE_GEMINI_CHAT ? 'gemini' : 'nenhum'} | ouvido: ${GROQ_KEY ? `groq ${STT_MODEL}` : 'openai'}`);

// divide resposta em frases p/ TTS streaming (fala a 1ª enquanto o resto sintetiza)
function splitSentences(text) {
  const parts = String(text || '').split(/(?<=[.!?…])\s+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + ' ' + p).trim().length <= 180) cur = (cur + ' ' + p).trim();
    else { if (cur) out.push(cur); cur = p; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [String(text || '').slice(0, 400)];
}

// histórico por usuário (curto) + memória longa (memory.json)
const histories = new Map();
const MEMORY_PATH = path.join(__dirname, '..', 'memory.json');
let memory = {};
try { memory = JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8')); } catch {}
let memoryWrite = Promise.resolve();
function saveMemory() {
  // A memória é atualizada fora da resposta principal; escrita assíncrona evita parar
  // o event loop quando o disco está ocupado. Cada snapshot mantém a ordem das mudanças.
  const snapshot = JSON.stringify(memory, null, 2);
  memoryWrite = memoryWrite.catch(() => {}).then(() => fs.promises.writeFile(MEMORY_PATH, snapshot));
  memoryWrite.catch(() => {});
}
async function flushMemory() { await memoryWrite.catch(() => {}); }
function getFacts(userId) {
  return (memory[userId] || '').slice(0, 1200);
}
// a cada 12 msgs, resume as 6 mais antigas em fatos (1 chamada barata) e limpa
function maybeSummarize(userId) {
  try {
    const h = getHistory(userId);
    if (h.length < 12) return;
    const old = h.splice(0, 6);
    const convo = old.map(m => `${m.role === 'user' ? 'pessoa' : 'bot'}: ${m.content}`).join('\n');
    chatOnce(CHAT_MODEL, [
      { role: 'user', content: `Resuma em até 3 linhas só FATOS duradouros sobre a pessoa (nome, gostos, assuntos). Nada de fofoca efêmera. Conversa:\n${convo.slice(0, 1500)}` }
    ]).then(r => {
      const s = ((r.choices[0].message.content || '').trim()).slice(0, 600);
      if (s) {
        memory[userId] = ((memory[userId] ? memory[userId] + '\n' : '') + s).slice(-1500);
        saveMemory();
      }
    }).catch(() => {});
  } catch {}
}

function getHistory(userId) {
  if (!histories.has(userId)) histories.set(userId, []);
  return histories.get(userId);
}

function pushHistory(userId, role, content) {
  const h = getHistory(userId);
  // guarda resumido: corta item longo pra não estourar token
  const short = String(content || '').slice(0, 200);
  h.push({ role, content: short });
  maybeSummarize(userId); // comprime as antigas em fatos (memory.json) quando acumula
  while (h.length > 12) h.shift();
}

function clearHistory(userId) {
  histories.delete(userId);
  for (const [key, entry] of fastCache) if (entry.userId === userId) fastCache.delete(key);
}

// Reutiliza somente a mesma entrada no mesmo contexto, durante 60 segundos.
const fastCache = new Map();
function pruneCache() {
  for (const [key, entry] of fastCache) if (Date.now() - entry.t >= 60000) fastCache.delete(key);
}
function responseCacheInfo() { pruneCache(); return { entries: fastCache.size }; }
function clearResponseCache() { const count = fastCache.size; fastCache.clear(); return count; }
function cacheGet(key) {
  pruneCache();
  return fastCache.get(key)?.r || null;
}
function cacheSet(key, userId, reply) {
  pruneCache();
  fastCache.set(key, { userId, r: reply, t: Date.now() });
  if (fastCache.size > 100) fastCache.delete(fastCache.keys().next().value);
}

const SHORT_SUFFIX_PT = '\nResposta para ser falada em voz alta: use português brasileiro simples, de conversa, em uma ou duas frases completas. Use vocabulário e construção de frases do Brasil: você, a gente, celular, fone e estou fazendo, conforme o contexto. Evite construções de Portugal como estou a fazer, telemóvel e fixe. Preserve acentos (você, tá, tô, é, não) e pontuação de conversa. Use contrações naturais como tô, tá e pra, sem empilhar gírias. Não escreva risadas (haha, kkk), abreviações de chat (slc, mt, bnt), emojis, ações, listas ou marcações. Não invente um apelido nem repita o nome da pessoa em cada resposta. Não force interjeições. Responda ao assunto; se a fala estiver confusa, peça para repetir em uma frase curta.';

function suffixFor(lang, mode = 'voice') {
  if (mode === 'text') return `\nResponda no idioma ${lang}, de forma clara e conversacional. Use até ${TEXT_REPLY_LIMIT} caracteres e conclua as frases. O início deve responder diretamente à pergunta e funcionar também quando lido em voz alta.`;
  if (lang && !String(lang).toLowerCase().startsWith('pt')) {
    return '\nWrite one or two complete, conversational sentences to be spoken aloud in the user language (' + lang + '). Avoid written laughter, chat abbreviations, stage directions, emojis and forced fillers. If the speech is unclear, ask them to repeat briefly.';
  }
  return SHORT_SUFFIX_PT + `\nProcure ficar em até ${VOICE_REPLY_LIMIT} caracteres, concluindo a frase.`;
}

function abortError() {
  const error = new Error('Solicitação cancelada.');
  error.name = 'AbortError';
  return error;
}

function withTimeout(createRequest, ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer, onAbort;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    reject(new Error(`timeout ${ms / 1000}s`));
    controller.abort();
  }, ms); });
  const cancelled = signal ? new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  }) : null;
  const request = Promise.resolve().then(() => createRequest({ signal: requestSignal, timeout: ms, maxRetries: 0 }));
  return Promise.race([request, timeout, ...(cancelled ? [cancelled] : [])]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

function chatParams(model, messages, stream = false) {
  const params = { model, messages, temperature: 0.7 };
  if (stream) params.stream = true;
  if (isGroqOss(model)) {
    params.max_completion_tokens = MAX_TOKENS;
    params.reasoning_effort = REASONING_EFFORT;
    params.include_reasoning = false;
  } else params.max_tokens = MAX_TOKENS;
  return params;
}

function retryDelay(error) {
  const status = Number(error?.status);
  if (![408, 429, 500, 502, 503, 504].includes(status)) return null;
  const headers = error.headers;
  const header = headers?.get ? headers.get('retry-after') : headers?.['retry-after'];
  const body = error.error || error;
  // Cota diária/créditos não se recuperam durante uma resposta na call.
  if (status === 429 && (/quota|daily|billing|credit/i.test(error.message || '') ||
      (header == null && typeof body.retry_after !== 'number'))) return null;
  const wait = header != null || typeof body.retry_after === 'number'
    ? retryAfterMs({ headers: { get: () => header } }, body) : 0;
  if (wait > 2000) return null;
  return Math.max(wait, gaussianJitter({ mean: 400, stddev: 80, min: 200, max: 700 }));
}

function waitForRetry(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, ms);
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(abortError()); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

async function requestCompletion(client, model, messages, { signal, stream = false } = {}) {
  if (!client) throw new Error(/^gemini-/i.test(model)
    ? 'Configure GEMINI_API_KEY para o chat Gemini.' : 'Configure GROQ_API_KEY ou OPENAI_API_KEY para o chat.');
  let retried = false;
  const retry = async error => {
    if (signal?.aborted) throw abortError();
    const delay = client === gemini && !retried ? retryDelay(error) : null;
    if (delay == null) return false;
    retried = true;
    await waitForRetry(delay, signal);
    return true;
  };
  const open = () => withTimeout(options => client.chat.completions.create(chatParams(model, messages, stream), options), 10000, signal);
  let response;
  try { response = await open(); }
  catch (error) { if (!await retry(error)) throw error; response = await open(); }
  if (!stream) return response;
  return (async function* () {
    let receivedText = false;
    while (true) {
      try {
        for await (const chunk of response) {
          if (signal?.aborted) throw abortError();
          if (streamChunkText(chunk)) receivedText = true;
          yield chunk;
        }
        return;
      } catch (error) {
        // Após qualquer texto recebido, repetir pode duplicar trechos já falados.
        if (receivedText || !await retry(error)) throw error;
        response = await open();
      }
    }
  })();
}

async function chatOnce(model = CHAT_MODEL, messages, options = {}) {
  const client = /^gemini-/i.test(model) ? gemini : ai;
  try {
    return await requestCompletion(client, model, messages, options);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (gemini && client !== gemini && !/^gemini-/i.test(model)) {
      console.log('[ia] provedor principal indisponível, tentando Gemini.');
      return requestCompletion(gemini, GEMINI_FALLBACK_MODEL, messages, options);
    }
    throw error;
  }
}

function chatStreamOnce(model, messages, options = {}) {
  return chatOnce(model, messages, { ...options, stream: true });
}

const FALLBACKS = ['opa, tô aqui! fala de novo?', 'e aí, repete aí que eu não peguei', 'tô na escuta, manda de novo'];

function getTimeContext() {
  const h = new Date().getHours();
  const day = new Date().getDay();
  const days = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  let periodo;
  if (h >= 5 && h < 12) periodo = 'manhã';
  else if (h >= 12 && h < 18) periodo = 'tarde';
  else if (h >= 18 && h < 23) periodo = 'noite';
  else periodo = 'madrugada';
  return `${periodo} de ${days[day]}, ~${h}h`;
}

function prepareTurn(text, userId, systemPrompt, lang, context) {
  if (context.signal?.aborted) throw abortError();
  lang = speechLanguage(lang, context.replyLanguage);
  const mode = context.responseMode === 'text' ? 'text' : 'voice';
  const limit = mode === 'text' ? TEXT_REPLY_LIMIT : VOICE_REPLY_LIMIT;
  const hardLimit = mode === 'text' ? 1900 : VOICE_REPLY_LIMIT * 2;
  const clean = String(text || '').slice(0, mode === 'text' ? 4000 : MAX_INPUT).trim() || 'e aí?';
  const history = context.ephemeral ? (context.history || []).slice(-MAX_HISTORY) : getHistory(userId).slice(-MAX_HISTORY);
  const facts = context.ephemeral ? '' : getFacts(userId);

  // monta contexto enriquecido
  const time = getTimeContext();
  const callMembers = context.callMembers || '';
  const extraContext = [];
  extraContext.push(`[hora: ${time}]`);
  if (callMembers) extraContext.push(`[pessoas na call: ${callMembers}]`);
  if (context.botName) extraContext.push(`[seu nome: ${context.botName}]`);
  if (context.topicContext) extraContext.push(`\n[CONTEXTO DA PESQUISA — use pra responder perguntas sobre o assunto]:\n${context.topicContext}`);

  const messages = [
    { role: 'system', content: (systemPrompt || '') + suffixFor(lang, mode) + (facts ? `\n[coisas que você lembra dessa pessoa: ${facts}]` : '') + (extraContext.length ? '\n' + extraContext.join(' ') : '') },
    ...history,
    { role: 'user', content: clean }
  ];
  const cacheKey = createHash('sha256').update(JSON.stringify([
    userId, context.conversationId || '', CHAT_MODEL, lang, mode, limit, messages
  ])).digest('hex');
  return { clean, messages, cacheKey, limit, hardLimit };
}

function saveTurn(turn, userId, reply, context) {
  if (context.ephemeral) return;
  pushHistory(userId, 'user', turn.clean);
  pushHistory(userId, 'assistant', reply);
  cacheSet(turn.cacheKey, userId, reply);
}

async function think(text, userId, systemPrompt, lang = 'pt', context = {}) {
  const turn = prepareTurn(text, userId, systemPrompt, lang, context);
  const { clean, messages, cacheKey, limit, hardLimit } = turn;
  const hit = context.ephemeral ? null : cacheGet(cacheKey);
  if (hit) { context.onFirstToken?.(); return hit; }
  let reply = '';
  for (let attempt = 0; attempt < 2 && !reply; attempt++) {
    const res = await chatOnce(CHAT_MODEL, attempt === 0 ? messages : [...messages.slice(0, 1), { role: 'user', content: clean }], { signal: context.signal });
    if (context.signal?.aborted) throw abortError();
    reply = fitReply((res.choices[0].message.content || '').trim(), limit, hardLimit).text;
  }
  if (!reply) reply = FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
  context.onFirstToken?.();
  saveTurn(turn, userId, reply, context);
  return reply;
}

function streamChunkText(chunk) {
  const content = chunk?.choices?.[0]?.delta?.content;
  if (typeof content === 'string') return content;
  // Alguns provedores compatíveis devolvem content como partes em vez de string.
  if (Array.isArray(content)) return content.map(part => part?.text || '').join('');
  return '';
}

// Texto e voz compartilham a resposta, com limites independentes.
async function thinkStream(text, userId, systemPrompt, lang = 'pt', context = {}) {
  const turn = prepareTurn(text, userId, systemPrompt, lang, context);
  const emit = sentence => {
    if (context.signal?.aborted || !sentence) return;
    try { context.onSentence?.(sentence); }
    catch (error) { console.error('[ia] fila de fala rejeitou trecho:', error.message); }
  };
  const speech = createReplyBuffer(VOICE_REPLY_LIMIT, emit);
  const hit = context.ephemeral ? null : cacheGet(turn.cacheKey);
  if (hit) {
    context.onFirstToken?.();
    speech.push(hit); speech.finish();
    return hit;
  }
  const written = createReplyBuffer(turn.limit, undefined, turn.hardLimit);
  let firstToken = true;
  const stream = await chatStreamOnce(CHAT_MODEL, turn.messages, { signal: context.signal });
  for await (const chunk of stream) {
    if (context.signal?.aborted) throw abortError();
    const piece = streamChunkText(chunk);
    if (!piece) continue;
    if (firstToken) { firstToken = false; context.onFirstToken?.(); }
    written.push(piece);
    speech.push(piece);
    if (written.done) break;
  }
  if (context.signal?.aborted) throw abortError();
  let reply = written.finish();
  if (!reply) {
    reply = FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
    speech.push(reply);
  }
  speech.finish();
  saveTurn(turn, userId, reply, context);
  return reply;
}

function normalizeLanguage(language) {
  const value = String(language || 'pt').toLowerCase();
  return ({ portuguese: 'pt', português: 'pt', english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it', japanese: 'ja' })[value] || value.split('-')[0];
}

async function transcribe(wavPath, { signal, language: requestedLanguage } = {}) {
  if (signal?.aborted) throw abortError();
  const preferred = String(requestedLanguage ?? (getConversationLanguage() !== null ? 'auto' : process.env.STT_LANGUAGE || config.sttLanguage || 'pt')).toLowerCase();
  const languageHint = preferred === 'auto' ? {} : { language: normalizeLanguage(preferred) };
  const params = {
    model: STT_MODEL,
    ...languageHint,
    prompt: languageHint.language === 'pt' ? 'Conversa informal em português brasileiro.' : undefined,
    temperature: 0
  };
  let res;
  const audioFile = async () => Buffer.isBuffer(wavPath) ? OpenAI.toFile(wavPath, 'speech.wav', {type:'audio/wav'}) : fs.createReadStream(wavPath);
  try {
    const file = await audioFile();
    res = await withTimeout(options => ai.audio.transcriptions.create({ ...params, file, response_format: 'verbose_json' }, options), 8000, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error.status !== 400 || !/response_format|verbose/i.test(error.message || '')) throw error;
    const file = await audioFile();
    res = await withTimeout(options => ai.audio.transcriptions.create({ ...params, file }, options), 8000, signal);
  }
  if (signal?.aborted) throw abortError();
  if (typeof res === 'string') return { text: res.trim(), language: languageHint.language || detectTextLanguage(res) };
  const text = (res.text || '').trim();
  const language = normalizeLanguage(res.language || languageHint.language || detectTextLanguage(text));
  const segs = res.segments || [];
  if (segs.length) {
    let noisy = 0;
    for (const s of segs) {
      if ((s.no_speech_prob ?? 0) > 0.6 || (s.avg_logprob ?? 0) < -1.2) noisy++;
    }
    // maioria dos trechos é ruído + texto curto = chiado, ignora
    if (noisy / segs.length >= 0.6 && text.length < 25) {
      console.log('[stt] só ruído, ignorando');
      return { text: '', language };
    }
  }
  return { text, language };
}

// resume últimas msgs do canal em 3 linhas faladas (p/ !resumo)
async function summarizeChannel(lines) {
  const convo = lines.slice(-30).join('\n').slice(0, 3000);
  if (!convo.trim()) return 'não rolou nada demais no chat ainda';
  const res = await chatOnce(CHAT_MODEL, [
    { role: 'user', content: `Resume em até 3 linhas curtas, como quem conta fofoca na call, o que rolou aqui:\n${convo}` }
  ]);
  return ((res.choices[0].message.content || '').trim()).slice(0, 600) || 'não entendi o papo, fala de novo?';
}

module.exports = { think, thinkStream, chatOnce, transcribe, speak, speakStream, summarizeChannel, splitSentences, getHistory, pushHistory, clearHistory, getFacts, ttsClean, flushMemory, llmInfo, listVoices, listVoiceProfiles, getTtsInfo, responseCacheInfo, clearResponseCache };
