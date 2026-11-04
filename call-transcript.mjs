import {mkdir, open} from 'node:fs/promises';
import {resolve, join} from 'node:path';

const speakers = new Map([
  ['session.input_transcript.delta', 'Caller'],
  ['session.output_transcript.delta', 'Sophie'],
]);
const stamp = ms => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${(ms % 60000 / 1000).toFixed(3).padStart(6, '0')}`;

/** Append speech only, never audio, tools, credentials or complete event payloads. */
export function createCallTranscript({callId, directory = './transcripts', startedAt = new Date(), onError = () => {}}) {
  if (!/^[a-f0-9-]{36}$/i.test(callId)) throw new Error('Invalid transcript call ID.');
  const path = join(resolve(directory), `${startedAt.toISOString().replace(/[:.]/g, '-')}_${callId}.txt`);
  let file, failed = false, closed = false, lastSpeaker, lastEnd = -Infinity;
  const seen = new Set();
  const fail = () => { if (!failed) { failed = true; try { onError(); } catch { /* Logging cannot interrupt calls. */ } } };
  let pending = (async () => {
    await mkdir(resolve(directory), {recursive: true, mode: 0o700});
    file = await open(path, 'wx', 0o600);
    await file.writeFile(`Call transcript\nCall ID: ${callId}\nStarted: ${startedAt.toISOString()}\nSpeech recognition may contain errors. Sophie text describes generated speech, not proof of audio heard.\nFragments are appended in arrival order; timestamps are offsets on the session timeline.\n\n`);
  })().catch(fail);
  const append = text => {
    pending = pending.then(async () => { if (!failed) await file.appendFile(text); }).catch(fail);
  };
  return {
    path,
    metadata({did, mode, businessName, businessId}) {
      if (closed) return;
      append(`\nRoute: ${JSON.stringify({did, mode, businessName, businessId})}\n`);
      lastSpeaker = undefined;
    },
    event(event) {
      const speaker = speakers.get(event?.type);
      if (closed || !speaker || typeof event.delta !== 'string' || !event.delta.length ||
          !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms) || event.start_ms < 0 || event.end_ms < event.start_ms) return;
      if (typeof event.event_id === 'string') { if (seen.has(event.event_id)) return; seen.add(event.event_id); }
      // Never trim fragments or add spaces: whitespace and repeated words are speech data.
      const newLine = speaker !== lastSpeaker || event.start_ms - lastEnd > 1500 || event.start_ms < lastEnd;
      append(`${newLine ? `\n[${stamp(event.start_ms)}] ${speaker}: ` : ''}${event.delta}`);
      lastSpeaker = speaker;
      lastEnd = event.end_ms;
    },
    async close(reason = 'call ended') {
      if (closed) return pending;
      closed = true;
      append(`\n\nEnded: ${new Date().toISOString()}\nReason: ${JSON.stringify(String(reason))}\n`);
      pending = pending.then(async () => { if (file) await file.close(); }).catch(fail);
      return pending;
    },
    async flush() { await pending; },
  };
}
