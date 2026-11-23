import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {createSophieCallback} from '../src/agents/trade/trade-sophie-callback.mjs';
import {ownerRequestedCallInstructions} from '../src/agents/trade/trade-owner-requested-call.mjs';
import {createCallRecord} from '../src/observability/call-record.mjs';

test('owner-requested calls carry the purpose through a one-time media token and dedupe the dial',async(t)=>{
 const secret='fixture-bridge-secret-for-owner-calls-12345678';let dials=0,token;
 const service=createSophieCallback({env:{BMSPRO_CALLBACK_ENABLED:'true',BMSPRO_CALLBACK_AMI_USER:'fixture',BMSPRO_CALLBACK_AMI_SECRET:'fixture'},bridgeSecret:secret,resolveRoute:async()=>({mode:'trade',businessId:'business-a',callback:{callerId:'0359111403',dialPrefix:''}}),hasCapacity:()=>true,dial:async input=>{dials++;token=input.token;return 'ANSWERED'}});
 const server=createServer((req,res)=>void service.handle(req,res,'owner_requested'));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const input={id:'a'.repeat(64),did:'0359111403',businessId:'business-a',number:'0412345678',customerName:'John Smith',ownerRequest:{category:'complaint',instructions:'Ask whether the repair resolved the issue.'}};
 const post=(body,authorization=secret)=>fetch(`http://127.0.0.1:${server.address().port}`,{method:'POST',headers:{Authorization:`Bearer ${authorization}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post(input,'wrong')).status,401);
 assert.equal((await post({...input,ownerRequest:{category:'invalid',instructions:'x'.repeat(20)}})).status,400);
 assert.equal((await post({...input,ownerRequest:{category:'invoice',instructions:'x'.repeat(1001)}})).status,400);assert.equal(dials,0);
 assert.equal((await post(input)).status,200);assert.equal((await post(input)).status,200);assert.equal(dials,1);
 const context=service.take(token);assert.equal(context.purpose,'owner_requested');assert.deepEqual(context.ownerRequest,input.ownerRequest);assert.equal(service.take(token),undefined);
 const prompt=ownerRequestedCallInstructions(context,'Fixture Business');
 assert.match(prompt,/Ask whether the repair resolved/);assert.match(prompt,/Before they confirm identity/);assert.match(prompt,/unverified business context/);assert.match(prompt,/not verified payment/);
 const record=createCallRecord({callId:'0a41e31d-0620-47d1-9ef9-c9c60cef73a8'});record.callback(input.id,true);
 assert.equal(record.build().ownerScheduledCall,true);assert.equal(record.build().callbackAttemptId,input.id);
 assert.ok(!JSON.stringify(record.build()).includes(input.ownerRequest.instructions));
});
