import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {createSophieCallback} from '../src/agents/trade/trade-sophie-callback.mjs';
import {createQuotationFollowUpSession,quotationFollowUpInstructions} from '../src/agents/trade/trade-quotation-follow-up.mjs';
import {createCallRecord} from '../src/observability/call-record.mjs';
const config={mode:'trade',url:'https://trade.example/api/ai/mcp',token:'fixture',businessId:'business-a',did:'0359111403'};
const outbound={purpose:'quotation_followup',number:'0412345678',customerName:'Customer Fixture',attemptId:'a'.repeat(64),quotationFollowUp:{quotationCode:'QT TEST123'}};
test('quote decisions require recipient confirmation, a verified read and explicit decision confirmation',async()=>{
 const calls=[];
 const session=createQuotationFollowUpSession(config,outbound,async(url,init)=>{
  assert.equal(url.pathname,'/api/ai/callbacks/quotation');assert.equal(init.headers['X-BMSPro-Trade-Business'],'business-a');assert.equal(init.headers['X-BMSPro-Caller-Number'],outbound.number);
  const body=JSON.parse(init.body);calls.push(body);assert.equal(body.attemptId,outbound.attemptId);
  return Response.json(body.operation==='details'?{status:'OK',quotation:{reference:'QT TEST123',totalAud:110}}:{status:'RECORDED',decision:body.decision});
 });
 const accept={customerConfirmed:true,decisionConfirmed:true,decision:'accepted'};
 assert.equal((await session.call('record_quotation_decision',accept)).status,'REJECTED');
 assert.equal((await session.call('get_follow_up_quotation',{customerConfirmed:false})).status,'REJECTED');
 assert.equal((await session.call('get_follow_up_quotation',{customerConfirmed:true,quotationId:'other'})).status,'REJECTED');assert.equal(calls.length,0);
 assert.equal((await session.call('get_follow_up_quotation',{customerConfirmed:true})).status,'OK');
 assert.equal((await session.call('record_quotation_decision',{...accept,decisionConfirmed:false})).status,'REJECTED');
 assert.equal((await session.call('record_quotation_decision',accept)).status,'RECORDED');assert.equal((await session.call('record_quotation_decision',{...accept,decision:'rejected'})).status,'REJECTED');assert.equal(calls.length,2);
 assert.equal(createQuotationFollowUpSession(config,{...outbound,purpose:'owner_notification'}),undefined);
 const prompt=quotationFollowUpInstructions(outbound,'Fixture Business');assert.match(prompt,/conditional acceptance is not a decision/);assert.match(prompt,/read back the exact quotation reference/);assert.match(prompt,/on voicemail/i);assert.match(prompt,/Never begin by reciting a quotation number/);assert.match(prompt,/one short question at a time/);assert.match(prompt,/two or three short sentences per turn/);assert.match(prompt,/Do not claim they already had a job done/);
});
test('mismatched or unavailable quote details cannot unlock acceptance',async()=>{
 const session=createQuotationFollowUpSession(config,outbound,async()=>Response.json({status:'OK',quotation:{reference:'OTHER'}}));
 assert.equal((await session.call('get_follow_up_quotation',{customerConfirmed:true})).status,'UNAVAILABLE');
 assert.equal((await session.call('record_quotation_decision',{customerConfirmed:true,decisionConfirmed:true,decision:'accepted'})).status,'REJECTED');
});
test('quotation outbound endpoint retains one-time call identity and deduplicates dialing',async t=>{
 const secret='quotation-followup-fixture-secret-123456789';let dials=0,token;
 const service=createSophieCallback({env:{BMSPRO_CALLBACK_ENABLED:'true',BMSPRO_CALLBACK_AMI_USER:'fixture',BMSPRO_CALLBACK_AMI_SECRET:'fixture'},bridgeSecret:secret,resolveRoute:async()=>({...config,callback:{callerId:'0359111403',dialPrefix:''}}),hasCapacity:()=>true,dial:async input=>{dials++;token=input.token;return 'ANSWERED'}});
 const server=createServer((req,res)=>void service.handle(req,res,'quotation_followup'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const input={id:outbound.attemptId,did:config.did,businessId:config.businessId,number:outbound.number,customerName:outbound.customerName,quotationFollowUp:outbound.quotationFollowUp};
 const post=(body,auth=secret)=>fetch(`http://127.0.0.1:${server.address().port}`,{method:'POST',headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post(input,'wrong')).status,401);assert.equal((await post({...input,quotationFollowUp:{quotationCode:'bad\nquote'}})).status,400);
 assert.equal((await post(input)).status,200);assert.equal((await post(input)).status,200);assert.equal(dials,1);
 const media=service.take(token);assert.equal(media.purpose,'quotation_followup');assert.deepEqual(media.quotationFollowUp,outbound.quotationFollowUp);assert.equal(service.take(token),undefined);
 const log=createCallRecord({callId:'fixture'});log.callback(outbound.attemptId,false,true);assert.equal(log.build().quotationFollowUpCall,true);assert.equal(log.build().ownerScheduledCall,undefined);
 log.tool('record_quotation_decision',{status:'RECORDED',decision:'accepted',quotationId:'quote-a'},10);assert.deepEqual(log.build().outcomes,[{tool:'record_quotation_decision',status:'ACCEPTED',reference:'quote-a'}]);
});
