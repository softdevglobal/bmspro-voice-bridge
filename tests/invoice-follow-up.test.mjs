import assert from 'node:assert/strict';
import test from 'node:test';
import {createInvoiceFollowUpSession,invoiceFollowUpInstructions} from '../src/agents/trade/trade-invoice-follow-up.mjs';
const config={mode:'trade',url:'https://trade.example.test/api/ai/mcp',token:'test',businessId:'biz',did:'0359111403'};
const outbound={purpose:'overdue_invoice',attemptId:'a'.repeat(64),customerName:'Sam',number:'0412345678'};
test('invoice tools pin tenant, invoice attempt and number; confirmation and details must precede response',async()=>{
 const calls=[];
 const session=createInvoiceFollowUpSession(config,outbound,async(url,options)=>{
  const body=JSON.parse(options.body);calls.push(body);
  assert.equal(new URL(url).pathname,'/api/ai/callbacks/invoice');assert.equal(options.headers['X-BMSPro-Caller-Number'],outbound.number);assert.equal(options.headers['X-BMSPro-Trade-Business'],'biz');assert.equal(body.attemptId,outbound.attemptId);
  return Response.json(body.operation==='details'?{status:'OK',invoice:{reference:'INV-1'}}:{status:'RECORDED',paused:true});
 });
 const response={customerConfirmed:true,responseConfirmed:true,outcome:'reported_paid'};
 assert.equal((await session.call('record_invoice_response',response)).status,'REJECTED');
 assert.equal((await session.call('get_follow_up_invoice',{customerConfirmed:false})).status,'REJECTED');
 assert.equal((await session.call('get_follow_up_invoice',{customerConfirmed:true,invoiceId:'another'})).status,'REJECTED');
 assert.equal(calls.length,0);
 assert.equal((await session.call('get_follow_up_invoice',{customerConfirmed:true})).status,'OK');
 assert.equal((await session.call('record_invoice_response',response)).status,'RECORDED');
 assert.deepEqual(calls[1].response,{outcome:'reported_paid'});
 assert.equal((await session.call('record_invoice_response',response)).status,'REJECTED');
});
test('a settled or paused invoice stops the conversation without enabling response writes',async()=>{
 const session=createInvoiceFollowUpSession(config,outbound,async()=>Response.json({status:'STOP'}));
 assert.equal((await session.call('get_follow_up_invoice',{customerConfirmed:true})).status,'STOP');
 assert.equal((await session.call('record_invoice_response',{customerConfirmed:true,responseConfirmed:true,outcome:'disputed'})).status,'REJECTED');
});
test('failed responses never claim payment or a pause, and instructions forbid negotiation',async()=>{
 const session=createInvoiceFollowUpSession(config,outbound,async()=>{throw Error('offline');});
 assert.equal((await session.call('get_follow_up_invoice',{customerConfirmed:true})).status,'UNAVAILABLE');
 assert.equal(createInvoiceFollowUpSession(config,{...outbound,purpose:'missed_call'}),undefined);
 const instructions=invoiceFollowUpInstructions(outbound,'Fixture business');
 assert.match(instructions,/wrong person/);assert.match(instructions,/Never negotiate/);assert.match(instructions,/payment remains unverified/);
});

test('a wrong-person report needs explicit confirmation but never fetches invoice details',async()=>{
 const calls=[];
 const session=createInvoiceFollowUpSession(config,outbound,async(_url,options)=>{calls.push(JSON.parse(options.body));return Response.json({status:'RECORDED',paused:true});});
 assert.equal((await session.call('flag_invoice_wrong_contact',{wrongPersonConfirmed:false})).status,'REJECTED');
 assert.equal((await session.call('flag_invoice_wrong_contact',{wrongPersonConfirmed:true,invoiceId:'other'})).status,'REJECTED');
 assert.equal((await session.call('flag_invoice_wrong_contact',{wrongPersonConfirmed:true})).status,'RECORDED');
 assert.deepEqual(calls,[{attemptId:outbound.attemptId,operation:'wrong_contact',wrongPersonConfirmed:true}]);
 assert.equal((await session.call('get_follow_up_invoice',{customerConfirmed:true})).status,'REJECTED');
});
