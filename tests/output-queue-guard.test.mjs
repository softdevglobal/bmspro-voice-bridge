import assert from 'node:assert/strict';
import test from 'node:test';
import {createOutputQueueGuard} from '../src/audio/output-queue-guard.mjs';

test('fast Deepgram synthesis can buffer a normal explanation while playback keeps draining',()=>{
 let now=0;const guard=createOutputQueueGuard({deepgram:true,now:()=>now});
 assert.equal(guard.append(0,20*8000),null);
 let remaining=20*8000;
 for(now=0;now<=20000;now+=20){assert.equal(guard.check(remaining),null);remaining=Math.max(0,remaining-160);guard.drained(remaining);}
});
test('provider queues remain bounded and the existing GPT Live bound stays unchanged',()=>{
 const deepgram=createOutputQueueGuard({deepgram:true}),live=createOutputQueueGuard();
 assert.equal(deepgram.append(0,60*8000),null);assert.equal(deepgram.append(60*8000,1),'OUTPUT_AUDIO_BACKLOG');
 assert.equal(live.append(0,80000),null);assert.equal(live.append(80000,1),'OUTPUT_AUDIO_BACKLOG');
});
test('a stopped playback path still fails even when the generated audio fits the buffer',()=>{
 let now=0;const guard=createOutputQueueGuard({deepgram:true,now:()=>now});guard.append(0,160000);
 now=9999;assert.equal(guard.check(160000),null);now=10000;assert.equal(guard.check(160000),'OUTPUT_PLAYBACK_STALLED');
 guard.drained(159840);assert.equal(guard.check(159840),null);
});
test('barge-in and empty queues reset progress without discarding future speech',()=>{
 let now=0;const guard=createOutputQueueGuard({deepgram:true,now:()=>now});guard.append(0,8000);guard.clear();
 now=20000;assert.equal(guard.check(0),null);assert.equal(guard.append(0,8000),null);assert.equal(guard.check(8000),null);
 guard.drained(0);now=40000;assert.equal(guard.check(0),null);
});
