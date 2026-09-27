const { AudioBuffer, Telemetry, rms, endpointDelay } = require('./primitives');
const { allowed, addressed, participate, normalize, runTool } = require('./policy');
const { ConversationMemory } = require('./memory');
const { classifyError } = require('./gemini-provider');

// Transport-independent coordinator. Provider contract: connect/begin/sendAudio/
// end/respondTool/close; events are normalized by each provider adapter.
class LiveConversation {
  constructor({ guildId, options, providerFactory, play, stopPlayback = () => {},
    identify = id => ({id,name:id,roles:[]}), permanent, now = Date.now,
    onActivity = () => {}, onFallback = () => {}, autoTick = true }) {
    Object.assign(this, { guildId, options, providerFactory, play, stopPlayback, identify, permanent, now, onActivity, onFallback });
    this.people = new Map(); this.memory = new ConversationMemory(options); this.telemetry = new Telemetry(now);
    this.state = 'IDLE'; this.current = null; this.output = null; this.sequence = 0;
    this.paused = false; this.closed = false; this.fallback = false;
    this.safeMode = options.safeMode; this.killed = options.killed; this.silent = false;
    this.responses = []; this.interruptions = []; this.errors = [];
    this.repetitions = []; this.lastResponse = 0; this.usage = {input:0,output:0,total:0};
    this.lastTick = now(); this.resources = {rssMb:0,cpuPercent:0,eventLoopLagMs:0};
    this.cpu = process.cpuUsage(); this.cpuAt = now();
    if (autoTick) { this.timer = setInterval(() => this.tick(), 50); this.timer.unref?.(); }
  }
  event(type, data) { this.telemetry.event(type,data); }
  transition(state) { if (this.state !== state) { this.state = state; this.event('state',{state}); } }
  policy() { return {...this.options,safeMode:this.safeMode,killed:this.killed}; }
  participant(userId) {
    let p = this.people.get(userId);
    if (p) return p;
    if (this.people.size >= this.options.maxParticipants) {
      const idle = [...this.people.values()].filter(x => !x.turn && this.output?.person !== x).sort((a,b) => a.lastActive-b.lastActive)[0];
      if (!idle) { this.telemetry.count('participantsRejected'); return null; }
      this.disconnect(idle); this.people.delete(idle.id);
    }
    const info = this.identify(userId);
    p = {id:userId,name:String(info.name || userId).slice(0,80),roles:info.roles || [],lastActive:this.now(),
      epoch:0,provider:null,ready:false,connecting:false,failures:0,retryAt:0,turn:null,
      pre:[],preBytes:0,voicedMs:0,lastPacket:0,engagedUntil:0};
    this.people.set(userId,p); this.event('participant',{userId}); return p;
  }
  ingest(userId, pcm, at = this.now()) {
    if (this.closed || this.paused || this.killed || this.safeMode) return;
    if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > 16000) { this.telemetry.count('invalidFrames'); return; }
    const identity = this.identify(userId);
    if (!allowed(userId,identity.roles || [],this.policy(),identity.rolesKnown)) { this.telemetry.count('deniedFrames'); return; }
    const p = this.participant(userId); if (!p) return;
    p.roles = identity.roles || []; p.lastActive = at;
    const audible = rms(pcm) >= this.options.vadThreshold;
    const gap = p.lastPacket ? at-p.lastPacket : 0;
    p.lastPacket = at;
    if (gap > 120) this.telemetry.count('captureGaps');
    this.telemetry.count('inputFrames'); this.telemetry.count('inputBytes',pcm.length);
    if(this.options.developer && this.telemetry.counters.inputFrames%5===0)this.event('audio-frame',{userId,bytes:pcm.length});
    if (!p.turn || p.turn.phase !== 'listening') {
      if (gap > 120 || !audible) p.voicedMs = 0;
      p.voicedMs = audible ? p.voicedMs + pcm.length/32 : 0;
      p.pre.push(Buffer.from(pcm)); p.preBytes += pcm.length;
      while (p.preBytes > Math.max(this.options.vadMs + 120,300)*32) p.preBytes -= p.pre.shift().length;
      if (p.voicedMs < this.options.vadMs || at < p.retryAt) return;
      if (this.current || this.output) this.interrupt('barge-in');
      if (this.safeMode) return;
      if (p.turn) this.cancelTurn(p,'new-segment');
      const frames = p.pre; p.pre = []; p.preBytes = 0; p.voicedMs = 0;
      p.turn = {id:++this.sequence,phase:'listening',startedAt:at,lastVoice:at,frames,bytes:frames.reduce((n,b)=>n+b.length,0),
        begun:false,input:'',interim:'',answer:'',finalInput:false,generated:false,endedAt:0,audioBytes:0,admitted:false};
      this.onActivity(); this.event('vad-start',{userId,responseId:p.turn.id});
      this.telemetry.observe('vad',this.options.vadMs); this.transition('LISTENING');
      this.connect(p);
    } else {
      const t = p.turn;
      if (audible) t.lastVoice = at;
      t.frames.push(Buffer.from(pcm)); t.bytes += pcm.length;
    }
    if (p.turn && p.turn.bytes > this.options.maxInputBufferMs*32) {
      this.telemetry.count('inputOverflows'); this.cancelTurn(p,'input-overflow');
    }
  }
  connect(p) {
    if (p.ready || p.connecting || this.closed || this.paused || this.safeMode || this.killed || this.now() < p.retryAt) return;
    const epoch = ++p.epoch;
    p.connecting = true;
    const provider = this.providerFactory({options:{...this.options,provider:this.fallback?'cascade':this.options.provider},onEvent:event => {
      if (!this.closed && p.epoch === epoch && p.provider === provider) {
        try { this.receive(p,event); } catch { this.failure(p,'provider-event'); }
      }
    }});
    p.provider = provider;
    this.event('provider-connect',{userId:p.id,epoch});
    Promise.resolve().then(() => provider.connect()).then(() => {
      if (this.closed || p.epoch !== epoch) { provider.close(); return; }
      p.ready = true; p.connecting = false;
      this.event('provider-ready',{userId:p.id,epoch});
    }).catch(error => { if (p.epoch === epoch && !this.closed) this.failure(p,classifyError(error)); });
  }
  disconnect(p) {
    p.epoch++; p.ready = false; p.connecting = false;
    const provider = p.provider; p.provider = null; provider?.close();
    p.usage = null;
  }
  context(p) {
    return {speaker:{id:p.id,name:p.name},participants:[...this.people.values()].map(x => ({id:x.id,name:x.name})),
      conversation:this.memory.context(p.id),authorizedMemories:this.permanent?.forUser(this.guildId,p.id,this.options) || []};
  }
  tick(at = this.now()) {
    if (this.closed) return;
    const lag = Math.max(0,at-this.lastTick-50); this.lastTick = at;
    this.resources.eventLoopLagMs = lag;
    if (at-this.cpuAt > 2000) {
      const usage = process.cpuUsage(this.cpu);
      this.resources.cpuPercent = Math.round((usage.user+usage.system)/((at-this.cpuAt)*10)*100)/100;
      this.resources.rssMb = Math.round(process.memoryUsage().rss/1024/1024);
      this.cpu = process.cpuUsage(); this.cpuAt = at;
      if (this.resources.rssMb > this.options.watchdogMb || lag > this.options.watchdogLagMs) this.enterSafe('watchdog');
    }
    if (this.paused || this.safeMode || this.killed) return;
    for (const p of this.people.values()) {
      const t = p.turn;
      if (!t) {
        if (p.provider && at-p.lastActive > this.options.idleSessionSeconds*1000) this.disconnect(p);
        if (!p.provider && p.failures > 0 && p.retryAt && at >= p.retryAt) this.connect(p);
        continue;
      }
      if (!p.provider) this.connect(p);
      try {
        if (p.ready) {
          if (!t.begun) { p.usage=null; p.provider.begin(this.context(p)); t.begun = true; }
          // Pace catch-up to at most 100 ms per 50 ms tick; bounded local backlog.
          let sent = 0;
          while (t.frames.length && sent < 3200) {
            const pcm = t.frames.shift(); t.bytes -= pcm.length; sent += pcm.length;
            p.provider.sendAudio(pcm);
          }
        }
        if (t.phase === 'listening') {
          const otherSpeaking = [...this.people.values()].some(x => x !== p && x.turn?.phase === 'listening' && at-x.turn.lastVoice < this.options.silenceMs);
          if (at-t.lastVoice >= endpointDelay(t.interim || t.input,this.options,otherSpeaking) || at-t.startedAt >= this.options.maxUtteranceSeconds*1000) {
            t.phase = 'waiting'; t.endedAt = t.lastVoice;
            this.event('endpoint',{userId:p.id,responseId:t.id,ms:at-t.lastVoice});
            this.telemetry.observe('endpoint',at-t.lastVoice);
          }
        }
        if (t.phase === 'waiting' && at-t.endedAt > this.options.maxPendingMs) this.cancelTurn(p,'stale-input');
        if (t.phase === 'processing' && at-t.processingAt > (this.options.maxResponseSeconds+15)*1000) this.failure(p,'response-timeout');
      } catch { this.failure(p,'transport'); }
    }
    if (this.output && at-this.output.createdAt > this.options.maxResponseSeconds*1000+15000) this.enterSafe('playback-timeout');
    this.pump(at);
    if (!this.current && !this.output) {
      const turns = [...this.people.values()].map(p=>p.turn).filter(Boolean);
      this.transition(turns.some(t=>t.phase==='listening')?'LISTENING':turns.length?'WAITING':'IDLE');
    }
    if (this.pendingOptions && !this.current && !this.output && ![...this.people.values()].some(p=>p.turn)) this.applyOptions(this.pendingOptions);
  }
  pump(at) {
    if (this.current || this.output || this.paused || this.safeMode || this.killed) return;
    if ([...this.people.values()].some(p=>p.turn?.phase === 'listening')) return;
    const waiting = [...this.people.values()].filter(p=>p.ready && p.turn?.phase==='waiting' && !p.turn.bytes)
      .sort((a,b)=>(a.id===this.options.priorityUserId?-1:b.id===this.options.priorityUserId?1:a.turn.endedAt-b.turn.endedAt));
    const p = waiting[0]; if (!p) return;
    const t = p.turn; this.current = p; t.phase = 'processing'; t.processingAt = at;
    this.transition('PROCESSING'); this.event('generation-start',{userId:p.id,responseId:t.id});
    try { p.provider.end(); } catch { this.failure(p,'transport'); }
  }
  receive(p,e) {
    if (e.type === 'error') { this.failure(p,e.reason); return; }
    if (e.type === 'provider-event') { this.event('provider-event',{userId:p.id,reason:e.reason}); return; }
    if (e.type === 'goAway') {
      this.event('provider-go-away',{userId:p.id});
      if (p.turn) p.rotate = true; else { this.disconnect(p); this.connect(p); }
      return;
    }
    if (e.type === 'usage') {
      // A prompt includes previous context again each turn. Deduplicate interim
      // updates within one turn, but never subtract the previous turn's prompt.
      const next = {input:e.value.promptTokenCount || 0,output:e.value.responseTokenCount || 0,total:e.value.totalTokenCount || 0};
      for (const key of Object.keys(next)) this.usage[key] += Math.max(0,next[key]-(p.usage?.[key] || 0));
      p.usage = next; return;
    }
    const t = p.turn;
    if (!t || this.safeMode || this.killed || this.paused) return;
    if (e.type === 'interrupted') { this.cancelTurn(p,'provider-interrupted'); return; }
    if (e.type === 'tool') {
      const identity = this.identify(p.id);
      p.provider?.respondTool(e.call,runTool(e.call.name,e.call.args,p.id,identity.roles || [],this.policy()));
      this.event('tool',{userId:p.id,responseId:t.id}); return;
    }
    if (e.type === 'interim') { t.interim = e.text.slice(0,4000); this.event('transcript-partial',{userId:p.id,responseId:t.id}); }
    if (e.type === 'transcript') {
      if (e.role === 'user') {
        if (!t.finalInput) t.input = (t.input + e.text).slice(0,4000);
        if (e.final && !t.finalInput) this.finalizeInput(p,t);
        this.event(e.final?'transcript-final':'transcript-partial',{userId:p.id,responseId:t.id});
        this.admitOutput(p,t);
      } else {
        t.answer += e.text;
        if (!t.firstTextAt) { t.firstTextAt=this.now(); this.telemetry.observe('firstToken',this.now()-t.processingAt); }
        if (t.answer.length > this.options.maxCharacters) { this.cancelTurn(p,'character-limit'); return; }
        const normalized = normalize(t.answer).replace(/[^\p{L}\p{N}]/gu,'');
        if (normalized.length > 20 && this.repetitions.slice(-2).every(x=>x===normalized) && this.repetitions.length >= 2) {
          this.silent = true; this.cancelTurn(p,'loop'); this.telemetry.count('loops'); return;
        }
      }
    }
    if (e.type === 'audio') {
      if (this.current !== p || t.phase !== 'processing') return;
      if (!t.firstAudioAt) { t.firstAudioAt=this.now(); this.telemetry.observe('firstAudio',this.now()-t.processingAt); this.event('first-audio',{userId:p.id,responseId:t.id}); }
      t.audioBytes += e.pcm.length;
      if (t.audioBytes > this.options.maxResponseSeconds*48000) { this.cancelTurn(p,'duration-limit'); return; }
      if (!t.audio) t.audio = new AudioBuffer(this.options);
      if (!t.audio.push(e.pcm)) { this.telemetry.count('outputOverflows'); this.cancelTurn(p,'output-overflow'); return; }
      this.admitOutput(p,t);
    }
    if (e.type === 'generationComplete') { t.generated = true; t.audio?.end(); }
    if (e.type === 'turnComplete') {
      this.finalizeInput(p,t);
      this.admitOutput(p,t);
      t.generated = true; if (!t.audio?.stream.writableEnded) t.audio?.end();
      t.complete = true; p.failures = 0; p.retryAt = 0;
      this.telemetry.count('turns'); this.event('turn-complete',{userId:p.id,responseId:t.id});
      if (this.current === p) this.current = null;
      if (!t.admitted) { t.audio?.destroy(); this.finishTurn(p,t); }
      else if (t.played) this.finishTurn(p,t);
    }
  }
  finalizeInput(p,t) {
    // Interim hypotheses never become history. Only provider transcription is finalized.
    if (!t.finalInput && t.input.trim()) {
      t.finalInput = true; this.memory.add(p.id,'user',t.input);
      this.telemetry.observe('transcript',Math.max(0,this.now()-t.startedAt));
    }
  }
  admitOutput(p,t) {
    if (t.admitted || !t.audio || !t.input || this.current !== p || this.output || this.paused || this.safeMode || this.killed) return;
    const at = this.now();
    const identity=this.identify(p.id);
    if (!allowed(p.id,identity.roles || [],this.policy(),identity.rolesKnown)) return;
    if (this.silent) {
      if (!addressed(t.input,this.options.wakeWords)) return;
      this.silent = false; this.repetitions = [];
    }
    if (!participate(t.input,this.options,at<p.engagedUntil)) return;
    this.responses = this.responses.filter(x=>at-x<60000);
    if (this.responses.length >= this.options.responsesPerMinute || (this.lastResponse && at-this.lastResponse<this.options.cooldownMs)) return;
    this.responses.push(at); this.lastResponse = at; t.admitted = true;
    const abort = new AbortController();
    const output = {person:p,turn:t,id:t.id,abort,createdAt:at}; this.output = output;
    this.telemetry.count('responses');
    Promise.resolve().then(() => {
      if (abort.signal.aborted || this.output !== output) return false;
      return this.play(t.audio.stream,{signal:abort.signal,options:this.options,onPlaying:()=> {
        if (this.output !== output) return;
        t.playbackAt=this.now(); this.transition('SPEAKING');
        this.telemetry.observe('total',this.now()-t.endedAt);
        this.telemetry.observe('playback',this.now()-t.firstAudioAt);
        this.event('playback',{userId:p.id,responseId:t.id});
      }});
    }).then(played => {
      if (this.output !== output) return;
      this.output = null; t.played = !!played;
      if (!played) { this.cancelTurn(p,'playback-unavailable'); return; }
      this.telemetry.observe('responseDuration',this.now()-(t.playbackAt || at));
      if (t.complete) this.finishTurn(p,t);
    }).catch(() => { if (this.output === output) { this.output = null; this.failure(p,'playback'); } });
  }
  finishTurn(p,t) {
    if (p.turn !== t) return;
    if (t.played && t.answer) {
      this.memory.add(p.id,'assistant',t.answer);
      this.repetitions.push(normalize(t.answer).replace(/[^\p{L}\p{N}]/gu,''));
      this.repetitions = this.repetitions.slice(-3); p.engagedUntil=this.now()+45000;
    }
    t.audio?.destroy(); p.turn=null;
    if (!t.played) this.disconnect(p); // Never keep an unheard model answer as spoken context.
    if (p.rotate) { p.rotate=false; this.disconnect(p); this.connect(p); }
  }
  cancelTurn(p,reason) {
    const t = p.turn; if (!t) return;
    if (this.output?.person === p) {
      const out = this.output; this.output = null; out.abort.abort(); this.stopPlayback();
    }
    if (this.current === p) this.current = null;
    t.audio?.destroy(); t.frames=[]; t.bytes=0; p.turn=null;
    this.disconnect(p); // New connection epoch makes late provider events unambiguous.
    this.event('cancel',{userId:p.id,responseId:t.id,reason});
  }
  interrupt(reason = 'manual') {
    const at = this.now();
    if (this.current || this.output) {
      this.telemetry.count('interruptions'); this.interruptions=this.interruptions.filter(x=>at-x<60000); this.interruptions.push(at);
      this.transition('INTERRUPTED');
      for (const p of new Set([this.current,this.output?.person])) if (p) this.cancelTurn(p,reason);
      if (this.interruptions.length > this.options.interruptionsPerMinute) this.enterSafe('interruption-limit');
    }
  }
  failure(p,reason) {
    const at = this.now();
    this.telemetry.count('errors'); this.event('error',{userId:p.id,reason});
    this.errors=this.errors.filter(x=>at-x<60000); this.errors.push(at);
    this.cancelTurn(p,reason); this.disconnect(p); p.usage=null;
    p.failures++; p.retryAt=at+Math.min(30000,500*2**p.failures);
    if (['configuration','quota','audio-format'].includes(reason) || p.failures>this.options.reconnectAttempts || this.errors.length>=8) {
      this.enterSafe(reason);
      if (this.options.fallback === 'cascade' && this.options.provider !== 'cascade' && !this.fallback && !this.killed) {
        this.fallback=true; this.safeMode=false; this.onFallback(); this.event('fallback',{reason});
        for(const person of this.people.values()){person.failures=0;person.retryAt=0;}
      }
    }
  }
  stop(reason = 'manual') {
    for (const p of this.people.values()) { this.cancelTurn(p,reason); this.disconnect(p); p.pre=[]; p.preBytes=0; p.voicedMs=0; }
    this.current=null; this.stopPlayback(); this.transition('IDLE');
  }
  enterSafe(reason) { this.safeMode=true; this.stop(reason); this.event('safe-mode',{reason}); }
  pause(on = true) { this.paused=on; if (on) this.stop('paused'); }
  kill() { this.killed=true; this.stop('kill-switch'); this.event('kill-switch'); }
  resume() { this.stop('rearm'); this.safeMode=false; this.killed=false; this.fallback=false; this.silent=false; this.errors=[]; this.interruptions=[]; for(const p of this.people.values()){p.retryAt=0;p.failures=0;} }
  update(options) {
    // Revocations take effect immediately; cosmetic/provider edits wait for a boundary.
    const urgent = ['safeMode','killed','allowUsers','denyUsers','allowRoles','denyRoles','tools','toolUsers','toolRoles','permanentMemory','memoryUsers','retainTranscripts','enabled','mode','onlyWhenCalled'];
    if (urgent.some(k=>JSON.stringify(options[k])!==JSON.stringify(this.options[k]))) { this.stop('policy-update'); this.applyOptions(options); }
    else this.pendingOptions=options;
  }
  applyOptions(options) {
    this.pendingOptions=null; this.options=options; this.memory.options=options; this.safeMode=options.safeMode; this.killed=options.killed;
    for (const p of this.people.values()) this.disconnect(p);
    this.event('configuration-applied');
  }
  remove(userId) {
    const p=this.people.get(userId); if (!p) return;
    this.cancelTurn(p,'participant-left'); this.disconnect(p); this.people.delete(userId);
  }
  snapshot() {
    return {guildId:this.guildId,state:this.state,safeMode:this.safeMode,killed:this.killed,silent:this.silent,
      paused:this.paused,fallback:this.fallback,pendingConfiguration:!!this.pendingOptions,
      provider:this.fallback?'cascade':this.options.provider,responseId:this.output?.id || this.current?.turn?.id || null,
      participants:[...this.people.values()].map(p=>({id:p.id,name:p.name,connected:p.ready,phase:p.turn?.phase || 'idle',
        inputBytes:p.turn?.bytes || 0,outputBytes:p.turn?.audio?.size || 0,reconnectAttempts:p.failures,
        partial:this.options.retainTranscripts ? p.turn?.interim || p.turn?.input || '' : undefined})),
      memory:this.memory.snapshot(),resources:{...this.resources},usage:{...this.usage},
      estimatedCost:(this.usage.input*this.options.inputPrice+this.usage.output*this.options.outputPrice)/1000000,
      telemetry:this.telemetry.snapshot()};
  }
  close() {
    if(this.closed)return; this.closed=true; clearInterval(this.timer); this.stop('leave');
    this.people.clear(); this.memory.clear(); this.telemetry.events=[];
  }
}
module.exports = { LiveConversation };
