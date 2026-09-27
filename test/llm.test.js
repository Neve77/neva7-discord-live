const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModule, deferred } = require('./helpers');

function setup(env = {}, result = { text: 'Entendi agora', language: 'portuguese' }, globals = {}) {
  const requests = [];
  const providers = [];
  const options = [];
  let failure;
  const tts = loadModule('src/tts.js', {
    './config': { config: {}, state: {} }, 'edge-tts-universal': {}
  }, { process: { env } });
  class OpenAI {
    constructor(clientOptions) {
      this.chat = { completions: { create: async (params, requestOptions) => {
        providers.push(clientOptions);
        options.push(requestOptions);
        requests.push(params);
        if (typeof globals.chatCreate === 'function') return globals.chatCreate(params, requestOptions);
        return { choices: [{ message: { content: 'Estou no Discord.' } }] };
      } } };
      this.audio = { transcriptions: { create: async (params, requestOptions) => {
        providers.push(clientOptions);
        options.push(requestOptions);
        requests.push(params);
        if (failure) throw failure;
        return result;
      } } };
    }
  }
  const llm = loadModule('src/llm.js', {
    openai: OpenAI, './tts': tts,
    fs: { readFileSync: () => '{}', createReadStream: file => file },
    './config': { config: { sttLanguage: 'pt' } }
  }, {
    process: { env: { GROQ_API_KEY: 'groq-test', ...env } },
    setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; },
    ...globals
  });
  return { llm, requests, options, providers, fail(error) { failure = error; } };
}

test('transcrição envia idioma PT e normaliza portuguese sem falsa correção', async () => {
  const s = setup();
  const result = await s.llm.transcribe('test.wav');
  assert.equal(s.requests[0].language, 'pt');
  assert.equal(result.language, 'pt');
});

test('modo automático preserva inglês curto em vez de forçar português', async () => {
  const s = setup({ STT_LANGUAGE: 'auto' }, { text: 'Peace', language: 'english' });
  const result = await s.llm.transcribe('test.wav');
  assert.equal(result.language, 'en');
  assert.equal(s.requests[0].language, undefined);
  assert.equal(s.requests[0].prompt, undefined);
});

test('limite da transcrição não dispara outra chamada automática', async () => {
  const s = setup();
  s.fail(Object.assign(new Error('rate limit'), { status: 429 }));
  await assert.rejects(s.llm.transcribe('test.wav'), /rate limit/);
  assert.equal(s.requests.length, 1);
  assert.equal(s.options[0].maxRetries, 0);
  assert.equal(s.options[0].timeout, 8000);
});

test('política do painel substitui o antigo hint PT na transcrição e na resposta',async()=>{
  const s=setup({STT_LANGUAGE:'pt',TTS_LANGUAGE:'pt-BR'},{text:'Hola Neve, ¿cómo estás?',language:'spanish'});
  const result=await s.llm.transcribe('test.wav',{language:'auto'});
  assert.equal(s.requests[0].language,undefined);assert.equal(result.language,'es');
  await s.llm.think(result.text,'user','Converse em português.',result.language,{replyLanguage:'auto'});
  assert.match(s.requests[1].messages[0].content,/user language \(es-ES\)/);
});
test('fallback STT sem metadados identifica texto inglês e espanhol',async()=>{
  for(const [text,lang] of [['Hello, how are you?','en'],['Hola, ¿cómo estás?','es']]){
    const s=setup({}, {text});const result=await s.llm.transcribe('test.wav',{language:'auto'});assert.equal(result.language,lang);
  }
});
test('mudar idioma de resposta não reutiliza resposta em cache de outro idioma',async()=>{
  const s=setup();await s.llm.think('Hello','user','regras','en',{replyLanguage:'auto'});await s.llm.think('Hello','user','regras','en',{replyLanguage:'pt-BR'});
  assert.equal(s.requests.length,2);assert.match(s.requests[0].messages[0].content,/en-US/);assert.match(s.requests[1].messages[0].content,/português brasileiro/);
});

test('resposta usa instrução brasileira mesmo se transcrição detectou inglês; texto não vira grafia fonética', async () => {
  const s = setup();
  const reply = await s.llm.think('Onde você está?', 'user', 'Converse naturalmente.', 'english');
  assert.match(s.requests[0].messages[0].content, /português brasileiro/);
  assert.match(s.requests[0].messages[0].content, /Preserve acentos/);
  assert.equal(reply, 'Estou no Discord.');
});

