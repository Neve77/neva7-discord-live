const fs = require('node:fs');
const path = require('node:path');

const PRESETS = {
  'Ultra Low Latency': { silenceMs: 350, incompleteMs: 950, prebufferMs: 120 },
  Natural: { silenceMs: 650, incompleteMs: 1600, prebufferMs: 240 },
  'High Quality': { silenceMs: 850, incompleteMs: 2000, prebufferMs: 400 },
  Economy: { silenceMs: 850, incompleteMs: 1800, prebufferMs: 240, maxResponseSeconds: 12 },
  Development: { silenceMs: 650, incompleteMs: 1600, prebufferMs: 240, developer: true }
};
const PERSONALITIES = {
  Casual: 'Converse com leveza e naturalidade.', Gamer: 'Seja um colega de jogos, evite spoilers.',
  Amigo: 'Seja acolhedor e curioso, sem fingir ter experiências humanas.',
  Streamer: 'Seja energético, conciso e atento ao ritmo da call.',
  Assistente: 'Seja claro, prestativo e preciso.', Personalizado: ''
};
function defaults(env = process.env) {
  return {
    enabled: env.VOICE_PIPELINE !== 'legacy', provider: 'gemini', fallback: 'none',
    model: env.GEMINI_LIVE_MODEL || 'gemini-3.8-live', voice: env.GEMINI_VOICE || 'Aoede', fallbackVoice: 'francisca',
    preset: 'Natural', mode: 'conversational', onlyWhenCalled: true,
    wakeWords: (env.WAKE_WORDS || 'neve,nevas,neva7').split(',').map(x => x.trim()).filter(Boolean),
    profile: 'Casual', personality: '', systemPrompt: 'Você se chama Neva7.', replyLanguage: 'auto',
    humor: 50, energy: 50, curiosity: 50, spontaneity: 25, formality: 20, sarcasm: 10, concision: 80,
    speed: 1, volume: 1, pitch: 0, style: 'natural', intensity: 50, pronunciation: '',
    normalize: false, compressor: false, limiter: true, equalizer: 0, noiseReduction: false,
    silenceMs: 650, incompleteMs: 1600, vadMs: 160, vadThreshold: 300,
    maxUtteranceSeconds: 30, maxResponseSeconds: 25, maxCharacters: 1200,
    prebufferMs: 240, maxBufferMs: 6000, maxInputBufferMs: 2500, maxPendingMs: 8000,
    maxParticipants: 8, cooldownMs: 1200, responsesPerMinute: 12, interruptionsPerMinute: 20,
    priorityUserId: env.VOICE_PRIORITY_USER_ID ?? env.OWNER_ID ?? '',
    allowUsers: [], denyUsers: [], allowRoles: [], denyRoles: [],
    tools: [], toolUsers: [], toolRoles: [], safeMode: false, killed: false,
    retainTranscripts: false, permanentMemory: false, memoryUsers: [],
    maxHistory: 40, maxSummaryChars: 2400, clearOnLeave: true,
    reconnectAttempts: 4, idleSessionSeconds: 300, watchdogMb: 768, watchdogLagMs: 2000,
    developer: false, inputPrice: 0, outputPrice: 0,
    autoJoinGuild: env.LIVE_GUILD_ID || '', autoJoinChannel: env.LIVE_CHANNEL_ID || ''
  };
}
const ranges = {
  humor:[0,100], energy:[0,100], curiosity:[0,100], spontaneity:[0,100], formality:[0,100], sarcasm:[0,100], concision:[0,100],
  speed:[0.5,2], volume:[0,2], pitch:[-6,6], intensity:[0,100], equalizer:[-12,12],
  silenceMs:[200,2500], incompleteMs:[300,4000], vadMs:[60,600], vadThreshold:[50,5000],
  maxUtteranceSeconds:[2,120], maxResponseSeconds:[2,60], maxCharacters:[50,4000],
  prebufferMs:[40,1000], maxBufferMs:[1000,15000], maxInputBufferMs:[300,5000], maxPendingMs:[1000,15000],
  maxParticipants:[1,32], cooldownMs:[0,30000], responsesPerMinute:[1,60], interruptionsPerMinute:[1,120],
  maxHistory:[2,200], maxSummaryChars:[200,8000], reconnectAttempts:[0,8], idleSessionSeconds:[30,1800],
  watchdogMb:[128,8192], watchdogLagMs:[250,10000], inputPrice:[0,1000], outputPrice:[0,1000]
};
const enums = { replyLanguage:['auto','pt-BR','es','en'], provider:['gemini','cascade'], fallback:['none','cascade'], fallbackVoice:['francisca','thalita','antonio'], mode:['observer','conversational','participative'],
  preset:[...Object.keys(PRESETS),'Custom'], profile:Object.keys(PERSONALITIES) };
function validate(patch, current = defaults()) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Configuração deve ser um objeto.');
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(current, key)) throw new Error(`Opção desconhecida: ${key}`);
    if (enums[key]) { if (!enums[key].includes(value)) throw new Error(`Valor inválido: ${key}`); }
    else if (ranges[key]) {
      const [min,max] = ranges[key];
      if (!Number.isFinite(value) || value < min || value > max ||
          (!['speed','volume','pitch','equalizer','inputPrice','outputPrice'].includes(key) && !Number.isInteger(value))) throw new Error(`Limite inválido: ${key}`);
    } else if (Array.isArray(current[key])) {
      if (!Array.isArray(value) || value.length > 100 || value.some(x => typeof x !== 'string' || !x.trim() || x.length > 80)) throw new Error(`Lista inválida: ${key}`);
      if (key === 'tools' && value.some(x => !['clock','calculator'].includes(x))) throw new Error('Ferramenta não disponível.');
    } else if (typeof value !== typeof current[key] || (typeof value === 'string' && value.length > 4000)) throw new Error(`Valor inválido: ${key}`);
    next[key] = structuredClone(value);
  }
  if (next.incompleteMs < next.silenceMs || next.prebufferMs >= next.maxBufferMs) throw new Error('Os limites de pausa/buffer são incompatíveis.');
  if (next.onlyWhenCalled && !next.wakeWords.length) throw new Error('Informe pelo menos um nome de chamada.');
  return next;
}
class LiveSettings {
  constructor({ file = path.join(__dirname, '../../live-settings.json'), env = process.env } = {}) {
    this.file = file;
    this.value = defaults(env);
    if (file && fs.existsSync(file)) this.value = validate(JSON.parse(fs.readFileSync(file, 'utf8')), this.value);
  }
  update(patch) {
    const next = validate(patch, this.value);
    if (this.file) {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
    }
    this.value = next;
    return next;
  }
}
module.exports = { LiveSettings, defaults, validate, PRESETS, PERSONALITIES };
