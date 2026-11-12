// Barge-in: when the caller starts talking while Sophie is still speaking, the
// Live model stops generating, but audio it already streamed (faster than real
// time) is still queued in the bridge and would keep playing. The bridge drops
// that stale audio as soon as a new caller turn starts.
//
// The trigger is OpenAI's own transcript of the caller, not raw loudness, so
// line echo of Sophie's voice or background noise does not cut her off. Only
// the FIRST transcript fragment of each caller turn triggers: later fragments of
// the same turn arrive late (transcription lags the audio) and could otherwise
// cut the start of Sophie's reply to that turn.

const TURN_GAP_MS = 1500;   // caller fragments closer than this belong to one turn

export function createBargeInDetector({gapMs = TURN_GAP_MS} = {}) {
  let lastEndMs = -Infinity;
  return {
    /** Returns true when this event is the first caller speech of a new turn. */
    isNewCallerTurn(event) {
      if (event?.type !== 'session.input_transcript.delta' || typeof event.delta !== 'string') return false;
      if (!/[\p{L}\p{N}]/u.test(event.delta)) return false;          // ignore punctuation/whitespace-only fragments
      const start = Number.isFinite(event.start_ms) ? event.start_ms : null;
      const end = Number.isFinite(event.end_ms) ? event.end_ms : start;
      if (start === null) return false;
      const newTurn = start - lastEndMs > gapMs || start < lastEndMs - gapMs;
      lastEndMs = Math.max(end ?? start, start);
      return newTurn;
    },
  };
}
