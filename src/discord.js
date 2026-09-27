const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { gaussianJitter, retryAfterMs } = require('./jitter');
const { discordRestError } = require('./discord-errors');

const API = 'https://discord.com/api/v10';
const GATEWAY_V9 = 'wss://gateway.discord.gg/?v=9&encoding=json';
const GATEWAY_V10 = 'wss://gateway.discord.gg/?v=10&encoding=json';
const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_VOICE_STATES: 1 << 7,
  GUILD_MESSAGES: 1 << 9,
  MESSAGE_CONTENT: 1 << 15
};

// Chrome 126 — User-Agent real, não versão fake
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SUPER_PROPS = Buffer.from(JSON.stringify({
  os: 'Windows',
  browser: 'Chrome',
  device: '',
  system_locale: 'pt-BR',
  browser_user_agent: UA,
  browser_version: '126.0.0.0',
  os_version: '10',
  referrer: '',
  referring_domain: '',
  referrer_current: '',
  referring_domain_current: '',
  release_channel: 'stable',
  client_build_number: 345862,
  client_event_source: null
})).toString('base64');

const UA_BOT = 'DiscordBot (E-bot, 2.0.0)';

function normalizePresence(value = {}) {
  const status = ['online', 'idle', 'dnd', 'invisible'].includes(value.status) ? value.status : 'online';
  const type = [0, 1, 2, 3, 5].includes(Number(value.type)) ? Number(value.type) : 0;
  return {
    status,
    type,
    name: String(value.name || '').trim().slice(0, 128),
    state: String(value.state || '').trim().slice(0, 128),
    url: String(value.url || '').trim().slice(0, 512)
  };
}

class DiscordSelfbot extends EventEmitter {
  constructor(token, opts = {}) {
    super();
    this.token = token;
    this.bot = !!opts.bot;
    this.presence = normalizePresence(opts.presence || { name: opts.activity || 'Conversando no Discord' });
    this.me = null;
    this.applicationId = null;
    this.ws = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.heartbeatTimer = null;
    this.heartbeatAck = true;
    this.heartbeatMs = 0; // intervalo atual do gateway
    this.voiceStates = new Map();
    this.users = new Map();
    this.memberRoles = new Map();
    this.guildMembers = new Map();
    this.connected = false;
    this.reconnects = 0;
    this.lastSend = 0;
    this.presenceTimer = null;
    this.destroyed = false;
    this.reconnectTimer = null;
    this.identifyTimer = null;
    this.restQueue = Promise.resolve();
    this.restRouteQueues = new Map();
    this.restBlockedUntil = 0;
    this.restRouteBlockedUntil = new Map();
    this.restDeniedUntil = new Map();
    this.restAbort = new AbortController();
    this.stopError = null;
    this.lastTyping = 0; // anti-flood de typing
  }

  headers(extra = {}) {
    if (this.bot) {
      return {
        'Authorization': `Bot ${this.token}`,
        'User-Agent': UA_BOT,
        'Content-Type': 'application/json',
        ...extra
      };
    }
    return {
      'Authorization': this.token,
      'User-Agent': UA,
      'Content-Type': 'application/json',
      'Origin': 'https://discord.com',
      'Referer': 'https://discord.com/channels/@me',
      'X-Discord-Locale': 'pt-BR',
      'X-Super-Properties': SUPER_PROPS,
      ...extra
    };
  }

  rest(path, method = 'GET', body = null, retries = 4) {
    if (this.destroyed) return Promise.reject(this.stopError || new Error('Conexão com Discord encerrada.'));
    // Bots oficiais têm limite por rota no Discord. Uma fila global fazia uma resposta
    // aguardar ACK, typing e comandos de outros canais, mesmo quando não dividiam limite.
    if (this.bot) {
      const route = this.restRouteKey(path, method);
      const previous = this.restRouteQueues.get(route) || Promise.resolve();
      const pending = previous.then(() => this.requestRest(path, method, body, retries, route));
      const settled = pending.catch(() => {});
      this.restRouteQueues.set(route, settled);
      settled.finally(() => {
        if (this.restRouteQueues.get(route) === settled) this.restRouteQueues.delete(route);
      }).catch(() => {});
      return pending;
    }
    const pending = this.restQueue.then(() => this.requestRest(path, method, body, retries, this.restRouteKey(path, method)));
    this.restQueue = pending.catch(() => {});
    return pending;
  }

