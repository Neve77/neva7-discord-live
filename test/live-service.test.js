const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {WebPanel}=require('../src/web-panel');
const {LiveService}=require('../src/live/service');
const {LiveSettings,defaults}=require('../src/live/settings');
const {PermanentMemory}=require('../src/live/memory');
const {CascadeProvider}=require('../src/live/cascade-provider');
const flush=()=>new Promise(r=>setImmediate(r));
function setup(){
  const discord=new EventEmitter();discord.bot=true;discord.users=new Map();discord.memberRoles=new Map();
  const voice={active:new Map(),pending:new Map(),get(gid){return this.active.get(gid);},setLiveFactory(f){this.factory=f;},leave(gid){this.active.get(gid)?.live?.close();this.active.delete(gid);}};
  const settings=new LiveSettings({file:null,env:{}}),permanent=new PermanentMemory(null);
  const live=new LiveService({voice,discord,settings,permanent});
  return {voice,discord,settings,live,attach(gid='g'){const s={speechAbort:new AbortController()};voice.active.set(gid,s);s.live=voice.factory(gid,s);return s;}};
}
test('API Live: configuração real, laboratório offline, host/origin e export sem transcrição',async()=>{
  const s=setup(),session=s.attach();
  session.live.memory.add('a','user','segredo de voz');session.live.event('endpoint',{userId:'a',text:'segredo de voz'});
  const panel=new WebPanel({live:s.live},{port:0});const url=await panel.start();
  try {
    const page=await fetch(url+'/live');assert.equal(page.status,200);assert.match(await page.text(),/Conversa Live/);
    const post=(body,headers={})=>fetch(url+'/api/live/action',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    assert.equal((await post({action:'settings',value:{mode:'observer'}})).status,200);assert.equal(s.settings.value.mode,'observer');
    assert.equal((await post({action:'settings',value:{wat:true}})).status,400);
    assert.equal((await post({action:'kill'},{Origin:'https://attacker.invalid'})).status,403);assert.equal(s.settings.value.killed,false);
    const rebound=await new Promise((resolve,reject)=>{const req=require('node:http').get(url+'/api/live',{headers:{Host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
    assert.equal(rebound,403);
    const lab=await (await fetch(url+'/api/live/lab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'Neve, eu queria, mas'})})).json();assert.equal(lab.endpointMs,1600);assert.equal(lab.networkUsed,false);
    assert.ok(!(await (await fetch(url+'/api/live/replay')).text()).includes('segredo de voz'));
    assert.equal((await post({action:'kill'})).status,200);assert.equal(s.voice.active.size,0);assert.equal(s.voice.liveBlocked(),true);
    await post({action:'resume'});assert.equal(s.voice.liveBlocked(),false);
  }finally{session.live.close();await panel.stop();}
});
test('idioma escolhido no painel aplica-se também ao modo clássico sem mudar a conta',()=>{
  const s=setup();const {getConversationLanguage}=require('../src/languages');
  assert.equal(getConversationLanguage(),'auto');s.discord.bot=false;s.live.update({enabled:false,replyLanguage:'es'});
  assert.equal(getConversationLanguage(),'es');assert.equal(s.discord.bot,false);assert.equal(s.settings.value.replyLanguage,'es');
  s.live.update({replyLanguage:'auto'});assert.equal(getConversationLanguage(),'auto');
});
test('retirar função revoga sessão e sair limpa contexto por padrão',()=>{
  const s=setup();s.settings.update({allowRoles:['mod']});const transport=s.attach();
  s.discord.memberRoles.set('g:a',['mod']);const p=transport.live.participant('a');p.turn={id:1,frames:[],bytes:0};transport.live.memory.add('a','user','segredo');
  s.discord.memberRoles.set('g:a',[]);s.discord.emit('memberRolesUpdate',{guild_id:'g',user:{id:'a'}});assert.equal(transport.live.people.size,0);
  s.voice.leave('g');assert.equal(s.live.sessions.size,0);assert.equal(s.live.archives.length,0);assert.equal(transport.live.memory.turns.length,0);
});

test('funções são consultadas uma vez quando desconhecidas e a identidade continua isolada por servidor',async()=>{
  const s=setup();s.settings.update({allowRoles:['mod']});const queries=[];
  s.discord.rest=async path=>{queries.push(path);return {roles:['mod']};};
  assert.equal(s.live.identify('g','a').rolesKnown,false);s.live.identify('g','a');await flush();
  assert.equal(s.live.identify('g','a').rolesKnown,true);assert.equal(queries.length,1);assert.equal(s.live.identify('other','a').rolesKnown,false);
});
test('memória permanente é explícita e desligar retenção apaga arquivos de sessão em RAM',()=>{
  const s=setup();s.settings.update({clearOnLeave:false,retainTranscripts:true});const transport=s.attach();transport.live.memory.add('a','user','segredo');s.voice.leave('g');assert.equal(s.live.archives.length,1);
  s.live.update({retainTranscripts:false});assert.equal(s.live.archives.length,0);
  assert.throws(()=>s.live.command('memorySave',{guildId:'g',userId:'a',text:'nota'}));s.live.update({permanentMemory:true,memoryUsers:['a']});s.live.command('memorySave',{guildId:'g',userId:'a',text:'nota'});assert.equal(s.live.permanent.notes.length,1);
});
test('Cascade compartilha contrato, usa WAV em memória e não grava histórico legado',async()=>{
  const events=[],calls=[];let context;
  const components={transcribe:async buffer=>{assert.equal(buffer.toString('ascii',0,4),'RIFF');return {text:'Neve, oi'};},
    think:async(text,id,prompt,lang,options)=>{context=options;return 'Olá!';},speak:async(text,lang,options)=>{calls.push(options);return Buffer.from('mp3');}};
  const provider=new CascadeProvider({options:defaults({}),onEvent:e=>events.push(e),components,decode:async(b,s,onAudio)=>onAudio(Buffer.alloc(640))});
  await provider.connect();provider.begin({speaker:{id:'a'},conversation:{recent:[{userId:'b',role:'user',text:'contexto'}],summary:'resumo'}});provider.sendAudio(Buffer.alloc(640));provider.end();await flush();
  assert.ok(context.ephemeral);assert.ok(context.history.some(t=>t.content.includes('contexto')));assert.equal(calls[0].buffer,true);assert.equal(calls[0].provider,'edge');assert.equal(events.at(-1).type,'turnComplete');assert.ok(events.some(e=>e.type==='audio'));provider.close();
});
test('Cascade cancelado não entrega transcrição nem áudio tardios',async()=>{
  let resolve;const events=[];const provider=new CascadeProvider({options:defaults({}),onEvent:e=>events.push(e),components:{transcribe:()=>new Promise(r=>resolve=r)}});
  await provider.connect();provider.begin({});provider.sendAudio(Buffer.alloc(640));provider.end();provider.close();resolve({text:'late'});await flush();assert.equal(events.length,0);
});

test('Cascade detecta ES, PT-BR e EN e usa o mesmo idioma no texto e na voz, mesmo com env PT',async()=>{
  for(const [detected,utterance,expected] of [['spanish','Neve, ¿cómo estás?','es-ES'],['portuguese','Neve, como você está?','pt-BR'],['english','Neve, how are you?','en-US']]){
    const calls=[],events=[];
    const provider=new CascadeProvider({options:defaults({}),onEvent:e=>events.push(e),components:{
      transcribe:async(audio,options)=>{assert.equal(options.language,'auto');return {text:utterance,language:detected};},
      think:async(text,id,prompt,lang,options)=>{calls.push(lang);assert.equal(options.replyLanguage,'auto');assert.match(prompt,/espanhol.*inglês/);return utterance;},
      speak:async(text,lang,options)=>{calls.push(lang);assert.equal(options.replyLanguage,'auto');return Buffer.from('audio');}
    },decode:async()=>{}});
    await provider.connect();provider.begin({speaker:{id:'a'}});await provider.run(Buffer.alloc(0));assert.deepEqual(calls,[expected,expected]);assert.equal(events.at(-1).type,'turnComplete');provider.close();
  }
});
test('idioma fixo muda resposta Cascade sem forçar idioma da transcrição',async()=>{
  const calls=[];
  const provider=new CascadeProvider({options:{...defaults({}),replyLanguage:'pt-BR'},onEvent:()=>{},components:{
    transcribe:async(audio,o)=>{assert.equal(o.language,'auto');return {text:'Hello Neve',language:'english'};},
    think:async(text,id,prompt,lang)=>{calls.push(lang);return 'Olá';},speak:async(text,lang)=>{calls.push(lang);return Buffer.alloc(0);}
  },decode:async()=>{}});
  provider.begin({speaker:{id:'a'}});await provider.run(Buffer.alloc(0));assert.deepEqual(calls,['pt-BR','pt-BR']);provider.close();
});

test('teste de voz cancelado fecha provider e não expõe erro com credenciais na API',async()=>{
  const s=setup();const transport=s.attach();let closed=false,started;
  const ready=new Promise(r=>started=r);
  s.live.providers.set('gemini',({onEvent})=>({async connect(){},sendText(){started();},close(){closed=true;}}));
  const task=s.live.testVoice('g','teste');const rejected=assert.rejects(task,/indisponível/);await ready;s.voice.cancelLiveTest('g');await rejected;assert.equal(closed,true);assert.equal(s.live.testAbort,null);assert.equal(transport.live.paused,false);
  s.live.providers.set('gemini',()=>({async connect(){throw new Error('wss://example?key=secret');},close(){}}));
  await assert.rejects(s.live.testVoice('g','teste'),e=>!e.message.includes('secret'));s.voice.leave('g');
});
