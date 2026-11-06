ssh dev@100.88.220.83

# 1. Is Asterisk running?
sudo asterisk -rx "core show uptime"

# 2. Where does Asterisk send the call audio?
sudo grep -vE '^\s*(;|$)' /etc/asterisk/websocket_client.conf

# 3. Watch live while you call 0359111403
sudo asterisk -rvvv

These are three read-only checks on the server. Together they show where your call stops. None of them changes anything.

ssh dev@100.88.220.83
Logs you into the server (aicallcenter) as the user dev. Everything after this runs on the server, not on your laptop. It asks for the dev password.

1. sudo asterisk -rx "core show uptime"
Question: is Asterisk running?

sudo runs the command as administrator (it asks for the password again). Asterisk only answers administrators.
asterisk -rx "…" connects to the running Asterisk, runs one command and exits.
core show uptime asks Asterisk how long it has been running.
Result	Meaning
System uptime: 3 days, 2 hours…	✅ Asterisk is running
Unable to connect to remote asterisk	❌ Asterisk is stopped, so no call can reach the bridge
2. sudo grep -vE '^\s*(;|$)' /etc/asterisk/websocket_client.conf
Question: where does Asterisk send the call audio?

/etc/asterisk/websocket_client.conf is the Asterisk setting that says where to connect for each call.
grep -vE '^\s*(;|$)' shows the file without comment lines (starting with ;) and blank lines, so you only see the real settings.
The line that matters is uri=:

Result	Meaning
uri=ws://127.0.0.1:8787/media	✅ Asterisk sends calls to port 8787 on the server, which your tunnel forwards to your laptop
A different address, e.g. ws://100.88.220.83:8787/media	❌ Asterisk sends calls somewhere your tunnel isn't listening
3. sudo asterisk -rvvv
Question: what happens to your call, step by step?

Opens Asterisk's live console. -r connects to the running Asterisk, and vvv turns on detailed messages.
The screen then shows events as they happen. Call 0359111403 while it's open and watch.
Press Ctrl+C to leave the console. That doesn't stop Asterisk.
What appears when you call	Meaning
Nothing	Yeastar isn't sending the call to Asterisk; check the Yeastar inbound route
Lines with from-yeastar, 2000, Dial(WebSocket/bmspro-media…), then an error	Asterisk receives the call but can't connect to the bridge; the error line says why
Same lines, and your laptop bridge prints Asterisk connected	✅ Working
In short

Your call → Yeastar ──(check 3)──► Asterisk ──(checks 1 and 2)──► tunnel → laptop bridge
Check 1 shows whether Asterisk is on, check 2 where it sends calls, and check 3 how far your call gets. Paste me the output and I'll tell you the fix.

12:17 PM
It's fixed. Asterisk is signed in to Yeastar again, and everything on your side is ready, so you can call 0359111403 now.

Part	Status
Asterisk → Yeastar (extension 2000)	✅ Registered (was Rejected since this morning)
Tunnel (server 8787 → laptop)	✅ Running
Bridge on laptop	✅ Listening on 8787
Trade on laptop	✅ Running on 3001
I ran only the re-register command on the server and changed no settings. The temporary password file is deleted.

When you call, your bridge window should print, in order:

Asterisk connected; waiting for MEDIA_START
MCP startup: … lines, then MCP ready
Connecting to OpenAI
Sophie greets you. Ask "Do you charge to come out?" and watch for MCP tool: search_business_knowledge status=FOUND.
If it stops at OpenAI error (like in the photo from yesterday), the bridge's OpenAI key in bmspro-voice-bridge\.env is the problem. Send me the log and I'll check it.

Afterwards:

Change the dev password. It's been shared in this chat.
Stop the tunnel (Ctrl+C) when you're finished testing, so real callers aren't sent to your laptop.
Retry setting: Asterisk gave up after a short Yeastar outage last night. Setting it to keep retrying in pjsip.conf would prevent that.