  restRouteKey(path, method) {
    const pathname = String(path).replace(/^https?:\/\/[^/]+/i, '').split('?')[0]
      .replace(/(\/channels\/\d+\/messages)\/\d+/i, '$1/:message')
      .replace(/(\/guilds\/\d+\/voice-states)\/\d+/i, '$1/:user');
    return `${String(method).toUpperCase()}:${pathname}`;
  }

  stopConnection(error, event = 'connectionStopped') {
    if (this.destroyed) return;
    this.stopError = error;
    this.loginError = error.message;
    this.destroy();
    this.emit(event, error);
  }

  assertRestAvailable(route) {
    if (this.destroyed) throw this.stopError || new Error('Conexão com Discord encerrada.');
    if (/^POST:.*\/messages(?:\?|$)/.test(route || '') && this.activityBlocked?.()) throw new Error('Respostas bloqueadas pelo controle de segurança.');
    const denied = this.restDeniedUntil.get(route);
    if (denied?.until > Date.now()) throw Object.assign(new Error(`${denied.error.message} Aguarde ${Math.ceil((denied.until - Date.now()) / 1000)} s antes de tentar novamente.`), {
      code: denied.error.code, discordCode: denied.error.discordCode, channelId: denied.error.channelId
    });
    if (denied) this.restDeniedUntil.delete(route);
  }

  waitForRest(ms) {
    const signal = this.restAbort.signal;
    return new Promise((resolve, reject) => {
      let timer;
      const abort = () => { clearTimeout(timer); reject(this.stopError || new Error('Conexão com Discord encerrada.')); };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    });
  }

  updateRestLimit(response, route) {
    if (!route || response.headers?.get?.('x-ratelimit-remaining') !== '0') return;
    const after = response.headers.get('x-ratelimit-reset-after');
    const reset = response.headers.get('x-ratelimit-reset');
    const ms = after != null ? Number(after) * 1000 : reset != null ? Number(reset) * 1000 - Date.now() : NaN;
    if (Number.isFinite(ms) && ms >= 0) {
      this.restRouteBlockedUntil.set(route, Math.max(this.restRouteBlockedUntil.get(route) || 0, Date.now() + ms));
    }
  }

  async requestRest(path, method, body, retries, route = null) {
    const url = path.startsWith('http') ? path : API + path;
    for (let i = 0; i < retries; i++) {
      for (;;) {
        this.assertRestAvailable(route);
        const until = Math.max(this.restBlockedUntil, this.restRouteBlockedUntil.get(route) || 0,
          this.bot ? 0 : this.lastSend + 1000);
        if (Date.now() >= until) break;
        await this.waitForRest(Math.min(until - Date.now(), 60000));
      }
      this.lastSend = Date.now();
      const res = await fetch(url, {
        method,
        headers: this.headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: this.restAbort.signal
      });
      this.assertRestAvailable(route);
      this.updateRestLimit(res, route);
      if (res.status === 429) {
        const j = await res.json().catch(() => ({}));
        const wait = retryAfterMs(res, j) + gaussianJitter({ mean: 500, stddev: 200, min: 100, max: 2000 });
        const until = Date.now() + wait;
        const global = j.global === true || res.headers?.get?.('x-ratelimit-global') === 'true';
        if (route && !global) this.restRouteBlockedUntil.set(route, Math.max(this.restRouteBlockedUntil.get(route) || 0, until));
        else this.restBlockedUntil = Math.max(this.restBlockedUntil, until);
        continue;
      }
      if (res.status === 401) {
        const e = Object.assign(new Error('Discord recusou o token (401). A conexão foi parada; confira a conta no aplicativo oficial.'), { code: 401 });
        this.stopConnection(e, 'invalidToken');
        throw e;
      }
      if (!res.ok) {
        let detail = {};
        try { detail = await res.json(); } catch {}
        if ([40002, 40004, 40012].includes(detail?.code)) {
          const e = Object.assign(new Error(`Discord restringiu a operação (código ${detail.code}). Automação parada; resolva o aviso no aplicativo oficial antes de reconectar.`), { code: res.status, discordCode: detail.code });
          this.stopConnection(e);
          throw e;
        }
        const error = discordRestError(res.status, detail, path, method);
        if (res.status === 403) this.restDeniedUntil.set(route, { until: Date.now() + 60000, error });
        throw error;
      }
      if (res.status === 204) return null;
      return res.json();
    }
    throw Object.assign(new Error('Discord limitou as requisições.'), { code: 429 });
  }

