const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModule, deferred } = require('./helpers');

function setup({ voice = 'francisca', speed = 1, fail = false, env = {}, config = {}, gemini = {}, pending } = {}) {
  const calls = [], writes = [];
  const audio = Buffer.from('original-audio');
  class EdgeTTS {
    constructor(text, voice, options) { calls.push({ text, voice, options }); }
    async synthesize() {
      if (pending) await pending;
      if (fail) throw new Error('edge unavailable');
      return { audio: { arrayBuffer: async () => audio } };
    }
  }
  const tts = loadModule('src/tts.js', {
    'edge-tts-universal': { EdgeTTS },
    fs: { writeFileSync: (file, bytes) => writes.push({ file, bytes }) },
    './config': { config, state: { ttsVoice: voice, ttsSpeed: speed } },
    './gemini-voice.mjs': {
      GEMINI_AUDIO_MODEL: 'gemini-2.5-flash-native-audio-preview-12-2025', GEMINI_VOICES: ['Aoede', 'Kore'],
      geminiVoiceName: value => value === 'Kore' ? value : 'Aoede', ...gemini
    },
    openai: class { constructor() { assert.fail('não usar API paga'); } },
    child_process: { execFileSync() { assert.fail('não recodificar MP3'); } }
  }, { process: { env } });
  return { tts, calls, writes, audio };
}

test('preserva áudio original sem filtros, pitch artificial ou desaceleração', async () => {
  const s = setup();
  await s.tts.speak('Teste, um dois três.');
  assert.equal(s.calls[0].voice, 'pt-BR-FranciscaNeural');
  assert.equal(s.calls[0].options.rate, '+0%');
  assert.equal(s.calls[0].options.pitch, '+0Hz');
  assert.deepEqual(s.writes[0].bytes, s.audio);
});

test('respeita voz/velocidade escolhidas e oferece só vozes PT-BR verificadas', async () => {
  const s = setup({ speed: 1.2, voice: 'thalita' });
  await s.tts.speak('Agora sim.');
  assert.equal(s.calls[0].options.rate, '+20%');
  assert.equal(s.calls[0].voice, 'pt-BR-ThalitaMultilingualNeural');
  assert.equal(s.tts.listVoices().join(','), 'francisca,thalita,antonio');
});

test('perfis de voz expõem o timbre e o estilo para o painel', () => {
  const edge = setup();
  assert.deepEqual(JSON.parse(JSON.stringify(edge.tts.listVoiceProfiles())), [
    { id: 'francisca', name: 'Francisca', timbre: 'feminino', style: 'Natural e acolhedora' },
    { id: 'thalita', name: 'Thalita', timbre: 'feminino', style: 'Clara e versátil' },
    { id: 'antonio', name: 'Antonio', timbre: 'masculino', style: 'Calmo e direto' }
  ]);
  const gemini = setup({ env: { TTS_MODE: 'gemini' } });
  assert.deepEqual(JSON.parse(JSON.stringify(gemini.tts.listVoiceProfiles())), [
    { id: 'aoede', name: 'Aoede', timbre: 'feminino', style: 'Leve' },
    { id: 'kore', name: 'Kore', timbre: 'masculino', style: 'Firme' }
  ]);
});

test('remove risadas escritas e marcações e expande abreviações', () => {
  const { tts } = setup();
  const cleaned = tts.ttsClean('Haha, **vc** tá mt bnt! kkk 😂 <@123456>');
  assert.equal(cleaned, 'você tá muito bonito!');
  assert.equal(tts.ttsClean('Veja [isso](https://example.com).'), 'Veja isso.');
  assert.equal(tts.ttsClean(cleaned), cleaned);
});

test('falha do Edge tenta outra voz gratuita e nunca chama serviço pago', async () => {
  const s = setup({ fail: true, env: { TTS_MODE: 'openai', OPENAI_API_KEY: 'test-key' } });
  await assert.rejects(s.tts.speak('Teste'), /Voz gratuita indisponível/);
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].voice, 'pt-BR-ThalitaMultilingualNeural');
  assert.equal(s.writes.length, 0);
});

test('amostras não mudam voz persistida e texto vazio não gera áudio', async () => {
  const s = setup();
  await s.tts.speak('Comparação.', 'pt', { voice: 'antonio', speed: 1 });
  await s.tts.speak('Voz escolhida.');
  assert.equal(s.calls[0].voice, 'pt-BR-AntonioNeural');
  assert.equal(s.calls[1].voice, 'pt-BR-FranciscaNeural');
  await assert.rejects(s.tts.speak('kkk 😂'), /Não há texto pronunciável/);
  assert.equal(s.calls.length, 2);
});

