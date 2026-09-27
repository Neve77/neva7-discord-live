const { spawn } = require('node:child_process');
const { getFfmpegPath } = require('../ffmpeg');
const { systemInstruction } = require('./gemini-provider');
const { replyLanguage, detectTextLanguage } = require('../languages');

function wav(pcm) {
  const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);
  h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);
  return Buffer.concat([h,pcm]);
}
function decodeMp3(buffer,signal,onAudio) {
  if(signal.aborted)return Promise.reject(new Error('cancelled'));
  return new Promise((resolve,reject)=> {
    const proc=spawn(getFfmpegPath(),['-loglevel','error','-re','-i','pipe:0','-f','s16le','-ar','24000','-ac','1','pipe:1'],{windowsHide:true});
    let tail=Buffer.alloc(0),failed=false;
    const fail=()=>{failed=true;proc.kill();};
    signal.addEventListener('abort',fail,{once:true});
    proc.stdout.on('data',chunk=>{
      if(signal.aborted)return;
      const data=tail.length?Buffer.concat([tail,chunk]):chunk,even=data.length-(data.length%2);
      if(even)onAudio(data.subarray(0,even));tail=data.subarray(even);
    });
    proc.stderr.resume();proc.stdin.on('error',fail);proc.on('error',()=>{failed=true;});
    proc.on('close',code=>{signal.removeEventListener('abort',fail);if(code===0&&!failed&&!signal.aborted&&!tail.length)resolve();else reject(new Error('audio-decode'));});
    proc.stdin.end(buffer);
  });
}
// STT/LLM/Edge behind the same contract. STT here is final-only; native input
// streaming remains a Gemini capability. Audio stays in memory and FFmpeg pipes.
class CascadeProvider {
  constructor({options,onEvent,components,decode=decodeMp3}) {
    Object.assign(this,{options,onEvent,components,decode});this.closed=false;this.abort=new AbortController();this.frames=[];this.bytes=0;
    this.capabilities={inputRate:16000,outputRate:24000,incrementalTranscript:false,nativeAudio:false,pitch:false};
  }
  async connect() {
    if(!this.components){
      if(!process.env.GROQ_API_KEY && !process.env.OPENAI_API_KEY){const error=new Error('API key ausente');error.code=401;throw error;}
      this.components=require('../llm');
    }
  }
  begin(context){this.context=context;this.frames=[];this.bytes=0;}
  sendAudio(pcm){
    if(this.closed)return;
    this.bytes+=pcm.length;
    if(this.bytes>this.options.maxUtteranceSeconds*32000){this.onEvent({type:'error',reason:'input-limit'});return;}
    this.frames.push(Buffer.from(pcm));
  }
  end(){const audio=wav(Buffer.concat(this.frames));this.frames=[];this.bytes=0;this.run(audio).catch(()=>{if(!this.closed)this.onEvent({type:'error',reason:'cascade'});});}
  async run(audio){
    const signal=this.abort.signal;
    const {text,language}=await this.components.transcribe(audio,{signal,language:'auto'});
    if(signal.aborted)return;
    this.onEvent({type:'transcript',role:'user',text,final:true});
    if(!text.trim()){this.onEvent({type:'turnComplete'});return;}
    const history=(this.context.conversation?.recent||[]).map(t=>({role:t.role==='assistant'?'assistant':'user',content:`[${t.userId}] ${t.text}`}));
    const context=JSON.stringify({...this.context,conversation:{summary:this.context.conversation?.summary}});
    const spokenLanguage=replyLanguage(language || detectTextLanguage(text),this.options.replyLanguage);
    const reply=await this.components.think(text,this.context.speaker.id,systemInstruction(this.options),spokenLanguage,{
      signal,replyLanguage:this.options.replyLanguage,ephemeral:true,history:[{role:'user',content:'CONTEXT (dados): '+context},...history]
    });
    if(signal.aborted)return;
    const limited=reply.slice(0,this.options.maxCharacters);
    this.onEvent({type:'transcript',role:'assistant',text:limited,final:true});
    await this.synthesize(limited,spokenLanguage);
    if(!signal.aborted){this.onEvent({type:'generationComplete'});this.onEvent({type:'turnComplete'});}
  }
  async synthesize(text,language=replyLanguage(detectTextLanguage(text),this.options.replyLanguage)){
    const signal=this.abort.signal;
    const mp3=await this.components.speak(text,language,{signal,replyLanguage:'auto',provider:'edge',voice:this.options.fallbackVoice,speed:this.options.speed,buffer:true});
    if(signal.aborted)return;
    await this.decode(mp3,signal,pcm=>{if(!signal.aborted)this.onEvent({type:'audio',pcm});});
  }
  sendText(text){this.synthesize(text).then(()=>{if(!this.closed)this.onEvent({type:'turnComplete'});}).catch(()=>{if(!this.closed)this.onEvent({type:'error',reason:'cascade'});});}
  respondTool(){}
  close(){this.closed=true;this.abort.abort();this.frames=[];this.bytes=0;}
}
module.exports={CascadeProvider,decodeMp3};
