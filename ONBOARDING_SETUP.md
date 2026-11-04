# Onboarding pilot: 0359111410

The chosen onboarding pilot number is **0359111410**. A read-only check found no
mapping for it in the configured Command Centre database. This does not verify
that the carrier has allocated the number or that its Yeastar route exists.

Current working path:

Phone -> Yeastar -> extension 2000 / Asterisk -> this Node voice bridge -> OpenAI
and the Command Centre backend through the existing SSH tunnel.

Workshop DIDs 0359111400 and 0359111403 continue to use their existing Black
receptionist tools. This bridge selects the agent per DID; it does not use the
direct SIP route's global AI_LIVE_AGENT_MODE setting.

## 1. Prepare the database

Open the intended Supabase project's SQL editor and run:

`D:\Softdev Global\command-center-backend\scripts\add-ai-onboarding.sql`

This creates separate draft and audit tables. It does not change workshop data.
The migration has not been applied by this chat. The readiness check reported
that onboarding storage was not available through the database API.

## 2. Configure the local backend

Edit `D:\Softdev Global\command-center-backend\.env.local`, preserving current
workshop settings, and add:

```dotenv
AI_ONBOARDING_ENABLED=true
AI_ONBOARDING_DIDS_JSON=["0359111410"]
AI_ONBOARDING_BRIDGE_SECRET=<new-separate-random-secret>
AI_ONBOARDING_OPERATOR_ID=<chosen-existing-platform-super-admin-UUID>
AI_ONBOARDING_APPROVED_TERMS_JSON=<actual-approved-terms-JSON>
```

Generate the new credential privately in local PowerShell:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Store it only in the backend and voice server environment files. It must differ
from AI_VOICE_BRIDGE_SECRET. Never paste it into chat or conversation text.

Three platform admin candidates were found; choose the intended operator rather
than automatically assigning another person's account. The backend rechecks that
account's role for every request.

The terms JSON uses this structure with actual approved content:

```json
{"version":"<approved-version>","billingSummary":"<approved-charges-and-rules>","privacySummary":"<approved-notice-and-providers>","recording":"disabled","retentionDays":0,"marketingEnabled":false}
```

The recording/retention values above are structural examples, not an approved
policy. Use the approved business settings. Do not invent a commercial price.

Restart the local backend with `npm run dev`. Keep the existing reverse SSH
tunnel running so the server can access `http://127.0.0.1:15050/api`.

## 3. Upload the bridge files

In SSH, stop the running bridge with Ctrl+C and back up the current files. In
local PowerShell, upload:

```powershell
$bridgeDir = 'C:\Users\Niranga Lakshan\Documents\New project\output\bmspro-voice-bridge'
scp "$bridgeDir\bridge.mjs" "$bridgeDir\business-tools.mjs" "$bridgeDir\tenant-routing.mjs" "$bridgeDir\onboarding-tools.mjs" "$bridgeDir\check-mcp.mjs" dev@100.88.220.83:/home/dev/bmspro-voice-bridge/
```

No new npm dependency is required. Do not upload local secrets or node_modules.

In the voice server's `~/bmspro-voice-bridge/.env`, keep the existing workshop
configuration and OpenAI key, and add:

```dotenv
BMSPRO_ONBOARDING_DIDS_JSON=["0359111410"]
BMSPRO_ONBOARDING_BRIDGE_SECRET=<same-secret-as-backend-AI_ONBOARDING_BRIDGE_SECRET>
```

The onboarding MCP URL is derived from BMSPRO_MCP_URL by replacing its path with
`/api/ai/mcp/onboarding-call/`. The existing local tunnel URL and
BMSPRO_ALLOW_HTTP_FOR_LOCAL_TEST setting are reused.

## 4. Check the backend connection before routing calls

In SSH:

```bash
cd ~/bmspro-voice-bridge
node --env-file=.env check-mcp.mjs 0359111410
```

This creates an empty setup draft to check readiness. It does not call OpenAI,
approve or provision an account, or activate calls. It must report four
onboarding tools. A failed check means configuration still needs attention.

## 5. Configure the Yeastar inbound route

Once the carrier number and backend readiness are verified, create a separate
route under Call Control -> Inbound Routes:

```text
Name:                BMSPro_Onboarding
Trunk:               Command-Center
DID Pattern:         0359111410
Inbound Alert Info:  bmsdid0359111410
Default Destination: Extension -> 2000
```

Confirm the carrier presents that DID pattern; use its actual format if it
differs. Keep the marker's digits as 0359111410 to match the backend allowlist.
Use the intended test-time destination if time conditions are configured. Place
the exact route before a broader route that would otherwise capture the call.
Save and apply. Do not change the workshop routes or add this platform number as
a workshop DID mapping. The onboarding endpoint rejects already-mapped workshop
numbers.

The existing Asterisk Alert-Info marker handling remains the same. No new
extension or dialplan section is required for this bridge integration.

## 6. Start the bridge and test

In SSH:

```bash
cd ~/bmspro-voice-bridge
node --env-file=.env bridge.mjs
```

Keep the local backend, SSH tunnel and bridge running. Call 0359111410 and verify
that the AI introduces itself as BMS Pro's onboarding assistant, asks for setup
details, remembers earlier answers and saves corrections. Inspect the saved draft
through the operator API/database. Then verify the two existing workshop numbers
still answer for their mapped workshop.

Owner approval is a separate verified Black login step at the review URL returned
by the call. The Black review screen shows the collected setup and requires the
owner to approve the exact version. The backend then prepares Black owner, branch,
service, staff and knowledge records in TEST_MODE. With the backend review
notification migration and TextBee/ZeptoMail credentials configured, confirmed
review submission sends the link by SMS and email and reports each channel's
provider acceptance separately. Staff invitations, billing, phone routing and live activation
remain operator steps. A spoken yes does not launch the workshop.

## Local checks completed

Backend TypeScript build and 43 backend tests passed. Three standalone bridge
tests passed, including per-DID mode selection, separate credentials and distinct
call identities. These are isolated local tests, not proof of carrier routing,
real audio/model behavior, deployed database integration or a live phone call.

To turn onboarding routing off, set BMSPRO_ONBOARDING_DIDS_JSON=[] and restart
the bridge, or disable AI_ONBOARDING_ENABLED on the backend. Saved drafts remain
in the database. Restore the previous bridge files if a full rollback is needed.
