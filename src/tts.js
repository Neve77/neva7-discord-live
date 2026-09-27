const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { allocateTemp } = require('./cache');
const { EdgeTTS } = require('edge-tts-universal');
const { config, state } = require('./config');
const { getConversationLanguage, replyLanguage } = require('./languages');

// Edge is the no-key option; Gemini Live is selected explicitly via TTS_MODE.
const VOICES = {
  francisca: 'pt-BR-FranciscaNeural',
  thalita: 'pt-BR-ThalitaMultilingualNeural',
  antonio: 'pt-BR-AntonioNeural'
};
const ALIASES = {
  natural: 'francisca', nova: 'thalita', shimmer: 'francisca', fable: 'francisca',
  alloy: 'francisca', masculino: 'antonio', masculine: 'antonio', echo: 'antonio', onyx: 'antonio'
};

// O Gemini documenta estilo, n\u00e3o g\u00eanero. A coluna de timbre é uma referência
// de curadoria para facilitar a escolha no painel, sem representar identidade.
const EDGE_VOICE_PROFILES = {
  francisca: { name: 'Francisca', timbre: 'feminino', style: 'Natural e acolhedora' },
  thalita: { name: 'Thalita', timbre: 'feminino', style: 'Clara e vers\u00e1til' },
  antonio: { name: 'Antonio', timbre: 'masculino', style: 'Calmo e direto' }
};
const GEMINI_VOICE_PROFILES = {
  zephyr: ['feminino', 'Brilhante'], puck: ['feminino', 'Animada'], charon: ['masculino', 'Informativa'],
  kore: ['masculino', 'Firme'], fenrir: ['masculino', 'El\u00e9trica'], leda: ['feminino', 'Jovem'],
  orus: ['masculino', 'Firme'], aoede: ['feminino', 'Leve'], callirrhoe: ['feminino', 'Tranquila'],
  autonoe: ['feminino', 'Brilhante'], enceladus: ['masculino', 'Soprada'], iapetus: ['masculino', 'Clara'],
  umbriel: ['masculino', 'Tranquila'], algieba: ['masculino', 'Suave'], despina: ['feminino', 'Suave'],
  erinome: ['feminino', 'Clara'], algenib: ['masculino', 'Rouca'], rasalgethi: ['masculino', 'Informativa'],
  laomedeia: ['feminino', 'Animada'], achernar: ['feminino', 'Suave'], alnilam: ['masculino', 'Firme'],
  schedar: ['masculino', 'Equilibrada'], gacrux: ['masculino', 'Madura'], pulcherrima: ['feminino', 'Marcante'],
  achird: ['masculino', 'Amig\u00e1vel'], zubenelgenubi: ['masculino', 'Casual'], vindemiatrix: ['feminino', 'Gentil'],
  sadachbia: ['feminino', 'Viva'], sadaltager: ['masculino', 'S\u00e1bia'], sulafat: ['feminino', 'Calorosa']
};

function speechLanguage(detected = 'pt', policy) {
  return replyLanguage(detected, policy ?? getConversationLanguage() ?? process.env.TTS_LANGUAGE ?? config?.ttsLanguage ?? 'pt-BR');
}

