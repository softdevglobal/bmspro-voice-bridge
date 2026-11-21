import assert from 'node:assert/strict';
import test from 'node:test';
import {LIVE_CONTEXT_MAX_BYTES, splitLiveContext, sendLiveContext} from '../src/agents/live-context.mjs';

test('long service/email guidance is preserved in ordered, bounded context appends', () => {
  const content = 'Services: ' + JSON.stringify(Array.from({length: 100}, (_, i) => `Service ${i} with a very long description`)) + '\nSpell emails letter by letter. '.repeat(30);
  const sent = [];
  const count = sendLiveContext({send: event => sent.push(event)}, {type: 'session.instructions.append', delegation_id: null, event_id: 'trade_voice_guide_call', content});
  assert.ok(count > 1);
  assert.equal(sent.map(event => event.content).join(''), content);
  assert.equal(new Set(sent.map(event => event.event_id)).size, count);
  assert.ok(sent.every(event => event.delegation_id === null && event.type === 'session.instructions.append' && Buffer.byteLength(event.content) <= LIVE_CONTEXT_MAX_BYTES));
});

test('Unicode and unsplittable text never exceed the byte ceiling or lose code points', () => {
  for (const content of ['😀සිංහල漢字'.repeat(300), 'X'.repeat(4000), ' '.repeat(900), 'a'.repeat(399) + '😀', 'a'.repeat(400), '']) {
    const chunks = splitLiveContext(content);
    assert.equal(chunks.join(''), content);
    assert.ok(chunks.every(chunk => chunk.length > 0 && Buffer.byteLength(chunk) <= 400));
    assert.ok(chunks.every(chunk => !chunk.includes('\uFFFD')));
  }
});

test('short events retain their identity and session-wide binding', () => {
  const event = {type: 'session.commentary.append', delegation_id: null, event_id: 'hello', content: 'Hello there.'};
  const sent = [];
  assert.equal(sendLiveContext({send: value => sent.push(value)}, event), 1);
  assert.deepEqual(sent, [event]);
  assert.throws(() => splitLiveContext(null), TypeError);
  assert.throws(() => sendLiveContext({send() {}}, {...event,type: 'session.update'}), TypeError);
});
