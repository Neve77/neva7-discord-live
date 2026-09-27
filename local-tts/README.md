# Teste local do Chatterbox em português brasileiro

O teste usa a versão específica `ResembleAI/Chatterbox-Multilingual-pt-br`, com o código e a referência de voz do [demonstrador oficial](https://huggingface.co/spaces/ResembleAI/Chatterbox-Multilingual-TTS-pt-br). A revisão do código é fixa; revisões e hashes dos modelos ficam em `tools/chatterbox/assets-manifest.json`.

Requer `uv`, Python 3.12 e uma GPU NVIDIA com driver compatível com CUDA 12.8. A instalação e os downloads ficam dentro de `tools/`, separados do bot e do Python global. O primeiro download ocupa vários GB.

```powershell
npm run setup:chatterbox
npm run chatterbox-test
node scripts/chatterbox-report.js
```

As amostras ficam em `samples/chatterbox`:

- `01-primeira.wav`: primeira geração, incluindo custos de inicialização da inferência.
- `02-natural.wav`: mesmos parâmetros após aquecimento.
- `03-conversa.wav`: menor intensidade e ajuste de ritmo para comparação.
- `resultados.json`: tempo de carregamento, preparação da referência, geração, duração e pico de memória CUDA.
- `comparar.html`: comparação com a voz atual, criada pelo comando de relatório acima; usa Edge gratuito para gerar o áudio atual com a mesma frase.

As três amostras usam o mesmo texto e a mesma semente. `rtf` é o tempo de geração dividido pela duração do áudio. Valores menores que 1 significam geração mais rápida que a duração do áudio; o bot ainda precisa aguardar o arquivo inteiro neste teste.

Para outra frase ou uma referência própria/autorizada:

```powershell
npm run chatterbox-test -- --text "Oi, tudo bem? Bora conversar?"
npm run chatterbox-test -- --reference "E:/caminho/voz.wav"
```

O teste não inicia o Discord nem altera a voz ativa do bot. A integração na call depende da avaliação das amostras e do atraso medido.
