import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {createOwnerVoiceHandler} from '../src/agents/trade/trade-owner-voice.mjs';

test('owner voice setup requires the Trade bridge secret and uses the bridge OpenAI key', async (t) => {
  const secret = 'trade-bridge-test-secret-0000000000000000';
  const apiKey = 'fixture-bridge-openai-key';
  const toolNames = ['get_daily_summary', 'list_jobs_awaiting_scheduling', 'get_staff_working_today'];
  const upstream = t.mock.fn(async (url, request) => {
    assert.equal(url, 'https://api.openai.com/v1/realtime/calls');
    assert.equal(request.headers.Authorization, `Bearer ${apiKey}`);
    assert.equal(request.body.get('sdp'), 'v=0\r\no=fixture');
    const session = JSON.parse(request.body.get('session'));
    assert.equal(session.model, 'fixture-realtime-model');
    assert.deepEqual(session.tools.map(tool => tool.name), toolNames);
    return new Response('v=0\r\no=answer');
  });
  const server = createServer(createOwnerVoiceHandler({secret, apiKey, model: 'fixture-realtime-model', fetcher: upstream}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/owner-voice/session`;
  const payload = {
    sdp: 'v=0\r\no=fixture',
    safetyIdentifier: 'a'.repeat(64),
    session: {instructions: 'Give the owner a briefing.', tools: toolNames.map(name => ({type: 'function', name}))},
  };
  const post = (token, body = payload) => fetch(url, {
    method: 'POST', body: JSON.stringify(body),
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
  });
  assert.equal((await post('wrong')).status, 401);
  assert.equal((await post(secret, {...payload, sdp: 'invalid'})).status, 400);
  assert.equal((await post(secret, {...payload, sdp: 'v=0\r\n' + 'x'.repeat(100_000)})).status, 413);
  assert.equal(upstream.mock.callCount(), 0);
  const response = await post(secret);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/sdp');
  assert.equal(await response.text(), 'v=0\r\no=answer');
  assert.equal(upstream.mock.callCount(), 1);
});

test('owner voice accepts any known read-only tools, but not unknown or repeated ones', async (t) => {
  const secret = 'trade-bridge-test-secret-0000000000000000';
  const upstream = t.mock.fn(async () => new Response('v=0\r\no=answer'));
  const server = createServer(createOwnerVoiceHandler({secret, apiKey: 'key', fetcher: upstream}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/owner-voice/session`;
  const start = names => fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${secret}`},
    body: JSON.stringify({
      sdp: 'v=0\r\no=fixture', safetyIdentifier: 'b'.repeat(64),
      session: {instructions: 'Owner briefing.', tools: names.map(name => ({type: 'function', name}))},
    }),
  });

  // Current and older Trade tool sets both work.
  assert.equal((await start(['get_daily_summary', 'get_day_activity', 'get_staff_day_report',
    'list_missed_calls', 'list_overdue_invoices', 'list_invoices', 'list_jobs_awaiting_scheduling', 'get_staff_working_today',
    'lookup_customer_jobs', 'suggest_scheduling', 'list_quote_follow_ups', 'get_sophie_call_summaries', 'get_customer_call_history'])).status, 200);
  assert.equal((await start(['get_daily_summary', 'list_jobs_awaiting_scheduling',
    'get_staff_working_today'])).status, 200);
  // Trade with owner knowledge enabled adds the knowledge search.
  assert.equal((await start(['get_daily_summary', 'get_day_activity', 'get_staff_day_report',
    'list_jobs_awaiting_scheduling', 'get_staff_working_today', 'search_business_knowledge'])).status, 200);
  // Trade with voice knowledge drafts enabled adds the three browser-side draft tools.
  assert.equal((await start(['get_daily_summary', 'get_day_activity', 'get_staff_day_report',
    'list_jobs_awaiting_scheduling', 'get_staff_working_today', 'search_business_knowledge',
    'prepare_knowledge_draft', 'save_knowledge_draft', 'discard_knowledge_draft'])).status, 200);
  // Trade with voice services enabled adds the two owner MCP service tools.
  assert.equal((await start(['get_daily_summary', 'get_day_activity', 'get_staff_day_report',
    'list_jobs_awaiting_scheduling', 'get_staff_working_today', 'prepare_service', 'create_service'])).status, 200);
  // Trade with voice customers enabled adds the four browser-side customer tools.
  assert.equal((await start(['get_daily_summary', 'list_customers', 'open_add_customer_form',
    'open_edit_customer_form', 'customer_form_step'])).status, 200);
  assert.equal(upstream.mock.callCount(), 6);

  assert.equal((await start(['get_daily_summary', 'create_job'])).status, 400, 'unknown tool');
  assert.equal((await start(['get_daily_summary', 'search_knowledge'])).status, 400, 'unknown knowledge tool name');
  assert.equal((await start(['get_daily_summary', 'publish_knowledge'])).status, 400, 'no publish tool');
  assert.equal((await start(['get_daily_summary', 'get_daily_summary'])).status, 400, 'repeated tool');
  assert.equal((await start([])).status, 400, 'no tools');
  assert.equal(upstream.mock.callCount(), 6);
});

// The server owns authorization, pending changes and confirmation; the bridge only allows known names.
test('owner visit preparation and confirmation tools pass the bridge whitelist', async (t) => {
 const secret = 'trade-bridge-test-secret-0000000000000000';
 const upstream = t.mock.fn(async () => new Response('v=0\r\no=answer'));
 const server = createServer(createOwnerVoiceHandler({secret, apiKey:'fixture-key', fetcher:upstream}));
 await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
 t.after(() => new Promise(resolve => server.close(resolve)));
 const response = await fetch(`http://127.0.0.1:${server.address().port}/owner-voice/session`,{
  method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},
  body:JSON.stringify({sdp:'v=0\r\no=fixture',safetyIdentifier:'c'.repeat(64),session:{instructions:'Owner visit management.',tools:[
   'find_call_customers','prepare_customer_scheduled_call','get_work_visits','prepare_job_create','prepare_inspection_create','get_services','get_staff','prepare_job_schedule','prepare_job_assignment','prepare_job_cancel',
   'prepare_inspection_schedule','prepare_inspection_assignment','prepare_inspection_cancel','confirm_owner_change','cancel_owner_change',
  ].map(name=>({type:'function',name}))}}),
 });
 assert.equal(response.status,200);assert.equal(upstream.mock.callCount(),1);
});

