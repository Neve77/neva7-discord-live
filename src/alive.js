const { think } = require('./llm');
const { getSystemPrompt } = require('./config');

// Comentários espontâneos, somente nos canais escolhidos e após ativação explícita.
class AliveSystem {
  constructor(discord, options = {}) {
    this.discord = discord;
    this.enabled = options.enabled ?? false;
    this.channels = new Set(options.channels || []); // canais que o bot "vive"
    this.minInterval = options.minInterval ?? 2 * 60 * 1000; // 2 min entre msgs
    this.maxInterval = options.maxInterval ?? 8 * 60 * 1000; // 8 min entre msgs
    this.maxPerHour = options.maxPerHour ?? 8; // máx msgs por hora
    this.ghostRate = options.ghostRate ?? 0.3; // 30% chance de ignorar msg
    this.lastMsgTime = new Map(); // channelId -> timestamp
    this.msgCount = new Map(); // channelId -> { count, resetAt }
    this.recentMsgs = new Map(); // channelId -> últimas msgs lidas
    this.running = false;
    this.timer = null;
    this.ticking = false;

    // escuta todas as mensagens pra manter contexto
    discord.on('message', (m) => this.onMessage(m));
  }

  // registra canais onde o bot deve "viver"
  addChannel(channelId) {
    this.channels.add(channelId);
    console.log(`[viva] canal registrado: ${channelId}`);
  }

  removeChannel(channelId) {
    this.channels.delete(channelId);
  }

  // mantém últimas 20 msgs de cada canal pra contexto
  onMessage(m) {
    if (m.author?.bot || m.author?.id === this.discord.me?.id) return;
    const ch = m.channel_id;
    if (!this.channels.has(ch)) return;
    if (!this.recentMsgs.has(ch)) this.recentMsgs.set(ch, []);
    const msgs = this.recentMsgs.get(ch);
    msgs.push({
      author: m.author?.username || 'alguém',
      content: (m.content || '').slice(0, 200),
      time: Date.now()
    });
    // guarda só as últimas 20
    if (msgs.length > 20) msgs.splice(0, msgs.length - 20);
  }

  // checa se pode mandar msg agora (rate limit)
  canSend(channelId) {
    const now = Date.now();
    const hour = this.msgCount.get(channelId);
    if (hour) {
      if (now > hour.resetAt) {
        this.msgCount.set(channelId, { count: 0, resetAt: now + 3600000 });
      } else if (hour.count >= this.maxPerHour) {
        return false;
      }
    }
    const last = this.lastMsgTime.get(channelId) || 0;
    if (now - last < this.minInterval) return false;
    return true;
  }

  // gera msg baseada no contexto do canal
  async generateMsg(channelId) {
    const msgs = this.recentMsgs.get(channelId) || [];
    if (msgs.length < 3) return null; // precisa de contexto mínimo

    // pega as últimas 10 msgs
    const recent = msgs.slice(-10);
    const convo = recent.map(m => `${m.author}: ${m.content}`).join('\n');

    const prompt = `Você é um bot de conversa em um chat de Discord. Você acabou de ler as últimas mensagens do canal.
Separe e comente algo natural sobre o que tá rolando — pode ser uma reação, piada, opinião, pergunta, ou só uma msg curta.
Use linguagem natural, 1-2 frases no máximo.
NÃO responda a tudo — escolhe UMA coisa pra comentar.

Conversa recente:
${convo}`;

    const reply = await think(prompt, 'viva:' + channelId, getSystemPrompt() + '\nFaça um comentário breve como bot de conversa, sem fingir ser uma pessoa real. Pode ignorar msgs que não tem o que comentar.');
    return reply;
  }

  // manda msg no canal
  async sendMsg(channelId, text) {
    if (!this.running || !this.enabled || !this.discord.connected || !this.channels.has(channelId) || !this.canSend(channelId)) return false;
    // Reserva o intervalo antes de enviar, inclusive se a API recusar a mensagem.
    this.lastMsgTime.set(channelId, Date.now());
    try {
      await this.discord.sendMessage(channelId, text);
      this.lastMsgTime.set(channelId, Date.now());
      const hour = this.msgCount.get(channelId) || { count: 0, resetAt: Date.now() + 3600000 };
      hour.count++;
      this.msgCount.set(channelId, hour);
      console.log(`[viva] mandou msg em ${channelId}: ${text.slice(0, 80)}`);
      return true;
    } catch (e) {
      console.error(`[viva] erro enviar em ${channelId}:`, e.message?.slice(0, 60));
      return false;
    }
  }

  // loop principal: checa canais periodicamente
  start() {
    if (this.running) return;
    this.running = true;
    console.log(`[viva] sistema ativo em ${this.channels.size} canais`);

    this.timer = setInterval(() => this.tick().catch(e => console.error('[viva] erro:', e.message)), 60 * 1000);
  }

  async tick() {
    if (!this.running || !this.enabled || !this.discord.connected || this.ticking) return;
    this.ticking = true;
    try {
      for (const channelId of this.channels) {
        if (!this.running || !this.enabled || !this.discord.connected) break;
        try {
          // rate limit
          if (!this.canSend(channelId)) continue;
          // chance de ignorar (gente não fala o tempo todo)
          if (Math.random() < this.ghostRate) continue;
          // precisa de msgs recentes
          const msgs = this.recentMsgs.get(channelId);
          if (!msgs || msgs.length < 3) continue;
          // última msg não pode ser muito antiga (>5 min)
          const lastMsg = msgs[msgs.length - 1];
          if (Date.now() - lastMsg.time > 5 * 60 * 1000) continue;
          // não responde a msgs muito antigas
          if (Date.now() - lastMsg.time < 30000) continue; // espera 30s após última msg

          const reply = await this.generateMsg(channelId);
          if (reply && reply.length > 3) {
            await this.sendMsg(channelId, reply);
          }
        } catch (e) {
          console.error('[viva] erro:', e.message?.slice(0, 60));
        }
      }
    } finally { this.ticking = false; }
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    console.log('[viva] sistema parado');
  }
}

module.exports = { AliveSystem };
