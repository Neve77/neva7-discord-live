const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const fs = require('fs');
const { loadModule, deferred } = require('./helpers');
const { importSoundEffect } = require('../src/sound-effects');

function setup() {
  const ready = deferred();
  const speaking = new EventEmitter();
  const connection = new EventEmitter();
  connection.state = { status: 'connecting' };
  const streams = new Map();
  connection.receiver = { speaking, subscriptions: streams, subscribe(userId) {
    const stream = new PassThrough(); streams.set(userId, stream); return stream;
  } };
  connection.subscribe = () => {};
  connection.destroy = () => {
    connection.state.status = 'destroyed';
    ready.reject(new Error('destroyed'));
    connection.emit('destroyed');
  };
  const player = new EventEmitter();
  player.play = () => {};
  player.stop = () => {};
  let joins = 0;
  const conversions = [];
  const voiceLib = {
    joinVoiceChannel() { joins++; return connection; },
    createAudioPlayer: () => player,
    createAudioResource: () => ({}),
    entersState: (target, status) => target === connection ? ready.promise : Promise.resolve(),
    VoiceConnectionStatus: { Ready: 'ready', Destroyed: 'destroyed' },
    AudioPlayerStatus: { Playing: 'playing', Idle: 'idle' },
    StreamType: { OggOpus: 'ogg' }, EndBehaviorType: { AfterSilence: 'silence' }
  };
  const { ZeroVoiceManager } = loadModule('src/voice.js', {
    './logger': { voz: { error() {} } },
    '@discordjs/voice': voiceLib,
    './ffmpeg': { getFfmpegPath: () => 'ffmpeg', hasFfmpeg: () => true, runFfmpeg: async args => conversions.push(args) },
    opusscript: class { decode(packet) { return packet; } delete() {} }
  }, { process: { env: { OWNER_ID: 'owner' } } });
  const discord = new EventEmitter();
  discord.me = { id: 'bot' };
  const manager = new ZeroVoiceManager(discord, async () => {});
  const connect = () => { connection.state.status = 'ready'; ready.resolve(connection); };
  return { manager, speaking, connection, player, connect, conversions, voiceLib, streams, joins: () => joins };
}

test('importSoundEffect rejeita HTML em vez de mídia válida', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    body: [Buffer.from('<html><body>nao e audio</body></html>')]
  });
  await assert.rejects(importSoundEffect({ url: 'https://example.com/track.html' }), /audio|mídia|arquivo/i);
  global.fetch = originalFetch;
});

test('entradas simultâneas compartilham conexão; repetir entrar não desconecta', async () => {
  const s = setup();
  const first = s.manager.join('guild', 'call');
  const second = s.manager.join('guild', 'call');
  assert.equal(first, second);
  assert.equal(s.joins(), 1);
  s.connect();
  const session = await first;
  assert.equal(await s.manager.join('guild', 'call'), session);
  assert.equal(s.joins(), 1);
  s.manager.leave('guild');
});

test('setLiveFactory registra a sessão live em cada call ativa', async () => {
  const s = setup();
  let called = false;
  s.manager.setLiveFactory((guildId, session) => {
    called = true;
    return { guildId, session };
  });
  const pending = s.manager.join('guild', 'call');
  s.connect();
  const session = await pending;
  assert.equal(called, true);
  assert.equal(session.live.guildId, 'guild');
  s.manager.leave('guild');
});

test('sair cancela entrada pendente sem criar sessão fantasma', async () => {
  const s = setup();
  const pending = s.manager.join('guild', 'call');
  s.manager.leave('guild');
  await assert.rejects(pending);
  assert.equal(s.manager.get('guild'), undefined);
  assert.equal(s.manager.pending.size, 0);
});

test('sair da call também cancela síntese de voz pendente', async () => {
  const s = setup();
  const pending = s.manager.join('guild', 'call');
  s.connect();
  const session = await pending;
  session.synthesisAbort = new AbortController();
  s.manager.leave('guild');
  assert.equal(session.synthesisAbort.signal.aborted, true);
});

test('playPcmStream reproduz PCM do Live sem falhar na call', async () => {
  const s = setup();
  const pending = s.manager.join('guild', 'call');
  s.connect();
  await pending;
  const source = new PassThrough();
  const result = s.manager.playPcmStream('guild', source, { signal: new AbortController().signal, maxDuration: 2000 });
  source.write(Buffer.alloc(9600));
  source.end();
  assert.equal(await result, true);
  s.manager.leave('guild');
});

test('muta não dispara captura nem erro quando outra pessoa fala', async () => {
  const s = setup();
  const pending = s.manager.join('guild', 'call');
  s.connect();
  await pending;
  s.manager.setListen('guild', false);
  s.manager.capture = () => { throw new Error('capture must not be called'); };
  assert.doesNotThrow(() => s.speaking.emit('start', 'person'));
  s.manager.leave('guild');
});

