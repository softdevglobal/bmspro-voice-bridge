
// Maximum amount of incoming u-law(PCMU) audio data
const MAX_PENDING_ULAW_BYTES = 8000; // One second at 8 kHz PCMU.
// Maximum amount of outgoing audio data that can wait
const MAX_WS_BUFFERED_BYTES = 256_000;
// PCM16 meansthe Pulse-Code Modulation 
// way of representing audio as numerical values
function ulawSampleToPcm16(byte) {
  const value = (~byte) & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return sign ? -magnitude : magnitude;
}

// Asterisk supplies 8 kHz PCMU. VoiceStudio's speech stream accepts signed
// 16-bit mono PCM at 16 kHz, so decode PCMU and linearly upsample each frame.
function ulaw8kToPcm16k(input) {
  const ulaw = Buffer.from(input);
  const output = Buffer.allocUnsafe(ulaw.length * 4);
  for (let i = 0; i < ulaw.length; i++) {
    const sample = ulawSampleToPcm16(ulaw[i]);
    const next = i + 1 < ulaw.length ? ulawSampleToPcm16(ulaw[i + 1]) : sample;
    output.writeInt16LE(sample, i * 4);
    output.writeInt16LE(Math.round((sample + next) / 2), i * 4 + 2);
  }
  // return the converted 16h kHz audio buffer
  return output;
}

function safeCode(value) {
  return String(value ?? 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 80) || 'unknown';
}

// create VoiceStudio shadow connection
export function createVoiceStudioShadow({WebSocket, url, apiKey, log, logTranscripts = false}) {
  const report = message => { try { log(`VoiceStudio shadow: ${message}`); } catch {} };
  if (!apiKey) {
    report('skipped; API key is not configured. The OpenAI call path is unaffected.');
    return null;
  }

  let endpoint;
  try {
    endpoint = new URL(url);
    const localWs = endpoint.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
    if (endpoint.protocol !== 'wss:' && !localWs) throw new Error('unsafe endpoint');
    if (endpoint.pathname !== '/v1/audio/transcriptions/stream') throw new Error('unexpected endpoint path');
    endpoint.searchParams.set('pcm', '1');
    endpoint.searchParams.set('sr', '16000');
  } catch {
    report('skipped; URL must be the VoiceStudio streaming endpoint on loopback or use WSS. The OpenAI call path is unaffected.');
    return null;
  }

  let socket;
  try {
    socket = new WebSocket(endpoint, {headers: {Authorization: `Bearer ${apiKey}`}, handshakeTimeout: 2500, maxPayload: 1_000_000});
  } catch {
    report('connect failed; continuing the call without shadow ASR.');
    return null;
  }

  // initialize  connection state and tracking variable
  let state = 'connecting';
  let ended = false;
  let failed = false;
  let connectTimer;
  let closeTimer;
  let pending = [];
  let pendingBytes = 0;
  let audioBytes = 0;
  let droppedBytes = 0;
  let finalEvents = 0;

  // Release tempory resources and clear pending audio
  const cleanup = () => {
    clearTimeout(connectTimer);
    clearTimeout(closeTimer);
    pending = [];
    pendingBytes = 0;
  };
  const fail = code => {
    if (failed || ended) return;
    failed = true;
    state = 'failed';
    cleanup();
    report(`unavailable code=${safeCode(code)}; continuing the call on OpenAI.`);
    try { if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate(); } catch {}
  }; 
  const sendAudio = ulaw => { // send audot to VoiceStudio
    if (state !== 'open' || socket.readyState !== WebSocket.OPEN) {
      droppedBytes += ulaw.length;
      return;
    }
    if (socket.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      droppedBytes += ulaw.length;
      return;
    }
    try {
      const pcm = ulaw8kToPcm16k(ulaw);
      socket.send(pcm, {binary: true}, error => {
        if (error) fail('audio_send_failed');
      });
      audioBytes += pcm.length;
    } catch { fail('audio_send_failed'); }
  };

  connectTimer = setTimeout(() => fail('connect_timeout'), 3000);
  connectTimer.unref?.();
  socket.on('open', () => {
    if (ended || failed) return socket.close();
    clearTimeout(connectTimer);
    state = 'open';
    report('connected; streaming mirrored call audio.');
    for (const chunk of pending) sendAudio(chunk);
    pending = [];
    pendingBytes = 0;
  });
  socket.on('message', raw => {
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return; }
    if (event.type === 'session.started') {
      report('speech session started.');
    } else if (event.type === 'final') {
      finalEvents++;
      const text = typeof event.text === 'string' ? event.text.replace(/[\r\n\t]+/g, ' ').slice(0, 500) : '';
      report(`transcript final kind=${safeCode(event.final_kind)} chars=${text.length}${logTranscripts && text ? ` text="${text}"` : ''}`);
    } else if (event.type === 'error') {
      fail(event.code || 'stream_error');
    }
  });
  socket.on('error', () => fail('socket_error'));
  socket.on('close', () => {
    const wasOpen = state === 'open';
    state = ended ? 'closed' : state;
    cleanup();
    if (!ended && !failed) fail('socket_closed');
    else if (ended) report(`closed; audioBytes=${audioBytes} droppedInputBytes=${droppedBytes} finalEvents=${finalEvents}${wasOpen ? '' : ' (not connected)'}.`);
  });

  return {
    append(data) {
      if (ended || failed || !data?.length) return;
      const chunk = Buffer.from(data);
      if (state === 'open') return sendAudio(chunk);
      if (state !== 'connecting') return;
      if (pendingBytes + chunk.length > MAX_PENDING_ULAW_BYTES) {
        droppedBytes += chunk.length;
        return;
      }
      pending.push(chunk);
      pendingBytes += chunk.length;
    },
    end() {
      if (ended) return;
      ended = true;
      clearTimeout(connectTimer);
      if (state === 'open' && socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({type: 'input_audio.end'})); } catch {}
        closeTimer = setTimeout(() => {
          try { if (socket.readyState === WebSocket.OPEN) socket.close(1000); } catch {}
        }, 2500);
        closeTimer.unref?.();
      } else {
        cleanup();
        try { if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.terminate(); } catch {}
      }
    },
  };
}