test('contexto efêmero do Live não grava histórico nem reutiliza cache legado', async () => {
  const s=setup();
  await s.llm.think('pergunta','a','regras','pt',{ephemeral:true,history:[{role:'user',content:'contexto autorizado'}]});
  await s.llm.think('pergunta','a','regras','pt',{ephemeral:true});
  assert.equal(s.requests.length,2);
  assert.equal(s.llm.getHistory('a').length,0);
  assert.ok(s.requests[0].messages.some(x=>x.content==='contexto autorizado'));
});

test('cérebro GPT-OSS usa raciocínio baixo, resposta separada e orçamento de conclusão', async () => {
  const s = setup();
  await s.llm.think('teste do cérebro', 'user', 'Converse.', 'pt');
  assert.equal(s.llm.llmInfo.chatProvider, 'Groq');
  assert.equal(s.requests[0].model, 'openai/gpt-oss-120b');
  assert.equal(s.requests[0].reasoning_effort, 'low');
  assert.equal(s.requests[0].include_reasoning, false);
  assert.equal(s.requests[0].max_completion_tokens, 1024);
  assert.equal(s.requests[0].max_tokens, undefined);
});

test('stream GPT-OSS lê somente o texto final e preserva configuração explícita de esforço', async () => {
  async function* chunks() {
    yield { choices: [{ delta: { reasoning: 'Raciocínio que não deve ir para a voz.' } }] };
    yield { choices: [{ delta: { content: 'Agora sim! ' } }] };
    yield { choices: [{ delta: { content: 'Manda a próxima.' } }] };
  }
  const s = setup({ CHAT_REASONING_EFFORT: 'medium', MAX_TOKENS: '1500' }, undefined, {
    chatCreate: async () => chunks()
  });
  const spoken = [];
  const result = await s.llm.thinkStream('teste', 'user', 'Converse.', 'pt', { onSentence: text => spoken.push(text) });
  assert.equal(s.requests[0].stream, true);
  assert.equal(s.requests[0].reasoning_effort, 'medium');
  assert.equal(s.requests[0].max_completion_tokens, 1500);
  assert.deepEqual(spoken, ['Agora sim!', 'Manda a próxima.']);
  assert.equal(result, 'Agora sim! Manda a próxima.');
});

test('fallback Gemini não recebe parâmetros específicos do GPT-OSS', async () => {
  for (const streaming of [false, true]) {
    const s = setup({ GEMINI_API_KEY: 'gemini-test' }, undefined, {
      chatCreate: async params => {
        if (params.model === 'openai/gpt-oss-120b') throw new Error('Groq indisponível');
        if (streaming) return (async function* () { yield { choices: [{ delta: { content: 'Tô aqui.' } }] }; })();
        return { choices: [{ message: { content: 'Tô aqui.' } }] };
      }
    });
    const result = await s.llm[streaming ? 'thinkStream' : 'think']('teste', 'user', 'Converse.', 'pt');
    assert.equal(result, 'Tô aqui.');
    assert.equal(s.requests[1].model, 'gemini-3.6-flash');
    assert.equal(s.requests[1].reasoning_effort, undefined);
    assert.equal(s.requests[1].include_reasoning, undefined);
    assert.equal(s.requests[1].max_completion_tokens, undefined);
    assert.equal(s.requests[1].max_tokens, 1024);
  }
});

test('modelo Gemini usa endpoint e chave Google em texto e streaming, mantendo STT no Groq', async () => {
  for (const streaming of [false, true]) {
    const s = setup({ GEMINI_API_KEY: 'gemini-test', CHAT_MODEL: 'gemini-3.6-flash' }, undefined, {
      chatCreate: async () => streaming
        ? (async function* () { yield { choices: [{ delta: { content: 'Gemini respondeu.' } }] }; })()
        : { choices: [{ message: { content: 'Gemini respondeu.' } }] }
    });
    const reply = await s.llm[streaming ? 'thinkStream' : 'think']('teste', 'user', 'Converse.', 'pt');
    assert.equal(reply, 'Gemini respondeu.');
    assert.equal(s.llm.llmInfo.chatProvider, 'Gemini');
    assert.equal(s.providers[0].baseURL, 'https://generativelanguage.googleapis.com/v1beta/openai/');
    assert.equal(s.providers[0].apiKey, 'gemini-test');
    assert.equal(s.requests[0].model, 'gemini-3.6-flash');
    assert.equal(s.requests[0].reasoning_effort, undefined);
    await s.llm.transcribe('test.wav');
    assert.equal(s.providers[1].baseURL, 'https://api.groq.com/openai/v1');
    assert.equal(s.llm.llmInfo.sttProvider, 'Groq');
  }
});

