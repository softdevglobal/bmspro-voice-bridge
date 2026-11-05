import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema, CallToolRequestSchema, ReadResourceRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {loadTenantRoutes, configForDid, resolveMediaStartRoute} from '../src/routing/tenant-routing.mjs';
import {openOnboardingSession, ONBOARDING_TOOLS} from '../src/agents/onboarding/onboarding-tools.mjs';

const env = {BMSPRO_BRIDGE_SECRET: 'workshop-secret-test-00000000000000000000',
  BMSPRO_ONBOARDING_BRIDGE_SECRET: 'onboarding-secret-test-000000000000000000', BMSPRO_ONBOARDING_DIDS_JSON: '["0359111499"]'};

test('dedicated onboarding DID gets separate credentials while existing workshop routes are preserved', async () => {
  const routes = loadTenantRoutes(env);
  for (const did of ['0359111400', '0359111403']) {
    const config = configForDid(did, routes, 'black');
    assert.equal(config.mode, 'receptionist');
    assert.equal(config.token, env.BMSPRO_BRIDGE_SECRET);
    assert.deepEqual(config.routingHeaders, {'X-BMSPro-DID': did});
  }
  const config = await resolveMediaStartRoute({channel_variables: {BMS_ROUTE_INFO: '<http://localhost>;info=bmsdid0359111499'}}, routes);
  assert.equal(config.mode, 'onboarding');
  assert.equal(config.token, env.BMSPRO_ONBOARDING_BRIDGE_SECRET);
  assert.equal(new URL(config.url).pathname, '/api/ai/mcp/onboarding-call/');
  assert.equal(loadTenantRoutes({...env, BMSPRO_ONBOARDING_DIDS_JSON: '[]'}).onboarding, null);
});

test('invalid DID lists, shared credentials and conflicting route markers are rejected', async () => {
  for (const value of ['not-json', '["0359111499","0359111499"]', '["+61359111499"]'])
    assert.throws(() => loadTenantRoutes({...env, BMSPRO_ONBOARDING_DIDS_JSON: value}));
  assert.throws(() => loadTenantRoutes({...env, BMSPRO_ONBOARDING_BRIDGE_SECRET: env.BMSPRO_BRIDGE_SECRET}));
  const routes = loadTenantRoutes(env);
  await assert.rejects(resolveMediaStartRoute({channel_variables: {BMS_ROUTE_INFO: '<http://localhost>;info=bmsdid0359111499', _BMS_ROUTE_INFO: 'conflicting'}}, routes));
});

test('bridge onboarding client uses separate call identities and only exposes onboarding tools', async () => {
  const data = new Map();
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const id = req.headers['x-bmspro-onboarding-call'];
    assert.match(id, /^[a-f0-9-]{36}$/);
    assert.equal(req.headers['authorization'], `Bearer ${env.BMSPRO_ONBOARDING_BRIDGE_SECRET}`);
    assert.equal(req.headers['x-bmspro-did'], '0359111499');
    if (!data.has(id)) data.set(id, {});
    const mcp = new Server({name: 'test-onboarding-backend', version: '1.0.0'}, {capabilities: {tools: {}, resources: {}}});
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [...ONBOARDING_TOOLS, 'get_available_pink_subscription_plans'].map(name => ({name, inputSchema: {type: 'object', additionalProperties: true}}))}));
    mcp.setRequestHandler(ReadResourceRequestSchema, async () => ({contents: [{uri: 'bmspro://onboarding/call', mimeType: 'application/json', text: JSON.stringify({
      did: '0359111499', mode: 'onboarding', voiceInstructions: 'Collect business setup details.', backendInstructions: 'Use this call only.', greeting: 'Introduce yourself as AI.',
    })}]}));
    mcp.setRequestHandler(CallToolRequestSchema, async request => {
      calls.push(request.params.name);
      if (request.params.name === 'get_available_pink_subscription_plans') return {content: [{type: 'text', text: JSON.stringify({plans: [{id: 'pink-starter', name: 'Pink Starter'}]})}]};
      if (request.params.name === 'save_onboarding_draft') data.set(id, {...data.get(id), ...request.params.arguments.configuration});
      return {content: [{type: 'text', text: JSON.stringify({reference: id, status: 'draft', configuration: data.get(id)})}]};
    });
    const transport = new StreamableHTTPServerTransport({enableJsonResponse: true});
    res.once('close', () => { void transport.close(); void mcp.close(); });
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    await mcp.connect(transport);
    await transport.handleRequest(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined);
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const config = {mode: 'onboarding', did: '0359111499', url: `http://127.0.0.1:${server.address().port}/mcp`, token: env.BMSPRO_ONBOARDING_BRIDGE_SECRET};
  let first, second;
  try {
    first = await openOnboardingSession(config);
    second = await openOnboardingSession(config);
    assert.equal(data.size, 2);
    assert.deepEqual(first.tools.map(tool => tool.name), [...ONBOARDING_TOOLS, 'get_available_pink_subscription_plans']);
    assert.equal((await first.call('get_available_pink_subscription_plans', {})).plans[0].id, 'pink-starter');
    const saved = await first.call('save_onboarding_draft', {configuration: {business: {tradingName: 'Call One'}}});
    assert.equal(saved.configuration.business.tradingName, 'Call One');
    assert.equal((await second.call('get_onboarding_status', {})).configuration.business, undefined);
    assert.equal((await first.call('create_booking', {})).status, 'REJECTED');
    assert.equal(calls.includes('create_booking'), false);
    await first.close();
    assert.equal((await first.call('get_onboarding_status', {})).status, 'REJECTED');
  } finally {
    await first?.close(); await second?.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
