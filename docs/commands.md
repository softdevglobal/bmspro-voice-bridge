# Sophie voice pilot — laptop test setup

How a call to the Trade pilot number reaches Sophie when the **bridge and Trade
run on a laptop**, and how to start, check and stop it.

- Pilot number (DID): **0359111403** → Nira Electrical Lynbrook (business `egr6Q6c19rgjJgUuzAI9`)
- Last verified: 6 November 2026

> **In one sentence:** Yeastar sends the call to Asterisk on the Melbourne server;
> Asterisk connects to port 8787 on the server as usual; an SSH tunnel forwards that
> port to the bridge on the laptop; the bridge talks to OpenAI for Sophie's voice and
> to Trade (also on the laptop) for business data.

---

## 1. Where everything runs

| Component | Where | Address / port | Role |
|---|---|---|---|
| **Yeastar PBX** | Yeastar cloud (Sydney) | `bmsproslynbrook.ras.yeastar.com:5060` (SIP) | Owns the phone number. Sends 0359111403's calls to extension **2000**. |
| **Asterisk 22** | Server `aicallcenter`, **Melbourne** | Registers to Yeastar as extension **2000**. Connects to `ws://127.0.0.1:8787/media` per call. | Answers the phone line and streams the call audio over a WebSocket. |
| **SSH tunnel** | Laptop → server | Server `127.0.0.1:8787` → laptop `127.0.0.1:8787` | Makes Asterisk's connection land on the laptop's bridge. |
| **Voice bridge** | **Laptop** (Sri Lanka) | Listens on `127.0.0.1:8787/media` | Joins the call audio to OpenAI, runs Sophie's tools, saves the call log. |
| **Trade admin panel** | **Laptop** | `http://127.0.0.1:3001` | Business data, MCP tools, AI knowledge, call logs. |
| **OpenAI Live** | OpenAI cloud | HTTPS / WebSocket | Sophie's voice (`gpt-live-1`, voice `shimmer`) and reasoning (`gpt-6-luna`). |
| **OpenAI embeddings** | OpenAI cloud | HTTPS | Turns knowledge text and questions into vectors (`text-embedding-3-small`). |
| **Firestore** | Firebase project `bmspro-trade` | (Admin SDK) | Businesses, services, AI knowledge, call logs. |

Server access: `ssh dev@100.88.220.83` (Tailscale address). Never put the password
in files or chat; change it if it has been shared.

## 2. Ports and addresses

