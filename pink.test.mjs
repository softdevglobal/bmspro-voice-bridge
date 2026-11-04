import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema, CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {openPinkSession, PINK_READ_TOOLS} from './pink-tools.mjs';

async function fixture({writeEnabled = true, uncertain = false, wrongBrand = false} = {}) {
  const calls = [], names = [...PINK_READ_TOOLS, ...(writeEnabled ? ['create_booking'] : [])];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers['x-bmspro-did'], '0359111425');
    const mcp = new Server({name: 'offline-pink', version: '1'}, {capabilities: {tools: {}}});
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({tools: names.map(name => ({name, inputSchema: {
      type: 'object', properties: name === 'create_booking' ? {requestKey: {type: 'string'}, slotToken: {type: 'string'}} : {},
      required: name === 'create_booking' ? ['requestKey', 'slotToken'] : [],
    }}))}));
    mcp.setRequestHandler(CallToolRequestSchema, async request => {
      calls.push(request.params);
      const name = request.params.name;
      const value = name === 'get_business_profile' ? {brand: wrongBrand ? 'black' : 'pink', did: '0359111425', ownerUid: 'salon', branch: {id: 'branch', name: 'Pink Branch', salonName: 'Test Salon', timezone: 'Australia/Sydney'}}
        : name === 'list_services' ? [{id: 'cut', name: 'Haircut'}]
        : name === 'get_available_slots' ? {brand: 'pink', slots: [{time: '15:00', slotToken: 'test-slot'}]}
        : {status: uncertain ? 'UNKNOWN' : 'PENDING_REVIEW', bookingId: 'booking'};
      return {content: [{type: 'text', text: JSON.stringify(value)}]};
    });
    const transport = new StreamableHTTPServerTransport({enableJsonResponse: true});
    res.once('close', () => {void transport.close(); void mcp.close();});
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    await mcp.connect(transport);
    await transport.handleRequest(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined);
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const config = {mode: 'pink', did: '0359111425', token: 'test-pink-credential', routingHeaders: {'X-BMSPro-DID': '0359111425'}, url: `http://127.0.0.1:${server.address().port}/mcp`};
  return {config, calls, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))};
}

test('Pink voice startup verifies its branch identity and respects disabled booking writes', async () => {
  const f = await fixture({writeEnabled: false}); let session;
  try {
    session = await openPinkSession(f.config);
    assert.equal(session.config.businessName, 'Test Salon');
    assert.deepEqual(session.tools.map(tool => tool.name), PINK_READ_TOOLS);
    assert.equal((await session.call('create_booking', {})).status, 'REJECTED');
    assert.equal(f.calls.some(call => call.name === 'create_booking'), false);
  } finally {await session?.close(); await f.close();}
});

test('Pink booking requires returned services, a current slot and confirmation; retries retain one private request key', async () => {
  const f = await fixture(); let session;
  try {
    session = await openPinkSession(f.config);
    const schema = session.tools.find(tool => tool.name === 'create_booking').parameters;
    assert.equal(Object.hasOwn(schema.properties, 'requestKey'), false);
    assert.equal((await session.call('get_available_slots', {date: '2026-10-29', serviceIds: ['cut']})).status, 'REJECTED');
    await session.call('list_services', {});
    await session.call('get_available_slots', {date: '2026-10-29', serviceIds: ['cut']});
    const args = {slotToken: 'test-slot', customerConfirmed: true, customerName: 'Test Client', customerPhone: '+61400000000', customerEmail: 'client@example.test'};
    assert.equal((await session.call('create_booking', {...args, customerConfirmed: false})).status, 'CONFIRMATION_REQUIRED');
    assert.equal((await session.call('create_booking', {...args, ownerUid: 'other-salon'})).status, 'REJECTED');
    assert.equal((await session.call('create_booking', args)).status, 'PENDING_REVIEW');
    assert.equal((await session.call('create_booking', args)).status, 'PENDING_REVIEW');
    const submissions = f.calls.filter(call => call.name === 'create_booking');
    assert.equal(submissions.length, 1); assert.match(submissions[0].arguments.requestKey, /^[a-f0-9-]{36}$/);
  } finally {await session?.close(); await f.close();}
});

test('uncertain Pink submission blocks changed details and additional booking writes', async () => {
  const f = await fixture({uncertain: true}); let session;
  try {
    session = await openPinkSession(f.config);
    await session.call('list_services', {}); await session.call('get_available_slots', {date: '2026-10-29', serviceIds: ['cut']});
    const args = {slotToken: 'test-slot', customerConfirmed: true};
    assert.equal((await session.call('create_booking', args)).status, 'UNKNOWN');
    assert.equal((await session.call('create_booking', args)).status, 'UNKNOWN');
    assert.equal((await session.call('create_booking', {...args, notes: 'changed'})).status, 'REJECTED');
    assert.equal(f.calls.filter(call => call.name === 'create_booking').length, 1);
  } finally {await session?.close(); await f.close();}
});

test('Pink startup rejects a Black profile before exposing voice tools', async () => {
  const f = await fixture({wrongBrand: true});
  try {await assert.rejects(openPinkSession(f.config), error => error.code === 'PINK_SETUP_FAILED');}
  finally {await f.close();}
});
