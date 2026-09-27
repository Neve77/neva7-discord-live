// Testa extração, FFmpeg e player sem login nem transmissão para o Discord.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createAudioPlayer, NoSubscriberBehavior } = require('@discordjs/voice');
const { ZeroVoiceManager } = require('../src/voice');
const { resolveTrack } = require('../src/music');

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) throw new Error('Uso: npm run music-check -- "link, nome da música ou caminho do áudio"');
  const track = fs.existsSync(query) ? { title: path.basename(query), file: path.resolve(query), tmp: false } : await resolveTrack(query);
  const manager = new ZeroVoiceManager(new EventEmitter(), async () => {});
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  const session = { player, tracks: [], musicVol: 0.7 };
  manager.active.set('teste-local', session);
  let playbackMs = 0, stopTimer;
  player.on('error', () => {}); // O erro é registrado pela fila e verificado abaixo.
  player.on('stateChange', (oldState, state) => {
    playbackMs = Math.max(playbackMs, oldState.resource?.playbackDuration || 0);
    if (state.status === 'playing') stopTimer = setTimeout(() => manager.stopMusic('teste-local'), 2000);
  });
  try {
    await manager.enqueueMusic('teste-local', [track]);
    await session.musicDone;
    if (session.musicError) throw new Error(session.musicError);
    if (playbackMs < 200) throw new Error('O player não recebeu áudio suficiente.');
    console.log(`OK: ${playbackMs}ms de áudio passaram pelo player local. Nenhuma conexão com uma call.`);
  } finally {
    clearTimeout(stopTimer);
    manager.stopMusic('teste-local');
    player.stop(true);
    manager.active.clear();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
