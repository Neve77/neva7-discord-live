const fs = require('fs');
const path = require('path');

const SCENES = {
  social: { name: 'Social', prompt: 'Seja acolhedora e mantenha a conversa leve.' },
  study: { name: 'Foco', prompt: 'Seja breve e ajude o grupo a manter o foco.' },
  game: { name: 'Jogo', prompt: 'Comente com energia sem atrapalhar a partida.' },
  movie: { name: 'Cinema', prompt: 'Evite spoilers e conduza a conversa após a sessão.' },
  late: { name: 'Madrugada', prompt: 'Fale baixo e mantenha uma conversa tranquila.' }
};

function clean(value, limit) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit); }

class SocialHub {
  constructor(file = path.join(__dirname, '..', 'social-hub.json')) {
    this.file = file; this.data = { guilds: {} };
    try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); if (data && data.guilds) this.data = data; } catch {}
  }
  save() {
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2) + '\n');
    fs.renameSync(temp, this.file);
  }
  guild(id) {
    if (!id) throw new Error('Servidor não informado.');
    if (!this.data.guilds[id]) this.data.guilds[id] = { scene: 'social', profiles: {}, moments: [], plans: [], polls: [] };
    return this.data.guilds[id];
  }
  see(guildId, user) {
    const id = String(user && user.id || ''); if (!id) return;
    const guild = this.guild(guildId);
    const profile = guild.profiles[id] || { name: '', notes: [] };
    profile.name = clean(user.global_name || user.username || profile.name || 'Pessoa', 80);
    profile.lastSeenAt = Date.now(); guild.profiles[id] = profile;
  }
  remember(guildId, user, text) {
    const note = clean(text, 220); if (!note) throw new Error('Escreva algo para guardar.');
    this.see(guildId, user); const profile = this.guild(guildId).profiles[user.id];
    profile.notes = [note].concat(profile.notes.filter(item => item !== note)).slice(0, 20); this.save(); return note;
  }
  moment(guildId, user, text, title) {
    const body = clean(text, 500); if (!body) throw new Error('O momento está vazio.');
    const item = { id: String(Date.now()), title: clean(title, 80) || 'Momento da call', text: body, author: clean(user && (user.global_name || user.username) || 'alguém', 80), at: Date.now() };
    const moments = this.guild(guildId).moments; moments.unshift(item); moments.splice(30); this.save(); return item;
  }
  scene(guildId, id) {
    const guild = this.guild(guildId);
    if (id != null) { if (!SCENES[id]) throw new Error('Cena desconhecida.'); guild.scene = id; this.save(); }
    return { id: guild.scene, ...SCENES[guild.scene] };
  }
  plan(guildId, user, text) {
    const task = clean(text, 240); if (!task) throw new Error('Descreva o próximo passo.');
    const plans = this.guild(guildId).plans;
    const item = { id: String(Date.now()), text: task, by: clean(user && (user.global_name || user.username) || 'grupo', 80), done: false, at: Date.now() };
    plans.unshift(item); plans.splice(40); this.save(); return item;
  }
  poll(guildId, user, question, choices) {
    const options = Array.from(new Set((choices || []).map(item => clean(item, 80)).filter(Boolean))).slice(0, 8);
    if (!clean(question, 160) || options.length < 2) throw new Error('Informe uma pergunta e ao menos duas opções.');
    const item = { id: String(Date.now()), question: clean(question, 160), choices: options, votes: {}, open: true, by: clean(user && (user.global_name || user.username) || 'grupo', 80), at: Date.now() };
    const polls = this.guild(guildId).polls; polls.unshift(item); polls.splice(10); this.save(); return item;
  }
  summary(guildId) {
    const guild = this.guild(guildId);
    return { scene: this.scene(guildId), moments: guild.moments.slice(0, 5), plans: guild.plans.filter(item => !item.done).slice(0, 5), polls: guild.polls.filter(item => item.open).slice(0, 3), people: Object.keys(guild.profiles).length };
  }
}

module.exports = { SocialHub, SCENES };
