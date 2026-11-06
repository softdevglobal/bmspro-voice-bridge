# BMSPro voice bridge

## Project layout

```
bmspro-voice-bridge/
├─ bridge.mjs                      Entry point (starts src/server/bridge.mjs)
├─ src/
│  ├─ server/bridge.mjs            HTTP /health, Asterisk WebSocket, per-call orchestration
│  ├─ routing/tenant-routing.mjs   Dialled number (DID) -> business and mode
│  ├─ agents/
│  │  ├─ registry.mjs              Mode -> agent session + opening greeting
│  │  ├─ black/business-tools.mjs  Black workshop receptionist
│  │  ├─ trade/trade-tools.mjs     Trade inspections and advice
│  │  ├─ trade/trade-action-policy.mjs  Trade per-call safety rules
│  │  ├─ pink/pink-tools.mjs       Pink salon receptionist
│  │  └─ onboarding/onboarding-tools.mjs  New business sign-up
│  ├─ dialog/
│  │  ├─ dialog-manager.mjs        Per-call conversation steps, write gates, retry limit
│  │  └─ flows.mjs                 Step definitions for each mode
│  ├─ audio/input-audio.mjs        20 ms paced audio timers
│  ├─ audio/draft-typing.mjs       Typing sound and speech detection (PCMU)
│  ├─ asr/voice-studio-shadow.mjs  Optional comparison speech-to-text
│  └─ observability/call-transcript.mjs  Per-call transcript files
├─ tests/                          node --test suites
├─ scripts/                        check-mcp.mjs, diagnose-trade.mjs
├─ deploy/asterisk/                extensions.conf / websocket_client.conf examples
└─ docs/                           Setup guides, FUNCTIONS_AND_FLOW.md (diagrams), AI_AGENT_BRIDGE_VS_TRADE.md
```

Commands:

```
npm start                                   # node --env-file=.env bridge.mjs
npm test                                    # all offline tests
node --env-file=.env scripts/check-mcp.mjs <DID>
```

### Deploying after the folder change

Older setup guides in `docs/` copy single files (for example `scp bridge.mjs trade-tools.mjs ...`).
Those files now live under `src/`. Copy the whole tree instead, keeping the layout:

```
scp -r bridge.mjs package.json package-lock.json src dev@<server>:/home/<user>/bmspro-voice-bridge/
```

Then run `npm ci` if dependencies changed and restart the bridge as before
(`node --env-file=.env bridge.mjs` still works). In old commands, `check-mcp.mjs` is now
`scripts/check-mcp.mjs` and the Asterisk examples are in `deploy/asterisk/`.

### Dialog manager

`src/dialog/dialog-manager.mjs` keeps per-call conversation state for every mode
(Black, Trade, Pink, onboarding). On each tool call it:

1. blocks a write tool whose earlier steps are not done yet (`STEP_REQUIRED`, no action performed),
2. stops a write tool after 3 failed attempts in a row (`RETRY_LIMIT`),
3. records progress and adds `dialogState` (current step, completed steps, next hint) to the tool result the AI reads.

The steps for each mode are in `src/dialog/flows.mjs`. The gates repeat rules
the agent sessions and backend already enforce, so they only fire earlier and
give a clearer next step. Logs show `Dialog: step a -> b`, blocked tools, and a
`Dialog final:` line when the call ends.

Set `BMSPRO_DIALOG_MANAGER` in `.env`:

| Value | Behaviour |
|---|---|
| `on` (default) | Track, gate and add hints |
| `observe` | Track and log only (`would block ...`); tool results unchanged |
| `off` | Disabled; the bridge behaves exactly as before the dialog manager |

## Optional VoiceStudio shadow ASR test

The bridge can mirror caller PCMU audio to VoiceStudio's local streaming ASR
without changing the live OpenAI conversation. It is disabled by default and
will only attach to DIDs listed in `BMSPRO_VOICESTUDIO_SHADOW_DIDS_JSON`. Shadow
connection, conversion, and backpressure failures are logged and dropped; they
never close the call or interrupt OpenAI/MCP. VoiceStudio transcripts do not
control responses or invoke booking tools.

