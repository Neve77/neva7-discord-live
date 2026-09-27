const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepareAssets } = require('./chatterbox-assets');

const root = path.join(__dirname, '..');
const envDir = path.join(root, 'tools', 'chatterbox', '.venv');
const python = path.join(envDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const env = { ...process.env, UV_CACHE_DIR: path.join(root, 'tools', 'uv-cache') };

function uv(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('uv', args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.on('error', error => reject(new Error(`Não consegui executar uv: ${error.message}`)));
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`uv encerrou com código ${code}`)));
  });
}

(async () => {
  if (!fs.existsSync(python)) await uv(['venv', '--python', process.env.CHATTERBOX_PYTHON || '3.12', envDir]);
  await uv(['pip', 'install', '--python', python, '--index-url', 'https://download.pytorch.org/whl/cu128', 'torch==2.8.0', 'torchaudio==2.8.0']);
  await uv(['pip', 'install', '--python', python, '-r', path.join(root, 'local-tts', 'requirements-chatterbox.txt')]);
  await prepareAssets();
  console.log('Pronto. Execute npm run chatterbox-test para gerar e medir as amostras.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
