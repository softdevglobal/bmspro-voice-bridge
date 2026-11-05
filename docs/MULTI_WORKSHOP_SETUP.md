# Automatic workshop selection from existing DID mappings

No DID list is required on the voice server. Asterisk supplies the route marker;
the bridge sends its DID in X-BMSPro-DID; Command Center resolves its existing
Supabase DID mapping and existing Super Admin-provisioned AI account. Names and
branches come from that lookup. No new tenant database is introduced.

## 1. Deploy backend changes first

Project: D:\Softdev Global\command-center-backend
- src/routes/ai/yeastar-mcp.routes.ts
- src/services/ai/black-agent-identity.service.ts

Review, commit, push and deploy those changes. Preserve unrelated working changes.
Add to the COMMAND CENTER BACKEND environment:

```ini
AI_VOICE_BRIDGE_SECRET=YOUR_NEW_RANDOM_BRIDGE_SECRET
```

Use a new random secret of at least 32 characters, different from existing MCP
secrets. For example generate one privately with openssl rand -hex 32. Never send
it in chat. Restart the backend after changing its environment.
Keep the existing feature flags, booking flag and legacy MCP entries as needed.
New DIDs need no new AI_MCP_TENANT_CONFIG_JSON entry when their AI account is created
using the existing Super Admin provisioning feature. Legacy manual UID entries
remain compatible. A DID mapping alone does not create or authorize an AI account.
The AI account must be active and assigned to the current mapped workshop/branch.
No Black admin-panel or frontend deployment is needed for this routing change.

## 2. Back up voice source in SSH

Stop Node with Ctrl+C:

```bash
cd ~/bmspro-voice-bridge
cp -n bridge.mjs bridge.before-auto-did.mjs
cp -n business-tools.mjs business-tools.before-auto-did.mjs
cp -n check-mcp.mjs check-mcp.before-auto-did.mjs
```

If tenant-routing.mjs is already present, back it up too. Back up extensions.conf
with sudo cp -an /etc/asterisk/extensions.conf /etc/asterisk/extensions.conf.before-auto-did.

## 3. Upload from LOCAL PowerShell

```powershell
$bridgeDir = 'C:\Users\Niranga Lakshan\Documents\New project\output\bmspro-voice-bridge'
scp "$bridgeDir\bridge.mjs" "$bridgeDir\business-tools.mjs" "$bridgeDir\check-mcp.mjs" "$bridgeDir\tenant-routing.mjs" dev@100.88.220.83:/home/dev/bmspro-voice-bridge/
```

No extra npm package is needed.

## 4. Voice server environment

In SSH run nano ~/bmspro-voice-bridge/.env. Keep OPENAI_API_KEY and BMSPRO_MCP_URL.
Add:

```ini
BMSPRO_BRIDGE_SECRET=THE_SAME_NEW_SECRET_AS_BACKEND_AI_VOICE_BRIDGE_SECRET
BMSPRO_MAX_CONCURRENT_CALLS=4
```

BMSPRO_VOICE_TENANTS_JSON is no longer used. Old standalone BMSPRO_MCP_SECRET and
BMSPRO_EXPECTED_* settings are ignored for automatic routing. Keep them privately
for rollback if needed. Save Ctrl+O, Enter, Ctrl+X; chmod 600 .env.

```bash
cd ~/bmspro-voice-bridge
node --env-file=.env check-mcp.mjs 0359111403
```

The final number is a one-off check, not a configured DID list. Expected: MCP ready
for that DID. This reads data only and does not create a booking or call OpenAI.
Unknown/unmapped DIDs, ambiguous +/non-+ duplicate mappings, wrong shared credentials,
and inactive/mismatched AI accounts are rejected. The backend matches exact digits
or the same digits prefixed with +; it never guesses country codes. The marker must
use the backend DID's digits, even if the carrier route pattern uses another format.

## 5. Asterisk and Yeastar

Each workshop's inbound route matches its DID, sets Inbound Alert Info to bmsdid
plus that mapped DID's digits (no +), and sends the call to extension 2000.
Example: 0359111403 -> bmsdid0359111403 -> 2000. Do not group different workshops
under the same route marker. This field was verified in the incoming SIP INVITE.

Run sudo nano /etc/asterisk/extensions.conf and replace only the existing context:

```ini
[from-yeastar]
exten => 2000,1,Set(__BMS_ROUTE_INFO=${PJSIP_HEADER(read,Alert-Info)})
 same => n,GotoIf($[${LEN(${BMS_ROUTE_INFO})}=0]?reject)
 same => n,Ringing()
 same => n,Dial(WebSocket/bmspro-media/c(ulaw)f(json)n,65,r)
 same => n,Hangup()
 same => n(reject),Hangup(21)
```

Preserve existing SIP registration and rtp_keepalive=5. No v() per-call URL
parameters are used because of a reported cross-call Asterisk issue. The marker
uses inherited channel variables from JSON MEDIA_START. That final propagation
has not yet been verified on the remote Asterisk build.

```bash
sudo asterisk -rx 'dialplan reload'
node --env-file=.env bridge.mjs
```

## 6. Verify

Call the existing DID from mobile and check Opening a call-scoped MCP session for
DID 0359111403. Confirm its branch/services before booking. Then configure a second
mapped DID with its Super Admin AI account and Yeastar marker. No voice-server env
change or restart is required just to add that workshop. Verify calls to each DID,
then simultaneous calls, keep business information and bookings separate.
Unmarked direct calls to extension 2000 are rejected rather than using a default.

The bridge has separate tenant, audio, OpenAI/MCP and booking state per call.
The 3-minute timer remains removed. Default concurrency is 4 (configurable 1-32),
subject to PBX/carrier/OpenAI/server limits. Health checks only local process state;
backend connectivity is checked for each DID through readiness or the actual call.
No tests or live API requests were run for this update; nothing has been deployed.

## Rollback

Stop Node; restore the matching bridge/business-tools/check-mcp backups and, if
applicable, tenant-routing.mjs. Restore the old extensions.conf and reload dialplan.
Restart the old bridge with its previous private env values. The backend retains
legacy per-tenant bearer authentication. Never expose bridge port 8787 publicly.

Sources:
- https://docs.asterisk.org/Configuration/Channel-Drivers/WebSocket/
- https://github.com/asterisk/asterisk/issues/2194
