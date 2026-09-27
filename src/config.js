const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const STATE_PATH = path.join(__dirname, '..', 'emotion-state.json');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

const config = loadConfig();

// estado em runtime (emoção atual) — persiste em emotion-state.json pra não perder ao reiniciar
let state = {
  current: config.defaultEmotion || 'natural',
  custom: null,
  interaction: '',
  ttsVoice: process.env.TTS_EDGE_VOICE || config.ttsVoice || 'nova',
  ttsSpeed: config.ttsSpeed || 1.0
};

try {
  if (fs.existsSync(STATE_PATH)) {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    state = { ...state, ...s };
  }
} catch {}

function saveState() {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function listEmotions() {
  return Object.keys(config.emotions);
}

function getSystemPrompt() {
  const base = state.custom || config.emotions[state.current] || config.emotions.natural;
  const interaction = String(state.interaction || '').trim();
  return interaction ? `${base}\n\n[ajustes de intera\u00e7\u00e3o escolhidos pela pessoa: ${interaction}]` : base;
}

function setEmotion(name) {
  name = (name || '').toLowerCase();
  if (!config.emotions[name]) return false;
  state.current = name;
  state.custom = null;
  saveState();
  return true;
}

function setCustom(text) {
  state.custom = text;
  saveState();
}

function getInteraction() {
  return String(state.interaction || '');
}

function setInteraction(text) {
  state.interaction = String(text || '').trim();
  saveState();
}

function getCurrent() {
  if (state.custom) return `custom: ${state.custom.slice(0, 80)}...`;
  return state.current;
}

function setVoice(v) {
  if (process.env.TTS_MODE?.toLowerCase() === 'gemini') state.geminiVoice = v;
  else state.ttsVoice = v;
  saveState();
}

function setSpeed(s) {
  state.ttsSpeed = s;
  saveState();
}

function setOption(name, value) {
  if (!['autoJoinOnMention', 'replyInTextToo'].includes(name) || typeof value !== 'boolean') {
    throw new Error('Configuração inválida.');
  }
  const updated = { ...config, [name]: value };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2) + '\n');
  config[name] = value;
}

function getBotPresence() {
  const value = config.botPresence || {};
  return {
    status: ['online', 'idle', 'dnd', 'invisible'].includes(value.status) ? value.status : 'online',
    type: [0, 1, 2, 3, 5].includes(value.type) ? value.type : 0,
    name: String(value.name || 'Conversando no Discord').trim().slice(0, 128),
    state: String(value.state || '').trim().slice(0, 128),
    url: String(value.url || '').trim().slice(0, 512)
  };
}

function setBotPresence(value) {
  const presence = getBotPresence();
  if (value && typeof value === 'object') {
    if (['online', 'idle', 'dnd', 'invisible'].includes(value.status)) presence.status = value.status;
    if ([0, 1, 2, 3, 5].includes(Number(value.type))) presence.type = Number(value.type);
    presence.name = String(value.name || '').trim().slice(0, 128);
    presence.state = String(value.state || '').trim().slice(0, 128);
    presence.url = String(value.url || '').trim().slice(0, 512);
  }
  const updated = { ...config, botPresence: presence };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2) + '\n');
  config.botPresence = presence;
  return presence;
}

module.exports = {
  config,
  state,
  listEmotions,
  getSystemPrompt,
  setEmotion,
  setCustom,
  getInteraction,
  setInteraction,
  getCurrent,
  setVoice,
  setSpeed,
  setOption,
  getBotPresence,
  setBotPresence
};
