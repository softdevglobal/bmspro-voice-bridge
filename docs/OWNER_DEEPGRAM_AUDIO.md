# Talk to Sophie: Deepgram browser audio

Implemented locally; live browser/microphone acceptance and deployment are still required. Phone-call provider selection and DID mapping are unchanged by this feature. Owner sessions use the authenticated Trade business, not a caller DID.

## Trade configuration

    AI_OWNER_VOICE_DEEPGRAM_ENABLED=true
    AI_OWNER_VOICE_PUBLIC_WS_URL=wss://YOUR_VOICE_HOST/owner-voice/audio

Keep AI_OWNER_VOICE_BRIDGE_URL and AI_VOICE_BRIDGE_SECRET unchanged. The HTTP bridge URL is server-to-server; PUBLIC_WS_URL must be reachable directly by the owner's browser. Hosted HTTPS Trade needs a secure WSS endpoint with a valid certificate. Do not put localhost in a deployed site's configuration to refer to the server: localhost means the owner's device.

For local Trade served on HTTP localhost, an existing local SSH forward to the bridge may be used:

    AI_OWNER_VOICE_PUBLIC_WS_URL=ws://127.0.0.1:18788/owner-voice/audio

Use the actual local forwarded port, not necessarily 18788. Keep the tunnel open. No API key or bridge shared secret belongs in a NEXT_PUBLIC variable.

## Main voice bridge configuration

    BMSPRO_OWNER_DEEPGRAM_ENABLED=true
    BMSPRO_AUDIO_PROVIDER=deepgram

Use the existing server-injected DEEPGRAM_API_KEY or mounted DEEPGRAM_API_KEY_FILE, plus the existing OpenAI key for gpt-6-luna. Owner voice must already be enabled with the configured dedicated Trade connection and shared bridge credential. Phone-call DID filters do not select owner audio; owner audio has its own explicit setting.

Upload src/server/bridge.mjs, src/audio/providers/deepgram.mjs, src/audio/providers/config.mjs, src/agents/trade/trade-owner-voice.mjs and src/agents/trade/trade-owner-deepgram.mjs. Restart the bridge while idle, deploy/restart Trade, then open a new Talk to Sophie session.

## Secure WebSocket proxy

Expose only /owner-voice/audio on the public WSS host, proxying to the bridge's private listening port. Preserve Origin and Sec-WebSocket-Protocol and support WebSocket upgrade. Do not expose /media or bridge control/session-minting endpoints publicly. Example Nginx location (replace upstream port if needed):

    location = /owner-voice/audio {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Origin $http_origin;
        proxy_set_header Sec-WebSocket-Protocol $http_sec_websocket_protocol;
        proxy_read_timeout 660s;
    }

This is a location fragment, not a complete TLS/server configuration. Use the existing trusted TLS reverse proxy configuration. A public hostname/certificate has not been supplied and is not automatically configured by this change.

## Flow and scope

Trade GET reports the selected voice transport to the authenticated owner. POST builds the same owner-scoped instructions/tools as before, then asks the bridge to mint an audio ticket. Tickets expire after 30 seconds, are consumed once, require the expected browser Origin and are carried in the versioned bms-owner-audio-v2 WebSocket subprotocol rather than URLs. Only provider/server keys stay on the bridge. Capacity defaults to four owner audio sessions; they are independently bounded from phone-call capacity. Sessions close after ten minutes.

Microphone capture uses a local AudioWorklet, echo cancellation/noise suppression and 20ms raw signed little-endian PCM frames at 24kHz for improved browser speech quality. The bridge streams Nova-3 en-AU recognition and Aura-2 aura-2-asteria-en synthesis through api.au.deepgram.com with mip_opt_out=true on both. Luna alone handles reasoning and tool decisions. Audio is resampled locally; browser MediaRecorder container bytes are not sent as raw PCM.

Tool calls return to the existing dashboard handlers. Owner authentication, tenant scoping, browser forms, MCP tools, prepare/readback/yes gating and real API validation remain in Trade. Deepgram transcripts supply the spoken owner replies used by the existing client confirmation gates. An executing action is never automatically repeated following an audio failure. Ticket/session audio errors fail closed rather than silently switching to OpenAI audio.

Voice mode changes; typed Chat retains its current text connection. No Deepgram key is sent to the owner or stored in the browser. Owner transcripts retain their existing on-screen-only behavior; this feature does not add call recordings or persistent owner conversation storage.

## Verification

Offline: scripts/test-ai-owner-call.ts covers owner authorization, mode selection, ticket response, missing/insecure endpoint refusal and unchanged chat behavior. scripts/test-owner-audio.mjs covers 44.1/48kHz capture resampling, frame sizes, silence and audio amplitude/polarity. Bridge tests/owner-deepgram.test.mjs covers auth, tools, single-use ticket replay, origin rejection and tool continuation; tests/deepgram-provider.test.mjs covers interruptions, greeting, five mocked concurrent contexts and provider failure. No live paid calls are placed by these tests.

Live acceptance still required: browser microphone permission and autoplay; immediate greeting; accurate recognition; audible quality and latency; interrupt/stop playback; two businesses with separate owner accounts; read-only report; one authorized test-data prepare/confirm flow; expired/replayed ticket rejection; dropped network closes microphone/provider sockets; simultaneous phone and owner sessions. Browser testing against a running app has not been performed as part of the local code checks.

Rollback: set AI_OWNER_VOICE_DEEPGRAM_ENABLED=false on Trade and restart/redeploy it; new voice sessions use the previous WebRTC path. Existing phone configuration remains independent. Do not disable the bridge owner gateway while active owner sessions are using it.

Browser audio version 2 requires deploying the updated Trade worklet/client AND bridge gateway together. Older endpoints reject the version rather than playing PCM as PCMU. Phone-call negotiated codecs remain unchanged. The browser buffers up to a bounded 60-second utterance: synthesis arriving faster than playback is normal, not an automatic slow-playback failure. Interruptions clear queued audio and any partial PCM sample. A heard live acceptance test is still required.
