import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema, CallToolRequestSchema, ReadResourceRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {openBusinessSession, VOICE_TOOLS} from './business-tools.mjs';
import {openOnboardingSession, ONBOARDING_TOOLS} from './onboarding-tools.mjs';

async function fixture(mode, mismatch = false, expectedReads = 3) {
  const startupReads = new Set(), calls = [];
  let release, timer, timedOut = false;
  const startup = new Promise(resolve => { release = resolve; });
  const read = async name => {
    startupReads.add(name);
    // Hold each startup read until the independent reads arrive. A serialized client
    // times out this barrier and fails the concurrency assertion below.
    timer ??= setTimeout(() => { timedOut = true; release(); }, 3000);
    if (startupReads.size === expectedReads) { clearTimeout(timer); release(); }
    await startup;
  };
  const did = mode === 'onboarding' ? '0359111499' : '0359111400';
  const identity = {brand: 'black', did, workshopName: 'Test Workshop', branchName: 'Test Branch'};
  const server = http.createServer(async (req, res) => {
    const mcp = new Server({name: 'offline-startup', version: '1.0.0'}, {capabilities: {tools: {}, resources: {}}});
    mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      await read('inventory');
      return {tools: (mode === 'onboarding' ? ONBOARDING_TOOLS : VOICE_TOOLS).map(name => ({name, inputSchema: {type: 'object'}}))};
    });
    mcp.setRequestHandler(ReadResourceRequestSchema, async () => {
      await read('profile');
      return {contents: [{uri: 'bmspro://onboarding/call', mimeType: 'application/json', text: JSON.stringify({
        mode, did, voiceInstructions: 'Collect setup facts.', backendInstructions: 'Use only this call.', greeting: 'Introduce yourself as AI.',
      })}]};
    });
    mcp.setRequestHandler(CallToolRequestSchema, async request => {
      const name = request.params.name;
      calls.push(name);
      let value;
      if (name === 'get_workshop_profile') {
        await read('profile');
        value = {...identity, branch: {id: 'branch-1'}};
      } else if (name === 'list_services') {
        await read('services');
        value = {...identity, ...(mismatch ? {branchName: 'Another Branch'} : {}), services: []};
      } else if (name === 'get_onboarding_status') {
        await read('status');
        value = {reference: 'test-draft-reference', status: 'draft', configuration: {}};
      } else throw new Error('Startup must not execute writes.');
      return {content: [{type: 'text', text: JSON.stringify(value)}]};
    });
    const transport = new StreamableHTTPServerTransport({enableJsonResponse: true});
    res.once('close', () => { void transport.close(); void mcp.close(); });
    const body = []; for await (const chunk of req) body.push(chunk);
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body.length ? JSON.parse(Buffer.concat(body).toString()) : undefined);
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    config: {mode, did, url: `http://127.0.0.1:${server.address().port}/mcp`, token: 'offline-test-secret'},
    calls,
    assertConcurrent: () => { assert.equal(timedOut, false, 'independent startup reads must overlap'); assert.equal(startupReads.size, expectedReads); },
    close: async () => { clearTimeout(timer); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

test('workshop startup overlaps inventory, profile and services while retaining verified tenant identity', async () => {
  const f = await fixture('receptionist');
  let session;
  try {
    session = await openBusinessSession(f.config, {preloadServices: true});
    f.assertConcurrent();
    assert.equal(session.config.workshop, 'Test Workshop');
    assert.equal(session.config.branchId, 'branch-1');
    assert.deepEqual(session.tools.map(tool => tool.name), VOICE_TOOLS);
    assert.deepEqual(new Set(f.calls), new Set(['get_workshop_profile', 'list_services']));
  } finally { await session?.close(); await f.close(); }
});

test('concurrent startup still rejects a service response from another tenant', async () => {
  const f = await fixture('receptionist', true);
  try {
    await assert.rejects(openBusinessSession(f.config, {preloadServices: true}), /MCP tenant mismatch/);
    f.assertConcurrent();
  } finally { await f.close(); }
});

test('a workshop call can greet after branch verification without fetching its service catalogue', async () => {
  const f = await fixture('receptionist', false, 2);
  let session;
  try {
    session = await openBusinessSession(f.config);
    f.assertConcurrent();
    assert.equal(session.config.branchId, 'branch-1');
    assert.equal(session.serviceCount, null);
    assert.deepEqual(f.calls, ['get_workshop_profile']);
    assert.ok(session.tools.some(tool => tool.name === 'list_services'));
  } finally { await session?.close(); await f.close(); }
});

test('onboarding startup overlaps inventory, instructions and status without submitting or provisioning', async () => {
  const f = await fixture('onboarding');
  let session;
  try {
    session = await openOnboardingSession(f.config);
    f.assertConcurrent();
    assert.equal(session.config.mode, 'onboarding');
    assert.deepEqual(session.tools.map(tool => tool.name), ONBOARDING_TOOLS);
    assert.deepEqual(f.calls, ['get_onboarding_status']);
  } finally { await session?.close(); await f.close(); }
});