Before enabling it, configure the isolated VoiceStudio test instance to use the
`sherpa-onnx-asr` backend and confirm its streaming model is installed. The
installed Zipformer EN 20M model is English-only. In the bridge `.env`, set
`BMSPRO_VOICESTUDIO_SHADOW_ENABLED=true`, allowlist only the test DID, and copy
the VoiceStudio API key into `BMSPRO_VOICESTUDIO_API_KEY`. Keep transcript
logging disabled unless the test caller is authorized and transcript output is
needed; when enabled, it should be turned off again after the test.

The VoiceStudio engine can be selected without its UI using authenticated
`POST /engines/select` with
`{"family":"asr","backend_id":"sherpa-onnx-asr"}`. Do not send
`model_id` for Sherpa; that field is only for Faster-Whisper ASR models in this
API. Confirm `/engines/asr` reports that backend active before testing. This
selection changes only the separate VoiceStudio test container; it does not
change Sophie’s OpenAI call path.

Rollback is to set `BMSPRO_VOICESTUDIO_SHADOW_ENABLED=false` (or clear the DID
allowlist) and restart the existing bridge service. The OpenAI call path remains
the normal path throughout the test. Stop the separate test container if the
host's CPU or memory load rises. No Asterisk dialplan or DID mapping change is
required. Upload `voice-studio-shadow.mjs` before `bridge.mjs`; restart only
after both files are in place. If startup fails, restore the previous
`bridge.mjs` and restart. The new helper file can remain unused.

Opening greetings are seeded in session.input and explicitly requested once via
session.commentary.append after session.started, while the continuous input
clock supplies silence. Initial silent output packets do not trigger ANSWER;
the first audio with audible energy does. Logs distinguish the greeting request
from audible greeting readiness. This follows the OpenAI greeting guidance;
model speech and actual caller-side playback still require live verification.

Input and output pacing follow monotonic elapsed time, with at most five 20 ms
frames of catch-up per callback. Timer lateness must not accumulate a backlog
over long calls. Brief upstream socket congestion pauses sending without dropping
caller speech; genuine eight-second input backlog/clock stalls still stop safely.
Upload bridge.mjs and input-audio.mjs together. Startup prints
`Audio pacing follows elapsed time; bounded catch-up enabled.` Input failures now
report INPUT_AUDIO_BACKLOG, INPUT_AUDIO_SEND_FAILED or INPUT_AUDIO_CLOCK_STALLED,
with queued audio milliseconds and upstream buffered bytes, not audio/transcripts.
Offline checks simulate long-call timer drift and network recovery; no live calls
or OpenAI usage are needed: `node --test input-audio.test.mjs`.

The voice assistant introduces herself as Sophie and identifies herself as AI
in the opening greeting on Black, Trade and onboarding calls. This identity is
set in bridge.mjs; callers are not asked to choose a receptionist name.

Phone onboarding collects business setup for Black workshops or Trade businesses
with setupMode=new_business. Receptionist names, AI voices/greetings, requested
DIDs, call routing and escalation are outside this onboarding questionnaire.
Deploy the matching backend validation and Black business provisioner changes
and upload onboarding-tools.mjs; new businesses can reach review/provisioning
without receptionist setup. Existing-business receptionist APIs remain separate.

Onboarding saves each new or corrected setup answer before asking the next
question. Deploy the matching backend's updated instructions, pendingAnswers
schema and Trade field merge, and upload `onboarding-tools.mjs`. Incomplete
structured answers remain pending until resolved; they cannot pass owner-review
submission. This is a model instruction policy, not a deterministic speech-turn
validator. Typing begins when the answer is delegated for processing, rather
than during the caller's speech. More frequent saves increase backend work.

