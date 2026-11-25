import assert from 'node:assert/strict';
import test from 'node:test';
import {openOwnerPhoneBriefing} from '../src/agents/trade/trade-owner-phone-briefing.mjs';
import {ownerPhoneGreeting,ownerInspectionNotificationInstructions} from '../src/agents/trade/trade-owner-notification.mjs';
const config={mode:'trade',url:'https://trade.example/api/ai/mcp',token:'fixture',businessId:'business-a',did:'0359111403'};
const outbound={purpose:'owner_notification',number:'0412345678',customerName:'Niranga Lakshan',attemptId:'a'.repeat(64),ownerNotification:{requestCode:'INS-REQ TEST123'}};
test('owner greeting is personal and conversation stays open for business questions',()=>{
  assert.equal(ownerPhoneGreeting('Niranga Lakshan'),"Hi Niranga, it's Sophie. Is now a good time for a quick update?");
  assert.doesNotMatch(ownerPhoneGreeting('Niranga Lakshan'),/AI|receptionist|Electrical/);
  const prompt=ownerInspectionNotificationInstructions(outbound,'Nira Electrical');
  assert.match(prompt,/Do not end the call just because/);assert.match(prompt,/invoices/);assert.match(prompt,/read only/);
});
test('owner calls obtain read tools pinned to the call; writes and callback follow-ups are rejected',async()=>{
  const bodies=[];
  const session=await openOwnerPhoneBriefing(config,outbound,async(url,init)=>{
    assert.equal(url.pathname,'/api/ai/callbacks/owner-briefing');
    assert.equal(init.headers['X-BMSPro-Caller-Number'],outbound.number);
    const body=JSON.parse(init.body);bodies.push(body);assert.equal(body.attemptId,outbound.attemptId);
    return Response.json(body.tool?{status:'OK',result:{status:'OK',invoices:[]}}:{status:'OK',tools:[
      {type:'function',name:'list_invoices',description:'Read invoices',parameters:{type:'object'}},
      {type:'function',name:'send_sms',description:'Forbidden',parameters:{type:'object'}},
    ]});
  });
  assert.deepEqual(session.tools.map(tool=>tool.name),['list_invoices']);
  assert.equal((await session.call('list_invoices',{})).status,'OK');
  assert.equal((await session.call('send_sms',{})).status,'REJECTED');
  assert.equal((await session.call('list_invoices',{followUp:true})).status,'REJECTED');
  assert.equal(bodies.length,2);
});
test('customer calls and failed lookups cannot obtain owner briefing data',async()=>{
  let calls=0;
  const customer=await openOwnerPhoneBriefing(config,{...outbound,purpose:'missed_call'},async()=>{calls++;});
  assert.deepEqual(customer.tools,[]);assert.equal(calls,0);
  const failed=await openOwnerPhoneBriefing(config,outbound,async()=>{throw Error('offline')});
  assert.deepEqual(failed.tools,[]);
});
