const test=require('node:test');
const assert=require('node:assert/strict');
const {replyLanguage,detectTextLanguage}=require('../src/languages');
const {systemInstruction}=require('../src/live/gemini-provider');
const {defaults,validate}=require('../src/live/settings');
const {endpointDelay}=require('../src/live/primitives');
test('idiomas novos migram configurações antigas sem fixar português pelo prompt anterior',()=>{
  const o=validate({systemPrompt:'Você se chama Neva7 e conversa em português brasileiro.'},defaults({}));
  assert.equal(o.replyLanguage,'auto');const prompt=systemInstruction(o);assert.match(prompt,/português brasileiro \(PT-BR\), espanhol \(ES\) e inglês \(EN\)/);assert.match(prompt,/prevalece/);
  assert.throws(()=>validate({replyLanguage:'unknown'}));
  assert.match(systemInstruction({...o,replyLanguage:'es'}),/Responda em espanhol/);
});
test('fallback para texto identifica três idiomas e mantém português brasileiro',()=>{
  for(const [text,lang] of [['Olá, como você está?','pt'],['Hola, ¿cómo estás?','es'],['Hello, how are you?','en']])assert.equal(detectTextLanguage(text),lang);
  assert.equal(replyLanguage('portuguese'),'pt-BR');assert.equal(replyLanguage('pt-PT'),'pt-BR');assert.equal(replyLanguage('spanish'),'es-ES');assert.equal(replyLanguage('english'),'en-US');
});
test('endpoint dá tempo adicional a frases incompletas nos três idiomas',()=>{
  const o=defaults({});for(const text of ['Neve, eu queria mas','Neve, yo quiero pero','Neve, I would like to'])assert.equal(endpointDelay(text,o),o.incompleteMs);
  for(const text of ['Neve, tudo bem?','Neve, ¿cómo estás?','Neve, how are you?'])assert.equal(endpointDelay(text,o),o.silenceMs);
});
