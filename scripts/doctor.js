require('dotenv').config();
const { getFfmpegPath } = require('../src/ffmpeg');
const { getYtdlpPath } = require('../src/youtube');
const { execFileSync } = require('child_process');
const { resolveDiscordAuth } = require('../src/connection-settings');

let failed = false;
function check(name, run) {
  try { console.log(`[OK] ${name}: ${run()}`); }
  catch (error) { failed = true; console.error(`[ERRO] ${name}: ${error.message}`); }
}
check('Node', () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('use Node 22.12 ou mais recente');
  return process.version;
});
check('Configuração', () => {
  const auth = resolveDiscordAuth();
  if (auth.error) throw new Error(auth.error);
  if (!auth.token) throw new Error(`falta token para o modo ${auth.mode}; configure na Central web`);
  if (!(process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || '').trim()) throw new Error('falta GROQ_API_KEY ou OPENAI_API_KEY');
  return `modo ${auth.mode}; credenciais preenchidas (sem conexão externa)`;
});
check('Biblioteca de voz', () => { require('@discordjs/voice'); return 'carregada'; });
check('Síntese de voz', () => {
  const info = require('../src/tts').getTtsInfo();
  if (info.provider === 'gemini' && !process.env.GEMINI_API_KEY?.trim()) throw new Error('falta GEMINI_API_KEY');
  return `${info.label}: ${info.model}, voz ${info.voice} (configuração local)`;
});
check('Decoder Opus', () => {
  const OpusScript = require('opusscript');
  const decoder = new OpusScript(48000, 2);
  decoder.delete();
  return 'carregado';
});
check('FFmpeg', getFfmpegPath);
check('Música do YouTube', () => execFileSync(getYtdlpPath(), ['--version'], { windowsHide: true, timeout: 15000, encoding: 'utf8' }).trim());
process.exitCode = failed ? 1 : 0;
