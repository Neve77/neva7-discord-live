// Baixa somente o executável oficial e confere o SHA-256 antes de instalar.
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

async function main() {
  const assets = { 'win32-x64': 'yt-dlp.exe', 'win32-arm64': 'yt-dlp_arm64.exe',
    'linux-x64': 'yt-dlp_linux', 'linux-arm64': 'yt-dlp_linux_aarch64',
    'darwin-x64': 'yt-dlp_macos', 'darwin-arm64': 'yt-dlp_macos' };
  const asset = assets[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error('Instale yt-dlp manualmente e configure YTDLP_PATH no .env.');
  async function get(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Download oficial falhou: HTTP ${response.status}`);
    return response;
  }
  const release = await (await get('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest')).json();
  if (!/^[\w.-]+$/.test(release.tag_name)) throw new Error('Versão inválida.');
  const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${release.tag_name}`;
  console.log(`Instalando yt-dlp ${release.tag_name} em tools/...`);
  const sums = await (await get(`${base}/SHA2-256SUMS`)).text();
  const line = sums.split(/\r?\n/).find(line => line.trim().split(/\s+/).at(-1).replace(/^\*/, '') === asset);
  const expected = line?.split(/\s+/)[0];
  if (!/^[a-f\d]{64}$/i.test(expected || '')) throw new Error('Checksum oficial não encontrado.');
  const bytes = Buffer.from(await (await get(`${base}/${asset}`)).arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected.toLowerCase()) throw new Error('Checksum não confere. Nada foi instalado.');
  const dir = path.join(__dirname, '..', 'tools');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  fs.writeFileSync(dest + '.download', bytes, { mode: 0o755 });
  fs.renameSync(dest + '.download', dest);
  console.log('YouTube instalado e SHA-256 verificado.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
