const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { config } = require('./config');
const { makeAdapterCreator } = require('./voice-adapter');
const { getFfmpegPath, hasFfmpeg, runFfmpeg: ff } = require('./ffmpeg');
const { allocateTemp } = require('./cache');
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
  const args = ['-y', '-loglevel', 'error', '-i', inFile, '-acodec', 'libopus', '-application', 'voip', '-ar', '48000', '-ac', '2'];
  if (Math.abs(volume - 1.0) > 0.01) args.push('-af', `volume=${volume}`);
  args.push(out);
  try { await ff(args); return out; }
  catch (error) { try { fs.unlinkSync(out); } catch {} throw error; }
}

// stream (ex: YouTube) -> ogg/opus ao vivo pelo ffmpeg
function streamToOpusOgg(inputStream, volume = 1.0) {
  const args = ['-analyzeduration', '0', '-loglevel', 'error', '-i', 'pipe:0', '-acodec', 'libopus', '-application', 'audio', '-ar', '48000', '-ac', '2'];
  if (Math.abs(volume - 1.0) > 0.01) args.push('-af', `volume=${volume}`);
  args.push('-f', 'ogg', 'pipe:1');
  const proc = spawn(getFfmpegPath(), args, { windowsHide: true });
  let stderr = '';
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
      decoder: new OpusScript(48000, 2)
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
    if (session.deaf) return; // modo !muta: só texto
    // barge-in: se ela tava falando e alguém começou, ela cala a boca igual gente
    if (session.playing) { session.speechQueue = []; try { session.player.stop(); } catch {} }
    session.busy = true;
    return (async () => {
      const opus = session.connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: config.silenceMs || 1800 }
      });
      const chunks = [];
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, (config.maxVoiceSeconds || 15) * 1000); // trava de segurança
        opus.on('data', (c) => {
          try {
            const pcm = session.decoder.decode(c);
            if (pcm && pcm.length) chunks.push(Buffer.from(pcm));
          } catch {}
        });
        const fin = () => { clearTimeout(timer); resolve(); };
        opus.on('end', fin);
        opus.on('error', fin);
        opus.on('close', fin);
      });
      try { opus.destroy(); } catch {}
      if (this.active.get(guildId) !== session) return;
      const pcm = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
      if (pcm.length < 48000) return; // curto demais (~0.25s, precisa de pelo menos "oi thalita")
      if (rms(pcm) < 300) { console.log('[voz] áudio fraco demais (só ruído), ignorando'); return; }
      const wavPath = allocateTemp('heard', 'wav');
      fs.writeFileSync(wavPath, wavBuffer(pcm));
      try { await this.onSpeech(userId, wavPath, guildId); }
      catch (e) { console.error('[voz] erro onSpeech:', e.message); }
      finally { try { fs.unlinkSync(wavPath); } catch {} }
    })().finally(() => { session.busy = false; });
  }

  async playPcmStream(guildId, stream, { signal, onPlaying = () => {}, audioOptions = {}, maxDuration = 30000 } = {}) {
    const session = this.active.get(guildId);
    if (!session) throw new Error('não tô em call');
    if (signal?.aborted) return false;
    if (stream == null || typeof stream.on !== 'function' || typeof stream.pipe !== 'function') {
      throw new Error('stream PCM inválida');
    }
    const pcm = [];
    let total = 0;
    let ended = false;
    let aborted = false;
    const maxSamples = Math.max(1, Math.floor((maxDuration || 30000) / 1000 * 48000 * 2));
    const cleanup = () => { if (signal) signal.removeEventListener?.('abort', onAbort); };
    const onAbort = () => { aborted = true; cleanup(); try { stream.destroy(); } catch {} };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const done = new Promise((resolve, reject) => {
      const fail = (error) => { cleanup(); reject(error); };
      const onData = (chunk) => {
        if (aborted || signal?.aborted) { cleanup(); return; }
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!buf.length) return;
        total += buf.length;
        if (total > maxSamples) { cleanup(); reject(new Error('áudio PCM excedeu o limite da resposta')); return; }
        pcm.push(buf);
      };
      const onEnd = () => { ended = true; cleanup(); resolve(true); };
      const onError = (error) => { cleanup(); reject(error); };
      stream.on('data', onData);
      stream.on('end', onEnd);
      stream.on('close', () => { if (!ended && !aborted) resolve(false); });
      stream.on('error', onError);
    });
    try {
      const started = new Promise((resolve) => {
        const onStart = () => { if (!aborted && !signal?.aborted) { onPlaying(); resolve(); } };
        stream.once('data', onStart);
        setTimeout(() => resolve(), 50);
      });
      await Promise.race([started, done]);
      if (signal?.aborted || aborted) return false;
      const buffer = Buffer.concat(pcm);
      if (!buffer.length) return false;
      const ogg = await fileToOpusOgg(wavBuffer(buffer, 48000, 2), audioOptions.volume ?? 1.0);
      try {
        const resource = createAudioResource(ogg, { inputType: StreamType.OggOpus });
        session.player.play(resource);
        await entersState(session.player, AudioPlayerStatus.Playing, 15000);
        await entersState(session.player, AudioPlayerStatus.Idle, Math.max(15000, maxDuration + 5000));
        return true;
      } finally {
        try { fs.unlinkSync(ogg); } catch {}
      }
    } catch (error) {
      if (signal?.aborted || aborted) return false;
      throw error;
    }
  }

  async playFile(guildId, mp3Path) {
    return this.playFiles(guildId, [mp3Path]);
  }

  // toca vários mp3 em sequência; cada um é convertido p/ ogg/opus NATIVO antes (sem engasgo)
  async playFiles(guildId, mp3s) {
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
        session.player.play(resource);
        await entersState(session.player, AudioPlayerStatus.Playing, 15000);
        await entersState(session.player, AudioPlayerStatus.Idle, 45000);
      }
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
    session.tracks = (session.tracks || []).concat(tracks);
    if (!session.musicLoop) this.pumpMusic(guildId, session).catch(e => console.error('[musica] erro:', e.message));
    return session.tracks.length;
  }

  async pumpMusic(guildId, session) {
    session.musicLoop = true;
    try {
      while (session.tracks.length && this.active.has(guildId)) {
        const t = session.tracks[0];
        session.musicBusy = true;
        session.killPipe = null;
        try {
          console.log('[musica] tocando:', t.title);
          let resource;
          let oggFile = null;
          if (t.kind === 'yt') {
            const play = require('play-dl');
            const s = await play.stream(t.url);
            t._s = s;
            const ff = streamToOpusOgg(s.stream, session.musicVol ?? 0.7);
            session.killPipe = () => { try { s.stream.destroy(); } catch {} try { ff.destroy(); } catch {} };
            resource = createAudioResource(ff, { inputType: StreamType.OggOpus });
          } else {
            oggFile = await fileToOpusOgg(t.file, session.musicVol ?? 0.7);
            resource = createAudioResource(oggFile, { inputType: StreamType.OggOpus });
          }
          session.player.play(resource);
          await entersState(session.player, AudioPlayerStatus.Idle, 15 * 60 * 1000).catch(() => {});
          if (oggFile) { try { fs.unlinkSync(oggFile); } catch {} }
        } catch (e) {
          console.error('[musica] falhou:', t.title, (e.message || '').slice(0, 150));
          if (/410|403|429|player|stream|url|sign|token|ffmpeg/i.test(e.message || '')) {
            try { await this.sayText(guildId, '⚠️ Não consegui tocar (YouTube barrou ou ffmpeg falhou). Baixa o áudio em .mp3 e manda com `!toca` anexando o arquivo.'); } catch {}
          }
        } finally {
          // loop: move pro final da fila em vez de remover
          if (session.loopEnabled && !t.tmp) {
            session.tracks.push(session.tracks.shift());
          } else {
            session.tracks.shift();
          }
          try { if (session.killPipe) session.killPipe(); } catch {}
          session.killPipe = null;
          try { if (t._s) t._s.stream.destroy(); } catch {}
          try { if (t.tmp) fs.unlinkSync(t.file); } catch {}
        }
      }
    } finally {
      session.musicLoop = false;
      session.musicBusy = false;
    }
  }

  skipTrack(guildId) {
    const s = this.active.get(guildId);
    if (!s) return false;
    try { if (s.killPipe) s.killPipe(); } catch {}
    try { s.player.stop(); } catch {}
    return true;
  }

  stopMusic(guildId) {
    const s = this.active.get(guildId);
    if (!s) return false;
    s.tracks = [];
    try { if (s.killPipe) s.killPipe(); } catch {}
    try { s.player.stop(); } catch {}
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
    return true;
  }

  shuffleTracks(guildId) {
    const s = this.active.get(guildId);
    if (!s || !s.tracks?.length) return false;
    // embaralha a fila (Fisher-Yates)
    for (let i = s.tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
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
    session.speechQueue = [];
    for (const track of session.tracks) {
      if (track.tmp) { try { fs.unlinkSync(track.file); } catch {} }
    }
    session.tracks = [];
    try { session.killPipe?.(); } catch {}
    for (const subscription of session.connection.receiver?.subscriptions?.values() || []) subscription.destroy();
    try { session.player.stop(true); } catch {}
    try { session.connection.destroy(); } catch {}
    try { session.decoder.delete(); } catch {}
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

module.exports = { ZeroVoiceManager, hasFfmpeg };
