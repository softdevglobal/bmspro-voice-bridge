import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {DeepgramVoice} from '../src/audio/providers/deepgram.mjs';
import {loadAudioProviderConfig,useDeepgram} from '../src/audio/providers/config.mjs';
class Socket extends EventEmitter {
  static all=[];
  constructor(url,options){super();this.url=new URL(url);this.options=options;this.sent=[];this.readyState=0;this.bufferedAmount=0;Socket.all.push(this);queueMicrotask(()=>{this.readyState=1;this.emit('open');});}
  send(data){this.sent.push(data);}
  terminate(){if(this.readyState===3)return;this.readyState=3;this.emit('close');}
  close(){this.terminate();}
  message(data,binary=false){this.emit('message',binary?Buffer.from(data):Buffer.from(JSON.stringify(data)),binary);}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function setup(client={responses:{create:async()=>({output:[],output_text:'Hello'})}}){
  const voice=new DeepgramVoice(client,{key:'fixture-secret',Socket});const events=[];const errors=[];
  voice.on('event',e=>events.push(e));voice.on('error',e=>errors.push(e));
  await once(voice.socket,'open');
  voice.send({type:'session.start',session:{instructions:'Sophie',input:[{content:[{text:'Greet the caller.'}]}],delegation:{responses:{instructions:'rules',tools:[]}}}});
  await tick();return {voice,events,errors,asr:voice.asr};
}
test('default route and non-Trade routes remain GPT Live; secret required only for Deepgram',async()=>{
  assert.equal((await loadAudioProviderConfig({})).provider,'gpt-live');
  await assert.rejects(loadAudioProviderConfig({BMSPRO_AUDIO_PROVIDER:'deepgram'}));
  const config=await loadAudioProviderConfig({BMSPRO_AUDIO_PROVIDER:'deepgram',BMSPRO_DEEPGRAM_DIDS_JSON:'["0359111403"]',DEEPGRAM_API_KEY:'fixture'});
  assert.equal(useDeepgram(config,{mode:'trade',did:'0359111403'}),true);
  assert.equal(useDeepgram(config,{mode:'trade',did:'0359111404'}),false);
  assert.equal(useDeepgram(config,{mode:'pink',did:'0359111403'}),false);
});
test('AU recognition/synthesis share PCMU and privacy flags; audio uses existing bridge events',async()=>{
  const {voice,events,asr}=await setup();
  try{
    voice.send({type:'session.commentary.append',content:'greeting chunk'});await tick();await tick();
    const tts=voice.tts;assert.ok(tts);
    for(const ws of [asr,tts]){assert.equal(ws.url.hostname,'api.au.deepgram.com');assert.equal(ws.url.searchParams.get('mip_opt_out'),'true');assert.equal(ws.url.searchParams.get('encoding'),'mulaw');assert.equal(ws.url.searchParams.get('sample_rate'),'8000');}
    assert.equal(asr.url.searchParams.get('language'),'en-AU');assert.equal(tts.url.searchParams.get('model'),'aura-2-asteria-en');
    tts.message([1,2,3],true);assert.equal(events.at(-1).type,'session.output_audio.delta');
    voice.send({type:'session.input_audio.append',audio:Buffer.alloc(160,255).toString('base64')});assert.equal(asr.sent.at(-1).length,160);
  }finally{voice.close();}
});
test('barge-in closes old synthesis and discards its late audio',async()=>{
  const {voice,asr,events}=await setup();
  try{
    voice.send({type:'session.commentary.append',content:'greet'});await tick();await tick();const old=voice.tts;
    asr.message({type:'Results',is_final:false,channel:{alternatives:[{transcript:'please wait'}]}});assert.equal(old.readyState,3);assert.ok(events.some(e=>e.type==='session.caller_speech.started'));
    const count=events.length;old.message([1,2],true);assert.equal(events.length,count);
  }finally{voice.close();}
});
test('five concurrent calls keep independent history and tools use existing bridge continuation',async()=>{
  await Promise.all(Array.from({length:5},async(_,i)=>{
    let requests=0;
    const {voice,asr,events}=await setup({responses:{create:async request=>{
      assert.equal(request.model,'gpt-6-luna');assert.equal(request.parallel_tool_calls,false);assert.equal(request.store,false);
      if(!requests++)return {output:[{type:'function_call',call_id:`tool-${i}`,name:'lookup',arguments:'{}'}]};
      assert.ok(request.input.some(item=>item.call_id===`tool-${i}`&&item.type==='function_call_output'));
      assert.ok(!request.input.some(item=>item.role==='user'&&item.content!==`caller ${i}`));
      return {output:[],output_text:'Verified answer'};
    }}});
    voice.on('event',e=>{if(e.type==='response.event')voice.send({type:'response.item.create',item:{type:'function_call_output',call_id:e.event.item.call_id,output:'{"status":"OK"}'}});});
    try{asr.message({type:'Results',is_final:true,speech_final:true,channel:{alternatives:[{transcript:`caller ${i}`}]}});await voice.serial;assert.ok(events.some(e=>e.type==='session.output_transcript.delta'));}
    finally{voice.close();}
  }));
});
test('provider disconnection reports a safe failure and close tears down every socket',async()=>{
  const {voice,asr,errors}=await setup();asr.terminate();assert.equal(errors[0].code,'DEEPGRAM_PIPELINE_UNAVAILABLE');
  voice.close();assert.equal(voice.connections.size,0);assert.equal(voice.socket.readyState,3);
});

test('unfiltered Deepgram follows every resolved Trade DID without assigning tenant identity',async()=>{
  const config=await loadAudioProviderConfig({BMSPRO_AUDIO_PROVIDER:'deepgram',DEEPGRAM_API_KEY:'fixture'});
  assert.equal(config.dids,null);
  for(const did of ['0359111403','0399991111'])assert.equal(useDeepgram(config,{mode:'trade',did}),true);
  assert.equal(useDeepgram(config,{mode:'pink',did:'0359111403'}),false);
  assert.equal(useDeepgram(config,null),false);
  assert.equal(useDeepgram(config,{mode:'trade'}),false);
  for(const filter of ['[]','{}','["bad"]'])await assert.rejects(loadAudioProviderConfig({BMSPRO_AUDIO_PROVIDER:'deepgram',DEEPGRAM_API_KEY:'fixture',BMSPRO_DEEPGRAM_DIDS_JSON:filter}));
});

test('SDK cancellation after caller interruption is not a fatal pipeline failure',async()=>{
  let rejectRequest;
  const {voice,asr,errors}=await setup({responses:{create:()=>new Promise((_,reject)=>{rejectRequest=reject;})}});
  try{
    asr.message({type:'Results',is_final:true,speech_final:true,channel:{alternatives:[{transcript:'hello'}]}});
    await tick();assert.equal(typeof rejectRequest,'function');
    asr.message({type:'Results',is_final:false,channel:{alternatives:[{transcript:'please wait'}]}});
    const error=new Error('Request was aborted.');error.name='APIUserAbortError';rejectRequest(error);
    await voice.serial;assert.equal(errors.length,0);
  }finally{voice.close();}
});

test('intentional TTS close errors after interruption do not terminate the call',async()=>{
  const {voice,asr,errors}=await setup();
  try{
    voice.send({type:'session.commentary.append',content:'greet'});await tick();await tick();const old=voice.tts;
    asr.message({type:'Results',is_final:false,channel:{alternatives:[{transcript:'please wait'}]}});old.emit('error',new Error('Socket cancelled'));
    assert.equal(errors.length,0);assert.equal(voice.closed,undefined);
  }finally{voice.close();}
});

test('configured greeting speaks first without Luna or caller input; bare VAD cannot cancel it',async()=>{
  let requests=0;
  const voice=new DeepgramVoice({responses:{create:async()=>{requests++;throw new Error('Must not generate greeting');}}},{key:'fixture',greeting:'Hi, thanks for calling Tenant A. My name is Sophie.',Socket});
  const errors=[];voice.on('error',e=>errors.push(e));voice.on('event',()=>{});
  try{
    await once(voice.socket,'open');
    voice.send({type:'session.start',session:{instructions:'rules',delegation:{responses:{tools:[]}}}});await tick();
    voice.send({type:'session.commentary.append',content:'greet'});await tick();await tick();
    assert.ok(voice.tts);assert.equal(requests,0);
    assert.ok(voice.tts.sent.some(x=>typeof x==='string'&&JSON.parse(x).text?.includes('Tenant A')));
    const epoch=voice.epoch;voice.asr.message({type:'SpeechStarted'});assert.equal(voice.epoch,epoch);assert.equal(voice.tts.readyState,1);assert.equal(errors.length,0);
  }finally{voice.close();}
});

test('owner browser format uses 24kHz PCM on both Deepgram streams while phone defaults remain PCMU',async()=>{
  const voice=new DeepgramVoice({responses:{create:async()=>({output:[],output_text:'Hello'})}},{key:'fixture',encoding:'linear16',sampleRate:24000,Socket});
  voice.on('error',()=>{});voice.on('event',()=>{});
  try{
    await once(voice.socket,'open');voice.send({type:'session.start',session:{instructions:'rules',input:[{content:[{text:'greet'}]}],delegation:{responses:{tools:[]}}}});await tick();
    voice.send({type:'session.commentary.append',content:'greet'});await tick();await tick();
    for(const ws of [voice.asr,voice.tts]){assert.equal(ws.url.searchParams.get('encoding'),'linear16');assert.equal(ws.url.searchParams.get('sample_rate'),'24000');assert.equal(ws.url.searchParams.get('mip_opt_out'),'true');}
  }finally{voice.close();}
});

test('speech removes Markdown markers while preserving report wording and numbers',async()=>{
  const {spokenText}=await import('../src/audio/providers/deepgram.mjs');
  assert.equal(spokenText('**Calls handled:** 8 calls today.\n\n**Missed calls:** 5 records.'),'Calls handled: 8 calls today.\n\nMissed calls: 5 records.');
  assert.equal(spokenText('## Summary\n- **Needs follow-up:** Call [John](https://example.test).\n- Invoice `INV-12`: $120.'),'Summary\nNeeds follow-up: Call John.\nInvoice INV-12: $120.');
  assert.equal(spokenText('Say *hello* and press * to continue.'),'Say hello and press * to continue.');
});

test('speech connection opens while Luna works but speech waits for the final verified answer',async()=>{
  let complete,request;
  const {voice,asr,events}=await setup({responses:{create:async value=>{request=value;return new Promise(resolve=>{complete=resolve;});}}});
  try{
    asr.message({type:'Results',is_final:true,speech_final:true,channel:{alternatives:[{transcript:'What are your hours?'}]}});
    await tick();await tick();
    assert.ok(voice.tts);assert.equal(voice.tts.sent.length,0);
    assert.deepEqual(request.reasoning,{effort:'low'});assert.deepEqual(request.text,{verbosity:'low'});
    complete({output:[],output_text:'We open at nine.'});await voice.serial;
    assert.equal(JSON.parse(voice.tts.sent[0]).type,'Speak');
    voice.tts.message([1,2],true);
    assert.ok(events.some(e=>e.type==='session.latency'&&e.stage==='turn_to_audio'));
  }finally{voice.close();}
});

test('lookup acknowledgement happens once and tools run without waiting for its audio',async()=>{
  let count=0,executed=0;
  const {voice,asr}=await setup({responses:{create:async()=>{
    if(count++<2)return {output:[{type:'function_call',call_id:`lookup-${count}`,name:'get_summary',arguments:'{}'}]};
    return {output:[],output_text:'You had eight calls today.'};
  }}});
  voice.acknowledgeLookups=true;
  voice.on('event',e=>{if(e.type==='response.event'){executed++;voice.send({type:'response.item.create',item:{type:'function_call_output',call_id:e.event.item.call_id,output:'{"status":"OK"}'}});}});
  try{
    asr.message({type:'Results',is_final:true,speech_final:true,channel:{alternatives:[{transcript:'Summarize my calls'}]}});
    await tick();await tick();
    assert.equal(executed,2,'lookups are not blocked behind the acknowledgement');
    const ack=voice.tts;assert.equal(JSON.parse(ack.sent[0]).text,'Let me check that for you.');
    ack.message({type:'Flushed'});await voice.serial;
    assert.notEqual(voice.tts,ack);assert.equal(JSON.parse(voice.tts.sent[0]).text,'You had eight calls today.');
    assert.equal(ack.sent.filter(s=>JSON.parse(s).type==='Speak').length,1);
  }finally{voice.close();}
});
