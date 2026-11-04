import http from 'node:http';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { LiveWS } from 'openai/resources/live/ws';
import { WebSocket, WebSocketServer } from 'ws';
import {openBusinessSession, voiceInstructions, backendInstructions} from './business-tools.mjs';
import {openOnboardingSession} from './onboarding-tools.mjs';
import {openTradeSession} from './trade-tools.mjs';
import {openPinkSession} from './pink-tools.mjs';
import {loadTenantRoutes, resolveMediaStartRoute} from './tenant-routing.mjs';
import {createInputAudioClock, createPacedAudioTimer} from './input-audio.mjs';
import {createDraftTypingCue, pcmuHasSpeech} from './draft-typing.mjs';
import {createVoiceStudioShadow} from './voice-studio-shadow.mjs';
import {createCallTranscript} from './call-transcript.mjs';

// Independent tenant and tool state per call; no application duration cutoff.
if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY in .env first.');
let tenantRoutes;
try {
  tenantRoutes = loadTenantRoutes();
  console.log('Backend DID routing configured. Black, Pink, Trade and onboarding numbers use separate tools.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'MCP readiness check failed.');
  process.exit(1);
}
const client = new OpenAI();
console.log('Audio pacing follows elapsed time; bounded catch-up enabled.');
const voiceStudioShadowEnabled = process.env.BMSPRO_VOICESTUDIO_SHADOW_ENABLED === 'true';
const voiceStudioShadowDids = (() => {
  try {
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
const maxCalls = Number(process.env.BMSPRO_MAX_CONCURRENT_CALLS || 4);
if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 32) throw new Error('BMSPRO_MAX_CONCURRENT_CALLS must be an integer from 1 to 32.');
const port = Number(process.env.BMSPRO_PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BMSPRO_PORT must be an integer from 1 to 65535.');
const bindHost = process.env.BMSPRO_BIND_HOST?.trim() || '127.0.0.1';
const bindOctets = bindHost.split('.').map(Number);
const bindIsLoopback = bindHost === '127.0.0.1' || bindHost === '::1';
const bindIsTailscale = bindOctets.length === 4 && bindOctets.every((value, index) =>
  Number.isInteger(value) && value >= 0 && value <= 255 && /^\d{1,3}$/.test(bindHost.split('.')[index] || '')) &&
  bindOctets[0] === 100 && bindOctets[1] >= 64 && bindOctets[1] <= 127;
if (!bindIsLoopback && !bindIsTailscale) throw new Error('BMSPRO_BIND_HOST must be loopback or this server’s Tailscale IPv4 address.');
const activeCalls = new Set();
const stopCalls = new Map();
let shuttingDown = false;
const server = http.createServer((req, res) => {
  res.writeHead(req.url === '/health' ? 200 : 404, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(req.url === '/health' ? {status: 'listening', activeCalls: activeCalls.size, maxCalls, routing: 'backend-did-mappings'} : {error: 'not found'}));
});
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
wss.on('connection', media => {
  const callId = randomUUID();
  const id = callId.slice(0, 8);
  const log = message => console.log(`${new Date().toISOString()} [${id}] ${message}`);
  const transcript = process.env.BMSPRO_TRANSCRIPTS_ENABLED === 'false' ? null : createCallTranscript({
    callId, directory: process.env.BMSPRO_TRANSCRIPTS_DIR || './transcripts',
    onError: () => log('Transcript file could not be written; call continues.'),
  });
  let endReason = 'call ended';
  const safeCode = value => String(value ?? 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 100);
  const safeDiagnostic = value => String(value ?? 'unknown').replace(/[\r\n\t]+/g, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/\+?(?:\d[\s().-]*){8,}/g, '[redacted-number]')
    .replace(/\b(?:sk|sess|re)_[A-Za-z0-9_-]{12,}\b/g, '[redacted-token]')
    .replace(/[^\x20-\x7E]/g, '?').slice(0, 240);
  let live, businessSession, businessConfig, voiceStudioShadow, connecting = false, ready = false, closing = false, paused = false, released = false;
  let activityConfig, activityStartedAt;
  let toolQueue = Promise.resolve();
  const handledCalls = new Set();
  let queue = Buffer.alloc(0), finalTimer;
  const draftTyping = createDraftTypingCue({onPlayback: () => log(`Typing audio: playback started (v4); mode=${safeCode(businessConfig?.mode)}.`)});
  let lastSpeechPlaybackAt = -Infinity;
  let inputBytes = 0, outputBytes = 0;
  let setupStartedAt, backendReadyAt, liveReadyAt, answeredAt, firstAudioAt, firstPlaybackAt;
  let greetingTranscript = '', greetingNameConfirmed = false;
  const reportActivity = (eventType, values = {}) => {
    if (!activityConfig?.url || !activityConfig?.token) return;
    try {
      const url = new URL(activityConfig.activityUrl || activityConfig.url);
      url.pathname = '/api/ai/agent-activity/events';
      url.search = '';
      const mode = activityConfig.mode === 'trade' ? 'trade' : activityConfig.mode === 'pink' ? 'pink' : activityConfig.mode === 'onboarding' ? 'onboarding' : 'receptionist';
      const brand = mode === 'trade' ? 'trade' : mode === 'pink' ? 'pink' : mode === 'onboarding' ? 'onboarding' : 'black';
      const body = {
        eventId: randomUUID(), callId, eventType, mode, brand,
        did: activityConfig.did,
        businessName: activityConfig.workshop || activityConfig.businessName,
        branchName: activityConfig.branch,
        model: 'gpt-live-1 + gpt-6-luna',
        occurredAt: new Date().toISOString(),
        ...(eventType === 'call_ended' ? {
          durationMs: activityStartedAt ? Math.max(0, Date.now() - activityStartedAt) : undefined,
          inputBytes, outputBytes,
        } : {}),
        ...values,
      };
      void fetch(url, {
        method: 'POST',
        headers: {Authorization: `Bearer ${activityConfig.activityToken || activityConfig.token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(4000),
      }).catch(() => {});
    } catch { /* Telemetry must never interrupt a live call. */ }
  };
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
  const usageFromEvent = event => {
    for (const value of [event?.usage, event?.session?.usage, event?.response?.usage, event?.event?.usage]) {
      const usage = safeTokenUsage(value);
      if (Object.keys(usage).length) return usage;
    }
    return {};
  };
  const command = name => {
    if (media.readyState === 1) media.send(JSON.stringify({command: name}));
  };
  const release = () => {
    if (released) return;
    released = true; clearTimeout(finalTimer); activeCalls.delete(media); stopCalls.delete(media);
    void transcript?.close(endReason);
  };
  const finish = reason => {
    if (closing) return;
    closing = true;
    endReason = reason;
    clearTimeout(setupTimer); pump.stop();
    inputAudio.stop();
    voiceStudioShadow?.end();
    draftTyping.stop();
    // A confirmed write already in flight may complete after hangup. Do not abort
    // it and retry: retain the backend's outcome and close the MCP session after it.
    void toolQueue.then(() => businessSession?.close()).catch(() => {});
    queue = Buffer.alloc(0);
    reportActivity('call_ended', {status: safeCode(reason)});
    log(`Ended: ${reason}; input=${inputBytes} bytes output=${outputBytes} bytes`);
    if (media.readyState === 1) { command('HANGUP'); media.close(); }
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
  const inputAudio = createInputAudioClock({
    canSend: () => ready && !closing && live?.socket.readyState === 1 && live.socket.platformSocket.bufferedAmount <= 64000,
    send: frame => {
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
      const allowed = businessSession?.tools.some(tool => tool.name === item.name) === true;
      try {
        if (!allowed || typeof item.arguments !== 'string' || item.arguments.length > (businessConfig.mode === 'onboarding' ? 65536 : 8192))
          throw new Error('Invalid tool request');
        const args = JSON.parse(item.arguments);
        draftTyping.start();
        result = await businessSession.call(item.name, args);
      } catch {
        draftTyping.stop();
        result = {status: 'UNAVAILABLE', message: 'Tool execution could not complete. Do not claim that a booking or setup action succeeded.'};
      } finally {
        // Keep the cue through the post-save response delay. AI audio stops it.
        if (!result ||
            ['UNAVAILABLE', 'REJECTED', 'UNKNOWN'].includes(result.status)) draftTyping.stop();
      }
      const resultText = JSON.stringify(result);
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
      activityConfig = businessConfig;
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
      connecting = true;
      setupStartedAt = performance.now();
      log(`Opening a call-scoped ${businessConfig.mode} MCP session for DID ${businessConfig.did}.`);
      const timing = {onTiming: (phase, elapsedMs) => log(`MCP startup: phase=${phase} durationMs=${elapsedMs}`)};
      try {
        businessSession = await (businessConfig.mode === 'onboarding' ? openOnboardingSession(businessConfig)
          : businessConfig.mode === 'trade' ? openTradeSession(businessConfig, timing)
            : businessConfig.mode === 'pink' ? openPinkSession(businessConfig, timing) : openBusinessSession(businessConfig, timing));
      } catch (error) {
        log(`MCP setup failed: mode=${businessConfig.mode} code=${safeCode(error?.code)}`);
        return finish('MCP setup unavailable; check endpoint, feature flags and DID assignment');
      }
      if (closing) { await businessSession.close(); return; }
      backendReadyAt = performance.now();
      log(`MCP ready: setupMs=${Math.round(backendReadyAt - setupStartedAt)}`);
      businessConfig = businessSession.config;
      transcript?.metadata({did: businessConfig.did, mode: businessConfig.mode,
        businessName: businessConfig.businessName || businessConfig.workshop, businessId: businessConfig.businessId || businessSession.profile?.businessId});
      if (businessConfig && activityConfig) {
        activityConfig = {...activityConfig, ...businessConfig, url: activityConfig.url, token: activityConfig.token, did: activityConfig.did};
      }
      log('Connecting to OpenAI.');
      const openingGreeting = businessConfig.mode === 'onboarding'
        ? 'Speak this greeting in English, preserving the complete sentence "My name is Sophie": "Hi, thanks for calling BMS Pro. My name is Sophie, your AI assistant. Shall we get your business set up?" Pronounce Sophie as SOH-fee. Then pause and listen. Do not call a tool before greeting.'
        : businessConfig.mode === 'pink'
          ? `Speak this greeting in English, preserving the complete sentence "My name is Sophie": "Hello, thank you for calling ${JSON.stringify(businessConfig.businessName)}, ${JSON.stringify(businessConfig.branch)}. My name is Sophie, your AI receptionist. How can I help?" Pronounce Sophie as SOH-fee. Then pause and listen. Do not call a tool before greeting.`
        : businessConfig.mode === 'trade'
          ? `Speak this greeting in English, preserving the complete sentence "My name is Sophie": "Hi, thanks for calling ${JSON.stringify(businessConfig.businessName)}. My name is Sophie, your AI receptionist. How can I help?" Pronounce Sophie as SOH-fee. Then pause and listen. Do not call a tool before greeting.`
          : `Speak this greeting in English, preserving the complete sentence "My name is Sophie": "Hello, thank you for calling ${JSON.stringify(businessConfig.workshop)}, ${JSON.stringify(businessConfig.branch)}. My name is Sophie, your AI receptionist. How can I help?" Pronounce Sophie as SOH-fee. Then pause and listen. Do not call a tool before greeting.`;
      live = new LiveWS(client, {reconnect: null, maxQueueSize: 64000});
      live.on('error', error => {
        // Do not dump SDK errors: headers, secrets or caller content may be included.
        const detail = error?.error?.error ?? error?.error ?? error;
        log(`OpenAI error; code=${safeCode(detail?.code)} type=${safeCode(detail?.type)} param=${safeCode(detail?.param)} clientEvent=${safeCode(detail?.client_event_id)} message=${safeDiagnostic(detail?.message)}`);
        finish('OpenAI error; check model access, billing and server configuration');
      });
      live.socket.on('open', () => {
        if (closing) return live.socket.platformSocket.terminate();
        live.send({type: 'session.start', session: {
          model: 'gpt-live-1', store: false,
          instructions: [
            businessSession.voiceInstructions ?? voiceInstructions(businessConfig),
            'Your name is Sophie. Identify yourself as Sophie, the AI assistant, in the opening greeting. For onboarding, you are Sophie from BMS Pro helping with business setup; do not ask the caller to choose an AI receptionist name.',
            'Keep routine replies to one or two short sentences and ask one question at a time. If backend work takes time, briefly acknowledge the request while waiting; do not announce an unverified result.',
          ].join(' '),
          input: [{role: 'developer', content: [{type: 'input_text', text: openingGreeting}]}],
          // Pin one voice for the whole call; changing voices between routes sounds like speaker switching.
          audio: {format: {type: 'audio/pcmu', rate: 8000}, output: {voice: 'shimmer'}},
          delegation: {type: 'responses', responses: {
            model: 'gpt-6-luna', tools: businessSession.tools, parallel_tool_calls: false,
            instructions: businessSession.backendInstructions ?? backendInstructions(businessConfig)
          }}
        }});
      });
      live.on('event', event => {
        transcript?.event(event);
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
              businessSession.tools.some(tool => tool.name === nested.item.name)) draftTyping.start();
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
        if (event.type === 'session.started') {
          if (ready) return;
          ready = true;
          liveReadyAt = performance.now();
          inputAudio.start();
          // Request once after readiness as well as seeding session.input. Keep
          // the media clock running; do not wait for caller speech to trigger it.
          live.send({type: 'session.commentary.append', event_id: `greeting_${callId}`, delegation_id: null, content: openingGreeting});
          log('Greeting v3: requested Sophie introduction; playback guard=400ms.');
          log(`OpenAI ready; generating opening greeting before answer. openAiSetupMs=${Math.round(liveReadyAt - backendReadyAt)} totalSetupMs=${Math.round(liveReadyAt - setupStartedAt)}`);
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
            clearTimeout(setupTimer);
            reportActivity('call_answered', {status: 'answered'});
            log(`Audible greeting audio ready; answered call. greetingGenerationMs=${Math.round(firstAudioAt - liveReadyAt)} totalSetupMs=${Math.round(firstAudioAt - setupStartedAt)}`);
          }
          if (queue.length + chunk.length > 80000) return finish('output backlog exceeded ten seconds');
          queue = Buffer.concat([queue, chunk]);
        }
      });
      live.socket.on('close', () => {
        if (!closing) finish('OpenAI socket closed');
        release();
      });
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
