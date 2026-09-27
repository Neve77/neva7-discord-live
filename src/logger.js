const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
const fileWrites = new Map();

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
  gray: '\x1b[90m', bright: '\x1b[1m'
};

function ts() {
  return new Date().toLocaleString('pt-BR', { hour12: false, timeZone: 'America/Sao_Paulo' });
}

function logFile(name, text) {
  const d = new Date().toISOString().slice(0, 10);
  const fp = path.join(LOG_DIR, `${name}-${d}.log`);
  // Logging never blocks resposta, áudio ou heartbeat. A fila por arquivo preserva a
  // ordem das linhas mesmo quando vários eventos chegam no mesmo tick.
  const previous = fileWrites.get(fp) || Promise.resolve();
  const write = previous.catch(() => {}).then(() => fs.promises.appendFile(fp, `[${ts()}] ${text}\n`));
  fileWrites.set(fp, write);
  write.finally(() => {
    if (fileWrites.get(fp) === write) fileWrites.delete(fp);
  }).catch(() => {});
}

async function flush() {
  await Promise.allSettled([...fileWrites.values()]);
}

function log(category, color, icon, msg, data) {
  const prefix = `${COLORS.gray}[${ts()}]${COLORS.reset} ${color}${icon} [${category}]${COLORS.reset}`;
  console.log(`${prefix} ${msg}`);
  if (data !== undefined) {
    const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    console.log(`${COLORS.gray}${str}${COLORS.reset}`);
  }
  logFile(category, `${icon} ${msg}${data !== undefined ? ' | ' + (typeof data === 'string' ? data : JSON.stringify(data)) : ''}`);
}

module.exports = {
  // Gateway
  gw: {
    ready: (user) => log('gw', COLORS.green, '✅', `READY: ${user.username} (${user.id})`),
    reconnect: (code, reason) => log('gw', COLORS.yellow, '🔄', `Reconectando (code ${code}): ${reason}`),
    event: (t, extra) => log('gw', COLORS.cyan, '📨', `Evento: ${t}`, extra),
    error: (msg, err) => log('gw', COLORS.red, '❌', `Erro: ${msg}`, err),
    raw: (op, t, d) => log('gw', COLORS.gray, '📥', `Packet op=${op} t=${t}`, d),
  },

  // Voz
  voz: {
    join: (guildId, channelId) => log('voz', COLORS.green, '🔊', `Entrando em call: guild=${guildId} channel=${channelId}`),
    leave: (guildId) => log('voz', COLORS.yellow, '🔇', `Saindo da call: guild=${guildId}`),
    ready: (guildId) => log('voz', COLORS.green, '✅', `Conectado! guild=${guildId}`),
    timeout: (guildId, state) => log('voz', COLORS.red, '⏰', `Timeout na conexão: guild=${guildId} state=${state}`),
    error: (msg, err) => log('voz', COLORS.red, '❌', `Erro: ${msg}`, err),
    serverUpdate: (guildId, endpoint) => log('voz', COLORS.cyan, '📡', `voiceServerUpdate: guild=${guildId} endpoint=${endpoint}`),
    stateUpdate: (guildId, userId, channel, session) => log('voz', COLORS.cyan, '📡', `voiceStateUpdate: guild=${guildId} user=${userId} channel=${channel || 'SAIU'} session=${session || '?'}`),
    sessionFound: (sessionId) => log('voz', COLORS.green, '🔑', `Session ID obtida: ${sessionId?.slice(0, 20)}...`),
    sessionNotFound: () => log('voz', COLORS.red, '🔑', `Session ID não encontrada via REST`),
    listening: (guildId) => log('voz', COLORS.green, '👂', `Escutando call: guild=${guildId}`),
    speaking: (userId) => log('voz', COLORS.magenta, '🗣️', `Alguém falou: user=${userId}`),
    playing: (title) => log('voz', COLORS.blue, '🎵', `Tocando: ${title}`),
    tts: (text) => log('voz', COLORS.gray, '🔊', `TTS: ${text?.slice(0, 80)}...`),
  },

  // IA
  ia: {
    think: (userId, text) => log('ia', COLORS.magenta, '🧠', `Pensando: user=${userId} msg="${text?.slice(0, 60)}"`),
    reply: (userId, text) => log('ia', COLORS.green, '💬', `Resposta: user=${userId} msg="${text?.slice(0, 60)}"`),
    error: (msg, err) => log('ia', COLORS.red, '❌', `Erro LLM: ${msg}`, err),
    stt: (lang, text) => log('ia', COLORS.cyan, '🎤', `STT: lang=${lang} text="${text?.slice(0, 60)}"`),
    tts: (engine, text) => log('ia', COLORS.blue, '🔊', `TTS [${engine}]: "${text?.slice(0, 60)}"`),
    cache: (userId) => log('ia', COLORS.gray, '💾', `Cache hit: user=${userId}`),
  },

  // Mensagens
  msg: {
    received: (author, guild, text) => log('msg', COLORS.white, '📩', `MSG de ${author} em ${guild || 'DM'}: "${text?.slice(0, 80)}"`),
    sent: (channel, text, elapsedMs) => log('msg', COLORS.green, '📤', `Enviado em ${channel}${Number.isFinite(elapsedMs) ? ` em ${elapsedMs}ms` : ''}: "${text?.slice(0, 80)}"`),
    error: (msg, err) => log('msg', COLORS.red, '❌', `Erro: ${msg}`, err),
    command: (author, cmd, args) => log('msg', COLORS.yellow, '⚡', `Comando: !${cmd} ${args?.join(' ')} de ${author}`),
    panel: (author, cmd, args) => log('msg', COLORS.magenta, '🎮', `Painel: ${cmd} ${args?.join(' ')} de ${author}`),
  },

  // Música
  music: {
    enqueue: (title, pos) => log('music', COLORS.blue, '🎵', `Na fila (${pos}): ${title}`),
    playing: (title) => log('music', COLORS.green, '▶️', `Tocando: ${title}`),
    skip: (title) => log('music', COLORS.yellow, '⏭', `Pulou: ${title}`),
    stop: () => log('music', COLORS.red, '⏹', `Parou música`),
    error: (msg, err) => log('music', COLORS.red, '❌', `Erro música: ${msg}`, err),
  },

  // Vida própria
  alive: {
    msg: (channel, text) => log('alive', COLORS.green, '💚', `Vida própria em ${channel}: "${text?.slice(0, 60)}"`),
    enabled: (channels) => log('alive', COLORS.green, '✅', `Ligado: ${channels} canais`),
    disabled: () => log('alive', COLORS.red, '❌', `Desligado`),
  },

  // Sistema
  sys: {
    start: () => log('sys', COLORS.bright + COLORS.green, '🚀', `Bot iniciado`),
    error: (msg, err) => log('sys', COLORS.red, '❌', `Erro fatal: ${msg}`, err),
    config: (key, val) => log('sys', COLORS.gray, '⚙️', `Config: ${key}=${val}`),
  },

  // Debug
  debug: (tag, msg, data) => log('debug', COLORS.gray, '🔍', `[${tag}] ${msg}`, data),
  flush,
};
