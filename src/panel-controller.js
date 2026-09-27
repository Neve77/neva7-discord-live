const fs = require('fs');
const { detectTextLanguage } = require('./languages');
const { MemberDirectory } = require('./member-directory');
const { messageAccess } = require('./message-access');
const { listSoundEffects, importSoundEffect, resolveSoundEffect } = require('./sound-effects');

class PanelController {
  constructor({ discord, voice, alive, settings, llmInfo, metrics, sayInVoice, resolveTrack, summarizeChannel,
    clearTopicContext = () => false, connectionSettings, ownerId, defaultGuildId, defaultTextChannelId,
    onJoin = () => {}, onLeave = () => {}, onTextChannel = () => {} }) {
    Object.assign(this, { discord, voice, alive, settings, llmInfo, metrics, sayInVoice, resolveTrack, summarizeChannel,
      clearTopicContext, connectionSettings, ownerId, defaultGuildId, defaultTextChannelId, onJoin, onLeave, onTextChannel });
    this.guild = null;
    this.textChannel = null;
    this.channels = [];
    this.lastSpeech = '';
    this.memberDirectory = new MemberDirectory(discord);
  }

  async listServers() {
    if (!this.discord.connected) return [];
    const servers = [];
    let after = '';
    while (true) {
      const page = await this.discord.rest(`/users/@me/guilds?limit=200${after ? `&after=${after}` : ''}`);
      servers.push(...page);
      if (page.length < 200 || page.at(-1).id === after) break;
      after = page.at(-1).id;
    }
    return servers.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  async initialize() {
    const servers = await this.listServers();
    const selected = servers.find(g => g.id === this.defaultGuildId) || (servers.length === 1 ? servers[0] : null);
    if (selected) await this.selectServer(selected);
  }

  async selectServer(guild) {
    // Carrega antes de trocar a seleção para não deixar um estado parcial se o REST falhar.
    const channels = await this.discord.rest(`/guilds/${guild.id}/channels`);
    this.guild = guild;
    this.channels = channels;
    this.textChannel = null;
    this.memberDirectory.reset(guild.id);
    const preferred = this.textChannels().find(ch => ch.id === this.defaultTextChannelId);
    if (preferred) this.selectTextChannel(preferred);
  }

  async refreshChannels() {
    this.requireGuild();
    this.channels = await this.discord.rest(`/guilds/${this.guild.id}/channels`);
    if (this.textChannel && !this.textChannels().some(ch => ch.id === this.textChannel.id)) this.textChannel = null;
  }

  textChannels() { return this.channels.filter(ch => [0, 5].includes(ch.type)).sort((a, b) => (a.position || 0) - (b.position || 0)); }
  voiceChannels() { return this.channels.filter(ch => ch.type === 2).sort((a, b) => (a.position || 0) - (b.position || 0)); }

  selectTextChannel(channel) {
    if (!this.textChannels().some(ch => ch.id === channel.id)) throw new Error('Escolha um canal de texto deste servidor.');
    this.textChannel = channel;
    this.onTextChannel(this.guild.id, channel.id);
  }

  requireGuild() {
    if (!this.guild) throw new Error('Selecione um servidor em Destino.');
    if (!this.discord.connected) throw new Error('O bot está desconectado. Aguarde a reconexão.');
    return this.guild.id;
  }

  requireTextChannel() {
    this.requireGuild();
    if (!this.textChannel) throw new Error('Selecione um canal de texto em Destino.');
    return this.textChannel.id;
  }

  requireVoice() {
    const guildId = this.requireGuild();
    const session = this.voice.get(guildId);
    if (!session) throw new Error('Entre em uma call: escolha uma call e clique em Entrar na call.');
    return session;
  }

  inviteUrl() {
    const applicationId = this.discord.applicationId || this.discord.me?.id;
    if (!this.discord.bot || !/^\d{17,20}$/.test(applicationId || '')) return '';
    // Ver canais, enviar/ler mensagens, conectar, falar e usar atividade de voz.
    const permissions = [10n, 11n, 16n, 20n, 21n, 25n].reduce((bits, bit) => bits | (1n << bit), 0n);
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', applicationId);
    url.searchParams.set('scope', 'bot');
    url.searchParams.set('permissions', permissions.toString());
    return url.toString();
  }

  status() {
    const session = this.guild ? this.voice.get(this.guild.id) : null;
    return {
      online: this.discord.connected, username: this.discord.me?.username || 'conectando',
      inviteUrl: this.inviteUrl(),
      connection: this.connectionSettings?.status() || null,
      connectionError: this.discord.loginError || '',
      guild: this.guild?.name || 'não selecionado', channel: this.textChannel?.name || 'não selecionado',
      call: session ? this.channels.find(ch => ch.id === session.channelId)?.name || session.channelId : 'fora da call',
      inCall: Boolean(session), voiceChannelId: session?.channelId || '', canFollowOwner: Boolean(this.ownerId),
      botMode: Boolean(this.discord.bot), selfbotSafeMode: !this.discord.bot,
      safetyWarning: !this.discord.bot ? 'Selfbot ativo: automações e respostas contínuas ficam bloqueadas por segurança; use apenas comandos manuais e locais.' : '',
      speaking: Boolean(session?.playing && !session.musicBusy), synthesizing: Boolean(session?.synthesizing),
      listening: session ? !session.deaf : null, volume: session ? Math.round(session.speechVol * 100) : null,
      music: session?.currentTrack ? `${session.musicState}: ${session.currentTrack.title}` : 'parada',
      musicError: session?.musicError || '',
      musicState: session?.musicState || 'parada', currentTrack: session?.currentTrack?.title || '',
      musicBusy: Boolean(session?.musicBusy), musicQueueSize: session?.tracks?.length || 0,
      musicQueue: (session?.tracks || []).slice(0, 20).map(track => ({ title: track.title, current: track === session.currentTrack })),
      aliveInChannel: Boolean(this.textChannel && this.alive.channels.has(this.textChannel.id)),
      emotion: this.settings.getCurrent(), voice: this.settings.getTtsInfo?.().voice || this.settings.state.ttsVoice, speed: this.settings.state.ttsSpeed,
      tts: this.settings.getTtsInfo?.().label || 'Edge',
      autoJoin: this.settings.config.autoJoinOnMention, replyInText: this.settings.config.replyInTextToo,
      alive: this.alive.enabled, aliveChannels: this.alive.channels.size,
      interaction: this.settings.getInteraction?.() || '',
      botMode: Boolean(this.discord.bot), presence: this.discord.presence || this.settings.getBotPresence?.() || null,
      model: `${this.llmInfo.chatProvider} / ${this.llmInfo.chatModel}`,
      guildId: this.guild?.id || '', textChannelId: this.textChannel?.id || '',
      metrics: this.metrics?.snapshot?.() || {},
      lastSpeech: this.lastSpeech,
      recording:this.voice.recordings?.snapshot(this.guild?.id)||null,
      recordingActive:[...(this.voice.recordings?.active.keys()||[])].map(id=>this.voice.recordings.snapshot(id)),
      soundEffects: listSoundEffects()
    };
  }

  async join(channelId = null) {
    const guildId = this.requireGuild();
    if (channelId) {
      if (!this.voiceChannels().some(ch => ch.id === channelId)) throw new Error('Escolha uma call deste servidor.');
    } else {
      if (!this.ownerId) throw new Error('Configure OWNER_ID no .env ou escolha uma call pelo nome.');
      channelId = await this.discord.resolveVoiceChannelOf(guildId, this.ownerId);
      if (!channelId) throw new Error('Você não está em uma call deste servidor.');
    }
    await this.voice.join(guildId, channelId);
    this.onJoin(guildId);
    return 'Conectado à call.';
  }

  async leave() {
    const guildId = this.requireGuild();
    await this.voice.leave(guildId);
    this.onLeave(guildId);
    return 'Saiu da call.';
  }

  async say(text) {
    this.requireVoice();
    if (!text?.trim()) throw new Error('Digite uma frase para falar.');
    if (text.length > 400) throw new Error('Use uma frase com até 400 caracteres.');
    // Fala iniciada pelo painel tem prioridade explícita sobre uma fila de música.
    const played = await this.sayInVoice(this.guild.id, text.trim(), detectTextLanguage(text), { interruptMusic: true });
    if (!played) throw new Error('A voz está ocupada. Pare a música ou aguarde e tente de novo.');
    this.lastSpeech = text.trim();
    this.onJoin(this.guild.id);
    return 'Áudio reproduzido na call.';
  }

  startRecording(){this.requireVoice();this.voice.startRecording(this.guild.id);return 'Gravação iniciada no computador. Participantes e áudio da Neva7 serão salvos.';}
  stopRecording(){const gid=this.guild?.id;if(!this.voice.recordings?.isActive(gid))throw new Error('Não há gravação ativa neste servidor.');this.voice.stopRecording(gid);return 'Gravação encerrada. Finalizando os WAVs no computador…';}

  async repeatLastSpeech() {
    if (!this.lastSpeech) throw new Error('Ainda não há uma frase para repetir. Use Falar agora primeiro.');
    await this.say(this.lastSpeech);
    return 'Última frase repetida na call.';
  }

  async announce(text) {
    const channel = this.requireTextChannel();
    this.requireVoice();
    const message = String(text || '').trim();
    if (!message || message.length > 400) throw new Error('Use um anúncio entre 1 e 400 caracteres para caber na fala.');
    await this.discord.sendMessage(channel, message);
    try {
      await this.say(message);
    } catch (error) {
      return `Anúncio enviado em #${this.textChannel.name}, mas a voz não tocou: ${error.message}`;
    }
    return `Anúncio enviado em #${this.textChannel.name} e falado na call.`;
  }

  diagnostics() {
    const status = this.status();
    const queuedRoutes = this.discord.restRouteQueues?.size || 0;
    const gateway = this.discord.heartbeatMs
      ? `${this.discord.heartbeatMs}ms (${this.discord.heartbeatAck ? 'ACK recebido' : 'aguardando ACK'})`
      : 'aguardando gateway';
    return [
      'DIAGNÓSTICO RÁPIDO',
      `Discord: ${status.online ? 'online' : 'desconectado'}  |  Gateway: ${gateway}`,
      `Servidor: ${status.guild}  |  Texto: #${status.channel}  |  Call: ${status.call}`,
      `IA: ${status.model}`,
      `Voz: ${status.tts} / ${status.voice} / ${status.speed}x  |  Escuta: ${status.listening == null ? 'fora da call' : status.listening ? 'ligada' : 'desligada'}`,
      `REST: ${queuedRoutes} rota(s) na fila  |  Autoentrada: ${status.autoJoin ? 'ON' : 'OFF'}  |  Texto: ${status.replyInText ? 'ON' : 'OFF'}`,
      status.metrics?.llm?.last != null ? `Latências: STT ${status.metrics.stt.last ?? '—'}ms  |  IA ${status.metrics.llm.last ?? '—'}ms  |  TTS ${status.metrics.tts.last ?? '—'}ms` : 'Latências: ainda sem uma resposta medida.',
      status.metrics?.voiceReply?.samples ? `Resposta na call: P50 ${status.metrics.voiceReply.p50}ms | P95 ${status.metrics.voiceReply.p95}ms | Maior ${status.metrics.voiceReply.max}ms` : '',
      status.lastSpeech ? `Última fala: ${status.lastSpeech.slice(0, 120)}` : 'Última fala: nenhuma'
    ].join('\n');
  }

  async play(query) {
    const session = this.requireVoice();
    const guildId = this.guild.id;
    if (!query?.trim()) throw new Error('Informe o nome da música ou um link.');
    const track = await this.resolveTrack(query.trim());
    try {
      if (this.voice.get(guildId) !== session) throw new Error('A call mudou durante a busca. Tente novamente.');
      await this.voice.enqueueMusic(guildId, [track]);
    }
    catch (error) { if (track.tmp) { try { fs.unlinkSync(track.file); } catch {} } throw error; }
    this.onJoin(guildId);
    return `Adicionado à fila: ${track.title}`;
  }

  async listSoundEffects() {
    return listSoundEffects();
  }

  async importSoundEffect(value = {}) {
    const item = await importSoundEffect(value);
    return `Efeito salvo: ${item.name || value.name || item.filename}`;
  }

  async playSoundEffect(value = {}) {
    const session = this.requireVoice();
    const raw = typeof value === 'string' ? value : value?.id ?? value?.filename ?? value?.name ?? value?.file ?? '';
    const id = String(raw || '').split(/[\\/]/).pop().trim();
    if (!id) throw new Error('Selecione um efeito para tocar na call.');
    const file = resolveSoundEffect(id);
    if (this.voice.get(this.guild.id) !== session) throw new Error('A call mudou antes de tocar o efeito.');
    const played = await this.voice.playFiles(this.guild.id, [file]);
    return played !== false ? 'Efeito tocado na call.' : 'A call está ocupada; tente novamente em seguida.';
  }

  queue() {
    const session = this.requireVoice();
    const queue = this.voice.musicQueue(this.guild.id).map((track, i) => `${i + 1}. ${track.title}`).join('\n') || 'Fila vazia.';
    return queue + (session.musicError ? `\nÚltimo erro: ${session.musicError}` : '');
  }

  skip() { this.requireVoice(); return this.voice.skipTrack(this.guild.id) ? 'Faixa pulada.' : 'Nada tocando.'; }
  stopMusic() { this.requireVoice(); return this.voice.stopMusic(this.guild.id) ? 'Música parada e fila limpa.' : 'Nada tocando.'; }

  stopAll() {
    const session = this.requireVoice();
    this.voice.stopRecording?.(this.guild.id,'stop-all');
    session.live?.stop();
    const musicStopped = this.voice.stopMusic(this.guild.id);
    session.responseAbort?.abort();
    session.synthesisAbort?.abort();
    session.speechAbort?.abort();
    session.speechQueue = [];
    session.pendingSpeech = [];
    for (const capture of session.captures?.values() || []) {
      capture.cancelled = true;
      capture.stream?.destroy();
    }
    try { session.player?.stop(true); } catch {}
    return musicStopped ? 'Áudio parado e fila de música limpa.' : 'Áudio atual parado.';
  }

  setVolume(value) {
    this.requireVoice();
    const volume = numeric(value, 0, 200, 'Volume');
    this.voice.setVolumes(this.guild.id, { speech: volume / 100, music: volume / 100 * 0.7 });
    return `Volume: ${volume}%. Vale para os próximos áudios.`;
  }

  toggleListening() {
    const session = this.requireVoice();
    const on = session.deaf;
    this.voice.setListen(this.guild.id, on);
    return `Escuta ${on ? 'ligada' : 'desligada'}.`;
  }

  setEmotion(name) {
    if (!this.settings.setEmotion(name)) throw new Error('Emoção desconhecida.');
    return `Emoção: ${name}`;
  }

  setCustomEmotion(text) {
    const custom = String(text || '').trim();
    if (!custom) throw new Error('Descreva a personalidade.');
    if (custom.length > 700) throw new Error('A personalidade pode ter no m\u00e1ximo 700 caracteres.');
    this.settings.setCustom(custom);
    return 'Personalidade personalizada salva.';
  }

  setInteraction(text) {
    const guide = String(text || '').trim();
    if (guide.length > 700) throw new Error('Os ajustes de intera\u00e7\u00e3o podem ter no m\u00e1ximo 700 caracteres.');
    if (typeof this.settings.setInteraction !== 'function') throw new Error('Ajustes de intera\u00e7\u00e3o indispon\u00edveis. Reinicie o bot.');
    this.settings.setInteraction(guide);
    return guide ? 'Ajustes de intera\u00e7\u00e3o salvos.' : 'Ajustes de intera\u00e7\u00e3o removidos.';
  }

  setVoice(name) {
    if (!this.settings.listVoices().includes(name)) throw new Error('Voz desconhecida.');
    this.settings.setVoice(name);
    return `Voz: ${name}`;
  }

  setSpeed(value) {
    const speed = numeric(value, 0.25, 4, 'Velocidade');
    this.settings.setSpeed(speed);
    return `Velocidade: ${speed}x`;
  }

  setBotPresence(value) {
    if (!this.discord.bot) throw new Error('A atividade pelo painel está disponível somente para bot oficial.');
    const name = String(value?.name || '').trim();
    const state = String(value?.state || '').trim();
    const url = String(value?.url || '').trim();
    const type = Number(value?.type);
    const status = String(value?.status || 'online');
    if (!name || name.length > 128) throw new Error('Informe uma atividade entre 1 e 128 caracteres.');
    if (state.length > 128) throw new Error('O detalhe pode ter no máximo 128 caracteres.');
    if (!['online', 'idle', 'dnd', 'invisible'].includes(status) || ![0, 1, 2, 3, 5].includes(type)) throw new Error('Status ou tipo de atividade inválido.');
    if (url && (type !== 1 || !/^https:\/\//i.test(url))) throw new Error('A URL deve começar com https:// e só é usada para transmissão.');
    const presence = this.settings.setBotPresence({ status, type, name, state, url });
    this.discord.setBotPresence(presence);
    return 'Atividade do bot atualizada no Discord.';
  }

  toggleOption(name) {
    if (!['autoJoinOnMention', 'replyInTextToo'].includes(name)) throw new Error('Opção desconhecida.');
    const enabled = !this.settings.config[name];
    this.settings.setOption(name, enabled);
    return `${name === 'autoJoinOnMention' ? 'Entrada automática' : 'Respostas em texto'}: ${enabled ? 'ligadas' : 'desligadas'}.`;
  }

  async send(text) {
    const channel = this.requireTextChannel();
    if (!text?.trim() || text.length > 2000) throw new Error('Digite uma mensagem entre 1 e 2000 caracteres.');
    await this.discord.sendMessage(channel, text.trim());
    return `Mensagem enviada em #${this.textChannel.name}.`;
  }

  async searchMembers(query) {
    return (await this.findMembers(query)).members;
  }

  async findMembers(query) {
    return this.memberDirectory.search(this.requireGuild(), query);
  }

  async checkMessageAccess() {
    const channelId = this.requireTextChannel(), guildId = this.guild.id, userId = this.discord.me?.id;
    if (!userId) throw new Error('Aguarde a conexão da conta com o Discord.');
    const [guild, channel, member] = await Promise.all([
      this.discord.rest(`/guilds/${guildId}`), this.discord.rest(`/channels/${channelId}`),
      this.discord.rest(`/guilds/${guildId}/members/${userId}`)
    ]);
    if (this.guild?.id !== guildId || this.textChannel?.id !== channelId) throw new Error('O destino mudou. Verifique as permissões novamente.');
    return { ...messageAccess(guild, channel, member, userId), account: this.discord.me.username,
      accountType: this.discord.bot ? 'Bot oficial' : 'Conta pessoal' };
  }

  async mention(userId, text) {
    const channel = this.requireTextChannel();
    const state = this.memberDirectory.state;
    const member = state?.members.get(String(userId || ''));
    const message = String(text || '').trim();
    if (!member) throw new Error('Busque e selecione uma pessoa da lista antes de mencionar.');
    if (!message || message.length > 1900) throw new Error('Digite uma mensagem entre 1 e 1900 caracteres.');
    // Revalidate membership before notifying; cached results can outlive a member leaving.
    const current = await this.discord.rest(`/guilds/${state.guildId}/members/${member.id}`);
    this.memberDirectory.assertCurrent(state);
    if (current?.user?.id !== member.id) throw new Error('Não foi possível confirmar esta pessoa no servidor. Busque novamente.');
    if (this.textChannel?.id !== channel) throw new Error('O canal mudou. Confira o destino antes de mencionar.');
    await this.discord.sendMessage(channel, `<@${member.id}> ${message}`, {
      allowedMentions: { parse: [], users: [member.id] }
    });
    return `${member.name} foi mencionado em #${this.textChannel.name}.`;
  }

  clearContext() {
    const guildId = this.requireGuild();
    return this.clearTopicContext(guildId)
      ? 'Contexto da conversa removido.'
      : 'Não há contexto ativo para limpar.';
  }

  async summarize() {
    const messages = await this.discord.rest(`/channels/${this.requireTextChannel()}/messages?limit=30`);
    const lines = messages.slice().reverse().filter(m => m.content).map(m => `${m.author?.username || 'alguém'}: ${m.content}`);
    return this.summarizeChannel(lines);
  }

  toggleAlive() {
    this.alive.enabled = !this.alive.enabled;
    return `Vida própria ${this.alive.enabled ? 'ligada' : 'desligada'} nesta sessão (${this.alive.channels.size} canais).`;
  }

  toggleAliveChannel() {
    const channel = this.requireTextChannel();
    if (this.alive.channels.has(channel)) { this.alive.removeChannel(channel); return 'Canal removido da vida própria.'; }
    this.alive.addChannel(channel);
    return 'Canal adicionado à vida própria nesta sessão.';
  }
}

function numeric(value, min, max, label) {
  const text = String(value).trim().replace(',', '.');
  const number = text ? Number(text) : NaN;
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label}: use um número de ${min} a ${max}.`);
  return number;
}

module.exports = { PanelController };
