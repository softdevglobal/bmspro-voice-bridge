import assert from 'node:assert/strict';
import test from 'node:test';
import {createBargeInDetector} from '../src/audio/barge-in.mjs';

const caller = (delta, start, end = start + 300) => ({type: 'session.input_transcript.delta', delta, start_ms: start, end_ms: end});

test('only the first fragment of each caller turn triggers barge-in', () => {
  const detector = createBargeInDetector();
  assert.equal(detector.isNewCallerTurn(caller('Sorry,', 5000)), true);       // caller starts talking over Sophie
  assert.equal(detector.isNewCallerTurn(caller(' can I', 5400)), false);      // same turn: must not cut Sophie's reply
  assert.equal(detector.isNewCallerTurn(caller(' ask?', 5900)), false);
  assert.equal(detector.isNewCallerTurn(caller('Yes', 12000)), true);         // a later, separate turn
});

test('Sophie\'s own speech, noise fragments and malformed events never trigger', () => {
  const detector = createBargeInDetector();
  assert.equal(detector.isNewCallerTurn({type: 'session.output_transcript.delta', delta: 'Hello', start_ms: 0, end_ms: 200}), false);
  assert.equal(detector.isNewCallerTurn(caller(' ', 1000)), false);
  assert.equal(detector.isNewCallerTurn(caller('...', 1000)), false);
  assert.equal(detector.isNewCallerTurn({type: 'session.input_transcript.delta', delta: 'hi'}), false);   // no timing
  assert.equal(detector.isNewCallerTurn(null), false);
  assert.equal(detector.isNewCallerTurn(caller('hi', 1000)), true);
});
