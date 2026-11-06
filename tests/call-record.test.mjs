import assert from 'node:assert/strict';
import test from 'node:test';
import {createCallRecord, sendTradeCallRecord} from '../src/observability/call-record.mjs';

const callId = '0a41e31d-0620-47d1-9ef9-c9c60cef73a8';
const speech = (type, delta, start, end, id) => ({type: `session.${type}_transcript.delta`, delta, start_ms: start, end_ms: end, event_id: id});

test('fragments merge into speaker turns; duplicates, bad timings and post-hangup text are ignored', () => {
  let time = 1_000_000;
  const record = createCallRecord({callId, now: () => time});
  record.event(speech('output', 'Hi, thanks for calling', 0, 900, 'a'));
  record.event(speech('output', ' Nira Electrical.', 950, 1500, 'b'));
  record.event(speech('output', ' Nira Electrical.', 950, 1500, 'b'));        // duplicate id
  record.event(speech('input', 'Do you charge to come out?', 2500, 4000, 'c'));
  record.event(speech('input', 'bad', 5000, 4000, 'd'));                       // end before start
  record.event({type: 'session.output_audio.delta', delta: 'AAAA'});            // not speech
  record.event(speech('output', 'Yes, ninety dollars.', 4600, 6000, 'e'));
  time += 65_000;
  record.answered();
  record.end('caller disconnected');
  record.event(speech('input', 'after hang-up', 7000, 7500, 'f'));
  const built = record.build();
  assert.deepEqual(built.transcript, [
    {speaker: 'sophie', atMs: 0, text: 'Hi, thanks for calling Nira Electrical.'},
    {speaker: 'caller', atMs: 2500, text: 'Do you charge to come out?'},
    {speaker: 'sophie', atMs: 4600, text: 'Yes, ninety dollars.'},
  ]);
  assert.equal(built.callId, callId);
  assert.equal(built.durationMs, 65_000);
  assert.equal(built.endReason, 'caller disconnected');
});

test('tools keep name, status and duration only; outcomes keep a safe reference', () => {
  const record = createCallRecord({callId});
  record.tool('search_business_knowledge', {status: 'FOUND', passages: [{title: 'x', text: 'secret text'}]}, 712.4);
  record.tool('create_inspection_request', {status: 'PENDING_REVIEW', requestId: 'req_123', message: 'saved'}, 1500);
  record.tool('create_job_booking', {status: 'CONFIRMED', jobCode: 'bad/ref'}, 900);
  const built = record.build();
  assert.deepEqual(built.tools[0], {name: 'search_business_knowledge', status: 'FOUND', durationMs: 712});
  assert.ok(!JSON.stringify(built).includes('secret text'));
  assert.deepEqual(built.outcomes, [
    {tool: 'create_inspection_request', status: 'PENDING_REVIEW', reference: 'req_123'},
    {tool: 'create_job_booking', status: 'CONFIRMED', reference: null},
  ]);
});

test('transcript size is bounded and caller number is accepted only as digits', () => {
  const record = createCallRecord({callId});
  for (let i = 0; i < 700; i++) record.event(speech(i % 2 ? 'input' : 'output', 'x'.repeat(200), i * 3000, i * 3000 + 100, `id${i}`));
  record.caller('+61 412 345 678');
  const built = record.build();
  assert.ok(built.transcript.length <= 500);
  assert.ok(built.transcript.reduce((sum, turn) => sum + turn.text.length, 0) <= 60000);
  assert.equal(built.callerNumber, '61412345678');
  const other = createCallRecord({callId});
  other.caller('<script>');
  assert.equal(other.build().callerNumber, null);
});

test('sending posts to Trade with bridge headers, skips non-Trade calls and never throws', async () => {
  const record = createCallRecord({callId});
  const calls = [];
  const fetcher = async (url, init) => { calls.push({url: String(url), init}); return new Response('{}', {status: 201}); };
  const config = {mode: 'trade', url: 'http://127.0.0.1:3001/api/ai/mcp', token: 'secret', did: '0359111403'};
  assert.equal(await sendTradeCallRecord({config, businessId: 'biz-a', record, fetcher}), true);
  assert.equal(calls[0].url, 'http://127.0.0.1:3001/api/ai/calls');
  assert.equal(calls[0].init.headers['X-BMSPro-Trade-Business'], 'biz-a');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
  assert.equal(JSON.parse(calls[0].init.body).callId, callId);

  assert.equal(await sendTradeCallRecord({config: {...config, mode: 'pink'}, businessId: 'biz-a', record, fetcher}), false);
  assert.equal(await sendTradeCallRecord({config, businessId: undefined, record, fetcher}), false);
  assert.equal(calls.length, 1);
  assert.equal(await sendTradeCallRecord({config, businessId: 'biz-a', record, fetcher: async () => { throw new Error('down'); }}), false);
});
