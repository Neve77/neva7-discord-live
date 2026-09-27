const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const GUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const OWNED_FILE = new RegExp(`^(\\d+)-(${GUID})-(tts|heard|ogg|music)-${GUID}\\.(mp3|wav|ogg|m4a|opus|flac|aac|webm)$`);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

class AudioCache {
  constructor({ root = path.join(__dirname, '..', '.cache', 'audio'), pid = process.pid, isAlive = alive, boot = randomUUID() } = {}) {
    this.root = path.resolve(root); this.pid = pid; this.boot = boot; this.isAlive = isAlive;
    this.leases = new Map(); this.lastClean = null;
  }

  checkRoot(create = false) {
    // Never walk through junctions/symlinks, including an ancestor of the cache directory.
    let current = path.parse(this.root).root;
    for (const segment of this.root.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!stat) {
        if (!create) return false;
        fs.mkdirSync(current); stat = fs.lstatSync(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('A pasta de cache precisa ser uma pasta local, sem links ou redirecionamentos.');
    }
    return true;
  }

  allocate(kind, extension) {
    if (!['tts', 'heard', 'ogg', 'music'].includes(kind) || !/^(mp3|wav|ogg|m4a|opus|flac|aac|webm)$/.test(extension)) throw new Error('Tipo de temporário inválido.');
    this.checkRoot(true);
    // Callers also remove files directly. Prune old, already removed reservations.
    for (const [file, created] of this.leases) if (Date.now() - created > 600000 && !fs.existsSync(file)) this.leases.delete(file);
    const file = path.join(this.root, `${this.pid}-${this.boot}-${kind}-${randomUUID()}.${extension}`);
    this.leases.set(file, Date.now()); return file;
  }

  release(file) { this.leases.delete(path.resolve(file)); }

  entries() {
    if (!this.checkRoot()) return [];
    const pids = new Map(), entries = [];
    for (const name of fs.readdirSync(this.root)) {
      const match = OWNED_FILE.exec(name); if (!match) continue;
      const file = path.resolve(this.root, name);
      if (path.dirname(file) !== this.root) continue;
      let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) continue;
      const pid = Number(match[1]);
      if (!pids.has(pid)) pids.set(pid, this.isAlive(pid));
      const inUse = pid === this.pid && match[2] === this.boot ? this.leases.has(file) : pids.get(pid);
      entries.push({ file, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev, inUse });
    }
    return entries;
  }

  inspect() {
    const entries = this.entries(), free = entries.filter(e => !e.inUse);
    return { root: this.root, files: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0),
      removableFiles: free.length, removableBytes: free.reduce((n, e) => n + e.size, 0),
      protectedFiles: entries.length - free.length, lastClean: this.lastClean };
  }

  clear() {
    const result = { removedFiles: 0, freedBytes: 0, protectedFiles: 0, failedFiles: 0, at: new Date().toISOString() };
    for (const entry of this.entries()) {
      if (entry.inUse) { result.protectedFiles++; continue; }
      try {
        if (!this.checkRoot()) continue;
        const stat = fs.lstatSync(entry.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.ino !== entry.ino || stat.dev !== entry.dev || stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs || this.leases.has(entry.file)) {
          result.protectedFiles++; continue;
        }
        // No recursion and no caller-supplied path: only recognized regular files directly in the cache.
        fs.unlinkSync(entry.file); this.release(entry.file); result.removedFiles++; result.freedBytes += stat.size;
      } catch (error) { if (error.code !== 'ENOENT') result.failedFiles++; }
    }
    this.lastClean = result; return result;
  }
}

const audioCache = new AudioCache();
module.exports = { AudioCache, audioCache, allocateTemp: (kind, ext) => audioCache.allocate(kind, ext) };
