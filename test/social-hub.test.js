const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SocialHub } = require('../src/social-hub');

test('hub social guarda memória, momentos, cenas, planos e enquetes por servidor', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neva7-social-'));
  const file = path.join(directory, 'hub.json');
  try {
    const hub = new SocialHub(file);
    const user = { id: 'u1', username: 'Ana' };
    hub.remember('g1', user, 'Prefere jogos cooperativos');
    hub.moment('g1', user, 'O grupo escolheu jogar junto.', 'Decisão');
    hub.scene('g1', 'game');
    hub.plan('g1', user, 'Marcar a próxima partida');
    hub.poll('g1', user, 'Qual jogo?', ['Um', 'Dois']);
    const summary = hub.summary('g1');
    assert.equal(summary.scene.id, 'game');
    assert.equal(summary.people, 1);
    assert.equal(summary.moments[0].title, 'Decisão');
    assert.equal(summary.plans[0].text, 'Marcar a próxima partida');
    assert.deepEqual(summary.polls[0].choices, ['Um', 'Dois']);
    assert.equal(new SocialHub(file).summary('g1').moments.length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
