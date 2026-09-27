// The dashboard owns the conversation policy; standalone legacy callers can
// still use their environment defaults until LiveService is initialized.
let conversationLanguage = null;
const SUPPORTED = ['auto', 'pt-BR', 'es', 'en'];
function setConversationLanguage(value) {
  if (!SUPPORTED.includes(value)) throw new Error('Idioma de resposta inválido.');
  conversationLanguage = value;
}
function getConversationLanguage() { return conversationLanguage; }
function normalizeLanguage(value = 'pt') {
  const code = String(value).trim().toLowerCase();
  return ({portuguese:'pt', 'português':'pt', spanish:'es', español:'es', english:'en'})[code] || code.split(/[-_]/)[0];
}
function replyLanguage(detected, policy = 'auto') {
  const preference = String(policy).trim().toLowerCase();
  const code = normalizeLanguage(preference === 'auto' ? detected : preference);
  return code === 'en' ? 'en-US' : code === 'es' ? 'es-ES' : 'pt-BR';
}
// Only a fallback for typed text / STT responses without language metadata.
// The audio recognizer or Gemini performs detection on actual speech.
function detectTextLanguage(text, fallback = 'pt') {
  const words = String(text).toLowerCase().match(/[\p{L}]+/gu) || [];
  const lexicon = {
    pt: new Set('olá oi obrigado obrigada você vocês não sim estou como está vamos hoje qual quero queria tudo bem fala português'.split(' ')),
    es: new Set('hola gracias español cómo estás estoy quiero quisiera puedes por favor buenos buenas días noches eres habla conmigo dónde qué pero'.split(' ')),
    en: new Set('hello hi thanks thank please how are you i am want would can could what where why tell speak english good morning the is this and'.split(' '))
  };
  const scores = Object.entries(lexicon).map(([code,set]) => [code,words.filter(w=>set.has(w)).length]);
  scores.sort((a,b)=>b[1]-a[1]);
  return scores[0][1] > scores[1][1] ? scores[0][0] : normalizeLanguage(fallback);
}
function languageInstruction(policy = 'auto') {
  const target = {'pt-BR':'português brasileiro',es:'espanhol',en:'inglês'}[policy];
  return 'IDIOMAS: Entenda português brasileiro (PT-BR), espanhol (ES) e inglês (EN), inclusive alternância entre eles. ' +
    (target ? `Responda em ${target}, mesmo quando a entrada estiver em outro idioma. ` : 'Identifique o idioma da fala atual e responda nesse mesmo idioma; acompanhe as mudanças de idioma entre turnos. ') +
    'Em português use sotaque e vocabulário do Brasil. Não traduza por padrão. Esta política de idioma prevalece sobre preferências de idioma em personalidades e instruções antigas.';
}
module.exports = { SUPPORTED, setConversationLanguage, getConversationLanguage, normalizeLanguage, replyLanguage, detectTextLanguage, languageInstruction };
