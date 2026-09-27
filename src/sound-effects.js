const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const SOUND_EFFECTS_DIR = path.join(__dirname, '..', 'sound-effects');
const ALLOWED_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.flac', '.webm']);
const MAX_BYTES = 16 * 1024 * 1024;

function ensureDir() {
  fs.mkdirSync(SOUND_EFFECTS_DIR, { recursive: true });
  return SOUND_EFFECTS_DIR;
}

function stripExtension(name = '') {
  const clean = String(name || '').trim();
  if (!clean) return 'efeito';
  return clean.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '_').replace(/\s+/g, ' ').trim() || 'efeito';
}

function sanitizeFileName(filename = '', fallback = 'efeito') {
  const original = String(filename || '').split(/[\\/]/).pop() || fallback;
  const ext = path.extname(original || '').toLowerCase();
  const base = path.basename(original, ext).replace(/[^\w\- ]+/g, '_').replace(/\s+/g, ' ').trim() || stripExtension(fallback);
  const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : '.mp3';
  return `${base || 'efeito'}${safeExt}`;
}

function looksLikeAudio(buffer, contentType = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  const type = String(contentType || '').toLowerCase();
  if (/text\/html|application\/json|application\/xhtml|text\/plain|text\/xml|image\//i.test(type)) return false;
  const head = buffer.subarray(0, 16);
  if (head.length >= 12 && head.subarray(0, 4).equals(Buffer.from('RIFF')) && head.subarray(8, 12).equals(Buffer.from('WAVE'))) return true;
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from('OggS'))) return true;
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from('fLaC'))) return true;
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from('ID3 '))) return true;
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from('ftyp'))) return true;
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x1A, 0x45, 0xDF, 0xA3]))) return true;
  if (head.length >= 2 && head[0] === 0xFF && (head[1] & 0xE0) === 0xE0) return true;
  return /audio|mpeg|mp3|wav|ogg|m4a|aac|opus|flac|webm|octet-stream/i.test(type);
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.opus': 'audio/ogg',
    '.flac': 'audio/flac',
    '.webm': 'audio/webm'
  };
  return map[ext] || 'audio/mpeg';
}

function metadata(filePath) {
  const name = path.basename(filePath);
  const stat = fs.statSync(filePath);
  return {
    id: name,
    name: path.parse(name).name,
    filename: name,
    size: stat.size,
    kind: mimeFor(filePath),
    createdAt: stat.birthtimeMs || stat.ctimeMs
  };
}

async function downloadRemote(url, filename) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Download do áudio falhou (HTTP ${res.status}).`);
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  if (/text\/html|application\/json|application\/xhtml|text\/plain|text\/xml|image\//i.test(contentType)) {
    throw new Error('O link não retornou um arquivo de áudio válido. Use um MP3, WAV, OGG, M4A ou outra mídia de áudio real.');
  }
  const headerLength = Number(res.headers.get('content-length') || '0');
  if (headerLength > MAX_BYTES) throw new Error('Arquivo grande demais (máximo 16 MB).');
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body || []) {
    total += chunk.length;
    if (total > MAX_BYTES) throw new Error('Arquivo grande demais (máximo 16 MB).');
    chunks.push(chunk);
  }
  if (!total) throw new Error('O arquivo de áudio está vazio.');
  const buffer = Buffer.concat(chunks);
  if (!looksLikeAudio(buffer, contentType)) {
    throw new Error('O arquivo baixado não parece ser um áudio válido. Verifique o link ou o formato do arquivo.');
  }
  return { buffer, filename: sanitizeFileName(filename || new URL(url).pathname.split('/').pop() || 'efeito.mp3') };
}

function decodeDataUrl(data) {
  const match = /^data:audio\/(.*?)(?:;base64)?,(.*)$/i.exec(String(data || ''));
  if (match) {
    const [, kind, payload] = match;
    const bytes = Buffer.from(payload, 'base64');
    return { buffer: bytes, filename: `efeito.${kind && kind !== 'octet-stream' ? kind : 'mp3'}` };
  }
  return { buffer: Buffer.from(String(data || ''), 'base64'), filename: 'efeito.mp3' };
}

function buildOwnName(name, filename) {
  const label = stripExtension(name || filename || 'efeito');
  return sanitizeFileName(filename || `${label}.mp3`, `${label}.mp3`);
}

function saveBuffer(buffer, filename) {
  if (!looksLikeAudio(buffer, 'audio')) throw new Error('Arquivo de áudio inválido. O conteúdo não é um áudio suportado.');
  const dir = ensureDir();
  const safeName = sanitizeFileName(filename || 'efeito.mp3', 'efeito.mp3');
  const file = path.join(dir, `${Date.now()}-${randomUUID()}-${safeName}`);
  fs.writeFileSync(file, buffer);
  return file;
}

function listSoundEffects() {
  const dir = ensureDir();
  return fs.readdirSync(dir)
    .filter(name => fs.statSync(path.join(dir, name)).isFile())
    .sort((a, b) => a.localeCompare(b, 'pt-BR'))
    .map(name => metadata(path.join(dir, name)));
}

function resolveSoundEffect(id) {
  const dir = ensureDir();
  const file = path.join(dir, String(id || '').split(/[\\/]/).pop() || '');
  if (!file.startsWith(dir) || !fs.existsSync(file)) throw new Error('Efeito sonoro não encontrado.');
  return file;
}

async function importSoundEffect({ name, filename, url, data }) {
  let buffer; let finalFilename = buildOwnName(name, filename || url);
  if (url) {
    const remote = await downloadRemote(url, filename || path.basename(new URL(url).pathname) || 'efeito.mp3');
    buffer = remote.buffer;
    finalFilename = remote.filename;
  } else if (data) {
    const parsed = decodeDataUrl(data);
    buffer = parsed.buffer;
    finalFilename = buildOwnName(name, filename || parsed.filename || 'efeito.mp3');
  } else {
    throw new Error('Informe um link ou um arquivo para importar o efeito sonoro.');
  }
  if (!buffer?.length) throw new Error('Arquivo de áudio vazio.');
  const file = saveBuffer(buffer, finalFilename);
  return metadata(file);
}

module.exports = { SOUND_EFFECTS_DIR, listSoundEffects, resolveSoundEffect, importSoundEffect, mimeFor };