  async login() {
    this.me = await this.rest('/users/@me');
    this.connect();
    return this.me;
  }

  async sendMessage(channelId, content, { allowedMentions } = {}) {
    const body = {
      content,
      tts: false,
      allowed_mentions: allowedMentions || { parse: [], replied_user: false }
    };
    return this.rest(`/channels/${channelId}/messages`, 'POST', body);
  }

  async typing(channelId) {
    try {
      // anti-flood: não manda typing 2x em <3s
      const now = Date.now();
      if (now - this.lastTyping < 3000) return;
      this.lastTyping = now;
      await this.rest(`/channels/${channelId}/typing`, 'POST');
    } catch {}
  }

  // Confirmar leitura não é necessário para responder e não faz parte da API de bots.
  async ack() {}

  async getChannel(channelId) {
    return this.rest(`/channels/${channelId}`);
  }

  getVoiceChannelOf(guildId, userId) {
    if (!guildId || !userId) return null;
    return this.voiceStates.get(`${guildId}:${userId}`)?.channelId || null;
  }

  async resolveVoiceChannelOf(guildId, userId) {
    // Primeiro checa o cache (preenchido via gateway VOICE_STATE_UPDATE / GUILD_CREATE)
    const cached = this.getVoiceChannelOf(guildId, userId);
    if (cached) return cached;
    if (!guildId || !userId) return null;
    // Selfbot não pode usar REST pra voice states (403). Só bot tenta REST.
    if (!this.bot) return null;
    try {
      const state = await this.rest(`/guilds/${guildId}/voice-states/${userId}`);
      if (!state?.channel_id) return null;
      this.voiceStates.set(`${guildId}:${userId}`, {
        channelId: state.channel_id, sessionId: state.session_id
      });
      return state.channel_id;
    } catch (error) {
      if (error.code === 404) return null;
      throw error;
    }
  }

  setPresence(status = 'online', activities = []) {
    this.send(3, { since: status === 'idle' ? Date.now() : 0, activities, status, afk: status === 'idle' });
  }

  defaultPresence() {
    const { name, type, state, url } = this.presence;
    if (!name) return [];
    const activity = { name, type };
    if (state) activity.state = state;
    if (type === 1 && url) activity.url = url;
    return [activity];
  }

  setBotPresence(value) {
    this.presence = normalizePresence(value);
    if (this.bot && this.connected) this.setPresence(this.presence.status, this.defaultPresence());
    return this.presence;
  }

  // Só publica a atividade configurada do bot; não simula uso de outros programas.
  startPresenceRotation() {
    clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    if (this.bot) this.setPresence(this.presence.status, this.defaultPresence());
  }

  joinVoiceGateway(guildId, channelId) {
    this.send(4, { guild_id: guildId, channel_id: channelId, self_mute: false, self_deaf: false });
  }

  leaveVoiceGateway(guildId) {
    this.send(4, { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false });
  }

