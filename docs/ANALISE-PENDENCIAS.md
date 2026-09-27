# Pendências verificadas — atualizado em 27/09/2026

A integração do transporte de voz foi restaurada. Voz Live, captura simultânea, interrupção, gravação e música compartilham agora ciclos explícitos de reprodução e cancelamento. A prioridade seguinte é validar a experiência em uma call real e concluir os efeitos sonoros.

## 1. Núcleo concluído

| Área | Situação atual | Verificação |
| --- | --- | --- |
| Voz Live | PCM é encaminhado durante a fala, com decoder e captura independentes por participante. | Testes de voz e encoder PCM → Ogg/Opus passando. |
| Interrupção | Ruído isolado não interrompe; 300 ms de voz contínua cancelam resposta, síntese e reprodução conforme a prioridade. | Casos simultâneos, fila e prioridade do dono passando. |
| Gravação | Entrada de participantes e saída do bot usam a mesma sessão; sair da call finaliza a gravação. | Testes de faixas, limites, recuperação e mixagem passando. |
| Música | Player usa `yt-dlp`, FFmpeg e cancelamento próprio; não depende mais de `play-dl`. | Fila, parada durante preparação, pulo, loop e erros passando. |

## 2. Efeitos sonoros: o que existe e o que falta

Já existem `src/sound-effects.js`, lista em Voz, prévia local, importação por arquivo/link e ação para tocar na call. A função ainda está incompleta:

1. **Upload bloqueado pelo limite da API.** `/api/action` usa `readBody` com 16 KB, incluindo o JSON e o áudio em base64. Uma importação simulada com 16.000 bytes retornou HTTP 400, `Solicitação muito grande.`, antes de chegar ao importador. Criar um limite específico coerente com os 16 MB anunciados pelo módulo e validar também os uploads locais.
2. **Link de página do Myinstants não é convertido em áudio.** O importador baixa os bytes da URL e salva com extensão de áudio, sem extrair o MP3 nem conferir o conteúdo. Uma categoria ou página HTML não é um arquivo MP3. Implementar importação de som individual e tratamento de bloqueios do site; manter upload local como alternativa. O site disponibiliza [Baixar MP3 na página de um som](https://www.myinstants.com/pt/instant/bruh/). Na consulta automática realizada, a categoria retornou HTTP 403.
3. **A prévia local é recriada a cada atualização.** `dashboard-classic.js:120` substitui toda a lista e seus elementos `<audio>`; o polling roda a cada 1,5 segundo. Atualizar só quando a biblioteca mudar para preservar a reprodução.
4. **Sucesso indevido quando a voz está ocupada.** `playFiles` retorna `undefined` se já há fala; `playSoundEffect` considera qualquer retorno diferente de `false` um sucesso. Padronizar o resultado e mostrar quando o efeito começou, terminou, falhou ou foi cancelado.
5. **Proteções incompletas.** `soundPlay` não integra a lista de ações protegidas na interface, seus botões usam um seletor diferente, e o controlador não verifica Safe Mode/Kill Switch antes de tocar. Fazer a validação também no backend e cancelar o efeito nos controles de parada.
6. **Arquivos e downloads precisam de validação.** Conferir áudio real, tamanho, duração, URLs e redirecionamentos antes de salvar. A rota de prévia precisa tratar Range inválido e erros de leitura sem deixar uma requisição quebrada.

Melhorias de uso posteriores: renomear/remover, favoritos, filtro de busca, volume próprio dos efeitos e catálogo do Myinstants dentro do painel. São incrementos; não substituem os bloqueios acima.

## 3. Verificação executada após a correção

| Verificação | Resultado |
| --- | --- |
| Suíte completa | 216 testes passaram; nenhum falhou, foi cancelado ou ficou pendente. |
| `voice.test.js` | 18 testes passaram, incluindo captura simultânea, Live, fila, interrupção e gravação. |
| `music.test.js` | 6 testes passaram e o processo encerrou normalmente. |
| `scripts/check-live-audio.js` | Passou: PCM mono 24 kHz convertido em streaming para Ogg/Opus. |
| `scripts/check-recording-audio.js` | Passou: mixagem real com FFmpeg de dois sinais sintéticos, sobreposição e silêncio preservados. Não valida a integração com Discord. |
| Upload por HTTP, com controlador simulado | Arquivo de 16.000 bytes bloqueado pelo limite de corpo; nenhuma importação ou mensagem real executada. |
| Painel em `127.0.0.1:3210` durante esta análise | Indisponível. Não houve reinício ou teste em call real. |

Saídas detalhadas: `.recon/analysis-tests.txt`, `.recon/analysis-voice-tests.txt` e `.recon/analysis-music-tests.txt`.

## 4. Ordem recomendada

1. Validar em uma call real: gravação, música, interrupção, reconexão e PT-BR/ES/EN. Os testes locais não comprovam rede, permissões ou qualidade percebida da voz.
2. Concluir a importação e reprodução dos efeitos, com upload funcional, MP3 extraído do Myinstants e prévia estável.
3. Adicionar um assistente de primeira configuração e diagnóstico guiado no painel.
4. Medir latência percebida, gaps de captura e tempo até o primeiro áudio em sessões reais.

Continuam como limites ou extensões documentados em `LIVE.md`: medição real de perda de pacotes, cancelamento acústico de eco, redução neural de ruído na entrada, resumo semântico do contexto e ferramentas além de relógio/calculadora. O Cascade atual também aguarda a transcrição completa; não oferece STT incremental.
