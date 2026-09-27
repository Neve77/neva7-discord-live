const fs = require('fs');
const http = require('http');
const path = require('path');

const ASSETS = {
  '/': ['live/dashboard.html', 'text/html; charset=utf-8'],
  '/app.css': ['live/dashboard.css', 'text/css; charset=utf-8'],
  '/app.js': ['live/dashboard.js', 'application/javascript; charset=utf-8'],
  '/live': ['live/dashboard.html', 'text/html; charset=utf-8'],
  '/live.css': ['live/dashboard.css', 'text/css; charset=utf-8'],
  '/live.js': ['live/dashboard.js', 'application/javascript; charset=utf-8'],
  '/panel-classic.js': ['live/dashboard-classic.js', 'application/javascript; charset=utf-8'],
  '/panel-recordings.js': ['live/dashboard-recordings.js', 'application/javascript; charset=utf-8'],
  '/panel-help.js': ['live/dashboard-help.js', 'application/javascript; charset=utf-8']
};

function isLocal(address = '') {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function json(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(data));
}

function text(res, code, data, type) {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(data);
}

async function readBody(req, maxBytes = 16 * 1024) {
  const parts = [];
  let bytes = 0;
  for await (const part of req) {
    bytes += part.length;
    if (bytes > maxBytes) throw new Error('Solicitação muito grande.');
    parts.push(part);
  }
  if (!parts.length) return {};
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new Error('JSON inválido.'); }
}

class WebPanel {
  constructor(controller, { port = 3210, host = '127.0.0.1', onShutdown = () => {} } = {}) {
    Object.assign(this, { controller, port, host, onShutdown });
    this.server = null;
    this.url = '';
  }

  async start() {
    if (this.server) return this.url;
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    this.url = `http://${this.host}:${address.port}`;
    return this.url;
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise(resolve => server.close(resolve));
  }