test('bridge accepts the Sophie email assistant tools',async(t)=>{
 const secret='trade-bridge-test-secret-0000000000000000';
 const upstream=t.mock.fn(async()=>new Response('v=0\r\no=answer'));
 const server=createServer(createOwnerVoiceHandler({secret,apiKey:'fixture-key',fetcher:upstream}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const start=(names)=>fetch(`http://127.0.0.1:${server.address().port}/owner-voice/session`,{
  method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},
  body:JSON.stringify({sdp:'v=0\r\no=fixture',safetyIdentifier:'d'.repeat(64),session:{instructions:'Owner email assistant.',tools:names.map(name=>({type:'function',name}))}}),
 });
 const names=['get_email_summary','get_email_questions','answer_email_question','get_email_rules','set_email_rule_level','pause_email_automation','get_open_complaints','prepare_return_visit_policy','confirm_owner_change','cancel_owner_change'];
 assert.equal((await start(names)).status,200);
 assert.equal(upstream.mock.callCount(),1);
 assert.equal((await start([...names,'approve_email_rule'])).status,400,'there is no voice tool that approves a rule');
 assert.equal(upstream.mock.callCount(),1);
});

test('bridge exposes fixed validation codes and rejects invalid setup before contacting OpenAI',async(t)=>{
 const secret='trade-bridge-test-secret-0000000000000000';
 const upstream=t.mock.fn(async()=>new Response(null,{status:403}));
 const server=createServer(createOwnerVoiceHandler({secret,apiKey:'fixture-key',fetcher:upstream}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const start=(instructions,names,token=secret)=>fetch(`http://127.0.0.1:${server.address().port}/owner-voice/session`,{
  method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
  body:JSON.stringify({sdp:'v=0\r\no=fixture',safetyIdentifier:'d'.repeat(64),session:{instructions,tools:names.map(name=>({type:'function',name}))}}),
 });
 let response=await start('Fixture.',['unknown_tool']);assert.equal(response.status,400);assert.equal(response.headers.get('x-bms-voice-error'),'tool_whitelist');
 response=await start('x'.repeat(4001),['get_daily_summary']);assert.equal(response.status,400);assert.equal(response.headers.get('x-bms-voice-error'),'instructions_limit');
 response=await start('Fixture.',['get_daily_summary'],'wrong');assert.equal(response.status,401);assert.equal(response.headers.get('x-bms-voice-error'),'bridge_authorization');
 assert.equal(upstream.mock.callCount(),0);
 t.mock.method(console,'error',()=>undefined);
 response=await start('Fixture.',['get_daily_summary']);assert.equal(response.status,502);assert.equal(response.headers.get('x-bms-voice-error'),'realtime_rejected');assert.equal(upstream.mock.callCount(),1);
});
