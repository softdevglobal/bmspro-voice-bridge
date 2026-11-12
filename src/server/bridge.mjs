import http from 'node:http'; // plain http server 
import { randomUUID } from 'node:crypto'; // unique IDs for calls and telemetry events
import OpenAI from 'openai'; // open ai SDK client
import { LiveWS } from 'openai/resources/live/ws'; // OpenAI Live (realtime voice) WebSocket wrapper
import { WebSocket, WebSocketServer } from 'ws'; // WebSocket client (shadow ASR) and server (Asterisk)
import {voiceInstructions, backendInstructions} from '../agents/black/business-tools.mjs'; // default Black prompts
import {openAgentSession, openingGreeting} from '../agents/registry.mjs'; // mode -> agent session (Black, Trade, Pink, onboarding) and greeting
import {createDialogManager, dialogModeFromEnv, DIALOG_INSTRUCTIONS} from '../dialog/dialog-manager.mjs'; // per-call conversation steps and write gates
import {loadTenantRoutes, resolveConfigForDid, resolveMediaStartRoute} from '../routing/tenant-routing.mjs'; // dialled number (DID) business routing
import {createInputAudioClock, createPacedAudioTimer} from '../audio/input-audio.mjs'; // paced audio send/receive timers
import {createDraftTypingCue, pcmuHasSpeech} from '../audio/draft-typing.mjs'; // typing sound
import {createBargeInDetector} from '../audio/barge-in.mjs'; // stop Sophie when the caller starts talking
import {END_CALL_TOOL, END_CALL_VOICE_RULE, END_CALL_BACKEND_RULE, createHangupController} from '../agents/end-call.mjs'; // Sophie can end the call after a goodbye
import {createVoiceStudioShadow} from '../asr/voice-studio-shadow.mjs'; // side by side seech to text test
import {createCallTranscript} from '../observability/call-transcript.mjs'; // per-call transcript file writer
import {createCallRecord, sendTradeCallRecord} from '../observability/call-record.mjs'; // call log saved to Trade (Firebase) after hang-up
import {createOwnerVoiceHandler} from './owner-voice.mjs';
import {createLiveListen} from './live-listen.mjs';
import {loadOwnerHandoff, ownerHandoffReadiness, redirectToOwner} from './owner-handoff.mjs';

