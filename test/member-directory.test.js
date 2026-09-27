const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MemberDirectory } = require('../src/member-directory');
const { deferred } = require('./helpers');
const member = (i, username = 'ana', nick = 'Apelido', display = 'Ána Lua') => ({
  user: { id: String(100000000000000000n + BigInt(i)), username, global_name: display }, nick
});
function setup(rest, bot = true) {
  const discord = Object.assign(new EventEmitter(), { bot, rest, guildMembers: new Map(), users: new Map() });
  const directory = new MemberDirectory(discord);
  return { directory, discord };
}

test('busca por todos os nomes e acentos não corta em 20 nem descarta o username atrás do apelido', async () => {
  const records = Array.from({ length: 31 }, (_, i) => member(i));
  const { directory } = setup(async route => route.includes('/members?') ? records : []);
  for (const query of ['ana', 'LUA', 'apelido', '@ana']) {
    const result = await directory.search('a', query);
    assert.equal(result.members.length, 31);
    assert.equal(result.complete, true);
    assert.equal(result.warning, '');
    assert.equal(result.members[0].username, 'ana');
  }
});

test('paginação avança pelo maior ID e encontra membros offline da próxima página', async () => {
  const records = Array.from({ length: 1000 }, (_, i) => member(i, 'joao', '', 'João'));
  // Intentionally unordered: Discord defines `after` as highest ID, not last array element.
  records.reverse();
  const paths = [];
  const { directory } = setup(async route => {
    paths.push(route);
    return route.includes('/search?') ? [] : route.includes('&after=') ? [member(1001)] : records;
  });
  const first = await directory.search('a', 'lua');
  assert.equal(first.members.length, 0);
  assert.equal(first.hasMore, true);
  assert.match(first.warning, /Carregar mais/);
  const second = await directory.search('a', 'lua');
  assert.equal(second.members.length, 1);
  assert.equal(second.complete, true);
  assert.equal(second.indexed, 1001);
  assert.ok(paths.includes('/guilds/a/members?limit=1000&after=100000000000000999'));
});

test('ID e menção consultam associação ao servidor e informam membro inexistente', async () => {
  const one = member(1), paths = [];
  const { directory } = setup(async route => {
    paths.push(route);
    if (route.endsWith('/' + one.user.id)) return one;
    throw Object.assign(new Error('Unknown Member'), { code: 404, discordCode: 10007 });
  });
  for (const query of [one.user.id, `<@${one.user.id}>`, `<@!${one.user.id}>`]) {
    assert.equal((await directory.search('a', query)).members[0].id, one.user.id);
  }
  assert.ok(paths.every(path => path === `/guilds/a/members/${one.user.id}`));
  const missing = await directory.search('a', member(2).user.id);
  assert.equal(missing.members.length, 0);
  assert.match(missing.warning, /não está no servidor/);
});

test('fallback é restrito ao servidor e falhas da API continuam visíveis', async () => {
  const { directory, discord } = setup(async () => { throw new Error('Sem acesso (403)'); });
  discord.users.set(member(7).user.id, member(7).user);
  discord.guildMembers.set('other', new Map([[member(8).user.id, member(8)]]));
  discord.guildMembers.set('a', new Map([[member(9).user.id, member(9)]]));
  const result = await directory.search('a', 'ana');
  assert.deepEqual(result.members.map(m => m.id), [member(9).user.id]);
  assert.match(result.warning, /Lista incompleta.*403/);
  assert.match(result.warning, /Busca do Discord indisponível/);
});

test('respostas atrasadas não preenchem o servidor novo e buscas simultâneas dividem a página', async () => {
  const page = deferred(); let lists = 0;
  const { directory } = setup(async route => {
    if (route.includes('/search?')) return [];
    lists++;
    return page.promise;
  });
  const searches = [directory.search('a', 'ana'), directory.search('a', 'lua')];
  const rejected = Promise.all(searches.map(promise => assert.rejects(promise, /servidor ou a lista mudou/)));
  directory.reset('b');
  page.resolve([member(1)]);
  await rejected;
  assert.equal(lists, 1);
  assert.equal(directory.state.members.size, 0);
});

test('conta pessoal informa busca parcial e não tenta endpoint de listagem do bot', async () => {
  const { directory } = setup(async route => { assert.match(route, /\/search\?/); return [member(1)]; }, false);
  const result = await directory.search('a', 'ana');
  assert.equal(result.members.length, 1);
  assert.equal(result.hasMore, false);
  assert.match(result.warning, /bot oficial com Server Members Intent/);
});

test('remoção de membro invalida seleção em cache e alteração atualiza apelido', async () => {
  const { directory, discord } = setup(async () => [member(1)]);
  await directory.search('a', 'ana');
  discord.emit('guildMemberChange', { guildId: 'a', member: member(1, 'novo', 'Novo nome'), removed: false });
  assert.equal(directory.state.members.get(member(1).user.id).name, 'Novo nome');
  discord.emit('guildMemberChange', { guildId: 'a', member: member(1), removed: true });
  assert.equal(directory.state.members.size, 0);
});
