require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { speak } = require('../src/tts');

const outputDir = path.join(__dirname, '..', 'samples', 'vozes');
const text = process.argv.slice(2).join(' ').trim() || 'E aí, beleza? Você tá me ouvindo direitinho? Tô aqui no Discord. Bora entrar na call e jogar mais uma partida?';
(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const voice of ['francisca', 'thalita', 'antonio']) {
    const file = await speak(text, 'pt', { voice, speed: 1, provider: 'edge' });
    const destination = path.join(outputDir, voice + '.mp3');
    try { fs.copyFileSync(file, destination); }
    finally { fs.unlinkSync(file); }
    console.log(`${voice}: ${destination}`);
  }
  console.log('Abra os MP3 para comparar. Escolha a voz pela opção 13 do painel.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
