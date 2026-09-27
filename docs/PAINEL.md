# Painel único da Neva7

Execute `npm.cmd start` e abra **http://127.0.0.1:3210/**. O endereço antigo `/live` abre exatamente a mesma interface. Os controles antigos e Live compartilham o servidor e os canais selecionados no topo.

| Área | O que faz |
| --- | --- |
| Pipeline | Visão geral da call, eventos e atalhos para as funções principais. |
| Conexão Discord | Escolhe a conta, salva o token, mostra o convite e ajusta a atividade do bot. Salvar uma conta exige reiniciar o programa. Token vazio reutiliza o já salvo desse tipo de conta. |
| Voz | Fala um texto, repete a última frase, fala e envia no chat, pausa a escuta, ajusta timbre, velocidade e volume. Também configura e testa a voz Live. |
| Música | Busca por nome ou link, adiciona à fila, pula faixa e para/limpa a fila. O Live pausa enquanto a música toca. |
| Mensagens | Envia texto ao canal, busca uma pessoa para mencionar, resume as últimas 30 mensagens e limpa o contexto de pesquisa. |
| Automação | Entra na call quando mencionada, responde também no chat e controla mensagens espontâneas nos canais escolhidos. |
| Gravações | Inicia/para a gravação no PC, mostra o destino dos arquivos e permite ouvir ou baixar o WAV completo e as faixas individuais. |
| Inteligência | Escolhe Live ou clássico, Gemini ou Cascade, idioma da resposta, regras de participação e recuperação. |
| Personalidade | Ajusta o perfil Live e mantém emoção, interação e personalidade personalizada do modo clássico e das mensagens. Os grupos são identificados na tela. |
| Participantes | Mostra as pessoas, limita quantos fluxos ficam ativos e escolhe um ID prioritário. |
| Conversação | Ajusta confirmação de voz, pausas e duração dos turnos. |
| Áudio | Ajusta buffers, redução de ruído da saída, equalização, compressor e limiter do Live. |
| Performance | Mostra latências medidas e uso do processo; configura os limites de proteção. |
| Laboratório | Simula pausa e participação com texto, sem Discord ou API. |
| Histórico | Exibe transcrições se autorizadas e controla retenção das sessões em memória. |
| Custos | Mostra tokens reportados e estimativas com preços inseridos por você. |
| Ferramentas | Autoriza consulta de hora e calculadora por usuário ou função. |
| Prompt Manager | Edita instruções e mostra o prompt efetivo do Live. |
| Memória | Limita contexto temporário e salva/apaga notas manuais de usuários autorizados. |
| Segurança | Define participantes permitidos/bloqueados, limites de respostas e privacidade. |
| Developer Mode | Exibe eventos técnicos e importa/exporta a timeline. O replay não contém áudio. |

Cada campo mostra sua função e os efeitos da mudança. **Aplicar configurações** salva os ajustes Live e de idioma; os botões de ação e seletores clássicos aplicam suas mudanças diretamente.

## Avisos e controles

- **Live precisa de bot oficial:** selecione Bot oficial em Conexão Discord e reinicie, ou clique **Usar modo clássico** para manter o caminho existente da conta pessoal. O painel não troca a conta sozinho.
- **Parar tudo na call:** cancela fala, resposta pendente, música e fila da call selecionada.
- **Safe Mode:** pausa respostas; pode ser acionado manualmente ou por uma falha/limite. Confira a timeline.
- **Kill Switch:** encerra calls e bloqueia novas chamadas e respostas.
- **Rearmar conversa:** desativa os bloqueios de proteção e volta ao provider principal. Depois você escolhe entrar na call. Se a causa da falha persistir, a proteção pode voltar.

## Enviar mensagens e encontrar pessoas

Em **Mensagens**, escolha o servidor e o canal de texto no topo. **Verificar permissões** consulta a conta conectada, os cargos, as permissões específicas do canal, timeout e aceite das regras. Essa consulta não envia uma mensagem. Em caso de recusa, o painel mantém o código HTTP e o código de erro do Discord, com a orientação correspondente. Confira as permissões da conta exibida no diagnóstico; as permissões da sua outra conta podem ser diferentes.

A busca aceita **apelido, nome de exibição, @usuário, ID numérico e menção colada** (`<@ID>`). Nome e usuário são mostrados junto do ID para distinguir homônimos. Ela compara todos os nomes sem diferenciar maiúsculas e acentos nos membros já carregados. Para copiar um ID: Discord → Configurações → Avançado → Modo desenvolvedor; depois clique com o botão direito na pessoa → Copiar ID do usuário.

