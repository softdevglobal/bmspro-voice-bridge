// Collects one call's log in memory and sends it to the Trade admin panel when
// the call ends, so the business owner can review it on the AI calls page.
//
// Stored: timings, end reason, tools used (name, status, duration), booking
// outcomes (status + reference only) and the caller/Sophie conversation text.
// Never stored: audio, tool arguments, raw tool results, credentials.
// Sending is fire-and-forget: a logging failure never affects a live call.

const MAX_TURNS = 500;          // conversation turns kept per call
const MAX_TURN_CHARS = 4000;    // per turn
const MAX_TOTAL_CHARS = 60000;  // whole conversation
const MAX_TOOLS = 100;
const OUTCOME_TOOLS = new Set(['create_inspection_request', 'create_job_booking', 'reschedule_job', 'cancel_job', 'register_customer']);

const speakers = new Map([
  ['session.input_transcript.delta', 'caller'],
  ['session.output_transcript.delta', 'sophie'],
]);
const safeCode = value => String(value ?? 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 64) || 'unknown';
const reference = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;

export function createCallRecord({callId, now = () => Date.now()}) {
  const startedAt = now();
  const turns = [], tools = [], outcomes = [], seen = new Set();
  let answeredAt = null, endedAt = null, endReason = null, setupMs = null, callerNumber = null, totalChars = 0;
  let last;   // {speaker, endMs} of the latest fragment, to merge fragments into turns

  return {
    /** Same OpenAI transcript events the transcript file uses; fragments are merged into turns. */
    event(event) {
      const speaker = speakers.get(event?.type);
      if (endedAt !== null || !speaker || typeof event.delta !== 'string' || !event.delta.length ||
          !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms) || event.start_ms < 0 || event.end_ms < event.start_ms) return;
      if (typeof event.event_id === 'string') { if (seen.has(event.event_id)) return; seen.add(event.event_id); }
      if (totalChars >= MAX_TOTAL_CHARS) return;
      const delta = event.delta.slice(0, MAX_TOTAL_CHARS - totalChars);
      const continues = last && last.speaker === speaker && event.start_ms - last.endMs <= 1500 && event.start_ms >= last.endMs;
      if (continues && turns.length) {
        const turn = turns[turns.length - 1];
        if (turn.text.length < MAX_TURN_CHARS) { const add = delta.slice(0, MAX_TURN_CHARS - turn.text.length); turn.text += add; totalChars += add.length; }
      } else if (turns.length < MAX_TURNS) {
        const text = delta.slice(0, MAX_TURN_CHARS);
        turns.push({speaker, atMs: Math.round(event.start_ms), text});
        totalChars += text.length;
      }
      last = {speaker, endMs: event.end_ms};
    },
    answered() { if (answeredAt === null) answeredAt = now(); },
    setup(ms) { if (Number.isFinite(ms)) setupMs = Math.max(0, Math.round(ms)); },
    caller(number) {
      const digits = String(number ?? '').replace(/\D/g, '');
      if (/^\d{6,15}$/.test(digits)) callerNumber = digits;
    },
    tool(name, result, durationMs) {
      if (tools.length < MAX_TOOLS) tools.push({name: safeCode(name), status: safeCode(result?.status || 'completed'), durationMs: Math.max(0, Math.round(durationMs || 0))});
      if (OUTCOME_TOOLS.has(name) && outcomes.length < 10) {
        outcomes.push({tool: safeCode(name), status: safeCode(result?.status),
          reference: reference(result?.requestId) ?? reference(result?.jobCode) ?? reference(result?.customerId)});
      }
    },
    end(reason) {
      if (endedAt !== null) return;
      endedAt = now();
      endReason = String(reason ?? 'call ended').replace(/[^\x20-\x7E]/g, '?').slice(0, 120);
    },
    /** The payload sent to Trade (POST /api/ai/calls). */
    build() {
      const end = endedAt ?? now();
      return {
        callId,
        startedAt: new Date(startedAt).toISOString(),
        answeredAt: answeredAt === null ? null : new Date(answeredAt).toISOString(),
        endedAt: new Date(end).toISOString(),
        durationMs: Math.max(0, end - startedAt),
        setupMs,
        endReason: endReason ?? 'call ended',
        callerNumber,
        tools,
        outcomes,
        transcript: turns.map(turn => ({...turn, text: turn.text.trim()})).filter(turn => turn.text.length),
      };
    },
  };
}

/**
 * Sends a finished call to Trade, authenticated like the MCP requests (bridge
 * secret + DID + pinned business). Only for direct Trade calls. Never throws.
 */
export async function sendTradeCallRecord({config, businessId, record, fetcher = fetch, log = () => {}}) {
  try {
    if (config?.mode !== 'trade' || !config.url || !config.token || !config.did || !businessId) return false;
    const url = new URL(config.url);
    url.pathname = '/api/ai/calls';
    url.search = '';
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`, 'X-BMSPro-DID': config.did, 'X-BMSPro-Trade-Business': businessId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(record.build()),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    log(`Call log: saved=${response.ok} status=${response.status}`);
    return response.ok;
  } catch {
    log('Call log: could not be sent; call already ended normally.');
    return false;
  }
}