test('chat funciona com somente a chave Gemini, sem cliente Groq ou OpenAI', async () => {
  const s = setup({ GROQ_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: 'gemini-test' });
  assert.equal(await s.llm.think('teste', 'user', 'Converse.'), 'Estou no Discord.');
  assert.equal(s.llm.llmInfo.chatProvider, 'Gemini');
  assert.equal(s.providers[0].apiKey, 'gemini-test');
});

test('erro do Gemini principal não repete a requisição como fallback', async () => {
  for (const streaming of [false, true]) {
    const s = setup({ GEMINI_API_KEY: 'gemini-test', CHAT_MODEL: 'gemini-2.5-flash' }, undefined, {
      chatCreate: async () => { throw Object.assign(new Error('quota Gemini'), { status: 429 }); }
    });
    await assert.rejects(s.llm[streaming ? 'thinkStream' : 'think']('teste', 'user', 'Converse.'), /quota Gemini/);
    assert.equal(s.requests.length, 1);
  }
});

test('modelo Gemini sem chave informa a configuração ausente sem enviar ao Groq', async () => {
  const s = setup({ CHAT_MODEL: 'gemini-3.6-flash', GEMINI_API_KEY: '' });
  for (const method of ['think', 'thinkStream']) {
    await assert.rejects(s.llm[method]('teste', 'user', 'Converse.'), /GEMINI_API_KEY/);
  }
  assert.equal(s.requests.length, 0);
});

test('resposta em stream libera a primeira frase antes de terminar a geração', async () => {
  async function* chunks() {
    yield { choices: [{ delta: { content: 'Tô por aqui. ' } }] };
    yield { choices: [{ delta: { content: 'Manda a próxima.' } }] };
  }
  const s = setup({}, undefined, {
    chatCreate: async params => {
      assert.equal(params.stream, true);
      return chunks();
    }
  });
  const spoken = [];
  const reply = await s.llm.thinkStream('teste', 'user', 'Converse naturalmente.', 'pt', {
    onSentence: sentence => spoken.push(sentence)
  });
  assert.equal(reply, 'Tô por aqui. Manda a próxima.');
  assert.deepEqual(spoken, ['Tô por aqui.', 'Manda a próxima.']);
});