Com bot oficial, cada busca carrega uma página de até 1.000 membros, incluindo offline. **Carregar mais membros** continua a lista de servidores maiores. Se houver mais de 1.000 correspondências, refine o nome ou cole o ID. Para listar todos, o bot precisa de **Server Members Intent**, em Developer Portal → Bot; a API exige essa opção conforme a [documentação do Discord](https://docs.discord.com/developers/resources/guild#list-guild-members). Na conta pessoal, a busca disponível pode ser parcial; o painel avisa e permite consultar diretamente pelo ID. Uma falha de acesso é mostrada, em vez de parecer que a pessoa não existe.

O sistema confirma que a pessoa está no servidor antes de enviar a menção. Trocar de servidor limpa a seleção; texto com `@everyone` ou outras menções não notifica pessoas adicionais. O Discord continua decidindo se a mensagem pode ser enviada: os códigos [50001 e 50013](https://docs.discord.com/developers/topics/opcodes-and-status-codes#json) indicam falta de acesso e permissão; verificações da conta e AutoMod têm causas distintas. O painel não altera cargos ou permissões do servidor.

## PT-BR, espanhol e inglês

Em **Inteligência → Idiomas**, o padrão **Automático** entende os três e acompanha o idioma de quem fala. Exemplos: “Neve, como você está?”, “Neve, ¿cómo estás?” e “Neve, how are you?”. Também é possível fixar a resposta em PT-BR, espanhol ou inglês sem limitar os idiomas de entrada.

Essa escolha vale para Gemini Live, Cascade e a conversa clássica. O painel tem precedência sobre antigos `STT_LANGUAGE=pt` / `TTS_LANGUAGE=pt-BR`. Português usa variante brasileira. No Cascade/Edge, espanhol usa a voz Elvira e inglês usa Aria; português mantém a voz escolhida. A fala manual e transcrições sem metadados usam uma heurística de texto, que pode ser ambígua em frases curtas. A detecção do áudio é feita pelo provider.

O Gemini nativo escolhe o idioma a partir do áudio e das instruções, sem `languageCode` forçado, conforme a [documentação da Live API](https://ai.google.dev/gemini-api/docs/live-api/capabilities).

## Gravar a call no computador

1. Entre na call usando os seletores no topo do painel.
2. Abra **Gravações** e clique em **Iniciar gravação**. Um aviso vermelho aparece em todas as áreas enquanto algum servidor está sendo gravado.
3. Clique em **Parar e salvar**. Espere a finalização; depois use o player ou **Baixar WAV**.

Os arquivos são salvos em `E:\bot\recordings\<data-hora_identificador>\` neste projeto (a pasta fica sempre ao lado de `src`). **call.wav** contém a mixagem; **track-*.wav** guarda uma faixa por participante e uma para a saída da Neva7; **manifest.json** associa nomes, IDs e horários às faixas. A saída inclui voz e música do bot. As pausas e falas simultâneas são preservadas usando o tempo de recepção local. O bot só pode gravar o áudio que recebe; microfones mutados, pacotes perdidos ou períodos de desconexão não são recuperados.

A gravação é manual e funciona nos caminhos Live e clássico. Não usa API de IA para gravar ou mixar. A conversa com a IA, se ligada, continua enviando áudio ao provider. Pausar a escuta da IA mantém a gravação local; **Sair**, **Parar tudo**, **Safe Mode manual** e **Kill Switch** finalizam a gravação. O programa também aguarda a finalização ao encerrar normalmente. Mudar a call encerra a gravação anterior; inicie outra no novo destino.

Formato: WAV mono PCM16 a 16 kHz. Limites por sessão: 2 horas, 32 faixas e 2 GB nas faixas individuais; a mixagem precisa de espaço adicional. O gravador para se o disco falhar ou a fila de escrita exceder 8 MB. Se o FFmpeg falhar na mixagem, as faixas individuais permanecem disponíveis. Um encerramento abrupto pode perder os últimos frames; os WAVs já escritos mantêm cabeçalhos reproduzíveis e aparecem como interrompidos após reiniciar.

Os arquivos não são apagados automaticamente, inclusive ao limpar contexto ou sair da call. Para removê-los, use o Explorador de Arquivos. A gravação começa desligada a cada entrada e reinício. O histórico textual e as notas de memória são funções separadas.
