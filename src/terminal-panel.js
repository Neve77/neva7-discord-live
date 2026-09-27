const readline = require('readline');
const { format, stripVTControlCharacters } = require('util');

const { menuText, fit } = require('./terminal-ui');

// Nomes e mensagens vindos do Discord não podem controlar o cursor do terminal.
function plain(value) {
  return stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
}

class TerminalPanel {
  constructor(controller, { input = process.stdin, output = process.stdout, onShutdown = () => {},
    consoleObject = console, createInterface = readline.createInterface } = {}) {
    Object.assign(this, { controller, input, output, onShutdown, consoleObject, createInterface });
    this.running = false;
    this.logs = [];
    this.notice = '';
    this.pending = null;
    this.mode = 'action';
    this.color = !Object.hasOwn(process.env, 'NO_COLOR');
  }

  start() {
    if (this.running || !this.input.isTTY || !this.output.isTTY) return;
    this.running = true;
    this.rl = this.createInterface({ input: this.input, output: this.output, terminal: true });
    this.rl.on('SIGINT', () => { this.stop(); this.onShutdown(); });
    this.rl.on('close', () => this.stop());
    this.output.write('\x1b[?1049h');
    this.enteredScreen = true;
    this.refreshTimer = setInterval(() => {
      if (this.mode === 'menu' && this.pending) this.render(true);
    }, 1000);
    this.refreshTimer.unref?.();
    this.originalConsole = {};
    for (const method of ['log', 'info', 'warn', 'error']) {
      this.originalConsole[method] = this.consoleObject[method];
      this.consoleObject[method] = (...args) => this.log(format(...args));
    }
    this.done = this.run().catch(error => {
      this.stop();
      this.consoleObject.error('Painel encerrado:', error.message);
    });
    return this.done;
  }

  log(text) {
    const line = plain(text).slice(0, 2000);
    this.logs.push(line);
    if (this.logs.length > 100) this.logs.shift();
    // Os eventos ficam no rodapé e na opção 22; não empurram o menu nem a entrada.
  }

  write(text) { this.output.write(plain(text) + '\n'); }

  render(restorePrompt = false) {
    const columns = this.output.columns || 88;
    const status = this.controller.status();
    const body = menuText(status, columns, { color: this.color, rows: this.output.rows || 30 });
    const feedback = this.notice || this.logs.at(-1) || 'Digite uma opção e Enter. Ctrl+C desliga.';
    const footer = '  ' + fit(feedback, Math.max(24, columns - 4));
    const screen = body + '\n' + footer + '\n';
    if (restorePrompt && screen === this.lastScreen) return;
    this.lastScreen = screen;
    this.output.write('\x1b[?25l\x1b[H\x1b[2J' + screen + '\x1b[?25h');
    if (restorePrompt) this.rl.prompt(true);
  }

  ask(prompt) {
    if (!this.running) return Promise.resolve(null);
    return new Promise(resolve => {
      this.pending = resolve;
      this.rl.question(plain(prompt), answer => {
        this.pending = null;
        resolve(answer.trim());
      });
    });
  }

  async choose(title, items) {
    if (!items.length) throw new Error('Nenhuma opção disponível. Verifique o servidor e as permissões do bot.');
    this.write(`\n${title}`);
    items.forEach((item, i) => this.write(`  ${i + 1}. ${item.label || item.name}`));
    const answer = await this.ask('Número (Enter cancela): ');
    if (!answer) return null;
    if (!/^\d+$/.test(answer) || !items[Number(answer) - 1]) throw new Error('Opção inválida. Escolha um número da lista.');
    return items[Number(answer) - 1];
  }

  async withInput(prompt, action) {
    const answer = await this.ask(prompt + ' (Enter cancela): ');
    return answer ? action(answer) : 'Cancelado.';
  }

