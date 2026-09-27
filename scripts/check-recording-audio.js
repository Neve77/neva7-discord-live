// End-to-end local WAV mixing check with synthetic samples only.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {CallRecordings}=require('../src/call-recordings');
const prefix=path.join(os.tmpdir(),'neva-recording-audio-'),root=fs.mkdtempSync(prefix);let now=0;
const recorder=new CallRecordings({root,clock:()=>now});
function tone(value){const pcm=Buffer.alloc(6400);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(value,i);return pcm;}
(async()=>{
  recorder.start('synthetic','test');now=200;recorder.capture('synthetic','one','Sinal 1',tone(1000));recorder.capture('synthetic','two','Sinal 2',tone(2000));now=400;
  const saved=await recorder.stop('synthetic');assert.equal(saved.state,'saved',saved.error);assert.equal(saved.tracks.length,2);
  const wav=fs.readFileSync(recorder.file(saved.id,saved.mixedFile).path);assert.equal(wav.toString('ascii',0,4),'RIFF');let data;
  for(let i=12;i+8<=wav.length;){const tag=wav.toString('ascii',i,i+4),size=wav.readUInt32LE(i+4);if(tag==='data'){data=wav.subarray(i+8,i+8+size);break;}i+=8+size+(size%2);}
  assert.ok(data?.length>=12800);assert.ok(Math.abs(data.readInt16LE(1000)-3000)<=2,'A mixagem deve somar as duas faixas simultâneas.');assert.equal(data.readInt16LE(12000),0,'A pausa final deve continuar silenciosa.');
  console.log('OK: duas vozes sintéticas sincronizadas → FFmpeg → call.wav reproduzível, com sobreposição e pausas preservadas.');
})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{await recorder.close();assert.ok(path.resolve(root).startsWith(path.resolve(prefix)));fs.rmSync(root,{recursive:true,force:true});});
