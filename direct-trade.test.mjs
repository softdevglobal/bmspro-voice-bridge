import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTenantRoutes, resolveConfigForDid} from './tenant-routing.mjs';

const env = {
  BMSPRO_BRIDGE_SECRET: 'command-center-test-secret-000000000000',
  BMSPRO_TRADE_BRIDGE_SECRET: 'trade-only-test-secret-0000000000000000',
  BMSPRO_TRADE_MCP_URL: 'http://127.0.0.1:13001/api/ai/mcp',
  BMSPRO_ALLOW_HTTP_FOR_LOCAL_TEST: 'true',
};
const did = '0359111403';
const json = value => new Response(JSON.stringify(value));

test('Trade discovers any dashboard-mapped DID without a bridge DID list or Command Center', async () => {
  const routes = loadTenantRoutes(env);
  let businessId = 'business-a';
  const fetcher = async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:13001/api/ai/voice');
    assert.equal(init.headers.Authorization, `Bearer ${env.BMSPRO_TRADE_BRIDGE_SECRET}`);
    assert.equal(init.headers['X-BMSPro-DID'], did);
    assert.equal(init.redirect, 'error');
    return json({matched: true, brand: 'trade', did, businessId});
  };
  const first = await resolveConfigForDid(did, routes, fetcher);
  assert.equal(first.url, env.BMSPRO_TRADE_MCP_URL);
  assert.equal(first.token, env.BMSPRO_TRADE_BRIDGE_SECRET);
  assert.equal(first.businessId, 'business-a');
  assert.equal(first.routingHeaders['X-BMSPro-Trade-Business'], 'business-a');
  assert.equal(first.activityToken, env.BMSPRO_BRIDGE_SECRET);
  assert.equal(first.activityUrl, routes.config.url);
  businessId = 'business-b';
  assert.equal((await resolveConfigForDid(did, routes, fetcher)).businessId, 'business-b');
  assert.equal(first.businessId, 'business-a', 'an existing call retains its original business binding');
});

test('unmapped numbers retain verified Black/Pink routing without leaking the Trade credential', async () => {
  const routes = loadTenantRoutes(env);
  for (const brand of ['black', 'pink']) {
    const result = await resolveConfigForDid(did, routes, async (url, init) => {
      if (url === routes.directTrade.discoveryUrl) return json({matched: false, did});
      assert.equal(url, routes.routeUrl);
      assert.equal(init.headers.Authorization, `Bearer ${env.BMSPRO_BRIDGE_SECRET}`);
      return json({brand, did});
    });
    assert.equal(result.mode, brand === 'black' ? 'receptionist' : 'pink');
  }
});

test('disabled Trade mappings cannot fall back to a stale backend assignment', async () => {
  const routes = loadTenantRoutes(env);
  let calls = 0;
  await assert.rejects(resolveConfigForDid(did, routes, async url => {
    calls++;
    assert.equal(url, routes.directTrade.discoveryUrl);
    return new Response('{}', {status: 403});
  }), /disabled/);
  assert.equal(calls, 1);
  await assert.rejects(resolveConfigForDid(did, routes, async url => url === routes.directTrade.discoveryUrl
    ? json({matched: false, did}) : json({brand: 'trade', did})), /dashboard/);
});

test('discovery outages cannot fall back to backend Trade tools but do not stop verified other products', async () => {
  const routes = loadTenantRoutes(env);
  for (const status of [401, 404, 429, 503]) {
    await assert.rejects(resolveConfigForDid(did, routes, async url => url === routes.directTrade.discoveryUrl
      ? new Response('{}', {status}) : json({brand: 'trade', did})), /discovery failed/);
  }
  const result = await resolveConfigForDid(did, routes, async url => {
    if (url === routes.directTrade.discoveryUrl) throw new Error('network unavailable');
    return json({brand: 'black', did});
  });
  assert.equal(result.mode, 'receptionist');
});

test('malformed discovery identity is rejected and onboarding bypasses Trade discovery', async () => {
  const routes = loadTenantRoutes(env);
  for (const route of [{matched: true, did: '0359111404', brand: 'trade', businessId: 'a'},
    {matched: true, did, brand: 'black', businessId: 'a'}, {matched: true, did, brand: 'trade', businessId: '../b'},
    {matched: true, did, brand: 'trade', businessId: ''}, {matched: false}]) {
    await assert.rejects(resolveConfigForDid(did, routes, async () => json(route)));
  }
  const onboarding = loadTenantRoutes({...env, BMSPRO_ONBOARDING_DIDS_JSON: JSON.stringify([did]), BMSPRO_ONBOARDING_BRIDGE_SECRET: 'onboarding-test-secret-0000000000000000'});
  assert.equal((await resolveConfigForDid(did, onboarding, async () => { throw new Error('must not fetch'); })).mode, 'onboarding');
});

test('endpoint and secret are required together; unsafe URLs and shared credentials fail closed', () => {
  for (const patch of [{BMSPRO_TRADE_MCP_URL: ''}, {BMSPRO_TRADE_BRIDGE_SECRET: ''},
    {BMSPRO_TRADE_BRIDGE_SECRET: env.BMSPRO_BRIDGE_SECRET}, {BMSPRO_TRADE_MCP_URL: 'http://example.com/api/ai/mcp'},
    {BMSPRO_TRADE_MCP_URL: 'https://user:pass@example.com/api/ai/mcp'}, {BMSPRO_TRADE_MCP_URL: 'https://example.com/api/ai/mcp?token=secret'},
    {BMSPRO_ALLOW_HTTP_FOR_LOCAL_TEST: 'false'}]) assert.throws(() => loadTenantRoutes({...env, ...patch}));
  assert.ok(loadTenantRoutes({...env, BMSPRO_TRADE_MCP_URL: 'https://trade.example.com/api/ai/mcp'}).directTrade);
});
