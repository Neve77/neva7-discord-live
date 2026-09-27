# Neva7 · conversa de voz para Discord

## Iniciar

Requisitos: Node 22.12+, FFmpeg disponível no PATH ou em `FFMPEG_PATH`, bot oficial convidado ao servidor, permissões de conectar/falar e eventos de voz. As dependências já constam do `package.json`.

No Windows, `npm.cmd run setup:ffmpeg` instala uma distribuição local em `tools/ffmpeg`, sem alterar o PATH ou exigir uma instalação global. O script baixa o [Essentials do Gyan](https://www.gyan.dev/ffmpeg/builds/), verifica o SHA-256 publicado e valida os caminhos do ZIP antes de extrair. A aplicação também procura automaticamente esse executável local.

1. Configure `.env` com `DISCORD_MODE=bot`, `BOT_TOKEN`, `GEMINI_API_KEY` e `VOICE_PIPELINE=live`.
2. `GEMINI_LIVE_MODEL` configura o modelo inicial; o padrão é `gemini-3.8-live`. O modelo precisa estar disponível para sua chave/projeto. O painel não troca modelos nem ativa faturamento automaticamente.
3. Execute `npm.cmd start` no PowerShell (ou `npm start` em um shell que permita o npm).
4. Abra `http://127.0.0.1:3210/`, configure a conta em **Conexão Discord**, selecione servidor/call e entre. `/live` abre o mesmo painel.
5. Chame a IA por “Neve”, “Nevas” ou “Neva7”. Modifique os nomes em **Inteligência**. O modo inicial é conversational com “Só responder quando chamado” ligado.
6. **Voz → Testar voz na call** usa a configuração salva, transmite áudio aos participantes e consome a API. Esse teste é manual; o laboratório de endpoint é offline.

Para entrar automaticamente ao iniciar, defina `LIVE_GUILD_ID` e `LIVE_CHANNEL_ID` ou preencha os IDs no dashboard. A seleção manual usa os nomes dos canais disponíveis. Kill Switch e Safe Mode impedem a entrada automática.

`live-settings.json` é criado ao salvar configurações e tem precedência sobre os valores iniciais do ambiente. Desative **Conversa Live ativa** para voltar ao caminho anterior; apenas alterar `.env` não substitui uma configuração já salva pelo painel.

O [guia do painel único](PAINEL.md) explica cada área, as funções antigas, os avisos e os controles de proteção. **Inteligência → Idiomas** entende PT-BR, espanhol e inglês e acompanha o idioma da fala por padrão. Um idioma de resposta fixo mantém a detecção dos três na entrada. A política do painel também se aplica ao caminho clássico e prevalece sobre os antigos idiomas fixos do `.env`.

**Gravações → Iniciar gravação** salva manualmente o áudio recebido e reproduzido na call em `recordings/`. Ao parar, gera `call.wav` e mantém as faixas individuais sincronizadas. Essa gravação local é independente de transcrições e memória da IA; seus arquivos permanecem no computador após sair da call. Veja limites e recuperação no [guia de gravação](PAINEL.md#gravar-a-call-no-computador).

## Caminho do áudio

```text
Discord Opus / User ID
  → PCM16 mono 16 kHz por participante
  → pre-roll limitado + VAD por energia
  → frames durante a fala → provider persistente por participante
  → endpoint local (pausa + transcrição disponível + outra pessoa falando)
  → fila de turnos com prioridade, idade máxima e uma resposta ativa
  → resposta PCM16 mono 24 kHz
  → política de participação + limites + responseId/epoch
  → prebuffer limitado → filtros FFmpeg → Opus → Discord
```

Há uma sessão do provider por participante ativo, até o limite configurado (8 por padrão). Isso preserva a identidade de falas simultâneas sem depender de diarização do modelo. Sessões ociosas expiram; ao atingir o limite, um participante ocioso pode ser removido. Cada conexão adiciona contexto recente da call e identidade como **dados de usuário**, nunca como instruções de sistema. Esse desenho pode consumir mais conexões/cota do que uma sessão única.

Os frames são enviados antes do endpoint. No Gemini, VAD automático é desativado e o aplicativo usa `activityStart` / `activityEnd`. O endpoint só libera uma resposta quando não há outra pessoa falando; em sobreposição, os fluxos permanecem separados. Um ID prioritário passa à frente dos turnos pendentes.

Voz contínua por 160 ms confirma a fala no preset inicial. Isso interrompe a reprodução atual, aborta o player, limpa os buffers e fecha a geração anterior. Um novo **epoch de conexão** e um novo **responseId** tornam callbacks atrasados obsoletos. Em turnos normais, a conexão é reutilizada; após cancelamento, é recriada com o contexto finalizado. A parte não ouvida da resposta cancelada não entra no histórico local.

## Providers e fallback

`LiveConversation` recebe um factory com este contrato:

```js
connect(); begin(context); sendAudio(pcm16k); end();
respondTool(call, result); close();
// Eventos: interim, transcript, audio, generationComplete, turnComplete,
// interrupted, error, goAway, tool, usage, provider-event.
```

- **gemini:** áudio de entrada e saída em streaming, transcrição fornecida pela Live API, sessão persistente, compressão de contexto no provider.
- **cascade:** componentes existentes de STT Groq/OpenAI → LLM → Edge → FFmpeg. STT recebe WAV em memória; Edge retorna MP3 em memória. Não grava áudio ou usa o arquivo de memória do LLM legado. O áudio de saída é enviado progressivamente ao mesmo coordenador. STT e geração de texto desse adapter aguardam etapas completas, portanto sua latência é maior e a transcrição não é incremental.

O fallback começa em **none**. Para usar **cascade**, configure `GROQ_API_KEY` ou `OPENAI_API_KEY` e a voz Edge. A troca é explícita, ocorre após falha fatal/cota ou esgotamento das tentativas e usa as mesmas políticas, contexto, cancelamento e buffers. A fala em andamento é descartada: repita-a após a recuperação. Não há repetição automática de áudio antigo. Se o fallback também falhar, a sessão entra em Safe Mode. **Rearmar** volta ao provider principal.

É possível selecionar Cascade como provider principal. Novos adapters podem ser registrados no mapa de providers do serviço sem alterar captura, coordenação ou dashboard. Ferramentas declarativas do Gemini não são executadas pelo adapter Cascade.

## Participação, personalidade e memória

**Observer** mantém contexto e suprime playback; **Conversational** responde a chamadas diretas e, quando a opção de chamada obrigatória estiver desligada, mantém continuidade por 45 segundos após responder; **Participative** permite respostas sem chamada. O modelo recebe instruções para avaliar a relevância. A opção “Só responder quando chamado” prevalece nos modos que permitem resposta.

As configurações de humor, energia, curiosidade, espontaneidade, formalidade, sarcasmo, concisão, estilo, pronúncia e ritmo sugerido entram nas instruções do modelo. Não mudam permissões. Há seis perfis e cinco presets; os valores são ajustáveis.

O contexto temporário fica em RAM. Apenas transcrições finalizadas entram no histórico. Hipóteses incrementais são descartáveis e só aparecem no painel se a exibição de transcrições estiver habilitada. O histórico é limitado; turnos antigos viram um **resumo extrativo** de trechos, com tamanho máximo. Não se trata de resumo semântico feito por outro modelo.

A memória permanente começa desligada. Para salvar uma nota, habilite a política, inclua o Discord ID autorizado e use **Memória → Adicionar nota**. As notas são isoladas por servidor e usuário; ficam em `live-memory.json`, ignorado pelo Git. O modelo não pode gravar notas, alterar políticas ou autorizar a si mesmo. Revogar a autorização impede que notas existentes sejam enviadas ao modelo; **Apagar nota** as remove do arquivo.

Sair da call apaga contexto e eventos por padrão. Se “Apagar sessão ao sair” estiver desligado, até cinco snapshots ficam em RAM até limpar o contexto ou encerrar o processo. Não há gravação automática de transcrições ou áudio em disco no Live/Cascade. O envio ao provider continua necessário para processar a conversa; as políticas de retenção do serviço externo são independentes.

## Segurança e recuperação

- Denylist de usuários/funções prevalece sobre allowlist. Allowlists vazias permitem participantes humanos. IDs e funções são verificados no servidor da call; funções ainda não verificadas bloqueiam a captura quando existe política por função. O bot consulta o membro e atualizações do Discord revogam acesso sem reiniciar.
- Ferramentas começam desligadas. Cada execução exige ferramenta habilitada e usuário ou função autorizada. Só há **clock** e **calculator**, ambas sem efeitos externos. Calculadora tem parser aritmético, sem `eval`, JavaScript arbitrário ou acesso ao sistema. Ferramentas futuras com ações sensíveis precisarão de um fluxo de confirmação próprio.
- A hierarquia de prompt complementa verificações locais; não promete eliminar semanticamente todo prompt injection. Voz/contexto não têm acesso aos setters administrativos.
- **Parar resposta** cancela o turno. **Safe Mode** suspende automação. **Kill Switch** persiste o bloqueio, cancela áudio, encerra calls e impede novas mensagens/calls até rearmar. O bloqueio de mensagens é verificado também ao retirar requisições da fila REST.
- Limites: caracteres recebidos na transcrição de saída, duração do áudio gerado, tempo de resposta, respostas/minuto, interrupções/minuto, cooldown, quantidade de participantes e tamanho/idade das filas. Como áudio e transcrição chegam de forma independente, o limite de caracteres não desfaz áudio já ouvido; os limites de bytes/duração são independentes dele.
- Watchdog monitora RSS, CPU, atraso do event loop, filas, erros e duração dos turnos. RSS/atraso acima dos limites, excesso de erros ou interrupções acionam proteção. Três respostas textuais repetidas consecutivas ativam Silent Mode; uma nova chamada direta libera a conversa.
- Provider reconecta com backoff limitado e restaura contexto local. Credencial/cota/formato inválido não entram em repetição infinita. Aviso `goAway` gira a conexão no fim do turno. Não reutiliza handles de resumption de turnos cancelados.
- Discord pausa a conversa quando a conexão de voz cai, aguarda recuperação e tenta `rejoin` até quatro vezes. Ao esgotar, encerra a call. Música e escuta desligada pausam o Live.

O painel só escuta em loopback, valida Host/Origin, exige JSON para ações e aplica CSP. Segredos não são incluídos no status. Os controles administrativos pressupõem acesso confiável a este computador; não exponha a porta por proxy público sem uma camada própria de autenticação.

## Dashboard e observabilidade

| Área | Recursos conectados |
| --- | --- |
| Pipeline | Estado real, etapas, contadores, eventos e conexão da call |
| Inteligência | Provider/modelo, fallback, participação, reconexão e autojoin |
| Personalidade | Seis perfis e parâmetros de estilo |
| Participantes | Identidade, fluxo, conexão e buffers por pessoa |
| Conversação | VAD, endpoint, limites e transcrições autorizadas |
| Voz | Timbre/ritmo, pitch FFmpeg, volume, expressão e teste na call |
| Gravações | Gravação manual local, WAV misturado e individual, player e download |
| Áudio | Prebuffer, limites, normalização, compressor, limiter, EQ e redução de ruído na saída |
| Performance | P50/P95/P99, último valor, CPU, RSS e atraso do processo |
| Laboratório | Simulação local de endpoint/participação e presets |
| Histórico | Transcrições finais autorizadas e snapshots temporários |
| Custos | Tokens reportados e estimativa com preços fornecidos pelo operador |
| Ferramentas | Clock/calculator e autorizações de usuário/função |
| Prompt Manager | Instruções do administrador e prompt efetivo |
| Memória | Política, contexto temporário e notas autorizadas |
| Segurança | Limites, listas, privacidade e controles de emergência |
| Developer Mode | Estado, contadores, eventos do provider, frames amostrados e replay |

Métricas ficam em janelas de até 200 amostras; a timeline mantém 300 eventos. “Total” mede fim da fala → início real do playback. “First token” mede a primeira transcrição textual de saída disponível, não tokens internos de raciocínio. Developer Mode amostra um evento de frame a cada cinco frames recebidos. Logs técnicos omitem conteúdo de voz, áudio, prompts, payloads do provider e credenciais.

O replay exporta JSON técnico e oferece um cursor para percorrer os eventos importados; não reenvia áudio nem consome API. A estimativa de custo usa preços configurados e tokens reportados, inclui novamente o contexto de cada turno e não substitui o faturamento do provider. Não há valores de preço pré-preenchidos. Cascade não fornece tokens de custo ao monitor atual.

## Limites conhecidos e validação

- VAD é uma heurística por energia, não um modelo neural. Endpoint usa pausa, hipótese textual disponível, finais incompletos comuns em português e sobreposição. Não garante compreensão semântica de toda pausa; o laboratório mostra exatamente essa regra local.
- O Gemini determina quando envia hipóteses/transcrições. Sem transcrição disponível, endpoint usa pausa e atividade dos demais participantes. O aplicativo não inventa transcrições parciais; o fallback tem STT final somente.
- Relevância espontânea e estilo são instruções ao modelo, não uma classificação determinística perfeita de intenção. “Só responder quando chamado” tem gate local por palavras inteiras.
- Backpressure cancela um turno se o produtor ultrapassar o teto; não acumula áudio indefinidamente nem remove sílabas no meio de uma resposta. O envio de entrada é cadenciado. Prebuffer suaviza jitter, mas depende da rede e do dispositivo.
- O receiver não expõe estatísticas RTP suficientes para calcular packet loss exato. Gaps de captura são medidos separadamente e **não** são apresentados como perda de pacotes.
- Pitch, EQ, redução de ruído e dinâmica usam FFmpeg na saída. Velocidade no Gemini é uma instrução de ritmo aproximado, sem garantia de fator exato. O limite de entrada é local; não há cancelamento de ruído neural de entrada ou cancelamento acústico de eco.
- Web, documentos, jogos, APIs externas, modelos locais e confirmações para ações sensíveis são pontos de extensão, conforme o escopo futuro do documento. Não aparecem como ferramentas já disponíveis.
- O pipeline antigo da Central, mensagens de texto, automações sociais e seus arquivos de memória continuam com políticas próprias. `VOICE_PIPELINE=legacy` não oferece as garantias de privacidade do Live. O fallback **cascade** pertence ao Live e evita esses arquivos legados.

Testes locais: `npm.cmd test`. Os testes usam providers/transporte simulados, cobrem streaming antes do endpoint, concorrência de participantes, barge-in, eventos atrasados, limites, quotas locais, loop detection, atualização de configuração, reconexão, fallback, memória, ferramentas e proteção HTTP. `npm.cmd run preview:live` serve o dashboard offline em 3211 e salva alterações apenas em RAM.

`npm.cmd run live-audio-check` valida o encoder real com um tom sintético em memória: PCM → redução de ruído/EQ/pitch/dinâmica/limiter → Ogg/Opus. Não abre microfone, não toca no dispositivo de áudio e não usa Discord ou APIs de IA.

Esses testes e a renderização do dashboard não substituem uma chamada real: latência de rede, permissões do servidor, modelo disponível, qualidade do microfone e quotas precisam ser verificados com seu bot e sua chave. Nenhum teste automático do projeto entra em uma call ou consome a API.

## Fontes dos contratos externos

- [Gemini Live: áudio, transcrição e atividade manual](https://ai.google.dev/gemini-api/docs/live-api/capabilities).
- [Gerenciamento de sessão, goAway e compressão](https://ai.google.dev/gemini-api/docs/live-api/session-management).
- [Referência WebSocket e uso de tokens](https://ai.google.dev/api/live).
- [Discord VoiceReceiver e associação de SSRC ao usuário](https://discordjs.dev/docs/packages/voice/main/VoiceReceiver:Class).

Implementação principal: `src/live/`; integração Discord/PCM: `src/voice.js`; inicialização: `src/index.js`; HTTP local: `src/web-panel.js`. Nenhuma dependência de produção adicional foi necessária.
