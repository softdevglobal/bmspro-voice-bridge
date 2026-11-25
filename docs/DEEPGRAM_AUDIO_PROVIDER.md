# Deepgram audio in the main voice bridge

Use the normal bridge.mjs entry point, /media WebSocket, existing port and the existing bmspro-media Asterisk connection. Do not route the main bridge through /media-staging. The source integration is implemented and offline-tested; real-call acceptance, regional account/model access and secret-manager deployment are still required before production approval.

## Provider selection

Default (including an absent setting):

    BMSPRO_AUDIO_PROVIDER=gpt-live

For all backend-mapped Trade tenants:

    BMSPRO_AUDIO_PROVIDER=deepgram
    # Omit BMSPRO_DEEPGRAM_DIDS_JSON to use all mapped Trade DIDs.

The existing backend DID mapping still resolves each business, profile and scoped tool session before provider selection. No tenant DID needs to be added to the environment. Non-Trade calls retain GPT Live. Optionally set BMSPRO_DEEPGRAM_DIDS_JSON to a nonempty JSON array for a limited rollout; omitted/blank means all mapped Trade DIDs. An explicit empty or malformed array is rejected. Startup fails on an invalid configuration rather than silently selecting a provider. Provide DEEPGRAM_API_KEY via secret-manager environment injection, or DEEPGRAM_API_KEY_FILE pointing at its private mounted secret file. The key is loaded once at startup; rotate with a controlled restart when calls are idle. Never put the actual value in source or command-line arguments. No provider-specific secret-manager connection is claimed: its provider/reference has not been supplied.

Start with the existing normal command and an environment overlay containing these provider settings. BMSPRO_PORT and existing base environment remain authoritative. Do not run two processes on the same port. Calls are selected once after the existing backend DID lookup.

## Restore the normal Asterisk path after the pilot

Within the existing 2000 block restore:

    same => n,Dial(WebSocket/bmspro-media/c(ulaw)f(json)n,65)

The normal bmspro-media URI must point at the main bridge's actual BMSPRO_PORT and /media, as before. The separate bmspro-deepgram-staging stanza is no longer used by this integration. The BMS_AUDIO_ENV=staging marker is not used to choose the provider in the main bridge; the explicit provider setting and optional DID filter are used instead. Preserve BMS_ROUTE_INFO, caller-channel and caller-ID handling. Keep production provider selection on gpt-live until the listening test is approved.

## Preserved behaviour

The adapter emits the events the main bridge already consumes, so call tools execute only through the existing allowlist, dialog checks, MCP action policy and serial tool queue. Includes callbacks, opt-out, owner handoff, end_call, call logs, transcripts, live listening/joining, admission capacity, paced PCMU playback and media flow control. Luna remains gpt-6-luna with existing reasoning/verbosity/service-tier settings and no parallel tools. The speech adapter never executes a business tool directly.

STT: Nova-3, en-AU, streaming. TTS: Aura-2 aura-2-asteria-en. Both pinned to api.au.deepgram.com with mip_opt_out=true. The main bridge currently negotiates only ulaw/PCMU mono 8000 Hz, 160 bytes per 20ms. Other codecs retain the existing rejection behaviour; supporting them requires an explicit conversion/negotiation change.

Provider sockets, model context, turn state and cancellation are isolated per call. Caller speech cancels model generation, closes stale synthesis, flushes queued bridge/Asterisk audio, and cancels pending polite hangup. An already executing business tool completes through the main bridge, which saves its outcome even after hangup. Late synthesis from the old utterance is discarded by generation identity. Transcripts contain generated Sophie text, potentially including interrupted/unheard words, as in the original bridge; they do not prove the full sentence was heard.

Provider failure ends the call through the normal bridge cleanup. There is NO automatic mid-call migration to GPT Live and no tool/audio replay. Safe rollback is to set BMSPRO_AUDIO_PROVIDER=gpt-live and restart the main bridge while idle; the next call uses the old transport. This is explicit rollback availability, not seamless recovery. OpenAI account/model access remains required for Luna.

## Acceptance required before claiming production readiness

1. Run npm test (offline mocks, no paid calls). Syntax-check src/server/bridge.mjs and both provider modules.
2. Start with one isolated authorized inbound test on the selected DID; listen to voice, names/numbers, greeting completeness, clarity and dropouts. Confirm Nova/Aura are available for the account in AU.
3. Measure caller end-of-speech to first audible response and compare with GPT Live on the same route. Current normal bridge timing logs cover greeting setup; use call recordings/manual timing for the full conversational latency measurement. Agree thresholds before sign-off.
4. Interrupt greeting, long replies, lookup and a prepare/readback. Check immediate stop, no old audio, no unverified action claims, explicit confirmation and no duplicate writes.
5. Test callbacks, reminders, opt-out, owner handoff, live listening/join and end_call using authorized test records/endpoints. Integration shares the original handlers but that does not replace live regression testing.
6. Simulate STT/TTS disconnect and confirm clean hangup/cleanup and no replay. Roll back to gpt-live and verify a new call.
7. Test 4–5 real simultaneous calls with the normal max-concurrency setting and verify no cross-call audio/state, clipping or overload. Mocked five-call tests are not acoustic/network load tests.
8. Obtain explicit approval after hearing the test. No production activation has been performed by these code changes.

References:
https://developers.deepgram.com/reference/speech-to-text/listen-streaming
https://developers.deepgram.com/reference/text-to-speech/speak-streaming
https://developers.deepgram.com/trust-security/your-data

