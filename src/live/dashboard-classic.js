'use strict';
const classicViews={
  connection:['Conexão Discord','Sua conta, no mesmo painel.','Configure a conexão, o convite e a atividade exibida no Discord.'],
  music:['Música','A trilha da sua call.','Busque uma música, acompanhe a fila e controle a reprodução.'],
  messages:['Mensagens','Continue o papo por texto.','Envie mensagens, mencione uma pessoa e resuma o canal selecionado.'],
  automation:['Automação','Defina quando participar.','Controles existentes de entrada na call, respostas por texto e conversas espontâneas.']
};
let classicBusy=false,changingDestination=false;
let memberSearchVersion=0,memberSearchBusy=false,memberSearchGuild='',memberSearchMore=false;
let accessVersion=0,accessDestination='';
const classicSlot=key=>`<div data-classic-live="${key}"></div>`;
const classicButton=(action,label,hint)=>`<button data-classic="${action}" title="${esc(hint)}">${esc(label)}</button>`;
function classicField(id,label,input,hint){return `<label class="field small-gap" for="${id}">${esc(label)}${input}<small>${esc(hint)}</small></label>`;}
function classicSelect(id,items,value,attributes='') {return `<select id="${id}" ${attributes}>${items.map(item=>{const [v,label]=Array.isArray(item)?item:[item,item];return `<option value="${esc(v)}" ${String(v).toLowerCase()===String(value).toLowerCase()?'selected':''}>${esc(label)}</option>`;}).join('')}</select>`;}
function renderClassic(which) {
  if(which==='connection'){
    const c=status?.connection||{},p=status?.presence||{};
    return '<div class="grid">'+card('Conexão com o Discord',classicSlot('connection')+
      '<form id="connectionForm" autocomplete="off">'+
      classicField('connectionMode','Tipo de conta',classicSelect('connectionMode',[['bot','Bot oficial · compatível com Live'],['selfbot','Conta pessoal · modo clássico']],c.mode||'bot'),'O Live exige bot oficial. A conta pessoal mantém o modo clássico existente.')+
      classicField('connectionToken','Token da conta selecionada','<div class="password-field"><input id="connectionToken" type="password" maxlength="512" autocomplete="new-password" spellcheck="false" placeholder="Cole um token ou use o já salvo"><button id="revealToken" type="button" aria-pressed="false">Mostrar</button></div>','Deixe vazio para reutilizar o token salvo desse tipo de conta. Nunca aparece no status do painel.')+
      '<p id="connectionModeHelp" class="muted small-gap"></p><div class="actions"><button type="submit" id="saveConnection" class="primary">Salvar conexão</button></div><p class="muted small-gap">Depois de salvar, reinicie o programa com npm.cmd start para aplicar a conta.</p></form>')+
      card('Convite e conta ativa',classicSlot('invite'))+
      card('Atividade no Discord','<p>Define o status e a atividade do perfil do bot oficial.</p><form id="presenceForm"><div class="field-grid">'+
      classicField('presenceStatus','Status',classicSelect('presenceStatus',['online','idle','dnd','invisible'],p.status||'online'),'Online, ausente, não perturbe ou invisível.')+
      classicField('presenceType','Tipo de atividade',classicSelect('presenceType',[[0,'Jogando'],[2,'Ouvindo'],[3,'Assistindo'],[5,'Competindo'],[1,'Transmitindo']],p.type||0),'Escolha como a atividade é apresentada.')+
      classicField('presenceName','Atividade',`<input id="presenceName" maxlength="128" required value="${esc(p.name||'')}">`,'Texto principal exibido no perfil.')+
      classicField('presenceState','Detalhe opcional',`<input id="presenceState" maxlength="128" value="${esc(p.state||'')}">`,'Complemento da atividade.')+'</div>'+
      classicField('presenceUrl','URL da transmissão',`<input id="presenceUrl" type="url" maxlength="512" value="${esc(p.url||'')}">`,'Usado somente no tipo Transmitindo.')+
      '<div class="actions"><button type="submit" id="savePresence">Atualizar atividade</button></div><p class="muted small-gap">A bio/About Me é editada no Developer Portal do Discord.</p></form>')+
      card('Programa e diagnóstico','<p>Diagnóstico mostra conexão, voz e métricas. Desligar encerra o processo e todas as calls.</p><div class="actions">'+classicButton('diagnostics','Ver diagnóstico','Exibe o estado técnico abaixo do painel.')+'<button id="shutdown" class="danger">Desligar a Neva7</button></div>')+'</div>';
  }
  if(which==='music')return '<div class="grid">'+card('Adicionar música',
    classicField('musicQuery','Nome, artista ou link','<input id="musicQuery" maxlength="500" placeholder="O que vamos ouvir?">','Busca a faixa e adiciona à fila da call selecionada.')+
    '<div class="actions">'+classicButton('play','Adicionar à fila','Busca e toca a faixa, ou adiciona ao final da fila.')+classicButton('skip','Pular faixa','Avança para a próxima música.')+classicButton('stopMusic','Parar e limpar fila','Encerra a música e remove a fila.')+'</div><p class="muted small-gap">A conversa Live fica pausada durante a música. Ao terminar, volta a escutar.</p>'+classicSlot('music')+
    classicField('musicVolume','Volume da call · %',`<input id="musicVolume" data-classic-setting="volume" type="number" min="0" max="200" step="5" value="${status?.volume??100}">`,'Aplica na hora à sessão selecionada; 100 é o volume normal.'))+
    card('Fila de reprodução',classicSlot('queue'))+'</div>';
  if(which==='messages')return '<div class="grid">'+card('Mensagem no canal selecionado',classicSlot('textDestination')+
    classicField('chatText','Texto da mensagem','<textarea id="chatText" maxlength="1900" placeholder="Escreva em PT-BR, espanhol ou inglês…"></textarea>','Enviar publica no canal de texto escolhido acima. Ctrl + Enter também envia.')+
    '<div class="actions">'+classicButton('send','Enviar mensagem','Envia somente o texto, sem falar na call.')+'<button id="checkMessageAccess">Verificar permissões</button></div><p id="messageAccess" class="muted small-gap" role="status">Verificar permissões consulta o acesso da conta conectada ao canal escolhido.</p><p id="messageSendError" class="error-text small-gap" role="alert"></p>')+
    card('Mencionar uma pessoa',classicField('memberQuery','Nome, apelido, @usuário ou ID','<input id="memberQuery" minlength="2" maxlength="80" placeholder="Ex.: Ana, @ana ou ID do Discord">','Busca no servidor selecionado, incluindo membros offline. Para copiar um ID, ative o Modo desenvolvedor no Discord e clique com o botão direito na pessoa → Copiar ID do usuário.')+
    '<div class="actions"><button id="searchMembers">Buscar pessoa</button><button id="moreMembers" hidden>Carregar mais membros</button></div><p id="memberSearchStatus" class="muted small-gap" role="status">Use pelo menos 2 letras ou cole o ID completo. A lista mostra o nome, o usuário e o ID para distinguir pessoas com nomes iguais.</p>'+classicField('memberSelect','Pessoa','<select id="memberSelect"><option value="">Busque uma pessoa primeiro</option></select>','Enviar com menção usa o texto da mensagem e marca somente esta pessoa.')+
    '<div class="actions">'+classicButton('mention','Enviar com menção','Envia a mensagem no canal e notifica a pessoa selecionada.')+'</div>')+
    card('Contexto do canal','<p>Resumir lê as últimas 30 mensagens e mostra um resumo aqui. Limpar contexto apaga o assunto de pesquisa ativo deste servidor.</p><div class="actions">'+classicButton('summarize','Resumir conversa','Usa a IA configurada para resumir o canal.')+classicButton('clearContext','Limpar contexto da pesquisa','Remove o assunto ativo usado nas respostas por texto.')+'</div>',true)+'</div>';
  if(which==='automation')return '<div class="grid">'+card('Entrada e resposta',
    '<p>Estes controles valem para menções e mensagens do modo clássico. A participação contínua do Live é ajustada em Inteligência.</p>'+classicSlot('automation'))+
    card('Como usar cada modo','<p><strong>Live:</strong> conversa contínua com bot oficial, áudio separado por participante e interrupções. Configure o motor em Inteligência.</p><p class="small-gap"><strong>Clássico:</strong> transcreve cada fala, gera texto e sintetiza a voz. Mantém as funções existentes de menções, emoção e interação.</p><p class="small-gap">Ambos entendem PT-BR, espanhol e inglês. O idioma de resposta é escolhido em Inteligência → Idiomas.</p><div class="actions"><a class="button-link" href="#intelligence">Inteligência e idiomas</a></div>')+'</div>';
  return '';
}
function classicVoiceCards(){return '<div class="grid small-gap">'+card('Fala manual · funções existentes',
  '<p>Escreva para a Neva7 falar na call usando a voz do modo clássico. Funciona também enquanto o Live está ligado.</p>'+classicField('speechText','Texto para falar','<textarea id="speechText" maxlength="400" placeholder="Olá! / ¡Hola! / Hello!"></textarea>','Detecta PT-BR, ES ou EN no texto; o idioma de resposta definido em Inteligência orienta a voz. Ctrl + Enter fala.')+
  '<div class="actions">'+classicButton('say','Falar agora','Sintetiza o texto e o reproduz na call; pode interromper a música.')+classicButton('repeat','Repetir última','Repete a última frase falada pelo painel.')+classicButton('announce','Falar e enviar no chat','Publica no canal de texto e reproduz na call.')+'</div>'+classicSlot('speech')+
  '<div class="actions">'+classicButton('listening','Ligar / pausar escuta','Pausa ou retoma a recepção de voz desta call.')+classicButton('stopAll','Parar tudo','Cancela fala, música e fila da call selecionada.')+'</div>')+
  card('Efeitos sonoros na call',
    '<p>Importe arquivos locais ou links de áudio direto e toque em seguida na call selecionada.</p>'+
    '<div id="soundEffectsList" class="sound-effects-list"></div>'+
    '<div class="field-grid"><label class="field">Link de áudio<input id="soundEffectUrl" type="url" placeholder="https://.../som.mp3"></label><label class="field">Arquivo local<input id="soundEffectFile" type="file" accept="audio/*"></label></div>'+
    '<div class="actions"><button id="soundImportUrl">Importar link</button><button id="soundImportFile">Importar do PC</button></div>' +
    '<p class="muted small-gap">Os arquivos ficam salvos no computador e ficam prontos para prévia local e reprodução na call.</p>')+
  card('Timbre e ritmo · voz manual e clássica',
  classicField('voiceFilter','Filtrar timbre',classicSelect('voiceFilter',[['all','Todas as vozes'],['feminino','Feminino'],['masculino','Masculino'],['neutro','Neutro']],'all'),'Filtro do catálogo, sem alterar a voz escolhida.')+
  classicField('classicVoice','Voz','<select id="classicVoice" data-classic-setting="voice"></select>','Voz usada pelos comandos de fala e pelo modo clássico. A voz Gemini Live é configurada acima.')+'<p id="voiceProfile" class="muted small-gap"></p><details class="small-gap"><summary>Catálogo de vozes e estilos</summary><div id="voiceCatalog" class="small-gap"></div></details>'+
  classicField('classicSpeed','Velocidade · ×',`<input id="classicSpeed" data-classic-setting="speed" type="number" min="0.25" max="4" step="0.05" value="${status?.speed||1}">`,'Velocidade da voz clássica; 1 é normal. Salva ao mudar o valor.')+
  classicField('classicVolume','Volume da call · %',`<input id="classicVolume" data-classic-setting="volume" type="number" min="0" max="200" step="5" value="${status?.volume??100}">`,'Volume imediato da call selecionada.'))+'</div>';}