test('evento speaking e ruído de outra pessoa não cancelam resposta em andamento', async () => {
  const s = setup();
  const pending = s.manager.join('guild', 'call');
  s.connect();
  const session = await pending;
  const response = new AbortController();
  const synthesis = new AbortController();
  const playback = new AbortController();
  session.responseAbort = response;
  session.synthesisAbort = synthesis;
  session.speechAbort = playback;
  session.responseUserId = 'owner';
  s.speaking.emit('start', 'person');
  s.streams.get('person').end(Buffer.alloc(640));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.signal.aborted, false);
  assert.equal(synthesis.signal.aborted, false);
  assert.equal(playback.signal.aborted, false);
  s.manager.leave('guild');
});

test('volume zero chega ao FFmpeg e erro de reprodução não vira sucesso', async () => {
  const s = setup();
  const pending = s.manager.join('guild', 'call');
  s.connect();
  const session = await pending;
  s.manager.setVolumes('guild', { speech: 0 });
  s.player.play = () => { throw new Error('audio failed'); };
  await assert.rejects(s.manager.playFiles('guild', ['test.mp3']), /audio failed/);
  assert.ok(s.conversions[0].includes('volume=0'));
  assert.equal(s.conversions[0][s.conversions[0].indexOf('-application') + 1], 'audio');
  assert.equal(s.conversions[0][s.conversions[0].indexOf('-frame_duration') + 1], '20');
  assert.equal(session.playing, false);
  s.manager.leave('guild');
});

test('pacote de ruído não corta a fala; 300ms de voz contínua interrompem', async () => {
  const s = setup();
  const pending = s.manager.join('guild', 'call');
  s.connect();
  const session = await pending;
  session.playing = true;
  let stops = 0;
  s.player.stop = () => { stops++; };
  let stream;
  s.connection.receiver.subscribe = () => { stream = new PassThrough(); return stream; };
  const noise = s.manager.capture('guild', session, 'person-a');
  stream.end(Buffer.alloc(640));
  await noise;
  assert.equal(stops, 0);
  const speech = s.manager.capture('guild', session, 'person-b');
  const pcm = Buffer.alloc(640);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(2000, i);
  for (let i = 0; i < 14; i++) stream.write(pcm);
  assert.equal(stops, 0);
  stream.write(pcm);
  assert.equal(stops, 1);
  stream.end();
  await speech;
  assert.notEqual(session.decoders.get('person-a'), session.decoders.get('person-b'));
  s.manager.leave('guild');
  await session.responseTask;
});

function speechFrame() {
  const pcm = Buffer.alloc(640);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(2000, i);
  return pcm;
}

test('duas pessoas são capturadas juntas e respondidas sem concorrer nem misturar PCM', async () => {
  const s = setup();
  const joining = s.manager.join('guild', 'call'); s.connect();
  const session = await joining;
  const heard = [], paths = [];
  s.manager.onSpeech = async (user, file) => {
    paths.push(file);
    const wav = fs.readFileSync(file);
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.length, 44 + 640 * 15);
    heard.push(user);
  };
  const first = s.manager.capture('guild', session, 'a');
  const second = s.manager.capture('guild', session, 'b');
  for (let i = 0; i < 15; i++) {
    s.streams.get('a').write(speechFrame());
    s.streams.get('b').write(speechFrame());
  }
  assert.equal(session.captures.size, 2);
  s.streams.get('a').end(); s.streams.get('b').end();
  await Promise.all([first, second]);
  await session.responseTask;
  assert.deepEqual(heard, ['a', 'b']);
  assert.ok(paths.every(file => !fs.existsSync(file)));
  s.manager.leave('guild');
});

test('só o interlocutor ou dono interrompem após 300ms; dono é o próximo da fila', async () => {
  const s = setup();
  const joining = s.manager.join('guild', 'call'); s.connect();
  const session = await joining;
  const started = deferred(), cancelled = deferred();
  const heard = [];
  s.manager.onSpeech = async (user, file, guild, { abort }) => {
    heard.push(user);
    if (user === 'a') {
      started.resolve();
      await new Promise(resolve => abort.signal.addEventListener('abort', resolve, { once: true }));
      cancelled.resolve();
    }
  };
  s.manager.queueSpeech('guild', session, { userId: 'a', pcm: speechFrame(), endedAt: Date.now() });
  await started.promise;
  const response = session.responseAbort;
  s.manager.interruptForSpeaker(session, 'b');
  assert.equal(response.signal.aborted, false);
  s.manager.queueSpeech('guild', session, { userId: 'b', pcm: speechFrame(), endedAt: Date.now() });
  const capture = s.manager.capture('guild', session, 'owner');
  for (let i = 0; i < 14; i++) s.streams.get('owner').write(speechFrame());
  assert.equal(response.signal.aborted, false);
  s.streams.get('owner').write(speechFrame());
  await cancelled.promise;
  assert.equal(response.signal.aborted, true);
  s.streams.get('owner').end();
  await capture;
  while (session.responseTask) await session.responseTask;
  assert.deepEqual(heard, ['a', 'owner', 'b']);
  s.manager.leave('guild');
});

