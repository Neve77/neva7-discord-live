const test = require('node:test');
const assert = require('node:assert/strict');
const { generateGeminiSpeech, streamGeminiSpeech, pcmToWav, GEMINI_AUDIO_MODEL, normalizeGeminiModel, GEMINI_API_MODES } = require('../src/gemini-voice.mjs');
const { deferred } = require('./helpers');

function fakeClient(onSend) {
  const sent = [], connections = [];
  let closed = 0;
  const client = { live: { async connect(options) {
    connections.push(options);
    return {
      sendClientContent(packet) { sent.push(packet); onSend?.(options.callbacks); },
      close() { closed++; options.callbacks.onclose({ code: 1000 }); }
    };
  } } };
  return { client, sent, connections, get closed() { return closed; } };
}
const audioMessage = (bytes, extra = {}) => ({ serverContent: {
  modelTurn: { parts: [{ inlineData: { data: bytes.toString('base64'), mimeType: 'audio/pcm;rate=24000' } }] }, ...extra
} });

test('aceita aliases de modelo e modo de API Gemini compatível', () => {
  assert.equal(normalizeGeminiModel('gemini-2.5-flash-preview-tts', 'audio'), 'gemini-2.5-flash-preview-tts');
  assert.equal(normalizeGeminiModel('gemini-2.5-flash-native-audio-preview-12-2025', 'live'), 'gemini-2.5-flash-native-audio-preview-12-2025');
  assert.ok(GEMINI_API_MODES.live.includes('live'));
  assert.ok(GEMINI_API_MODES.audio.includes('audio'));
});

test('usa modelo exato e AUDIO, concatena PCM mono 24 kHz sem alterar amostras', async () => {
  const pcm = Buffer.from([1, 0, 255, 127, 0, 128, 255, 255]);
  const fake = fakeClient(cb => {
    cb.onmessage(audioMessage(pcm.subarray(0, 4), { outputTranscription: { text: 'Olá, ' } }));
    cb.onmessage(audioMessage(pcm.subarray(4), { outputTranscription: { text: 'Brasil!' } }));
    cb.onmessage({ serverContent: { turnComplete: true } });
  });
  const result = await generateGeminiSpeech('Olá, Brasil!', { client: fake.client, voice: 'aoede' });
  assert.equal(fake.connections[0].model, GEMINI_AUDIO_MODEL);
  assert.deepEqual(fake.connections[0].config.responseModalities, ['AUDIO']);
  assert.equal(fake.connections[0].config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
  assert.equal(fake.connections[0].config.speechConfig.languageCode, undefined);
  assert.match(fake.connections[0].config.systemInstruction, /sotaque brasileiro/);
  assert.equal(result.wav.readUInt16LE(22), 1);
  assert.equal(result.wav.readUInt16LE(34), 16);
  assert.equal(result.wav.readUInt32LE(24), 24000);
  assert.equal(result.wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(result.wav.subarray(44), pcm);
  assert.equal(result.transcript, 'Olá, Brasil!');
  assert.equal(fake.sent[0].turnComplete, true);
  assert.equal(fake.closed, 1);
});

test('áudio vazio, taxa errada e PCM incompleto são erros, nunca sucesso', async () => {
  assert.throws(() => pcmToWav(Buffer.from([1])), /incompleto/);
  for (const message of [
    { serverContent: { turnComplete: true } },
    { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' } }] } } },
    audioMessage(Buffer.from([1]), { turnComplete: true })
  ]) {
    const fake = fakeClient(cb => cb.onmessage(message));
    await assert.rejects(generateGeminiSpeech('Teste', { client: fake.client }), /PCM|Formato/);
    assert.equal(fake.closed, 1);
  }
});

test('timeout inclui handshake pendente e fecha conexão que chegar atrasada', async () => {
  const connecting = deferred();
  let closed = 0;
  const client = { live: { connect: () => connecting.promise } };
  await assert.rejects(generateGeminiSpeech('Teste', { client, timeoutMs: 10 }), /não concluiu/);
  connecting.resolve({ close() { closed++; }, sendClientContent() { assert.fail('não enviar após timeout'); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1);
});

test('cota esgotada e fechamento prematuro não fazem outra tentativa', async () => {
  for (const fail of [cb => cb.onerror({ message: '429 quota exceeded' }), cb => cb.onclose({ code: 1008, reason: 'quota' })]) {
    const fake = fakeClient(fail);
    await assert.rejects(generateGeminiSpeech('Teste', { client: fake.client }), /quota/);
    assert.equal(fake.connections.length, 1);
    assert.equal(fake.closed, 1);
  }
});

test('cancelar síntese fecha o websocket e ignora áudio atrasado', async () => {
  const controller = new AbortController();
  const fake = fakeClient(cb => { controller.abort(); cb.onmessage(audioMessage(Buffer.alloc(20), { turnComplete: true })); });
  await assert.rejects(generateGeminiSpeech('Teste', { client: fake.client, signal: controller.signal }), /cancelada/);
  assert.equal(fake.closed, 1);
});

test('stream libera PCM antes de turnComplete, sem esperar a frase inteira', async () => {
  let callbacks;
  const first = deferred();
  const fake = fakeClient(cb => {
    callbacks = cb;
    cb.onmessage(audioMessage(Buffer.alloc(24000 * 2 / 5)));
  });
  const generated = streamGeminiSpeech('Teste', { client: fake.client, bufferMs: 160 });
  generated.stream.once('data', chunk => first.resolve(chunk));
  const chunk = await first.promise;
  assert.equal(chunk.length, 9600);
  assert.equal(fake.closed, 0);
  callbacks.onmessage({ serverContent: { turnComplete: true } });
  await generated.done;
  assert.equal(fake.closed, 1);
});

test('prazo para primeiro áudio encerra conexão sem esperar o prazo da frase', async () => {
  const fake = fakeClient();
  await assert.rejects(generateGeminiSpeech('Teste', {
    client: fake.client, firstAudioTimeoutMs: 10, timeoutMs: 1000
  }), /demorou para começar/);
  assert.equal(fake.closed, 1);
});
