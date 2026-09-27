require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generateGeminiSpeech } = require('../src/gemini-voice.mjs');
const { getTtsInfo } = require('../src/tts');
const { runFfmpeg, getFfmpegPath } = require('../src/ffmpeg');

async function main() {
  getFfmpegPath(); // Check playback prerequisites before consuming any API quota.
  const text = process.argv.slice(2).join(' ') || 'E aí, beleza? Você tá me ouvindo direitinho? Bora entrar na call e conversar um pouco?';
  const result = await generateGeminiSpeech(text, { voice: getTtsInfo().voice });
  const dir = path.join(__dirname, '..', 'samples', 'gemini');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'teste-pt-br.wav');
  fs.writeFileSync(file, result.wav);
  const report = {
    model: result.model, voice: result.voice, format: 'PCM16 LE mono 24000 Hz', text,
    transcript: result.transcript, generationSeconds: result.generationMs / 1000,
    firstAudioSeconds: result.firstAudioMs / 1000,
    audioSeconds: (result.wav.length - 44) / 48000
  };
  fs.writeFileSync(path.join(dir, 'resultado.json'), JSON.stringify(report, null, 2) + '\n');
  await runFfmpeg(['-v', 'error', '-i', file, '-f', 'null', '-']);
  console.log(JSON.stringify(report, null, 2));
  console.log(`Áudio validado com FFmpeg: ${file}`);
}

main().catch(error => { console.error(`[gemini] ${error.message}`); process.exitCode = 1; });
