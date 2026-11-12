import assert from 'node:assert/strict';
import test from 'node:test';
import {END_CALL_TOOL, createHangupController} from '../src/agents/end-call.mjs';

const tick = (controller, now, queuedBytes = 0, lastSpeechPlaybackAt = -Infinity) =>
  controller.shouldHangUp({now, queuedBytes, lastSpeechPlaybackAt});

test('the end_call tool takes no arguments and describes when it may be used', () => {
  assert.equal(END_CALL_TOOL.name, 'end_call');
  assert.deepEqual(END_CALL_TOOL.parameters.properties, {});
  assert.match(END_CALL_TOOL.description, /clearly finished/);
});

test('hangs up only after the goodbye has finished playing and a short pause', () => {
  const c = createHangupController();
  assert.equal(tick(c, 0), false);                          // nothing requested
  assert.equal(c.request(1000).status, 'ENDING');
  assert.equal(tick(c, 2000, 1600, 1990), false);            // goodbye still queued
  assert.equal(tick(c, 3000, 0, 2990), false);               // goodbye just finished
  assert.equal(tick(c, 3500, 0, 2990), false);               // pause not long enough yet
  assert.equal(tick(c, 4200, 0, 2990), true);                // goodbye heard + 1.2 s quiet
});

test('never hangs up instantly, falls back when no goodbye is spoken, and has a hard cap', () => {
  const quick = createHangupController();
  quick.request(0);
  assert.equal(tick(quick, 1000), false);                    // minimum wait
  assert.equal(tick(quick, 4000), false);                    // waiting for a goodbye
  assert.equal(tick(quick, 5000), true);                     // none came: hang up anyway

  const talky = createHangupController();
  talky.request(0);
  assert.equal(tick(talky, 14000, 800, 13990), false);
  assert.equal(tick(talky, 15000, 800, 14990), true);        // absolute cap
});

test('the caller speaking again cancels the hang-up', () => {
  const c = createHangupController();
  assert.equal(c.cancel(), false);
  c.request(0);
  assert.equal(c.pending, true);
  assert.equal(c.cancel(), true);
  assert.equal(c.pending, false);
  assert.equal(tick(c, 60000), false);
});
