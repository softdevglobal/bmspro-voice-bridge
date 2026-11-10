import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema, CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {loadTenantRoutes, resolveConfigForDid} from '../src/routing/tenant-routing.mjs';
import {openTradeSession, TRADE_READ_TOOLS} from '../src/agents/trade/trade-tools.mjs';

const secret = 'test-bridge-secret-for-trade-0000000000000';
test('legacy routing remains available when direct Trade is not configured', async () => {
  const routes = loadTenantRoutes({BMSPRO_BRIDGE_SECRET: secret});
  for (const brand of ['black', 'trade', 'pink']) {
    const config = await resolveConfigForDid('0359111403', routes, async () => new Response(JSON.stringify({brand, did: '0359111403'})));
    assert.equal(config.mode, brand === 'black' ? 'receptionist' : brand);
  }
});

async function fixture({extraTools = false, invalidProfile = false, actions = false, jobs = false} = {}) {
  const calls = [], bindings = [];
  let businessId = 'business-a';
  const names = [...TRADE_READ_TOOLS, ...(actions ? ['find_customer', 'get_available_slots', 'register_customer', 'create_inspection_request'] : extraTools ? ['get_available_slots', 'create_inspection_request'] : []),
    ...(jobs ? ['find_job', 'create_job_booking', 'reschedule_job', 'cancel_job'] : [])];
  const schema = name => ['reschedule_job', 'cancel_job'].includes(name)
    ? {type: 'object', properties: {requestKey: {type: 'string'}, jobCode: {type: 'string'}, email: {type: 'string'}, phone: {type: 'string'}}, required: ['requestKey', 'jobCode', 'email', 'phone']}
    : {type: 'object', properties: {requestKey: {type: 'string'}}, required: ['requestKey']};
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.equal(req.headers['x-bmspro-did'], '0359111403');
    const binding = req.headers['x-bmspro-trade-business'];
    if (binding) bindings.push(binding);
    if (binding && binding !== businessId) { res.writeHead(403, {'Content-Type': 'application/json'}); res.end('{}'); return; }
    const mcp = new Server({name: 'offline-trade', version: '1.0.0'}, {capabilities: {tools: {}}});
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({tools: names.map(name => ({name, inputSchema: schema(name)}))}));
    mcp.setRequestHandler(CallToolRequestSchema, async request => {
      const {name, arguments: args} = request.params;
      calls.push({name, args});
      let value;
      if (name === 'get_business_profile') value = {brand: invalidProfile ? 'black' : 'trade', did: '0359111403', businessId, businessName: 'Trade A', timezone: 'Australia/Melbourne'};
      else if (name === 'list_services') value = [{id: 'service-a', name: 'Inspection'}];
      else if (actions && name === 'find_customer') value = {status: 'NOT_FOUND', message: 'No match'};
      else if (actions && name === 'get_available_slots') value = {brand: 'trade', ...args, unavailable: []};
      else if (actions && name === 'register_customer') value = {status: 'CREATED', customerId: 'customer-a'};
      else if (actions && name === 'create_inspection_request') value = {status: 'PENDING_REVIEW', requestId: 'request-a'};
      else if (jobs && name === 'find_job') value = {status: 'MATCHED', jobCode: 'BK 4K7H2M9PQ', job: {canChange: true}};
      else if (jobs && name === 'cancel_job') value = {status: 'CANCELLED', jobCode: 'BK 4K7H2M9PQ'};
      else if (jobs && name === 'create_job_booking') value = {status: 'PENDING_REVIEW', requestId: 'request-job'};
      else throw new Error('Unsupported tools must never be called.');
      return {content: [{type: 'text', text: JSON.stringify(value)}]};
    });
    const transport = new StreamableHTTPServerTransport({enableJsonResponse: true});
    res.once('close', () => { void transport.close(); void mcp.close(); });
    const body = []; for await (const chunk of req) body.push(chunk);
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body.length ? JSON.parse(Buffer.concat(body).toString()) : undefined);
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  return {config: {mode: 'trade', did: '0359111403', token: secret, url: `http://127.0.0.1:${server.address().port}/mcp`}, calls, bindings,
    remap: () => { businessId = 'business-b'; }, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))};
}

