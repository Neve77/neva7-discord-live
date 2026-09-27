const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { config } = require('./config');
const { makeAdapterCreator } = require('./voice-adapter');
const { getFfmpegPath, hasFfmpeg, runFfmpeg: ff } = require('./ffmpeg');
const { allocateTemp } = require('./cache');
const { openYouTubeStream } = require('./youtube');
const { playResource } = require('./playback');
const { CallRecordings } = require('./call-recordings');
const logger = require('./logger');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType
} = require('@discordjs/voice');
const OpusScript = require('opusscript'); // só p/ DECODIFICAR o que escuta (leve); codificar é o ffmpeg

// Transporte de voz via @discordjs/voice (único jeito com DAVE/E2EE obrigatório desde mar/2026).
// O gateway continua 100% próprio (src/discord.js) — a lib só recebe os pacotes de voz
// através deste adapter custom, igual ela faz com qualquer outra lib.
// Codificação opus é 100% pelo ffmpeg (nativo, com libopus) — zero JS pesado, sem engasgo.

function wavBuffer(pcm, sampleRate = 48000, channels = 2) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// mp3 -> ogg/opus 48k stereo com o ffmpeg (nativo). Volume aplicado aqui (resource Ogg não tem volume inline).
async function fileToOpusOgg(inFile, volume = 1.0) {
  const out = allocateTemp('ogg', 'ogg');
  const args = ['-y', '-loglevel', 'error', '-i', inFile, '-acodec', 'libopus', '-application', 'audio', '-frame_duration', '20', '-ar', '48000', '-ac', '2'];
  if (Math.abs(volume - 1.0) > 0.01 || volume === 0) args.push('-af', `volume=${volume}`);
  args.push(out);
  try { await ff(args); return out; }
  catch (error) { try { fs.unlinkSync(out); } catch {} throw error; }
}

// stream (ex: YouTube) -> ogg/opus ao vivo pelo ffmpeg
function streamToOpusOgg(inputStream, volume = 1.0, options = {}) {
  if (options.pcm) return pcmToOpusOgg(inputStream, { ...(options.audioOptions || {}), volume }).stream;
  const args = ['-analyzeduration', '0', '-loglevel', 'error', '-i', 'pipe:0', '-acodec', 'libopus', '-application', 'audio', '-frame_duration', '20', '-ar', '48000', '-ac', '2'];
  if (Math.abs(volume - 1.0) > 0.01 || volume === 0) args.push('-af', `volume=${volume}`);
  args.push('-f', 'ogg', 'pipe:1');
  const proc = spawn(getFfmpegPath(), args, { windowsHide: true });
  let stderr = '';
  proc.stdout.on('error', () => {});
  proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
  proc.on('error', error => proc.stdout.destroy(error));
  proc.on('close', code => {
    if (code && !proc.killed) proc.stdout.destroy(new Error('FFmpeg: ' + stderr));
  });
  proc.stdin.on('error', error => proc.stdout.destroy(error));
  inputStream.on('error', error => proc.stdout.destroy(error));
  proc.stdout.on('close', () => { inputStream.destroy(); proc.kill(); });
  inputStream.pipe(proc.stdin);
  return proc.stdout;
}

function pcmToOpusOgg(inputStream, { volume = 1, speed = 1, pitch = 0, equalizer = 'flat', denoise = false } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0'];
  const filters = [];
  if (denoise) filters.push('afftdn');
  if (pitch) filters.push(`asetrate=24000*${Math.pow(2, pitch / 12)},aresample=48000`);
  if (speed && Math.abs(speed - 1) > 0.01) filters.push(`atempo=${Math.max(.5, Math.min(2, speed))}`);
  if (equalizer === 'voice') filters.push('highpass=f=90,lowpass=f=12000');
  if (Math.abs(volume - 1) > 0.01 || volume === 0) filters.push(`volume=${volume}`);
  if (filters.length) args.push('-af', filters.join(','));
  args.push('-acodec', 'libopus', '-application', 'voip', '-frame_duration', '20', '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1');
  const proc = spawn(getFfmpegPath(), args, { windowsHide: true });
  let stderr = '';
  proc.stdout.on('error', () => {});
  proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
  proc.on('error', error => proc.stdout.destroy(error));
  proc.on('close', code => { if (code && !proc.killed) proc.stdout.destroy(new Error('FFmpeg: ' + stderr)); });
  proc.stdin.on('error', error => { if (!proc.killed) proc.stdout.destroy(error); });
  inputStream.on('error', error => proc.stdout.destroy(error));
  inputStream.pipe(proc.stdin);
  return { stream: proc.stdout, close: () => { try { inputStream.unpipe(proc.stdin); } catch {} try { proc.kill(); } catch {} } };
}