| Port | Machine | Who listens | Who connects | Notes |
|---|---|---|---|---|
| `5060` (SIP) | Yeastar | Yeastar | Asterisk | Asterisk registers as 2000 (`yeastar-registration`). |
| `8787` | **Server** `127.0.0.1` | SSH tunnel (normally the server's own bridge) | Asterisk | Must be free of any server bridge while the tunnel is used. |
| `8787` | **Laptop** `127.0.0.1` | Laptop bridge | SSH tunnel | Set by `BMSPRO_PORT` / `BMSPRO_BIND_HOST` in `.env`. |
| `3001` | **Laptop** `127.0.0.1` | Trade (`npm run dev`) | Laptop bridge | Bridge uses `BMSPRO_TRADE_MCP_URL=http://127.0.0.1:3001/api/ai/mcp`. |
| `22` | Server | sshd | Laptop | Carries the tunnel. |
| `13001` | Server | — | — | **Not used** in this setup. Only needed when the bridge runs on the server and Trade on the laptop. |

## 3. Picture

```
                         ┌──────────── MELBOURNE SERVER (aicallcenter) ────────────┐
 Caller ──► Yeastar ───► │  Asterisk 22 (extension 2000)                           │
          (Sydney, SIP)  │     │  Dial(WebSocket/bmspro-media) ─► ws://127.0.0.1:8787│
                         │     │                         (held by the SSH tunnel)  │
                         └─────┼───────────────────────────────────────────────────┘
                               │  SSH tunnel (window 3): server 8787 → laptop 8787
                         ┌─────▼──────────────── LAPTOP (Sri Lanka) ───────────────┐
                         │  Voice bridge (window 2) on 127.0.0.1:8787              │
                         │     ├── audio ⇄ OpenAI Live (Sophie speaks and listens) │
                         │     └── tools ⇄ Trade (window 1) on 127.0.0.1:3001      │
                         │                    └── Firestore + OpenAI embeddings    │
                         └─────────────────────────────────────────────────────────┘
```

## 4. How a call is answered, step by step

1. **Caller dials 0359111403.** Yeastar's inbound route sends it to extension 2000
   and adds the marker `Alert-Info: bmsdid0359111403`.
2. **Asterisk receives it** in the `[from-yeastar]` context (verified on the server):
   ```
   exten => 2000,1,Set(__BMS_ROUTE_INFO=${PJSIP_HEADER(read,Alert-Info)})
    same => n,GotoIf($[${LEN(${BMS_ROUTE_INFO})}=0]?reject)   ; no marker → reject
    same => n,Ringing()                                      ; caller hears ringing
    same => n,Dial(WebSocket/bmspro-media/c(ulaw)f(json)n,65) ; open the bridge WebSocket
    same => n,Hangup()
    same => n(reject),Hangup(21)
   ```
   `n` = Asterisk does **not** answer by itself; the bridge decides when.
3. **Asterisk opens the WebSocket** (`/etc/asterisk/websocket_client.conf`, `[bmspro-media]`):
   `uri=ws://127.0.0.1:8787/media`, protocol `media`, 5 s connect timeout, no retries, no TLS.
   On the server that address is the tunnel, so the connection arrives at the **laptop bridge**.
4. **`MEDIA_START`**: Asterisk tells the bridge the audio format (μ-law, 160-byte frames)
   and passes `BMS_ROUTE_INFO`. The bridge reads the DID `0359111403` from it.
5. **Routing**: the bridge asks Trade `POST /api/ai/voice` "which business owns this
   number?" → Nira Electrical. The business ID is pinned for the whole call.
6. **Tools**: the bridge opens the MCP connection to Trade `POST /api/ai/mcp`, checks the
   business profile and gets the tool list (including `search_business_knowledge`).
7. **OpenAI**: the bridge starts the Live session with Sophie's instructions, the tools and
   the greeting.
8. **Answer**: as soon as Sophie's greeting audio is ready, the bridge sends Asterisk
   `{"command":"ANSWER"}`. The caller stops hearing ringing and, 400 ms later, hears
   "Hi, thanks for calling Nira Electrical Lynbrook. My name is Sophie…".
   If setup takes longer than 60 s the bridge ends the call.
9. **Conversation**: audio flows both ways continuously (section 5). When Sophie needs
   data she calls a Trade tool; a soft typing sound plays while she waits.
10. **End**: either the caller hangs up, or Sophie ends the call after a goodbye
    (`end_call`). The bridge sends `HANGUP`, then saves the call log to Trade and closes
    the transcript file.

## 5. What data passes on each link

| Link | Data | Format |
|---|---|---|
| Yeastar ⇄ Asterisk | Phone call | SIP signalling + RTP audio |
| Asterisk → bridge | Caller's voice | Binary WebSocket frames: **μ-law (PCMU) 8 kHz, 160 bytes = 20 ms** |
| Bridge → Asterisk | Sophie's voice, typing sound, silence | Same 160-byte frames, one every 20 ms (plus a 240 ms cushion at the start, see §8) |
| Asterisk ⇄ bridge | Control | JSON text: `MEDIA_START`, `MEDIA_XOFF/XON` from Asterisk; `ANSWER`, `HANGUP`, `FLUSH_MEDIA` from the bridge |
| Bridge ⇄ OpenAI Live | Caller audio in, Sophie's audio + transcript out, tool calls | WebSocket JSON events (audio base64 PCMU) |
| Bridge → Trade `/api/ai/voice` | "Which business owns this DID?" | HTTP POST, headers `Authorization: Bearer <bridge secret>`, `X-BMSPro-DID` |
| Bridge ⇄ Trade `/api/ai/mcp` | Tool calls and results (services, availability, knowledge, bookings) | MCP (JSON-RPC over HTTP POST), headers above + `X-BMSPro-Trade-Business` |
| Bridge → Trade `/api/ai/calls` | Call log after hang-up | HTTP POST JSON, same headers |
| Trade ⇄ Firestore | Business data, knowledge, call logs | Firebase Admin SDK |
| Trade → OpenAI embeddings | Knowledge text / caller question | HTTPS (only text, never audio) |

The business is **never** chosen by the AI: it always comes from the DID mapping and
the pinned `X-BMSPro-Trade-Business` header.

## 6. What is stored, and where

| Data | Where | Kept for |
|---|---|---|
| Call log: times, length, end reason, tools used, outcome, **full conversation text** | Firestore `ai_call_logs` (shown on Dashboard → **AI calls**) | 90 days (`AI_CALL_LOG_RETENTION_DAYS`), then auto-deleted (TTL) |
| Transcript text file | Laptop `bmspro-voice-bridge\transcripts\<time>_<callId>.txt` | Until deleted |
| AI knowledge entries + passages | Firestore `ai_knowledge_sources`, `ai_knowledge_chunks` (Dashboard → **AI knowledge**) | Until the owner deletes them |
| Questions Sophie couldn't answer (redacted) | Firestore `ai_unanswered_questions` | Until answered/dismissed |
| Audio recordings | **Nowhere** — audio is never stored | — |

Call logs contain customer names, phones and emails. The collections are meant to be
server-only (`firestore.rules`), but that rules change still needs deploying by the
project owner.

## 7. Start the test (three PowerShell windows)

### Window 1 — Trade

```powershell
cd C:\Users\syapa\OneDrive\Desktop\softdevglobal\projects\bmspro-trade-adminpanel\bmspro-trade-adminpanel
npm run dev
```

Wait for `Ready`. It must run on port **3001**.

### Window 2 — Bridge

```powershell
cd C:\Users\syapa\OneDrive\Desktop\softdevglobal\projects\bmspro-voice-bridge
node --env-file=.env --env-file=.env.trade-direct-pilot scripts/check-mcp.mjs 0359111403
```

Expected: `Trade MCP ready for DID 0359111403…` and a tool list that includes
`search_business_knowledge`. This check is read-only. Then start the bridge:

```powershell
node --env-file=.env --env-file=.env.trade-direct-pilot bridge.mjs
```

Expected: `BMSPro voice pilot listening at ws://127.0.0.1:8787/media` and **no** `PS …>`
prompt after it. Don't type in this window; it shows the live log.

### Window 3 — Tunnel

```powershell
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -R 127.0.0.1:8787:127.0.0.1:8787 dev@100.88.220.83
```

Type the server password. No output means it's working.
`remote port forwarding failed` means something on the server already uses port 8787.

### Call

Call **0359111403**.

## 8. Settings used on the laptop

**Bridge** (`bmspro-voice-bridge\.env` and `.env.trade-direct-pilot`)

| Setting | Value | Meaning |
|---|---|---|
| `BMSPRO_BIND_HOST` / `BMSPRO_PORT` | `127.0.0.1` / `8787` | Where the bridge listens |
| `BMSPRO_TRADE_MCP_URL` | `http://127.0.0.1:3001/api/ai/mcp` | Trade on the laptop |
| `BMSPRO_ALLOW_HTTP_FOR_LOCAL_TEST` | `true` | Allows plain HTTP to the local Trade |
| `BMSPRO_PLAYBACK_LEAD_MS` | `240` | Audio cushion kept in Asterisk to hide tunnel jitter. **Laptop only; use 0 on the server.** |
| `BMSPRO_BARGE_IN` | (unset = on) | Sophie stops when the caller talks; `false` turns it off |
| `BMSPRO_TRANSCRIPTS_ENABLED` | `true` | Writes transcript files |
| `BMSPRO_BACKEND_REASONING_EFFORT` | (unset = `low`) | How long the backend model thinks before each lookup and answer. Lower is faster. `medium`/`high` if bookings go wrong; `default` = OpenAI's default |
| `BMSPRO_BACKEND_VERBOSITY` | (unset = `low`) | Keeps backend answers short. `default` = OpenAI's default |
| `BMSPRO_BACKEND_SERVICE_TIER` | (unset = `default`) | `priority` is faster but costs more per token |

**Trade** (`.env.local`)

| Setting | Value | Meaning |
|---|---|---|
| `AI_VOICE_DIRECT_ENABLED` | `true` | Turns on `/api/ai/voice` and `/api/ai/mcp` |
| `AI_VOICE_BRIDGE_SECRET` | (secret) | Must equal the bridge's `BMSPRO_TRADE_BRIDGE_SECRET` |
| `AI_VOICE_KNOWLEDGE_ENABLED` | `true` | Sophie may search AI knowledge |
| `AI_KNOWLEDGE_MAX_DISTANCE` | `0.62` | How close a knowledge match must be (lower = stricter) |
| `AI_CALL_LOG_RETENTION_DAYS` | `90` (default) | Days a call log is kept |
| `OPENAI_API_KEY` | (secret) | Used for knowledge embeddings |

## 9. Log lines to watch in window 2

| Line | Meaning |
|---|---|
| `Asterisk connected; waiting for MEDIA_START.` | The call reached the laptop |
| `MCP ready: setupMs=…` | Trade tools are ready (should be well under 1 s) |
| `Audible greeting audio ready; answered call.` | Bridge sent `ANSWER` |
| `Playback lead: 240ms queued in Asterisk.` | Audio cushion in place |
| `MCP tool: search_business_knowledge status=FOUND durationMs=…` | Sophie answered from AI knowledge |
| `Barge-in: caller spoke; stopped Sophie…` | Caller interrupted; Sophie stopped |
| `End call: requested by Sophie…` | Sophie is ending the call after her goodbye |
| `Ended: <reason>` | Call finished (`caller disconnected`, `Sophie ended the call after saying goodbye`, …) |
| `Call log: saved=true status=201` | Call saved to Firestore |

## 10. Sophie's call behaviour

- **Interruptions:** when the caller starts a new sentence while Sophie is talking, the
  bridge drops her queued speech and she listens (reaction about 0.5–1 s). Echo and
  background noise do not trigger it.
- **Ending calls:** after the caller says goodbye or asks her to hang up, she says one short
  goodbye and the bridge hangs up when it has finished playing. If the caller keeps talking,
  the hang-up is cancelled. She never ends a call mid-booking.
- **Waiting:** a quiet, natural typing sound plays while she looks something up (only if it
  takes longer than 150 ms; it stops the moment she speaks).
- **Knowledge:** she answers only from published AI knowledge; if nothing matches she says
  she doesn't have that detail, and the question appears under "Questions Sophie couldn't
  answer".

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Call rings, nothing in window 2 | Asterisk isn't registered to Yeastar, or the tunnel is down | Check the tunnel window. On the server: `sudo asterisk -rx "pjsip show registrations"`. If **Rejected**: `sudo asterisk -rx "pjsip send register yeastar-registration"` |
| Call rings, then hangs up; window 2 shows `MCP setup failed` | Trade (window 1) not running or wrong port | Start Trade on 3001; rerun `check-mcp` |
| `Ended: OpenAI error…` | Bridge `OPENAI_API_KEY` invalid, or no model access | Fix the key in `bmspro-voice-bridge\.env` |
| `remote port forwarding failed` (window 3) | A bridge is running on the server on 8787 | Stop it on the server (`pkill -f "node .*bridge.mjs"`) |
| Sophie says she can't check something | Trade error or knowledge search unavailable | Look at window 1 for errors |
| Choppy voice | Tunnel jitter (laptop ↔ Melbourne ~164 ms) | Raise `BMSPRO_PLAYBACK_LEAD_MS` to 300–400; best fix is running the bridge on the server |
| AI calls page: "Could not load AI calls" | Firestore index missing | `npx firebase deploy --only firestore:indexes --project bmspro-trade` |
| No call log after a call | Trade or bridge running old code | Restart both; look for `Call log: saved=…` |

Useful server checks (read-only):

```bash
sudo asterisk -rx "core show uptime"                       # Asterisk running?
sudo asterisk -rx "pjsip show registrations"               # Registered to Yeastar?
sudo grep -vE '^\s*(;|$)' /etc/asterisk/websocket_client.conf   # Where calls are sent
sudo asterisk -rvvv                                         # Watch a call live (Ctrl+C to leave)
```

## 12. Stop the test / go back to the server bridge

1. **Ctrl+C in window 3** (tunnel) first, so new calls no longer reach the laptop.
2. Ctrl+C in window 2 (bridge) and window 1 (Trade).
3. To use the **server's** bridge again, on the server:
   ```bash
   cd ~/bmspro-voice-bridge
   node --env-file=.env --env-file=.env.trade-direct-pilot bridge.mjs
   ```
   Note: the server still runs the **old** bridge code (no knowledge search, call logs,
   barge-in or end-call) until the new code is deployed there.

## 13. Why the laptop setup is for testing only

| | Laptop (this setup) | Bridge on the Melbourne server |
|---|---|---|
| Audio path | Melbourne ⇄ Sri Lanka ⇄ OpenAI | Melbourne ⇄ OpenAI |
| Extra delay per exchange | ~400 ms (164 ms travel + 240 ms cushion) | ~0 (no cushion needed) |
| Voice quality | Affected by tunnel jitter | Clean |
| Depends on | Laptop staying on and connected | The server only |

While the tunnel is up, **real callers** to 0359111403 reach the laptop and hear the
current AI knowledge (currently test data). Stop the tunnel when you finish testing.
