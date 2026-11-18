/**
 * trade-action-policy.mjs: the safety gate between Sophie (the voice model) and the Trade MCP tools.
 *
 * Where it sits in a call:
 *   caller -> Sophie (model) -> trade-tools.mjs `tools[].call()` -> THIS POLICY -> `remote()` -> Trade MCP
 *   (`remote` is the callback trade-tools.mjs passes in; it does `client.callTool()` over HTTP to
 *   Trade's /api/ai/mcp route.)
 *
 * The model never talks to Trade directly. Every tool call is checked here first:
 *   1. Is the tool allowed for this business? (`names`, built from what Trade advertises)
 *   2. Are the arguments valid and free of server-controlled fields? (businessId, requestKey, ...)
 *   3. Were the prerequisites done in THIS call? (list_services, find_customer, find_job,
 *      get_available_slots, then prepare, then caller confirmation)
 *   4. For writes: attach a private retry key and never allow a second, different write.
 *   5. Is Trade's reply the shape we expect? If not, return UNAVAILABLE/UNKNOWN, never a guess.
 *
 * One policy object is created per phone call (see openTradeSession in trade-tools.mjs), so all
 * the Maps/Sets below are per-call memory and vanish when the call ends.
 */
import {randomUUID} from 'node:crypto';

/** Read-only tools that are always offered; they take no arguments. */
const baseTools = ['get_business_profile', 'list_services'];
/** Tools that change data in Trade. Each gets a private requestKey and is limited to one saved action per call. */
export const writeTools = Object.freeze([
  'register_customer',
  'create_inspection_request',
  'create_job_booking',
  'reschedule_job',
  'cancel_job',
]);
/** Writes that change an EXISTING job; these need a verified find_job result first. */
const jobWrites = ['reschedule_job', 'cancel_job'];
/** JSON with object keys sorted, so two equal argument sets always produce the same string (used as a fingerprint). */
const canonical = value =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map(key => [key, item[key]]),
        )
      : item,
  );
/** True for a plain object (not null, not an array). */
const object = value => value && typeof value === 'object' && !Array.isArray(value);
/** True when `value` is an object whose keys are all in `keys`; blocks extra or smuggled arguments. */
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
/** A safe Trade document id: non-empty string, max 128 chars, no "/" (Firestore path), not "." or "..". */
const id = value =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 128 &&
  !value.includes('/') &&
  !['.', '..'].includes(value);
/** A real calendar date as YYYY-MM-DD (rejects 2026-02-31). */
const date = value =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
/** Result shape for "the bridge refused this call"; nothing was sent to Trade. */
const rejected = message => ({status: 'REJECTED', message});
/** Result shape for "a write may or may not have saved"; Sophie must not retry or claim success. */
const unknown = () => ({
  status: 'UNKNOWN',
  message: 'Staff must verify whether this action was saved. Do not resubmit or claim success.',
});
/** Spoken words that stand for a symbol inside an email address. */
const spokenSymbols = {dot: '.', period: '.', point: '.', underscore: '_', hyphen: '-', dash: '-'};
/**
 * Turn an email written down the way it was said ("john dot smith at gmail dot com", or spelled
 * "j o h n @ gmail.com") into its written form. Real addresses never contain spaces, so a word between
 * spaces such as "dot" is always a spoken symbol and spelled letters are joined. "at" becomes "@" only
 * when there is no "@" yet and it is said exactly once. A trailing full stop from speech-to-text is
 * dropped. The result still has to pass the normal email check, and the caller hears it read back.
 */
