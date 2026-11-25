import {randomBytes} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {DeepgramVoice} from '../../audio/providers/deepgram.mjs';
import {validTools,authorized} from './trade-owner-voice.mjs';

// Authenticated, short-lived, single-use browser audio sessions. No business
// credentials or Deepgram keys reach the browser; tools still execute on Trade.
export function createOwnerDeepgram({secret,key,client,maxSessions=4,Voice=DeepgramVoice}){
  const tickets=new Map(),active=new Set();
  const wss=new WebSocketServer({noServer:true,maxPayload:65536,perMessageDeflate:false,handleProtocols:p=>p.has('bms-owner-audio-v2')?'bms-owner-audio-v2':false});
  const prune=()=>{for(const [token,t] of tickets)if(t.expires<=Date.now())tickets.delete(token);};
  async function handle(req,res){
    const fail=status=>{res.writeHead(status,{'Cache-Control':'no-store'});res.end();};
    if(req.method!=='POST')return fail(405);
    if(!authorized(req.headers.authorization,secret))return fail(401);
    if(req.headers['content-type']!=='application/json')return fail(415);
    const timer=setTimeout(()=>req.destroy(),10000);
    try{
      let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>98304)return fail(413);chunks.push(chunk);}
      const payload=JSON.parse(Buffer.concat(chunks).toString());
      const origin=new URL(payload.origin);
      if(origin.origin!==payload.origin||!['https:','http:'].includes(origin.protocol)||
        (origin.protocol==='http:'&&!['localhost','127.0.0.1'].includes(origin.hostname))||
        typeof payload.session?.instructions!=='string'||payload.session.instructions.length>4000||!validTools(payload.session.tools)||
        typeof payload.safetyIdentifier!=='string'||!/^[a-f0-9]{64}$/.test(payload.safetyIdentifier))return fail(400);
      prune();if(tickets.size>=32||active.size>=maxSessions)return fail(429);
      const token=randomBytes(32).toString('hex');
      tickets.set(token,{session:payload.session,origin:payload.origin,expires:Date.now()+30000});
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({token,expiresIn:30}));
    }catch{if(!res.headersSent)fail(400);}finally{clearTimeout(timer);}
  }
  function upgrade(req,socket,head){
    prune();const protocols=String(req.headers['sec-websocket-protocol']||'').split(',').map(s=>s.trim());
    const token=protocols.find(p=>/^[a-f0-9]{64}$/.test(p));const ticket=tickets.get(token);
    if(!ticket||req.headers.origin!==ticket.origin||!protocols.includes('bms-owner-audio-v2')||active.size>=maxSessions){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    tickets.delete(token);
    try{wss.handleUpgrade(req,socket,head,ws=>{active.add(ws);connect(ws,ticket.session);});}catch{socket.destroy();}
  }
  function connect(ws,session){
    const voice=new Voice(client,{key,acknowledgeLookups:true,encoding:'linear16',sampleRate:24000});let closed=false,started=false,turn=0;
    const send=e=>{if(ws.readyState===1){if(ws.bufferedAmount>256000)return close();ws.send(JSON.stringify(e));}};
    const timer=setTimeout(()=>close(),600000);
    const close=()=>{if(closed)return;closed=true;clearTimeout(timer);active.delete(ws);voice.close();ws.close();};
    const readyTimer=setTimeout(()=>close(),20000);
    ws.on('close',()=>{clearTimeout(readyTimer);close();});ws.on('error',close);
    voice.on('error',()=>{send({type:'error',code:'AUDIO_PIPELINE_UNAVAILABLE'});close();});
    voice.on('event',e=>{
      if(e.type==='session.latency')console.log('[owner-audio] timing',{stage:e.stage,durationMs:e.durationMs});
      if(e.type==='session.started'){started=true;clearTimeout(readyTimer);send({type:'owner.audio.ready',encoding:'linear16',sampleRate:24000});}
      if(e.type==='session.caller_speech.started'){turn++;send({type:'output_audio_buffer.cleared'});}
      if(e.type==='session.caller_turn.completed'){
        const item_id=`owner-${turn++}`;send({type:'input_audio_buffer.committed',item_id});
        send({type:'conversation.item.input_audio_transcription.completed',item_id,transcript:e.text});
      }
      if(e.type==='response.event'&&e.event?.item?.type==='function_call'){
        send({type:'response.done',response:{status:'completed',output:[e.event.item]}});
      }
      if(e.type==='session.output_transcript.delta'){const sophieId=`sophie-${Date.now()}`;send({type:'response.output_audio_transcript.done',item_id:sophieId,transcript:e.delta});}
      if(e.type==='session.output_audio.delta'&&ws.readyState===1){if(ws.bufferedAmount>256000)return close();ws.send(Buffer.from(e.delta,'base64'));}
      if(e.type==='session.synthesis.done')send({type:'owner.audio.synthesis_done'});
    });
    ws.on('message',(data,binary)=>{
      try{
        if(!started)return;
        if(binary){if(data.length>4096)throw new Error();voice.send({type:'session.input_audio.append',audio:data.toString('base64')});return;}
        const e=JSON.parse(data.toString());
        if(e.type==='conversation.item.create'&&e.item?.type==='function_call_output'){
          if(typeof e.item.output!=='string'||e.item.output.length>128000)throw new Error();
          if(!voice.pending.has(e.item.call_id))throw new Error();
          voice.send({type:'response.item.create',item:e.item});
        }else if(e.type==='conversation.item.create'&&e.item?.role==='user'){
          const question=e.item.content?.[0]?.text;if(typeof question!=='string'||question.length>8000)throw new Error();voice.greeted=true;voice.enqueue(question,voice.epoch);
        }else if(e.type==='response.create'&&!voice.greeted){voice.greeted=true;voice.greeting='Hey, it’s Sophie. What can I help you with today?';voice.input.push({role:'assistant',content:voice.greeting});void voice.speak(voice.greeting,voice.epoch).catch(()=>close());}
        // Browser transcription configuration and response.create continuations
        // are intentionally ignored: Deepgram/Luna own those server settings.
      }catch{close();}
    });
    voice.socket.once('open',()=>voice.send({type:'session.start',session:{instructions:session.instructions,input:[],delegation:{responses:{tools:session.tools.map(tool=>({...tool,strict:false})),instructions:session.instructions}}}}));
  }
  return {handle,upgrade,close(){for(const ws of active)ws.close();tickets.clear();}};
}
