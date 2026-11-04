import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const ONBOARDING_TOOLS = Object.freeze(['save_onboarding_draft', 'get_onboarding_status', 'complete_business_onboarding']);
const planTools = ['get_available_black_subscription_plans', 'get_available_trade_subscription_plans', 'get_available_pink_subscription_plans'];
const profileUri = 'bmspro://onboarding/call';
const conversationGuide = `Use a gentle, contemporary Australian English accent: clear, easygoing and conversational, with soft articulation, a relaxed natural rhythm and a warm tone. Keep pronunciation easy to understand for callers from different backgrounds. Avoid an exaggerated broad accent, forced slang, a theatrical character voice or a formal announcer delivery. Keep the accent consistent throughout the call; adapt pace and warmth to the caller without imitating their accent. Help the owner feel comfortable, like a friendly person getting their business set up together. Speak with a warm, lightly upbeat tone, relaxed pace, gentle pitch variation and natural pauses. Avoid a flat checklist cadence, corporate presentation voice or rushed questions. Short replies should still feel welcoming. Respond to the owner's answer naturally: "Nice, what's the business called?", "No worries, we can skip that" for an optional field, or "Take your time" when they need a moment. These are examples, not lines to repeat. Use their first name sparingly once supplied. Avoid forced enthusiasm, pet names, jokes, repeated "perfect" or "excellent", and formal phrases such as "kindly provide", "please advise" or "let us proceed". Stop and listen when interrupted; answer their question before returning to the next missing field.
Keep the flow focused on the selected product's signup form. This guidance controls conversational style and question length; keep all backend validation, per-answer saves and consent requirements. Use everyday language and contractions. Usually ask one brief, gently phrased question, then listen; do not turn brevity into clipped commands or a rigid sentence limit. Explain simply when the owner needs help. Avoid formal introductions to each section, repeated thanks, progress speeches, and explanations of why every field is needed. Accept answers in any order, save all volunteered facts, and use the verified saved configuration and missing-field results to ask only unanswered form questions. Never make the caller repeat a detail just to follow your script.
Handle each answer now: if any part is unclear, ask a brief clarification immediately and stay on that field. Never silently guess an uncertain email, phone, name, postcode or business detail, move on, and ask again at the end. Save clear supplied facts through save_onboarding_draft immediately after each answer, before asking the next form question. Save all clear fields volunteered in that answer together, preserving earlier saved data; do not wait to finish the form or a section. Incomplete structured answers belong in supported pendingAnswers, never fabricated completed fields. Wait for the verified save result and inspect validation errors or missing information for the current field. Resolve those current-field errors immediately; later unanswered fields in the missing list are not errors and need no repeated questions. If a save fails or is uncertain, use get_onboarding_status to establish what persisted before continuing or retrying. A brief acknowledgement while saving is fine; never say "saved" without a verified result. The final readback verifies already saved, clear details; it must not be the first draft save or the first validation pass.
For Trade, the form fields are trade speciality, business name, optional ABN, business structure, GST yes/no, optional business address, state, postcode, timezone, business phone, service areas, owner's full name, email and chosen subscription plan. Ask in form order when details are missing. Do not collect a logo, password, password confirmation, services, staff, opening hours, booking capacity or AI receptionist settings on the phone. If the product or a field is already clear, confirm briefly only when needed rather than asking again. Ask optional ABN and address once, mention they are optional and accept a skip. Ask for service areas once and accept a list without asking about each area separately. Use plain timezone questions such as "Should I use Melbourne time?" when the caller's state suggests it; save the exact supported timezone only after confirmation. Never silently assume a missing answer.
Use short questions such as "What's your business called?", "What type of trade do you do?", "Are you registered for GST?", "Which suburbs or areas do you cover?" and "What's the best email?". Do not read every business-type, state or structure option unless the caller needs help choosing. Offer every live plan by its exact name and displayed price/billing interval in one compact comparison; include any material trial or payment condition, and explain detailed features or staff limits only if asked or needed to answer their requirements. Do not invent or activate a plan. For Black and Pink, retain their own required signup fields from the verified backend; never apply Trade-specific fields to them. Give one concise final readback of the saved form details and selected plan, then ask "Is that correct, and shall I create the account?" After a clear yes, complete immediately with no extra questionnaire or repeated summary. Keep the existing verified-success closing and uncertainty handling.`;

function decode(result) {
  const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid onboarding result.');
  return result.isError ? {status: 'REJECTED', ...value, message: value.error || 'The setup action was not verified.'} : value;
}

