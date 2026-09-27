# Neva7 — IA de voz para Discord

<div align="center">
  <p><strong>Uma companheira de call que escuta, conversa, toca música e reage em tempo real.</strong></p>
  <p>Gemini Live, interrupção natural de fala, personalidades configuráveis e uma central web completa — tudo rodando no seu computador.</p>

  [![Node.js](https://img.shields.io/badge/Node.js-22.12%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
  [![Discord](https://img.shields.io/badge/Discord-voz%20e%20texto-5865F2?logo=discord&logoColor=white)](https://discord.com/developers/applications)
  [![Gemini](https://img.shields.io/badge/Gemini-Live-4285F4?logo=google&logoColor=white)](https://ai.google.dev/)
  [![License: MIT](https://img.shields.io/badge/licença-MIT-green.svg)](LICENSE)
</div>

## Visão geral

A Neva7 é um bot open source para Discord capaz de participar de chamadas de voz, entender cada pessoa separadamente e responder por voz ou texto. O pipeline recebe áudio PCM em tempo real, mantém uma sessão por participante e interrompe a resposta naturalmente quando alguém volta a falar.

Uma central local em **http://127.0.0.1:3210/** reúne conexão, voz, personalidade, idiomas, música, mensagens, automações, métricas e gravações. O projeto oferece suporte a PT-BR, espanhol e inglês, respondendo automaticamente no idioma detectado.

### Destaques

- **Conversa em tempo real:** Gemini Live com áudio transmitido enquanto a pessoa fala.
- **Interrupção natural:** cancela respostas e áudios antigos quando o interlocutor interrompe.
- **Várias personalidades:** presets de emoção e personalidade totalmente personalizável.
- **Central web:** controle do bot, chamadas, mensagens, música e configurações em um só lugar.
- **Música e efeitos:** YouTube, links diretos, anexos e arquivos locais.
- **Gravação de calls:** mix final e faixas individuais de cada participante.
- **Privacidade local:** credenciais, memórias, gravações e logs ficam fora do Git.
- **Testado:** suíte automatizada para voz, painel, memória, permissões e integrações.

## Início rápido

### Requisitos

- [Node.js 22.12 ou superior](https://nodejs.org/)
- [FFmpeg](https://ffmpeg.org/)
- Um bot criado no [Discord Developer Portal](https://discord.com/developers/applications)
- Uma chave `GEMINI_API_KEY` para a experiência Live

```powershell
git clone https://github.com/Neve77/neva7-discord-live.git
cd neva7-discord-live
Copy-Item .env.example .env
npm install
npm start
```

Depois, abra **http://127.0.0.1:3210/**. Para conhecer o painel sem configurar Discord ou IA:

```powershell
npm run preview:live
# Preview: http://127.0.0.1:3211/
```

> [!IMPORTANT]
> Nunca publique seu `.env` ou compartilhe tokens do Discord e chaves de API. O arquivo já está protegido pelo `.gitignore`.

## Como funciona

1. Uma pessoa chama o bot por menção ou por uma das palavras definidas em `WAKE_WORDS`.
2. A Neva7 entra na call, captura cada participante separadamente e detecta o fim da fala.
3. O Gemini processa a conversa e começa a devolver áudio antes de concluir toda a resposta.
4. Se alguém interromper, o áudio anterior é cancelado e o novo turno recebe prioridade.

O modo Live usa **bot oficial**, `GEMINI_API_KEY` e `VOICE_PIPELINE=live` por padrão. Groq e OpenAI continuam disponíveis para transcrição no pipeline clássico e no provider Cascade opcional. Para detalhes técnicos, consulte a [arquitetura do Live](docs/LIVE.md) e o [guia completo do painel](docs/PAINEL.md).

Para gravar uma chamada, use **Gravações → Iniciar gravação** na central. Ao finalizar, o sistema gera `call.wav` e preserva as faixas individuais dos participantes e da Neva7. Veja as [instruções e os limites de gravação](docs/PAINEL.md#gravar-a-call-no-computador).

## Configurar o bot no Discord

1. Acesse o [Discord Developer Portal](https://discord.com/developers/applications), selecione **New Application** e escolha um nome.
2. Em **Bot → Reset Token**, copie o token. Ele será exibido apenas uma vez.
3. Ative **Message Content Intent** e **Server Members Intent** na mesma página.
4. Em **OAuth2 → URL Generator**, selecione `bot` e conceda `Send Messages`, `Read Message History`, `Connect`, `Speak` e `Use Voice Activity`.
5. No Discord, ative **Configurações → Avançado → Modo Desenvolvedor**. Clique com o botão direito no seu perfil e use **Copiar ID**.

## Instalação detalhada

1. Instale Node.js 22.12+ e FFmpeg. No Windows, você pode usar:

```powershell
winget install Gyan.FFmpeg
```

Feche e abra novamente o terminal, depois confirme com `ffmpeg -version`. Se o executável não estiver no `PATH`, defina `FFMPEG_PATH=C:/caminho/para/ffmpeg.exe` no `.env`.

2. Copie o arquivo de exemplo e preencha pelo menos estas variáveis:

```dotenv
BOT_TOKEN=token_do_bot
OWNER_ID=teu_id
GEMINI_API_KEY=sua_chave_gemini
```

3. Instale as dependências, execute o diagnóstico e inicie:

```powershell
npm install
npm run setup:youtube
npm run doctor
npm start
```

O Groq e o OpenAI são opcionais. Configure `GROQ_API_KEY` ou `OPENAI_API_KEY` apenas se quiser usar os providers compatíveis do pipeline clássico ou Cascade.

## Central web

Ao executar `npm start`, abra **http://127.0.0.1:3210** no navegador. A central é local (não fica acessível por outros aparelhos), atualiza o status em tempo real e controla call, voz Gemini, música, conversa, personalidade e automações.

Em **Conexão Discord → Convite e conta ativa**, use **Adicionar ao servidor** para abrir o convite ou **Copiar convite** para compartilhá-lo. O link é gerado automaticamente com o ID do bot conectado e as permissões de texto e voz, seguindo o [fluxo oficial de convite do Discord](https://docs.discord.com/developers/topics/oauth2#bot-authorization-flow). Escolha o servidor na página do Discord.

No cartão **Conexão com o Discord**, escolha **Bot oficial** ou **Selfbot · conta pessoal**, cole o token no campo oculto e clique em **Salvar conexão**. Reinicie o programa para aplicar. Cada modo mantém seu próprio token; deixe o campo em branco para reutilizar o token já salvo no modo escolhido. Os valores ficam no `.env` local, ignorado pelo Git, e não são retornados pela API do painel. `DISCORD_MODE=bot` usa `BOT_TOKEN`; `DISCORD_MODE=selfbot` usa `TOKEN`, mesmo se houver um token de bot salvo. O site também abre sem token ou após falha de login, para permitir a correção. O convite para adicionar a servidores aparece apenas no modo bot oficial.

O [Discord proíbe selfbots e pode encerrar a conta pessoal](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots). Essa opção usa a autenticação legada já existente no projeto; não garante compatibilidade com todos os recursos do Discord.

Em **Mensagens → Mencionar uma pessoa**, busque pelo nome, escolha o resultado e escreva a mensagem. A Central gera a menção do Discord somente para a pessoa escolhida; não é necessário copiar ID. Ela também oferece **Limpar contexto da pesquisa** e **Parar tudo na call**, que cancela fala, resposta pendente e música da call.

Ela também mostra as últimas latências de transcrição, IA, resposta na call e resposta de texto. **Resposta na call** mede do último trecho de voz da pessoa até o player começar o áudio, incluindo o silêncio de fechamento, fila, STT, IA e síntese.

A escuta captura cada pessoa separadamente, em PCM mono de 16 kHz. Ruído e eventos de microfone não cancelam respostas. Após 300 ms de voz contínua, o interlocutor atual pode interromper; `OWNER_ID` também tem prioridade sobre outras pessoas. `VOICE_PRIORITY_USER_ID` permite escolher outro usuário; definido vazio, remove essa prioridade especial. Os demais aguardam uma fila de até três frases, uma por pessoa, descartadas após oito segundos para evitar respostas antigas. O limite de mensagens no chat não bloqueia a conversa por voz, e o envio do texto ocorre sem atrasar o áudio.

Na conversa por voz e nas menções do chat, a IA libera trechos da resposta enquanto continua gerando o restante. A primeira frase longa pode começar numa pausa natural ou num limite entre palavras. Enquanto um trecho toca, o próximo já é sintetizado; a fila prepara no máximo dois trechos por vez e reproduz na ordem. Interromper ou sair da call cancela também o áudio preparado. A transcrição ainda começa após o fim da fala da pessoa; esta otimização sobrepõe a geração da resposta, a síntese e a reprodução.

### Painel no terminal (opcional)

Defina `TERMINAL_PANEL=1` para usar também a interface de terminal. O menu tem cores, seções e status de música atualizado automaticamente. Os eventos ficam na opção **22**, sem empurrar a tela enquanto você digita. O layout se adapta à largura do terminal; `NO_COLOR=1` desativa cores.

- **1 / 2:** escolher servidor e canal de texto pelo nome.
- **3 / 4:** entrar e sair da call; escolha a call ou siga o usuário de `OWNER_ID`.
- **5 / 6:** testar a voz ou falar uma frase na call.
- **7–11:** tocar música, consultar fila, pular, parar e ajustar volume.
- **12–15:** mudar emoção, voz, velocidade e escuta.
- **16:** enviar uma mensagem ao canal de texto selecionado.
- **17 / 18:** ativar vida própria e adicionar/remover o canal selecionado.
- **19 / 20:** ativar entrada automática na call e respostas em texto.
- **21 / 22:** resumir o chat no terminal e consultar os últimos logs.
- **23:** diagnóstico local de conexão, gateway, IA, voz e filas REST, sem consumir API.
- **24:** repetir a última frase falada pelo painel.
- **25:** publicar um anúncio no canal selecionado e falá-lo na call.
- **0:** atualizar o status. **99** ou **Ctrl+C:** desligar o bot e sair das calls.

Em submenus, **Enter vazio cancela**. Emoção, voz, velocidade e opções 19/20 ficam salvas. Seleções de servidor/canal e vida própria valem para a sessão; `PANEL_GUILD` e `PANEL_CHANNEL` definem as seleções iniciais. O volume novo vale para os próximos áudios.

Para rodar somente com logs: `npm start -- --no-panel` ou defina `WEB_PANEL=0` e `TERMINAL_PANEL=0` no `.env`.

### Música

Entre na call pela opção **3** e use **7** com um link do YouTube, nome e artista ou arquivo da pasta `musicas`. Arquivos locais têm prioridade sobre a busca; são aceitos MP3, OGG, WAV, M4A, Opus, FLAC, AAC e WebM. Links diretos e anexos têm limite de 30 MB.

O YouTube usa o [yt-dlp oficial](https://github.com/yt-dlp/yt-dlp), instalado localmente com verificação de SHA-256. O Node já instalado executa os componentes JavaScript incluídos no executável, conforme a [documentação EJS](https://github.com/yt-dlp/yt-dlp/wiki/EJS). Tudo continua gratuito. Para atualizar a extração, execute `npm run setup:youtube` novamente. Vídeos privados, removidos ou que exigem login podem falhar; o motivo aparece no painel e nos logs.

O painel diferencia **carregando**, **tocando** e **parada**. As opções **9/10** cancelam mesmo durante o carregamento. O bot aguarda a música terminar antes de aplicar a saída por inatividade.

Para testar o caminho do áudio sem login no Discord nem transmissão em call:

```
npm run music-check -- "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
```

Esse teste verifica dois segundos de reprodução local; não verifica as permissões de uma call.

Se a call parar em `signalling`, consulte o erro detalhado em `logs/voz-AAAA-MM-DD.log`. O código solicita `GUILD_VOICE_STATES` no bit 7 (128), conforme a [documentação do gateway](https://docs.discord.com/developers/events/gateway#list-of-intents). Reinicie o processo após atualizar para aplicar os eventos solicitados no login.

## Como usa

Alguém te marca no chat:
```
@você e aí, bora jogar?
```
Se a pessoa tiver em call no mesmo servidor, o bot entra e começa a conversar. Isso também funciona quando o dono menciona o bot. Fala no microfone que ele escuta e responde falando.

Para verificar a voz, entre em uma call e envie `!entrar` e `!teste` no chat desse servidor. O bot precisa das permissões **Ver canal**, **Conectar** e **Falar** na call, inclusive nas permissões específicas do canal. `npm run doctor` verifica as dependências locais; `npm test` executa os testes sem conectar ao Discord.

## Configurar a emoção (só você digita)

Em qualquer chat, digite pela sua própria conta:

```
!emo lista
!emo feliz
!emo fria
!emo sedutora
!emo engracada
!emo seria
!emo anime
!emo brava
!emo set fala debochada, carioca, zoa tudo mas é gente boa
!emo atual
!voz francisca
!voz thalita
!velocidade 1.1
!status
!sair
!ajuda
```

Pra criar jeito novo permanente, edita `config.json` > `emotions` e usa `!emo <nome>`.

O preset `explosiva` traz energia alta, deboche, reações dramáticas e respostas curtas e afiadas, com palavrões ocasionais. Selecione **explosiva** no painel ou use `!emo explosiva`. Ele é o padrão inicial; sua seleção posterior continua salva em `emotion-state.json`.

## Comandos (manda você, dono)

```
!emo lista | !emo <nome> | !emo set <texto> | !emo atual
!voz thalita | !voz francisca | !voz antonio ...
!velocidade 1.1 | !status | !ajuda
!entrar | !sair | !teste
!resumo — resume o papo do chat
!toca <link YouTube | link .mp3 | nome> (./musicas) | anexa áudio junto
!fila | !pula | !para
!volume 0-200 | !muta (só texto) | !desmuta
```

## Novidades

- **Idioma:** detecção automática de PT-BR, espanhol e inglês; escolha o idioma de resposta em **Inteligência → Idiomas**.
- **Memória longa:** lembra de fatos entre sessões (`memory.json`, não vai pro git)
- **Wake word:** reage a `neve`, `nevas` ou `neva7` sem @. Personalize em `.env` com `WAKE_WORDS=neve,nevas,neva7`.
- **Interrupção:** exige 300ms de fala contínua acima do limiar de áudio; ruído isolado não corta a frase. **Sai sozinha** com call vazia
- **Proativa:** desligada por padrão; `PROACTIVE_VOICE=1` permite puxar assunto após 5min de silêncio
- **Música:** `!toca <nome e artista>` busca no YouTube; também aceita links, anexos e arquivos da pasta `musicas`.

## Arquivos (tudo próprio)

- `src/discord.js` — REST + gateway (login, mensagens, voice states, sem lib externa)
- `src/voice.js` — conexões via `@discordjs/voice`, fila de áudio e escuta PCM
- `src/voice-adapter.js` — entrega à biblioteca os eventos de voz do próprio bot
- `src/ffmpeg.js` — encontra o FFmpeg pelo PATH ou por `FFMPEG_PATH`
- `src/index.js` — menção, comandos, liga texto + voz
- `src/llm.js` — conversa e transcrição
- `src/tts.js` — seleção entre Gemini Live e Edge
- `src/gemini-voice.mjs` — SDK Google GenAI, áudio PCM16 mono 24 kHz e contêiner WAV
- `src/config.js` — emoções e estado
- `config.json` — presets de emoção, modelo, voz
- `emotion-state.json` — criado sozinho, guarda emoção atual

## Ajustes

### Qualidade da voz gratuita

O `.env.example` usa `TTS_MODE=gemini`, com o modelo **gemini-2.5-flash-native-audio-preview-12-2025** e a voz **Aoede**. Preencha `GEMINI_API_KEY` de um projeto no **Free Tier**. A [tabela do Google](https://ai.google.dev/gemini-api/docs/pricing#gemini-2.5-flash-native-audio) oferece uma cota gratuita; em projetos com faturamento ativado, a API pode cobrar. O código não ativa faturamento nem troca de modelo quando a cota acaba.

O texto da resposta é enviado pela Live API usando `@google/genai`, com instrução de leitura em português brasileiro. Os pedaços de PCM16 mono 24 kHz passam direto para a conversão Opus do Discord, sem filtros de equalização ou recompressão intermediária. Um buffer inicial de 320 ms (`GEMINI_STREAM_BUFFER_MS`) absorve jitter de rede antes de tocar; aumente até 1000 se houver estalos, ou reduza até 160 se a conexão estiver estável e a prioridade for latência. Este modo mantém a transcrição pelo Groq; não é uma sessão contínua de conversa áudio a áudio. Como o modelo é generativo, a leitura pode variar. A velocidade no painel funciona como uma orientação de ritmo para o Gemini, não uma transformação exata da duração.

```powershell
npm.cmd run gemini-test
```

O teste faz uma geração e valida o WAV com FFmpeg, sem entrar no Discord. Abra `samples/gemini/teste-pt-br.wav` para ouvir. Reinicie o bot, entre na call pela opção **3** e use **5** para testar. A opção **13** lista as vozes do Gemini; a escolha fica salva separadamente da voz Edge. `TTS_FALLBACK=none` mostra erros de cota/conexão sem trocar a voz; `TTS_FALLBACK=edge` habilita explicitamente a alternativa Edge. Na call, Gemini continua em streaming com qualquer uma dessas opções. Edge entra se Gemini falhar antes de começar a tocar; uma frase parcialmente falada não é repetida. O primeiro bloco Gemini tem prazo de oito segundos, incluindo a conexão.

Para experimentar o Chatterbox específico para português brasileiro na GPU, veja [o teste local](local-tts/README.md). Ele gera amostras e mede o tempo de resposta, sem alterar a voz ativa do bot.

Com `TTS_MODE=edge`, a voz inicial é **Francisca**, em velocidade normal. O áudio original do Edge é preservado, sem equalizador, compressor ou uma segunda compressão MP3. A saída para o Discord usa Opus com quadros de 20ms. Isso evita degradação extra; não transforma a voz sintetizada em uma voz humana indistinguível.

O idioma das respostas acompanha a fala por padrão: **PT-BR, espanhol ou inglês**. Para fixar a resposta em português brasileiro, escolha **Inteligência → Idiomas → Português brasileiro**. A política do painel prevalece sobre `TTS_LANGUAGE`. A preparação de voz em português expande abreviações e usa pronúncias brasileiras para alguns termos: `Discord → Discórdi`, `YouTube → Iutúbi` e `call → chamada`. Isso só afeta o áudio; o texto no chat continua com a grafia original. Ajustes de palavras ou nomes podem ser adicionados em `config.json`, no objeto `ttsPronunciation`; reinicie depois de editar.

No modo Edge, use a opção **13** do painel para comparar **Francisca**, **Thalita** e **Antonio**. Para gerar a mesma frase nas três vozes Edge, sem entrar na call:

```powershell
npm run voice-samples
```

Os arquivos ficam em `samples/vozes`. Esse comando de comparação usa somente o [serviço do Edge](https://github.com/travisvn/edge-tts-universal), sem chave de API. Mesmo que exista `OPENAI_API_KEY`, ela não é utilizada para a voz. `TTS_PITCH` não é aplicado; a entonação original é preservada.

### Cérebro de conversa

O cérebro padrão no Groq é `openai/gpt-oss-120b`, configurado para conversar com raciocínio baixo e entregar a resposta em streaming. A personalidade escolhida continua no prompt, e a transcrição e a voz mantêm suas próprias configurações. O [modelo suporta esforço de raciocínio ajustável](https://developers.openai.com/api/docs/models/gpt-oss-120b); os parâmetros usados no Groq seguem a [documentação do provedor](https://console.groq.com/docs/reasoning).

```env
CHAT_MODEL=openai/gpt-oss-120b
CHAT_REASONING_EFFORT=low
MAX_TOKENS=1024
```

`MAX_TOKENS` inclui raciocínio e resposta; a fala continua curta, limitada a 300 caracteres. O raciocínio não é enviado para a voz. Reinicie o bot após alterar o `.env`. A disponibilidade, as cotas e a cobrança dependem da conta Groq. Se precisar reverter o cérebro, use `CHAT_MODEL=qwen/qwen3.8-27b`; os parâmetros exclusivos do GPT-OSS deixam de ser enviados automaticamente.

### Intervalos de requisições

O REST do bot oficial usa filas por rota; o modo legado mantém uma fila global com intervalo mínimo de um segundo. Quando `X-RateLimit-Remaining` chega a zero, a próxima chamada à rota aguarda o prazo de reset, mesmo após uma resposta bem-sucedida. Após HTTP 429, o cliente respeita o maior prazo entre `Retry-After` e `retry_after`, com uma margem adicional, sem reduzir a espera indicada pelo servidor. Veja os [limites oficiais](https://docs.discord.com/developers/topics/rate-limits).

HTTP 401, exigência de verificação da conta, restrição de envio ou conexão revogada encerram a conexão e cancelam requisições pendentes. Uma operação que retorna 403 não é repetida na mesma rota por um minuto; confira as permissões antes de tentar novamente. Erros fatais de configuração do gateway também param a reconexão. O painel continua disponível para exibir o motivo. Resolva avisos de conta no aplicativo oficial do Discord; reiniciar o programa não remove uma restrição da plataforma.

Mensagens espontâneas (**vida própria**) começam desligadas; podem ser ativadas explicitamente no painel ou com `ALIVE_ENABLED=1`. Falas proativas exigem `PROACTIVE_VOICE=1`. A presença não alterna atividades fictícias. Mensagens comuns não notificam usuários, cargos ou `@everyone`; a ação explícita de mencionar uma pessoa no painel mantém somente a menção escolhida. A confirmação automática de leitura foi removida. O heartbeat usa o intervalo informado pelo gateway, sem simular instabilidade de rede.

Isso distribui as novas tentativas no tempo; não é proteção contra banimento. Conta antiga e poucas requisições não tornam selfbots permitidos: o [Discord proíbe automatizar contas pessoais](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots). Use `BOT_TOKEN` de bot oficial.

No programa, a transcrição usa detecção automática para entender PT-BR, ES e EN. `STT_LANGUAGE` continua disponível para consumidores independentes do módulo de transcrição. A configuração `bargeInMinMs` controla o tempo mínimo para interrupção clássica e `speechMinRms` o limiar de áudio.

- `config.json` > `silenceMs`: tempo de silêncio pra cortar a fala (padrão 500ms). Aumente se frases com pausas estiverem sendo cortadas.
- `voicePendingMaxMs`: validade de uma fala aguardando resposta (padrão 8000ms).
- `maxVoiceSeconds`: tamanho máximo por fala
- `replyInTextToo`: false se quiser só voz, sem mandar texto junto
- `openaiModel`: `gpt-4o-mini` é barato e rápido