test('idioma detectado não troca o sotaque brasileiro por uma voz inglesa', async () => {
  const s = setup();
  await s.tts.speak('Você tá no Discord? Bora entrar na call.', 'english');
  assert.equal(s.calls[0].voice, 'pt-BR-FranciscaNeural');
  assert.equal(s.calls[0].text, 'Você tá no Discórdi? Bora entrar na chamada.');
  assert.equal(s.tts.speechLanguage('pt-PT'), 'pt-BR');
});

test('modo multilíngue é explícito e não altera palavras inglesas como to', async () => {
  const s = setup({ env: { TTS_LANGUAGE: 'auto' } });
  await s.tts.speak('Go to Discord and call me.', 'english');
  assert.equal(s.calls[0].voice, 'en-US-AriaNeural');
  assert.equal(s.calls[0].text, 'Go to Discord and call me.');
  await s.tts.speak('Estou no YouTube.', 'portuguese');
  assert.equal(s.calls[1].voice, 'pt-BR-FranciscaNeural');
  assert.equal(s.calls[1].text, 'Estou no Iutúbi.');
});

test('política multilíngue do painel supera env PT e escolhe vozes ES, EN e PT-BR',async()=>{
  const s=setup({env:{TTS_LANGUAGE:'pt-BR'}});
  await s.tts.speak('Hola, ¿cómo estás?','spanish',{replyLanguage:'auto',buffer:true});
  await s.tts.speak('I want to speak.','english',{replyLanguage:'auto',buffer:true});
  await s.tts.speak('Olá, você tá bem?','pt-BR',{replyLanguage:'auto',buffer:true});
  assert.equal(s.calls[0].voice,'es-ES-ElviraNeural');assert.equal(s.calls[1].voice,'en-US-AriaNeural');assert.equal(s.calls[1].text,'I want to speak.');assert.equal(s.calls[2].voice,'pt-BR-FranciscaNeural');assert.equal(s.writes.length,0);
});

test('pronúncias respeitam palavras inteiras, acentos e nomes personalizados', async () => {
  const s = setup({ config: { ttsPronunciation: { YouTube: 'You Túbi', 'C++': 'cê mais mais' } } });
  const text = 'É callback ou call? Discordiano, João e André usam YouTube e C++.';
  await s.tts.speak(text);
  assert.equal(s.calls[0].text, 'É callback ou chamada? Discordiano, João e André usam You Túbi e cê mais mais.');
  assert.equal(text, 'É callback ou call? Discordiano, João e André usam YouTube e C++.');
});

test('Gemini usa grafia original e salva WAV; painel lista as vozes nativas', async () => {
  const requests = [];
  const wav = Buffer.from('wav-original');
  const s = setup({ env: { TTS_MODE: 'gemini' }, gemini: {
    generateGeminiSpeech: async (text, options) => { requests.push({ text, options }); return { wav }; }
  } });
  const file = await s.tts.speak('vc tá no Discord?', 'english');
  assert.match(file, /\.wav$/);
  assert.equal(requests[0].text, 'você tá no Discord?');
  assert.equal(requests[0].options.language, 'pt-BR');
  assert.equal(requests[0].options.voice, 'Aoede');
  assert.deepEqual(s.writes[0].bytes, wav);
  assert.equal(s.calls.length, 0);
  assert.equal(s.tts.listVoices().join(','), 'aoede,kore');
});

test('Gemini sem cota não muda silenciosamente de provedor; Edge exige opção explícita', async () => {
  const gemini = { generateGeminiSpeech: async () => { throw new Error('429 quota'); } };
  const s = setup({ env: { TTS_MODE: 'gemini' }, gemini });
  await assert.rejects(s.tts.speak('Teste'), /429 quota/);
  assert.equal(s.calls.length, 0);
  const fallback = setup({ env: { TTS_MODE: 'gemini', TTS_FALLBACK: 'edge' }, gemini });
  assert.match(await fallback.tts.speak('Teste'), /\.mp3$/);
  assert.equal(fallback.calls.length, 1);
  const explicit = setup({ env: { TTS_MODE: 'gemini' }, gemini });
  await explicit.tts.speak('Teste Edge', 'pt', { provider: 'edge' });
  assert.equal(explicit.calls.length, 1);
});

test('cancelar Edge libera resposta pendente e não salva áudio atrasado nem tenta outra voz', async () => {
  const pending = deferred();
  const s = setup({ pending: pending.promise });
  const controller = new AbortController();
  const speaking = s.tts.speak('Teste de cancelamento.', 'pt', { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(speaking, /cancelada/);
  pending.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.calls.length, 1);
  assert.equal(s.writes.length, 0);
});
