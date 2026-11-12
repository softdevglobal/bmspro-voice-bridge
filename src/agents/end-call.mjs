// Lets Sophie end the call politely, like a receptionist would: after the caller
// has clearly finished, she says a short goodbye and the bridge hangs up once
// that goodbye has finished playing. Handled entirely in the bridge (no backend).

export const END_CALL_TOOL = Object.freeze({
  type: 'function', name: 'end_call', strict: false,
  description: 'End the phone call. Use only when the caller has clearly finished: they said goodbye, thanked you and confirmed nothing else is needed, or asked you to hang up. Never use it mid-task, while a request is still being prepared or saved, because the caller is frustrated, or because of silence. After calling it, say one short goodbye; the call ends once that goodbye has been heard.',
  parameters: {type: 'object', properties: {}, required: [], additionalProperties: false},
});

export const END_CALL_VOICE_RULE =
  'You can end the call. When the caller says goodbye, says they will hang up, or asks you to hang up, give one short warm goodbye and request the backend end the call. ' +
  'Do not keep the caller on the line with extra questions once they are done, and never say you will end the call unless it is being ended. If they still have a question, answer it first.';

export const END_CALL_BACKEND_RULE =
  'Call end_call only when the caller has clearly finished (goodbye, "that is all", or a request to hang up). Never call it in the middle of a booking, while a write is pending, or to end an unfinished conversation. ' +
  'Any confirmed request must already be submitted or explicitly abandoned by the caller first.';

const ENDING_MESSAGE = 'The call will end after your goodbye. Say one short, warm goodbye now (for example "Thanks for calling, have a great day!") and nothing else. If the caller starts speaking again, the hang-up is cancelled and you should help them.';

/**
 * Decides when to hang up after end_call: once Sophie's goodbye has played and
 * a short pause has passed. Falls back to a time limit if no goodbye is heard.
 */
export function createHangupController({
  minWaitMs = 1500,            // never hang up sooner than this after the request
  quietAfterSpeechMs = 1200,   // pause after the goodbye finishes
  noGoodbyeTimeoutMs = 5000,   // hang up anyway if no goodbye audio arrives
  maxWaitMs = 15000,           // absolute cap
} = {}) {
  let requestedAt = null, heardGoodbye = false;
  return {
    get pending() { return requestedAt !== null; },
    request(now) {
      if (requestedAt === null) { requestedAt = now; heardGoodbye = false; }
      return {status: 'ENDING', message: ENDING_MESSAGE};
    },
    /** The caller spoke again: stay on the line. Returns true if a hang-up was cancelled. */
    cancel() {
      const was = requestedAt !== null;
      requestedAt = null; heardGoodbye = false;
      return was;
    },
    /** Called every audio tick. Returns true when the bridge should hang up now. */
    shouldHangUp({now, queuedBytes, lastSpeechPlaybackAt}) {
      if (requestedAt === null) return false;
      const elapsed = now - requestedAt;
      if (lastSpeechPlaybackAt > requestedAt) heardGoodbye = true;
      if (elapsed >= maxWaitMs) return true;
      if (elapsed < minWaitMs || queuedBytes > 0) return false;
      if (heardGoodbye) return now - lastSpeechPlaybackAt >= quietAfterSpeechMs;
      return elapsed >= noGoodbyeTimeoutMs;
    },
  };
}
