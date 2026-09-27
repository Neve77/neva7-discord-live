require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { speak } = require('../src/tts');
const { state } = require('../src/config');

const dir = path.join(__dirname, '..', 'samples', 'chatterbox');
const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

async function main() {
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'resultados.json'), 'utf8'));
  const currentVoice = state.ttsVoice || 'thalita';
  const started = performance.now();
  const current = await speak(report.text, 'pt-BR', { voice: currentVoice, speed: 1, provider: 'edge' });
  try { fs.copyFileSync(current, path.join(dir, '00-edge-atual.mp3')); }
  finally { fs.unlinkSync(current); }
  report.edge_generation_seconds = Math.round(performance.now() - started) / 1000;
  report.edge_voice = currentVoice;
  fs.writeFileSync(path.join(dir, 'resultados.json'), JSON.stringify(report, null, 2));
  const titles = { '01-primeira.wav': 'Primeira geração', '02-natural.wav': 'Chatterbox · natural', '03-conversa.wav': 'Chatterbox · conversa' };
  const cards = report.samples.filter(sample => sample.file !== '01-primeira.wav').map(sample => `
    <article><span class="tag">NOVA VOZ · PT-BR</span><h2>${escapeHtml(titles[sample.file] || sample.file)}</h2>
      <audio controls preload="none" src="${encodeURIComponent(sample.file)}"></audio>
      <p>${sample.generation_seconds.toFixed(2)}s para gerar · ${sample.audio_seconds.toFixed(2)}s de áudio</p>
    </article>`).join('');
  const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Comparar as vozes do bot</title><style>
*{box-sizing:border-box}body{margin:0;background:#10141e;color:#eef2ff;font:16px/1.6 system-ui,sans-serif}
main{max-width:940px;margin:60px auto;padding:0 24px}h1{font-size:36px;line-height:1.15;margin:12px 0}h2{font-size:21px}
.tag{font-size:12px;letter-spacing:1.2px;color:#9acbff}p{color:#b7c1d5}.quote{border-left:3px solid #72b5ff;padding:10px 20px;margin:28px 0;background:#171e2c}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}article{padding:24px;background:#1b2232;border:1px solid #303c52;border-radius:16px}
audio{width:100%;margin:8px 0}article p{font-size:13px}footer{margin:30px 0;color:#aab7cb;font-size:14px}
</style><main><span class="tag">TESTE DE VOZ DO BOT</span><h1>Qual soa mais natural?</h1>
<p>Ouça a mesma frase nas três versões. Compare sotaque, pausas, entonação e palavras cortadas.</p>
<div class="quote">${escapeHtml(report.text)}</div><div class="grid">
<article><span class="tag">VOZ ATUAL · EDGE</span><h2>${escapeHtml(currentVoice)}</h2><audio controls preload="none" src="00-edge-atual.mp3"></audio><p>${report.edge_generation_seconds.toFixed(2)}s para gerar nesta execução</p></article>${cards}</div>
<footer>Chatterbox executado localmente na ${escapeHtml(report.gpu)}, com a referência feminina do demonstrador oficial brasileiro.
Os tempos medem a criação do arquivo inteiro; a call, a transcrição e a IA de conversa não fazem parte desta medição. A voz ativa do bot não foi alterada.</footer></main></html>`;
  fs.writeFileSync(path.join(dir, 'comparar.html'), html);
  console.log('Comparação pronta: ' + path.join(dir, 'comparar.html'));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
