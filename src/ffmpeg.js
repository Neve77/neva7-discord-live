const { spawnSync, execFile } = require('child_process');
const path = require('path');

let command;
function getFfmpegPath() {
  if (command) return command;
  const candidates = [...new Set([process.env.FFMPEG_PATH?.trim(), path.join(__dirname, '../tools/ffmpeg/bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), 'ffmpeg'].filter(Boolean))];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-version'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
    if (!result.error && result.status === 0) {
      command = candidate;
      return command;
    }
  }
  throw new Error('FFmpeg não encontrado. Instale com winget install Gyan.FFmpeg ou configure FFMPEG_PATH no .env.');
}

function hasFfmpeg() {
  try { getFfmpegPath(); return true; } catch { return false; }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(getFfmpegPath(), args, { windowsHide: true, timeout: 60000 },
      (error) => error ? reject(error) : resolve());
  });
}

module.exports = { getFfmpegPath, hasFfmpeg, runFfmpeg };