  async handle(req, res) {
    if (!isLocal(req.socket.remoteAddress)) return json(res, 403, { error: 'Painel disponível apenas neste computador.' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    try {
      const host=req.headers.host,port=req.socket.localPort;
      if (![ `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}` ].includes(host) ||
          (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site']==='cross-site') {
        return json(res,403,{error:'Acesse pelo painel local.'});
      }
      if(req.method==='POST' && !/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(res,415,{error:'Envie JSON.'});
      if(req.method==='GET'&&pathname==='/api/recordings')return json(res,200,this.controller.voice?.recordings?.list()||{root:'',recordings:[],active:[]});
      if(req.method==='GET'&&pathname.startsWith('/api/recordings/')){
        const parts=pathname.split('/');if(parts.length!==5)throw new Error('Arquivo inválido.');
        const store=this.controller.voice?.recordings;if(!store)throw new Error('Gravação indisponível.');
        const file=store.file(parts[3],parts[4]);return this.audio(req,res,file,parts[4],url.searchParams.has('download'));
      }
      if(pathname.startsWith('/api/live')) {
        const live=this.controller.live;
        if(!live)throw new Error('Reinicie o bot para carregar o módulo Live.');
        if(req.method==='GET' && pathname==='/api/live')return json(res,200,live.snapshot());
        if(req.method==='GET' && pathname==='/api/live/replay')return json(res,200,{sessions:live.snapshot().sessions.map(s=>({guildId:s.guildId,events:s.telemetry.events}))});
        if(req.method==='POST' && pathname==='/api/live/lab')return json(res,200,live.lab(await readBody(req)));
        if(req.method==='POST' && pathname==='/api/live/test-voice') {
          const body=await readBody(req,2048);
          return json(res,200,await live.testVoice(String(body.guildId||''),body.text));
        }
        if(req.method==='POST' && pathname==='/api/live/action') {
          const body=await readBody(req);
          return json(res,200,{message:live.command(body.action,body.value),...live.snapshot()});
        }
      }
      if (req.method === 'POST' && pathname === '/api/connection') {
        const host = req.headers.host;
        const port = req.socket.localPort;
        const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
        if (!localHosts.includes(host) || (req.headers.origin && req.headers.origin !== `http://${host}`) ||
            req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Salve a conexão pela Central web local.' });
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Envie a configuração em JSON.' });
        if (!this.controller.connectionSettings) throw new Error('Configuração de conexão indisponível.');
        const connection = await this.controller.connectionSettings.save(await readBody(req, 2048));
        return json(res, 200, { ok: true, connection, message: 'Conexão salva. Reinicie o programa para aplicar.' });
      }
      if (req.method === 'GET' && ASSETS[pathname]) {
        const [file, type] = ASSETS[pathname];
        const source = await fs.promises.readFile(path.join(__dirname, file), 'utf8');
        return text(res, 200, source, type);
      }
      if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, { status: this.controller.status() });
      if (req.method === 'GET' && pathname === '/api/catalog') return json(res, 200, await this.catalog());
      if (req.method === 'GET' && pathname === '/api/sound-effects') {
        const effects = await this.controller.listSoundEffects?.() || [];
        return json(res, 200, { effects });
      }
      if (req.method === 'GET' && pathname.startsWith('/api/sound-effects/')) {
        const fileName = decodeURIComponent(pathname.replace('/api/sound-effects/', ''));
        const { resolveSoundEffect, mimeFor } = require('./sound-effects');
        const filePath = resolveSoundEffect(fileName);
        const stat = fs.statSync(filePath);
        const range = req.headers.range || '';
        let start = 0, end = stat.size - 1;
        if (range) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (m) {
            if (m[1]) start = Number(m[1]);
            if (m[2]) end = Math.min(end, Number(m[2]));
          }
        }
        res.writeHead(range ? 206 : 200, {
          'Content-Type': mimeFor(filePath),
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': `inline; filename="${path.basename(filePath)}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {})
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/members') {
        const query = url.searchParams.get('q') || '';
        return json(res, 200, this.controller.findMembers ? await this.controller.findMembers(query)
          : { members: await this.controller.searchMembers(query) });
      }
      if (req.method === 'GET' && pathname === '/api/message-access') return json(res, 200, await this.controller.checkMessageAccess());
      if (req.method === 'POST' && pathname === '/api/action') {
        const body = await readBody(req);
        const message = await this.action(body.action, body.value);
        return json(res, 200, { ok: true, message, status: this.controller.status() });
      }
      return json(res, 404, { error: 'Rota não encontrada.' });
    } catch (error) {
      return json(res, 400, { error: error.message || 'Não foi possível concluir a ação.' });
    }
  }

  async catalog() {
    return {
      servers: await this.controller.listServers(),
      textChannels: this.controller.textChannels(),
      voiceChannels: this.controller.voiceChannels(),
      emotions: this.controller.settings.listEmotions(),
      voices: this.controller.settings.listVoices(),
      voiceProfiles: this.controller.settings.listVoiceProfiles?.() || this.controller.settings.listVoices().map(id => ({ id, name: id, timbre: 'neutro', style: 'Vers\u00e1til' })),
      voiceProfileNote: 'Timbre \u00e9 uma refer\u00eancia pr\u00e1tica de escolha; o Gemini documenta estilos, n\u00e3o g\u00eanero.'
    };
  }

  audio(req,res,file,name,download=false){
    let start=0,end=file.size-1,partial=false;
    if(req.headers.range){
      const range=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if(!range||!range[1]&&!range[2]){res.writeHead(416,{'Content-Range':`bytes */${file.size}`});res.end();return;}
      if(!range[1])start=Math.max(0,file.size-Number(range[2]));
      else{start=Number(range[1]);if(range[2])end=Math.min(end,Number(range[2]));}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=file.size){res.writeHead(416,{'Content-Range':`bytes */${file.size}`});res.end();return;}
      partial=true;
    }
    const headers={'Content-Type':'audio/wav','Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`${download?'attachment':'inline'}; filename="${name}"`};
    if(partial)headers['Content-Range']=`bytes ${start}-${end}/${file.size}`;
    const stream=fs.createReadStream(file.path,{start,end});stream.once('error',()=>{if(!res.headersSent)json(res,404,{error:'Arquivo indisponível.'});else res.destroy();});
    stream.once('open',()=>{res.writeHead(partial?206:200,headers);stream.pipe(res);});res.once('close',()=>stream.destroy());
  }

  async action(action, value = {}) {
    const api = this.controller;
    const string = key => String(value?.[key] ?? '');
    switch (action) {
      case 'selectServer': {
        const server = (await api.listServers()).find(item => item.id === string('id'));
        if (!server) throw new Error('Servidor não encontrado. Atualize a página e tente de novo.');
        await api.selectServer(server);
        return `Servidor selecionado: ${server.name}`;
      }
      case 'selectText': {
        const channel = api.textChannels().find(item => item.id === string('id'));
        if (!channel) throw new Error('Canal de texto não encontrado.');
        api.selectTextChannel(channel);
        return `Canal selecionado: #${channel.name}`;
      }
      case 'join': return api.join(string('channelId') || null);
      case 'leave': return api.leave();
      case 'say': return api.say(string('text'));
      case 'repeat': return api.repeatLastSpeech();
      case 'announce': return api.announce(string('text'));
      case 'play': return api.play(string('query'));
      case 'skip': return api.skip();
      case 'stopMusic': return api.stopMusic();
      case 'stopAll': return api.stopAll();
      case 'recordingStart': return api.startRecording();
      case 'recordingStop': return api.stopRecording();
      case 'volume': return api.setVolume(string('value'));
      case 'emotion': return api.setEmotion(string('name'));
      case 'customEmotion': return api.setCustomEmotion(string('text'));
      case 'interaction': return api.setInteraction(string('text'));
      case 'voice': return api.setVoice(string('name'));
      case 'speed': return api.setSpeed(string('value'));
      case 'presence': return api.setBotPresence(value);
      case 'soundImport': return api.importSoundEffect ? await api.importSoundEffect(value) : 'Efeito salvo.';
      case 'soundPlay': return api.playSoundEffect ? await api.playSoundEffect(value) : 'Efeito tocado.';
      case 'listening': return api.toggleListening();
      case 'autoJoin': return api.toggleOption('autoJoinOnMention');
      case 'replyInText': return api.toggleOption('replyInTextToo');
      case 'send': return api.send(string('text'));
      case 'mention': return api.mention(string('userId'), string('text'));
      case 'clearContext': return api.clearContext();
      case 'summarize': return api.summarize();
      case 'alive': return api.toggleAlive();
      case 'aliveChannel': return api.toggleAliveChannel();
      case 'diagnostics': return api.diagnostics();
      case 'shutdown':
        setTimeout(() => this.onShutdown(), 0);
        return 'Encerrando o bot…';
      default: throw new Error('Ação inválida.');
    }
  }
}

module.exports = { WebPanel, isLocal, readBody };