test('fila limita pendências, troca frase da mesma pessoa e descarta fala vencida', async () => {
  const s = setup();
  const joining = s.manager.join('guild', 'call'); s.connect();
  const session = await joining;
  session.responseTask = Promise.resolve(); // ocupa a resposta para inspecionar a fila
  const enqueue = (userId, endedAt = Date.now()) => s.manager.queueSpeech('guild', session, { userId, endedAt, pcm: speechFrame() });
  enqueue('old', Date.now() - 9000);
  enqueue('a'); enqueue('b'); enqueue('a'); enqueue('c'); enqueue('d'); enqueue('owner');
  assert.equal(session.pendingSpeech.length, 3);
  assert.deepEqual(Array.from(session.pendingSpeech, item => item.userId), ['owner', 'b', 'a']);
  session.pendingSpeech[0].endedAt = Date.now() - 9000;
  const heard = [];
  s.manager.onSpeech = async user => heard.push(user);
  session.responseTask = null;
  s.manager.drainSpeech('guild', session);
  await session.responseTask;
  assert.deepEqual(heard, ['b', 'a']);
  s.manager.leave('guild');
});

test('captura Live entrega frames durante a fala sem criar WAV nem chamar o pipeline legado', async () => {
  const s=setup(),frames=[];let closed=false,legacyCalls=0,paused=false;
  s.manager.onSpeech=async()=>legacyCalls++;
  s.manager.setLiveFactory(()=>({options:{maxParticipants:8,incompleteMs:1000,maxUtteranceSeconds:30},ingest:(id,pcm)=>frames.push({id,pcm}),close:()=>closed=true,pause:on=>paused=on,telemetry:{count(){}}}));
  const joining=s.manager.join('guild','call');s.connect();const session=await joining;
  const capture=s.manager.capture('guild',session,'person');s.streams.get('person').write(speechFrame());
  assert.equal(frames.length,1);assert.equal(frames[0].id,'person');assert.equal(frames[0].pcm.length,640);
  s.manager.setListen('guild',false);await capture;assert.equal(paused,true);assert.equal(legacyCalls,0);assert.equal(session.captures.size,0);
  s.manager.leave('guild');assert.equal(closed,true);
});

function recordingSpy(manager){const frames=[],stops=[];let on=true;manager.recordings={isActive:()=>on,capture:(...args)=>frames.push(args),stop:(gid,reason)=>{on=false;stops.push(reason);}};return {frames,stops};}
test('gravação recebe o mesmo PCM do Live sem abrir uma segunda assinatura',async()=>{
  const s=setup(),liveFrames=[];s.manager.setLiveFactory(()=>({options:{maxParticipants:8,incompleteMs:1000,maxUtteranceSeconds:30},ingest:(id,pcm)=>liveFrames.push(pcm),close(){},telemetry:{count(){}}}));
  const joining=s.manager.join('guild','call');s.connect();const session=await joining,rec=recordingSpy(s.manager);
  const task=s.manager.capture('guild',session,'person');s.streams.get('person').end(speechFrame());await task;
  assert.equal(rec.frames.length,1);assert.deepEqual(rec.frames[0][3],liveFrames[0]);assert.equal(s.streams.size,1);s.manager.leave('guild');assert.equal(rec.stops[0],'left-call');
});
test('gravação funciona com IA pausada ou escuta desligada sem chamar a IA',async()=>{
  for(const live of [false,true]){const s=setup();let heard=0;s.manager.onSpeech=async()=>heard++;
    if(live)s.manager.setLiveFactory(()=>({paused:true,options:{maxParticipants:8},ingest(){throw new Error('não enviar');},close(){}}));
    const joining=s.manager.join('guild','call');s.connect();const session=await joining;if(!live)session.deaf=true;const rec=recordingSpy(s.manager);
    const task=s.manager.capture('guild',session,'person');s.streams.get('person').end(speechFrame());await task;assert.equal(rec.frames.length,1);assert.equal(heard,0);s.manager.leave('guild');
  }
});
test('saída do bot só é gravada quando o player lê e não quando o recurso é preparado',async()=>{
  const s=setup();const joining=s.manager.join('guild','call');s.connect();const session=await joining,rec=recordingSpy(s.manager);
  const resource={playStream:new EventEmitter(),read:()=>speechFrame()};s.manager.recordPlayback('guild',session,resource);assert.equal(rec.frames.length,0);
  resource.read();assert.equal(rec.frames.length,1);assert.equal(rec.frames[0][4].bot,true);assert.equal(rec.frames[0][1],'bot');resource.playStream.emit('end');resource.read();assert.equal(rec.frames.length,1);s.manager.leave('guild');
});
test('fluxos apenas de gravação não ocupam o limite de participantes da IA',async()=>{
  const s=setup(),frames=[];s.manager.setLiveFactory(()=>({options:{maxParticipants:1,incompleteMs:1000,maxUtteranceSeconds:30},ingest:(id,pcm)=>frames.push(pcm),close(){},telemetry:{count(){}}}));
  const joining=s.manager.join('guild','call');s.connect();const session=await joining;recordingSpy(s.manager);
  session.captures.set('other',{recordOnly:true,stream:{destroy(){}}});const task=s.manager.capture('guild',session,'person');s.streams.get('person').end(speechFrame());await task;assert.equal(frames.length,1);s.manager.leave('guild');
});
