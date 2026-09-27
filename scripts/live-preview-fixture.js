// Real panel controller with in-memory substitutes. No credentials, network,
// audio device or Discord side effects, including when --qa simulates a call.
const {EventEmitter}=require('node:events');
const {PanelController}=require('../src/panel-controller');
const {LiveService}=require('../src/live/service');
const {LiveSettings}=require('../src/live/settings');
const {PermanentMemory}=require('../src/live/memory');
const {CallRecordings}=require('../src/call-recordings');
function previewController(simulate=false,{recordingRoot}={}){
  const discord=new EventEmitter();Object.assign(discord,{bot:true,connected:simulate,me:{id:'123456789012345678',username:'Prévia local'},users:new Map(),memberRoles:new Map()});
  const channels=[{id:'text',name:'geral · simulado',type:0},{id:'voice',name:'Call · simulada',type:2}];
  const demoMember={user:{id:'234567890123456789',username:'Ana Demo',global_name:'Ana Demo'},roles:[]};
  discord.rest=async route=>{
    if(route.includes('/members/search')||route.includes('/members?'))return [demoMember];
    if(route.endsWith('/members/'+demoMember.user.id))return demoMember;
    if(route.endsWith('/members/'+discord.me.id))return {user:discord.me,roles:[]};
    if(route==='/guilds/demo')return {id:'demo',roles:[{id:'demo',permissions:'3072'}]};
    if(route==='/channels/text')return {...channels[0],guild_id:'demo',permission_overwrites:[]};
    if(route.includes('/messages?'))return [{content:'Conversa de demonstração',author:{username:'Ana Demo'}}];
    if(route.endsWith('/channels'))return channels;
    return [{id:'demo',name:'Servidor de demonstração'}];
  };
  discord.sendMessage=async()=>{if(discord.activityBlocked())throw new Error('Rearme a conversa.');};discord.setBotPresence=p=>{discord.presence=p;};
  const voice={active:new Map(),pending:new Map(),get(id){return this.active.get(id);},setLiveFactory(){},leave(id){this.recordings?.stop(id,'left-call');this.active.get(id)?.live?.close();this.active.delete(id);},
    async join(id,channelId){if(this.liveBlocked())throw new Error('Rearme a conversa.');this.active.set(id,{channelId,deaf:false,speechVol:1,tracks:[],musicState:'parada'});},
    setListen(id,on){this.get(id).deaf=!on;},setVolumes(id,v){this.get(id).speechVol=v.speech;},
    async enqueueMusic(id,tracks){const s=this.get(id);s.tracks.push(...tracks);s.currentTrack=s.tracks[0];s.musicBusy=true;s.musicState='tocando';},
    skipTrack(id){const s=this.get(id);s.tracks.shift();s.currentTrack=s.tracks[0];return true;},
    stopMusic(id){const s=this.get(id);s.tracks=[];s.currentTrack=null;s.musicBusy=false;s.musicState='parada';return true;}
  };
  if(recordingRoot){
    voice.recordings=new CallRecordings({root:recordingRoot,mix:async(files,out)=>require('node:fs').copyFileSync(files[0],out)});
    voice.startRecording=id=>{const s=voice.get(id);if(!s)throw new Error('Entre na call.');const r=voice.recordings.start(id,s.channelId);const tone=Buffer.alloc(3200);for(let i=0;i<tone.length;i+=2)tone.writeInt16LE(Math.round(1200*Math.sin(i*.05)),i);voice.recordings.capture(id,'demo','Áudio sintético de teste',tone);return r;};
    voice.stopRecording=(id,reason)=>voice.recordings.stop(id,reason);
  }
  const state={ttsVoice:'francisca',ttsSpeed:1,current:'natural',interaction:''},config={autoJoinOnMention:false,replyInTextToo:true};
  const settings={state,config,getCurrent:()=>state.current,getInteraction:()=>state.interaction,
    listEmotions:()=>['natural','feliz','seria'],listVoices:()=>['francisca','thalita','antonio'],
    listVoiceProfiles:()=>[{id:'francisca',name:'Francisca',timbre:'feminino',style:'Natural'},{id:'thalita',name:'Thalita',timbre:'feminino',style:'Versátil'},{id:'antonio',name:'Antonio',timbre:'masculino',style:'Calmo'}],
    setEmotion(name){state.current=name;return true;},setCustom(text){state.current='custom: '+text;},setInteraction(text){state.interaction=text;},setVoice(name){state.ttsVoice=name;},setSpeed(value){state.ttsSpeed=value;},setOption(name,value){config[name]=value;},setBotPresence:p=>p
  };
  let connection={mode:'bot',activeMode:'bot',hasBotToken:false,hasSelfbotToken:false,restartRequired:false};
  const connectionSettings={status:()=>connection,async save({mode,token}){if(!['bot','selfbot'].includes(mode))throw new Error('Modo inválido.');const key=mode==='bot'?'hasBotToken':'hasSelfbotToken';if(!token&&!connection[key])throw new Error('Informe um token de demonstração.');connection={...connection,mode,[key]:true,restartRequired:true};return connection;}};
  const alive={enabled:false,channels:new Set(),addChannel(id){this.channels.add(id);},removeChannel(id){this.channels.delete(id);}};
  const controller=new PanelController({discord,voice,alive,settings,connectionSettings,llmInfo:{chatProvider:'Demo local',chatModel:'sem API'},
    sayInVoice:async()=>{if(voice.liveBlocked())throw new Error('Rearme a conversa.');return true;},resolveTrack:async query=>({title:query}),summarizeChannel:async lines=>'Resumo simulado: '+lines.join(' ')});
  controller.live=new LiveService({voice,discord,settings:new LiveSettings({file:null,env:{}}),permanent:new PermanentMemory(null)});
  return controller;
}
module.exports={previewController};
