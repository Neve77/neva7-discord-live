const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { PassThrough } = require('stream');

function getYtdlpPath() {
  const configured = (process.env.YTDLP_PATH || '').trim();
  const local = path.join(__dirname, '..', 'tools', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (configured) return configured;
  if (fs.existsSync(local)) return local;
  throw new Error('YouTube não instalado. Rode npm run setup:youtube e tente novamente. Arquivos locais continuam funcionando.');
}

function commonArgs() {
  return ['--ignore-config', '--no-plugin-dirs', '--no-remote-components', '--no-playlist',
    '--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`, '--no-progress',
    '--socket-timeout', '15', '--retries', '1', '--fragment-retries', '1'];
}

function youtubeError(stderr, fallback = '') {
  const lines = String(stderr).split(/\r?\n/);
  const detail = lines.findLast(line => line.startsWith('ERROR:')) || fallback || lines.filter(Boolean).at(-1) || 'sem áudio disponível';
  return new Error(`YouTube: ${detail.replace(/^ERROR:\s*/, '').slice(0, 400)}`);
}

async function findYouTube(query) {
  const binary = getYtdlpPath();
  const target = /^https?:\/\//i.test(query) ? query : `ytsearch1:${query}`;
  const raw = await new Promise((resolve, reject) => {
    execFile(binary, [...commonArgs(), '--dump-single-json', '--skip-download', '--', target],
      { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(youtubeError(stderr, error.code === 'ENOENT' ? 'yt-dlp não encontrado; rode npm run setup:youtube' : error.killed ? 'a busca demorou demais; tente novamente' : error.message));
        else resolve(stdout);
      });
  });
  const result = JSON.parse(raw);
  const info = result.entries ? result.entries.find(Boolean) : result;
  if (!info?.id) throw new Error('Não achei essa música no YouTube. Tente nome e artista.');
  if (info.is_live) throw new Error('Use uma música ou vídeo gravado; transmissões ao vivo não são suportadas.');
  return { kind: 'yt', url: info.webpage_url || `https://www.youtube.com/watch?v=${info.id}`,
    title: String(info.title || 'YouTube').slice(0, 150), tmp: false };
}

function openYouTubeStream(url) {
  const proc = spawn(getYtdlpPath(), [...commonArgs(), '-f', 'bestaudio/best', '-o', '-', '--', url],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = new PassThrough();
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  proc.on('error', error => output.destroy(youtubeError('', error.message)));
  proc.stdout.on('error', error => output.destroy(error));
  // Aguarda a saída do processo para não confundir uma falha com fim normal de áudio.
  proc.stdout.pipe(output, { end: false });
  proc.on('close', code => {
    if (output.destroyed) return;
    if (code === 0) output.end();
    else output.destroy(youtubeError(stderr));
  });
  output.on('close', () => { proc.stdout.destroy(); proc.kill(); });
  return output;
}

module.exports = { getYtdlpPath, findYouTube, openYouTubeStream };
