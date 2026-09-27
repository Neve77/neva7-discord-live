const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const ROOT = path.join(__dirname, '..', 'tools', 'chatterbox');
const SPACE = 'ResembleAI/Chatterbox-Multilingual-TTS-pt-br';
const SOURCE_REVISION = '9e515821e826e207cd617a0fdd0223899ed108ea';

async function json(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, file, expectedHash) {
  if (fs.existsSync(file) && expectedHash && await hashFile(file) === expectedHash) return expectedHash;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partial = file + '.download';
  let offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  if (offset && expectedHash && await hashFile(partial) === expectedHash) {
    fs.renameSync(partial, file);
    return expectedHash;
  }
  const res = await fetch(url, {
    signal: AbortSignal.timeout(45 * 60 * 1000),
    headers: offset ? { Range: `bytes=${offset}-` } : {}
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  if (res.status === 200) offset = 0; // O servidor pode não aceitar retomada.
  else if (res.status !== 206 || !res.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) throw new Error('Resposta de retomada inválida.');
  const hash = createHash('sha256');
  if (offset) {
    for await (const chunk of fs.createReadStream(partial)) hash.update(chunk);
    console.log(`Retomando ${path.basename(file)} em ${Math.round(offset / 1024 / 1024)} MB`);
  }
  const meter = new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } });
  await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(partial, { flags: offset ? 'a' : 'w' }));
  const actual = hash.digest('hex');
  if (expectedHash && actual !== expectedHash) throw new Error(`SHA-256 inválido: ${path.basename(file)}`);
  fs.renameSync(partial, file);
  return actual;
}

async function prepareAssets() {
  fs.mkdirSync(ROOT, { recursive: true });
  const manifestPath = path.join(ROOT, 'assets-manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { source: { repo: SPACE, revision: SOURCE_REVISION }, models: {}, files: {} };
  const source = await json(`https://huggingface.co/api/spaces/${SPACE}/revision/${SOURCE_REVISION}`);
  const sourceFiles = source.siblings.map(item => item.rfilename).filter(name => name.startsWith('chatterbox/') && name.endsWith('.py'));
  for (let i = 0; i < sourceFiles.length; i += 6) {
    await Promise.all(sourceFiles.slice(i, i + 6).map(async name => {
      const dest = path.join(ROOT, 'source', name);
      const sha256 = await download(`https://huggingface.co/spaces/${SPACE}/resolve/${SOURCE_REVISION}/${name}`, dest, manifest.files[name]);
      manifest.files[name] = sha256;
    }));
  }
  for (const [repo, filenames] of [
    ['ResembleAI/Chatterbox-Multilingual-pt-br', ['t3_pt_br.safetensors', 's3gen_v3.pt', 'grapheme_mtl_merged_expanded_v1.json']],
    ['ResembleAI/chatterbox', ['ve.pt']]
  ]) {
    const revision = manifest.models[repo] || 'main';
    const info = await json(`https://huggingface.co/api/models/${repo}/revision/${revision}?blobs=true`);
    manifest.models[repo] = info.sha;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    for (const name of filenames) {
      const asset = info.siblings.find(item => item.rfilename === name);
      if (!asset) throw new Error(`Modelo oficial sem ${name}`);
      const key = `${repo}/${name}`;
      console.log(`Modelo: ${name} (${Math.round((asset.size || 0) / 1024 / 1024)} MB)`);
      const expected = asset.lfs?.sha256 || asset.lfs?.oid || manifest.files[key];
      manifest.files[key] = await download(`https://huggingface.co/${repo}/resolve/${info.sha}/${name}`, path.join(ROOT, 'models', name), expected);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      console.log(`OK: ${name}`);
    }
  }
  const reference = 'https://storage.googleapis.com/chatterbox-demo-samples/mtl-v3-single-language-prompts/pt-br/pt_br_f2.wav';
  manifest.reference = { url: reference, sha256: await download(reference, path.join(ROOT, 'reference-pt-br.wav'), manifest.reference?.sha256) };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('Modelo pt-BR e referência oficial prontos.');
}

module.exports = { prepareAssets };
if (require.main === module) prepareAssets().catch(error => { console.error(error.message); process.exitCode = 1; });
