const $ = selector => document.querySelector(selector);
let catalog, status, toastTimer, connectionSaving = false, connectionInitialized = false;
const actions = [];

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a ação.');
  return data;
}
function setText(selector, value) { const node = $(selector); if (node) node.textContent = value; }
function setDisabled(selector, state) { const node = $(selector); if (node) node.disabled = state; }
function inputValue(selector) { return $(selector).value.trim(); }
function toast(message, error = false) {
  const node = $('#toast'); node.textContent = message; node.classList.toggle('error', error); node.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 4200);
}
function showAction(message, error = false) {
  $('#actionFeedback').hidden = false; $('#actionFeedback').classList.toggle('error', error); setText('#actionFeedbackText', message);
  actions.unshift({ message, error, at: new Date() }); actions.splice(12);
  const list = $('#actionHistory'); list.replaceChildren();
  for (const item of actions) {
    const row = document.createElement('li'); row.className = item.error ? 'error' : '';
    const time = document.createElement('time'); time.textContent = item.at.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const text = document.createElement('span'); text.textContent = item.message; row.append(time, text); list.append(row);
  }
  setText('#lastAction', message);
}
function addOption(select, value, label) { const item = document.createElement('option'); item.value = value; item.textContent = label; select.append(item); }
function setOptions(selector, items, selected, label, placeholder = '') {
  const select = $(selector); select.replaceChildren(); if (placeholder) addOption(select, '', placeholder);
  for (const item of items) addOption(select, item.id || item, label ? label(item) : item.name || item);
  if (selected && Array.from(select.options).some(item => item.value === selected)) select.value = selected;
}
function metric(name) { const value = status && status.metrics && status.metrics[name] && status.metrics[name].last; return Number.isFinite(value) ? String(value) + 'ms' : '—'; }

const TIMBRE_LABELS = { feminino: 'Feminino', masculino: 'Masculino', neutro: 'Neutro' };
const EMOTION_DESCRIPTIONS = {
  natural: 'Espont\u00e2nea e equilibrada para conversar na call.', feliz: 'Mais animada e positiva.', fria: 'Direta, breve e pouco emotiva.',
  sedutora: 'Suave, confiante e provocante.', engracada: 'Leve, brincalhona e com piadas.', seria: 'Calma, madura e objetiva.',
  anime: 'Fofa, expressiva e inspirada em anime.', brava: 'Impaciente, mas sem pesar a m\u00e3o.',
  explosiva: 'Intensa, debochada e cheia de energia, com respostas afiadas e humor provocador.',
  depre: 'Melanc\u00f3lica e mais lenta.', narradora: 'Dram\u00e1tica e imersiva.'
};
function voiceProfiles() {
  const profiles = catalog?.voiceProfiles;
  return Array.isArray(profiles) && profiles.length ? profiles : (catalog?.voices || []).map(id => ({ id, name: id, timbre: 'neutro', style: 'Vers\u00e1til' }));
}
function voiceProfile(id) { return voiceProfiles().find(item => item.id === id); }
function voiceLabel(profile) { return `${profile.name} · ${TIMBRE_LABELS[profile.timbre] || 'Neutro'} · ${profile.style}`; }
function renderVoiceOptions() {
  const select = $('#voiceSetting'), filter = $('#voiceFilter').value, profiles = voiceProfiles();
  const selected = voiceProfile(status?.voice);
  const visible = profiles.filter(profile => filter === 'all' || profile.timbre === filter);
  select.replaceChildren();
  const appendGroup = (label, items) => {
    if (!items.length) return;
    const group = document.createElement('optgroup'); group.label = label;
    for (const profile of items) addOption(group, profile.id, voiceLabel(profile));
    select.append(group);
  };
  if (selected && !visible.some(profile => profile.id === selected.id)) appendGroup('Selecionada atualmente', [selected]);
  for (const timbre of ['feminino', 'masculino', 'neutro']) appendGroup(`Timbre ${TIMBRE_LABELS[timbre]}`, visible.filter(profile => profile.timbre === timbre));
  if (!select.options.length) addOption(select, '', 'Nenhuma voz nesse filtro');
  if (selected && Array.from(select.options).some(option => option.value === selected.id)) select.value = selected.id;
}
function renderVoiceProfile() {
  const selected = voiceProfile(status?.voice) || voiceProfile($('#voiceSetting').value);
  setText('#voiceProfileTag', selected ? TIMBRE_LABELS[selected.timbre] || 'Neutro' : '—');
  setText('#voiceProfile', selected ? `${selected.name}: timbre percebido ${TIMBRE_LABELS[selected.timbre]?.toLowerCase() || 'neutro'} · estilo ${selected.style}.` : 'Escolha uma voz para ver seu perfil.');
  setText('#voiceProfileNote', catalog?.voiceProfileNote || 'Use os perfis como refer\u00eancia para escolher o timbre.');
  const list = $('#voiceCatalog'); list.replaceChildren();
  for (const profile of voiceProfiles()) {
    const row = document.createElement('li'); row.className = profile.id === status?.voice ? 'current' : '';
    const name = document.createElement('strong'), detail = document.createElement('small');
    name.textContent = profile.name; detail.textContent = `${TIMBRE_LABELS[profile.timbre] || 'Neutro'} · ${profile.style}`;
    row.append(name, detail); list.append(row);
  }
}
function renderVoiceSettings() {
  if (!catalog) return;
  renderVoiceOptions(); renderVoiceProfile();
  const selectedEmotion = $('#emotionSetting').value || status?.emotion || 'natural';
  setText('#emotionCurrent', status?.emotion || selectedEmotion);
  setText('#emotionDescription', EMOTION_DESCRIPTIONS[selectedEmotion] || 'Escolha o tom principal da conversa.');
  const interaction = $('#interactionSetting');
  if (document.activeElement !== interaction) interaction.value = status?.interaction || '';
  updateCount('#interactionSetting', '#interactionCount');
}

