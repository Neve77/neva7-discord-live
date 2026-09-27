// Exercises the actual streaming encoder/filters with a synthetic tone. No AI,
// Discord, microphone, playback device or saved audio is involved.
require('dotenv').config();
const {Readable}=require('node:stream');
const {streamToOpusOgg}=require('../src/voice');
const {defaults}=require('../src/live/settings');
(async()=>{
  const pcm=Buffer.alloc(24000*2);
  for(let sample=0;sample<24000;sample++)pcm.writeInt16LE(Math.round(2000*Math.sin(2*Math.PI*440*sample/24000)),sample*2);
  const options={...defaults({}),noiseReduction:true,equalizer:2,pitch:2,normalize:true,compressor:true,limiter:true};
  const stream=streamToOpusOgg(Readable.from([pcm]),1,{pcm:true,audioOptions:options});
  let bytes=0,first=true;
  for await(const chunk of stream){
    if(first && chunk.subarray(0,4).toString()!=='OggS')throw new Error('Contêiner de saída inesperado.');
    first=false;bytes+=chunk.length;
  }
  if(first)throw new Error('O encoder não produziu áudio.');
  console.log(`OK: PCM 24 kHz → filtros completos → Ogg/Opus em streaming (${bytes} bytes).`);
})().catch(error=>{console.error(error.message);process.exitCode=1;});
