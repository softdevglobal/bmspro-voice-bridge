# The AI Agent: Voice Bridge vs Trade

Where Sophie's AI (the LLM) runs, what belongs in the voice bridge and what belongs in Trade, how each Trade business gets its own agent today, and what is still missing.

Related: [FUNCTIONS_AND_FLOW.md](FUNCTIONS_AND_FLOW.md) (bridge folders, functions, call flow and how to run).

---

## Contents

1. [The LLM is called from the voice bridge](#1-the-llm-is-called-from-the-voice-bridge)
2. [Keep the brain in the bridge; move what it knows to Trade](#2-keep-the-brain-in-the-bridge-move-what-it-knows-to-trade)
3. [How each Trade business gets its own agent today](#3-how-each-trade-business-gets-its-own-agent-today)
4. [What's missing for a real per-business agent](#4-whats-missing-for-a-real-per-business-agent)
5. [How each business would get its own agent](#5-how-each-business-would-get-its-own-agent)

---

## 1. The LLM is called from the voice bridge

The LLM runs at OpenAI, not on our servers. The voice bridge opens and controls one OpenAI session per call:

- `gpt-live-1` listens and speaks.
- `gpt-6-luna` decides which tools to use.

When the model asks for a tool, the request comes back to the bridge. The bridge runs it (the MCP call to Trade) and sends the result back.

```
Phone call → bridge opens OpenAI session → OpenAI LLM thinks → tool request → bridge → Trade MCP
                                                             ← result ← bridge ← Trade MCP
```

**Rule:** if it happens while someone is on the phone, it's in the bridge. If it happens before, after, or outside a call, it's in Trade or Command Center.

The bridge keeps no database and remembers nothing between calls. Each call starts fresh and is cleared when it ends, apart from the transcript file. Anything that must be stored, edited by a person, or used outside a call belongs in Trade or Command Center.

| Belongs in the voice bridge (during a call) | Belongs in Trade / Command Center (outside a call) |
|---|---|
| Audio, answering and hanging up | Website or portal chat agent: Trade `/api/ai/chat`, `lib/ai/agent/` |
| The OpenAI session (instructions, voice, tools) | Knowledge / FAQ storage and RAG indexing: Trade `lib/ai/rag/`, exposed as an MCP tool |
| Running tool calls and the safety checks (`trade-action-policy.mjs`) | Business data, bookings, customers: Trade database, reached through MCP tools |
| The dialog manager (steps for this call) | Agent profile settings (greeting, tone, FAQs): Trade dashboard, read by the bridge at call start |
| The transcript and call events | Call summaries, reports, dashboards: Trade / Command Center (the bridge only sends events) |
| | Super agent, Super RAG, A2A: Command Center |

## 2. Keep the brain in the bridge; move what it knows to Trade

**Moving the whole brain to Trade is not recommended.** If Trade ran the AI and the bridge only passed audio:

| Problem | Why |
|---|---|
| Slower replies | Every caller turn would go bridge → Trade → AI model → tools → back. |
| Calls depend on the laptop | Trade currently runs on a Windows PC through the SSH tunnel. If the PC sleeps or the tunnel drops, Sophie stops mid-call instead of losing just one lookup. |
| Next.js isn't built for live calls | A call needs one process holding its state for minutes (prepared booking, checked dates, retry keys). Next.js handles one request at a time and forgets in between, especially on hosting like Vercel. |
| Repeated three times | Black and Pink would each need their own brain too. Today one bridge serves every brand. |
| Safety moves away from the call | `trade-action-policy.mjs` and the dialog manager would have to be rebuilt inside Trade. |

**Moving what the brain knows and says is recommended:**

| Stays in the bridge (how the call runs) | Moves to Trade (what Sophie knows and says) |
|---|---|
| OpenAI live voice connection, audio, answer/hang-up | Greeting and tone for each business |
| Dialog manager (steps, gates, retry limit) | Conversation guide and questions (today `turnInstructions` and `conversationGuide` in `trade-tools.mjs`) |
| `trade-action-policy.mjs` safety checks | FAQs and knowledge (RAG, through a `search_knowledge` tool) |
| Call state, transcripts, logs | Which actions are switched on for each business |
| | Final booking rules (already there) |

**There's already an example in the code:** onboarding works this way. Command Center sends Sophie's instructions and greeting through the MCP resource `bmspro://onboarding/call`, and the bridge reads it at the start of the call (`onboarding-tools.mjs`). Trade could do the same with something like `bmspro://trade/agent-profile`.

What this gains:
- The Trade team changes Sophie's wording or questions without redeploying the bridge.
- Each business can customise its greeting and FAQs from the Trade dashboard.
- A future Trade chat agent reads the same profile, so phone and chat behave the same way.
- Calls stay fast and safe because the runtime doesn't move.

Two safeguards when doing it:
- Limit the size of text from Trade, as onboarding already does (20,000 characters).
- Keep the bridge's fixed safety instructions in charge; Trade's text adds to them and can't override them.

## 3. How each Trade business gets its own agent today

Every Trade business gets its own isolated Sophie for each call, but no business has its own agent settings yet. One shared Sophie (in the bridge) runs each call using that business's identity, data and permissions.

| What makes the call specific to one business | Where in Trade |
|---|---|
| **Phone number → business** | Firestore DID mappings collection (`did → businessId`, on/off), managed on the **DID mappings** dashboard page (`app/dashboard/did-mappings`, `lib/ai/data/did-mappings.ts`) |
| **Who Sophie works for** | `businesses/{businessId}`: name, address, phone, email, timezone, status. Served by `get_business_profile` (`lib/ai/mcp/tools/service.tools.ts`) |
| **What the business offers** | `services` where `businessId` matches and `isActive` is true (`list_services`) |
| **Customers, availability, inspections** | Always filtered to that `businessId` (`customer.tools.ts`, `booking.tools.ts`) |
| **What Sophie is allowed to do** | `sophieBookingAuthority`, the "Allow Sophie to assign staff and confirm bookings" toggle (`components/business-ai-booking-settings.tsx`) |
| **Platform switches** (all businesses) | `AI_VOICE_DIRECT_ENABLED`, `AI_VOICE_ACTIONS_ENABLED`, `AI_AUTO_ASSIGN_STAFF_ENABLED` |

How a call becomes a specific business's agent:

```
Call to 0359111403
 → bridge asks Trade /api/ai/voice → DID mapping → businessId (Nira Electrical Lynbrook)
 → bridge opens Trade /api/ai/mcp with that DID + businessId
 → every tool reads ONLY that business: profile, services, customers, availability
 → Sophie greets as "Nira Electrical Lynbrook" and books only into that business
```

Business A and Business B share the same Sophie, but on each call she only sees and changes one business's data.

## 4. What's missing for a real per-business agent

These are planned in the Trade project but are still **empty** or return "Not implemented" (501):

| Planned piece | Files | Purpose |
|---|---|---|
| AI dashboard pages | `app/dashboard/ai/knowledge`, `ai/calls`, `ai/unanswered` (headings only) | Owner screens to manage their agent |
| Knowledge base (RAG) | `lib/ai/rag/*`, `lib/ai/data/knowledge-*.ts`, `app/api/ai/knowledge` (501), `lib/ai/mcp/tools/knowledge.tools.ts` | Each business's own FAQs, documents and policies for Sophie to answer from |
| Call logs and summaries | `lib/ai/calls/*`, `lib/ai/data/call-logs.ts`, `app/api/ai/calls` (501) | Each business sees its own calls |
| Learning loop | `lib/ai/learning/*` (approve, redact, unanswered, suggest-from-handoff), `app/api/ai/unanswered` (501) | Questions Sophie couldn't answer → owner approves an answer → it goes into knowledge |
| Handover | `lib/ai/mcp/tools/escalation.tools.ts` | Pass the caller to staff |
| Chat agent | `lib/ai/agent/*`, `app/api/ai/chat` (501) | Text version of the agent |
| Agent profile | not present | Each business's greeting, tone, extra questions |

## 5. How each business would get its own agent

Everything would live in Trade, scoped by `businessId`. The bridge reads it through MCP:

1. **Agent profile:** greeting, tone and extra questions per business. The bridge reads it at call start, the same way onboarding works today.
2. **Knowledge:** the owner adds FAQs and documents on the **AI knowledge** page, and Sophie looks them up with a `search_knowledge` tool, filtered to that business.
3. **Unanswered questions:** Sophie logs what she couldn't answer, the owner approves an answer on the **Unanswered** page, and it becomes knowledge. That's the learning loop.
4. **Call logs:** the bridge sends call events and summaries, and the owner sees them on the **AI calls** page.

**Summary:** today each business gets an isolated Sophie that knows its name, services, customers and booking permission. Knowledge, call history and learning aren't built yet; their folders and pages exist as placeholders in Trade.