async function loadCatalog() {
  catalog = await request('/api/catalog');
  setOptions('#serverSelect', catalog.servers, status && status.guildId, item => item.name, 'Escolha um servidor');
  setOptions('#textSelect', catalog.textChannels, status && status.textChannelId, item => '#' + item.name, 'Escolha um canal de texto');
  setOptions('#voiceSelect', catalog.voiceChannels, status && status.voiceChannelId, item => item.name, 'Seguir minha call (OWNER_ID)');
  setOptions('#emotionSetting', catalog.emotions, status && status.emotion, item => item);
  renderVoiceSettings();
  renderControls();
}
function renderConnection() {
  const saved = status && status.connection; if (!saved) return;
  if (!connectionInitialized) { $('#connectionMode').value = saved.mode; connectionInitialized = true; }
  const selfbot = $('#connectionMode').value === 'selfbot', hasToken = selfbot ? saved.hasSelfbotToken : saved.hasBotToken;
  setText('#connectionTokenLabel', selfbot ? 'Token da sua conta' : 'Token do bot');
  $('#connectionToken').placeholder = hasToken ? 'Deixe em branco para manter o token salvo' : 'Cole o token aqui';
  setText('#tokenHelp', hasToken ? 'Já existe um token salvo para este modo. Preencha somente para substituí-lo.' : 'O token fica salvo no arquivo .env deste computador.');
  $('#selfbotNotice').hidden = !selfbot; setDisabled('#connectionMode', connectionSaving); setDisabled('#connectionToken', connectionSaving);
  setDisabled('#saveConnection', connectionSaving || (!hasToken && !inputValue('#connectionToken')));
  setText('#saveConnection', connectionSaving ? 'Salvando…' : 'Salvar conexão'); setText('#connectionModeTag', saved.activeMode === 'selfbot' ? 'Selfbot' : 'Bot oficial');
  setText('#connectionMessage', saved.restartRequired ? 'Conexão salva. Reinicie o programa para aplicar.' : status.connectionError || (status.online ? 'Conectado como ' + status.username + '.' : 'Aguardando conexão com o Discord.'));
  $('#botInvite').hidden = saved.activeMode === 'selfbot';
}
function renderPresence() {
  const presence = status && status.presence;
  const available = Boolean(status && status.botMode);
  $('#presenca').hidden = !available;
  if (!available || !presence) return;
  $('#presenceStatus').value = presence.status || 'online'; $('#presenceType').value = String(presence.type == null ? 0 : presence.type);
  if (document.activeElement !== $('#presenceName')) $('#presenceName').value = presence.name || '';
  if (document.activeElement !== $('#presenceState')) $('#presenceState').value = presence.state || '';
  if (document.activeElement !== $('#presenceUrl')) $('#presenceUrl').value = presence.url || '';
  $('#presenceUrlField').hidden = Number($('#presenceType').value) !== 1;
}
function renderControls() {
  if (!status) return;
  const online = !!status.online, guild = !!status.guildId, channel = !!status.textChannelId, call = !!status.inCall;
  setDisabled('#serverSelect', !online || !(catalog && catalog.servers.length)); setDisabled('#textSelect', !online || !guild); setDisabled('#voiceSelect', !online || !guild); setDisabled('#join', !online || !guild || call);
  for (const button of document.querySelectorAll('[data-group="call"], [data-group="speech"], [data-action="listening"], [data-action="stopAll"], [data-action="skip"], [data-action="stopMusic"]')) button.disabled = !call;
  for (const selector of ['#say', '#announce', '#play', '#volume', '#musicVolume']) setDisabled(selector, !call);
  for (const selector of ['#voiceSetting', '#voiceFilter', '#emotionSetting', '#speed', '#interactionSetting', '#saveInteraction', '#clearInteraction', '#customEmotionSetting', '#saveCustomEmotion']) setDisabled(selector, false);
  for (const selector of ['#send', '#mention', '#searchMembers', '#memberQuery']) setDisabled(selector, !channel);
  for (const button of document.querySelectorAll('[data-action="summarize"], [data-action="clearContext"], [data-action="aliveChannel"]')) button.disabled = !channel;
}
function renderQueue() {
  const queue = status.musicQueue || [], list = $('#musicQueue'); list.replaceChildren();
  queue.forEach((track, index) => {
    const row = document.createElement('li'), number = document.createElement('span'), name = document.createElement('div');
    row.className = track.current ? 'current' : ''; number.textContent = String(index + 1).padStart(2, '0'); name.textContent = track.title;
    if (track.current) { const now = document.createElement('small'); now.textContent = 'Tocando agora'; name.append(now); }
    row.append(number, name); list.append(row);
  });
  $('#queueEmpty').hidden = queue.length > 0; setText('#queueCount', String(status.musicQueueSize || 0) + ' faixa' + (status.musicQueueSize === 1 ? '' : 's'));
}
function render() {
  if (!status) return;
  renderConnection();
  renderPresence();
  const online = !!status.online, guild = !!status.guildId, channel = !!status.textChannelId, call = !!status.inCall;
  $('#onlineDot').classList.toggle('live', online); setText('#connection', online ? 'Online' : status.connectionError ? 'Sem conexão' : 'Conectando'); setText('#accountName', status.username || 'Conectando ao painel'); setText('#syncStatus', online ? 'Atualizado agora' : 'Aguardando conexão');
  setText('#callTag', call ? 'Na call: ' + status.call : 'Fora da call');
  setText('#destinationHint', !online ? 'Conecte a conta para carregar os servidores.' : !guild ? 'Escolha um servidor para continuar.' : !channel ? 'Escolha um canal de texto para enviar mensagens.' : 'Enviando mensagens em #' + status.channel + '.');
  setText('#speechDestination', call ? status.call : 'Entre em uma call'); setText('#activityLabel', call ? 'Na call ' + status.call : 'Fora da call');
  setText('#voiceDescription', call ? (status.speaking ? 'A Neva7 está falando agora.' : 'Pronta para conversar.') : 'Sua voz fica pronta ao entrar.');
  $('.voice-wave').classList.toggle('active', !!(status.speaking || status.synthesizing)); setText('#voiceInitial', (status.voice || 'N').slice(0, 1).toUpperCase()); setText('#textChannelTag', channel ? '#' + status.channel : 'Sem canal selecionado'); setText('#ttsTag', status.tts || 'Voz');
  setText('#musicState', String(status.musicState || 'parada').toUpperCase()); setText('#currentTrack', status.currentTrack || 'Sua próxima música começa aqui'); $('#musicError').hidden = !status.musicError; setText('#musicError', status.musicError || '');
  $('#speechUnavailable').hidden = call; $('#messageUnavailable').hidden = channel; setText('#musicHint', call ? 'Escolha uma música para tocar nesta call.' : 'Entre em uma call para tocar música.'); setText('#aliveChannelHint', channel ? 'Usar #' + status.channel + ' para puxar assunto.' : 'Selecione um canal de texto na aba Call e voz.');
  setText('#metricStt', metric('stt')); setText('#metricLlm', metric('llm')); setText('#metricVoiceReply', metric('voiceReply')); setText('#metricReply', metric('reply'));
  setText('#metricFirstToken', metric('firstToken')); setText('#metricFirstSentence', metric('firstSentence'));
  setText('#metricFirstAudio', metric('firstAudio')); setText('#metricTextVoiceReply', metric('textVoiceReply'));
  for (const element of document.querySelectorAll('[data-metric-summary]')) {
    const value = status.metrics?.[element.dataset.metricSummary];
    element.textContent = value?.samples ? `P50 ${value.p50 ?? '—'} ms · P95 ${value.p95 ?? '—'} ms · Maior ${value.max ?? '—'} ms · ${value.samples} amostras` : 'Ainda sem medições';
  }
  setText('#speedValue', String(status.speed || 1) + '×'); setText('#volumeValue', status.volume == null ? '—' : String(status.volume) + '%'); setText('#musicVolumeValue', status.volume == null ? '—' : String(status.volume) + '%');
  $('#speed').value = Math.max(.25, Math.min(4, Number(status.speed) || 1)); if (status.volume != null) { $('#volume').value = status.volume; $('#musicVolume').value = status.volume; }
  setText('#listening', status.listening ? 'Desligar escuta' : 'Ligar escuta'); $('#listening').setAttribute('aria-pressed', String(!!status.listening));
  for (const pair of [['#autoJoin', status.autoJoin], ['#replyInText', status.replyInText], ['#alive', status.alive]]) { setText(pair[0], pair[1] ? 'Ligado' : 'Desligado'); $(pair[0]).parentElement.setAttribute('aria-pressed', String(!!pair[1])); }
  setText('#aliveChannels', String(status.aliveChannels || 0) + ' canal(is)'); $('#aliveChannels').parentElement.setAttribute('aria-pressed', String(!!status.aliveInChannel));
  $('#connectionBanner').hidden = online; if (!online) { setText('#bannerTitle', 'Conecte a conta para usar a Neva7'); setText('#bannerText', status.connectionError || 'Configure o token do bot ou da conta pessoal no painel.'); }
  $('#stepConnection').className = online ? 'done' : 'current'; $('#stepServer').className = guild ? 'done' : online ? 'current' : ''; $('#stepCall').className = call ? 'done' : guild ? 'current' : '';
  const invite = status.inviteUrl || ''; $('#inviteLink').value = invite; setDisabled('#copyInvite', !invite); const link = $('#openInvite'); link.setAttribute('aria-disabled', String(!invite)); link.tabIndex = invite ? 0 : -1; if (invite) link.href = invite; else link.removeAttribute('href');
  setText('#inviteHelp', invite ? 'Abra o convite e escolha o servidor no Discord, ou copie o link para compartilhar.' : 'Conecte o bot para gerar o link de convite.');
  renderQueue(); renderVoiceSettings(); renderControls();
}
async function refresh(withCatalog = false) {
  const wasOnline = status && status.online; status = (await request('/api/status')).status; render();
  if (withCatalog || !catalog || (!wasOnline && status.online)) await loadCatalog();
}
async function action(name, payload = {}, output = false, withCatalog = false) {
  try {
    const data = await request('/api/action', { method: 'POST', body: JSON.stringify({ action: name, value: payload }) }); status = data.status; render();
    if (output || data.message.includes('\n')) { setText('#output', data.message); $('#activity').open = true; }
    toast(data.message); showAction(data.message); if (withCatalog) await loadCatalog();
  } catch (error) { toast(error.message, true); showAction(error.message, true); }
}
async function searchMembers() {
  const query = inputValue('#memberQuery'); if (query.length < 2) return toast('Digite ao menos 2 letras para buscar uma pessoa.', true);
  try { const data = await request('/api/members?q=' + encodeURIComponent(query)); setOptions('#memberSelect', data.members, '', item => item.name, data.members.length ? 'Selecione uma pessoa' : 'Ninguém encontrado'); setDisabled('#memberSelect', !data.members.length); toast(data.members.length ? String(data.members.length) + ' pessoa(s) encontrada(s).' : 'Ninguém encontrado com esse nome.'); } catch (error) { toast(error.message, true); }
}
function updateCount(input, output) { setText(output, String($(input).value.length) + ' / ' + $(input).maxLength); }

