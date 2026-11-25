import assert from 'node:assert/strict';
import test from 'node:test';
import {phoneAccessInstructions,recognizePhoneCaller,OWNER_INBOUND_GREETING,isOwnerCandidate} from '../src/agents/trade/trade-caller-access.mjs';
import {createTradeActionPolicy} from '../src/agents/trade/trade-action-policy.mjs';

test('phone matches never authorize private owner access', () => {
  for (const access of [undefined, {role:'customer'}, {role:'owner_candidate',ownerAccess:false}, {role:'owner_candidate',ownerAccess:true}]) {
    const instructions=phoneAccessInstructions(access);
    assert.match(instructions,/Never disclose internal summaries/);
    assert.match(instructions,/Never execute owner management actions/);
    assert.match(instructions,/signed-in Trade account/);
  }
});
test('inbound recognition pins tenant and caller metadata and grants no owner access', async () => {
  const config={mode:'trade',url:'https://trade.example/api/ai/mcp',token:'offline-secret',businessId:'business-a',did:'0359111403'};
  const access=await recognizePhoneCaller(config,'0412345678',async(url,init)=>{
    assert.equal(url.pathname,'/api/ai/voice/caller-access');
    assert.equal(init.headers['X-BMSPro-Trade-Business'],'business-a');
    assert.equal(init.headers['X-BMSPro-Caller-Number'],'0412345678');
    assert.equal(init.redirect,'error');
    return Response.json({role:'owner_candidate',ownerAccess:false,ownerName:'must not retain'});
  });
  assert.deepEqual(access,{role:'owner_candidate',ownerAccess:false,verificationRequired:true});
  assert.equal(isOwnerCandidate(access),true);
  assert.match(OWNER_INBOUND_GREETING,/Good to hear from you/);
  assert.doesNotMatch(OWNER_INBOUND_GREETING,/receptionist|inspection|book/i);
});
test('recognition failures and unexpected authorization claims keep the customer greeting', async()=>{
  const config={mode:'trade',url:'https://trade.example/api/ai/mcp',token:'offline-secret',businessId:'business-a',did:'0359111403'};
  for (const fetcher of [async()=>Response.json({role:'customer',ownerAccess:false}),async()=>Response.json({role:'owner_candidate',ownerAccess:true}),async()=>new Response('',{status:503}),async()=>{throw Error('timeout')}])
    assert.equal(await recognizePhoneCaller(config,'0412345678',fetcher),undefined);
  let calls=0;const fetcher=async()=>{calls++;throw Error('must not call')};
  await recognizePhoneCaller(config,null,fetcher);
  await recognizePhoneCaller({...config,url:'https://backend.example/api/bms-blue/ai/mcp/'},'0412345678',fetcher);
  assert.equal(calls,0);
});
test('recognition is not a model-selectable owner tool', () => {
  assert.match(phoneAccessInstructions({role:'owner_candidate',ownerAccess:false}), /not verified identity/);
});
test('customer policy rejects owner tools even if a remote inventory advertises them', async () => {
  const forbidden=['get_day_activity','list_invoices','get_phone_caller_access','create_owner_job'];
  let calls=0;
  const policy=createTradeActionPolicy(new Map(['get_business_profile','list_services',...forbidden].map(name=>[name,{}])),async()=>{calls++;return {};});
  for (const name of forbidden) {
    assert.equal(policy.names.includes(name),false);
    assert.equal((await policy.call(name,{role:'owner'})).status,'REJECTED');
  }
  assert.equal(calls,0);
});
