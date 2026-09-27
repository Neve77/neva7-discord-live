# Pendências verificadas — 23/09/2026

A versão atual tem boa parte dos módulos e do painel, mas o transporte de voz não implementa mais contratos que os outros arquivos esperam. A prioridade é restaurar essa integração antes de ampliar os efeitos sonoros. Esta análise não altera a conta Discord nem reinicia o programa.

## 1. Bloqueios principais

| Prioridade | Constatação | Consequência e trabalho necessário |
| --- | --- | --- |
| Crítica | `src/voice.js` não fornece `setLiveFactory`, `playPcmStream`, `startRecording`, `recordPlayback` e o coordenador de turnos usado pelos testes. | Live, streaming Gemini, gravação da call e interrupções estão incompatíveis com `index.js`, `panel-controller.js` e os testes. Restaurar o contrato do transporte preservando as alterações atuais do projeto. |
| Crítica | `index.js:355` só cria `LiveService` quando `setLiveFactory` existe. O painel depende de `/api/live` para concluir o primeiro carregamento (`dashboard.js:127`). | Numa nova inicialização, o serviço fica nulo, `/api/live` retorna erro e a interface não conclui o carregamento. Os bloqueios globais instalados pelo serviço também ficam ausentes. O painel precisa permanecer utilizável mesmo quando Live estiver indisponível. |
| Alta | `call-recordings.js` está presente e funciona isoladamente, mas `ZeroVoiceManager` não instancia nem alimenta o gravador. | O botão Iniciar gravação chama um método inexistente. Conectar entrada PCM, saída efetivamente reproduzida, parada e encerramento ao gravador. |
| Alta | A reprodução de música em `voice.js:280` usa `require('play-dl')`, dependência ausente. Também diverge do cancelamento e acompanhamento de estado esperados pelos testes. | Reprodução do YouTube e controles de fila precisam voltar a usar o transporte disponível no projeto (`youtube.js`) e um ciclo de reprodução cancelável. Apenas instalar a dependência antiga não resolve o restante. |

## 2. Efeitos sonoros: o que existe e o que falta

Já existem `src/sound-effects.js`, lista em Voz, prévia local, importação por arquivo/link e ação para tocar na call. A função ainda está incompleta:

1. **Upload bloqueado pelo limite da API.** `/api/action` usa `readBody` com 16 KB, incluindo o JSON e o áudio em base64. Uma importação simulada com 16.000 bytes retornou HTTP 400, `Solicitação muito grande.`, antes de chegar ao importador. Criar um limite específico coerente com os 16 MB anunciados pelo módulo e validar também os uploads locais.
2. **Link de página do Myinstants não é convertido em áudio.** O importador baixa os bytes da URL e salva com extensão de áudio, sem extrair o MP3 nem conferir o conteúdo. Uma categoria ou página HTML não é um arquivo MP3. Implementar importação de som individual e tratamento de bloqueios do site; manter upload local como alternativa. O site disponibiliza [Baixar MP3 na página de um som](https://www.myinstants.com/pt/instant/bruh/). Na consulta automática realizada, a categoria retornou HTTP 403.
3. **A prévia local é recriada a cada atualização.** `dashboard-classic.js:120` substitui toda a lista e seus elementos `<audio>`; o polling roda a cada 1,5 segundo. Atualizar só quando a biblioteca mudar para preservar a reprodução.
4. **Sucesso indevido quando a voz está ocupada.** `playFiles` retorna `undefined` se já há fala; `playSoundEffect` considera qualquer retorno diferente de `false` um sucesso. Padronizar o resultado e mostrar quando o efeito começou, terminou, falhou ou foi cancelado.
5. **Proteções incompletas.** `soundPlay` não integra a lista de ações protegidas na interface, seus botões usam um seletor diferente, e o controlador não verifica Safe Mode/Kill Switch antes de tocar. Fazer a validação também no backend e cancelar o efeito nos controles de parada.
6. **Arquivos e downloads precisam de validação.** Conferir áudio real, tamanho, duração, URLs e redirecionamentos antes de salvar. A rota de prévia precisa tratar Range inválido e erros de leitura sem deixar uma requisição quebrada.

Melhorias de uso posteriores: renomear/remover, favoritos, filtro de busca, volume próprio dos efeitos e catálogo do Myinstants dentro do painel. São incrementos; não substituem os bloqueios acima.

## 3. Verificação executada

| Verificação | Resultado |
| --- | --- |
| Testes fora de `voice.test.js` e `music.test.js` | 172 passaram. Inclui jitter, REST, busca de membros, idiomas e testes isolados do Live. |
| `voice.test.js`, executado isoladamente | 15 testes: 4 passaram, 11 falharam. Há erros de métodos ausentes e falhas de cancelamento, captura e gravação. |
| `music.test.js`, executado isoladamente | 3 falhas observadas; não concluiu e foi encerrado após 5 segundos. Não há contagem final válida dessa suíte. |
| `npm.cmd test` completo | Não concluiu; não é correto afirmar que a versão atual está com todos os testes passando. |
| `scripts/check-live-audio.js` | Falhou: `streamToOpusOgg is not a function`. |
| `scripts/check-recording-audio.js` | Passou: mixagem real com FFmpeg de dois sinais sintéticos, sobreposição e silêncio preservados. Não valida a integração com Discord. |
| Upload por HTTP, com controlador simulado | Arquivo de 16.000 bytes bloqueado pelo limite de corpo; nenhuma importação ou mensagem real executada. |
| Painel em `127.0.0.1:3210` durante esta análise | Indisponível. Não houve reinício ou teste em call real. |

Saídas detalhadas: `.recon/analysis-tests.txt`, `.recon/analysis-voice-tests.txt` e `.recon/analysis-music-tests.txt`.

## 4. Ordem recomendada

1. Reconciliar `voice.js` com os contratos de Live, gravação, streaming, cancelamento e fila; obter testes de voz e música passando.
2. Garantir carregamento do painel e controles de segurança mesmo quando o provider Live estiver indisponível.
3. Concluir a importação e reprodução dos efeitos, com upload funcional, MP3 extraído do Myinstants e prévia estável.
4. Validar em uma call real: gravação, efeito ouvido pelos participantes, interrupção, reconexão e PT-BR/ES/EN. Os testes locais não comprovam rede, permissões ou qualidade percebida da voz.

Continuam como limites ou extensões documentados em `LIVE.md`: medição real de perda de pacotes, cancelamento acústico de eco, redução neural de ruído na entrada, resumo semântico do contexto e ferramentas além de relógio/calculadora. O Cascade atual também aguarda a transcrição completa; não oferece STT incremental.
