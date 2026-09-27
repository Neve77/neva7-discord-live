const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { execFile } = require('node:child_process');
const { getFfmpegPath } = require('./ffmpeg');

const RATE = 16000, BYTES_PER_SECOND = RATE * 2;
function wavHeader(bytes) {
  const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+bytes,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);
  h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(RATE,24);h.writeUInt32LE(BYTES_PER_SECOND,28);
  h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(bytes,40);return h;
}
function writeAll(fd,buffer,position) {
  return new Promise((resolve,reject)=>{
    let offset=0;
    const next=()=>fs.write(fd,buffer,offset,buffer.length-offset,position+offset,(error,count)=>{
      if(error)return reject(error);if(!count)return reject(new Error('Escrita de áudio incompleta.'));
      offset+=count;if(offset<buffer.length)next();else resolve();
    });next();
  });
}
function mixTracks(files,output) {
  return new Promise((resolve,reject)=>{
    const args=['-y','-hide_banner','-loglevel','error',...files.flatMap(file=>['-i',file]),'-filter_complex',
      `amix=inputs=${files.length}:duration=longest:normalize=0,alimiter=limit=0.95:level=false:latency=true`,
      '-ar',String(RATE),'-ac','1','-c:a','pcm_s16le',output];
    execFile(getFfmpegPath(),args,{windowsHide:true,timeout:300000,maxBuffer:64*1024},error=>error?reject(error):resolve());
  });
}
function processAlive(pid){if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
class CallRecordings {
  constructor({root=path.join(__dirname,'../recordings'),clock=()=>performance.now(),mix=mixTracks,write=writeAll,isProcessAlive=processAlive,onStop=()=>{},maxDurationMs=2*60*60*1000,maxBytes=2*1024**3,maxQueuedBytes=8*1024**2,maxTracks=32}={}) {
    Object.assign(this,{root:path.resolve(root),clock,mix,write,isProcessAlive,onStop,maxDurationMs,maxBytes,maxQueuedBytes,maxTracks});
    this.active=new Map();this.finishing=new Set();this.recent=new Map();this.lastError='';
  }
  isActive(guildId){return this.active.has(guildId);}
  save(record){const file=path.join(record.directory,'manifest.json');fs.writeFileSync(file+'.tmp',JSON.stringify(record.meta,null,2)+'\n',{mode:0o600});fs.renameSync(file+'.tmp',file);}
  start(guildId,channelId) {
    if(this.active.has(guildId))throw new Error('Esta call já está sendo gravada.');
    if(this.finishing.size>=4)throw new Error('Aguarde a finalização das gravações anteriores.');
    const id=new Date().toISOString().replace(/[:.]/g,'-')+'_'+randomUUID();
    const directory=path.join(this.root,id);fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const meta={id,guildId,channelId,pid:process.pid,startedAt:Date.now(),endedAt:null,durationMs:0,state:'recording',reason:'',error:'',mixedFile:null,tracks:[]};
    const record={directory,meta,started:this.clock(),tracks:new Map(),queued:0,logicalBytes:0};
    this.save(record);this.active.set(guildId,record);this.lastError='';
    record.timer=setTimeout(()=>this.stop(guildId,'duration-limit'),this.maxDurationMs);record.timer.unref?.();
    return this.snapshot(guildId);
  }
  snapshot(guildId){const r=this.active.get(guildId);return r?{...r.meta,durationMs:Math.max(0,this.clock()-r.started),bytes:r.logicalBytes,trackCount:r.tracks.size}:null;}
  capture(guildId,userId,name,pcm,{bot=false}={}) {
    const r=this.active.get(guildId);if(!r||!Buffer.isBuffer(pcm)||!pcm.length||pcm.length%2)return;
    const elapsed=Math.max(0,this.clock()-r.started);
    if(elapsed>=this.maxDurationMs){this.stop(guildId,'duration-limit');return;}
    try {
      let track=r.tracks.get(userId);
      if(!track){
        if(r.tracks.size>=this.maxTracks){this.stop(guildId,'track-limit');return;}
        const file='track-'+randomUUID()+'.wav',fd=fs.openSync(path.join(r.directory,file),'wx',0o600);
        try{fs.writeSync(fd,wavHeader(0));}catch(error){fs.closeSync(fd);throw error;}
        const meta={userId:String(userId),name:String(name||userId).slice(0,128),bot,file,bytes:0};
        track={fd,meta,end:0,chain:Promise.resolve(),error:null};r.tracks.set(userId,track);r.meta.tracks.push(meta);this.save(r);
      }
      // Timestamped sparse writes preserve silences and overlapping speakers.
      // Ignore jitter under 40 ms; received packets in a burst stay contiguous.
      const desired=Math.max(0,Math.round(elapsed*RATE/1000)*2-pcm.length);
      const start=desired>track.end+BYTES_PER_SECOND*.04?desired:track.end,end=start+pcm.length;
      const growth=end-track.end;
      if(end>this.maxDurationMs/1000*BYTES_PER_SECOND||r.logicalBytes+growth>this.maxBytes){this.stop(guildId,'size-limit');return;}
      if(r.queued+pcm.length>this.maxQueuedBytes){this.fail(r,'O disco não acompanhou o áudio. A gravação foi interrompida.');return;}
      const copy=Buffer.from(pcm);track.end=end;track.meta.bytes=end;r.logicalBytes+=growth;r.queued+=copy.length;
      track.chain=track.chain.then(async()=>{
        if(track.error)return;
        await this.write(track.fd,copy,44+start);
        // Each committed packet leaves a playable header, even after a crash.
        await this.write(track.fd,wavHeader(end),0);
      }).catch(()=>{track.error=true;this.fail(r,'Não foi possível gravar no disco. Confira espaço e permissões.');}).finally(()=>{r.queued-=copy.length;});
    } catch {this.fail(r,'Não foi possível criar o arquivo de áudio. Confira espaço e permissões.');}
  }
  fail(record,message){record.meta.error=message;this.lastError=message;if(this.active.get(record.meta.guildId)===record)this.stop(record.meta.guildId,'disk-error');}
  stop(guildId,reason='operator') {
    const r=this.active.get(guildId);if(!r)return Promise.resolve(null);
    this.active.delete(guildId);clearTimeout(r.timer);r.meta.state='finishing';r.meta.reason=reason;r.meta.endedAt=Date.now();r.meta.durationMs=Math.min(this.maxDurationMs,Math.max(0,this.clock()-r.started));
    try{this.onStop(guildId);}catch{}
    try{this.save(r);}catch{r.meta.error='Não foi possível atualizar os dados da gravação.';}
    const task=this.finish(r).catch(()=>{this.lastError='Falha ao finalizar a gravação. As faixas já escritas foram preservadas.';r.meta.state='partial';r.meta.error=this.lastError;return r.meta;}).then(meta=>{this.recent.set(meta.id,meta);if(this.recent.size>100)this.recent.delete(this.recent.keys().next().value);return meta;});
    this.finishing.add(task);task.finally(()=>this.finishing.delete(task));return task;
  }
  async finish(r) {
    await Promise.all([...r.tracks.values()].map(t=>t.chain));
    const durationBytes=Math.min(Math.floor(r.meta.durationMs*RATE/1000)*2,Math.floor(this.maxDurationMs/1000)*BYTES_PER_SECOND);
    for(const t of r.tracks.values()) {
      try {
        // Finalize from committed disk bytes when a write failed; keep partial audio.
        let bytes=t.error?Math.max(0,fs.fstatSync(t.fd).size-44):t.end;
        bytes-=bytes%2;
        const padded=Math.max(bytes,durationBytes);
        if(!t.error&&r.logicalBytes+padded-bytes<=this.maxBytes){fs.ftruncateSync(t.fd,44+padded);r.logicalBytes+=padded-bytes;bytes=padded;}
        fs.writeSync(t.fd,wavHeader(bytes),0,44,0);t.meta.bytes=bytes;
      }catch{r.meta.error='Uma faixa foi salva parcialmente por falha no disco.';}
      finally{try{fs.closeSync(t.fd);}catch{}}
    }
    const files=r.meta.tracks.filter(t=>t.bytes>0).map(t=>path.join(r.directory,t.file));
    if(files.length&&!r.meta.error){
      try{await this.mix(files,path.join(r.directory,'call.wav'));r.meta.mixedFile='call.wav';}
      catch{r.meta.error='As faixas individuais foram salvas, mas a mixagem falhou. Confira o FFmpeg e o espaço no disco.';}
    }
    r.meta.state=r.meta.error?'partial':'saved';this.save(r);return r.meta;
  }
  stopAll(reason='shutdown'){return Promise.all([...this.active.keys()].map(gid=>this.stop(gid,reason)));}
  async close(){await this.stopAll();await Promise.all([...this.finishing]);}
  read(id) {
    if(!/^[A-Za-z0-9_-]{10,100}$/.test(id))throw new Error('Gravação inválida.');
    const directory=path.join(this.root,id);
    if(fs.lstatSync(directory).isSymbolicLink())throw new Error('Gravação inválida.');
    const meta=this.recent.get(id)||JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
    if(meta.id!==id||!Array.isArray(meta.tracks))throw new Error('Gravação inválida.');
    if(['recording','finishing'].includes(meta.state)&&meta.pid!==process.pid){
      if(!this.isProcessAlive(meta.pid)){meta.state='interrupted';for(const track of meta.tracks){
        if(/^track-[a-f0-9-]{36}\.wav$/.test(track.file))try{track.bytes=Math.max(0,fs.statSync(path.join(directory,track.file)).size-44);}catch{}
      }meta.durationMs=Math.max(0,...meta.tracks.map(t=>Number(t.bytes)||0))/BYTES_PER_SECOND*1000;}
    }
    return meta;
  }
  list() {
    if(!fs.existsSync(this.root))return {root:this.root,recordings:[],active:[],error:this.lastError};
    const recordings=[];
    for(const id of fs.readdirSync(this.root).sort().reverse().slice(0,100)) {
      try{const meta=this.read(id);const active=this.active.get(meta.guildId);const value=active?.meta.id===id?this.snapshot(meta.guildId):meta;
        recordings.push(value);
      }catch{}
    }
    return {root:this.root,recordings,active:[...this.active.keys()].map(gid=>this.snapshot(gid)),error:this.lastError};
  }
  file(id,name) {
    if(name!=='call.wav'&&!/^track-[a-f0-9-]{36}\.wav$/.test(name))throw new Error('Arquivo inválido.');
    const meta=this.read(id);
    if(['recording','finishing'].includes(meta.state))throw new Error('Aguarde finalizar a gravação.');
    if(name!==meta.mixedFile&&!meta.tracks.some(t=>t.file===name))throw new Error('Arquivo não encontrado.');
    const file=path.join(this.root,id,name),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Arquivo inválido.');
    return {path:file,size:stat.size};
  }
}
module.exports={CallRecordings,wavHeader,mixTracks,RATE};
