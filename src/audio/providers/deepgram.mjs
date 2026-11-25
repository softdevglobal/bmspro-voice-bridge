// Speech transport adapter for the existing bridge. Business tool execution remains in bridge.mjs.
import {EventEmitter} from 'node:events';
import {WebSocket} from 'ws';
/** Keep display formatting out of TTS; preserve the answer's words and numbers. */
export function spokenText(text) {
  return text
    .replace(/```[^\n]*\n/g, '').replace(/```/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)([\s\S]*?)\1/g, '$2')
    .replace(/(^|[\s(])([*_])([^*_\n]+)\2(?=$|[\s.,!?:;)])/g, '$1$3')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}
export class DeepgramVoice extends EventEmitter {
  constructor(client,{key,greeting,encoding='mulaw',sampleRate=8000,acknowledgeLookups=false,Socket=WebSocket}) {
    super();if(!((encoding==='mulaw'&&sampleRate===8000)||(encoding==='linear16'&&sampleRate===24000)))throw new Error('Unsupported audio format');this.acknowledgeLookups=acknowledgeLookups;this.encoding=encoding;this.sampleRate=sampleRate;this.client=client;this.key=key;this.Socket=Socket;this.greeting=greeting;this.callerSpeaking=false;
    this.socket=new EventEmitter();this.socket.readyState=0;
    this.socket.platformSocket={bufferedAmount:0,terminate:()=>this.close()};
    this.input=[];this.parts=[];this.epoch=0;this.serial=Promise.resolve();this.pending=new Map();this.connections=new Set();this.started=Date.now();this.greeted=false;
    queueMicrotask(()=>{if(!this.closed){this.socket.readyState=1;this.socket.emit('open');}});
  }
  event(type,values={}){if(!this.closed)this.emit('event',{type,...values});}
  fail(){if(!this.closed)this.emit('error',{code:'DEEPGRAM_PIPELINE_UNAVAILABLE'});}
  async open(path,params,handler){
    const url=new URL(`wss://api.au.deepgram.com/v1/${path}`);
    url.search=new URLSearchParams({encoding:this.encoding,sample_rate:String(this.sampleRate),mip_opt_out:'true',...params}).toString();
    const ws=new this.Socket(url,{headers:{Authorization:`Token ${this.key}`},handshakeTimeout:8000,maxPayload:2*1024*1024});
    this.connections.add(ws);
    ws.on('error',()=>{if(!ws.expectedClose)this.fail();});
    ws.on('message',(data,binary)=>{if(this.closed)return;try{handler(data,binary);}catch{this.fail();}});
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);ws.once('close',()=>reject(new Error('Connection closed')));});
    if(this.closed){ws.terminate();throw new Error('Call closed');}
    return ws;
  }
  async start(session){
    this.session=session;this.backend=session.delegation.responses;
    this.instructions=session.instructions||'';
    this.asr=await this.open('listen',{model:'nova-3',language:'en-AU',channels:'1',interim_results:'true',vad_events:'true',endpointing:'300',utterance_end_ms:'1000'},(data,binary)=>{
      if(binary)return;const event=JSON.parse(data.toString());
      if(event.type==='Error')return this.fail();
      const recognized=event.type==='Results'&&/[\p{L}\p{N}]/u.test(event.channel?.alternatives?.[0]?.transcript||'');
      if(recognized&&!this.callerSpeaking){
        this.callerSpeaking=true;
        this.epoch++;this.abort?.abort();if(this.tts){this.tts.expectedClose=true;this.tts.terminate();}this.tts=null;
        this.input.push({role:'developer',content:'Caller interrupted. Previous generated words may not have been heard. Never treat an interrupted readback as confirmed. Address the latest turn and never repeat executed actions.'});
        this.event('session.caller_speech.started');
      }
      if(event.type==='Results'&&event.is_final){
        const text=event.channel?.alternatives?.[0]?.transcript;
        if(text){this.parts.push(text);const at=Date.now()-this.started;this.event('session.input_transcript.delta',{delta:text,start_ms:at,end_ms:at});}
        if(event.speech_final)this.finalTurn();
      }
      if(event.type==='UtteranceEnd')this.finalTurn();
    });
    this.asr.on('close',()=>{if(!this.closed)this.fail();});
    this.keepAlive=setInterval(()=>{if(this.asr?.readyState===1)this.asr.send(JSON.stringify({type:'KeepAlive'}));},4000);
    this.event('session.started');
  }
  finalTurn(){this.callerSpeaking=false;const text=this.parts.join(' ').trim();this.parts=[];if(!text)return;if(text.length>8000)return this.fail();this.event('session.caller_turn.completed',{text});this.enqueue(text,this.epoch);}
  enqueue(text,epoch){
    const queuedAt=performance.now();this.serial=this.serial.then(()=>this.respond(text,epoch,queuedAt)).catch(error=>{if(!this.closed&&epoch===this.epoch&&error?.name!=='AbortError')this.fail();});
  }
  async respond(text,epoch,queuedAt=performance.now()){
    if(this.closed)return;
    // Retain every completed caller utterance even if a later utterance superseded its reply.
    this.input.push({role:'user',content:text});
    if(epoch!==this.epoch)return;
    if(this.input.length>400)throw new Error('History limit');
    this.turnStartedAt=queuedAt;this.prepareSpeech(epoch);
    for(let step=0;step<10;step++){
      if(this.closed||epoch!==this.epoch)return;
      this.abort=new AbortController();
      this.event('session.delegation.created');
      const modelStarted=performance.now();
      const response=await this.client.responses.create({model:'gpt-6-luna',store:false,
        instructions:[this.instructions,this.backend.instructions].join(' '),input:this.input,
        tools:this.backend.tools||[],parallel_tool_calls:false,
        reasoning:this.backend.reasoning||{effort:'low'},
        text:this.backend.text||{verbosity:'low'},
        ...(this.backend.service_tier?{service_tier:this.backend.service_tier}:{}),
        ...(this.backend.tool_choice?{tool_choice:this.backend.tool_choice}:{}),
      },{signal:this.abort.signal,maxRetries:0,timeout:45000});
      this.event('session.latency',{stage:'luna',durationMs:Math.round(performance.now()-modelStarted)});
      this.input.push(...response.output);
      const calls=response.output.filter(item=>item.type==='function_call');
      if(this.acknowledgeLookups && this.checkedEpoch!==epoch && calls.some(item=>/^(get_|list_|lookup_|find_|search_|suggest_)/.test(item.name))){
        this.checkedEpoch=epoch;
        this.lookupAck=this.checking(epoch);
      }
      for(const item of calls){
        if(this.closed)return;
        // Register before emitting: bridge runTool supplies the result asynchronously.
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{this.pending.delete(item.call_id);reject(new Error('Tool result timeout'));},60000);
          this.pending.set(item.call_id,{resolve:()=>{clearTimeout(timer);resolve();}});
          this.event('response.event',{event:{type:'response.output_item.done',item}});
        });
      }
      if(epoch!==this.epoch||this.closed)return;
      if(!calls.length){if(response.output_text)await this.speak(response.output_text,epoch);return;}
    }
    throw new Error('Tool step limit');
  }
  // Establish the AU speech transport while Luna/tools are running. No text is
  // sent until the existing loop has a final answer with all tool results known.
  prepareSpeech(epoch){
    if(this.closed||epoch!==this.epoch)return Promise.resolve(null);
    if(this.preparedSpeech?.epoch===epoch&&(!this.preparedSpeech.ws||this.preparedSpeech.ws.readyState===1))return this.preparedSpeech.promise;
    const state={epoch,ws:null};this.preparedSpeech=state;
    const started=performance.now();
    state.promise=this.open('speak',{model:'aura-2-asteria-en'},(data,binary)=>{
      if(epoch!==this.epoch||this.closed)return;
      if(binary){
        if(!state.sent)return;
        if(!state.firstAudio){state.firstAudio=true;this.event('session.latency',{stage:'tts_first_audio',durationMs:Math.round(performance.now()-state.sentAt)});
          if(this.turnStartedAt!==undefined)this.event('session.latency',{stage:'turn_to_audio',durationMs:Math.round(performance.now()-this.turnStartedAt)});}
        this.event('session.output_audio.delta',{delta:data.toString('base64')});return;
      }
      const e=JSON.parse(data.toString());
      if(e.type==='Error')this.fail();
      if(e.type==='Flushed'&&state.ws){state.done?.();this.event('session.synthesis.done');clearTimeout(state.ws.deadline);state.ws.expectedClose=true;state.ws.close();}
    }).then(ws=>{
      state.ws=ws;
      if(this.closed||epoch!==this.epoch){ws.expectedClose=true;ws.terminate();return null;}
      this.tts=ws;
      ws.warmIdle=setTimeout(()=>{ws.expectedClose=true;ws.close();},15000);
      this.event('session.latency',{stage:'tts_connect',durationMs:Math.round(performance.now()-started)});
      ws.on('close',()=>{state.done?.();clearTimeout(ws.warmIdle);clearTimeout(ws.deadline);this.connections.delete(ws);if(this.preparedSpeech===state)this.preparedSpeech=null;if(!this.closed&&epoch===this.epoch&&!ws.expectedClose)this.fail();});
      return ws;
    }).catch(()=>{if(!this.closed&&epoch===this.epoch)this.fail();return null;});
    return state.promise;
  }
  async checking(epoch){
    const ws=await this.prepareSpeech(epoch);
    if(!ws||this.closed||epoch!==this.epoch)return;
    const state=this.preparedSpeech;
    let timer;
    const finished=new Promise(resolve=>{state.done=resolve;timer=setTimeout(()=>{ws.expectedClose=true;ws.close();resolve();},3500);});
    try{await this.speak('Let me check that for you.',epoch,true);await finished;}
    finally{clearTimeout(timer);}
  }
  async speak(text,epoch,checking=false){
    if(!checking&&this.lookupAck)await this.lookupAck;
    if(this.closed||epoch!==this.epoch)return;
    if(text.length>6000)throw new Error('Speech length limit');
    const ws=await this.prepareSpeech(epoch);
    if(!ws||this.closed||epoch!==this.epoch)return;
    const state=this.preparedSpeech;
    clearTimeout(ws.warmIdle);
    this.event('session.synthesis.started');
    ws.deadline=setTimeout(()=>this.fail(),30000);
    const at=Date.now()-this.started;
    this.event('session.output_transcript.delta',{delta:text,start_ms:at,end_ms:at});
    state.sent=true;state.sentAt=performance.now();
    ws.send(JSON.stringify({type:'Speak',text:spokenText(text)}));ws.send(JSON.stringify({type:'Flush'}));
  }
  send(event){
    if(this.closed)return;
    if(event.type==='session.start'){void this.start(event.session).catch(()=>this.fail());return;}
    if(event.type==='session.update'){this.backend={...this.backend,...event.session.delegation.responses};this.event('session.updated',{client_event_id:event.event_id});return;}
    if(event.type==='session.instructions.append'){this.instructions+=' '+event.content;return;}
    if(event.type==='session.commentary.append'){
      // Live receives split context chunks. Accumulate the seeded full greeting only once.
      if(!this.greeted){this.greeted=true;if(this.greeting){this.input.push({role:'assistant',content:this.greeting});void this.speak(this.greeting,this.epoch).catch(()=>this.fail());return;}const greeting=this.session.input?.[0]?.content?.[0]?.text||event.content;this.enqueue(greeting,this.epoch);}return;
    }
    if(event.type==='session.input_audio.append'){
      if(this.asr?.readyState===1){if(this.asr.bufferedAmount>64000)return this.fail();this.asr.send(Buffer.from(event.audio,'base64'));}return;
    }
    if(event.type==='response.item.create'){
      const item=event.item;if(item?.type!=='function_call_output')return;
      this.input.push(item);const pending=this.pending.get(item.call_id);this.pending.delete(item.call_id);pending?.resolve();return;
    }
    if(event.type==='response.create')return; // The serial loop continues after the verified tool result.
    if(event.type==='session.close'){this.event('session.closed',{reason:'close_requested'});this.close();}
  }
  close(){
    if(this.closed)return;this.closed=true;this.abort?.abort();clearInterval(this.keepAlive);
    for(const pending of this.pending.values())pending.resolve();this.pending.clear();
    for(const ws of this.connections){clearTimeout(ws.warmIdle);clearTimeout(ws.deadline);ws.terminate();}this.connections.clear();
    this.socket.readyState=3;this.socket.emit('close');this.key=null;
  }
}