function classicPersonalityCards(){return '<div class="grid small-gap">'+card('Emoção e interação · modo clássico e mensagens',
  '<p>Estas opções preservam o comportamento das respostas antigas. O Live usa o perfil e os ajustes acima.</p>'+
  classicField('classicEmotion','Emoção base',classicSelect('classicEmotion',catalog?.emotions||[],status?.emotion,'data-classic-setting="emotion"'),'Troca o tom das respostas clássicas e remove uma personalidade personalizada anterior.')+
  classicField('interactionSetting','Ajustes de interação',`<textarea id="interactionSetting" maxlength="700">${esc(status?.interaction||'')}</textarea>`,'Complementa a emoção base; por exemplo: faça perguntas curtas e evite spoilers.')+
  '<div class="actions">'+classicButton('interaction','Salvar ajustes','Salva o texto de interação para as respostas clássicas.')+'<button id="clearInteraction">Limpar ajustes</button></div>')+
  card('Criar uma personalidade do zero',classicField('customEmotionSetting','Sua personalidade','<textarea id="customEmotionSetting" maxlength="700" placeholder="Descreva como a Neva7 deve conversar…"></textarea>','Substitui a emoção base do modo clássico até você selecionar outra emoção.')+
  '<div class="actions">'+classicButton('customEmotion','Aplicar personalidade','Salva uma personalidade completa para as respostas clássicas.')+'</div>'+classicSlot('personality'))+'</div>';}