  async run() {
    this.write('Carregando painel...');
    try { await this.controller.initialize(); }
    catch (error) { this.notice = `Não consegui carregar os servidores: ${error.message}. Tente a opção 1.`; }
    while (this.running) {
      this.mode = 'menu';
      this.render();
      const answer = await this.ask('  Escolha > ');
      if (answer === null) break;
      this.mode = 'action';
      this.output.write('\x1b[H\x1b[2J');
      this.write('  PAINEL DO BOT\n');
      try {
        const result = await this.execute(answer.replace(/^0+(?=\d)/, '')) || '';
        if (this.running && result.includes('\n')) {
          this.write(result);
          await this.ask('\nEnter para voltar: ');
          this.notice = '';
        } else this.notice = result;
      }
      catch (error) { this.notice = 'Erro: ' + error.message; }
    }
  }

  async execute(choice) {
    const api = this.controller;
    switch (choice.toLowerCase()) {
      case '': case '0': case 'menu': case 'ajuda': case 'status': return '';
      case '1': {
        const server = await this.choose('Servidores', await api.listServers());
        if (server) { await api.selectServer(server); return `Servidor selecionado: ${server.name}`; }
        return 'Cancelado.';
      }
      case '2': {
        await api.refreshChannels();
        const channel = await this.choose('Canais de texto', api.textChannels());
        if (channel) { api.selectTextChannel(channel); return `Canal selecionado: #${channel.name}`; }
        return 'Cancelado.';
      }
      case '3': {
        await api.refreshChannels();
        const channel = await this.choose('Entrar na call', [
          { id: null, name: 'Seguir minha call (OWNER_ID)' }, ...api.voiceChannels()
        ]);
        return channel ? api.join(channel.id) : 'Cancelado.';
      }
      case '4': return api.leave();
      case '5': return api.say('Teste de voz, um dois três. Tá me ouvindo?');
      case '6': return this.withInput('Frase para falar na call', text => api.say(text));
      case '7': return this.withInput('Nome e artista, link do YouTube ou arquivo em musicas', query => {
        this.write('\nBuscando áudio...');
        return api.play(query);
      });
      case '8': return api.queue();
      case '9': return api.skip();
      case '10': return api.stopMusic();
      case '11': return this.withInput('Volume de 0 a 200', value => api.setVolume(value));
      case '12': {
        const emotion = await this.choose('Emoções', [
          ...api.settings.listEmotions().map(name => ({ name })), { name: 'Personalizada...', custom: true }
        ]);
        if (!emotion) return 'Cancelado.';
        return emotion.custom ? this.withInput('Descreva a personalidade', text => api.setCustomEmotion(text)) : api.setEmotion(emotion.name);
      }
      case '13': {
        const voice = await this.choose('Vozes', api.settings.listVoices().map(name => ({ name })));
        return voice ? api.setVoice(voice.name) : 'Cancelado.';
      }
      case '14': return this.withInput('Velocidade de 0,25 a 4 (1 = normal)', value => api.setSpeed(value));
      case '15': return api.toggleListening();
      case '16':
        api.requireTextChannel();
        return this.withInput(`Mensagem para #${api.textChannel.name}`, text => api.send(text));
      case '17': return api.toggleAlive();
      case '18': return api.toggleAliveChannel();
      case '19': return api.toggleOption('autoJoinOnMention');
      case '20': return api.toggleOption('replyInTextToo');
      case '21': return api.summarize();
      case '22':
        this.write('\nÚltimos logs:\n' + (this.logs.slice(-30).join('\n') || 'Nenhum log nesta sessão.'));
        await this.ask('\nEnter para voltar: ');
        return '';
      case '23': case 'diag': case 'diagnostico': return api.diagnostics();
      case '24': case 'repetir': return api.repeatLastSpeech();
      case '25':
        api.requireTextChannel();
        api.requireVoice();
        return this.withInput('Anúncio para texto e call (até 400 caracteres)', text => api.announce(text));
      case '99': case 'encerrar':
        this.stop();
        await this.onShutdown();
        return 'Bot desligado.';
      default: throw new Error('Opção inválida. Digite um dos números do menu.');
    }
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.refreshTimer);
    const pending = this.pending;
    this.pending = null;
    if (pending) pending(null);
    this.rl.close();
    if (this.enteredScreen) this.output.write('\x1b[?25h\x1b[?1049l');
    this.enteredScreen = false;
    for (const [method, original] of Object.entries(this.originalConsole || {})) this.consoleObject[method] = original;
  }
}

module.exports = { TerminalPanel, menuText };