function fileToOpusStream(inFile, volume = 1.0) {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', inFile, '-acodec', 'libopus', '-application', 'audio', '-frame_duration', '20', '-ar', '48000', '-ac', '2'];
  if (Math.abs(volume - 1.0) > 0.01 || volume === 0) args.push('-af', `volume=${volume}`);
  args.push('-f', 'ogg', 'pipe:1');
  const proc = spawn(getFfmpegPath(), args, { windowsHide: true });
  let stderr = '';
  proc.stdout.on('error', () => {});
  proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
  proc.on('error', error => proc.stdout.destroy(error));
  proc.on('close', code => { if (code && !proc.killed) proc.stdout.destroy(new Error('FFmpeg: ' + stderr)); });
  return { stream: proc.stdout, close: () => { try { proc.kill(); } catch {} } };
}

// energia média do áudio (int16): voz real costuma dar >1000, chiado <300
function rms(pcm) {
  if (pcm.length < 2) return 0;
  let sum = 0, n = 0;
  for (let i = 0; i + 1 < pcm.length; i += 64) { // amostra 1 a cada 32 (rápido e basta)
    const v = pcm.readInt16LE(i);
    sum += v * v;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

class ZeroVoiceManager {
  constructor(discord, onSpeech) {
    this.discord = discord;
    this.onSpeech = onSpeech;
    this.active = new Map(); // guildId -> session
    this.pending = new Map();
    this.liveFactory = null;
    this.recordings = new CallRecordings();
    this.sayText = async () => {}; // index.js injeta o envio p/ canal texto

    discord.on('voiceStateUpdate', (data) => {
      if (data.user_id !== discord.me?.id) return;
      const session = this.active.get(data.guild_id);
      if (session && data.channel_id) session.channelId = data.channel_id;
      if (!data.channel_id) this.leave(data.guild_id);
    });
  }

  setLiveFactory(factory) {
    this.liveFactory = typeof factory === 'function' ? factory : null;
    if (!this.liveFactory) return null;
    for (const [guildId, session] of this.active) {
      if (!session.live) session.live = this.liveFactory(guildId, session);
    }
    return this.liveFactory;
  }

  join(guildId, channelId) {
    const pending = this.pending.get(guildId);
    if (pending) {
      if (pending.channelId === channelId) return pending.promise;
      return pending.promise.catch(() => {}).then(() => this.join(guildId, channelId));
    }
    const current = this.active.get(guildId);
    if (current?.channelId === channelId && current.connection.state.status === VoiceConnectionStatus.Ready) {
      return Promise.resolve(current);
    }
    this.leave(guildId);
    const entry = { channelId, connection: null, promise: null };
    this.pending.set(guildId, entry);
    entry.promise = this.connect(guildId, channelId, entry).finally(() => {
      if (this.pending.get(guildId) === entry) this.pending.delete(guildId);
    });
    return entry.promise;
  }

  async connect(guildId, channelId, entry) {
    console.log('[voz] entrando na call...');
    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: makeAdapterCreator(this.discord, guildId),
      selfDeaf: false,
      selfMute: false
    });
    entry.connection = connection;
    connection.on('error', (e) => console.log('[voz] conn erro:', e.message));
    connection.on(VoiceConnectionStatus.Disconnected, () => console.log('[voz] desconectado'));
    connection.on(VoiceConnectionStatus.Connecting, () => console.log('[voz] conectando...'));
    connection.on(VoiceConnectionStatus.Signalling, () => console.log('[voz] sinalizando...'));
    connection.on(VoiceConnectionStatus.Ready, () => console.log('[voz] pronto!'));

    console.log('[voz] aguardando estado Ready...');
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 25000);
    } catch (e) {
      console.error('[voz] timeout ao conectar:', e.message);
      console.log('[voz] estado atual:', connection.state.status);
      // tenta destruir a conexão morta
      try { connection.destroy(); } catch {}
      throw new Error('não consegui conectar a voz. Confira as permissões Conectar/Falar e a conexão de rede.');
    }

    if (this.pending.get(guildId) !== entry) {
      try { connection.destroy(); } catch {}
      throw new Error('entrada na call cancelada');
    }
    const player = createAudioPlayer();
    player.on('error', (e) => console.log('[voz] player erro:', e.message));
    connection.subscribe(player);

    const session = {
      connection,
      player,
      channelId,
      playing: false,
      busy: false,
      speechQueue: [],
      tracks: [],
      musicLoop: false,
      musicBusy: false,
      speechVol: 1.0,
      musicVol: 0.7,
      deaf: false, // !muta liga: fica na call mas só responde texto
      selfId: this.discord.me.id,
      decoders: new Map(),
      captures: new Map(),
      pendingSpeech: [],
      responseTask: null,
      responseAbort: null,
      responseUserId: null,
      musicState: 'parada',
      musicError: '',
      musicGeneration: 0
    };
    this.active.set(guildId, session);
    if (this.liveFactory) {
      session.live = this.liveFactory(guildId, session);
    }
    connection.once(VoiceConnectionStatus.Destroyed, () => {
      if (this.active.get(guildId) === session) this.leave(guildId);
    });
    this.startListening(guildId, session);
    console.log('[voz] conectado na call (com DAVE/E2EE)');
    return session;
  }

  startListening(guildId, session) {
    const receiver = session.connection.receiver;
    if (!receiver || !receiver.speaking || typeof receiver.speaking.on !== 'function') {
      console.log('[voz] receiver sem speaking — escuta indisponível, só falo');
      return;
    }
    receiver.speaking.on('start', (userId) => {
      if (this.active.get(guildId) !== session || session.deaf) return;
      if (userId === session.selfId) return;
      if (session.busy) return;
      this.capture(guildId, session, userId).catch(e => console.error('[voz] captura:', e.message));
    });
    console.log('[voz] escutando a call...');
  }

  async capture(guildId, session, userId) {
    if (this.active.get(guildId) !== session) return;
    const existing = session.captures.get(userId);
    if (existing) return existing.task;
    const live = session.live;
    const liveEnabled = Boolean(live && !live.paused && !session.deaf);
    const recordOnly = !liveEnabled && (session.deaf || live?.paused);
    const activeAiCaptures = [...session.captures.values()].filter(item => !item.recordOnly).length;
    if (liveEnabled && activeAiCaptures >= (live.options?.maxParticipants || 8)) return;
    const stream = session.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: live?.options?.incompleteMs || config.silenceMs || 1800 }
    });
    const decoder = session.decoders.get(userId) || new OpusScript(16000, 1);
    session.decoders.set(userId, decoder);
    const state = { stream, decoder, chunks: [], bytes: 0, voicedBytes: 0, interrupted: false, recordOnly, task: null };
    session.captures.set(userId, state);
    state.task = new Promise(resolve => {
      const maxSeconds = live?.options?.maxUtteranceSeconds || config.maxVoiceSeconds || 15;
      const timer = setTimeout(() => { try { stream.destroy(); } catch {} resolve(); }, maxSeconds * 1000);
      timer.unref?.();
      const finish = () => { clearTimeout(timer); resolve(); };
      stream.on('data', packet => {
        let pcm;
        try { pcm = Buffer.from(decoder.decode(packet)); } catch { return; }
        if (!pcm.length || pcm.length % 2) return;
        if (this.recordings?.isActive(guildId)) {
          const name = this.discord.users?.get(userId)?.global_name || this.discord.users?.get(userId)?.username || userId;
          this.recordings.capture(guildId, userId, name, pcm);
        }
        if (liveEnabled && !live.paused && !session.deaf) live.ingest(userId, pcm);
        if (!live && !recordOnly) { state.chunks.push(pcm); state.bytes += pcm.length; }
        state.voicedBytes = rms(pcm) >= 300 ? state.voicedBytes + pcm.length : 0;
        if (!state.interrupted && state.voicedBytes >= 16000 * 2 * 0.3) {
          state.interrupted = this.interruptForSpeaker(session, userId);
        }
      });
      stream.once('end', finish); stream.once('error', finish); stream.once('close', finish);
    }).then(() => {
      if (this.active.get(guildId) !== session || live || recordOnly || state.bytes < 3200) return;
      const pcm = Buffer.concat(state.chunks);
      if (rms(pcm) >= 300) this.queueSpeech(guildId, session, { userId, pcm, endedAt: Date.now() });
    }).finally(() => {
      try { stream.destroy(); } catch {}
      if (session.captures.get(userId) === state) session.captures.delete(userId);
    });
    return state.task;
  }

  interruptForSpeaker(session, userId) {
    const owner = String(process.env.OWNER_ID || '').trim();
    if (session.responseUserId && userId !== session.responseUserId && userId !== owner) return false;
    if (session.responseUserId && userId === owner && userId !== session.responseUserId) session.prioritySpeaker = userId;
    let stopped = false;
    for (const key of ['responseAbort', 'synthesisAbort', 'speechAbort']) {
      const controller = session[key];
      if (controller && !controller.signal?.aborted) { controller.abort(); stopped = true; }
    }
    if (session.playing || stopped) {
      session.speechQueue = [];
      try { session.player.stop(true); } catch {}
      stopped = true;
    }
    return stopped;
  }

  queueSpeech(guildId, session, item) {
    if (!item?.userId || !Buffer.isBuffer(item.pcm) || Date.now() - item.endedAt > 8000) return false;
    const owner = String(process.env.OWNER_ID || '').trim();
    const existing = session.pendingSpeech.findIndex(entry => entry.userId === item.userId);
    if (existing >= 0) session.pendingSpeech[existing] = item;
    else if (item.userId === owner) {
      if (session.prioritySpeaker === item.userId) session.prioritySpeaker = null;
      session.pendingSpeech.unshift(item);
      if (session.pendingSpeech.length > 3) session.pendingSpeech.pop();
    } else if (session.pendingSpeech.length < 2) session.pendingSpeech.unshift(item);
    if (!session.responseTask) this.drainSpeech(guildId, session);
    return true;
  }

  drainSpeech(guildId, session) {
    if (session.responseTask || this.active.get(guildId) !== session) return session.responseTask;
    session.pendingSpeech = session.pendingSpeech.filter(item => Date.now() - item.endedAt <= 8000);
    if (session.prioritySpeaker && !session.pendingSpeech.some(item => item.userId === session.prioritySpeaker)) return null;
    const item = session.pendingSpeech.shift();
    if (!item) return null;
    const abort = new AbortController();
    session.responseAbort = abort; session.responseUserId = item.userId;
    const wavPath = allocateTemp('heard', 'wav');
    fs.writeFileSync(wavPath, wavBuffer(item.pcm, 16000, 1));
    const task = Promise.resolve().then(() => this.onSpeech(item.userId, wavPath, guildId, { abort }))
      .catch(error => { if (!abort.signal.aborted) console.error('[voz] erro onSpeech:', error.message); })
      .finally(() => {
        try { fs.unlinkSync(wavPath); } catch {}
        if (session.responseAbort === abort) session.responseAbort = null;
        if (session.responseUserId === item.userId) session.responseUserId = null;
        if (session.responseTask === task) session.responseTask = null;
        this.drainSpeech(guildId, session);
      });
    session.responseTask = task;
    return task;
  }

  startRecording(guildId) {
    const session = this.active.get(guildId);
    if (!session) throw new Error('Entre em uma call antes de gravar.');
    return this.recordings.start(guildId, session.channelId);
  }

  stopRecording(guildId, reason = 'operator') {
    return this.recordings.stop(guildId, reason);
  }

  recordPlayback(guildId, session, resource) {
    if (!resource || typeof resource.read !== 'function' || resource._recordingWrapped) return resource;
    resource._recordingWrapped = true;
    const original = resource.read.bind(resource);
    let ended = false;
    resource.playStream?.once?.('end', () => { ended = true; });
    resource.playStream?.once?.('close', () => { ended = true; });
    resource.read = (...args) => {
      const pcm = original(...args);
      if (!ended && Buffer.isBuffer(pcm) && pcm.length && this.recordings?.isActive(guildId)) {
        const id = session.selfId || this.discord.me?.id || 'bot';
        const name = this.discord.me?.username || 'Neva7';
        this.recordings.capture(guildId, id, name, pcm, { bot: true });
      }
      return pcm;
    };
    return resource;
  }

  async playPcmStream(guildId, stream, { signal, onPlaying = () => {}, audioOptions = {}, maxDuration = 30000 } = {}) {
    const session = this.active.get(guildId);
    if (!session) throw new Error('não tô em call');
    if (signal?.aborted) return false;
    if (stream == null || typeof stream.on !== 'function' || typeof stream.pipe !== 'function') {
      throw new Error('stream PCM inválida');
    }
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    session.speechAbort?.abort(); session.speechAbort = abort;
    const encoded = pcmToOpusOgg(stream, audioOptions);
    const resource = createAudioResource(encoded.stream, { inputType: StreamType.OggOpus });
    this.recordPlayback(guildId, session, resource);
    const timer = setTimeout(() => abort.abort(), maxDuration + 5000); timer.unref?.();
    try {
      session.player.play(resource);
      await entersState(session.player, AudioPlayerStatus.Playing, 15000);
      if (!abort.signal.aborted) onPlaying();
      await entersState(session.player, AudioPlayerStatus.Idle, Math.max(15000, maxDuration + 5000));
      return !abort.signal.aborted;
    } catch (error) {
      if (abort.signal.aborted || signal?.aborted) return false;
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel); encoded.close();
      if (session.speechAbort === abort) session.speechAbort = null;
    }
  }

  async playFile(guildId, mp3Path) {
    return this.playFiles(guildId, [mp3Path]);
  }

  // toca vários mp3 em sequência; cada um é convertido p/ ogg/opus NATIVO antes (sem engasgo)
  async playFiles(guildId, mp3s, { signal, onPlaying = () => {} } = {}) {
    const session = this.active.get(guildId);
    if (!session) throw new Error('não tô em call');
    if (session.playing) return;
    getFfmpegPath();
    session.playing = true;
    session.speechQueue = mp3s.slice();
    const oggs = [];
    try {
      while (session.speechQueue.length && this.active.get(guildId) === session) {
        const file = session.speechQueue.shift();
        const ogg = await fileToOpusOgg(file, session.speechVol ?? 1.0);
        oggs.push(ogg);
        if (this.active.get(guildId) !== session) break;
        const resource = createAudioResource(ogg, { inputType: StreamType.OggOpus });
        this.recordPlayback(guildId, session, resource);
        session.player.play(resource);
        await entersState(session.player, AudioPlayerStatus.Playing, 15000);
        if (!signal?.aborted) onPlaying();
        await entersState(session.player, AudioPlayerStatus.Idle, 45000);
        if (signal?.aborted) return false;
      }
      return true;
    } finally {
      session.playing = false;
      session.speechQueue = [];
      for (const o of oggs) { try { fs.unlinkSync(o); } catch {} }
    }
  }

  // ---- música ----
  musicQueue(guildId) {
    const s = this.active.get(guildId);
    return s ? (s.tracks || []) : [];
  }

  async enqueueMusic(guildId, tracks) {
    const session = this.active.get(guildId);
    if (!session) throw new Error('não tô em call');
    if (!Number.isInteger(session.musicGeneration)) session.musicGeneration = 0;
    session.tracks = (session.tracks || []).concat(tracks);
    session.musicError = '';
    if (!session.musicDone || session.musicTaskGeneration !== session.musicGeneration) {
      const generation = ++session.musicGeneration;
      session.musicTaskGeneration = generation;
      const task = this.pumpMusic(guildId, session, generation)
        .catch(error => { session.musicError = error.message; console.error('[musica] erro:', error.message); })
        .finally(() => {
          if (session.musicDone === task) {
            session.musicDone = null; session.musicLoop = false; session.musicBusy = false; session.currentTrack = null;
            if (!session.tracks.length) session.musicState = 'parada';
          }
        });
      session.musicDone = task;
    }
    return session.tracks.length;
  }

  async pumpMusic(guildId, session, generation) {
    session.musicLoop = true;
    while (session.tracks.length && this.active.get(guildId) === session && session.musicGeneration === generation) {
      if (session.speechDone) await Promise.resolve(session.speechDone).catch(() => {});
      if (session.musicGeneration !== generation || !session.tracks.length) break;
      const track = session.tracks[0];
      const abort = new AbortController(); session.musicAbort = abort;
      session.currentTrack = track; session.musicBusy = true; session.musicState = 'carregando';
      let source, encoded, played = false;
      try {
        console.log('[musica] tocando:', track.title);
        if (track.kind === 'yt') {
          source = openYouTubeStream(track.url);
          const stream = streamToOpusOgg(source, session.musicVol ?? 0.7);
          encoded = { stream, close: () => { try { source.destroy(); } catch {} try { stream.destroy(); } catch {} } };
        } else encoded = fileToOpusStream(track.file, session.musicVol ?? 0.7);
        if (abort.signal.aborted || session.musicGeneration !== generation) continue;
        const resource = createAudioResource(encoded.stream, { inputType: StreamType.OggOpus });
        played = await playResource(session.player, resource, {
          signal: abort.signal,
          onPlaying: () => { session.musicState = 'tocando'; },
          maxDuration: 15 * 60 * 1000
        });
        if (!played && !abort.signal.aborted) throw new Error('A reprodução não começou.');
      } catch (error) {
        if (!abort.signal.aborted) {
          session.musicError = error.message || 'Falha ao reproduzir a música.';
          logger.music?.error?.(track.title, session.musicError.slice(0, 150));
        }
      } finally {
        encoded?.close();
        if (session.musicAbort === abort) session.musicAbort = null;
        const stillCurrent = session.tracks[0] === track;
        if (stillCurrent) {
          session.tracks.shift();
          if (played && session.loopEnabled && !track.tmp && session.musicGeneration === generation) session.tracks.push(track);
        }
        if (track.tmp) { try { fs.unlinkSync(track.file); } catch {} }
        session.currentTrack = null;
      }
    }
  }

  skipTrack(guildId) {
    const s = this.active.get(guildId);
    if (!s || (!s.currentTrack && !s.tracks?.length)) return false;
    if (!s.currentTrack && s.tracks.length) s.tracks.shift();
    s.musicAbort?.abort();
    try { s.player.stop(true); } catch {}
    return true;
  }

  stopMusic(guildId) {
    const s = this.active.get(guildId);
    if (!s || (!s.currentTrack && !s.tracks?.length && !s.musicDone)) return false;
    s.musicGeneration++;
    s.tracks = [];
    s.musicAbort?.abort();
    try { s.player.stop(true); } catch {}
    s.musicState = 'parada'; s.currentTrack = null;
    return true;
  }

  setVolumes(guildId, { speech, music }) {
    const s = this.active.get(guildId);
    if (!s) return false;
    if (speech != null) s.speechVol = Math.max(0, Math.min(2, speech));
    if (music != null) s.musicVol = Math.max(0, Math.min(2, music));
    return true;
  }

  setListen(guildId, on) {
    const s = this.active.get(guildId);
    if (!s) return false;
    s.deaf = !on;
    s.live?.pause?.(!on);
    if (!on && !this.recordings?.isActive(guildId)) {
      for (const capture of s.captures?.values() || []) { try { capture.stream.destroy(); } catch {} }
    }
    return true;
  }

  shuffleTracks(guildId) {
    const s = this.active.get(guildId);
    if (!s || !s.tracks?.length) return false;
    // embaralha a fila (Fisher-Yates)
    const start = s.currentTrack && s.tracks[0] === s.currentTrack ? 1 : 0;
    for (let i = s.tracks.length - 1; i > start; i--) {
      const j = start + Math.floor(Math.random() * (i - start + 1));
      [s.tracks[i], s.tracks[j]] = [s.tracks[j], s.tracks[i]];
    }
    return true;
  }

  toggleLoop(guildId) {
    const s = this.active.get(guildId);
    if (!s) return null;
    s.loopEnabled = !s.loopEnabled;
    return s.loopEnabled;
  }

  // compat com index.js (usa guildId atual da sessão quando chamado sem)
  leave(guildId) {
    const pending = this.pending.get(guildId);
    this.pending.delete(guildId);
    if (pending?.connection) {
      try { pending.connection.destroy(); } catch {}
    }
    const session = this.active.get(guildId);
    if (!session) return;
    this.active.delete(guildId);
    session.musicGeneration++;
    for (const key of ['responseAbort', 'synthesisAbort', 'speechAbort', 'musicAbort']) session[key]?.abort?.();
    session.speechQueue = [];
    session.pendingSpeech = [];
    for (const capture of session.captures?.values() || []) { try { capture.stream.destroy(); } catch {} }
    session.captures?.clear();
    session.live?.close?.();
    this.recordings?.stop?.(guildId, 'left-call');
    for (const track of session.tracks) {
      if (track.tmp) { try { fs.unlinkSync(track.file); } catch {} }
    }
    session.tracks = [];
    try { session.killPipe?.(); } catch {}
    for (const subscription of session.connection.receiver?.subscriptions?.values() || []) subscription.destroy();
    try { session.player.stop(true); } catch {}
    try { session.connection.destroy(); } catch {}
    for (const decoder of session.decoders?.values() || []) { try { decoder.delete(); } catch {} }
    session.decoders?.clear();
  }

  get(guildId) {
    const s = this.active.get(guildId);
    if (!s) return undefined;
    // expõe playFile bound como antes (sayInVoice usa conn.playFile(mp3))
    if (!s._bound) {
      s._bound = true;
      const mgr = this;
      s.playFile = (mp3) => mgr.playFile(guildId, mp3);
    }
    return s;
  }
}

module.exports = { ZeroVoiceManager, hasFfmpeg, streamToOpusOgg };
