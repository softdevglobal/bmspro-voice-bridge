# Direct Trade dashboard routing

## Text call transcripts

Upload `bridge.mjs` and `call-transcript.mjs` together, then restart the existing
bridge. Text transcripts are enabled by default for all routes, including business
owner onboarding and Trade bookings. No API key or model change is needed.

Each call appends Caller/Sophie speech to its own timestamped `.txt` file under
`~/bmspro-voice-bridge/transcripts/` when started from that directory. Files update
during the call and close after final session events. Speaker blocks preserve
incoming fragment text; displayed offsets mark block starts. Overlapping or late
fragments may appear in arrival order. Recognition can contain errors, and generated
Sophie text does not prove that all corresponding audio reached the caller.
Tools and audio payloads are excluded. Files contain caller details and are created
with owner-only permissions on Linux; keep them out of source control. There is no
automatic expiry; remove files when no longer needed.

Optional common `.env` settings:

```dotenv
# Default true; set false to stop saving future calls:
BMSPRO_TRANSCRIPTS_ENABLED=true
# Optional absolute directory; default ./transcripts:
BMSPRO_TRANSCRIPTS_DIR=/home/dev/bmspro-voice-bridge/transcripts
```

In SSH, list files and follow the latest conversation:

```bash
cd ~/bmspro-voice-bridge
ls -lt transcripts/*.txt
tail -f "$(ls -t transcripts/*.txt | head -n 1)"
```

Offline check: `node --test call-transcript.test.mjs`.

Conversation update: upload `bridge.mjs`, `trade-tools.mjs` and
`onboarding-tools.mjs`, then restart the existing bridge. This shortens the
greeting and form questions, skips answered questions, keeps optional fields
optional, and uses one final readback. Keep the already installed
`trade-action-policy.mjs`. No env changes are needed for this prompt update.

Configure the Trade endpoint and its dedicated secret in the protected bridge env:

```dotenv
BMSPRO_TRADE_MCP_URL=https://your-trade-host/api/ai/mcp
BMSPRO_TRADE_BRIDGE_SECRET=<dedicated Trade secret>
```

No Trade DID list is needed. The bridge derives `/api/ai/voice` from the Trade
origin and asks it about each incoming DID. An active dashboard mapping returns
the business ID, which is pinned before MCP initialization. Only
`get_business_profile`, `list_services`, `find_customer` and `get_available_slots`
are exposed to the agent. Trade can additionally enable `register_customer` and
`create_inspection_request` with `AI_VOICE_ACTIONS_ENABLED=true` on Trade itself.
The bridge requires the accompanying lookup contracts before exposing writes.

Registration requires explicit account consent and preserves existing profiles.
Inspection submission requires readback/confirmation, listed services and checked
availability. Accounts are optional; guests may submit. Requests are pending
review unless Trade actually confirms staff assignment under the business's Sophie
authority. No history, profile editing, cancellation or rescheduling is available.
The bridge controls retry keys and caches write outcomes; unknown results require
staff verification and must not be resubmitted.

Onboarding uses its existing separate allowlist and secret. Unmapped numbers
continue through Command Center's verified Black/Pink routing. Disabled Trade
numbers are blocked. Discovery errors cannot fall back to Command Center's
Trade MCP. If no direct Trade URL is configured, legacy backend routing remains.

Trade's dashboard is the sole source of DID-to-business assignments. Phone
numbers still need their Yeastar/Asterisk route and Alert-Info DID marker.
New Trade mappings need no bridge environment edits or restarts.

## Existing local pilot

Keep the existing reverse SSH tunnel and Trade's development server running.
The pilot env uses `http://127.0.0.1:13001/api/ai/mcp` and
`BMSPRO_ALLOW_HTTP_FOR_LOCAL_TEST=true`. Keep the existing secret.

Upload `trade-tools.mjs` and the new `trade-action-policy.mjs` together. For older
discovery installations also upload `tenant-routing.mjs`, then remove any obsolete
`BMSPRO_TRADE_DIRECT_DIDS_JSON` line from `.env` and `.env.trade-direct-pilot`.
Do not upload secrets or node_modules. After upload, enable
`AI_VOICE_ACTIONS_ENABLED=true` in Trade's local/hosting environment and restart or
redeploy Trade. No new bridge env setting is required. Verify in SSH:

```bash
node --env-file=.env --env-file=.env.trade-direct-pilot check-mcp.mjs 0359111403
```

Expected: Nira Electrical Lynbrook's business verifies, services load, and six
tools are listed (four if actions are disabled). This check never creates a
customer or inspection. Stop and restart the existing bridge process with
both environment files after verification. No Asterisk dialplan changes are needed.

```bash
node --env-file=.env --env-file=.env.trade-direct-pilot bridge.mjs
```

Offline checks:

```bash
node --test trade.test.mjs trade-action-policy.test.mjs direct-trade.test.mjs onboarding.test.mjs pink.test.mjs startup.test.mjs
```