  send(op, d) {
    if (this.destroyed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ op, d }));
    return true;
  }

  gwUrl() {
    return this.bot ? GATEWAY_V10 : GATEWAY_V9;
  }

  connect(resume = false) {
    if (this.destroyed) return;
    const base = (resume && this.resumeUrl ? this.resumeUrl : this.gwUrl());
    const wsHeaders = this.bot ? { 'User-Agent': UA_BOT } : { 'User-Agent': UA, Origin: 'https://discord.com' };
    this.ws = new WebSocket(base, { headers: wsHeaders });
    this.ws.on('open', () => {
      if (resume && this.sessionId && this.seq != null) {
        this.send(6, { token: this.token, session_id: this.sessionId, seq: this.seq });
      }
    });
    this.ws.on('message', (raw) => {
      try { this.onPacket(JSON.parse(raw.toString())); } catch {}
    });
    this.ws.on('close', (code, reason) => {
      this.connected = false;
      clearTimeout(this.heartbeatTimer);
      if (this.destroyed) return;
      const r = reason ? reason.toString().slice(0, 120) : '';
      if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) {
        const message = code === 4004 ? 'Discord recusou o token do gateway.' :
          `Discord encerrou o gateway (${code}). Corrija a configuração antes de reiniciar; não haverá novas tentativas automáticas.`;
        this.stopConnection(Object.assign(new Error(message), { code }), code === 4004 ? 'invalidToken' : 'connectionStopped');
        return;
      }
      if (code === 4007 || code === 4009) { this.sessionId = null; this.seq = null; }
      console.log(`[gw] fechou (code ${code}) ${r}${code === 4014 ? ' — Privileged Intents?' : ''}`);
      // Backoff de reconexão evita sobrecarregar o serviço durante indisponibilidade.
      this.reconnects++;
      const exp = Math.min(this.reconnects, 6);
      const baseWait = 3000 * Math.pow(1.6, exp);
      const wait = Math.min(baseWait, 60000) + gaussianJitter({ mean: 1500, stddev: 800, min: 200, max: 5000 });
      this.reconnectTimer = setTimeout(() => this.connect(true), wait);
    });
    this.ws.on('error', () => {});
  }

  startHeartbeat(ms) {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatMs = ms;
    let firstBeat = true;

    const beat = () => {
      // O primeiro heartbeat de uma conexão nova não pode interpretar o ACK pendente
      // da sessão anterior como falha. Depois dele, cada envio exige seu próprio ACK.
      if (!firstBeat && !this.heartbeatAck) {
        console.log('[gw] ⚠️ heartbeat não respondido, reconectando...');
        try { this.ws.close(); } catch {}
        return;
      }
      firstBeat = false;
      this.heartbeatAck = false;
      this.send(1, this.seq);

      this.heartbeatTimer = setTimeout(beat, ms);
    };

    // O protocolo pede jitter apenas no primeiro heartbeat, seguido do intervalo exato.
    const initialDelay = Math.floor(Math.random() * ms);
    this.heartbeatTimer = setTimeout(beat, initialDelay);
  }

  identify() {
    if (this.destroyed) return;
    if (this.bot) {
      this.send(2, {
        token: this.token,
        intents: INTENTS.GUILDS | INTENTS.GUILD_MEMBERS | INTENTS.GUILD_VOICE_STATES | INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT,
        properties: { os: 'linux', browser: 'E-bot', device: 'E-bot' },
        presence: { status: this.presence.status, since: this.presence.status === 'idle' ? Date.now() : 0, activities: this.defaultPresence(), afk: this.presence.status === 'idle' },
        compress: false,
        large_threshold: 250
      });
      return;
    }
    this.send(2, {
      token: this.token,
      capabilities: 16381,
      properties: {
        os: 'Windows',
        browser: 'Chrome',
        device: '',
        system_locale: 'pt-BR',
        browser_user_agent: UA,
        browser_version: '126.0.0.0',
        os_version: '10',
        referrer: '',
        referring_domain: '',
        referrer_current: '',
        referring_domain_current: '',
        release_channel: 'stable',
        client_build_number: 345862,
        client_event_source: null
      },
      presence: { status: 'online', since: 0, activities: [], afk: false },
      compress: false,
      large_threshold: 250,
      client_state: {
        guild_versions: {},
        highest_last_message_id: '0',
        read_state_version: 0,
        user_guild_settings_version: -1,
        user_settings_version: -1,
        private_channels_version: '0',
        api_code_version: 0
      }
    });
  }

  cacheGuildMember(guildId, member) {
    if (!guildId || !member?.user?.id) return;
    if (!this.guildMembers.has(guildId)) this.guildMembers.set(guildId, new Map());
    const cache = this.guildMembers.get(guildId), old = cache.get(member.user.id);
    cache.set(member.user.id, { ...old, ...member, user: { ...old?.user, ...member.user } });
  }

  onPacket(p) {
    if (this.destroyed) return;
    const { op, d, s, t } = p;
    if (s != null) this.seq = s;

    if (op === 10) {
      this.startHeartbeat(d.heartbeat_interval);
      if (!this.sessionId) this.identify();
      return;
    }
    if (op === 11) { this.heartbeatAck = true; return; }
    if (op === 1) { this.send(1, this.seq); return; }
    if (op === 7) { try { this.ws.close(); } catch {} return; }
    if (op === 9) {
      this.sessionId = null;
      this.seq = null;
      clearTimeout(this.identifyTimer);
      this.identifyTimer = setTimeout(() => this.identify(), 1000 + Math.floor(Math.random() * 4000));
      return;
    }
    if (op !== 0) return;

    if (t === 'READY') {
      this.guildMembers.clear();
      this.reconnects = 0;
      this.sessionId = d.session_id;
      const v = this.bot ? 10 : 9;
      this.resumeUrl = d.resume_gateway_url ? `${d.resume_gateway_url}/?v=${v}&encoding=json` : null;
      this.me = d.user;
      this.applicationId = d.application?.id || (this.bot ? d.user.id : null);
      this.connected = true;
      this.startPresenceRotation();
      console.log(`[gw] ✅ READY: ${d.user.username} (${d.user.id}) [BOT=${this.bot}]`);
      this.emit('ready', d.user);
      return;
    }
    if (t === 'RESUMED') {
      this.reconnects = 0;
      this.connected = true;
      this.emit('resumed');
      return;
    }
    if (t === 'MESSAGE_CREATE') {
      if (d.guild_id && d.member && d.author) this.cacheGuildMember(d.guild_id, { ...d.member, user: d.author });
      if (d.author?.id) this.users.set(d.author.id, { username: d.author.username, global_name: d.author.global_name || d.author.username, bot: !!d.author.bot });
      this.emit('message', d);
      return;
    }
    if (t === 'VOICE_STATE_UPDATE') {
      this.cacheGuildMember(d.guild_id, d.member);
      if (d.member?.roles) this.memberRoles.set(`${d.guild_id}:${d.user_id}`, d.member.roles);
      if (d.member?.user) this.users.set(d.user_id, { ...d.member.user, global_name:d.member.nick || d.member.user.global_name || d.member.user.username });
      if (d.guild_id && d.user_id) {
        if (d.channel_id) this.voiceStates.set(`${d.guild_id}:${d.user_id}`, { channelId: d.channel_id, sessionId: d.session_id });
        else this.voiceStates.delete(`${d.guild_id}:${d.user_id}`);
      }
      this.emit('voiceStateUpdate', d);
      return;
    }
    if (t === 'VOICE_SERVER_UPDATE') { this.emit('voiceServerUpdate', d); return; }
    if (t === 'GUILD_MEMBER_ADD' || t === 'GUILD_MEMBER_UPDATE' || t === 'GUILD_MEMBER_REMOVE') {
      const key = `${d.guild_id}:${d.user?.id}`;
      if (t === 'GUILD_MEMBER_REMOVE') this.memberRoles.delete(key);
      else this.memberRoles.set(key, d.roles || []);
      if (t === 'GUILD_MEMBER_REMOVE') this.guildMembers.get(d.guild_id)?.delete(d.user?.id);
      else this.cacheGuildMember(d.guild_id, d);
      this.emit('guildMemberChange', { guildId: d.guild_id, member: d, removed: t === 'GUILD_MEMBER_REMOVE' });
      this.emit('memberRolesUpdate', d);
      return;
    }
    if (t === 'GUILD_CREATE') {
      this.guildMembers.set(d.id, new Map());
      console.log(`[gw] GUILD_CREATE: ${d.name} (${d.id}) - ${(d.voice_states || []).length} voice states, ${(d.members || []).length} members`);
      for (const vs of (d.voice_states || [])) {
        if (vs.channel_id) this.voiceStates.set(`${d.id}:${vs.user_id}`, { channelId: vs.channel_id, sessionId: vs.session_id });
      }
      for (const m of (d.members || [])) {
        this.cacheGuildMember(d.id, m);
        if (m.user?.id) {
          this.memberRoles.set(`${d.id}:${m.user.id}`, m.roles || []);
          this.users.set(m.user.id, { username: m.user.username, global_name: m.user.global_name || m.nick || m.user.username, bot: !!m.user.bot });
        }
      }
      return;
    }
    if (t === 'GUILD_MEMBERS_CHUNK') {
      for (const member of d.members || []) this.cacheGuildMember(d.guild_id, member);
      return;
    }
    if (t === 'GUILD_DELETE') this.guildMembers.delete(d.id);

    // Só loga eventos desconhecidos em debug (evita spam no console)
    // console.log(`[gw] evt: ${t}`, JSON.stringify(d).slice(0, 150));
  }

  destroy() {
    this.destroyed = true;
    this.connected = false;
    this.restAbort.abort();
    clearTimeout(this.heartbeatTimer);
    clearTimeout(this.presenceTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.identifyTimer);
    try { this.ws?.close(1000, 'Bot desligado'); } catch {}
  }
}

module.exports = { DiscordSelfbot };
