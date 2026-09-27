// https://docs.discord.com/developers/topics/permissions#permission-overwrites
function messageAccess(guild, channel, member, userId, now = Date.now()) {
  if (channel.guild_id !== guild.id || member.user?.id !== userId || !Array.isArray(guild.roles) || !Array.isArray(member.roles)) {
    throw new Error('Não foi possível confirmar as permissões da conta neste canal.');
  }
  const bits = value => BigInt(value || '0');
  const roleIds = new Set([guild.id, ...member.roles]);
  let permissions = guild.roles.reduce((all, role) => roleIds.has(role.id) ? all | bits(role.permissions) : all, 0n);
  const administrator = guild.owner_id === userId || Boolean(permissions & 8n);
  if (!administrator) {
    const overwrites = channel.permission_overwrites || [];
    const apply = overwrite => { if (overwrite) permissions = permissions & ~bits(overwrite.deny) | bits(overwrite.allow); };
    apply(overwrites.find(o => Number(o.type) === 0 && o.id === guild.id));
    let allow = 0n, deny = 0n;
    for (const overwrite of overwrites) if (Number(overwrite.type) === 0 && overwrite.id !== guild.id && roleIds.has(overwrite.id)) {
      allow |= bits(overwrite.allow); deny |= bits(overwrite.deny);
    }
    permissions = permissions & ~deny | allow;
    apply(overwrites.find(o => Number(o.type) === 1 && o.id === userId));
  }
  const view = administrator || Boolean(permissions & (1n << 10n));
  const send = administrator || Boolean(permissions & (1n << 11n));
  const timedOut = !administrator && Date.parse(member.communication_disabled_until) > now;
  const blockers = [];
  if (!view) blockers.push('Ver canal');
  if (!send) blockers.push('Enviar mensagens');
  if (timedOut) blockers.push('Castigo (timeout) ativo');
  if (member.pending) blockers.push('Aceite das regras do servidor pendente');
  if (![0, 5].includes(channel.type)) blockers.push('Escolha um canal de texto comum ou de anúncios');
  return { channelId: channel.id, guildId: guild.id, accountId: userId, view, send, timedOut, blockers,
    canSend: blockers.length === 0,
    message: blockers.length ? `Envio bloqueado: ${blockers.join('; ')}. Confira a conta conectada em Editar canal → Permissões e as regras do servidor.`
      : 'As permissões de Ver canal e Enviar mensagens estão liberadas. O Discord ainda pode recusar uma mensagem por verificação da conta, AutoMod ou outra restrição.' };
}
module.exports = { messageAccess };
