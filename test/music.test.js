const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { loadModule, deferred } = require('./helpers');
const tick = () => new Promise(resolve => setImmediate(resolve));

function queueSetup() {
  const processes = [], plays = [], errors = [], removed = [];
  const youtube = { openYouTubeStream: () => {
    if (youtube.fail) throw new Error('vídeo indisponível');
    return new PassThrough();
  } };
  const { ZeroVoiceManager } = loadModule('src/voice.js', {
    fs: { unlinkSync: file => removed.push(file) }, './config': { config: {} },
    './youtube': youtube,
    './logger': { music: { playing() {}, error: (...args) => errors.push(args) } },
    './ffmpeg': { getFfmpegPath: () => 'ffmpeg', hasFfmpeg: () => true },
    child_process: { spawn(file, args) {
      const proc = new EventEmitter();
      Object.assign(proc, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), args });
      proc.kill = () => { proc.killed = true; proc.emit('close', null); };
      processes.push(proc);
      return proc;
    } },
    '@discordjs/voice': { createAudioResource: stream => ({ stream }), StreamType: { OggOpus: 'ogg' } },
    './playback': { playResource(player, resource, options) {
      const done = deferred();
      const finish = result => { options.signal.removeEventListener('abort', abort); done.resolve(result); };
      const abort = () => finish(false);
      options.signal.addEventListener('abort', abort, { once: true });
      plays.push({ resource, finish });
      options.onPlaying();
      return done.promise;
    } }
  });
  const manager = new ZeroVoiceManager(new EventEmitter(), async () => {});
  const session = { player: { stop() {} }, tracks: [], musicVol: 0 };
  manager.active.set('g', session);
  return { manager, session, processes, plays, errors, removed, youtube };
}

test('fila reproduz duas faixas, respeita volume zero e encerra processos', async () => {
  const s = queueSetup();
  await s.manager.enqueueMusic('g', [{ title: 'a', file: 'a.mp3' }, { title: 'b', file: 'b.wav', tmp: true }]);
  assert.equal(s.session.currentTrack.title, 'a');
  assert.ok(s.processes[0].args.includes('volume=0'));
  s.plays[0].finish(true);
  await tick();
  assert.equal(s.session.currentTrack.title, 'b');
  s.plays[1].finish(true);
  await s.session.musicDone;
  assert.equal(s.session.tracks.length, 0);
  assert.equal(s.session.musicBusy, false);
  assert.deepEqual(s.removed, ['b.wav']);
  await tick();
  assert.ok(s.processes.every(proc => proc.killed));
});

test('parar durante preparação não inicia a antiga nem remove uma faixa recém-adicionada', async () => {
  const s = queueSetup(), speech = deferred();
  s.session.speechDone = speech.promise;
  const old = { title: 'antiga', file: 'old.mp3' }, fresh = { title: 'nova', file: 'new.mp3' };
  await s.manager.enqueueMusic('g', [old]);
  assert.equal(s.manager.stopMusic('g'), true);
  await s.manager.enqueueMusic('g', [fresh]);
  speech.resolve();
  await tick();
  assert.equal(s.plays.length, 1);
  assert.equal(s.session.currentTrack, fresh);
  assert.ok(s.processes[0].args.includes('new.mp3'));
  s.plays[0].finish(true);
  await s.session.musicDone;
  assert.equal(s.session.tracks.length, 0);
});

test('pular durante carregamento segue para próxima; shuffle preserva faixa atual', async () => {
  const s = queueSetup(), speech = deferred();
  s.session.speechDone = speech.promise;
  await s.manager.enqueueMusic('g', ['a', 'b', 'c', 'd'].map(title => ({ title, file: title + '.mp3' })));
  assert.equal(s.manager.skipTrack('g'), true);
  speech.resolve();
  await tick();
  assert.equal(s.session.currentTrack.title, 'b');
  s.manager.shuffleTracks('g');
  assert.equal(s.session.tracks[0].title, 'b');
  s.manager.stopMusic('g');
  await s.session.musicDone;
  assert.equal(s.manager.skipTrack('g'), false);
  assert.equal(s.manager.stopMusic('g'), false);
});

test('erro do YouTube fica visível e loop não repete faixa que falhou', async () => {
  const s = queueSetup();
  s.session.loopEnabled = true;
  s.youtube.fail = true;
  await s.manager.enqueueMusic('g', [{ title: 'teste', kind: 'yt', url: 'https://youtube.com/watch?v=test' }]);
  await s.session.musicDone;
  assert.match(s.session.musicError, /vídeo indisponível/);
  assert.equal(s.errors.length, 1);
  assert.equal(s.session.tracks.length, 0);
});

test('resolver prioriza arquivo local, aceita extensão maiúscula e busca nome no YouTube', async () => {
  const searches = [];
  const { resolveTrack } = loadModule('src/music.js', {
    fs: { mkdirSync() {}, readdirSync: () => ['Minha Música.MP3', 'Outro.ogg'] },
    './youtube': { findYouTube: async query => { searches.push(query); return { title: 'encontrada' }; } }
  }, { URL });
  assert.match((await resolveTrack('minha música')).file, /Minha Música\.MP3$/);
  assert.match((await resolveTrack('outro.OGG')).file, /Outro\.ogg$/);
  await resolveTrack('Artista - Canção');
  await resolveTrack('https://music.youtube.com/watch?v=123');
  assert.equal(searches.length, 2);
  assert.equal(searches[0], 'Artista - Canção');
  await assert.rejects(resolveTrack('ausente.mp3'), /pasta musicas/);
  await assert.rejects(resolveTrack('https://youtube.com.evil.example/watch?v=123'), /link do YouTube/);
});

test('download interrompe áudio maior que 30 MB mesmo sem content-length', async () => {
  let closed = false, written = false;
  const { resolveTrack } = loadModule('src/music.js', {
    fs: { promises: { writeFile: async () => { written = true; } } }, './youtube': {}
  }, { URL, fetch: async () => ({ ok: true, headers: { get: () => null }, body: (async function* () {
    try { yield Buffer.alloc(16 * 1024 * 1024); yield Buffer.alloc(16 * 1024 * 1024); }
    finally { closed = true; }
  })() }) });
  await assert.rejects(resolveTrack('https://audio.example/music.mp3'), /30 MB/);
  assert.equal(closed, true);
  assert.equal(written, false);
});