test('Trade blocks writes when a server lacks the required customer lookup contract', async () => {
  const f = await fixture({extraTools: true}); let session;
  try {
    session = await openTradeSession(f.config);
    assert.deepEqual(session.tools.map(tool => tool.name), ['get_business_profile', 'list_services', 'get_available_slots']);
    assert.deepEqual(await session.call('list_services', {}), [{id: 'service-a', name: 'Inspection'}]);
    for (const name of ['get_available_slots', 'create_inspection_request', 'create_booking', 'send_sms']) assert.equal((await session.call(name, {})).status, 'REJECTED');
    assert.equal((await session.call('get_business_profile', {businessId: 'business-b'})).status, 'REJECTED');
    assert.ok(f.calls.every(call => TRADE_READ_TOOLS.includes(call.name)));
    assert.ok(f.bindings.every(binding => binding === 'business-a'));
  } finally { await session?.close(); await f.close(); }
});

test('real MCP session calls customer and booking tools with hidden retry keys and pinned business', async () => {
  const f = await fixture({actions: true}); let session;
  try {
    session = await openTradeSession(f.config);
    assert.equal(session.tools.length, 7);
    for (const tool of session.tools.filter(tool => ['register_customer', 'create_inspection_request'].includes(tool.name))) {
      assert.equal(tool.parameters.properties.requestKey, undefined);
      assert.equal(tool.parameters.required.includes('requestKey'), false);
    }
    const customer = {fullName: 'Test Customer', email: 'test@example.test', phone: '0412345678'};
    await session.call('find_customer', {email: customer.email, phone: customer.phone});
    const account = await session.call('register_customer', {customerConfirmed: true, customer});
    assert.equal(account.status, 'CREATED');
    await session.call('list_services', {});
    await session.call('get_available_slots', {from: '2099-11-05', to: '2099-11-05'});
    const args = {customerConfirmed: true, customer, customerId: account.customerId, serviceId: 'service-a',
      address: {street: '1 Test Street', suburb: 'Lynbrook', state: 'VIC', postcode: '3975'}, preferredSlots: [{date: '2099-11-05', timeRange: 'morning'}]};
    const {customerConfirmed: _confirmation, ...details} = args;
    assert.equal((await session.call('prepare_inspection_request', details)).status, 'READY_FOR_CONFIRMATION');
    const submitTool = session.tools.find(tool => tool.name === 'create_inspection_request');
    assert.deepEqual(Object.keys(submitTool.parameters.properties), ['customerConfirmed']);
    assert.equal((await session.call('create_inspection_request', {customerConfirmed: true})).status, 'PENDING_REVIEW');
    assert.equal((await session.call('create_inspection_request', {customerConfirmed: true})).status, 'PENDING_REVIEW');
    const submissions = f.calls.filter(call => call.name === 'create_inspection_request');
    assert.equal(submissions.length, 1); assert.ok(submissions[0].args.requestKey);
    assert.ok(f.bindings.every(binding => binding === 'business-a'));
  } finally { await session?.close(); await f.close(); }
});

test('discovery business binding is applied before initialization and reassignment stops old calls', async () => {
  const f = await fixture(); let session;
  try {
    session = await openTradeSession({...f.config, businessId: 'business-a'});
    assert.ok(f.bindings.length >= 3);
    f.remap();
    assert.equal((await session.call('list_services', {})).status, 'UNAVAILABLE');
    assert.equal((await session.call('get_business_profile', {})).status, 'UNAVAILABLE');
    assert.equal(f.calls.length, 1);
  } finally { await session?.close(); await f.close(); }
});

test('Trade startup rejects a mismatched discovery business or Black profile', async () => {
  const f = await fixture();
  try { await assert.rejects(openTradeSession({...f.config, businessId: 'business-b'})); } finally { await f.close(); }
  const invalid = await fixture({invalidProfile: true});
  try { await assert.rejects(openTradeSession(invalid.config)); } finally { await invalid.close(); }
});

