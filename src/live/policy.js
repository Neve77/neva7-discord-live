function allowed(userId, roles, options, rolesKnown = true) {
  if (!rolesKnown && (options.allowRoles.length || options.denyRoles.length)) return false;
  if (options.killed || options.safeMode || options.denyUsers.includes(userId) || roles.some(r => options.denyRoles.includes(r))) return false;
  return (!options.allowUsers.length && !options.allowRoles.length) || options.allowUsers.includes(userId) || roles.some(r => options.allowRoles.includes(r));
}
function normalize(text) { return String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(); }
function addressed(text, words) {
  const tokens = normalize(text).split(/[^\p{L}\p{N}]+/u);
  return words.some(w => (' ' + tokens.join(' ') + ' ').includes(' ' + normalize(w).trim() + ' '));
}
function participate(text, options, engaged) {
  if (options.mode === 'observer') return false;
  if (addressed(text, options.wakeWords)) return true;
  if (options.onlyWhenCalled) return false;
  return options.mode === 'participative' || engaged;
}
function calculator(expression) {
  // Small arithmetic grammar. Never eval/Function and never access global objects.
  const input = String(expression).replace(/\s/g, '');
  if (!input || input.length > 120 || /[^\d.+*/()%-]/.test(input)) throw new Error('Expressão inválida.');
  const tokens = input.match(/\d+(?:\.\d+)?|\.\d+|[()+*/%\-]/g) || [];
  if (tokens.join('') !== input) throw new Error('Expressão inválida.');
  let pos = 0;
  function atom() {
    const t = tokens[pos++];
    if (t === '-') return -atom();
    if (t === '+') return atom();
    if (t === '(') { const v = sum(); if (tokens[pos++] !== ')') throw new Error('Parênteses inválidos.'); return v; }
    if (!t || !/^\d|^\./.test(t)) throw new Error('Número inválido.');
    return Number(t);
  }
  function product() { let v = atom(); while (['*','/','%'].includes(tokens[pos])) { const op = tokens[pos++], n = atom(); v = op === '*' ? v*n : op === '/' ? v/n : v%n; } return v; }
  function sum() { let v = product(); while (['+','-'].includes(tokens[pos])) { const op = tokens[pos++], n = product(); v = op === '+' ? v+n : v-n; } return v; }
  const result = sum();
  if (pos !== tokens.length || !Number.isFinite(result)) throw new Error('Resultado inválido.');
  return result;
}
function runTool(name, args, userId, roles, options) {
  if (!allowed(userId, roles, options) || !options.tools.includes(name) ||
      (!options.toolUsers.includes(userId) && !roles.some(r => options.toolRoles.includes(r)))) return { error: 'Permissão negada.' };
  try {
    if (name === 'clock') return { utc: new Date().toISOString(), timezone: 'UTC' };
    if (name === 'calculator') return { result: calculator(args?.expression) };
    return { error: 'Ferramenta não disponível.' };
  } catch { return { error: 'Argumentos inválidos.' }; }
}
module.exports = { allowed, addressed, participate, normalize, runTool, calculator };
