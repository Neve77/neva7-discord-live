// O limite é um alvo: uma primeira frase longa pode terminar até o dobro dele.
// Sem pontuação nesse espaço, corta numa palavra e sinaliza com reticências.
function fitReply(text, limit, hardLimit = limit * 2) {
  const value = String(text || '');
  if (value.length <= limit) return { text: value, done: false };
  const ends = [...value.slice(0, hardLimit + 1).matchAll(/[.!?…](?=\s|$)/g)].map(match => match.index + 1);
  const within = ends.filter(end => end <= limit);
  const end = within.at(-1) || ends.find(end => end <= hardLimit);
  if (end) return { text: value.slice(0, end), done: true };
  if (value.length <= hardLimit) return { text: value, done: false };
  const prefix = value.slice(0, hardLimit - 1);
  const space = prefix.lastIndexOf(' ');
  return { text: prefix.slice(0, space > 0 ? space : prefix.length).trimEnd() + '…', done: true };
}

function takeCompletedSentence(buffer, first = false) {
  let match = buffer.match(/^\s*([\s\S]*?[.!?…])(?=\s|$)/);
  if (first) {
    const pause = buffer.match(/^\s*([\s\S]{47,}?[,;:])(?=\s|$)/);
    if (pause && (!match || pause[0].length < match[0].length)) match = pause;
    if (!match && buffer.length >= 120) {
      const boundary = buffer.lastIndexOf(' ', 100);
      if (boundary >= 48) return { sentence: buffer.slice(0, boundary).trim(), rest: buffer.slice(boundary).trimStart() };
    }
  }
  if (!match) return null;
  return { sentence: match[1].trim(), rest: buffer.slice(match[0].length).trimStart() };
}

function createReplyBuffer(limit, onSentence = () => {}, hardLimit = limit * 2) {
  let raw = '', value = '', consumed = 0, emitted = false, done = false;
  const flush = final => {
    let part;
    while ((part = takeCompletedSentence(value.slice(consumed), !emitted))) {
      consumed = value.length - part.rest.length;
      emitted = true;
      onSentence(part.sentence);
    }
    if (final && value.slice(consumed).trim()) {
      const tail = value.slice(consumed).trim();
      consumed = value.length;
      onSentence(tail);
    }
  };
  return {
    push(piece) {
      if (done) return;
      raw += String(piece).slice(0, Math.max(0, hardLimit + 1 - raw.length));
      ({ text: value, done } = fitReply(raw, limit, hardLimit));
      flush(done);
    },
    finish() { done = true; flush(true); return value.trim(); },
    get done() { return done; }
  };
}

module.exports = { fitReply, createReplyBuffer };