test('primeiro trecho de frase longa sai numa pausa antes de terminar a interpretação', async () => {
  const complete = deferred();
  const first = 'Eu consigo preparar a próxima parte enquanto conversamos,';
  async function* chunks() {
    yield { choices: [{ delta: { content: first + ' ' } }] };
    await complete.promise;
    yield { choices: [{ delta: { content: 'e assim a conversa fica mais rápida.' } }] };
  }
  const s = setup({}, undefined, { chatCreate: async () => chunks() });
  const spoken = [];
  const reply = s.llm.thinkStream('teste', 'user', 'Converse.', 'pt', { onSentence: text => spoken.push(text) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(spoken, [first]);
  complete.resolve();
  const result = await reply;
  assert.equal(result, spoken.join(' '));
});

test('primeiro trecho sem pontuação respeita palavras e não duplica o texto restante', async () => {
  const complete = deferred();
  const prefix = 'Vou começar explicando como podemos conversar de um jeito mais rápido enquanto preparo o restante da resposta para você ouvir com calma';
  async function* chunks() {
    yield { choices: [{ delta: { content: prefix } }] };
    await complete.promise;
    yield { choices: [{ delta: { content: ' e entender tudo.' } }] };
  }
  const s = setup({}, undefined, { chatCreate: async () => chunks() });
  const spoken = [];
  const reply = s.llm.thinkStream('teste', 'user', 'Converse.', 'pt', { onSentence: text => spoken.push(text) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spoken.length, 1);
  assert.ok(prefix.startsWith(spoken[0] + ' '));
  complete.resolve();
  assert.equal(await reply, spoken.join(' '));
});

test('prazo da transcrição aborta a requisição em andamento', async () => {
  let deadline;
  const pending = deferred();
  const s = setup({}, pending.promise, { setTimeout: callback => { deadline = callback; return 0; }, clearTimeout() {} });
  const transcribing = s.llm.transcribe('test.wav');
  await Promise.resolve();
  deadline();
  await assert.rejects(transcribing, /timeout/);
  assert.equal(s.options[0].signal.aborted, true);
  pending.resolve({ text: 'resposta antiga' });
});

test('interrupção cancela STT sem esperar a API responder', async () => {
  const pending = deferred();
  const s = setup({}, pending.promise);
  const controller = new AbortController();
  const transcribing = s.llm.transcribe('test.wav', { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(transcribing, { name: 'AbortError' });
  assert.equal(s.options[0].signal.aborted, true);
  pending.resolve({ text: 'resposta antiga' });
});

test('pesquisa pode chamar chatOnce exportado com o modelo configurado', async () => {
  const s = setup({ GEMINI_API_KEY: 'gemini-test', CHAT_MODEL: 'gemini-3.6-flash' });
  await s.llm.chatOnce(s.llm.llmInfo.chatModel, [{ role: 'user', content: 'Resuma os resultados.' }]);
  assert.equal(s.providers[0].apiKey, 'gemini-test');
  assert.equal(s.requests[0].model, 'gemini-3.6-flash');
});

test('cache nunca reaproveita pergunta depois de outra troca na conversa', async () => {
  for (const method of ['think', 'thinkStream']) {
    const s = setup({}, undefined, { chatCreate: async params => params.stream
      ? (async function* () { yield { choices: [{ delta: { content: 'Resposta.' } }] }; })()
      : { choices: [{ message: { content: 'Resposta.' } }] } });
    await s.llm[method]('por quê?', 'user', 'Converse.');
    await s.llm[method]('mude de assunto', 'user', 'Converse.');
    await s.llm[method]('por quê?', 'user', 'Converse.');
    assert.equal(s.requests.length, 3);
    assert.ok(s.requests[2].messages.some(m => m.content === 'mude de assunto'));
  }
});

test('cache inclui instruções, assunto, participantes, destino, idioma e modo', async () => {
  const variations = [
    { prompt: 'Outra personalidade.' }, { topicContext: 'Outro assunto.' },
    { callMembers: 'Ana e Bruno' }, { conversationId: 'outro-servidor:canal' },
    { replyLanguage: 'en' }, { responseMode: 'text' }, { botName: 'Outro nome' }
  ];
  for (const variation of variations) {
    const s = setup();
    await s.llm.think('oi', 'user', 'Converse.');
    s.llm.getHistory('user').length = 0; // Mesmo histórico; somente a configuração muda.
    await s.llm.think('oi', 'user', variation.prompt || 'Converse.', 'pt', variation);
    assert.equal(s.requests.length, 2, JSON.stringify(variation));
  }
});

test('cache idêntico é reutilizado e limpar histórico invalida somente esse usuário', async () => {
  const s = setup();
  await s.llm.think('oi', 'user', 'Converse.');
  await s.llm.think('olá', 'another', 'Converse.');
  s.llm.getHistory('user').length = 0;
  await s.llm.think('oi', 'user', 'Converse.');
  assert.equal(s.requests.length, 2);
  s.llm.clearHistory('user');
  assert.equal(s.llm.responseCacheInfo().entries, 1);
  await s.llm.think('oi', 'user', 'Converse.');
  assert.equal(s.requests.length, 3);
});

test('stream efêmero respeita histórico recebido sem gravar histórico ou cache', async () => {
  const s = setup({}, undefined, { chatCreate: async () => (async function* () {
    yield { choices: [{ delta: { content: 'Resposta.' } }] };
  })() });
  await s.llm.thinkStream('oi', 'user', 'Converse.', 'pt', { ephemeral: true, history: [{ role: 'user', content: 'Contexto autorizado.' }] });
  assert.ok(s.requests[0].messages.some(m => m.content === 'Contexto autorizado.'));
  assert.equal(s.llm.getHistory('user').length, 0);
  assert.equal(s.llm.responseCacheInfo().entries, 0);
});

function retryTimers(delays) {
  return (callback, delay) => {
    if (delay < 3000) { delays.push(delay); queueMicrotask(callback); return 0; }
    const timer = setTimeout(callback, delay); timer.unref(); return timer;
  };
}

test('Gemini recupera um 503 em texto e na abertura do streaming, com uma espera curta', async () => {
  for (const streaming of [false, true]) {
    let attempts = 0;
    const delays = [];
    const s = setup({ GEMINI_API_KEY: 'gemini-test', CHAT_MODEL: 'gemini-3.6-flash' }, undefined, {
      setTimeout: retryTimers(delays),
      chatCreate: async () => {
        if (++attempts === 1) throw Object.assign(new Error('temporário'), { status: 503 });
        return streaming ? (async function* () { yield { choices: [{ delta: { content: 'Recuperou.' } }] }; })()
          : { choices: [{ message: { content: 'Recuperou.' } }] };
      }
    });
    assert.equal(await s.llm[streaming ? 'thinkStream' : 'think']('oi', 'user', 'Converse.'), 'Recuperou.');
    assert.equal(attempts, 2);
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 200 && delays[0] <= 700);
  }
});

test('Gemini respeita Retry-After curto e não espera cota longa ou repete erro permanente', async () => {
  for (const [status, retryAfter, expected] of [[429, '1', 2], [429, '65', 1], [503, '10', 1], [403, null, 1], [400, null, 1], [503, null, 2]]) {
    const delays = [];
    const s = setup({ GEMINI_API_KEY: 'gemini-test', CHAT_MODEL: 'gemini-3.6-flash' }, undefined, {
      setTimeout: retryTimers(delays),
      chatCreate: async () => { throw Object.assign(new Error('indisponível'), { status, headers: { 'retry-after': retryAfter } }); }
    });
    await assert.rejects(s.llm.think('oi', 'user', 'Converse.'), /indisponível/);
    assert.equal(s.requests.length, expected);
    if (status === 429 && retryAfter === '1') assert.ok(delays[0] >= 1000);
  }
});

test('stream recupera falha anterior ao texto; depois do primeiro trecho nunca repete', async () => {
  for (const partial of [false, true]) {
    let attempts = 0;
    const s = setup({ GEMINI_API_KEY: 'gemini-test', CHAT_MODEL: 'gemini-3.6-flash' }, undefined, {
      setTimeout: retryTimers([]),
      chatCreate: async () => {
        const attempt = ++attempts;
        return (async function* () {
          if (attempt === 1) {
            if (partial) yield { choices: [{ delta: { content: 'Já comecei.' } }] };
            throw Object.assign(new Error('stream indisponível'), { status: 503 });
          }
          yield { choices: [{ delta: { content: 'Recuperou.' } }] };
        })();
      }
    });
    const spoken = [];
    const promise = s.llm.thinkStream('oi', 'user', 'Converse.', 'pt', { onSentence: text => spoken.push(text) });
    if (partial) {
      await assert.rejects(promise, /stream indisponível/);
      assert.deepEqual(spoken, ['Já comecei.']);
      assert.equal(attempts, 1);
    } else {
      assert.equal(await promise, 'Recuperou.');
      assert.deepEqual(spoken, ['Recuperou.']);
      assert.equal(attempts, 2);
    }
  }
});

test('interromper durante a espera cancela a nova tentativa Gemini', async () => {
  const waiting = deferred(), controller = new AbortController();
  const s = setup({ GEMINI_API_KEY: 'gemini-test', CHAT_MODEL: 'gemini-3.6-flash' }, undefined, {
    setTimeout: (callback, delay) => {
      if (delay < 3000) { waiting.resolve(); return 0; }
      const timer = setTimeout(callback, delay); timer.unref(); return timer;
    },
    chatCreate: async () => { throw Object.assign(new Error('temporário'), { status: 503 }); }
  });
  const request = s.llm.think('oi', 'user', 'Converse.', 'pt', { signal: controller.signal });
  await waiting.promise;
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(s.requests.length, 1);
});

test('texto escrito preserva detalhes enquanto a voz termina numa frase completa', async () => {
  const first = 'A primeira frase responde diretamente à pergunta.';
  const details = ' Aqui estão mais detalhes para você ler com calma.'.repeat(14);
  const full = first + details;
  const s = setup({}, undefined, { chatCreate: async params => params.stream
    ? (async function* () { for (let i = 0; i < full.length; i += 17) yield { choices: [{ delta: { content: full.slice(i, i + 17) } }] }; })()
    : { choices: [{ message: { content: full } }] } });
  const spoken = [];
  let firstTokens = 0;
  const reply = await s.llm.thinkStream('explique', 'user', 'Converse.', 'pt', {
    responseMode: 'text', onSentence: text => spoken.push(text), onFirstToken: () => firstTokens++
  });
  assert.equal(reply, full);
  assert.ok(reply.length > 300);
  assert.ok(spoken.join(' ').length <= 300);
  assert.ok(spoken.at(-1).endsWith('.'));
  assert.equal(firstTokens, 1);
  assert.equal(await s.llm.think('explique', 'other', 'Converse.', 'pt', { responseMode: 'text' }), full);
  const voice = await s.llm.think('explique', 'voice', 'Converse.');
  assert.equal(voice, spoken.join(' '));
});
