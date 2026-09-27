const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { findYouTube } = require('./youtube');
const { allocateTemp } = require('./cache');

const MUSICAS_DIR = path.join(__dirname, '..', 'musicas');
const AUDIO_EXTENSION = /\.(mp3|ogg|wav|m4a|opus|flac|aac|webm)$/i;
const MAX_BYTES = 30 * 1024 * 1024;

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

async function downloadAudio(url, name) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Download de áudio falhou (HTTP ${res.status}).`);
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  if (/text\/html|application\/json|application\/xhtml|text\/plain|text\/xml|image\//i.test(contentType)) {
    throw new Error('O link não retornou um arquivo de áudio válido. Use um arquivo MP3, WAV, OGG, M4A ou outro áudio real.');
  }
  if (Number(res.headers.get('content-length')) > MAX_BYTES) {
    await res.body?.cancel();
    throw new Error('Arquivo grande demais (máximo 30 MB).');
  }
  const parts = [];
  let length = 0;
  for await (const chunk of res.body) {
    length += chunk.length;
    if (length > MAX_BYTES) throw new Error('Arquivo grande demais (máximo 30 MB).');
    parts.push(chunk);
  }
  if (!length) throw new Error('O arquivo de áudio está vazio.');
  const buffer = Buffer.concat(parts);
  if (!looksLikeAudio(buffer, contentType)) {
    throw new Error('O arquivo baixado não parece ser um áudio válido. Verifique o link ou o formato do arquivo.');
  }
  const extension = path.extname(String(name || 'audio.mp3')).slice(1).toLowerCase();
  const file = allocateTemp('music', /^(mp3|wav|ogg|m4a|opus|flac|aac|webm)$/.test(extension) ? extension : 'mp3');
  await fs.promises.writeFile(file, buffer);
  return { title: name || 'Áudio', file, tmp: true };
}

async function resolveTrack(query = '', attachment) {
  if (attachment?.url) return downloadAudio(attachment.url, attachment.filename || 'audio.mp3');
  query = query.trim().replace(/^"(.*)"$/, '$1');
  if (!query) throw new Error('Informe o nome da música, link do YouTube ou arquivo da pasta musicas.');
  if (/^https?:\/\//i.test(query)) {
    const url = new URL(query);
    if (url.hostname === 'youtu.be' || url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com')) return findYouTube(url.href);
    if (!AUDIO_EXTENSION.test(url.pathname)) throw new Error('Use um link do YouTube ou link direto de áudio (.mp3, .ogg, .wav...).');
    return downloadAudio(url.href, decodeURIComponent(path.posix.basename(url.pathname)));
  }
  fs.mkdirSync(MUSICAS_DIR, { recursive: true });
  const files = fs.readdirSync(MUSICAS_DIR).filter(name => AUDIO_EXTENSION.test(name));
  const local = files.find(name => name.toLowerCase() === query.toLowerCase()) ||
    files.find(name => path.parse(name).name.toLowerCase() === query.toLowerCase());
  if (local) return { title: local, file: path.join(MUSICAS_DIR, local), tmp: false };
  if (AUDIO_EXTENSION.test(query)) throw new Error(`Não achei "${query}" na pasta musicas. Copie o arquivo para lá ou digite nome e artista para buscar no YouTube.`);
  return findYouTube(query);
}

module.exports = { resolveTrack };
