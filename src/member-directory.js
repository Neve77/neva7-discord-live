const normalize = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
const memberView = member => {
  const user = member?.user;
  if (!/^\d{16,20}$/.test(String(user?.id || ''))) return null;
  return { id: user.id, name: member.nick || user.global_name || user.username || 'Membro',
    username: user.username || '', displayName: user.global_name || '', nickname: member.nick || '' };
};

class MemberDirectory {
  constructor(discord) {
    this.discord = discord;
    discord.on?.('guildMemberChange', ({ guildId, member, removed }) => {
      if (this.state?.guildId !== guildId) return;
      if (removed) this.state.members.delete(member.user?.id);
      else this.remember(this.state, member);
    });
  }

  reset(guildId) {
    this.state = { guildId, members: new Map(), after: '', complete: false, indexed: 0, pending: null,
      created: Date.now(), retryAt: 0, indexWarning: '' };
  }

  assertCurrent(state) {
    if (this.state !== state) throw new Error('O servidor ou a lista mudou durante a busca. Busque a pessoa novamente.');
  }

  remember(state, member) {
    const view = memberView(member);
    if (view) state.members.set(view.id, view);
    return view;
  }

  async indexPage(state) {
    if (state.complete || Date.now() < state.retryAt || !this.discord.bot) return;
    if (state.pending) return state.pending;
    state.pending = (async () => {
      try {
        const page = await this.discord.rest(`/guilds/${state.guildId}/members?limit=1000${state.after ? `&after=${state.after}` : ''}`);
        this.assertCurrent(state);
        if (!Array.isArray(page)) throw new Error('O Discord não retornou uma lista de membros.');
        for (const member of page) this.remember(state, member);
        const next = page.reduce((id, m) => /^\d{16,20}$/.test(m.user?.id || '') && BigInt(m.user.id) > BigInt(id || '0') ? m.user.id : id, state.after);
        if (page.length >= 1000 && next === state.after) throw new Error('O Discord repetiu a página de membros. Tente novamente em um minuto.');
        state.after = next;
        state.indexed += page.length;
        state.complete = page.length < 1000;
        state.indexWarning = '';
        state.retryAt = 0;
      } catch (error) {
        this.assertCurrent(state);
        state.indexWarning = `Lista incompleta: ${error.message}`;
        state.retryAt = Date.now() + 60000;
      }
    })();
    try { await state.pending; } finally { state.pending = null; }
  }

  async search(guildId, query) {
    const raw = String(query || '').trim();
    if (raw.length < 2) throw new Error('Digite ao menos 2 letras ou cole o ID da pessoa.');
    if (raw.length > 80) throw new Error('A busca pode ter no máximo 80 caracteres.');
    if (this.state?.guildId !== guildId || Date.now() - this.state.created > 300000) this.reset(guildId);
    const state = this.state;
    state.created = Date.now(); // Expire idle searches without losing progress while paging a large guild.
    const id = /^(?:<@!?(\d{16,20})>|(\d{16,20}))$/.exec(raw)?.slice(1).find(Boolean);
    if (id) {
      let member;
      try { member = await this.discord.rest(`/guilds/${guildId}/members/${id}`); }
      catch (error) {
        this.assertCurrent(state);
        if (error.discordCode !== 10007) throw error;
        state.members.delete(id);
        return { guildId, query: raw, members: [], hasMore: false, warning: 'Esta pessoa não está no servidor selecionado.', total: 0 };
      }
      this.assertCurrent(state);
      const view = this.remember(state, member);
      if (!view || view.id !== id) throw new Error('Não foi possível confirmar esta pessoa no servidor.');
      return { guildId, query: raw, members: [view], hasMore: false, warning: '', total: 1 };
    }

    const term = raw.replace(/^@/, '');
    if (term.length < 2) throw new Error('Digite ao menos 2 letras depois do @.');
    let searchWarning = '', remoteFull = false;
    // A page per search keeps large guilds responsive. "Load more" continues after the last ID.
    const outcomes = await Promise.allSettled([
      this.discord.rest(`/guilds/${guildId}/members/search?query=${encodeURIComponent(term)}&limit=1000`),
      this.indexPage(state)
    ]);
    this.assertCurrent(state);
    const remote = outcomes[0];
    if (remote.status === 'fulfilled' && Array.isArray(remote.value)) {
      for (const member of remote.value) this.remember(state, member);
      remoteFull = remote.value.length === 1000;
    } else searchWarning = `Busca do Discord indisponível: ${remote.reason?.message || 'resposta inválida'}`;
    if (outcomes[1].status === 'rejected') throw outcomes[1].reason;
    // Global users are not proof of membership. Only merge this guild's gateway data.
    for (const member of this.discord.guildMembers?.get(guildId)?.values() || []) this.remember(state, member);
    const normalized = normalize(term);
    const matches = [...state.members.values()].filter(member =>
      [member.name, member.username, member.displayName, member.nickname].some(value => normalize(value).includes(normalized))
    ).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.id.localeCompare(b.id));
    const warning = [searchWarning, state.indexWarning,
      !this.discord.bot ? 'Busca parcial nesta conta. Para carregar todos os membros, use o bot oficial com Server Members Intent. Você também pode colar o ID da pessoa.' : '',
      !state.complete && !state.indexWarning && this.discord.bot ? 'Há mais membros no servidor. Use Carregar mais membros para ampliar a busca por apelido e nome de exibição.' : '',
      matches.length > 1000 || remoteFull && !state.complete ? 'Há muitos resultados. Refine o nome ou cole o ID para localizar uma pessoa específica.' : ''
    ].filter(Boolean).join(' ');
    return { guildId, query: raw, members: matches.slice(0, 1000), total: matches.length, indexed: state.indexed,
      complete: state.complete, hasMore: Boolean(this.discord.bot && !state.complete && !state.indexWarning), warning };
  }
}

module.exports = { MemberDirectory, memberView };