export function writtenEmail(value) {
  if (typeof value !== 'string') return value;
  const words = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const spokenAt = !words.some(word => word.includes('@')) && words.filter(word => word === 'at').length === 1;
  return words
    .map(word => spokenSymbols[word] ?? (spokenAt && word === 'at' ? '@' : word))
    .join('')
    .replace(/\.+$/, '');
}
const validEmail = email => typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
/** Which contact fields are missing or invalid, for a targeted question instead of asking for everything. */
function invalidContactFields(value, full = false) {
  const fields = [];
  const given = object(value) ? value : {};
  if (
    full &&
    (typeof given.fullName !== 'string' || given.fullName.trim().length < 2 || given.fullName.trim().length > 200)
  )
    fields.push('fullName');
  if (!validEmail(writtenEmail(given.email))) fields.push('email');
  if (typeof given.phone !== 'string' || !/^\d{6,15}$/.test(given.phone.replace(/\D/g, '')))
    fields.push('phone');
  return fields.length ? fields : ['customer'];
}
/** What Sophie should say when the email could not be used: spell it, letter by letter, kindly. */
export const SPELL_EMAIL_GUIDANCE =
  'The email was not captured correctly. Kindly ask the caller to spell it letter by letter, for example "Sorry, I didn\'t quite catch that. Could you spell the email for me, letter by letter?" Write down exactly the letters they say, then read it back slowly letter by letter in short groups, saying "at" and "dot" as words, and wait for a yes before trying again. If only one part was unclear, ask them to spell just that part.';
/** A rejection that names only the bad contact fields, with a friendly way to fix each one. */
function contactRejection(fields) {
  const help = [];
  if (fields.includes('email')) help.push(SPELL_EMAIL_GUIDANCE);
  if (fields.includes('phone'))
    help.push('For the phone, ask only for the missing or unclear digits and read the number back in short groups.');
  if (fields.includes('fullName')) help.push('Ask for the first and last name and read it back.');
  return {
    status: 'REJECTED',
    code: 'INVALID_CUSTOMER_DETAILS',
    invalidFields: fields,
    message: [
      'Correct only the listed invalid fields using the existing call context first. Ask a targeted clarification only if the caller must supply a correction. Do not ask for all contact details again.',
      ...help,
    ].join(' '),
  };
}
/**
 * Validate and normalise caller contact details. Returns {email, phone} (written, lower-cased email,
 * digits-only phone of 6-15 digits), or with `full` also {fullName} (2-200 chars). Returns null if
 * anything is off.
 */
function contact(value, full = false) {
  if (
    !only(value, full ? ['fullName', 'email', 'phone'] : ['email', 'phone']) ||
    typeof value.email !== 'string' ||
    typeof value.phone !== 'string'
  )
    return null;
  const email = writtenEmail(value.email),
    phone = value.phone.replace(/\D/g, '');
  if (!validEmail(email) || !/^\d{6,15}$/.test(phone)) return null;
  if (!full) return {email, phone};
  if (
    typeof value.fullName !== 'string' ||
    value.fullName.trim().length < 2 ||
    value.fullName.trim().length > 200
  )
    return null;
  return {fullName: value.fullName.trim(), email, phone};
}
/** Stable key for an email+phone pair; ties a customerId to the contacts it was returned for. */
const contactKey = value => canonical({email: value.email, phone: value.phone});
/** A 24-hour HH:MM time. */
const clock = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
/** Same normalisation as Trade: spoken references may drop the BK prefix or add spaces. */
function jobCode(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  let compact = value.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (compact.length === 11 && compact.startsWith('BK')) compact = compact.slice(2);
  return /^[2-9A-HJKMNP-Z]{9}$/.test(compact) ? `BK ${compact}` : null;
}
/**
 * One to three distinct preferred sessions: {date, timeRange: morning|afternoon} plus optional startTime
 * (and endTime when `allowEnd`, which must be after startTime). Returns the cleaned list or null.
 */
function sessions(value, allowStart, allowEnd = false) {
  const keys = allowStart ? ['date', 'timeRange', 'startTime'] : ['date', 'timeRange'];
  if (allowEnd) keys.push('endTime');
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 3 ||
    value.some(
      slot =>
        !only(slot, keys) ||
        !date(slot.date) ||
        !['morning', 'afternoon'].includes(slot.timeRange) ||
        (slot.startTime != null && !clock(slot.startTime)) ||
        (slot.endTime != null &&
          (!clock(slot.endTime) || (slot.startTime && slot.endTime <= slot.startTime))),
    )
  )
    return null;
  if (new Set(value.map(slot => `${slot.date}:${slot.timeRange}`)).size !== value.length) return null;
  return value.map(slot =>
    allowStart
      ? {
          date: slot.date,
          timeRange: slot.timeRange,
          startTime: slot.startTime ?? null,
          ...(allowEnd && slot.endTime ? {endTime: slot.endTime} : {}),
        }
      : {date: slot.date, timeRange: slot.timeRange},
  );
}
/** Validate a job/site address {street, suburb, state, 4-digit postcode}; returns it trimmed, or null. */
function address(value) {
  if (
    !only(value, ['street', 'suburb', 'state', 'postcode']) ||
    typeof value.street !== 'string' ||
    value.street.length > 300 ||
    typeof value.suburb !== 'string' ||
    !value.suburb.trim() ||
    value.suburb.length > 200 ||
    typeof value.state !== 'string' ||
    !value.state.trim() ||
    value.state.length > 100 ||
    !/^\d{4}$/.test(value.postcode)
  )
    return null;
  return {
    street: value.street.trim(),
    suburb: value.suburb.trim(),
    state: value.state.trim(),
    postcode: value.postcode,
  };
}

