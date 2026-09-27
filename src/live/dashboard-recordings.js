'use strict';
let recordingsData=null,recordingsLoading=false;
const recordingDuration=ms=>{const s=Math.floor((ms||0)/1000);return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s%3600/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};
const recordingSize=bytes=>bytes>1024**3?(bytes/1024**3).toFixed(2)+' GB':(bytes/1024**2).toFixed(1)+' MB';
function recordingsView(){return '<div class="grid">'+card('Gravar a call no computador',
  '<p>Salva as vozes recebidas na call e o áudio reproduzido pela Neva7, incluindo sua fala e música. A gravação começa somente ao clicar em Iniciar.</p><div id="recordingState" class="small-gap"></div><div class="actions">'+classicButton('recordingStart','● Iniciar gravação','Começa a salvar o áudio da call selecionada em WAV.')+classicButton('recordingStop','■ Parar e salvar','Finaliza as faixas individuais e gera o WAV com a conversa completa.')+'</div><p class="muted small-gap">Pausar a escuta da IA mantém a gravação. Sair da call, Parar tudo, Safe Mode manual ou Kill Switch encerram a gravação.</p>')+
  card('Onde os arquivos ficam','<p id="recordingFolder" class="recording-path">Carregando pasta…</p><div class="actions"><button id="copyRecordingFolder">Copiar caminho da pasta</button><button id="refreshRecordings">Atualizar arquivos</button></div><p class="small-gap">Cada sessão tem uma pasta com <strong>call.wav</strong> (conversa completa), faixas WAV separadas por participante e <strong>manifest.json</strong> com os nomes e horários.</p><p class="muted small-gap">WAV mono, 16 kHz. Limites por sessão: 2 horas, 32 faixas e 2 GB nas faixas individuais. A mixagem usa espaço adicional. A gravação local não precisa de uma API de IA.</p>')+
  card('Gravações salvas neste PC','<p class="muted">Ouça aqui ou baixe uma cópia. Os arquivos permanecem na pasta até você apagá-los no computador.</p><div id="recordingFiles" class="recording-files small-gap"></div>',true)+'</div>';}
async function loadRecordings(){if(recordingsLoading)return;recordingsLoading=true;try{recordingsData=await api('/api/recordings');renderRecordings();}catch(error){feedback(error.message,true);}finally{recordingsLoading=false;}}
function renderRecordings(){
  const active=status?.recordingActive||[],banner=$('#recordingBanner');banner.hidden=!active.length;
  $('#recordingBannerText').textContent=active.length?`● GRAVANDO NO PC · ${active.length} call(s) · ${recordingDuration(Math.max(...active.map(r=>r.durationMs)))}. O áudio está sendo salvo.`:'';
  if(!$('#recordingState'))return;
  const r=status?.recording;
  $('#recordingState').innerHTML=rows([['Estado',r?'● Gravando':'Parada'],['Tempo',r?recordingDuration(r.durationMs):'—'],['Faixas',r?.trackCount||0],['Tamanho das faixas',r?recordingSize(r.bytes):'—']]);
  if(!recordingsData)return;
  $('#recordingFolder').textContent=recordingsData.root||'Gravação indisponível nesta prévia.';
  const list=$('#recordingFiles');
  const items=recordingsData.recordings.filter(x=>x.state!=='recording');
  const signature=JSON.stringify(items);
  if(list.dataset.signature===signature)return;list.dataset.signature=signature;
  const reasons={'left-call':'Saiu da call','channel-changed':'Mudança de call','safe-mode':'Safe Mode','kill-switch':'Kill Switch','stop-all':'Parar tudo','duration-limit':'Limite de 2 horas','size-limit':'Limite de tamanho','track-limit':'Limite de participantes','disk-error':'Falha no disco',operator:'Parada pelo painel',shutdown:'Programa encerrado'};
  const file=(r,name,label)=>{const url=`/api/recordings/${encodeURIComponent(r.id)}/${encodeURIComponent(name)}`;return `<div class="recording-track"><strong>${esc(label)}</strong><audio controls preload="none" aria-label="${esc(label)}" src="${url}"></audio><a class="button-link" href="${url}?download=1" download="${esc(name)}">Baixar WAV</a></div>`;};
  list.innerHTML=items.length?items.map(r=>`<article class="recording-item"><h3>${esc(new Date(r.startedAt).toLocaleString('pt-BR'))} · ${esc(recordingDuration(r.durationMs))}</h3><p class="muted">Servidor ${esc(r.guildId)} · Call ${esc(r.channelId)} · ${esc(reasons[r.reason]||r.reason||'Sessão anterior')}</p>${r.state==='finishing'?'<p class="small-gap">Finalizando e juntando as faixas… Os áudios aparecerão aqui.</p>':(r.state==='interrupted'?'<p class="error-text small-gap">O programa foi interrompido. As faixas já gravadas continuam disponíveis.</p>':'')+(r.error?`<p class="error-text small-gap">${esc(r.error)}</p>`:'')+(r.mixedFile?file(r,r.mixedFile,'Conversa completa'):'')+(r.tracks?.length?'<details class="small-gap"><summary>Faixas individuais · '+r.tracks.length+'</summary>'+r.tracks.map(t=>file(r,t.file,t.name+(t.bot?' · saída do bot':''))).join('')+'</details>':empty('Nenhum áudio foi recebido durante esta gravação.'))}</article>`).join(''):empty('Nenhuma gravação salva. Entre na call e clique em Iniciar gravação.');
}
document.addEventListener('click',async event=>{const b=event.target.closest('button');if(!b)return;
  if(b.id==='refreshRecordings')await loadRecordings();
  if(b.id==='copyRecordingFolder'){try{await navigator.clipboard.writeText(recordingsData?.root||'');feedback('Caminho da pasta copiado. Cole na barra de endereços do Explorador de Arquivos.');}catch{feedback('Pasta: '+(recordingsData?.root||'indisponível'));}}
});