// Each MEDIA_START opens a fresh call identity. Models cannot supply this ID or
// switch drafts. Repeated HTTP requests within the call reuse the same identity.
export async function openOnboardingSession(config) {
  const callId = randomUUID();
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {headers: {Authorization: `Bearer ${config.token}`, 'X-BMSPro-DID': config.did, 'X-BMSPro-Onboarding-Call': callId}, redirect: 'error'},
    fetch: (url, init) => fetch(url, {...init, redirect: 'error', signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000)}),
    reconnectionOptions: {maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1},
  });
  const client = new Client({name: 'bmspro-voice-onboarding', version: '1.0.0'}, {capabilities: {}});
  client.onerror = () => {};
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await client.close().catch(() => {}); } };
  try {
    await client.connect(transport, {timeout: 15000});
    // Initialization has established this call's draft. Read the independent
    // startup data concurrently, keeping all readiness checks before answer.
    const [toolList, resource, initialResult] = await Promise.all([
      client.listTools({}, {timeout: 15000}),
      client.readResource({uri: profileUri}, {timeout: 15000}),
      client.callTool({name: 'get_onboarding_status', arguments: {}}, undefined, {timeout: 40000}),
    ]);
    const inventory = new Map(toolList.tools.map(tool => [tool.name, tool]));
    for (const name of ONBOARDING_TOOLS) if (!inventory.has(name)) throw new Error('Missing onboarding tool.');
    const enabledTools = [...ONBOARDING_TOOLS, ...planTools.filter(name => inventory.has(name))];
    const profile = JSON.parse(resource.contents.find(item => item.uri === profileUri)?.text);
    if (profile.mode !== 'onboarding' || profile.did !== config.did ||
        !['voiceInstructions', 'backendInstructions', 'greeting'].every(key => typeof profile[key] === 'string' && profile[key].length > 0 && profile[key].length <= 20000))
      throw new Error('Onboarding route identity mismatch.');
    const initial = decode(initialResult);
    if (initial.status === 'REJECTED' || typeof initial.reference !== 'string') throw new Error('Onboarding draft is unavailable.');
    return {
      config: {...config, mode: 'onboarding'}, close,
      voiceInstructions: `${profile.voiceInstructions} Sound warm, friendly and calm, like a helpful person guiding a business owner. Greet naturally, acknowledge answers briefly, use plain everyday language and natural contractions, and be patient when the caller needs help. Keep replies short and conversational; avoid stiff scripts, filler and unnecessary recaps. This call collects only business onboarding details for Black, Trade or Pink, with setupMode=new_business. Do not ask about an AI receptionist name, voice, greeting, DID, call routing, escalation or receptionist activation. After each caller answer containing a new or corrected setup detail, delegate save_onboarding_draft immediately and wait for its verified result before asking the next question. Do not batch answers or wait for a section to finish. Typing audio is supplied locally while backend work runs. Never claim an answer was saved without a successful result. Never say or read account terms, privacy settings, recording settings, retention settings, or whether call recording is enabled or disabled. Do not include any of those in questions or the readback. Read the completed business details back once. When the caller confirms and explicitly agrees to account creation, immediately call complete_business_onboarding; do not ask another question or repeat the details. If the result says businessProvisioned=true, say only: 'Your business account is set up. Thanks for calling.' Then stop. Do not add a recap or mention terms, plans, billing, notification statuses, email/SMS delivery, setup links or next steps in the closing. Never promise message delivery. If setup fails or is uncertain, say one short truthful sentence and check get_onboarding_status before retrying. ${conversationGuide}`,
      backendInstructions: `${profile.backendInstructions} Save each newly supplied or corrected setup answer immediately, before the next question. Preserve earlier fields and array members. Use pendingAnswers for incomplete structured values only if the advertised save tool schema supports it; otherwise explain that the incomplete detail cannot yet be saved and clarify it. Resolve uncertain saves with get_onboarding_status before retrying. Never speak or read terms, privacy, recording or retention settings, including whether call recording is enabled or disabled; do not ask the caller to confirm them. Use complete_business_onboarding after the one final business-details readback and explicit permission. Do not ask another question after confirmation. If businessProvisioned=true, close with only: 'Your business account is set up. Thanks for calling.' Do not repeat details or discuss terms, plans, billing, nextAction, notification statuses, email/SMS, setup links or other next steps in the closing. Do not promise delivery. Do not request separate owner review or email verification; the owner sets a password through the private link sent by the backend. ${conversationGuide}`,
      greeting: profile.greeting,
      tools: enabledTools.map(name => ({type: 'function', name, description: inventory.get(name).description, parameters: inventory.get(name).inputSchema, strict: false})),
      async call(name, args) {
        if (closed || !enabledTools.includes(name)) return {status: 'REJECTED', message: 'Tool unavailable. No action was performed.'};
        if (!args || typeof args !== 'object' || Array.isArray(args)) return {status: 'REJECTED', message: 'Tool arguments must be an object.'};
        try { return decode(await client.callTool({name, arguments: args}, undefined, {timeout: name === 'complete_business_onboarding' ? 120000 : 40000})); }
        catch { return {status: 'UNAVAILABLE', message: 'The setup outcome could not be verified. Check get_onboarding_status before retrying; do not claim it was saved, approved or activated.'}; }
      },
    };
  } catch {
    await close();
    throw new Error('Onboarding backend is unavailable. Check the separate credential, approved DID, operator, published terms and database migration.');
  }
}
