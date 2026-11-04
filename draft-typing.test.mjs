import assert from 'node:assert/strict';
import test from 'node:test';
import {createDraftTypingCue, pcmuHasSpeech} from './draft-typing.mjs';

test('typing waits for a slow save and an answered, speech-free playback window', () => {
  let time = 0;
  const cue = createDraftTypingCue({now: () => time});
  assert.equal(cue.frame(true), null);
  cue.start();
  time = 149;
  assert.equal(cue.frame(true), null);
  time = 150;
  assert.equal(cue.frame(false), null);
  const frame = cue.frame(true);
  assert.equal(frame.length, 160);
  assert.ok(frame.some(value => value !== 0xff));
  cue.stop();
  assert.equal(cue.frame(true), null);
});

test('draft preparation and execution share one delay and one playback log, with a bounded tail', () => {
  let time = 0, notifications = 0;
  const cue = createDraftTypingCue({now: () => time, onPlayback: () => notifications++});
  cue.start();
  time = 140;
  cue.start();
  time = 151;
  assert.equal(cue.frame(true).length, 160);
  assert.equal(cue.frame(true).length, 160);
  assert.equal(notifications, 1);
  time = 45000;
  assert.equal(cue.frame(true), null);
  cue.start();
  time += 151;
  assert.equal(cue.frame(true).length, 160);
  assert.equal(notifications, 2);
});

test('typing loops whole PCMU frames and call instances have independent state', () => {
  let time = 0;
  const a = createDraftTypingCue({now: () => time});
  const b = createDraftTypingCue({now: () => time});
  a.start(); b.start(); time = 400;
  const first = a.frame(true);
  for (let i = 1; i < 80; i++) assert.equal(a.frame(true).length, 160);
  assert.deepEqual(a.frame(true), first);
  assert.deepEqual(b.frame(true), first);
  a.stop();
  assert.equal(a.frame(true), null);
  assert.equal(b.frame(true).length, 160);
});

test('PCMU silence packets do not suppress the cue, while audible samples take priority', () => {
  assert.equal(pcmuHasSpeech(Buffer.alloc(160, 0xff)), false);
  assert.equal(pcmuHasSpeech(Buffer.alloc(160, 0x7f)), false);
  assert.equal(pcmuHasSpeech(Buffer.alloc(160, 0xfe)), false);
  assert.equal(pcmuHasSpeech(Buffer.alloc(160, 0x80)), true);
  let time = 0;
  const cue = createDraftTypingCue({now: () => time});
  cue.start(); time = 200;
  const frame = cue.frame(!pcmuHasSpeech(Buffer.alloc(160, 0xff)));
  assert.ok(pcmuHasSpeech(frame), 'generated typing must have audible energy');
  assert.equal(cue.frame(!pcmuHasSpeech(Buffer.alloc(160, 0x80))), null);
});
