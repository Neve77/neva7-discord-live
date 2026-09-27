const test = require('node:test');
const assert = require('node:assert/strict');
const { messageAccess } = require('../src/message-access');
const base = () => ({
  guild: { id: 'g', roles: [{ id: 'g', permissions: '3072' }, { id: 'role', permissions: '0' }] },
  channel: { id: 'c', guild_id: 'g', type: 0, permission_overwrites: [] },
  member: { user: { id: 'u' }, roles: ['role'] }
});
test('diagnóstico respeita @everyone, cargos agregados e restrição individual', () => {
  const { guild, channel, member } = base();
  assert.equal(messageAccess(guild, channel, member, 'u').canSend, true);
  channel.permission_overwrites.push({ id: 'g', type: 0, deny: '2048', allow: '0' });
  assert.deepEqual(messageAccess(guild, channel, member, 'u').blockers, ['Enviar mensagens']);
  channel.permission_overwrites.push({ id: 'role', type: 0, deny: '0', allow: '2048' });
  assert.equal(messageAccess(guild, channel, member, 'u').canSend, true);
  channel.permission_overwrites.push({ id: 'u', type: 1, deny: '1024', allow: '0' });
  assert.deepEqual(messageAccess(guild, channel, member, 'u').blockers, ['Ver canal']);
});
test('timeout, aceite de regras e canal inadequado aparecem como bloqueios', () => {
  const { guild, channel, member } = base();
  member.communication_disabled_until = new Date(Date.now() + 60000).toISOString(); member.pending = true;
  channel.type = 2;
  const result = messageAccess(guild, channel, member, 'u');
  assert.equal(result.canSend, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.blockers.length, 3);
});
test('administrador e proprietário ignoram sobrescritas; diagnóstico rejeita destino divergente', () => {
  const { guild, channel, member } = base();
  channel.permission_overwrites.push({ id: 'u', type: 1, deny: '3072', allow: '0' });
  guild.owner_id = 'u';
  assert.equal(messageAccess(guild, channel, member, 'u').canSend, true);
  guild.owner_id = 'outro'; guild.roles[1].permissions = '8';
  assert.equal(messageAccess(guild, channel, member, 'u').canSend, true);
  channel.guild_id = 'outro';
  assert.throws(() => messageAccess(guild, channel, member, 'u'), /confirmar as permissões/);
});
