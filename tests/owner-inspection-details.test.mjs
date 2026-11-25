import assert from 'node:assert/strict';
import test from 'node:test';
import {ownerInspectionDetailsTool} from '../src/agents/trade/trade-owner-inspection-details.mjs';
const config={mode:'trade',url:'https://trade.example/api/ai/mcp',token:'fixture',businessId:'business-a',did:'0359111403'};
const outbound={purpose:'owner_notification',number:'0412345678',attemptId:'a'.repeat(64),ownerNotification:{requestCode:'INS-REQ TEST123'}};
test('inspection tool uses only the bridge-held call identity, never model selectors',async()=>{
  let calls=0;
  const session=ownerInspectionDetailsTool(config,outbound,async(url,init)=>{
    calls++;assert.equal(url.pathname,'/api/ai/callbacks/owner-inspection');
    assert.deepEqual(JSON.parse(init.body),{attemptId:outbound.attemptId});
    assert.equal(init.headers['X-BMSPro-Caller-Number'],outbound.number);
    assert.equal(init.headers['X-BMSPro-Trade-Business'],config.businessId);
    return Response.json({status:'OK',inspection:{requestCode:'INS-REQ TEST123',service:'Fixture inspection'}});
  });
  assert.equal((await session.call('get_notified_inspection',{})).status,'OK');
  for (const args of [{requestId:'other'}, {number:'0412345679'},null,[]]) assert.equal((await session.call('get_notified_inspection',args)).status,'UNAVAILABLE');
  assert.equal((await session.call('list_invoices',{})).status,'UNAVAILABLE');
  assert.equal(calls,1);
  assert.equal(ownerInspectionDetailsTool(config,{...outbound,purpose:'missed_call'}),undefined);
});
test('lookup errors and mismatched inspection references never disclose details',async()=>{
  for (const fetcher of [async()=>{throw Error('offline')},async()=>new Response('',{status:403}),async()=>Response.json({status:'OK',inspection:{requestCode:'another'}})]) {
    const result=await ownerInspectionDetailsTool(config,outbound,fetcher).call('get_notified_inspection',{});
    assert.equal(result.status,'UNAVAILABLE');assert.equal(result.inspection,undefined);
  }
});
