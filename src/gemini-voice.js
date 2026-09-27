// Gemini TTS via @google/genai — áudio nativo PCM 24kHz 16-bit mono
const { GoogleGenAI, Modality } = require('@google/genai');

const GEMINI_AUDIO_MODEL = process.env.GEMINI_AUDIO_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';

// Vozes do Gemini (nativas, sem Edge)
const GEMINI_VOICES = [
  'Aoede', 'Charon', 'Fenrir', 'Kore', 'Leda', 'Orus', 'Puck', 'Zephyr'
];
const GEMINI_VOICE_ALIASES = {
  natural: 'Kore', fem: 'Kore', feminino: 'Kore', male: 'Charon', masculino: 'Charon',
  aoede: 'Aoede', charon: 'Charon', fenrir: 'Fenrir', kore: 'Kore', leda: 'Leda',
  orus: 'Orus', puck: 'Puck', zephyr: 'Zephyr'
};

function geminiVoiceName(name) {
  const key = String(name || 'Kore').toLowerCase().trim();
  return GEMINI_VOICE_ALIASES[key] || GEMINI_VOICES.find(v => v.toLowerCase() === key) || 'Kore';
}

let genAIClient = null;
function getClient() {
  if (genAIClient) return genAIClient;
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY não configurada no .env');
  genAIClient = new GoogleGenAI({ apiKey });
  return genAIClient;
}

// Gera PCM 24kHz 16-bit mono e retorna WAV buffer pronto
async function generateGeminiSpeech(text, options = {}) {
  const client = getClient();
  const voice = geminiVoiceName(options.voice || process.env.GEMINI_VOICE || 'Kore');
  const speed = Number(options.speed ?? 1);
  const cleaned = String(text || '').trim().slice(0, 2000);
  if (!cleaned) throw new Error('Texto vazio para TTS');

  const startTime = Date.now();
  const response = await client.models.generateContent({
    model: GEMINI_AUDIO_MODEL,
    contents: [{ role: 'user', parts: [{ text: cleaned }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice }
        }
      }
    }
  });

  // Extrai áudio do response
  const candidates = response.candidates || [];
  if (!candidates.length) throw new Error('Gemini retornou sem candidatos');
  const parts = candidates[0].content?.parts || [];
  const audioPart = parts.find(p => p.inlineData?.data);
  if (!audioPart) {
    const textPart = parts.find(p => p.text);
    const reason = textPart?.text || candidates[0].finishReason || 'desconhecido';
    throw new Error(`Gemini não retornou áudio: ${reason}`);
  }

  const pcmBytes = Buffer.from(audioPart.inlineData.data, 'base64');
  const elapsed = Date.now() - startTime;

  // PCM 24kHz 16-bit mono → WAV
  const wav = pcmToWav(pcmBytes, 24000, 1, 16);
  console.log(`[gemini-tts] ✅ ${voice} | ${pcmBytes.length} bytes PCM | ${elapsed}ms | ${cleaned.slice(0, 40)}...`);
  return { wav, pcm: pcmBytes, sampleRate: 24000, channels: 1, bitsPerSample: 16, elapsed };
}

function pcmToWav(pcm, sampleRate, numChannels, bitsPerSample) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const buf = Buffer.alloc(44 + dataSize);
  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  // fmt sub-chunk
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  // data sub-chunk
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf;
}

module.exports = { generateGeminiSpeech, geminiVoiceName, GEMINI_VOICES, GEMINI_AUDIO_MODEL, pcmToWav };