$('#refresh').addEventListener('click', () => refresh(true).catch(error => toast(error.message, true))); $('#dismissFeedback').addEventListener('click', () => { $('#actionFeedback').hidden = true; });
$('#connectionMode').addEventListener('change', () => { $('#connectionToken').value = ''; renderConnection(); }); $('#connectionToken').addEventListener('input', renderConnection);
$('#revealToken').addEventListener('click', () => { const field = $('#connectionToken'), show = field.type === 'password'; field.type = show ? 'text' : 'password'; setText('#revealToken', show ? 'Ocultar' : 'Mostrar'); });
$('#connectionForm').addEventListener('submit', async event => { event.preventDefault(); if (connectionSaving) return; connectionSaving = true; renderConnection(); try { const data = await request('/api/connection', { method: 'POST', body: JSON.stringify({ mode: $('#connectionMode').value, token: $('#connectionToken').value }) }); $('#connectionToken').value = ''; status.connection = data.connection; toast(data.message); showAction(data.message); } catch (error) { toast(error.message, true); showAction(error.message, true); } finally { connectionSaving = false; renderConnection(); } });
$('#presenceType').addEventListener('change', () => { $('#presenceUrlField').hidden = Number($('#presenceType').value) !== 1; });
$('#presenceForm').addEventListener('submit', event => { event.preventDefault(); action('presence', { status: $('#presenceStatus').value, type: $('#presenceType').value, name: inputValue('#presenceName'), state: inputValue('#presenceState'), url: inputValue('#presenceUrl') }); });
$('#copyInvite').addEventListener('click', async () => { const field = $('#inviteLink'); if (!field.value) return; try { await navigator.clipboard.writeText(field.value); toast('Link de convite copiado!'); } catch { field.focus(); field.select(); toast('Link selecionado. Use Ctrl+C para copiar.'); } });
$('#serverSelect').addEventListener('change', event => { setOptions('#memberSelect', [], '', null, 'Busque alguém primeiro'); action('selectServer', { id: event.target.value }, false, true); }); $('#textSelect').addEventListener('change', event => action('selectText', { id: event.target.value }));
$('#join').addEventListener('click', () => action('join', { channelId: $('#voiceSelect').value })); $('#say').addEventListener('click', () => action('say', { text: inputValue('#speechText') })); $('#announce').addEventListener('click', () => action('announce', { text: inputValue('#speechText') })); $('#play').addEventListener('click', () => action('play', { query: inputValue('#musicQuery') })); $('#send').addEventListener('click', () => action('send', { text: inputValue('#chatText') })); $('#mention').addEventListener('click', () => action('mention', { userId: $('#memberSelect').value, text: inputValue('#chatText') })); $('#searchMembers').addEventListener('click', searchMembers);
$('#voiceFilter').addEventListener('change', () => { renderVoiceOptions(); renderVoiceProfile(); });
$('#voiceSetting').addEventListener('change', event => action('voice', { name: event.target.value }));
$('#emotionSetting').addEventListener('change', event => action('emotion', { name: event.target.value }));
$('#saveInteraction').addEventListener('click', () => action('interaction', { text: inputValue('#interactionSetting') }));
$('#clearInteraction').addEventListener('click', () => { $('#interactionSetting').value = ''; updateCount('#interactionSetting', '#interactionCount'); action('interaction', { text: '' }); });
$('#saveCustomEmotion').addEventListener('click', () => action('customEmotion', { text: inputValue('#customEmotionSetting') }));
$('#speed').addEventListener('change', event => action('speed', { value: event.target.value })); for (const field of document.querySelectorAll('[data-volume]')) field.addEventListener('change', event => action('volume', { value: event.target.value }));
for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', () => action(button.dataset.action, {}, ['diagnostics', 'summarize'].includes(button.dataset.action)));
for (const pair of [['#speechText', '#speechCount'], ['#chatText', '#chatCount'], ['#interactionSetting', '#interactionCount'], ['#customEmotionSetting', '#customEmotionCount']]) { $(pair[0]).addEventListener('input', () => updateCount(pair[0], pair[1])); updateCount(pair[0], pair[1]); }
$('#speechText').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); action('say', { text: inputValue('#speechText') }); } }); $('#chatText').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); action('send', { text: inputValue('#chatText') }); } });
$('#shutdown').addEventListener('click', () => $('#shutdownDialog').showModal()); $('#shutdownDialog').addEventListener('close', () => { if ($('#shutdownDialog').returnValue === 'confirm') action('shutdown'); });
for (const link of document.querySelectorAll('nav [data-view]')) link.addEventListener('click', event => { event.preventDefault(); const view = link.dataset.view; for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== view; for (const item of document.querySelectorAll('nav [data-view]')) item.setAttribute('aria-current', item === link ? 'page' : 'false'); document.getElementById(view).querySelector('h2').focus(); });
refresh(true).catch(error => { toast(error.message, true); showAction(error.message, true); }); setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 1500);