test('Trade uses the discovery profile without a second profile request and still rejects a remapped DID', async () => {
  const f = await fixture();
  let session;
  try {
    const routes = loadTenantRoutes({
      BMSPRO_BRIDGE_SECRET: 'test-command-center-secret-0000000000000',
      BMSPRO_TRADE_MCP_URL: f.config.url.replace(/\/mcp$/, '/api/ai/mcp'),
      BMSPRO_TRADE_BRIDGE_SECRET: secret,
      BMSPRO_ALLOW_HTTP_FOR_LOCAL_TEST: 'true',
    });
    const config = await resolveConfigForDid(f.config.did, routes, async () => Response.json({
      matched: true, brand: 'trade', did: f.config.did, businessId: 'business-a',
      profile: {businessName: 'Trade A', timezone: 'Australia/Melbourne'},
    }));
    session = await openTradeSession(config);
    assert.equal(session.config.businessName, 'Trade A');
    assert.equal(f.calls.length, 0);
    assert.ok(f.bindings.length > 0 && f.bindings.every(id => id === 'business-a'));
    f.remap();
    await assert.rejects(openTradeSession(config));
  } finally { await session?.close(); await f.close(); }
});

test('job tools reach the model without retry keys or job-change contacts, and cancel uses the verified lookup', async () => {
  const f = await fixture({actions: true, jobs: true}); let session;
  try {
    session = await openTradeSession(f.config);
    const tools = new Map(session.tools.map(tool => [tool.name, tool]));
    for (const name of ['find_job', 'create_job_booking', 'reschedule_job', 'cancel_job']) assert.ok(tools.has(name), name);
    assert.deepEqual(Object.keys(tools.get('cancel_job').parameters.properties), ['jobCode']);
    assert.deepEqual(tools.get('cancel_job').parameters.required, ['jobCode']);
    assert.match(session.voiceInstructions, /find_job/);
    const contact = {email: 'test@example.test', phone: '0412345678'};
    assert.equal((await session.call('find_job', {jobCode: 'BK4K7H2M9PQ', ...contact})).status, 'MATCHED');
    assert.equal((await session.call('cancel_job', {customerConfirmed: true, jobCode: 'BK 4K7H2M9PQ', reason: 'Moved house'})).status, 'CANCELLED');
    const sent = f.calls.find(call => call.name === 'cancel_job').args;
    assert.deepEqual({email: sent.email, phone: sent.phone, reason: sent.reason}, {...contact, reason: 'Moved house'});
    assert.ok(sent.requestKey);
  } finally { await session?.close(); await f.close(); }
});

test('job booking is prepared, read back and submitted with only the confirmation, and a pending result is kept', async () => {
  const f = await fixture({actions: true, jobs: true}); let session;
  try {
    session = await openTradeSession(f.config);
    const submit = session.tools.find(tool => tool.name === 'create_job_booking');
    assert.deepEqual(Object.keys(submit.parameters.properties), ['customerConfirmed']);
    assert.ok(session.tools.some(tool => tool.name === 'prepare_job_booking'));
    const customer = {fullName: 'Test Customer', email: 'test@example.test', phone: '0412345678'};
    const details = {serviceId: 'service-a', customerId: null, customer, address: {street: '1 Test Street', suburb: 'Lynbrook', state: 'VIC', postcode: '3975'},
      preferredSlots: [{date: '2099-11-05', timeRange: 'morning', startTime: '10:30'}]};
    assert.equal((await session.call('create_job_booking', {customerConfirmed: true})).status, 'PREPARATION_REQUIRED');
    await session.call('list_services', {});
    await session.call('get_available_slots', {from: '2099-11-05', to: '2099-11-05'});
    assert.equal((await session.call('prepare_job_booking', details)).status, 'READY_FOR_CONFIRMATION');
    assert.equal((await session.call('create_job_booking', {customerConfirmed: true})).status, 'PENDING_REVIEW');
    assert.equal((await session.call('create_job_booking', {customerConfirmed: true})).status, 'PENDING_REVIEW');
    const sent = f.calls.filter(call => call.name === 'create_job_booking');
    assert.equal(sent.length, 1); assert.equal(sent[0].args.preferredSlots[0].startTime, '10:30'); assert.ok(sent[0].args.requestKey);
  } finally { await session?.close(); await f.close(); }
});
