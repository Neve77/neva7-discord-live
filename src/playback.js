const { AudioPlayerStatus } = require('@discordjs/voice');

// Espera áudio de verdade: Idle inicial ou erro de buffering não são sucesso.
function playResource(player, resource, { signal, startTimeout = 60000, maxDuration = 4 * 60 * 60 * 1000, onPlaying = () => {} } = {}) {
  if (signal?.aborted) { resource.playStream?.destroy(); return Promise.resolve(false); }
  return new Promise((resolve, reject) => {
    let started = false, settled = false, timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      player.off('stateChange', onState);
      player.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (error || !result) player.stop(true);
      if (error) reject(error); else resolve(result);
    };
    const onError = error => finish(error);
    const onAbort = () => finish(null, false);
    const onState = (_, state) => {
      if (state.status === AudioPlayerStatus.Playing && !started) {
        started = true;
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error('Tempo máximo de reprodução atingido.')), maxDuration);
        onPlaying();
      } else if (state.status === AudioPlayerStatus.Idle) {
        finish(started ? null : new Error('O áudio terminou sem começar a tocar.'), started);
      }
    };
    player.on('stateChange', onState);
    player.on('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(new Error('O áudio não começou a tocar. Confira a conexão e a fonte da música.')), startTimeout);
    try { player.play(resource); } catch (error) { finish(error); }
  });
}

module.exports = { playResource };
