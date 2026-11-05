import assert from 'node:assert/strict';
import test from 'node:test';
import {createInputAudioClock, createPacedAudioTimer} from '../src/audio/input-audio.mjs';

function fixture(options = {}) {
  const frames = [];
  let tick, scheduled = 0, cancelled = 0, failures = 0, open = true, time = 0;
  const errors = [];
  const clock = createInputAudioClock({
    send: frame => frames.push(frame), canSend: () => open,
    onError: error => { failures++; errors.push(error); },
    now: () => time,
    schedule: (callback, period) => { assert.equal(period, 20); scheduled++; tick = callback; return 123; },
    cancel: handle => { assert.equal(handle, 123); cancelled++; },
    ...options,
  });
  return {clock, frames, errors, tick: (elapsed = 20) => { time += elapsed; tick(); }, setOpen: value => { open = value; },
    scheduled: () => scheduled, cancelled: () => cancelled, failures: () => failures};
}

test('an answered call supplies live input even if the silent caller sends no RTP', () => {
  const f = fixture();
  assert.equal(f.frames.length, 0);
  f.clock.start();
  for (let i = 0; i < 49; i++) f.tick();
  assert.equal(f.frames.length, 50);
  assert.equal(Buffer.concat(f.frames).length, 8000);
  assert.ok(f.frames.every(frame => frame.equals(Buffer.alloc(160, 0xff))));
  f.clock.start();
  assert.equal(f.scheduled(), 1);
});

test('fragmented and coalesced caller audio remains ordered with silence only for missing bytes', () => {
  const f = fixture();
  f.clock.start();
  const speech = Buffer.from(Array.from({length: 350}, (_, i) => i % 255));
  f.clock.append(speech.subarray(0, 70));
  f.clock.append(speech.subarray(70));
  f.tick(); f.tick(); f.tick();
  const delivered = Buffer.concat(f.frames.slice(1));
  assert.deepEqual(delivered.subarray(0, speech.length), speech);
  assert.ok(delivered.subarray(speech.length).equals(Buffer.alloc(130, 0xff)));
});

test('hangup discards pending audio and stops both silence and speech delivery', () => {
  const f = fixture();
  f.clock.start(); f.clock.append(Buffer.alloc(160, 1));
  f.clock.stop(); f.clock.append(Buffer.alloc(160, 2)); f.tick(); f.clock.start();
  assert.equal(f.frames.length, 1);
  assert.equal(f.cancelled(), 1);
  assert.equal(f.scheduled(), 1);
});

test('a closed upstream does not consume queued caller speech', () => {
  const f = fixture();
  f.setOpen(false); f.clock.start(); f.clock.append(Buffer.alloc(160, 3)); f.tick();
  assert.equal(f.frames.length, 0);
  f.setOpen(true); f.tick();
  assert.deepEqual(f.frames[0], Buffer.alloc(160, 3));
});

test('an input backlog or upstream send failure ends streaming once', () => {
  const f = fixture();
  f.clock.start(); f.clock.append(Buffer.alloc(64001)); f.tick();
  assert.equal(f.failures(), 1);
  assert.equal(f.frames.length, 1);
  const g = fixture({send: () => { throw new Error('backpressure'); }});
  g.clock.start(); g.tick();
  assert.equal(g.failures(), 1);
  assert.equal(g.cancelled(), 1);
});

test('ten minutes of callbacks arriving one millisecond late do not accumulate caller audio or lose speech', () => {
  const f = fixture();
  f.clock.start();
  const input = Buffer.alloc(168, 0x55); // 21 ms of caller audio per delayed callback.
  for (let i = 0; i < 30000; i++) { f.clock.append(input); f.tick(21); }
  assert.equal(f.failures(), 0);
  const delivered = Buffer.concat(f.frames.slice(1));
  assert.equal(delivered.length, 30000 * input.length);
  assert.ok(delivered.every(value => value === 0x55));
});

test('brief upstream congestion preserves audio and catches up without discarding speech', () => {
  const f = fixture(); f.clock.start(); f.setOpen(false);
  const speech = Buffer.alloc(1600, 0x33);
  f.clock.append(speech); f.tick(200);
  assert.equal(f.frames.length, 1);
  f.setOpen(true); f.tick(); f.tick(); f.tick();
  assert.deepEqual(Buffer.concat(f.frames.slice(1)).subarray(0, speech.length), speech);
  assert.equal(f.failures(), 0);
});

test('failure diagnostics distinguish queue overflow from a failed send', () => {
  const f = fixture(); f.clock.start(); f.clock.append(Buffer.alloc(64001));
  assert.deepEqual(f.errors, [{code: 'INPUT_AUDIO_BACKLOG', bufferedBytes: 64001}]);
  const g = fixture({send: () => { throw new Error('private socket error'); }});
  g.clock.start();
  assert.deepEqual(g.errors, [{code: 'INPUT_AUDIO_SEND_FAILED', bufferedBytes: 0}]);
});

test('pacing bounds catch-up bursts and reports a genuine eight-second clock stall once', () => {
  let time = 0, callback, sent = 0, failures = 0;
  const clock = createPacedAudioTimer({now: () => time, tick: () => { sent++; }, onError: () => failures++,
    schedule: action => { callback = action; return 1; }, cancel: () => {}});
  clock.start(); time = 1000; callback();
  assert.equal(sent, 6); // One immediate frame plus at most five per callback.
  time = 10000; callback(); callback();
  assert.equal(failures, 1);
});
