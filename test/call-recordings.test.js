const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {CallRecordings}=require('../src/call-recordings');
const {WebPanel}=require('../src/web-panel');
const {deferred}=require('./helpers');
const flush=()=>new Promise(r=>setImmediate(r));
function setup(t,options={}){
  const prefix=path.join(os.tmpdir(),'neva-recording-test-'),root=fs.mkdtempSync(prefix);let now=0;
  const mixed=[];const recorder=new CallRecordings({root,clock:()=>now,mix:async(files,out)=>{mixed.push(files);fs.copyFileSync(files[0],out);},...options});
  t.after(async()=>{await recorder.close();assert.ok(path.resolve(root).startsWith(path.resolve(prefix)));fs.rmSync(root,{recursive:true,force:true});});
  return {root,recorder,mixed,at:n=>{now=n;}};
}
function pcm(value=1500){const buffer=Buffer.alloc(640);for(let i=0;i<buffer.length;i+=2)buffer.writeInt16LE(value,i);return buffer;}
test('gravação manual preserva silêncio, sobreposição, faixas e cabeçalhos WAV',async t=>{
  const s=setup(t);s.recorder.capture('g','a','Ana',pcm());assert.equal(fs.readdirSync(s.root).length,0);
  const start=s.recorder.start('g','call');assert.throws(()=>s.recorder.start('g','call'),/já/);
  s.at(100);s.recorder.capture('g','a','Ana',pcm(1000));s.recorder.capture('g','b','Bia',pcm(2000));
  s.at(1100);s.recorder.capture('g','a','Ana',pcm(3000));
  const done=await s.recorder.stop('g');assert.equal(done.id,start.id);assert.equal(done.state,'saved');assert.equal(s.mixed[0].length,2);assert.equal(done.tracks.length,2);
  for(const track of done.tracks){const bytes=fs.readFileSync(s.recorder.file(done.id,track.file).path);assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.readUInt32LE(40),bytes.length-44);assert.equal(bytes.length,44+35200);assert.equal(bytes.readUInt16LE(22),1);assert.equal(bytes.readUInt32LE(24),16000);assert.ok(bytes.subarray(44,44+2560).every(x=>x===0));}
  const a=fs.readFileSync(s.recorder.file(done.id,done.tracks[0].file).path);assert.equal(a.readInt16LE(44+2560),1000);assert.equal(a.readInt16LE(44+34560),3000);
  assert.equal(await s.recorder.stop('g'),null);assert.equal(s.recorder.list().recordings[0].mixedFile,'call.wav');
});
test('falha na mixagem preserva WAVs individuais e informa resultado parcial',async t=>{
  const s=setup(t,{mix:async()=>{throw new Error('ffmpeg failed');}});s.recorder.start('g','c');s.at(20);s.recorder.capture('g','u','Nome',pcm());const done=await s.recorder.stop('g');
  assert.equal(done.state,'partial');assert.match(done.error,/mixagem falhou/);assert.equal(done.mixedFile,null);assert.equal(s.recorder.file(done.id,done.tracks[0].file).size,684);
});
test('limites de disco, duração e participantes encerram a gravação sem afetar outra call',async t=>{
  const s=setup(t,{maxBytes:1000,maxTracks:1,maxDurationMs:10000});s.recorder.start('other','c');s.recorder.start('g','c');s.at(20);s.recorder.capture('g','a','A',pcm());s.recorder.capture('g','b','B',pcm());
  await Promise.all([...s.recorder.finishing]);assert.equal(s.recorder.list().recordings.find(x=>x.guildId==='g').reason,'track-limit');assert.ok(s.recorder.isActive('other'));
  s.recorder.capture('other','u','U',pcm());s.at(100);s.recorder.capture('other','u','U',pcm());await Promise.all([...s.recorder.finishing]);assert.equal(s.recorder.list().recordings.find(x=>x.guildId==='other').reason,'size-limit');
  s.recorder.start('duration','c');s.at(10200);s.recorder.capture('duration','u','U',pcm());await Promise.all([...s.recorder.finishing]);assert.equal(s.recorder.list().recordings.find(x=>x.guildId==='duration').reason,'duration-limit');
});
test('fila de escrita é limitada e erro tardio não encerra uma gravação nova do mesmo servidor',async t=>{
  const queued=setup(t,{maxQueuedBytes:500});queued.recorder.start('g','c');queued.recorder.capture('g','a','A',pcm());assert.equal(queued.recorder.isActive('g'),false);await queued.recorder.close();assert.match(queued.recorder.lastError,/disco não acompanhou/);
  const gate=deferred(),s=setup(t,{write:async()=>{await gate.promise;throw new Error('ENOSPC');}});
  s.recorder.start('g','c');s.at(20);s.recorder.capture('g','a','A',pcm());await flush();const old=s.recorder.stop('g');const next=s.recorder.start('g','c');gate.resolve();await old;assert.equal(s.recorder.snapshot('g').id,next.id);assert.equal(s.recorder.isActive('g'),true);
});
test('gravação após encerramento abrupto continua acessível sem ler arquivos arbitrários',async t=>{
  const s=setup(t,{isProcessAlive:()=>false});s.recorder.start('g','c');s.at(20);s.recorder.capture('g','a','A',pcm());const done=await s.recorder.stop('g');
  const manifest=path.join(s.root,done.id,'manifest.json');fs.writeFileSync(manifest,JSON.stringify({...done,state:'finishing',pid:process.pid+1,mixedFile:null}));
  s.recorder.recent.clear();const restored=s.recorder.list().recordings[0];assert.equal(restored.state,'interrupted');assert.equal(restored.durationMs,20);assert.ok(s.recorder.file(done.id,done.tracks[0].file).size>44);
  assert.throws(()=>s.recorder.file('../..','.env'));assert.throws(()=>s.recorder.file(done.id,'manifest.json'));assert.throws(()=>s.recorder.file(done.id,'track-00000000-0000-0000-0000-000000000000.wav'));
});
test('falha ao salvar manifesto final não deixa o painel preso em finalizando',async t=>{
  const s=setup(t);s.recorder.start('g','c');s.at(20);s.recorder.capture('g','a','A',pcm());s.recorder.save=()=>{throw new Error('disk error');};
  const saved=await s.recorder.stop('g');assert.equal(saved.state,'partial');assert.equal(s.recorder.list().recordings[0].state,'partial');assert.ok(s.recorder.file(saved.id,saved.tracks[0].file).size>44);
});
test('API de gravações permite player com Range e download apenas na origem local',async t=>{
  const s=setup(t);const controller={voice:{recordings:s.recorder},status:()=>({}),startRecording:()=>{s.recorder.start('g','c');return 'iniciada';},stopRecording:async()=>{await s.recorder.stop('g');return 'salva';}};
  const panel=new WebPanel(controller,{port:0}),url=await panel.start();t.after(()=>panel.stop());
  const post=body=>fetch(url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post({action:'recordingStart'})).status,200);s.at(20);s.recorder.capture('g','a','A',pcm());
  const active=(await (await fetch(url+'/api/recordings')).json()).active[0];const route=`${url}/api/recordings/${active.id}/${active.tracks[0].file}`;
  assert.equal((await fetch(route)).status,400);assert.equal((await post({action:'recordingStop'})).status,200);
  const partial=await fetch(route,{headers:{Range:'bytes=0-43'}});assert.equal(partial.status,206);assert.equal((await partial.arrayBuffer()).byteLength,44);assert.match(partial.headers.get('content-range'),/^bytes 0-43\//);
  const download=await fetch(route+'?download=1');assert.match(download.headers.get('content-disposition'),/attachment/);assert.equal(download.headers.get('content-type'),'audio/wav');await download.arrayBuffer();
  assert.equal((await fetch(route,{headers:{Range:'bytes=999999-'}})).status,416);
  assert.equal((await fetch(route,{headers:{Origin:'https://other.invalid'}})).status,403);
  assert.equal((await fetch(url+`/api/recordings/${active.id}/manifest.json`)).status,400);
});
