const { stripVTControlCharacters } = require('util');

const GROUPS = [
  ['CONEXÃO', [['1', 'Servidor'], ['2', 'Canal de texto'], ['3', 'Entrar na call'], ['4', 'Sair da call']]],
  ['MÚSICA', [['7', 'Tocar música'], ['8', 'Ver fila'], ['9', 'Pular faixa'], ['10', 'Parar e limpar']]],
  ['VOZ', [['5', 'Testar voz'], ['6', 'Falar uma frase'], ['13', 'Escolher voz'], ['14', 'Velocidade']]],
  ['AJUSTES', [['11', 'Volume'], ['12', 'Personalidade'], ['15', 'Escuta ON / OFF'], ['19', 'Entrada automática']]],
  ['CONVERSA', [['16', 'Enviar mensagem'], ['20', 'Resposta em texto'], ['21', 'Resumir chat'], ['25', 'Anúncio: texto + voz']]],
  ['AUTOMAÇÃO', [['17', 'Vida própria ON / OFF'], ['18', 'Vida própria: canal'], ['19', 'Entrada automática'], ['0', 'Atualizar']]],
  ['FERRAMENTAS', [['22', 'Abrir logs'], ['23', 'Diagnóstico rápido'], ['24', 'Repetir última fala'], ['99', 'Desligar o bot']]]
];
const COLORS = { edge: 60, title: 81, muted: 245, text: 252, green: 114, yellow: 221, red: 203, key: 117 };
const segmenter = new Intl.Segmenter('pt-BR', { granularity: 'grapheme' });
const clean = value => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
const paint = (text, color, enabled) => enabled ? `\x1b[38;5;${COLORS[color]}m${text}\x1b[0m` : text;

function cellWidth(char) {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(char)) return 2;
  const cp = char.codePointAt(0);
  return cp >= 0x1100 && (cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7a3 || cp >= 0xf900 && cp <= 0xfaff || cp >= 0xff01 && cp <= 0xff60) ? 2 : 1;
}

function fit(value, width) {
  let text = '', used = 0;
  const chars = [...segmenter.segment(clean(value))].map(item => item.segment);
  for (let i = 0; i < chars.length; i++) {
    const size = cellWidth(chars[i]);
    if (used + size > width || used + size === width && i < chars.length - 1) {
      text += '…'; used++; break;
    }
    text += chars[i]; used += size;
  }
  return text + ' '.repeat(Math.max(0, width - used));
}

function menuText(status, columns = 88, { color = false, rows = 40 } = {}) {
  const width = Math.max(28, Math.min(columns - 2, 112));
  const inside = width - 4;
  const p = (text, role) => paint(text, role, color);
  const line = (text, role = 'text') => ` ${p('│', 'edge')} ${p(fit(text, inside), role)} ${p('│', 'edge')}`;
  const ncols = width >= 102 ? 3 : width >= 54 ? 2 : 1;
  const cell = Math.floor((inside - (ncols - 1) * 2) / ncols);
  const compact = rows < 30;
  const flag = value => value ? 'ON' : 'OFF';
  const lines = [
    ` ${p('╭' + '─'.repeat(width - 2) + '╮', 'edge')}`,
    line(`PAINEL DO BOT  /  ${status.username || 'Discord'}  ·  ${status.online ? 'ONLINE' : 'CONECTANDO'}`, status.online ? 'title' : 'yellow'),
    line(`${status.guild || 'Escolha um servidor [1]'}  /  Call: ${status.call || 'fora da call'}`, 'muted'),
    ...(!compact || !status.musicError ? [line(`${status.tts || 'Voz'}: ${status.voice || '—'} ${status.speed || 1}x  ·  Volume: ${status.volume == null ? '—' : status.volume + '%'}  ·  Escuta: ${status.listening == null ? '—' : flag(status.listening)}`)] : []),
    ...(!compact ? [
      line(`Texto: #${status.channel || 'não selecionado'}  ·  Emoção: ${status.emotion || 'natural'}`, 'muted'),
      line(`IA: ${status.model || '—'}  ·  Autoentrada: ${flag(status.autoJoin)}  ·  Resposta em texto: ${flag(status.replyInText)}  ·  Vida própria: ${flag(status.alive)}`, 'muted')
    ] : []),
    line(`♫  ${status.music || 'Sem música  ·  use [7] para tocar'}`, status.music?.startsWith('tocando:') ? 'green' : 'yellow'),
    ...(status.musicError ? [line(`Erro: ${status.musicError}  [22] detalhes`, 'red')] : [])
  ];
  for (let start = 0; start < GROUPS.length; start += ncols) {
    const groups = GROUPS.slice(start, start + ncols);
    lines.push(line(groups.map(([title]) => fit(title, cell)).join('  '), 'title'));
    for (let row = 0; row < 4; row++) {
      const cells = groups.map(([, items]) => {
        const [key, label] = items[row];
        return p(key.padStart(2, '0'), key === '99' ? 'red' : 'key') + '  ' + p(fit(label, cell - 4), 'text');
      });
      const padding = inside - groups.length * cell - (groups.length - 1) * 2;
      lines.push(` ${p('│', 'edge')} ${cells.join('  ')}${' '.repeat(padding)} ${p('│', 'edge')}`);
    }
  }
  lines.push(` ${p('╰' + '─'.repeat(width - 2) + '╯', 'edge')}`);
  return lines.join('\n');
}

module.exports = { menuText, fit, clean };