/**
 * Build the policy for ONE phone call. Models never supply request keys.
 *
 * @param inventory Map of tool name -> MCP tool definition, from Trade's `tools/list`. A tool Trade does
 *                  not advertise (feature flag off, no authority) can never be offered to Sophie.
 * @param remote    async (name, args) => result. Sends the call to Trade over MCP and returns the decoded JSON.
 * @returns {{names, prepare, submit, call}}
 *   names   tools Sophie may use in this call
 *   prepare validate and hold details (nothing saved); returns READY_FOR_CONFIRMATION
 *   submit  send the held details after the caller's yes (only `customerConfirmed: true` is accepted)
 *   call    the general entry point; every tool goes through it
 */
export function createTradeActionPolicy(inventory, remote) {
  // Per-call memory, filled from verified Trade results:
  const services = new Set(), // service ids returned by list_services; only these may be booked
    customers = new Map(), // customerId -> contactKey, from find_customer / register_customer
    checks = [], // availability windows already read: {from, to, unavailable:Set('date:session')}
    writes = new Map(), // write tool name -> {fingerprint, requestKey, result}; enforces one write per tool
    jobs = new Map(); // jobCode -> {contact, canChange}, from a MATCHED find_job
  // Prepared details per submission tool (inspection or job), held only in this call.
  const prepared = new Map();
  // Knowledge answers already fetched in this call, so a repeated question answers instantly.
  const knowledge = new Map();
  const knowledgeKey = question =>
    question
      .toLowerCase()
      .replace(/[^\p{L}\p{N}$%]+/gu, ' ')
      .trim();
  // Tools Sophie may use. A write is offered only when the reads it depends on are also advertised, e.g.
  // create_job_booking needs find_customer + get_available_slots + create_job_booking all present.
  const names = [
    ...baseTools,
    ...['find_customer', 'get_available_slots'].filter(name => inventory.has(name)),
  ];
  if (inventory.has('find_customer') && inventory.has('register_customer')) names.push('register_customer');
  if (
    inventory.has('find_customer') &&
    inventory.has('get_available_slots') &&
    inventory.has('create_inspection_request')
  )
    names.push('create_inspection_request');
  if (inventory.has('find_job')) names.push('find_job');
  if (
    inventory.has('find_customer') &&
    inventory.has('get_available_slots') &&
    inventory.has('create_job_booking')
  )
    names.push('create_job_booking');
  // Changing a job needs this call's verified lookup and a live availability check first.
  for (const name of jobWrites)
    if (inventory.has('find_job') && inventory.has('get_available_slots') && inventory.has(name))
      names.push(name);
  // Read-only RAG search; advertised by Trade only when AI_VOICE_KNOWLEDGE_ENABLED=true.
  if (inventory.has('search_business_knowledge')) names.push('search_business_knowledge');
  // True if any requested session has no availability check covering its date, or was reported unavailable.
  const unchecked = slots =>
    slots.some(slot => {
      const latest = [...checks].reverse().find(check => slot.date >= check.from && slot.date <= check.to);
      return !latest || latest.unavailable.has(`${slot.date}:${slot.timeRange}`);
    });
  const policy = {
    names,
    /** Step 1 of a booking: validate everything and hold it for this call. Saves nothing in Trade. */
    async prepare(raw, name = 'create_inspection_request') {
      prepared.delete(name);
      if (!object(raw) || Object.hasOwn(raw, 'customerConfirmed'))
        return rejected('Prepare the collected details without a confirmation flag.');
      return policy.call(name, {...raw, customerConfirmed: true}, {prepareOnly: true});
    },
    /** Step 2: after the caller says yes, send the held details. The model passes only customerConfirmed=true. */
    async submit(raw, name = 'create_inspection_request') {
      if (!only(raw, ['customerConfirmed']))
        return rejected(
          'Submit only the confirmation flag; reuse the prepared details without asking the caller again.',
        );
      if (raw.customerConfirmed !== true)
        return {
          status: 'CONFIRMATION_REQUIRED',
          message: 'Submit only after the caller explicitly agrees to send the prepared request.',
        };
      if (!prepared.has(name))
        return {
          status: 'PREPARATION_REQUIRED',
          message:
            'Prepare the details already collected in this call first. Do not restart name, phone or email questions unless preparation identifies an actual missing or invalid field.',
        };
      return policy.call(name, structuredClone(prepared.get(name)));
    },
    /**
     * Run one tool call. Three phases:
     *   A. Gate and validate `raw` per tool, building the clean `args` (branches below, one per tool kind).
     *   B. For writes: check the one-write rule, then either hold the args (prepareOnly) or register a
     *      private requestKey, so a retry reuses it and a different second write is refused.
     *   C. Call Trade via `remote`, check the reply shape, and record what we learned (services,
     *      customers, jobs, availability) so later calls can rely on it. Any malformed reply or failure
     *      becomes UNAVAILABLE (reads) or UNKNOWN (writes) instead of a guess.
     */
    async call(name, raw, {prepareOnly = false} = {}) {
      if (!names.includes(name)) return rejected('Tool unavailable. No action was performed.');
      if (!object(raw) || ['businessId', 'slug', 'requestKey', 'status'].some(key => Object.hasOwn(raw, key)))
        return rejected(
          'Use only advertised arguments; business and request identity are server-controlled.',
        );
      // Phase A. `args` is what will actually be sent to Trade.
      let args;
      if (baseTools.includes(name)) {
        if (Object.keys(raw).length) return rejected('This tool takes empty arguments.');
        args = {};
      } else if (name === 'find_customer') {
        args = contact(raw);
        if (!args) return contactRejection(invalidContactFields(raw));
      } else if (name === 'find_job') {
        const code = jobCode(raw.jobCode),
          found = only(raw, ['jobCode', 'email', 'phone'])
            ? contact({email: raw.email, phone: raw.phone})
            : null;
        if (!code || !found)
          return rejected(
            'Ask for the job reference from the booking message plus the email and mobile on the job.',
          );
        args = {jobCode: code, ...found};
      } else if (jobWrites.includes(name)) {
        if (raw.customerConfirmed !== true)
          return {
            status: 'CONFIRMATION_REQUIRED',
            message: 'Read back the job change and obtain explicit confirmation first.',
          };
        const code = jobCode(raw.jobCode),
          verified = code && jobs.get(code);
        if (!verified)
          return {
            status: 'LOOKUP_REQUIRED',
            message:
              'Find this job with find_job in this call first, using the reference and the contacts on the job.',
          };
        if (!verified.canChange) return rejected('This job must be changed by the team. Do not attempt it.');
        const extra = name === 'reschedule_job' ? 'preferredSlots' : 'reason';
        if (!only(raw, ['customerConfirmed', 'jobCode', extra]))
          return rejected('Use only the advertised job change fields.');
        args = {customerConfirmed: true, jobCode: code, ...verified.contact};
        if (name === 'reschedule_job') {
          const slots = sessions(raw.preferredSlots, true);
          if (!slots)
            return rejected(
              'Choose one to three distinct new dates with morning/afternoon and an optional exact HH:MM start time.',
            );
          if (unchecked(slots))
            return {
              status: 'AVAILABILITY_REQUIRED',
              message: 'Check availability for every new date and choose sessions that are not unavailable.',
            };
          args.preferredSlots = slots;
        } else {
          const reason = raw.reason ?? '';
          if (typeof reason !== 'string' || reason.length > 500)
            return rejected('Keep the cancellation reason under 500 characters.');
          args.reason = reason.trim();
        }
      } else if (name === 'get_available_slots') {
        if (
          !only(raw, ['from', 'to']) ||
          !date(raw.from) ||
          !date(raw.to) ||
          raw.to < raw.from ||
          (Date.parse(raw.to) - Date.parse(raw.from)) / 86400000 >= 90
        )
          return rejected('Choose valid from/to dates spanning 1-90 days.');
        args = {from: raw.from, to: raw.to};
      } else if (name === 'search_business_knowledge') {
        const question =
          typeof raw.question === 'string' ? raw.question.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
        if (!only(raw, ['question']) || question.length < 3 || question.length > 300)
          return rejected(
            'Ask one short question about this business, without customer names, emails or phone numbers.',
          );
        args = {question};
        const known = knowledge.get(knowledgeKey(question));
        if (known) return structuredClone(known);
      } else {
        if (raw.customerConfirmed !== true)
          return {
            status: 'CONFIRMATION_REQUIRED',
            message: 'Read back the details and obtain explicit confirmation before this action.',
          };
        const customer = contact(raw.customer, true);
        if (!customer) return contactRejection(invalidContactFields(raw.customer, true));
        if (name === 'register_customer') {
          if (!only(raw, ['customerConfirmed', 'customer']))
            return rejected('Use only the advertised customer registration fields.');
          args = {customerConfirmed: true, customer};
        } else if (name === 'create_job_booking') {
          if (
            !only(raw, [
              'customerConfirmed',
              'serviceId',
              'customerId',
              'customer',
              'address',
              'preferredSlots',
              'customerNotes',
              'deferScheduling',
            ]) ||
            (raw.deferScheduling !== undefined && typeof raw.deferScheduling !== 'boolean')
          )
            return rejected('Use only the advertised job booking fields.');
          if (!services.has(raw.serviceId))
            return rejected(
              'List services in this call and choose a returned service. Jobs book existing services only; offer an inspection for advice.',
            );
          const site = address(raw.address),
            slots = sessions(raw.preferredSlots, true, true);
          if (!site)
            return rejected('Collect and read back the job address, suburb, state and four-digit postcode.');
          if (!slots)
            return rejected(
              'Choose one to three distinct preferred sessions. Start and finish are optional HH:MM values, and finish must be after start.',
            );
          const customerId = raw.customerId ?? null,
            customerNotes = raw.customerNotes ?? '';
          if (customerId !== null && (!id(customerId) || customers.get(customerId) !== contactKey(customer)))
            return rejected(
              'Use a customer reference returned for these same contact details in this call, or null for a guest.',
            );
          if (typeof customerNotes !== 'string' || customerNotes.length > 2000)
            return rejected('Keep job notes under 2000 characters.');
          if (!raw.deferScheduling && unchecked(slots))
            return {
              status: 'AVAILABILITY_REQUIRED',
              message:
                'Successfully check availability for every preferred date and choose sessions that are not unavailable.',
            };
          args = {
            customerConfirmed: true,
            serviceId: raw.serviceId,
            customerId,
            customer,
            address: site,
            preferredSlots: slots,
            customerNotes: customerNotes.trim(),
            ...(raw.deferScheduling ? {deferScheduling: true} : {}),
          };
        } else {
          if (
            !only(raw, [
              'customerConfirmed',
              'requestType',
              'serviceId',
              'customRequest',
              'customerId',
              'customer',
              'address',
              'preferredSlots',
              'budgetAud',
              'customerNotes',
            ])
          )
            return rejected('Use only the advertised inspection fields.');
          const requestType = raw.requestType === undefined ? 'existing_service' : raw.requestType;
          let serviceId = null,
            customRequest = null;
          if (requestType === 'existing_service') {
            if (!services.has(raw.serviceId) || raw.customRequest != null)
              return rejected(
                'List services in this call and choose a returned service. Do not combine a service request with a custom request.',
              );
            serviceId = raw.serviceId;
          } else if (requestType === 'custom_quote') {
            const scope = raw.customRequest;
            if (
              raw.serviceId != null ||
              !only(scope, ['title', 'description']) ||
              typeof scope.title !== 'string' ||
              scope.title.trim().length < 3 ||
              scope.title.trim().length > 120 ||
              (scope.description != null &&
                (typeof scope.description !== 'string' || scope.description.trim().length > 1500))
            )
              return rejected(
                'For advice, collect a scope of work of 3-120 characters and an optional description up to 1500 characters. Use no service reference; never invent one.',
              );
            customRequest = {title: scope.title.trim(), description: scope.description?.trim() || ''};
          } else return rejected('Choose existing_service or custom_quote (not sure / need advice).');
          const address = raw.address;
          if (
            !only(address, ['street', 'suburb', 'state', 'postcode']) ||
            typeof address.street !== 'string' ||
            address.street.length > 300 ||
            typeof address.suburb !== 'string' ||
            !address.suburb.trim() ||
            address.suburb.length > 200 ||
            typeof address.state !== 'string' ||
            !address.state.trim() ||
            address.state.length > 100 ||
            !/^\d{4}$/.test(address.postcode)
          )
            return rejected(
              'Collect and read back the service address, suburb, state and four-digit postcode.',
            );
          if (
            !Array.isArray(raw.preferredSlots) ||
            !raw.preferredSlots.length ||
            raw.preferredSlots.length > 3 ||
            raw.preferredSlots.some(
              slot =>
                !only(slot, ['date', 'timeRange']) ||
                !date(slot.date) ||
                !['morning', 'afternoon'].includes(slot.timeRange),
            )
          )
            return rejected('Choose one to three preferred dates and morning/afternoon sessions.');
          if (
            new Set(raw.preferredSlots.map(slot => `${slot.date}:${slot.timeRange}`)).size !==
            raw.preferredSlots.length
          )
            return rejected('Choose distinct preferred sessions.');
          const customerId = raw.customerId ?? null;
          if (customerId !== null && (!id(customerId) || customers.get(customerId) !== contactKey(customer)))
            return rejected(
              'Use a customer reference returned for these same contact details in this call, or null for a guest.',
            );
          const budgetAud = raw.budgetAud ?? null,
            customerNotes = raw.customerNotes ?? '';
          if (
            (budgetAud !== null &&
              (typeof budgetAud !== 'number' ||
                !Number.isFinite(budgetAud) ||
                budgetAud <= 0 ||
                budgetAud > 99999999)) ||
            typeof customerNotes !== 'string' ||
            customerNotes.length > 2000
          )
            return rejected('Check the optional budget and notes before submitting.');
          args = {
            customerConfirmed: true,
            requestType,
            serviceId,
            customRequest,
            customerId,
            customer,
            address: {
              street: address.street.trim(),
              suburb: address.suburb.trim(),
              state: address.state.trim(),
              postcode: address.postcode,
            },
            preferredSlots: raw.preferredSlots,
            budgetAud,
            customerNotes: customerNotes.trim(),
          };
        }
      }
      // Phase B: write bookkeeping.
      if (writeTools.includes(name)) {
        const existing = writes.get(name),
          fingerprint = canonical(args);
        if (existing)
          return existing.fingerprint === fingerprint
            ? existing.result
            : rejected(
                'This call already has a saved or uncertain action. Staff must verify it; do not submit another.',
              );
        if (
          name === 'create_inspection_request' &&
          args.preferredSlots.some(slot => {
            const latest = [...checks]
              .reverse()
              .find(check => slot.date >= check.from && slot.date <= check.to);
            return !latest || latest.unavailable.has(`${slot.date}:${slot.timeRange}`);
          })
        )
          return {
            status: 'AVAILABILITY_REQUIRED',
            message:
              'Successfully check availability for every preferred date and choose sessions that are not unavailable.',
          };
        if (prepareOnly) {
          prepared.set(name, structuredClone(args));
          const {customerConfirmed: _confirmation, ...summary} = args;
          return {
            status: 'READY_FOR_CONFIRMATION',
            summary,
            message:
              'The supplied details passed bridge validation and availability prerequisites. They are held in this call, not saved as a booking or reserved. Read back this summary once, obtain permission, then submit using only customerConfirmed=true. Do not ask for names or contacts again unless the caller corrects them. Backend live validation will run at submission.',
          };
        }
        writes.set(name, {fingerprint, requestKey: randomUUID(), result: unknown()});
      }
      // Phase C: call Trade and verify the reply.
      try {
        const state = writes.get(name);
        const result = await remote(
          name,
          writeTools.includes(name) ? {...args, requestKey: state.requestKey} : args,
        );
        if (writeTools.includes(name)) {
          const success =
            name === 'register_customer'
              ? ['CREATED', 'EXISTS'].includes(result?.status) && id(result.customerId)
              : name === 'create_inspection_request'
                ? ['PENDING_REVIEW', 'CONFIRMED'].includes(result?.status) && id(result.requestId)
                : name === 'cancel_job'
                  ? result?.status === 'CANCELLED' && !!jobCode(result.jobCode)
                  : name === 'create_job_booking' && result?.status === 'PENDING_REVIEW'
                    ? id(result.requestId)
                    : result?.status === 'CONFIRMED' &&
                      !!jobCode(result.jobCode) &&
                      date(result.appointment?.date) &&
                      clock(result.appointment?.startTime);
          if (success) {
            state.result = result;
            if (name === 'register_customer') customers.set(result.customerId, contactKey(args.customer));
            if (jobWrites.includes(name)) jobs.delete(args.jobCode);
          } else if (
            ['REJECTED', 'NOT_FOUND'].includes(result?.status) &&
            typeof result.message === 'string'
          ) {
            if (result.code === 'REQUEST_KEY_CONFLICT') state.result = result;
            else writes.delete(name);
            return result;
          }
          return state.result;
        }
        if (name === 'list_services') {
          if (
            !Array.isArray(result) ||
            result.some(service => !id(service?.id) || typeof service.name !== 'string')
          )
            throw new Error('Invalid services.');
          services.clear();
          for (const service of result) services.add(service.id);
        }
        if (name === 'find_job') {
          if (
            result?.status === 'MATCHED' &&
            jobCode(result.jobCode) === args.jobCode &&
            typeof result.job?.canChange === 'boolean'
          )
            jobs.set(args.jobCode, {
              contact: {email: args.email, phone: args.phone},
              canChange: result.job.canChange,
            });
          else if (!['NOT_FOUND', 'REJECTED'].includes(result?.status))
            throw new Error('Invalid job lookup.');
        }
        if (name === 'find_customer') {
          if (result?.status === 'MATCHED' && id(result.customerId))
            customers.set(result.customerId, contactKey(args));
          else if (!['NOT_FOUND', 'REJECTED'].includes(result?.status))
            throw new Error('Invalid customer match.');
        }
        if (name === 'get_available_slots') {
          if (
            result?.brand !== 'trade' ||
            result.from !== args.from ||
            result.to !== args.to ||
            !Array.isArray(result.unavailable) ||
            result.unavailable.some(
              slot => !date(slot?.date) || !['morning', 'afternoon'].includes(slot.timeRange),
            )
          )
            throw new Error('Invalid availability.');
          checks.push({
            from: args.from,
            to: args.to,
            unavailable: new Set(result.unavailable.map(slot => `${slot.date}:${slot.timeRange}`)),
          });
          if (checks.length > 20) checks.shift();
        }
        if (name === 'search_business_knowledge') {
          if (
            !['FOUND', 'NO_MATCH', 'REJECTED'].includes(result?.status) ||
            !Array.isArray(result.passages) ||
            result.passages.length > 8 ||
            result.passages.some(
              passage =>
                typeof passage?.title !== 'string' ||
                typeof passage.text !== 'string' ||
                passage.text.length > 2000,
            )
          )
            throw new Error('Invalid knowledge result.');
          if (result.status === 'FOUND' && !result.passages.length)
            throw new Error('Invalid knowledge result.');
          if (['FOUND', 'NO_MATCH'].includes(result.status)) {
            if (knowledge.size >= 30) knowledge.delete(knowledge.keys().next().value);
            knowledge.set(knowledgeKey(args.question), structuredClone(result));
          }
        }
        return result;
      } catch {
        return writeTools.includes(name)
          ? writes.get(name).result
          : {
              status: 'UNAVAILABLE',
              message:
                'The Trade lookup could not be verified. Do not invent customer details or availability.',
            };
      }
    },
  };
  return policy;
}
