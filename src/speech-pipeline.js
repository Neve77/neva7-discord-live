// Prepara no máximo o trecho atual e o próximo. Só a reprodução é sequencial.
function createSpeechPipeline({ prepare, play, ready, canPlay = () => true, signal, onError = () => {} }) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const entries = [];
  let running = null, initialized = false, closed = false, count = 0, played = false;

  const dispose = () => {
    for (const entry of entries) entry.audio?.dispose();
  };
  combined.addEventListener('abort', dispose, { once: true });
  const cancel = () => controller.abort();
  const warm = () => {
    if (!initialized || combined.aborted) return;
    for (const entry of entries.slice(0, 2)) {
      if (entry.audio) continue;
      entry.audio = prepare(entry.text, combined);
      // O próximo trecho pode falhar enquanto o primeiro ainda está tocando.
      entry.audio.ready.catch(() => {});
    }
  };
  const start = () => {
    if (running || combined.aborted || !entries.length) return;
    running = Promise.resolve().then(async () => {
      await ready;
      initialized = true;
      while (entries.length && !combined.aborted) {
        if (!canPlay()) { cancel(); break; }
        warm();
        const entry = entries[0];
        await entry.audio.ready;
        if (combined.aborted || !canPlay()) { cancel(); break; }
        const result = await play(entry.text, entry.audio, combined);
        if (result === false) { cancel(); break; }
        played = true;
        entry.audio.dispose();
        entries.shift();
      }
    }).catch(error => {
      if (!combined.aborted) onError(error);
      cancel();
    }).finally(() => {
      if (combined.aborted) { dispose(); entries.length = 0; }
      running = null;
      start();
    });
  };
  return {
    enqueue(text) {
      const sentence = String(text || '').trim();
      if (!sentence || closed || combined.aborted) return;
      entries.push({ text: sentence, audio: null });
      count++;
      // start() mantém os erros de preparação dentro da promessa da fila.
      if (running && initialized) {
        try { warm(); } catch (error) { onError(error); cancel(); }
      }
      start();
    },
    async done() {
      closed = true;
      try { while (running) await running; return played; }
      finally { combined.removeEventListener('abort', dispose); }
    },
    cancel,
    get count() { return count; }
  };
}

module.exports = { createSpeechPipeline };
