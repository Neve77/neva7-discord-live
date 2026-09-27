const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

function loadModule(relative, mocks = {}, globals = {}) {
  const filename = path.join(__dirname, '..', relative);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const sandbox = {
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : realRequire(name),
    module, exports: module.exports, __dirname: path.dirname(filename), __filename: filename,
    Buffer, process, AbortController, AbortSignal, console: { log() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    ...globals
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return module.exports;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

module.exports = { loadModule, deferred };