function renderVoiceOptions(){const select=$('#classicVoice');if(!select)return;const filter=$('#voiceFilter').value;const profiles=catalog?.voiceProfiles||[];
  select.innerHTML=profiles.filter(p=>filter==='all'||p.timbre===filter||p.id.toLowerCase()===String(status?.voice).toLowerCase()).map(p=>`<option value="${esc(p.id)}" ${p.id.toLowerCase()===String(status?.voice).toLowerCase()?'selected':''}>${esc(p.name)} · ${esc(p.style)}</option>`).join('');
  const current=profiles.find(p=>p.id.toLowerCase()===String(status?.voice).toLowerCase());$('#voiceProfile').textContent=current?`${current.name} · ${current.timbre} · ${current.style}`:'Escolha uma voz do catálogo.';
  $('#voiceCatalog').innerHTML=rows(profiles.map(p=>[p.name,`${p.timbre} · ${p.style}`]))+`<p class="muted">${esc(catalog?.voiceProfileNote)}</p>`;
}
function classicUnavailable(action){
  if(classicBusy)return 'Aguarde a ação atual.';
  if(changingDestination)return 'Aguarde a troca do servidor ou canal.';
  if(status?.selfbotSafeMode && ['presence','autoJoin','replyInText','alive','aliveChannel','recordingStart','recordingStop','summarize','play'].includes(action)) {
    return 'Selfbot: automações e respostas contínuas ficam bloqueadas por segurança; use apenas comandos manuais e locais.';
  }
  const protectedActions=['say','repeat','announce','send','mention','play','listening','alive','aliveChannel','recordingStart'];
  if(protectedActions.includes(action)&&(data?.config.killed||data?.config.safeMode||current()?.safeMode))return 'Rearme a conversa para usar esta função.';
  if(['say','repeat','announce','play','skip','stopMusic','stopAll','volume','listening','recordingStart'].includes(action)&&!status?.inCall)return 'Entre em uma call.';
  if(action==='recordingStart'&&status?.recording)return 'A call já está sendo gravada.';
  if(action==='recordingStop'&&!status?.recording)return 'Não há gravação ativa no servidor selecionado.';
  if(['announce','send','mention','summarize','aliveChannel'].includes(action)&&(!status?.online||!status?.textChannelId))return 'Selecione um canal de texto.';
  if(action==='repeat'&&!status?.lastSpeech)return 'Fale uma frase primeiro.';
  if(action==='presence'&&(!status?.online||!status?.botMode))return 'Conecte um bot oficial para definir a atividade.';
  if(action==='mention'&&!$('#memberSelect')?.value)return 'Busque e selecione uma pessoa.';
  if(action==='clearContext'&&!status?.guildId)return 'Selecione um servidor.';
  return '';
}
function renderClassicLive(){
  const s=status||{},o=data?.config||{},c=s.connection||{};
  if(memberSearchGuild!==(s.guildId||''))resetMemberSearch();
  const destination=`${s.guildId||''}:${s.textChannelId||''}`;
  if(accessDestination!==destination){accessDestination=destination;accessVersion++;if($('#messageAccess'))$('#messageAccess').textContent='Verifique as permissões deste canal.';if($('#messageSendError'))$('#messageSendError').textContent='';}
  const stateButton=(action,label,on,help)=>`<div class="setting-row"><div><strong>${label}</strong><p>${help}</p></div><button data-classic="${action}" aria-pressed="${!!on}">${on?'Ligado':'Desligado'}</button></div>`;
  const parts={
    connection:()=>rows([['Conta ativa',c.activeMode==='selfbot'?'Pessoal · clássico':'Bot oficial'],['Conexão',s.online?'Conectada':'Desconectada'],['Alteração de conta',c.restartRequired?'Salva · reinicie o programa':'Sem reinício pendente']])+(s.connectionError?`<p class="error-text">${esc(s.connectionError)}</p>`:''),
    invite:()=>rows([['Nome',s.username||'Desconectado'],['Token de bot',c.hasBotToken?'Já salvo':'Não configurado'],['Token pessoal',c.hasSelfbotToken?'Já salvo':'Não configurado']])+(s.inviteUrl?`<label class="field small-gap">Link do bot<input id="inviteLink" readonly value="${esc(s.inviteUrl)}"></label><div class="actions"><a class="button-link" href="${esc(s.inviteUrl)}" target="_blank" rel="noopener noreferrer">Adicionar ao servidor</a><button id="copyInvite">Copiar convite</button></div>`:empty('Conecte o bot oficial para gerar o convite.')),
    music:()=>rows([['Reprodução',s.musicState||'Parada'],['Faixa atual',s.currentTrack||'Nenhuma']])+(s.musicError?`<p class="error-text">${esc(s.musicError)}</p>`:''),
    queue:()=>s.musicQueue?.length?table(['Ordem','Música'],s.musicQueue.map((t,i)=>[t.current?'Tocando':i+1,t.title])):empty('Fila vazia. Adicione uma faixa na call.'),
    textDestination:()=>rows([['Servidor',s.guild||'Selecione acima'],['Canal de texto',s.textChannelId?'#'+s.channel:'Selecione acima']]),
    speech:()=>rows([['Escuta',s.listening===null?'Fora da call':s.listening?'Ligada':'Pausada'],['Saída',s.speaking?'Falando':s.synthesizing?'Gerando voz':'Livre'],['Última frase',s.lastSpeech||'Nenhuma'],['Voz clássica',`${s.tts||'—'} · ${s.voice||'—'}`]]),
    personality:()=>rows([['Emoção atual',s.emotion||'natural']]),
    automation:()=>stateButton('autoJoin','Entrar quando mencionada',s.autoJoin,'Acompanha para a call quem mencionou a Neva7 no chat.')+stateButton('replyInText','Também responder no chat',s.replyInText,'Publica no Discord a resposta das menções e da conversa clássica; não publica transcrições Live.')+stateButton('alive','Puxar assunto no texto',s.alive,'Ativa o sistema existente de mensagens espontâneas nos canais escolhidos.')+stateButton('aliveChannel','Usar este canal para puxar assunto',s.aliveInChannel,`Inclui ou remove o canal de texto selecionado. ${s.aliveChannels||0} canal(is) ativo(s).`)
  };
  document.querySelectorAll('[data-classic-live]').forEach(el=>{const html=parts[el.dataset.classicLive]?.()||'';if(el.innerHTML!==html)el.innerHTML=html;});
  document.querySelectorAll('[data-classic],[data-classic-setting]').forEach(el=>{const reason=classicUnavailable(el.dataset.classic||el.dataset.classicSetting);el.disabled=!!reason;if(reason)el.setAttribute('aria-label',`${el.textContent||el.id} — ${reason}`);else el.removeAttribute('aria-label');});
  for(const id of ['searchMembers','moreMembers'])if($('#'+id))$('#'+id).disabled=!s.online||!s.guildId||classicBusy||memberSearchBusy||changingDestination;
  if($('#moreMembers'))$('#moreMembers').hidden=!memberSearchMore;
  if($('#savePresence'))$('#savePresence').disabled=!!classicUnavailable('presence');
  if($('#connectionModeHelp')){const bot=$('#connectionMode').value==='bot';$('#connectionModeHelp').textContent=(bot?c.hasBotToken:c.hasSelfbotToken)?'Já existe um token salvo para esta opção. Você pode salvar sem colar novamente.':'Informe o token desta conta para salvar a conexão.';}
  if($('#classicEmotion')&&!document.activeElement?.matches('#classicEmotion'))$('#classicEmotion').value=s.emotion||'';
  if($('#soundEffectsList')){
    const effects=(status?.soundEffects||[]).map(effect=>`<div class="sound-effect-item"><div><strong>${esc(effect.name || effect.filename)}</strong><small>${esc(effect.filename)} · ${esc(Math.round((effect.size||0)/1024))} KB</small></div><div class="actions"><audio controls src="/api/sound-effects/${encodeURIComponent(effect.filename)}"></audio><button data-classic-sound="${esc(effect.filename)}">Tocar na call</button></div></div>`).join('')||'<p class="muted">Nenhum efeito salvo ainda. Importe um arquivo local ou cole um link MP3.</p>';
    $('#soundEffectsList').innerHTML=effects;
  }
  for(const [id,value] of [['classicVolume',s.volume],['musicVolume',s.volume],['classicSpeed',s.speed]])if($('#'+id)&&document.activeElement!==$('#'+id)&&value!=null)$('#'+id).value=value;
}
async function classicAction(action,value={}) {
  if(classicBusy)return;classicBusy=true;renderClassicLive();
  if(['send','mention'].includes(action)&&$('#messageSendError'))$('#messageSendError').textContent='';
  try{const result=await api('/api/action',{action,value});status=result.status;feedback(result.message);$('#actionOutput').textContent=result.message;if(['summarize','diagnostics'].includes(action))$('#actionOutput').parentElement.open=true;renderLive();if(['voice','emotion'].includes(action))renderVoiceOptions();if(['soundImport','soundPlay'].includes(action))await poll().catch(()=>{});if(action.startsWith('recording'))loadRecordings();return result;}
  catch(error){feedback(error.message,true);if(['send','mention'].includes(action)&&$('#messageSendError'))$('#messageSendError').textContent=error.message;}
  finally{classicBusy=false;renderClassicLive();}
}
function resetMemberSearch(){
  memberSearchVersion++;memberSearchBusy=false;memberSearchMore=false;memberSearchGuild=status?.guildId||'';
  if($('#memberSelect'))$('#memberSelect').innerHTML='<option value="">Busque uma pessoa primeiro</option>';
  if($('#memberSearchStatus'))$('#memberSearchStatus').textContent='Busque por nome, apelido, @usuário ou ID no servidor selecionado.';
  if($('#moreMembers'))$('#moreMembers').hidden=true;
}
async function searchPeople(){
  const query=$('#memberQuery').value.trim();if(query.length<2)throw new Error('Digite pelo menos duas letras ou cole o ID.');
  const select=$('#memberSelect'),guildId=status?.guildId,version=++memberSearchVersion;
  memberSearchBusy=true;select.innerHTML='<option value="">Buscando…</option>';$('#memberSearchStatus').textContent='Consultando membros do servidor…';renderClassicLive();
  const current=()=>version===memberSearchVersion&&guildId===status?.guildId&&select===$('#memberSelect');
  try{
    const result=await api('/api/members?q='+encodeURIComponent(query));if(!current())return;
    if(result.guildId&&result.guildId!==guildId)throw new Error('O servidor mudou. Busque novamente.');
    select.innerHTML='<option value="">Selecione uma pessoa</option>'+result.members.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}${m.username?' · @'+esc(m.username):''} · ${esc(m.id)}</option>`).join('');
    memberSearchMore=!!result.hasMore;
    const count=`${result.members.length} pessoa(s) encontrada(s).`;
    $('#memberSearchStatus').textContent=`${count}${result.indexed!=null?` ${result.indexed} membros carregados.`:''} ${result.warning||'Busca concluída.'}`;
    feedback(count);
  }catch(error){if(current()){select.innerHTML='<option value="">Busca indisponível</option>';memberSearchMore=false;$('#memberSearchStatus').textContent=error.message;feedback(error.message,true);}}
  finally{if(version===memberSearchVersion){memberSearchBusy=false;renderClassicLive();}}
}
async function checkMessageAccess(){
  const output=$('#messageAccess'),button=$('#checkMessageAccess'),destination=accessDestination,version=++accessVersion;
  button.disabled=true;output.textContent='Conferindo conta, cargos e permissões do canal…';
  const current=()=>version===accessVersion&&destination===accessDestination&&output===$('#messageAccess');
  try{const result=await api('/api/message-access');if(current())output.textContent=`${result.accountType}: ${result.account} · ${result.accountId}. ${result.message}`;}
  catch(error){if(current())output.textContent=error.message;}
  finally{button.disabled=false;}
}
document.addEventListener('click',async event=>{
  const b=event.target.closest('button');if(!b)return;
  try {
    if(b.dataset.classic){const action=b.dataset.classic;const payload={say:()=>({text:$('#speechText').value}),announce:()=>({text:$('#speechText').value}),play:()=>({query:$('#musicQuery').value}),send:()=>({text:$('#chatText').value}),mention:()=>({userId:$('#memberSelect').value,text:$('#chatText').value}),interaction:()=>({text:$('#interactionSetting').value}),customEmotion:()=>({text:$('#customEmotionSetting').value})}[action];await classicAction(action,payload?.()||{});}
    if(b.dataset.classicSound){await classicAction('soundPlay',{id:b.dataset.classicSound, filename:b.dataset.classicSound});}
    if(b.id==='clearInteraction'){const result=await classicAction('interaction',{text:''});if(result)$('#interactionSetting').value='';}
    if(['searchMembers','moreMembers'].includes(b.id))await searchPeople();
    if(b.id==='checkMessageAccess')await checkMessageAccess();
    if(b.id==='copyInvite'){try{await navigator.clipboard.writeText(status.inviteUrl);feedback('Convite copiado.');}catch{$('#inviteLink').select();feedback('Link selecionado. Use Ctrl+C para copiar.');}}
    if(b.id==='revealToken'){const input=$('#connectionToken');input.type=input.type==='password'?'text':'password';b.textContent=input.type==='text'?'Ocultar':'Mostrar';b.setAttribute('aria-pressed',String(input.type==='text'));}
    if(b.id==='shutdown')$('#shutdownDialog').showModal();
    if(b.id==='soundImportUrl'){const url=$('#soundEffectUrl').value.trim(); if(!url) throw new Error('Cole um link direto de áudio para importar.'); await classicAction('soundImport',{url, name: url.split('/').pop() || 'efeito'}); $('#soundEffectUrl').value='';}
    if(b.id==='soundImportFile'){document.getElementById('soundEffectFile').click();}
    if(b.dataset.useClassic!==undefined){if(Object.keys(draft).length)throw new Error('Aplique ou descarte as alterações antes de mudar o modo.');await command('settings',{enabled:false});}
  }catch(error){feedback(error.message,true);}
});
document.addEventListener('change',async event=>{
  const action=event.target.dataset.classicSetting;if(action){const key=['voice','emotion'].includes(action)?'name':'value';classicAction(action,{[key]:event.target.value});}
  if(event.target.id==='voiceFilter')renderVoiceOptions();
  if(event.target.id==='soundEffectFile'){
    const file=event.target.files?.[0]; if(!file) return; const dataUrl = await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Não foi possível ler o arquivo de áudio.'));reader.readAsDataURL(file);});
    await classicAction('soundImport',{name:file.name.replace(/\.[^.]+$/, ''), filename:file.name, data:dataUrl});
    event.target.value='';
    try { await poll(); } catch {}
    renderClassicLive();
  }
  if(['memberSelect','connectionMode'].includes(event.target.id)){if(event.target.id==='connectionMode')$('#connectionToken').value='';renderClassicLive();}
});
document.addEventListener('submit',async event=>{
  if(!['connectionForm','presenceForm'].includes(event.target.id))return;event.preventDefault();
  if(event.target.id==='presenceForm'){await classicAction('presence',{status:$('#presenceStatus').value,type:$('#presenceType').value,name:$('#presenceName').value,state:$('#presenceState').value,url:$('#presenceUrl').value});return;}
  const button=$('#saveConnection');if(button.disabled)return;button.disabled=true;
  try{const result=await api('/api/connection',{mode:$('#connectionMode').value,token:$('#connectionToken').value});if($('#connectionToken'))$('#connectionToken').value='';status.connection=result.connection;feedback(result.message);renderLive();}catch(error){feedback(error.message,true);}finally{button.disabled=false;}
});
document.addEventListener('input',event=>{if(event.target.id==='memberQuery'){resetMemberSearch();renderClassicLive();}});
document.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.id==='memberQuery'){event.preventDefault();if(!$('#searchMembers').disabled)$('#searchMembers').click();}if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&['speechText','chatText'].includes(event.target.id)){event.preventDefault();const action=event.target.id==='speechText'?'say':'send';if(!classicUnavailable(action))classicAction(action,{text:event.target.value});}});
