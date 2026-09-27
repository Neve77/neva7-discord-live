const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const python = path.join(root, 'tools', 'chatterbox', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!fs.existsSync(python)) {
  console.error('Execute npm run setup:chatterbox primeiro.');
  process.exitCode = 1;
} else {
  const child = spawn(python, ['-u', path.join(root, 'local-tts', 'test_chatterbox.py'), ...process.argv.slice(2)], {
    cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' }
  });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  process.on('SIGINT', () => { child.kill(); });
}