Onboarding, Black and Trade calls play synthetic typing with occasional mouse
press/release clicks while delegated
backend work takes more than 150 ms. Delegation, advertised tool preparation or
tool execution starts the cue. It uses the existing 20 ms PCMU playback clock only
after answer and while AI speech is absent. The cue stops on
failure, audible AI speech playback or hangup, with a 45-second safety expiry. After a
successful tool result it continues through the wait for the next spoken response;
it does not indicate that any action succeeded. Playback emits the timing-only log
`Typing audio: playback started (v4); mode=...` for deployment diagnostics.
PCMU silence in AI audio packets allows cue playback; audible AI speech takes
priority. Packet arrival alone does not cancel feedback.
Upload `draft-typing.mjs` together with `bridge.mjs`. No new dependency, audio
download or environment variable is needed.
Offline check: `node --test draft-typing.test.mjs input-audio.test.mjs`.

Trade phone routing is supported by `trade-tools.mjs` and the backend DID route
resolver. The bridge reads the current Black/Blue assignment from DID Mappings;
no separate Trade DID list is needed. See TRADE_SETUP.md for backend flags,
upload steps and a cost-free readiness check.

Current deployment: multi-workshop routing from Yeastar Alert-Info markers, using
existing Command Center DID mappings. Read MULTI_WORKSHOP_SETUP.md for migration,
configuration, deployment order, manual verification and rollback.

Dedicated onboarding calls are now supported in the local source. See
ONBOARDING_SETUP.md for the chosen 0359111410 pilot, configuration, upload steps
and remaining live checks. Each number selects either workshop or onboarding
tools within the same bridge process.

Tools: get_workshop_profile, list_services, get_available_slots, create_booking.
Booking requests require explicit spoken readback/confirmation and are submitted
for staff approval only. PENDING_REVIEW is not a confirmed mechanic appointment.
Confirmation speech is model-driven; the code additionally requires the true
confirmation flag and an offer returned in the same call's MCP session.

Every call has separate tenant, audio, OpenAI/MCP and booking state. No three-minute
call timer. No call-transfer, cancellation or callback tools; systemd and production
routing/monitoring remain separate work. The onboarding update has local automated
tests; the live pilot still needs deployment/configuration and a real phone test.
Never include .env or node_modules in shared artifacts.

The opening greeting is seeded at session startup for both workshop and onboarding
calls. `input-audio.mjs` supplies 20 ms PCMU frames, including silence when the PBX
sends no caller audio, so the Live media clock runs before the caller speaks.
The bridge now sends ANSWER only when the first nonempty greeting audio arrives.
Apply the matching `extensions.conf.example` context: remove Answer()/Wait(1),
use Ringing(), and set the WebSocket dialstring's `n` option to disable automatic
answer. Dial's `r` option supplies ringback during setup; its 65-second timeout
allows the bridge's 60-second startup deadline to finish first. Both bridge and
dialplan changes are required. This moves setup into ringing; it does not shorten
backend requests or guarantee a measured caller-side playback delay. Upstream
Yeastar routes must also avoid answering before handing the call to Asterisk.
Upload both `bridge.mjs` and `input-audio.mjs` together and restart the bridge.
Run `node --test input-audio.test.mjs onboarding.test.mjs startup.test.mjs` for offline checks;
these do not place calls or contact OpenAI.

Independent MCP startup reads now run concurrently, before verified results are
exposed to the voice session. Upload `business-tools.mjs` and
`onboarding-tools.mjs` with the bridge to apply this startup optimization.
Each call logs MCP setup, OpenAI setup, answer-to-first-audio and
answer-to-first-playback times in milliseconds; tool logs also include execution
duration. These logs contain timing/status only, never caller audio or transcripts.
Use these measurements from an authorized call to locate remaining network,
backend or model delay. No live latency improvement has been measured offline.

The bridge also posts call start/end, answered status, token usage when the provider
reports it, and MCP tool name/status/duration to the backend AI Agent Activity feed.
It does not send audio, transcripts, tool arguments, or raw results. Apply
`scripts/add-ai-agent-activity.sql` in the Command Centre backend's Supabase project
and deploy the matching backend and bridge before expecting persisted transactions.

Workshop calls verify the branch and tool inventory before answering, and fetch
services only when needed during the conversation. `check-mcp.mjs` deliberately
still reads the service catalogue for a full readiness check. Both call setup and
that check report individual MCP startup phase timings.
