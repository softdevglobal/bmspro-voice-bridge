# Pink onboarding and booking

Use the same `BMSPRO_MCP_URL` setting for Black, Trade and Pink. The bridge resolves the product from the backend DID mapping.

For the existing reverse tunnel:

```env
BMSPRO_MCP_URL=http://127.0.0.1:15050/api/ai/mcp/black
BMSPRO_ALLOW_HTTP_FOR_LOCAL_TEST=true
```

Keep `BMSPRO_BRIDGE_SECRET` equal to the backend's `AI_VOICE_BRIDGE_SECRET`. Keep the separate onboarding secret and existing onboarding DID configuration.

## Deploy the updated bridge

Stop the remote bridge with Ctrl+C. From Windows PowerShell:

```powershell
$bridgeDir = 'C:\Users\Niranga Lakshan\Documents\New project\output\bmspro-voice-bridge'
scp "$bridgeDir\onboarding-tools.mjs" "$bridgeDir\pink-tools.mjs" "$bridgeDir\tenant-routing.mjs" "$bridgeDir\business-tools.mjs" "$bridgeDir\bridge.mjs" "$bridgeDir\check-mcp.mjs" dev@100.88.220.83:/home/dev/bmspro-voice-bridge/
```

Deploy the updated Command Center backend and Pink admin's `app/account-setup/` files. Pink account invitation links depend on this page. Local backend updates are picked up by `npm run dev`.

On the voice server, with the Windows SSH tunnel active:

```bash
cd ~/bmspro-voice-bridge
node --env-file=.env check-mcp.mjs 0359111425
node --env-file=.env bridge.mjs
```

## Onboarding call

Call the existing onboarding DID (for example `0359111410`) and choose Pink. The assistant collects Pink signup details and a current plan, reads them back and requests permission to create the account. It must not collect a password. The owner uses the private setup link, then configures branches, services and staff in the Pink dashboard. A salon's receptionist DID is not its business onboarding number.

## Booking call

The backend must have `AI_MCP_PINK_ENABLED=true`. To submit bookings, also set `AI_MCP_PINK_BOOKINGS_ENABLED=true` and restart the backend. The agent discovers `create_booking` automatically. Call a DID mapped to a Pink salon and branch with a dedicated active Pink AI identity. Select a returned service and time; provide customer name, email and phone; explicitly confirm the readback. Only an upstream confirmed result means confirmed. Pending requests require salon review; uncertain results require staff verification.

Booking creation currently accepts one service per request. Point `PINK_API_BASE_URL` at your test/staging Pink API when testing writes against non-production data. No test in the supplied suites submits a real booking or creates a real owner.

## Offline checks

Backend: `npm run test:ai`

Bridge: `node --test pink.test.mjs onboarding.test.mjs trade.test.mjs startup.test.mjs`
