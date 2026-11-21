# Joining a live Sophie call

## Current bridge flow

For bridge-backed calls, the live panel uses the bridge's business-verified UUID
session. It no longer queries Yeastar to guess ownership from shared extension
2000. The bridge retains the exact original Asterisk PJSIP caller channel from
BMS_CALLER_CHANNEL and the verified Trade owner forwarding extension.

Choose Join call, then Confirm join. Asterisk rings the mapped owner extension
through Yeastar. Answer it to speak with both parties. Sophie stays connected.
Hang up the owner extension to leave. Stop browser listening first to avoid echo.

One join request is allowed per live session. A failed or uncertain request is
not automatically retried, and the owner cannot request another join on the same
session. REQUESTED means Asterisk accepted the request, not that the owner
answered. An owner phone can ring for up to 25 seconds; if the customer hangs up
before the owner answers, no other call is selected.

## Bridge server deployment required

Deploy these files from the voice-bridge repository to the same relative paths
in `/home/dev/bmspro-voice-bridge-main`:

- src/server/bridge.mjs
- src/agents/live-context.mjs (bounded Live context appends)
- src/agents/trade/trade-live-listen.mjs
- src/agents/trade/trade-live-join.mjs (new)

For an older server checkout, upload the full `src` folder together so the
server and its supporting modules stay in sync. This preserves `.env` files.

Merge the dedicated `[bms-live-join]` account from
`deploy/asterisk/manager-handoff.conf.example` into manager.conf, with a new
random secret. Keep AMI on 127.0.0.1:5038. The account needs write=originate and
read=none. Do not broaden the existing handoff account.

Add to the protected bridge env file:

```dotenv
BMSPRO_LIVE_LISTEN_ENABLED=true
BMSPRO_LIVE_JOIN_ENABLED=true
BMSPRO_LIVE_JOIN_AMI_USER=bms-live-join
BMSPRO_LIVE_JOIN_AMI_SECRET=<new-random-secret-at-least-32-characters>
```

Reload Asterisk manager settings after merging the account, then restart the
bridge through its existing service or terminal. Do not restart active calls.
Verify that app_chanspy is loaded with `module show like app_chanspy` in the
Asterisk console. No inbound-route, ring-group, or existing dialplan change is
needed if BMS_CALLER_CHANNEL is already passed (as used by owner handoff).

Trade still uses AI_LIVE_LISTEN_BRIDGE_URL and the existing shared bridge secret.
If a reverse proxy allowlists paths, also permit POST /live-listen/join on the
private/authenticated bridge route. Never expose AMI publicly.

The business must have Listen live enabled and a valid forwardingExtension.
Only its active owner can join. Current inbound bridge sessions with the original
caller channel are supported. Outbound-only calls without that channel are not
advertised as joinable. Older bridge versions remain listen-only.

## Safety and verification

The server derives business access from the signed-in owner. Trade verifies the
current DID mapping, and the bridge independently re-resolves the route before
originating. The browser supplies only a call UUID; it never chooses a channel,
extension, dialplan context, or application. Hung-up and other-business UUIDs
are rejected. Calls ending during AMI login do not originate an owner leg.

Asterisk ChanSpy uses uBES: exact channel, both-party audio, exit on target
hangup, and stop when no target remains. It does not scan a shared prefix or
allow numeric DTMF to select another channel. This is joining, not a transfer or
a Sophie-muting takeover.

For installations without bridge streaming, the existing verified Yeastar
monitoring path remains available, with its DID ownership requirements.

Run bridge tests with `node --test tests/live-join.test.mjs tests/live-listen.test.mjs`.
Run Trade tests with `npx tsx --import ./scripts/stub-server-only.mjs --test scripts/test-ai-did-mappings.ts`.

After deployment, test on your own inbound call: join through the owner extension,
confirm two-way audio, hang up only the owner leg, and verify Sophie and the
customer remain connected. Also test customer hangup before owner answer and two
simultaneous business calls. Actual PBX audio has not been verified by mocked tests.

References:
- https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Dialplan_Applications/ChanSpy/
- https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/AMI_Actions/Originate/
