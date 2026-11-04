import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const PINK_READ_TOOLS = Object.freeze(['get_business_profile', 'list_services', 'get_available_slots']);
const writeTool = 'create_booking';
const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
function decode(result) {
  if (result.isError) throw new Error('Pink tool failed.');
  const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
  try { return JSON.parse(text); } catch { throw new Error('Pink tool returned invalid data.'); }
}

export async function openPinkSession(config, {onTiming} = {}) {
  const client = new Client({name: 'bmspro-voice-pink', version: '1.0.0'}, {capabilities: {}});
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {headers: {Authorization: `Bearer ${config.token}`, ...config.routingHeaders}, redirect: 'error'},
    fetch: (url, init) => fetch(url, {...init, redirect: 'error', signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000)}),
    reconnectionOptions: {maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1},
  });
  client.onerror = () => {};
  let closed = false, submission;
  const services = new Set(), slotTokens = new Set();
  const close = async () => { if (!closed) { closed = true; await client.close().catch(() => {}); } };
  const timed = async (phase, operation) => {
    const started = performance.now();
    try { return await operation(); } finally { onTiming?.(phase, Math.round(performance.now() - started)); }
  };
  try {
    await timed('initialize', () => client.connect(transport, {timeout: 15000}));
    const [listed, profileResult] = await Promise.all([
      timed('tool_inventory', () => client.listTools({}, {timeout: 15000})),
      timed('pink_profile', () => client.callTool({name: 'get_business_profile', arguments: {}}, undefined, {timeout: 30000})),
    ]);
    const inventory = new Map(listed.tools.map(tool => [tool.name, tool]));
    for (const name of PINK_READ_TOOLS) if (!inventory.has(name)) throw new Error('Missing Pink read tool.');
    const profile = decode(profileResult);
    const branch = profile?.branch;
    if (profile?.brand !== 'pink' || String(profile.did).replace(/^\+/, '') !== config.did ||
        typeof profile.ownerUid !== 'string' || !profile.ownerUid || typeof branch?.id !== 'string' ||
        typeof branch?.name !== 'string' || !branch.name.trim()) throw new Error('Pink profile identity unavailable.');
    const timezone = branch.timezone || 'Australia/Sydney';
    new Intl.DateTimeFormat('en-AU', {timeZone: timezone}).format();
    const names = [...PINK_READ_TOOLS, ...(inventory.has(writeTool) ? [writeTool] : [])];
    const salonName = typeof branch.salonName === 'string' ? branch.salonName : typeof branch.ownerName === 'string' ? branch.ownerName : 'BMS Pro Pink';
    const context = `You serve only the Pink salon ${JSON.stringify(salonName)}, branch ${JSON.stringify(branch.name)}, timezone ${JSON.stringify(timezone)}.`;
    return {
      config: {...config, mode: 'pink', businessName: salonName, branch: branch.name}, profile, close,
      greeting: `Greet the caller for ${JSON.stringify(salonName)}, ${JSON.stringify(branch.name)}. Introduce yourself as Sophie, its AI receptionist, and ask how you can help.`,
      voiceInstructions: `${context} Speak warmly, briefly and naturally. Ask one question at a time. Use Pink tools for current services, prices and availability. Explain that an available time is not reserved. Before submitting a booking, read back the service, branch, local date and time, customer name, email and phone once and obtain explicit confirmation. Do not ask for or handle passwords or payment details. Say a booking is confirmed only if Pink returns CONFIRMED; PENDING_REVIEW means the salon must review it; UNKNOWN means staff must verify it. Never read internal IDs, slot tokens or request keys aloud.`,
      backendInstructions: `${context} Use only the advertised Pink tools and only facts from their successful results. Never use Black drop-off or Trade inspection workflows. For availability, ask which service and date, then call get_available_slots using an active service ID returned by list_services. Offer no more than three returned times, explain availability is not a reservation, and do not say an empty or failed result means the salon is closed. ${inventory.has(writeTool) ? 'Call create_booking only after the complete read-back and explicit confirmation. Keep the same request key for an identical retry; UNKNOWN must be checked by staff, never resubmitted with a new key.' : 'Booking submission is disabled; offer staff assistance and do not claim a request was created.'} Never say internal IDs, tokens or request keys.`,
      tools: names.map(name => {
        const tool = inventory.get(name), parameters = structuredClone(tool.inputSchema);
        if (name === writeTool) {
          delete parameters.properties?.requestKey;
          if (Array.isArray(parameters.required)) parameters.required = parameters.required.filter(key => key !== 'requestKey');
        }
        return {type: 'function', name, description: tool.description, parameters, strict: false};
      }),
      async call(name, args) {
        if (closed || !names.includes(name)) return {status: 'REJECTED', message: 'Tool unavailable; no action was performed.'};
        if (!args || typeof args !== 'object' || Array.isArray(args) || ['ownerUid', 'branchId', 'businessId', 'requestKey'].some(key => Object.hasOwn(args, key)))
          return {status: 'REJECTED', message: 'Use only the advertised arguments; salon selection and request identity are controlled by the server.'};
        if (name === 'get_available_slots' && (typeof args.serviceIds?.[0] !== 'string' || args.serviceIds.length !== 1 || args.serviceIds.some(id => !services.has(id))))
          return {status: 'REJECTED', message: 'Read list_services in this call and use one returned active service ID.'};
        if (name === writeTool) {
          if (args.customerConfirmed !== true) return {status: 'CONFIRMATION_REQUIRED', message: 'Read back all booking details and get explicit confirmation first.'};
          if (!slotTokens.has(args.slotToken)) return {status: 'REJECTED', message: 'Use a current slot token returned by get_available_slots in this call.'};
          const fingerprint = canonical(args);
          if (submission) return submission.fingerprint === fingerprint ? submission.result : {status: 'REJECTED', message: 'A booking request is already submitted or uncertain in this call. Ask staff to verify it.'};
          submission = {fingerprint, result: {status: 'UNKNOWN', message: 'Staff must verify this request. Do not retry or claim it was saved.'}};
        }
        try {
          const callArgs = name === writeTool ? {...args, requestKey: randomUUID()} : args;
          const result = decode(await client.callTool({name, arguments: callArgs}, undefined, {timeout: 40000}));
          if (name === 'get_business_profile' && (result?.brand !== 'pink' || String(result.did).replace(/^\+/, '') !== config.did || result.branch?.id !== branch.id))
            throw new Error('Pink identity changed.');
          if (name === 'list_services') {
            if (!Array.isArray(result) || result.some(service => typeof service?.id !== 'string')) throw new Error('Invalid Pink service result.');
            services.clear(); for (const service of result) services.add(service.id);
          }
          if (name === 'get_available_slots') {
            if (result?.brand !== 'pink' || !Array.isArray(result.slots)) throw new Error('Invalid Pink availability result.');
            for (const slot of result.slots) if (typeof slot.slotToken === 'string') slotTokens.add(slot.slotToken);
          }
          if (name === writeTool) return submission.result = result;
          return result;
        } catch {
          return name === writeTool ? submission.result : {status: 'UNAVAILABLE', message: 'Pink lookup could not be verified. Do not infer business facts or availability.'};
        }
      },
    };
  } catch {
    await close();
    const error = new Error('Pink MCP unavailable. Check Pink MCP flags, configured DID, Firebase Pink credentials and branch assignment.');
    error.code = 'PINK_SETUP_FAILED';
    throw error;
  }
}
