// Writes one plain-text transcript file per phone call (what the caller and Sophie said).
// Only speech text is saved: no audio, tool calls, credentials or full event data.

// mkdir creates the transcripts folder; open gives a file handle we can keep appending to.
import {mkdir, open} from 'node:fs/promises';
// resolve makes an absolute path; join builds the file path.
import {resolve, join} from 'node:path';

// Maps the OpenAI event type to the name printed in the transcript.
const speakers = new Map([
  // Text of what the caller said (speech recognition result).
  ['session.input_transcript.delta', 'Caller'],
  // Text of what Sophie (the AI) said.
  ['session.output_transcript.delta', 'Sophie'],
]);
// Turns milliseconds into mm:ss.mmm, e.g. 83500 -> "01:23.500".
const stamp = ms => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${(ms % 60000 / 1000).toFixed(3).padStart(6, '0')}`;

/** Append speech only, never audio, tools, credentials or complete event payloads. */
// Creates a transcript writer for one call. Returns { path, metadata, event, close, flush }.
// callId: the call's unique id. directory: where files go. startedAt: call start time.
// onError: called once if writing fails (so the bridge can log it).
export function createCallTranscript({callId, directory = './transcripts', startedAt = new Date(), onError = () => {}}) {
  // The call id must be a 36-character UUID (letters a-f, digits, dashes); this also keeps it safe to use in a file name.
  if (!/^[a-f0-9-]{36}$/i.test(callId)) throw new Error('Invalid transcript call ID.');
  // File name = start time (with ":" and "." replaced by "-") + "_" + call id + ".txt".
  const path = join(resolve(directory), `${startedAt.toISOString().replace(/[:.]/g, '-')}_${callId}.txt`);
  // file: the open file handle. failed: a write error happened. closed: the call has ended.
  // lastSpeaker / lastEnd: who spoke last and when they finished, used to decide when to start a new line.
  let file, failed = false, closed = false, lastSpeaker, lastEnd = -Infinity;
  // Ids of events already written, so a repeated event is not written twice.
  const seen = new Set();
  // Marks the transcript as failed and tells the caller once; a logging error must never interrupt the call.
  const fail = () => { if (!failed) { failed = true; try { onError(); } catch { /* Logging cannot interrupt calls. */ } } };
  // "pending" is a queue: every write waits for the one before, so text is saved in order.
  // This first step creates the folder and the file, then writes the header.
  let pending = (async () => {
    // Create the transcripts folder if needed; owner-only permissions (0o700).
    await mkdir(resolve(directory), {recursive: true, mode: 0o700});
    // Create the file; 'wx' fails if it already exists. Owner read/write only (0o600).
    file = await open(path, 'wx', 0o600);
    // Header: call id, start time and a warning that speech recognition can be wrong.
    await file.writeFile(`Call transcript\nCall ID: ${callId}\nStarted: ${startedAt.toISOString()}\nSpeech recognition may contain errors. Sophie text describes generated speech, not proof of audio heard.\nFragments are appended in arrival order; timestamps are offsets on the session timeline.\n\n`);
  // If creating the file fails, record the failure instead of crashing.
  })().catch(fail);
  // Adds text to the end of the file, after all earlier writes have finished.
  const append = text => {
    // Skip writing if an earlier step failed; any new error is recorded by fail().
    pending = pending.then(async () => { if (!failed) await file.appendFile(text); }).catch(fail);
  };
  // The object the bridge uses.
  return {
    // Where the transcript file is.
    path,
    // Writes a "Route:" line with which number, mode and business this call was routed to.
    metadata({did, mode, businessName, businessId}) {
      // Ignore if the call has already ended.
      if (closed) return;
      // Write the routing details as one JSON line.
      append(`\nRoute: ${JSON.stringify({did, mode, businessName, businessId})}\n`);
      // The next speech starts on a fresh line.
      lastSpeaker = undefined;
    },
    // Handles one OpenAI event; only caller/Sophie speech text is written.
    event(event) {
      // Which speaker this event belongs to (undefined for any other event type).
      const speaker = speakers.get(event?.type);
      // Ignore it if the call has ended, it is not speech, the text is missing or empty,
      // or the start/end times are not valid numbers (end must not be before start).
      if (closed || !speaker || typeof event.delta !== 'string' || !event.delta.length ||
          !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms) || event.start_ms < 0 || event.end_ms < event.start_ms) return;
      // If this event id was already written, skip it; otherwise remember it.
      if (typeof event.event_id === 'string') { if (seen.has(event.event_id)) return; seen.add(event.event_id); }
      // Never trim fragments or add spaces: whitespace and repeated words are speech data.
      // Start a new line when the speaker changes, there was a pause of more than 1.5 seconds, or the timeline went backwards.
      const newLine = speaker !== lastSpeaker || event.start_ms - lastEnd > 1500 || event.start_ms < lastEnd;
      // On a new line, print "[mm:ss.mmm] Speaker: " first; then add the text exactly as received.
      append(`${newLine ? `\n[${stamp(event.start_ms)}] ${speaker}: ` : ''}${event.delta}`);
      // Remember who spoke and when they finished.
      lastSpeaker = speaker;
      lastEnd = event.end_ms;
    },
    // Called when the call ends: writes the end time and reason, then closes the file.
    async close(reason = 'call ended') {
      // Already closed: just wait for the pending writes.
      if (closed) return pending;
      // Stop accepting new speech.
      closed = true;
      // Footer: when the call ended and why.
      append(`\n\nEnded: ${new Date().toISOString()}\nReason: ${JSON.stringify(String(reason))}\n`);
      // After all writes finish, close the file (if it was opened).
      pending = pending.then(async () => { if (file) await file.close(); }).catch(fail);
      // Let the caller wait until everything is saved.
      return pending;
    },
    // Waits until everything queued so far has been written (used by tests and shutdown).
    async flush() { await pending; },
  };
}
