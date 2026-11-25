import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter,once} from 'node:events';
import {WebSocket} from 'ws';
import {createOwnerDeepgram} from '../src/agents/trade/trade-owner-deepgram.mjs';
const secret='owner-gateway-secret-fixture-123456789012345';
class Voice extends EventEmitter {
  static instances=[];
  constructor(){super();Voice.instances.push(this);this.socket=new EventEmitter();this.pending=new Map();this.input=[];this.epoch=0;queueMicrotask(()=>this.socket.emit('open'));}
  send(e){if(e.type==='session.start')this.emit('event',{type:'session.started'});this.last=e;}
  enqueue(text){this.question=text;}
  async speak(text){this.spoken=text;}
  close(){this.closed=true;this.emit("closed");}
}
async function setup(t){
  const gateway=createOwnerDeepgram({secret,key:'secret-not-sent',client:{},Voice});
  const server=http.createServer(gateway.handle);server.on('upgrade',gateway.upgrade);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  t.after(()=>{gateway.close();server.close();server.closeAllConnections();});
  const mint=(patch={},auth=secret)=>fetch(origin,{method:'POST',headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},body:JSON.stringify({origin:'http://localhost:3002',safetyIdentifier:'a'.repeat(64),session:{instructions:'business-owner-scoped',tools:[{type:'function',name:'get_daily_summary'}]},...patch})});
  return {origin,mint};
}
test('owner ticket requires bridge auth, valid tools and expected browser origin',async t=>{
  const {mint}=await setup(t);
  assert.equal((await mint({},'wrong')).status,401);
  assert.equal((await mint({session:{instructions:'rules',tools:[{type:'function',name:'foreign_tool'}]}})).status,400);
  const response=await mint();assert.equal(response.status,200);const ticket=await response.json();assert.match(ticket.token,/^[a-f0-9]{64}$/);assert.equal(ticket.expiresIn,30);assert.equal(ticket.key,undefined);
});
test('audio tickets are single-use and browser tools return through the existing continuation',async t=>{
  const {origin,mint}=await setup(t);const ticket=await(await mint()).json();
  const ws=new WebSocket(origin.replace('http:','ws:'),['bms-owner-audio-v2',ticket.token],{origin:'http://localhost:3002'});t.after(()=>ws.terminate());
  const ready=once(ws,'message');await once(ws,'open');assert.equal(JSON.parse((await ready)[0]).type,'owner.audio.ready');
  const voice=Voice.instances.at(-1);assert.equal(voice.last.session.delegation.responses.tools[0].strict,false);voice.pending.set('tool-a',{});
  ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'function_call_output',call_id:'tool-a',output:'{"status":"OK"}'}}));
  await new Promise(r=>setTimeout(r,10));assert.equal(voice.last.type,'response.item.create');
  const replay=new WebSocket(origin.replace('http:','ws:'),['bms-owner-audio-v2',ticket.token],{origin:'http://localhost:3002'});replay.on('error',()=>{});t.after(()=>replay.terminate());const [,res]=await once(replay,'unexpected-response');assert.equal(res.statusCode,403);res.resume();replay.terminate();
  const stopped=once(voice,'closed');ws.close();await stopped;assert.equal(voice.closed,true);
});
test('cross-origin audio upgrade is refused',async t=>{
  const {origin,mint}=await setup(t);const ticket=await(await mint()).json();
  const ws=new WebSocket(origin.replace('http:','ws:'),['bms-owner-audio-v2',ticket.token],{origin:'https://foreign.test'});ws.on('error',()=>{});t.after(()=>ws.terminate());
  const [,res]=await once(ws,'unexpected-response');assert.equal(res.statusCode,403);res.resume();ws.terminate();
});