function ttsClean(text, language = 'pt-BR') {
  let clean = String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\*(?:ri|rindo|risos|sorri|sorrindo|suspira)[^*]*\*/gi, '')
    .replace(/[*_`#~]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\b(?:k{2,}|(?:rs){2,}|(?:ha){2,}|(?:he){2,}|a(?:ha){2,})\b/gi, '')
    .replace(/!{2,}/g, '!').replace(/\?{2,}/g, '?').replace(/\.{3,}/g, '…');
  const abbreviations = {
    vc: 'você', vcs: 'vocês', tb: 'também', tbm: 'também', pq: 'porque', td: 'tudo',
    hj: 'hoje', dps: 'depois', obg: 'obrigado', blz: 'beleza', mds: 'meu Deus',
    ne: 'né', ta: 'tá', to: 'tô', eh: 'é', flw: 'falou', vlw: 'valeu',
    slc: 'nossa', mt: 'muito', mto: 'muito', bnt: 'bonito', nss: 'nossa', tlgd: 'entendeu'
  };
  if (language.startsWith('pt')) {
    clean = clean.replace(/(?<![\p{L}\p{N}_])(?:vc|vcs|tb|tbm|pq|td|hj|dps|obg|blz|mds|ne|ta|to|eh|flw|vlw|slc|mt|mto|bnt|nss|tlgd)(?![\p{L}\p{N}_])/giu,
      word => abbreviations[word.toLowerCase()]);
  }
  return clean.replace(/\s+/g, ' ').replace(/\s+([,.!?…])/g, '$1')
    .replace(/^[\s,.!?…]+/, '').replace(/([.!?])\s*[,;]/g, '$1').trim();
}

function preparePronunciation(text, language) {
  const clean = ttsClean(text, language);
  if (!language.startsWith('pt')) return clean;
  // Só muda o texto enviado à voz; a mensagem escrita e a memória ficam intactas.
  const pronunciation = {
    discord: 'Discórdi', youtube: 'Iutúbi', whatsapp: 'Uatsápi',
    call: 'chamada', calls: 'chamadas', afk: 'fora do teclado',
    ...(config?.ttsPronunciation || {})
  };
  const aliases = new Map(Object.entries(pronunciation)
    .filter(([word, spoken]) => word.trim() && typeof spoken === 'string' && spoken.trim())
    .map(([word, spoken]) => [word.toLowerCase(), spoken]));
  const pattern = [...aliases.keys()].sort((a, b) => b.length - a.length)
    .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!pattern) return clean;
  return clean.replace(new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`, 'giu'),
    word => aliases.get(word.toLowerCase()));
}

function voiceFor(language, requested) {
  const lang = String(language || 'pt').toLowerCase();
  if (lang === 'english' || lang.startsWith('en')) return 'en-US-AriaNeural';
  if (lang === 'spanish' || lang.startsWith('es')) return 'es-ES-ElviraNeural';
  const name = String(requested || state.ttsVoice || 'francisca').toLowerCase();
  return VOICES[name] || VOICES[ALIASES[name]] || VOICES.francisca;
}

function waitForEdge(request, signal) {
  if (signal?.aborted) return Promise.reject(new Error('Síntese cancelada.'));
  let timer, cancel;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Edge não respondeu em 10 segundos.')), 10000);
    cancel = () => reject(new Error('Síntese cancelada.'));
    signal?.addEventListener('abort', cancel, { once: true });
  });
  return Promise.race([Promise.resolve().then(request), deadline]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  });
}