// Independent tenant and tool state per call; no application duration cutoff.
// Refuse to start without the OpenAI Api key.
if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY in .env first.');
let tenantRoutes;
try {
  tenantRoutes = loadTenantRoutes(); // load/validate DID routing config at startup
  console.log('Backend DID routing configured. Black, Pink, Trade and onboarding numbers use separate tools.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'MCP readiness check failed.');
  process.exit(1);
}
const client = new OpenAI(); // shared OpenAI client (reads OPENAI_API_KEY)
const ownerHandoff = loadOwnerHandoff();
const dialogMode = dialogModeFromEnv(); // BMSPRO_DIALOG_MANAGER: on (default), observe or off
console.log(`Dialog manager: ${dialogMode}.`);
console.log('Audio pacing follows elapsed time; bounded catch-up enabled.');

// ---- Optional "shadow" speech-to-text (VoiceStudio), for comparison only ----
const voiceStudioShadowEnabled = process.env.BMSPRO_VOICESTUDIO_SHADOW_ENABLED === 'true';
const voiceStudioShadowDids = (() => {
  try {
    // Allowlist of phone numbers (DIDs) that get shadow ASR, as a JSON array of strings.
    const value = JSON.parse(process.env.BMSPRO_VOICESTUDIO_SHADOW_DIDS_JSON || '[]');
    if (!Array.isArray(value) || value.some(did => typeof did !== 'string')) throw new Error();
    return new Set(value.map(did => did.replace(/\D/g, '')).filter(Boolean));
  } catch {
    console.warn('VoiceStudio shadow ASR disabled: BMSPRO_VOICESTUDIO_SHADOW_DIDS_JSON must be a JSON array of DID strings.');
    return new Set();
  }
})();
if (voiceStudioShadowEnabled && voiceStudioShadowDids.size) {
  console.log(`VoiceStudio shadow ASR enabled for ${voiceStudioShadowDids.size} allowlisted DID(s); OpenAI remains the live call path.`);
} else {
  console.log('VoiceStudio shadow ASR disabled; OpenAI remains the live call path.');
}

// ---- Server settings and validation ----

const maxCalls = Number(process.env.BMSPRO_MAX_CONCURRENT_CALLS || 4); // max simultaneous calls
if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 32) throw new Error('BMSPRO_MAX_CONCURRENT_CALLS must be an integer from 1 to 32.');
const port = Number(process.env.BMSPRO_PORT || 8787); // listening port
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BMSPRO_PORT must be an integer from 1 to 65535.');
// Playback lead (jitter buffer). Asterisk's chan_websocket queues the frames it
// receives and plays them on its own 20 ms clock, inserting silence whenever the
// queue is empty. Sending exactly one frame per 20 ms keeps that queue near empty,
// so any network delay between the bridge and Asterisk (for example an SSH tunnel)
// becomes silence in the middle of words. A lead keeps this much audio queued in
// Asterisk so short delays are absorbed, at the cost of the same fixed delay.
// 0 = off (bridge on the same server as Asterisk). Try 200-300 over a tunnel.
const playbackLeadMs = Number(process.env.BMSPRO_PLAYBACK_LEAD_MS || 0);
if (!Number.isInteger(playbackLeadMs) || playbackLeadMs < 0 || playbackLeadMs > 1000) throw new Error('BMSPRO_PLAYBACK_LEAD_MS must be an integer from 0 to 1000.');
const playbackLeadFrames = Math.round(playbackLeadMs / 20);
// Barge-in is on unless explicitly disabled (BMSPRO_BARGE_IN=false).
const bargeInEnabled = process.env.BMSPRO_BARGE_IN !== 'false';
// Backend (delegated) model speed. It runs twice for each lookup: once to choose the
// tool and once to write the answer, so its reasoning time is most of the pause
// after "let me check". "default" leaves the setting to OpenAI's model default.
const choice = (name, fallback, allowed) => {
  const value = (process.env[name]?.trim() || fallback).toLowerCase();
  if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(', ')}.`);
  return value;
};
const backendReasoningEffort = choice('BMSPRO_BACKEND_REASONING_EFFORT', 'low', ['default', 'none', 'minimal', 'low', 'medium', 'high']);
const backendVerbosity = choice('BMSPRO_BACKEND_VERBOSITY', 'low', ['default', 'low', 'medium', 'high']);
// 'priority' is faster at a higher price; see OpenAI's pricing before enabling.
const backendServiceTier = choice('BMSPRO_BACKEND_SERVICE_TIER', 'default', ['default', 'auto', 'priority']);
const backendSpeedSettings = {
  ...(backendReasoningEffort !== 'default' ? {reasoning: {effort: backendReasoningEffort}} : {}),
  ...(backendVerbosity !== 'default' ? {text: {verbosity: backendVerbosity}} : {}),
  ...(backendServiceTier !== 'default' ? {service_tier: backendServiceTier} : {}),
};
console.log(`Backend model speed: reasoning=${backendReasoningEffort} verbosity=${backendVerbosity} serviceTier=${backendServiceTier}`);
const bindHost = process.env.BMSPRO_BIND_HOST?.trim() || '127.0.0.1'; // address to bind
const bindOctets = bindHost.split('.').map(Number); 
const bindIsLoopback = bindHost === '127.0.0.1' || bindHost === '::1';
// True only for a well-formed IPv4 address in the Tailscale range 100.64.0.0 - 100.127.255.255.
const bindIsTailscale = bindOctets.length === 4 && bindOctets.every((value, index) =>
  Number.isInteger(value) && value >= 0 && value <= 255 && /^\d{1,3}$/.test(bindHost.split('.')[index] || '')) &&
  bindOctets[0] === 100 && bindOctets[1] >= 64 && bindOctets[1] <= 127;
if (!bindIsLoopback && !bindIsTailscale) throw new Error('BMSPRO_BIND_HOST must be loopback or this server’s Tailscale IPv4 address.');
const activeCalls = new Set();
const stopCalls = new Map();
let shuttingDown = false;
const ownerVoice = process.env.BMSPRO_OWNER_VOICE_ENABLED === 'true' && tenantRoutes.directTrade
  ? createOwnerVoiceHandler({
      secret: tenantRoutes.directTrade.token,
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_REALTIME_MODEL?.trim() || undefined,
    })
  : null;
// ---- HTTP server for health checks and authenticated owner voice setup ----
const liveListen = process.env.BMSPRO_LIVE_LISTEN_ENABLED === 'true' && tenantRoutes.directTrade
  ? createLiveListen(tenantRoutes.directTrade.token) : null;
const server = http.createServer((req, res) => {
  if (liveListen && !shuttingDown && /^\/live-listen\/(calls$|audio\?)/.test(req.url ?? '')) {
    liveListen.handle(req, res);
    return;
  }
  if (req.url === '/owner-voice/session' && ownerVoice && !shuttingDown) {
    void ownerVoice(req, res);
    return;
  }
  res.writeHead(req.url === '/health' ? 200 : 404, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(req.url === '/health' ? {status: 'listening', activeCalls: activeCalls.size, maxCalls, routing: 'backend-did-mappings'} : {error: 'not found'}));
});
// ---- WebSocket server for Asterisk audio (/media), subprotocol "media" ----
const wss = new WebSocketServer({noServer: true, maxPayload: 65500,
  handleProtocols: protocols => protocols.has('media') ? 'media' : false});
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/media' || shuttingDown || activeCalls.size >= maxCalls || !req.headers['sec-websocket-protocol']?.split(',').map(x => x.trim()).includes('media')) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  try { wss.handleUpgrade(req, socket, head, ws => { activeCalls.add(ws); wss.emit('connection', ws); }); }
  catch { socket.destroy(); }
});
// =============================================================================
// One WebSocket connection = one phone call. Everything below is per-call state.
// =============================================================================
wss.on('connection', media => {
  const callId = randomUUID(); // full unique caller ID
  let listenerFeed;
  const id = callId.slice(0, 8); // short ID for log lines
  const log = message => console.log(`${new Date().toISOString()} [${id}] ${message}`);
  // Transcript file writer 
  const transcript = process.env.BMSPRO_TRANSCRIPTS_ENABLED === 'false' ? null : createCallTranscript({
    callId, directory: process.env.BMSPRO_TRANSCRIPTS_DIR || './transcripts',
    onError: () => log('Transcript file could not be written; call continues.'),
  });
  // In-memory call log, sent to Trade after hang-up (direct Trade calls only).
  const callRecord = createCallRecord({callId});
  let endReason = 'call ended';
  const safeCode = value => String(value ?? 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 100);
  const safeDiagnostic = value => String(value ?? 'unknown').replace(/[\r\n\t]+/g, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/\+?(?:\d[\s().-]*){8,}/g, '[redacted-number]')
    .replace(/\b(?:sk|sess|re)_[A-Za-z0-9_-]{12,}\b/g, '[redacted-token]')
    .replace(/[^\x20-\x7E]/g, '?').slice(0, 240);
  let live, businessSession, businessConfig, voiceStudioShadow, connecting = false, ready = false, closing = false, paused = false, released = false;
  let activityConfig, activityStartedAt, ownerDestination, handoffAttempted = false;
  let dialog = null; // per-call dialog manager, created once the agent session is open
  let toolQueue = Promise.resolve();
  const handledCalls = new Set();
  let queue = Buffer.alloc(0), finalTimer;
  const draftTyping = createDraftTypingCue({onPlayback: () => log(`Typing audio: playback started (v4); mode=${safeCode(businessConfig?.mode)}.`)});
  let lastSpeechPlaybackAt = -Infinity, leadSent = false;
  const bargeIn = createBargeInDetector();
  const hangup = createHangupController();
  // Caller started a new turn: drop Sophie's queued (now stale) audio so she
  // stops straight away, like a person would. Asterisk's small playback lead is
  // flushed too and rebuilt before her next words.
  const interruptPlayback = () => {
    const sophieAudible = queue.length >= 800 || performance.now() - lastSpeechPlaybackAt < 400;
    if (!bargeInEnabled || !sophieAudible) return;
    const droppedMs = Math.round(queue.length / 8);
    queue = Buffer.alloc(0);
    draftTyping.stop();
    if (playbackLeadFrames && leadSent) { command('FLUSH_MEDIA'); leadSent = false; }
    log(`Barge-in: caller spoke; stopped Sophie and dropped ${droppedMs}ms of queued audio.`);
  };
  let inputBytes = 0, outputBytes = 0;
  let setupStartedAt, backendReadyAt, liveReadyAt, answeredAt, firstAudioAt, firstPlaybackAt;
  let toolsEnabled = false;
  let greetingTranscript = '', greetingNameConfirmed = false;

  // ---- Telemetry: POST call events to the backend. Failures are ignored so calls never break. ----
  const reportActivity = (eventType, values = {}) => {
    if (!activityConfig?.url || !activityConfig?.token) return;
    try {
      const url = new URL(activityConfig.activityUrl || activityConfig.url);
      url.pathname = '/api/ai/agent-activity/events';
      url.search = '';
      // Map the call mode to the telemetry mode and brand name.
      const mode = activityConfig.mode === 'trade' ? 'trade' : activityConfig.mode === 'pink' ? 'pink' : activityConfig.mode === 'onboarding' ? 'onboarding' : 'receptionist';
      const brand = mode === 'trade' ? 'trade' : mode === 'pink' ? 'pink' : mode === 'onboarding' ? 'onboarding' : 'black';
      const body = {
        eventId: randomUUID(), callId, eventType, mode, brand,
        did: activityConfig.did,
        businessName: activityConfig.workshop || activityConfig.businessName,
        branchName: activityConfig.branch,
        model: 'gpt-live-1 + gpt-6-luna', // live voice model + backend reasoning model
        occurredAt: new Date().toISOString(),
        ...(eventType === 'call_ended' ? {
          durationMs: activityStartedAt ? Math.max(0, Date.now() - activityStartedAt) : undefined,
          inputBytes, outputBytes,
        } : {}),
        ...values,
      };
      void fetch(url, { // fire-and-forget, 4 second timeout
        method: 'POST',
        headers: {Authorization: `Bearer ${activityConfig.activityToken || activityConfig.token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(4000),
      }).catch(() => {});
    } catch { /* Telemetry must never interrupt a live call. */ }
  };

   // ---- Token usage helpers: keep only numeric "token" fields from OpenAI usage data ----
  const safeTokenUsage = value => {
    const result = {};
    const walk = (source, target, depth = 0) => {
      if (!source || typeof source !== 'object' || Array.isArray(source) || depth > 4) return;
      for (const [key, item] of Object.entries(source)) {
        if (!/token/i.test(key)) continue;
        if (typeof item === 'number' && Number.isFinite(item) && item >= 0) target[key.slice(0, 80)] = item;
        else if (item && typeof item === 'object' && !Array.isArray(item)) {
          const nested = {}; walk(item, nested, depth + 1);
          if (Object.keys(nested).length) target[key.slice(0, 80)] = nested;
        }
      }
    };
    walk(value, result);
    return result;
  };
    // Find usage data in any of the places OpenAI may put it.
  const usageFromEvent = event => {
    for (const value of [event?.usage, event?.session?.usage, event?.response?.usage, event?.event?.usage]) {
      const usage = safeTokenUsage(value);
      if (Object.keys(usage).length) return usage;
    }
    return {};
  };
  // Send a control command (e.g. ANSWER, HANGUP) to Asterisk.
  const command = name => {
    if (media.readyState === 1) media.send(JSON.stringify({command: name}));
  };
  // final cleanup 
  const release = () => {
    if (released) return;
    released = true; clearTimeout(finalTimer); activeCalls.delete(media); stopCalls.delete(media);
    void transcript?.close(endReason);
  };
    // End the call for any reason (hangup, error, timeout, shutdown). Safe to call repeatedly.
  const finish = (reason, hangupMedia = true) => {
    if (closing) return;
    closing = true;
    listenerFeed?.close();
    endReason = reason;
    clearTimeout(setupTimer); pump.stop();
    inputAudio.stop();
    voiceStudioShadow?.end();
    draftTyping.stop();
    // A confirmed write already in flight may complete after hangup. Do not abort
    // it and retry: retain the backend's outcome and close the MCP session after it.
    // The call log is sent once that outcome is known, so it records the real result.
    callRecord.end(reason);
    void toolQueue.catch(() => {})
      .then(() => sendTradeCallRecord({config: businessConfig, businessId: businessSession?.profile?.businessId, record: callRecord, log}))
      .then(() => businessSession?.close()).catch(() => {});
    queue = Buffer.alloc(0);
    reportActivity('call_ended', {status: safeCode(reason)});
    log(`Ended: ${reason}; input=${inputBytes} bytes output=${outputBytes} bytes`);
    if (dialog) {
      const state = dialog.snapshot();
      log(`Dialog final: step=${state.step} completed=${state.completed.join(',') || 'none'} toolCalls=${state.toolCalls}`);
    }
    if (hangupMedia && media.readyState === 1) { command('HANGUP'); media.close(); }
    if (live?.socket.readyState === 1 && ready) {
      live.send({type: 'session.close'});
      finalTimer = setTimeout(() => {
        log('Final usage unavailable (close timeout).');
        live.socket.platformSocket.terminate(); release();
      }, 15000);
    } else {
      live?.socket.platformSocket.terminate(); release();
    }
  };
  const connectVoice = () => {
    log('Connecting to OpenAI.');
    live = new LiveWS(client, {reconnect: null, maxQueueSize: 64000});
    live.on('error', error => {
      // Avoid dumping SDK errors that can include credentials or caller content.
      const detail = error?.error?.error ?? error?.error ?? error;
      log(`OpenAI error; code=${safeCode(detail?.code)} type=${safeCode(detail?.type)} param=${safeCode(detail?.param)} clientEvent=${safeCode(detail?.client_event_id)} message=${safeDiagnostic(detail?.message)}`);
      finish('OpenAI error; check model access, billing and server configuration');
    });
    live.socket.on('close', () => {
      if (!closing) finish('OpenAI socket closed');
      release();
    });
  };
  // ---- Caller -> OpenAI audio: paced sender with backpressure protection ----
  const inputAudio = createInputAudioClock({
    // Only send when OpenAI is ready, the call is open, and the upstream buffer is under 64 KB.
    canSend: () => ready && !closing && live?.socket.readyState === 1 && live.socket.platformSocket.bufferedAmount <= 64000,
    send: frame => {
      listenerFeed?.input(frame);
      live.send({type: 'session.input_audio.append', audio: frame.toString('base64')});
      inputBytes += frame.length;
    },
    onError: ({code, bufferedBytes}) => {
      log(`Audio input failed: code=${safeCode(code)} queuedAudioMs=${Math.round(bufferedBytes / 8)} upstreamBufferedBytes=${live?.socket?.platformSocket?.bufferedAmount ?? 0}`);
      finish(safeCode(code));
    },
  });
  stopCalls.set(media, () => finish('bridge stopping'));
  const setupTimer = setTimeout(() => finish('setup timeout'), 60000);
  const runTool = item => {
    if (closing || typeof item.call_id !== 'string' || handledCalls.has(item.call_id)) return;
    handledCalls.add(item.call_id);
    toolQueue = toolQueue.then(async () => {
      if (closing) return;
      const toolStartedAt = performance.now();
      let result;
      const endCall = item.name === END_CALL_TOOL.name;
      const allowed = endCall || (toolsEnabled && businessSession?.tools.some(tool => tool.name === item.name) === true);
      try {
        if (!allowed || typeof item.arguments !== 'string' || item.arguments.length > (businessConfig.mode === 'onboarding' ? 65536 : 8192))
          throw new Error('Invalid tool request');
        const args = JSON.parse(item.arguments);
        // Dialog manager: block a write whose earlier steps are not done yet.
        const blocked = endCall ? null : dialog?.check(item.name) ?? null;
        if (endCall) {
          // Handled by the bridge: hang up once Sophie's goodbye has played (see the audio pump).
          result = hangup.request(performance.now());
          log('End call: requested by Sophie; hanging up after her goodbye.');
        } else if (item.name === 'transfer_to_owner') {
          if (!ownerDestination || answeredAt === undefined || handoffAttempted ||
              !args || Object.keys(args).length !== 1 || args.callerConfirmed !== true) {
            log(`Owner handoff failed: ${handoffAttempted ? 'ALREADY_ATTEMPTED' : answeredAt === undefined ? 'CALL_NOT_ANSWERED' : 'CONFIRMATION_REQUIRED'}`);
            result = {status: 'UNAVAILABLE', message: 'The transfer was not started.'};
          } else {
            handoffAttempted = true;
            draftTyping.stop();
            const current = await resolveConfigForDid(businessConfig.did, tenantRoutes).catch(() => null);
            if (closing) return;
            const stillMapped = current?.mode === 'trade' && current.businessId === businessConfig.businessId &&
              current.forwardingExtension === ownerDestination.extension;
            if (!stillMapped) log('Owner handoff failed: MAPPING_CHANGED_OR_UNAVAILABLE');
            if (stillMapped && await redirectToOwner(ownerHandoff, ownerDestination, undefined, reason => log(`Owner handoff failed: ${reason}`))) {
              log('Owner handoff accepted by Asterisk.');
              return finish('owner handoff', false);
            }
            result = {status: 'UNAVAILABLE', message: 'The owner transfer could not be started. Explain that you could not connect them.'};
          }
        } else if (blocked) result = blocked;
        else {
          draftTyping.start();
          result = await businessSession.call(item.name, args);
        }
      } catch {
        draftTyping.stop();
        result = {status: 'UNAVAILABLE', message: 'Tool execution could not complete. Do not claim that a booking or setup action succeeded.'};
      } finally {
        // Keep the cue through the post-save response delay. AI audio stops it.
        if (!result ||
            ['UNAVAILABLE', 'REJECTED', 'UNKNOWN', 'STEP_REQUIRED', 'RETRY_LIMIT'].includes(result.status)) draftTyping.stop();
      }
      // Dialog manager: update progress, then add the current step and next hint for the AI.
      if (allowed && !endCall) dialog?.record(item.name, result);
      const resultText = JSON.stringify(dialog ? dialog.annotate(result) : result);
      const rejectionCodes = new Map([
        ["Black's safe AI booking contract is not deployed. Transfer to staff.", 'BLACK_AI_BOOKING_CONTRACT_NOT_READY'],
        ['The request could not be verified. Transfer to staff; do not claim it was saved.', 'BLACK_API_REJECTED_REQUEST'],
        ['Ask for a valid customer name, email and phone; then read back and reconfirm.', 'INVALID_CUSTOMER_DETAILS'],
        ['Tool arguments must be an object.', 'INVALID_TOOL_ARGUMENTS'],
        ['Tool unavailable. No action was performed.', 'TOOL_UNAVAILABLE'],
      ]);
      // The onboarding MCP returns a stable, non-sensitive error code. Prefer
      // it over matching human-readable messages so production logs explain
      // rejected setup actions without logging owner data or action links.
      const backendCode = typeof result.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(result.code)
        ? result.code
        : undefined;
      const reason = result.status === 'REJECTED' ? ` reason=${backendCode || rejectionCodes.get(result.message) || 'UNCLASSIFIED_REJECTION'}` : '';
      reportActivity('mcp_tool', {toolName: safeCode(allowed ? item.name : 'unexpected'), status: safeCode(result.status || 'completed'), durationMs: Math.round(performance.now() - toolStartedAt)});
      callRecord.tool(allowed ? item.name : 'unexpected', result, performance.now() - toolStartedAt);
      if (allowed && item.name === 'submit_for_owner_review') {
        const notifications = result.reviewNotifications;
        log(`Owner review notifications: sms=${safeCode(notifications?.sms?.status || 'not_reported')} smsCode=${safeCode(notifications?.sms?.code || 'none')} email=${safeCode(notifications?.email?.status || 'not_reported')} emailCode=${safeCode(notifications?.email?.code || 'none')}`);
      }
      if (allowed && item.name === 'complete_business_onboarding') {
        log(`Account setup notifications: sms=${safeCode(result.accountNotifications?.sms?.status || 'not_reported')} smsCode=${safeCode(result.accountNotifications?.sms?.code || 'none')} email=${safeCode(result.accountNotifications?.email?.status || 'not_reported')} emailCode=${safeCode(result.accountNotifications?.email?.code || 'none')}`);
      }
      log(`MCP tool: ${allowed ? item.name : 'unexpected'} status=${safeCode(result.status || 'completed')}${reason} durationMs=${Math.round(performance.now() - toolStartedAt)}`);
      if (closing || live.socket.readyState !== 1) return;
      live.send({type: 'response.item.create', item: {
        type: 'function_call_output', call_id: item.call_id,
        output: resultText.length <= 128000 ? resultText : JSON.stringify({status: 'UNAVAILABLE', message: 'Business response too large; ask staff to verify. Do not infer a booking result.'}),
      }});
      live.send({type: 'response.create'});
    }).catch(() => finish('tool continuation failed'));
  };
  // Send actual PCMU frames from the moment the route is accepted, even before
  // OpenAI is ready. The Yeastar relay/NAT may need outbound RTP to learn the
  // return media path; RTP comfort-noise alone did not establish it in this setup.
  // Continue silent frames between utterances, keeping the playback queue short.
  const pump = createPacedAudioTimer({tick: () => {
    if (!connecting || closing || paused || media.readyState !== 1) return;
    if (media.bufferedAmount > 64000) return finish('media socket backpressure');
    // Keep the beginning of the greeting queued while the answered SIP/RTP
    // path settles. Continue sending silence without discarding speech.
    const playbackReady = answeredAt !== undefined && performance.now() - answeredAt >= 400;
    // Once, when playback starts: queue the jitter-buffer lead in Asterisk as
    // silence. From then on one frame per tick keeps that lead constant.
    if (playbackReady && !leadSent) {
      leadSent = true;
      for (let i = 0; i < playbackLeadFrames; i++) media.send(Buffer.alloc(160, 0xff));
      if (playbackLeadFrames) log(`Playback lead: ${playbackLeadFrames * 20}ms queued in Asterisk.`);
    }
    const length = playbackReady ? Math.min(160, queue.length) : 0;
    const frame = Buffer.alloc(160, 0xff);
    queue.copy(frame, 0, 0, length); queue = queue.subarray(length);
    const speech = pcmuHasSpeech(frame);
    if (speech) {
      lastSpeechPlaybackAt = performance.now();
      draftTyping.stop();
    }
    // Live may send encoded silence while the backend is working. Only audible
    // AI speech suppresses the local cue; receiving an audio packet alone cannot.
    const typingFrame = draftTyping.frame(!speech && answeredAt !== undefined && performance.now() - lastSpeechPlaybackAt >= 180);
    if (typingFrame) typingFrame.copy(frame);
    media.send(frame); outputBytes += typingFrame ? frame.length : length;
    listenerFeed?.output(frame);
    if (hangup.shouldHangUp({now: performance.now(), queuedBytes: queue.length, lastSpeechPlaybackAt}))
      return finish('Sophie ended the call after saying goodbye');
    if (length && firstPlaybackAt === undefined) {
      firstPlaybackAt = performance.now();
      log(`First audio sent to Asterisk: answerToPlaybackMs=${Math.round(firstPlaybackAt - answeredAt)} totalSetupMs=${Math.round(firstPlaybackAt - setupStartedAt)}`);
    }
  }, onError: () => finish('OUTPUT_AUDIO_CLOCK_STALLED')});
  pump.start();
  log('Asterisk connected; waiting for MEDIA_START.');
  media.on('message', async (data, binary) => {
    if (closing) return;
    try {
      if (binary) {
        voiceStudioShadow?.append(data);
        if (ready && live.socket.readyState === 1) {
          inputAudio.append(data);
        }
        return;
      }
      const event = JSON.parse(data.toString());
      log(`Asterisk event: ${safeCode(event.event)}`);
      if (event.event === 'MEDIA_XOFF') paused = true;
      if (event.event === 'MEDIA_XON') paused = false;
      if (event.event !== 'MEDIA_START') return;
      if (live || connecting) return finish('duplicate MEDIA_START');
      if (event.format !== 'ulaw' || Number(event.optimal_frame_size) !== 160)
        return finish('expected ulaw / 160-byte frames');
      connecting = true;
      const routingStartedAt = performance.now();

 // ---- Step 1: work out which business/mode this phone number belongs to ----
      try { businessConfig = await resolveMediaStartRoute(event, tenantRoutes); }
      catch (error) {
        const message = error instanceof Error ? error.message : '';
        const httpStatus = /^Backend DID routing lookup failed \(HTTP (\d{3})\)\.$/.exec(message)?.[1];
        const routeCodes = new Map([
          ['Missing Asterisk route variable.', 'MISSING_ROUTE_VARIABLE'],
          ['Missing or conflicting Asterisk route marker.', 'MISSING_OR_CONFLICTING_ROUTE_MARKER'],
          ['Invalid route marker.', 'INVALID_ROUTE_MARKER'],
          ['Backend DID routing lookup failed.', 'ROUTE_NETWORK_ERROR'],
          ['Backend DID routing response is invalid.', 'INVALID_ROUTE_RESPONSE'],
          ['Backend DID routing response does not match the call.', 'ROUTE_IDENTITY_MISMATCH'],
        ]);
        log(`DID routing failed: code=${httpStatus ? `ROUTE_HTTP_${httpStatus}` : routeCodes.get(message) || 'ROUTE_UNAVAILABLE'}`);
        return finish('missing or invalid route marker, backend DID routing failure, or unmapped DID');
      }
      if (closing) return;
      log(`DID route ready: durationMs=${Math.round(performance.now() - routingStartedAt)}`);
      activityConfig = businessConfig;
      // Optional: the dialplan may pass the caller's number as BMS_CALLER_ID.
      callRecord.caller(event.channel_variables?.BMS_CALLER_ID ?? event.channel_variables?.__BMS_CALLER_ID);
      if (voiceStudioShadowEnabled && voiceStudioShadowDids.has(String(businessConfig.did || '').replace(/\D/g, ''))) {
        voiceStudioShadow = createVoiceStudioShadow({
          WebSocket,
          url: process.env.BMSPRO_VOICESTUDIO_SHADOW_URL || 'ws://127.0.0.1:3900/v1/audio/transcriptions/stream?pcm=1&sr=16000',
          apiKey: process.env.BMSPRO_VOICESTUDIO_API_KEY,
          log,
          logTranscripts: process.env.BMSPRO_VOICESTUDIO_SHADOW_LOG_TRANSCRIPTS === 'true',
        });
      }
      activityStartedAt = Date.now();
      reportActivity('call_started', {status: 'routing'});
      setupStartedAt = performance.now();
      if (businessConfig.mode === 'trade') connectVoice();
      const discoveredProfile = businessConfig.discoveredProfile;
      let greetFirst = false;
      if (businessConfig.mode === 'trade' && typeof discoveredProfile?.businessName === 'string' &&
          discoveredProfile.businessName.trim() && typeof discoveredProfile.timezone === 'string') {
        try {
          new Intl.DateTimeFormat('en-AU', {timeZone: discoveredProfile.timezone});
          greetFirst = true;
        } catch { /* The regular MCP startup validates the profile before greeting. */ }
      }
      const toolsUpdateId = `trade_tools_${callId}`;
      let toolsUpdateSent = false, setupFailed = false, callerSpokeBeforeTools = false, dateInstructions;
      const backendPrompt = () => [
        businessSession.backendInstructions ?? backendInstructions(businessConfig), END_CALL_BACKEND_RULE,
        businessSession.turnInstructions || '', dateInstructions, dialog?.enforce ? DIALOG_INSTRUCTIONS : '',
      ].join(' ');
      const steerVoice = (suffix, content) => live.send({
        type: 'session.instructions.append', event_id: `${suffix}_${callId}`, delegation_id: null, content,
      });
      const resumeCaller = (suffix, content) => {
        steerVoice(suffix, content);
        if (callerSpokeBeforeTools) live.send({
          type: 'session.commentary.append', event_id: `${suffix}_resume_${callId}`, delegation_id: null, content,
        });
      };
      const enableTradeTools = () => {
        if (!greetFirst || !ready || closing || toolsUpdateSent) return;
        if (setupFailed) {
          resumeCaller('trade_unavailable', 'Trade tools could not connect for this call. If the caller asked for an action, explain it could not be completed. Never claim a booking, lookup or transfer succeeded.');
          return;
        }
        if (!businessSession) return;
        toolsUpdateSent = true;
        live.send({type: 'session.update', event_id: toolsUpdateId, session: {delegation: {
          type: 'responses', responses: {tools: [...businessSession.tools, END_CALL_TOOL], tool_choice: 'auto', instructions: backendPrompt()},
        }}});
      };

    // ---- Step 2: open the call-scoped MCP tool session for the matching mode ----     
      const prepareBusiness = async () => {
        log(`Opening a call-scoped ${businessConfig.mode} MCP session for DID ${businessConfig.did}.`);
        const timing = {onTiming: (phase, elapsedMs) => log(`MCP startup: phase=${phase} durationMs=${elapsedMs}`)};
        try {
          businessSession = await openAgentSession(businessConfig, timing);
        } catch (error) {
          log(`MCP setup failed: mode=${businessConfig.mode} code=${safeCode(error?.code)}`);
          if (greetFirst) {
            setupFailed = true;
            enableTradeTools();
            return;
          }
          return finish('MCP setup unavailable; check endpoint, feature flags and DID assignment');
        }
        if (closing) { await businessSession.close(); return; }
        backendReadyAt = performance.now();
        log(`MCP ready: setupMs=${Math.round(backendReadyAt - setupStartedAt)}`);
        businessConfig = businessSession.config;
        const handoff = ownerHandoffReadiness(ownerHandoff, businessConfig, event.channel_variables);
        if (handoff.status !== 'NOT_TRADE_ROUTE') log(`Owner handoff: ${handoff.status}`);
        if (handoff.status === 'READY') {
          ownerDestination = handoff;
          businessSession.tools.push({
            type: 'function', name: 'transfer_to_owner', strict: false,
            description: 'Transfer the live caller to the business owner. Offer when the caller asks for a human or you cannot help. Wait for a clear yes, say you will put them through, then call once.',
            parameters: {type: 'object', properties: {callerConfirmed: {type: 'boolean', const: true}},
              required: ['callerConfirmed'], additionalProperties: false},
          });
          const handoffInstructions = ' For this call, transfer_to_owner is available. If the caller asks for a person or you cannot help, offer to connect them to the owner. Wait for a clear yes, tell them you will put them through, then call transfer_to_owner once. If it fails, explain that you could not connect them.';
          businessSession.voiceInstructions = businessSession.voiceInstructions.replace(' or transfer actions', '') + handoffInstructions;
          businessSession.backendInstructions += handoffInstructions;
        }
        if (dialogMode !== 'off') dialog = createDialogManager({mode: businessConfig.mode, enforce: dialogMode === 'on', log});
        transcript?.metadata({did: businessConfig.did, mode: businessConfig.mode,
          businessName: businessConfig.businessName || businessConfig.workshop, businessId: businessConfig.businessId || businessSession.profile?.businessId});
        if (businessConfig && activityConfig) {
          activityConfig = {...activityConfig, ...businessConfig, url: activityConfig.url, token: activityConfig.token, did: activityConfig.did};
        }
        enableTradeTools();
      };
      if (greetFirst) {
        void prepareBusiness().catch(() => {
          setupFailed = true;
          enableTradeTools();
        });
      } else {
        await prepareBusiness();
        if (closing) return;
        toolsEnabled = true;
      }

         // ---- Step 3: pick the fixed Sophie greeting for this mode ---- 
      const greeting = greetFirst
        ? `Greet the caller in English: "Hi, thanks for calling ${JSON.stringify(discoveredProfile.businessName)}. My name is Sophie, your AI receptionist. How can I help?" Then pause and listen. Pronounce Sophie as SOH-fee.`
        : openingGreeting(businessConfig);
      
      // ---- Step 4: open the OpenAI Live (realtime voice) connection ----
      if (!live) connectVoice();
      const startVoice = () => {
        if (closing) return live.socket.platformSocket.terminate();
        const timeZone = businessSession?.profile?.timezone || (greetFirst ? discoveredProfile.timezone : businessConfig.timezone) || 'Australia/Melbourne';
        const localNow = new Intl.DateTimeFormat('en-AU', {timeZone, dateStyle: 'full', timeStyle: 'short'}).format(new Date());
        dateInstructions = `At session start the current local date and time is ${localNow}, timezone ${timeZone}. Use this to resolve today, tomorrow and dates without a year. Clarify ambiguous dates immediately, before any other form field; never invent a weekday or postpone the year question until submission. Use ISO dates including the resolved year in tools.`;
        log(greetFirst ? 'Trade greeting-first startup: MCP can load after greeting.' :
          'Conversation flow v11: portal questions only; service and advice inspections can schedule when Trade confirms staff.');
        live.send({type: 'session.start', session: {
          model: 'gpt-live-1', store: false,
          instructions: [
            greetFirst
              ? `You are the receptionist for ${JSON.stringify(discoveredProfile.businessName)}. Greet and listen while Trade connects. If a caller asks for a booking, business lookup or transfer before the tools are ready, acknowledge their request briefly and retain what they said. Wait for the tool-ready instruction before delegating. Never invent business details or claim an action succeeded without a verified result.`
              : businessSession.voiceInstructions ?? voiceInstructions(businessConfig),
            'Your name is Sophie. Identify yourself as Sophie, the AI assistant, in the opening greeting. For onboarding, you are Sophie from BMS Pro helping with business setup; do not ask the caller to choose an AI receptionist name.',
            'Keep routine replies to one or two short sentences and ask one question at a time. If backend work takes time, briefly acknowledge the request while waiting; do not announce an unverified result.',
            'If the caller starts talking while you are speaking, stop at once, listen to them and respond to what they said; do not finish or repeat the sentence you were saying.',
            END_CALL_VOICE_RULE,
            greetFirst ? '' : businessSession.turnInstructions || '',
            dateInstructions,
          ].join(' '),
          input: [{role: 'developer', content: [{type: 'input_text', text: greeting}]}],
          // Pin one voice for the whole call; changing voices between routes sounds like speaker switching.
          audio: {format: {type: 'audio/pcmu', rate: 8000}, output: {voice: 'shimmer'}},
          delegation: {type: 'responses', responses: {
            model: 'gpt-6-luna', parallel_tool_calls: false,
            ...backendSpeedSettings,
            ...(greetFirst ? {
              tools: [], tool_choice: 'none',
              instructions: 'Trade is connecting. Retain the caller’s request and acknowledge it briefly. Do not claim an action was performed.',
            } : {tools: [...businessSession.tools, END_CALL_TOOL], instructions: backendPrompt()}),
          }}
        }});
      };
    // ---- Events coming from OpenAI Live ----
      live.on('event', event => {
        transcript?.event(event);
        callRecord.event(event);
        if (!closing && answeredAt !== undefined && bargeIn.isNewCallerTurn(event)) {
          interruptPlayback();
          // The caller is still talking after Sophie offered to end the call: stay on the line.
          if (hangup.cancel()) log('End call: cancelled because the caller kept talking.');
        }
        // Inspect only the beginning of assistant speech; never print transcript
        // content. This distinguishes generated wording from playback clipping.
        if (event.type === 'session.output_transcript.delta' && !greetingNameConfirmed && greetingTranscript.length < 1200) {
          greetingTranscript += typeof event.delta === 'string' ? event.delta.slice(0, 1200 - greetingTranscript.length) : '';
          if (/\bsophie\b/i.test(greetingTranscript)) {
            greetingNameConfirmed = true;
            greetingTranscript = '';
            log('Greeting v3: assistant transcript includes Sophie.');
          }
        }
        if (event.type === 'error') {
          log(`OpenAI server error: code=${safeCode(event.error?.code)} type=${safeCode(event.error?.type)} param=${safeCode(event.error?.param)} clientEvent=${safeCode(event.error?.client_event_id)} message=${safeDiagnostic(event.error?.message)}`);
          if (!closing && event.error?.client_event_id === toolsUpdateId) {
            setupFailed = true;
            toolsEnabled = false;
            resumeCaller('trade_update_failed', 'Trade tools are unavailable. If the caller requested an action, explain it could not be completed.');
          }
        }
        // Log types and error codes only: never transcripts, audio, keys or session snapshots.
        if (event.type !== 'session.output_audio.delta' && !event.type.includes('transcript'))
          log(`OpenAI event: ${safeCode(event.type)}`);
        if (event.type === 'session.usage.updated') {
          const usage = usageFromEvent(event);
          if (Object.keys(usage).length) reportActivity('usage_updated', {usage});
        }
        if (!closing && answeredAt !== undefined && event.type === 'session.delegation.created') draftTyping.start();
        if (event.type === 'response.event') {
          const nested = event.event ?? event.response_event;
          if (!closing && nested?.type === 'response.output_item.added' &&
              nested.item?.type === 'function_call' &&
              toolsEnabled && businessSession?.tools.some(tool => tool.name === nested.item.name)) draftTyping.start();
          if (nested?.type === 'response.failed' || nested?.type === 'error' ||
              (nested?.type === 'response.done' && ['failed', 'cancelled', 'incomplete'].includes(nested.response?.status))) draftTyping.stop();
          if (nested?.type === 'response.output_item.done' && nested.item?.type === 'function_call') runTool(nested.item);
          if (nested?.type === 'response.failed' || nested?.type === 'response.done' || nested?.type === 'error')
            log(`Backend: ${safeCode(nested.type)} status=${safeCode(nested.response?.status)} code=${safeCode(nested.error?.code ?? nested.response?.status_details?.error?.code)}`);
        }
        if (event.type === 'session.closed') {
          const finalUsage = usageFromEvent(event);
          if (Object.keys(finalUsage).length) reportActivity('usage_updated', {usage: finalUsage});
          log(`OpenAI session finalized; reason=${safeCode(event.reason)}`);
          if (!closing) { ready = false; finish('OpenAI session closed'); }
          live.close(); release(); return;
        }
        if (closing) return;
        if (greetFirst && !toolsEnabled && event.type === 'session.input_transcript.delta' && event.delta?.trim()) {
          callerSpokeBeforeTools = true;
        }
        if (event.type === 'session.updated' && toolsUpdateSent && !toolsEnabled && !setupFailed &&
            (!event.client_event_id || event.client_event_id === toolsUpdateId)) {
          toolsEnabled = true;
          log(`Trade tools attached: totalSetupMs=${Math.round(performance.now() - setupStartedAt)}`);
          resumeCaller('trade_ready', 'Trade tools are ready. If the caller is waiting on a request, continue it now using the details they already gave. Delegate business facts, availability, bookings and transfers to the backend. Ask only the next question required by the backend workflow. Confirm actions only from verified tool results.');
        }
        if (event.type === 'session.started') {
          if (ready) return;
          ready = true;
          liveReadyAt = performance.now();
          inputAudio.start();
          // Request once after readiness as well as seeding session.input. Keep
          // the media clock running; do not wait for caller speech to trigger it.
          live.send({type: 'session.commentary.append', event_id: `greeting_${callId}`, delegation_id: null, content: greeting});
          log('Greeting v3: requested Sophie introduction; playback guard=400ms.');
          log(`OpenAI ready; generating opening greeting before answer. voiceReadyMs=${Math.round(liveReadyAt - (greetFirst ? setupStartedAt : backendReadyAt))} totalSetupMs=${Math.round(liveReadyAt - setupStartedAt)}`);
          enableTradeTools();
        }
        if (event.type === 'session.output_audio.delta' && ready) {
          const chunk = Buffer.from(event.delta, 'base64');
          if (!chunk.length) return;
          // Live streams encoded silence too. It is not evidence that Sophie
          // greeted the caller, and must not trigger ANSWER or first-audio logs.
          if (firstAudioAt === undefined && !pcmuHasSpeech(chunk)) return;
          if (chunk.length && firstAudioAt === undefined) {
            firstAudioAt = performance.now();
            // With chan_websocket's n option, the caller keeps hearing ringing
            // until actual greeting audio is available, not just session.started.
            command('ANSWER');
            answeredAt = performance.now();
            listenerFeed = liveListen?.start(callId, businessConfig);
            clearTimeout(setupTimer);
            reportActivity('call_answered', {status: 'answered'});
            callRecord.answered();
            callRecord.setup(firstAudioAt - setupStartedAt);
            log(`Audible greeting audio ready; answered call. greetingGenerationMs=${Math.round(firstAudioAt - liveReadyAt)} totalSetupMs=${Math.round(firstAudioAt - setupStartedAt)}`);
          }
          if (queue.length + chunk.length > 80000) return finish('output backlog exceeded ten seconds');
          queue = Buffer.concat([queue, chunk]);
        }
      });
      if (live.socket.readyState === WebSocket.OPEN) startVoice();
      else live.socket.on('open', startVoice);
    } catch { finish('invalid event or connection error'); }
  });
  media.on('error', () => finish('Asterisk socket error'));
  media.on('close', () => finish('caller disconnected'));
});
server.on('error', error => { console.error(`Listener error: ${error.code}`); process.exitCode = 1; });
server.listen(port, bindHost, () => console.log(`BMSPro voice pilot listening at ws://${bindHost}:${port}/media`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  shuttingDown = true;
  for (const stop of stopCalls.values()) stop();
  server.close();
  setTimeout(() => process.exit(0), 16000).unref();
});
