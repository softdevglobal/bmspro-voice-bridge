import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCallTranscript} from '../src/observability/call-transcript.mjs';

const id = '11111111-1111-4111-8111-111111111111';
test('call text is updated live, preserves fragments, separates speakers and excludes tool payloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-transcript-'));
  try {
    const writer = createCallTranscript({callId: id, directory});
    writer.metadata({did: '0359111410', mode: 'onboarding'});
    const event = (speaker, delta, start_ms, end_ms, event_id) => writer.event({type: `session.${speaker}_transcript.delta`, delta, start_ms, end_ms, event_id});
    event('output', 'Hi,', 0, 100, '1'); event('output', ' I am Sophie.', 100, 500, '2');
    event('input', 'My business is', 600, 800, '3'); event('input', ' Test Test.', 800, 1000, '4');
    event('input', ' Test Test.', 800, 1000, '4');
    writer.event({type: 'response.event', delta: 'secret-tool-payload'});
    await writer.flush();
    let content = await readFile(writer.path, 'utf8');
    assert.match(content, /Sophie: Hi, I am Sophie\./);
    assert.match(content, /Caller: My business is Test Test\./);
    assert.equal(content.includes('secret-tool-payload'), false);
    event('output', 'Thanks!', 1200, 1500, '5');
    await writer.close('caller disconnected');
    writer.event({type: 'session.input_transcript.delta', delta: 'after close', start_ms: 2000, end_ms: 2100});
    await writer.flush(); content = await readFile(writer.path, 'utf8');
    assert.match(content, /Sophie: Thanks!/); assert.match(content, /Reason: "caller disconnected"/);
    assert.equal(content.includes('after close'), false);
    if (process.platform !== 'win32') assert.equal((await stat(writer.path)).mode & 0o777, 0o600);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
test('separate calls get separate files and disk failures are isolated from calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-transcript-'));
  try {
    const a = createCallTranscript({callId: id, directory});
    const b = createCallTranscript({callId: '22222222-2222-4222-8222-222222222222', directory});
    assert.notEqual(a.path, b.path); await Promise.all([a.close(), b.close()]);
    const blocked = join(directory, 'not-a-directory'); await writeFile(blocked, 'file');
    let failures = 0;
    const broken = createCallTranscript({callId: id, directory: blocked, onError: () => { failures++; }});
    broken.event({type: 'session.input_transcript.delta', delta: 'hello', start_ms: 0, end_ms: 100});
    await broken.close(); assert.equal(failures, 1);
    assert.throws(() => createCallTranscript({callId: '../escape', directory}));
  } finally { await rm(directory, {recursive: true, force: true}); }
});
