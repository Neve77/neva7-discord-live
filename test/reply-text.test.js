const test = require('node:test');
const assert = require('node:assert/strict');
const { fitReply, createReplyBuffer } = require('../src/reply-text');

test('resposta longa termina na última frase completa dentro do alvo', () => {
  const text = 'Primeira frase completa. ' + 'Mais detalhes para continuar a explicação '.repeat(20);
  assert.equal(fitReply(text, 100).text, 'Primeira frase completa.');
});

test('primeira frase pode terminar além do alvo sem ser cortada', () => {
  const sentence = 'Uma explicação com palavras suficientes para ultrapassar o alvo sem perder o final da frase.';
  assert.equal(fitReply(sentence + ' Outra frase.', 60).text, sentence);
});

test('texto sem pontuação usa limite absoluto, palavra inteira e reticências', () => {
  const text = 'explicação detalhada '.repeat(150);
  const result = fitReply(text, 1800, 1900).text;
  assert.ok(result.length <= 1900);
  assert.ok(/(?:explicação|detalhada)…$/.test(result));
  assert.ok(text.startsWith(result.slice(0, -1)));
});

test('limite e áudio permanecem iguais com diferentes tamanhos de chunk', () => {
  for (const text of [
    'A primeira frase já explica o necessário. ' + 'Outros detalhes interessantes '.repeat(20) + '.',
    'Uma explicação detalhada '.repeat(8) + '.',
    'palavras para uma frase sem pontuação '.repeat(40)
  ]) {
    for (const size of [1, 7, 53, text.length]) {
      const spoken = [], buffer = createReplyBuffer(100, text => spoken.push(text));
      for (let i = 0; i < text.length; i += size) buffer.push(text.slice(i, i + size));
      const actual = buffer.finish();
      assert.equal(actual, fitReply(text, 100).text.trim());
      assert.equal(spoken.join(' '), actual);
    }
  }
});
