const fs = require('node:fs');
class ConversationMemory {
  constructor(options) { this.options = options; this.turns = []; this.summary = ''; this.sequence = 0; }
  add(userId, role, text) {
    text = String(text || '').trim().slice(0, 4000);
    if (!text) return;
    this.turns.push({ id: ++this.sequence, userId, role, text, at: Date.now() });
    while (this.turns.length > this.options.maxHistory) {
      const old = this.turns.shift();
      // Deterministic extractive summary, bounded, never promoted to instructions.
      this.summary = (this.summary + `\n${old.userId}/${old.role}: ${old.text.slice(0,160)}`).slice(-this.options.maxSummaryChars);
    }
  }
  context(userId) {
    return { summary: this.summary, recent: this.turns.slice(-12), participant: this.turns.filter(t => t.userId === userId).slice(-8) };
  }
  clear() { this.turns = []; this.summary = ''; }
  snapshot() { return { count: this.turns.length, summaryChars: this.summary.length, turns: this.options.retainTranscripts ? this.turns.slice() : [] }; }
}
class PermanentMemory {
  constructor(file) {
    this.file = file; this.notes = [];
    if (file && fs.existsSync(file)) {
      const notes = JSON.parse(fs.readFileSync(file,'utf8'));
      if (!Array.isArray(notes) || notes.length > 200 || notes.some(n => typeof n?.text !== 'string' || typeof n?.userId !== 'string' || typeof n?.guildId !== 'string')) throw new Error('Memória permanente inválida.');
      this.notes = notes;
    }
  }
  save(guildId, userId, text, options) {
    if (!options.permanentMemory || !options.memoryUsers.includes(userId)) throw new Error('Autorize este usuário na política de memória.');
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('Memória deve ter de 1 a 1000 caracteres.');
    if (this.notes.length >= 200) throw new Error('Limite de 200 memórias atingido. Apague uma memória antes de continuar.');
    this.notes.push({ id: require('node:crypto').randomUUID(), guildId, userId, text: text.trim() }); this.persist();
  }
  remove(id) { this.notes = this.notes.filter(n => n.id !== id); this.persist(); }
  persist() { if (this.file) { fs.writeFileSync(this.file+'.tmp', JSON.stringify(this.notes), {mode:0o600}); fs.renameSync(this.file+'.tmp',this.file); } }
  forUser(guildId, userId, options) { return options.permanentMemory && options.memoryUsers.includes(userId) ? this.notes.filter(n => n.guildId === guildId && n.userId === userId) : []; }
}
module.exports = { ConversationMemory, PermanentMemory };
