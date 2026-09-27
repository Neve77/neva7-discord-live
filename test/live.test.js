const test=require('node:test');
const assert=require('node:assert/strict');
const {LiveConversation}=require('../src/live/session');
const {defaults,validate,LiveSettings}=require('../src/live/settings');
const {allowed,participate,calculator,runTool}=require('../src/live/policy');
const {AudioBuffer,endpointDelay}=require('../src/live/primitives');
const {PermanentMemory,ConversationMemory}=require('../src/live/memory');
const {GeminiLiveProvider}=require('../src/live/gemini-provider');
const {deferred}=require('./helpers');
const flush=()=>new Promise(r=>setImmediate(r));
function frame(value=1000){const b=Buffer.alloc(640);for(let i=0;i<b.length;i+=2)b.writeInt16LE(value,i);return b;}
function setup(patch={}) {
  let now=100000;const providers=[],plays=[];
  const options=validate({...patch},defaults({}));
  const session=new LiveConversation({guildId:'g',options,now:()=>now,autoTick:false,
    identify:id=>({id,name:id,roles:id==='admin'?['mod']:[]}),
    providerFactory:({onEvent})=>{
      const p={onEvent,closed:false,packets:[],ends:0,begins:[],async connect(){},begin(context){this.begins.push(context);},sendAudio(pcm){this.packets.push(Buffer.from(pcm));},end(){this.ends++;},close(){this.closed=true;},respondTool(){}};providers.push(p);return p;
    },play:(stream,opts)=>{const done=deferred();const p={stream,opts,done,audio:[],aborted:false};plays.push(p);stream.on('data',b=>p.audio.push(b));stream.on('end',()=>done.resolve(true));opts.onPlaying();opts.signal.addEventListener('abort',()=>{p.aborted=true;done.resolve(false);},{once:true});return done.promise;}
  });
  const advance=ms=>{now+=ms;session.tick(now);};
  const speech=async(id='alice',value=1000)=>{for(let i=0;i<10;i++){session.ingest(id,frame(value));advance(20);}await flush();advance(50);};
  const endpoint=async()=>{advance(options.incompleteMs+50);await flush();advance(50);};
  return {session,providers,plays,advance,speech,endpoint};
}
test('Live envia PCM antes do endpoint e reutiliza a sessão em turnos consecutivos',async()=>{
  const s=setup();await s.speech();assert.equal(s.providers.length,1);assert.ok(s.providers[0].packets.length>0);assert.equal(s.providers[0].ends,0);
  await s.endpoint();const p=s.providers[0];assert.equal(p.ends,1);
  p.onEvent({type:'transcript',role:'user',text:'Neve, oi!',final:true});
  p.onEvent({type:'audio',pcm:Buffer.alloc(24000)});await flush();assert.equal(s.plays.length,1);
  p.onEvent({type:'transcript',role:'assistant',text:'Olá!'});p.onEvent({type:'turnComplete'});await flush();
  assert.equal(s.session.memory.turns.length,2);assert.equal(s.plays[0].audio[0].length,24000);
  s.advance(2000);await s.speech();assert.equal(s.providers.length,1);assert.equal(p.begins.length,2);s.session.close();
});
test('barge-in invalida a resposta e ignora áudio/eventos de conexões antigas',async()=>{
  const s=setup();await s.speech();await s.endpoint();const old=s.providers[0];
  old.onEvent({type:'transcript',role:'user',text:'Neve, explique',final:true});old.onEvent({type:'audio',pcm:Buffer.alloc(24000)});await flush();
  const oldId=s.session.output.id;await s.speech('bob');assert.equal(s.plays[0].aborted,true);assert.equal(old.closed,true);
  old.onEvent({type:'audio',pcm:Buffer.alloc(24000)});old.onEvent({type:'turnComplete'});
  await s.endpoint();const p=s.providers.at(-1);p.onEvent({type:'transcript',role:'user',text:'Neve, outra pergunta',final:true});p.onEvent({type:'audio',pcm:Buffer.alloc(24000)});await flush();
  assert.ok(s.session.current.turn.id>oldId);assert.equal(s.session.memory.turns.some(t=>t.role==='assistant'),false);s.session.close();
});
test('falas simultâneas preservam PCM e dono tem prioridade no endpoint',async()=>{
  const s=setup({priorityUserId:'bob'});
  for(let i=0;i<10;i++){s.session.ingest('alice',frame(1000));s.session.ingest('bob',frame(2000));s.advance(20);}await flush();s.advance(50);await s.endpoint();
  assert.equal(s.session.current.id,'bob');assert.equal(s.providers[0].packets[0].readInt16LE(),1000);assert.equal(s.providers[1].packets[0].readInt16LE(),2000);
  s.providers[1].onEvent({type:'transcript',role:'user',text:'fala entre humanos',final:true});s.providers[1].onEvent({type:'turnComplete'});s.advance(50);
  assert.equal(s.session.current.id,'alice');assert.equal(s.session.memory.turns[0].userId,'bob');s.session.close();
});
test('ruído isolado não abre provider; denylist vence allowlist e funções',async()=>{
  const s=setup({allowRoles:['mod'],denyUsers:['admin']});await s.speech('admin');await s.speech('alice');assert.equal(s.providers.length,0);s.session.close();
  const r=setup();for(let i=0;i<50;i++){r.session.ingest('a',frame(20));r.advance(20);}assert.equal(r.providers.length,0);r.session.close();
  const o={...defaults({}),allowRoles:['mod']};assert.ok(allowed('a',['mod'],o));assert.ok(!allowed('a',[],o));
});
test('observer nunca reproduz; somente chamada exige palavra inteira',async()=>{
  const s=setup({mode:'observer'});await s.speech();await s.endpoint();const p=s.providers[0];p.onEvent({type:'transcript',role:'user',text:'Neve, oi',final:true});p.onEvent({type:'audio',pcm:Buffer.alloc(24000)});p.onEvent({type:'turnComplete'});await flush();assert.equal(s.plays.length,0);s.session.close();
  assert.equal(participate('nevertheless',defaults({}),false),false);assert.equal(participate('Neve, tudo bem?',defaults({}),false),true);
});
test('buffers têm teto, e saída excedida cancela geração e playback',async()=>{
  const b=new AudioBuffer({prebufferMs:100,maxBufferMs:1000});assert.equal(b.push(Buffer.alloc(48001)),false);assert.equal(b.size,0);b.destroy();
  const s=setup({maxBufferMs:1000});await s.speech();await s.endpoint();s.providers[0].onEvent({type:'audio',pcm:Buffer.alloc(50000)});assert.equal(s.providers[0].closed,true);assert.equal(s.session.telemetry.counters.outputOverflows,1);s.session.close();
});
test('transcrições parciais não viram histórico; histórico e resumo são limitados',async()=>{
  const s=setup({maxHistory:2});await s.speech();s.providers[0].onEvent({type:'interim',text:'hipótese secreta'});assert.equal(s.session.memory.turns.length,0);
  assert.equal(JSON.stringify(s.session.snapshot()).includes('hipótese secreta'),false);s.session.close();
  const m=new ConversationMemory({...defaults({}),maxHistory:2,maxSummaryChars:200});for(let i=0;i<30;i++)m.add('a','user','texto '+i);assert.equal(m.turns.length,2);assert.ok(m.summary.length<=200);
});
test('pausa de frase incompleta espera mais e sobreposição prolonga endpoint',()=>{
  const o=defaults({});assert.equal(endpointDelay('Eu queria, mas',o),1600);assert.equal(endpointDelay('Qual é a hora?',o),650);assert.equal(endpointDelay('Sim.',o,true),1600);
});
test('kill, pause e revogação de permissões cancelam imediatamente e bloqueiam captura',async()=>{
  for(const action of ['kill','pause','policy']){
    const s=setup();await s.speech();await s.endpoint();const p=s.providers[0];p.onEvent({type:'transcript',role:'user',text:'Neve, oi',final:true});p.onEvent({type:'audio',pcm:Buffer.alloc(24000)});await flush();
    if(action==='policy')s.session.update({...s.session.options,denyUsers:['alice']});else s.session[action]();
    assert.equal(s.plays[0].aborted,true);await s.speech();assert.equal(s.providers.length,1);s.session.close();
  }
});
test('reconecta com backoff e restaura contexto; cota entra em Safe Mode sem retry',async()=>{
  const s=setup();s.session.memory.add('alice','user','contexto anterior');await s.speech();s.providers[0].onEvent({type:'error',reason:'connection'});assert.equal(s.session.safeMode,false);s.advance(500);assert.equal(s.providers.length,1);s.advance(600);await flush();assert.equal(s.providers.length,2);await s.speech();assert.ok(JSON.stringify(s.providers[1].begins).includes('contexto anterior'));
  s.providers[1].onEvent({type:'error',reason:'quota'});assert.equal(s.session.safeMode,true);s.advance(30000);assert.equal(s.providers.length,2);s.session.close();
});
test('ferramentas usam autorização local; calculadora nunca executa JS; memória requer política',()=>{
  assert.equal(calculator('2*(3+4)-1'),13);assert.throws(()=>calculator('process.exit()'));assert.throws(()=>calculator('1/0'));
  const o={...defaults({}),tools:['calculator'],toolUsers:['a']};assert.equal(runTool('calculator',{expression:'2+2'},'a',[],o).result,4);assert.ok(runTool('calculator',{expression:'2+2'},'b',[],o).error);
  const memory=new PermanentMemory(null);assert.throws(()=>memory.save('g','a','nota',o));memory.save('g','a','nota',{...o,permanentMemory:true,memoryUsers:['a']});assert.equal(memory.forUser('other','a',{...o,permanentMemory:true,memoryUsers:['a']}).length,0);
});
test('validação rejeita opções desconhecidas, NaN, listas inválidas e limites incompatíveis',()=>{
  for(const patch of [{typo:1},{maxParticipants:NaN},{maxParticipants:1.5},{tools:['shell']},{silenceMs:2000,incompleteMs:500},{onlyWhenCalled:true,wakeWords:[]}])assert.throws(()=>validate(patch));
  const store=new LiveSettings({file:null,env:{}});store.update({mode:'observer'});assert.equal(store.value.mode,'observer');
});
test('provider usa atividade manual, PCM correto, todos os blocos e close invalida callbacks',async()=>{
  const events=[],sent=[];let setup,closed=0;
  const p=new GeminiLiveProvider({options:defaults({}),onEvent:e=>events.push(e),client:{live:{async connect(value){setup=value;return {sendClientContent:x=>sent.push(x),sendRealtimeInput:x=>sent.push(x),close:()=>closed++};}}}});
  await p.connect();p.begin({speaker:{id:'a'}});p.sendAudio(frame());p.end();
  assert.equal(setup.config.realtimeInputConfig.automaticActivityDetection.disabled,true);assert.equal(sent[2].audio.mimeType,'audio/pcm;rate=16000');assert.ok(sent[3].activityEnd);
  const part={inlineData:{mimeType:'audio/pcm;rate=24000',data:Buffer.alloc(100).toString('base64')}};
  setup.callbacks.onmessage({serverContent:{modelTurn:{parts:[part,part]},turnComplete:true}});assert.equal(events.filter(e=>e.type==='audio').length,2);
  p.close();setup.callbacks.onmessage({serverContent:{modelTurn:{parts:[part]}}});assert.equal(events.filter(e=>e.type==='audio').length,2);assert.equal(closed,1);
});
test('provider fecha handshake atrasado após timeout e recusa PCM inválido',async()=>{
  let resolve,closed=0;const p=new GeminiLiveProvider({options:defaults({}),timeoutMs:10,onEvent(){},client:{live:{connect:()=>new Promise(r=>resolve=r)}}});
  await assert.rejects(p.connect(),/timeout/);resolve({close:()=>closed++});await flush();assert.equal(closed,1);
  const events=[],q=new GeminiLiveProvider({options:defaults({}),onEvent:e=>events.push(e)});
  q.message({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=48000',data:'AAAA'}}]}}});assert.equal(events[0].reason,'audio-format');
});

test('loop de respostas repetidas entra em silêncio e nova chamada relevante rearma',async()=>{
  const s=setup({cooldownMs:0}),answer='Esta é uma resposta repetitiva suficientemente longa.';
  for(let i=0;i<3;i++){
    await s.speech();await s.endpoint();const p=s.providers.at(-1);
    p.onEvent({type:'transcript',role:'user',text:'Neve, responda',final:true});p.onEvent({type:'transcript',role:'assistant',text:answer});
    if(i<2){p.onEvent({type:'audio',pcm:Buffer.alloc(24000)});await flush();p.onEvent({type:'turnComplete'});await flush();}
  }
  assert.equal(s.session.silent,true);assert.equal(s.session.telemetry.counters.loops,1);
  await s.speech();await s.endpoint();const p=s.providers.at(-1);p.onEvent({type:'transcript',role:'user',text:'Neve, vamos mudar de assunto',final:true});p.onEvent({type:'audio',pcm:Buffer.alloc(24000)});await flush();assert.equal(s.session.silent,false);s.session.close();
});
test('configuração de voz espera segmento; quotas locais bloqueiam novas respostas',async()=>{
  const s=setup({responsesPerMinute:1,cooldownMs:0});await s.speech();s.session.update({...s.session.options,voice:'Kore'});s.advance(50);assert.equal(s.session.options.voice,'Aoede');
  await s.endpoint();const p=s.providers[0];p.onEvent({type:'transcript',role:'user',text:'Neve, oi',final:true});p.onEvent({type:'audio',pcm:Buffer.alloc(24000)});await flush();p.onEvent({type:'turnComplete'});await flush();s.advance(50);assert.equal(s.session.options.voice,'Kore');
  await s.speech();await s.endpoint();const q=s.providers.at(-1);q.onEvent({type:'transcript',role:'user',text:'Neve, segunda',final:true});q.onEvent({type:'audio',pcm:Buffer.alloc(24000)});q.onEvent({type:'turnComplete'});await flush();assert.equal(s.plays.length,1);s.session.close();
});
test('fallback explícito troca provider e mantém contexto, limites e cancelamento',async()=>{
  const s=setup({fallback:'cascade'});s.session.memory.add('alice','user','contexto da call');await s.speech();s.providers[0].onEvent({type:'error',reason:'quota'});
  assert.equal(s.session.fallback,true);assert.equal(s.session.safeMode,false);await s.speech();assert.ok(JSON.stringify(s.providers.at(-1).begins).includes('contexto da call'));assert.equal(s.session.snapshot().provider,'cascade');
  s.providers.at(-1).onEvent({type:'error',reason:'configuration'});assert.equal(s.session.safeMode,true);s.session.close();
});
test('input pendente tem limite durante handshake e saída respeita duração e caracteres',async()=>{
  const s=setup({maxInputBufferMs:300});s.session.providerFactory=()=>({connect:()=>new Promise(()=>{}),close(){}});await s.speech();for(let i=0;i<30;i++){s.session.ingest('alice',frame());s.advance(20);}assert.ok(s.session.telemetry.counters.inputOverflows>=1);s.session.close();
  for(const kind of ['duration','characters']){const t=setup({maxResponseSeconds:2,maxCharacters:50});await t.speech();await t.endpoint();t.providers[0].onEvent(kind==='duration'?{type:'audio',pcm:Buffer.alloc(100000)}:{type:'transcript',role:'assistant',text:'x'.repeat(51)});assert.equal(t.providers[0].closed,true);t.session.close();}
});
test('percentis são calculados e eventos técnicos nunca incluem texto ou áudio',()=>{
  const {Telemetry}=require('../src/live/primitives');const telemetry=new Telemetry(()=>1);
  for(let i=1;i<=100;i++)telemetry.observe('total',i);telemetry.event('frame',{bytes:640,text:'secret',pcm:Buffer.alloc(640),apiKey:'secret'});
  const result=telemetry.snapshot();assert.equal(result.latency.total.p50,50);assert.equal(result.latency.total.p95,95);assert.equal(result.latency.total.p99,99);assert.ok(!JSON.stringify(result).includes('secret'));
});

test('funções desconhecidas falham fechadas mesmo com usuário explicitamente permitido',()=>{
  const o={...defaults({}),allowUsers:['a'],denyRoles:['blocked']};
  assert.equal(allowed('a',[],o,false),false);assert.equal(allowed('a',[],o,true),true);
});

test('tokens de contexto são contabilizados de novo a cada turno',async()=>{
  const s=setup({cooldownMs:0});
  for(let i=0;i<2;i++){
    await s.speech();await s.endpoint();const p=s.providers.at(-1);
    p.onEvent({type:'usage',value:{promptTokenCount:100,responseTokenCount:50,totalTokenCount:150}});
    p.onEvent({type:'transcript',role:'user',text:'Neve, oi',final:true});p.onEvent({type:'audio',pcm:Buffer.alloc(24000)});await flush();p.onEvent({type:'turnComplete'});await flush();
  }
  assert.deepEqual(s.session.usage,{input:200,output:100,total:300});s.session.close();
});

test('rearmar fecha o provider de fallback e preserva contexto para o principal',async()=>{
  const s=setup({fallback:'cascade'});await s.speech();s.providers[0].onEvent({type:'error',reason:'quota'});await s.speech();const fallback=s.providers.at(-1);
  s.session.memory.add('alice','user','lembrança da sessão');s.session.resume();assert.equal(fallback.closed,true);assert.equal(s.session.fallback,false);
  await s.speech();assert.ok(JSON.stringify(s.providers.at(-1).begins).includes('lembrança da sessão'));s.session.close();
});
