# Direct Trade dashboard routing

## Prepare, then submit

The Trade MCP server still exposes six tools when writes are enabled. The bridge
adds the local `prepare_inspection_request` function to validate and hold collected
details before the final readback. Its voice-facing `create_inspection_request`
takes only `customerConfirmed=true`; the bridge supplies the prepared details and
private key to the original backend tool. No booking is saved or reserved during
preparation. Live backend validation still runs at submission. Corrections require
a new preparation; a failed preparation clears the previous draft. Saved or
uncertain writes cannot be duplicated by preparing a different request.

Upload `bridge.mjs`, `trade-tools.mjs` and `trade-action-policy.mjs` together and
restart the existing bridge. The next call logs `Conversation flow v11`. This
update adds no env settings or backend endpoints. Seven voice functions appear
with writes enabled, including the local preparation function; the backend MCP
inventory remains six. Contacts should be clarified as collected, not re-entered
after submission consent. Real validation errors may still require a targeted
correction before submission.

## Both portal request options

For a listed service, use `requestType=existing_service`, its verified `serviceId`
and `customRequest=null`. For "Not sure / need advice", use
`requestType=custom_quote`, `serviceId=null` and a `customRequest` with a short
scope/title (3-120 characters) and optional description (up to 1500 characters).
Do not force a service selection for advice. Both paths retain the same contacts,
site, one to three preferred dates/sessions, live availability and consent checks.
Advice requests can also schedule a visit when Trade's staff-automation flag and
the business's Sophie booking authority are enabled. In Team, the chosen inspector
must be active and permitted to receive and handle quotation requests
(`canget_qutaion=true`). This is the eligibility rule for an assessment without a
service; no skill or service ID is inferred from free text. Working hours, off days,
leave, existing work, closures and travel buffers still apply. If no permitted
inspector is free, the request stays pending. CONFIRMED schedules the assessment
visit only; it does not approve a quotation or work price. Both new portal and voice
requests use the shared Trade assignment workflow.

Deploy Trade's updated MCP schema first, then upload `bridge.mjs`,
`trade-tools.mjs` and `trade-action-policy.mjs` together and restart the bridge.
There are no new env settings. The six backend MCP tools remain unchanged in
name; preparation is an additional local bridge function.

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

Expected: Nira Electrical Lynbrook's business verifies, services load, and seven
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
