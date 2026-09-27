const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { parse } = require('dotenv');

function resolveDiscordAuth(env = process.env) {
  const mode = String(env.DISCORD_MODE || '').trim().toLowerCase() ||
    (env.BOT_TOKEN?.trim() ? 'bot' : env.TOKEN?.trim() ? 'selfbot' : 'bot');
  if (!['bot', 'selfbot'].includes(mode)) return { mode: 'bot', token: '', error: 'DISCORD_MODE deve ser bot ou selfbot.' };
  return { mode, token: String(env[mode === 'bot' ? 'BOT_TOKEN' : 'TOKEN'] || '').trim() };
}

function selfbotSafety(mode = 'bot') {
  const activeMode = String(mode || 'bot').trim().toLowerCase();
  const botMode = activeMode === 'bot';
  return {
    botMode,
    selfbotSafeMode: !botMode,
    safetyWarning: !botMode ? 'Selfbot ativo: automações e respostas contínuas ficam bloqueadas por segurança; use apenas comandos manuais e locais.' : ''
  };
}

function updateEnv(source, updates) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const remaining = new Map(Object.entries(updates));
  const lines = source.split(/\r?\n/).map(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !Object.hasOwn(updates, match[1])) return line;
    remaining.delete(match[1]);
    return `${match[1]}=${updates[match[1]]}`;
  });
  while (lines.at(-1) === '') lines.pop();
  for (const [key, value] of remaining) lines.push(`${key}=${value}`);
  return lines.join(newline) + newline;
}

class ConnectionSettings {
  constructor({ env = process.env, file = path.join(__dirname, '..', '.env') } = {}) {
    this.file = file;
    this.values = { DISCORD_MODE: env.DISCORD_MODE, BOT_TOKEN: env.BOT_TOKEN, TOKEN: env.TOKEN };
    this.active = resolveDiscordAuth(this.values);
    this.saving = false;
  }

  status() {
    const saved = resolveDiscordAuth(this.values);
    const safety = selfbotSafety(saved.mode);
    return {
      mode: saved.mode,
      activeMode: this.active.mode,
      botMode: safety.botMode,
      selfbotSafeMode: safety.selfbotSafeMode,
      safetyWarning: safety.safetyWarning,
      hasBotToken: Boolean(this.values.BOT_TOKEN?.trim()),
      hasSelfbotToken: Boolean(this.values.TOKEN?.trim()),
      restartRequired: saved.mode !== this.active.mode || saved.token !== this.active.token
    };
  }

  async save({ mode, token = '' } = {}) {
    if (!['bot', 'selfbot'].includes(mode)) throw new Error('Escolha Bot oficial ou Selfbot.');
    if (typeof token !== 'string' || token.length > 512 || /[\r\n]/.test(token)) throw new Error('Token inválido. Cole somente o token, em uma linha.');
    const entered = token.trim();
    if (entered && !/^[A-Za-z0-9._-]+$/.test(entered)) throw new Error('Token inválido. Cole somente o token, sem prefixos ou aspas.');
    if (this.saving) throw new Error('Aguarde a configuração atual terminar de salvar.');
    this.saving = true;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      let source = '';
      try { source = await fs.promises.readFile(this.file, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const values = { ...this.values, ...parse(source) };
      const key = mode === 'bot' ? 'BOT_TOKEN' : 'TOKEN';
      const selectedToken = entered || String(values[key] || '').trim();
      if (!selectedToken) throw Object.assign(new Error('Informe o token para o modo escolhido.'), { userInput: true });
      if (!/^[A-Za-z0-9._-]{1,512}$/.test(selectedToken)) throw Object.assign(new Error('O token salvo é inválido. Cole um novo token.'), { userInput: true });
      const updates = { DISCORD_MODE: mode, [key]: selectedToken };
      await fs.promises.writeFile(temporary, updateEnv(source, updates), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.promises.rename(temporary, this.file);
      this.values = { ...values, ...updates };
      return this.status();
    } catch (error) {
      if (error.userInput) throw error;
      throw new Error('Não foi possível salvar a conexão no arquivo .env. Verifique a permissão de escrita.');
    } finally {
      try { await fs.promises.unlink(temporary); } catch {}
      this.saving = false;
    }
  }
}

module.exports = { ConnectionSettings, resolveDiscordAuth, selfbotSafety };