async function speak(text, language = 'pt', options = {}) {
  if (options.signal?.aborted) throw new Error('Síntese cancelada.');
  language = speechLanguage(language, options.replyLanguage);
  const mode = options.provider || getTtsInfo().provider;
  // Native audio understands normal spelling; Edge's phonetic rewrites hurt Gemini prosody.
  const cleaned = (mode === 'gemini' ? ttsClean(text, language) : preparePronunciation(text, language)).slice(0, 400).trim();
  if (!/[\p{L}\p{N}]/u.test(cleaned)) throw new Error('Não há texto pronunciável para gerar a voz.');
  const speed = Number(options.speed ?? state.ttsSpeed ?? 1);
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw new Error('Velocidade de voz inválida.');
  if (mode === 'gemini') {
    const { generateGeminiSpeech } = require('./gemini-voice.mjs');
    try {
      const result = await generateGeminiSpeech(cleaned, {
        voice: options.voice || getTtsInfo().voice, speed, language, signal: options.signal
      });
      const file = allocateTemp('tts', 'wav');
      fs.writeFileSync(file, result.wav);
      return file;
    } catch (error) {
      // Never switch to a different paid model or retry a quota error in a loop.
      if (options.signal?.aborted || (process.env.TTS_FALLBACK || 'none') !== 'edge') throw error;
      console.error('[tts] Gemini indisponível; usando Edge:', error.message);
      return speak(text, language, { ...options, provider: 'edge', voice: state.ttsVoice });
    }
  }
  const baseRate = Number(process.env.TTS_RATE_NUM || 0);
  const rate = Math.round((speed * (1 + (Number.isFinite(baseRate) ? baseRate : 0) / 100) - 1) * 100);
  const prosody = { rate: `${rate >= 0 ? '+' : ''}${Math.max(-75, Math.min(300, rate))}%`, pitch: '+0Hz', volume: '+0%' };
  const preferred = voiceFor(language, options.voice);
  const fallback = String(language).toLowerCase().startsWith('en') || language === 'english'
    ? 'en-US-JennyNeural' : String(language).toLowerCase().startsWith('es') || language === 'spanish'
      ? 'es-ES-ElviraNeural' : preferred === VOICES.francisca ? VOICES.thalita : VOICES.francisca;
  const voices = [...new Set([preferred, fallback])];
  let failure;
  for (const voice of voices) {
    try {
      const buffer = await waitForEdge(async () => {
        const result = await new EdgeTTS(cleaned, voice, prosody).synthesize();
        return Buffer.from(await result.audio.arrayBuffer());
      }, options.signal);
      if (options.signal?.aborted) throw new Error('Síntese cancelada.');
      if (!buffer.length) throw new Error('O serviço retornou áudio vazio.');
      if (options.buffer) return buffer;
      const file = allocateTemp('tts', 'mp3');
      // Preserva o áudio original: sem equalização, compressor ou segunda compressão MP3.
      fs.writeFileSync(file, buffer);
      return file;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      failure = error;
      console.error(`[tts] ${voice} indisponível:`, error.message);
    }
  }
  throw new Error(`Voz gratuita indisponível no momento: ${failure?.message || 'erro de síntese'}`);
}

function getTtsInfo() {
  if (process.env.TTS_MODE?.toLowerCase() === 'gemini') {
    const { GEMINI_AUDIO_MODEL, geminiVoiceName } = require('./gemini-voice.mjs');
    return {
      provider: 'gemini', label: 'Gemini Native', model: process.env.GEMINI_AUDIO_MODEL || GEMINI_AUDIO_MODEL,
      voice: geminiVoiceName(state.geminiVoice || process.env.GEMINI_VOICE || 'Aoede')
    };
  }
  return { provider: 'edge', label: 'Edge', model: 'Neural PT-BR', voice: state.ttsVoice };
}

function listVoices() {
  return listVoiceProfiles().map(voice => voice.id);
}

function listVoiceProfiles() {
  if (getTtsInfo().provider !== 'gemini') {
    return Object.entries(EDGE_VOICE_PROFILES).map(([id, profile]) => ({ id, ...profile }));
  }
  return require('./gemini-voice.mjs').GEMINI_VOICES.map(name => {
    const id = name.toLowerCase();
    const [timbre = 'neutro', style = 'Vers\u00e1til'] = GEMINI_VOICE_PROFILES[id] || [];
    return { id, name, timbre, style };
  });
}

function speakStream(text, language = 'pt', options = {}) {
  if (getTtsInfo().provider !== 'gemini') throw new Error('Streaming de voz requer TTS_MODE=gemini.');
  language = speechLanguage(language, options.replyLanguage);
  const cleaned = ttsClean(text, language).slice(0, 400).trim();
  if (!/[\p{L}\p{N}]/u.test(cleaned)) throw new Error('Não há texto pronunciável para gerar a voz.');
  const speed = Number(options.speed ?? state.ttsSpeed ?? 1);
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw new Error('Velocidade de voz inválida.');
  return require('./gemini-voice.mjs').streamGeminiSpeech(cleaned, {
    ...options, voice: options.voice || getTtsInfo().voice, speed, language
  });
}

module.exports = { speak, speakStream, ttsClean, speechLanguage, listVoices, listVoiceProfiles, getTtsInfo };
