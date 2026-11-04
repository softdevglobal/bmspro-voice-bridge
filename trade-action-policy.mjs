import {randomUUID} from 'node:crypto';

const baseTools = ['get_business_profile', 'list_services'];
const writeTools = ['register_customer', 'create_inspection_request'];
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('/') && !['.', '..'].includes(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const rejected = message => ({status: 'REJECTED', message});
const unknown = () => ({status: 'UNKNOWN', message: 'Staff must verify whether this action was saved. Do not resubmit or claim success.'});
function contact(value, full = false) {
  if (!only(value, full ? ['fullName', 'email', 'phone'] : ['email', 'phone']) || typeof value.email !== 'string' || typeof value.phone !== 'string') return null;
  const email = value.email.trim().toLowerCase(), phone = value.phone.replace(/\D/g, '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !/^\d{6,15}$/.test(phone)) return null;
  if (!full) return {email, phone};
  if (typeof value.fullName !== 'string' || value.fullName.trim().length < 2 || value.fullName.trim().length > 200) return null;
  return {fullName: value.fullName.trim(), email, phone};
}
const contactKey = value => canonical({email: value.email, phone: value.phone});

/** Per-call prerequisites, references and retry identity. Models never supply request keys. */
export function createTradeActionPolicy(inventory, remote) {
  const services = new Set(), customers = new Map(), checks = [], writes = new Map();
  const names = [...baseTools, ...['find_customer', 'get_available_slots'].filter(name => inventory.has(name))];
  if (inventory.has('find_customer') && inventory.has('register_customer')) names.push('register_customer');
  if (inventory.has('find_customer') && inventory.has('get_available_slots') && inventory.has('create_inspection_request')) names.push('create_inspection_request');
  return {
    names,
    async call(name, raw) {
      if (!names.includes(name)) return rejected('Tool unavailable. No action was performed.');
      if (!object(raw) || ['businessId', 'slug', 'requestKey', 'status'].some(key => Object.hasOwn(raw, key)))
        return rejected('Use only advertised arguments; business and request identity are server-controlled.');
      let args;
      if (baseTools.includes(name)) {
        if (Object.keys(raw).length) return rejected('This tool takes empty arguments.');
        args = {};
      } else if (name === 'find_customer') {
        args = contact(raw);
        if (!args) return rejected('Ask for a valid email and phone number.');
      } else if (name === 'get_available_slots') {
        if (!only(raw, ['from', 'to']) || !date(raw.from) || !date(raw.to) || raw.to < raw.from || (Date.parse(raw.to) - Date.parse(raw.from)) / 86400000 >= 90)
          return rejected('Choose valid from/to dates spanning 1-90 days.');
        args = {from: raw.from, to: raw.to};
      } else {
        if (raw.customerConfirmed !== true) return {status: 'CONFIRMATION_REQUIRED', message: 'Read back the details and obtain explicit confirmation before this action.'};
        const customer = contact(raw.customer, true);
        if (!customer) return rejected('Ask for a valid full name, email and phone; then read back and reconfirm.');
        if (name === 'register_customer') {
          if (!only(raw, ['customerConfirmed', 'customer'])) return rejected('Use only the advertised customer registration fields.');
          args = {customerConfirmed: true, customer};
        } else {
          if (!only(raw, ['customerConfirmed', 'serviceId', 'customerId', 'customer', 'address', 'preferredSlots', 'budgetAud', 'customerNotes']) || !services.has(raw.serviceId))
            return rejected('List services in this call and choose a returned service before booking.');
          const address = raw.address;
          if (!only(address, ['street', 'suburb', 'state', 'postcode']) || typeof address.street !== 'string' || address.street.length > 300 ||
              typeof address.suburb !== 'string' || !address.suburb.trim() || address.suburb.length > 200 || typeof address.state !== 'string' || !address.state.trim() || address.state.length > 100 || !/^\d{4}$/.test(address.postcode))
            return rejected('Collect and read back the service address, suburb, state and four-digit postcode.');
          if (!Array.isArray(raw.preferredSlots) || !raw.preferredSlots.length || raw.preferredSlots.length > 3 || raw.preferredSlots.some(slot =>
            !only(slot, ['date', 'timeRange']) || !date(slot.date) || !['morning', 'afternoon'].includes(slot.timeRange)))
            return rejected('Choose one to three preferred dates and morning/afternoon sessions.');
          if (new Set(raw.preferredSlots.map(slot => `${slot.date}:${slot.timeRange}`)).size !== raw.preferredSlots.length) return rejected('Choose distinct preferred sessions.');
          const customerId = raw.customerId ?? null;
          if (customerId !== null && (!id(customerId) || customers.get(customerId) !== contactKey(customer))) return rejected('Use a customer reference returned for these same contact details in this call, or null for a guest.');
          const budgetAud = raw.budgetAud ?? null, customerNotes = raw.customerNotes ?? '';
          if ((budgetAud !== null && (typeof budgetAud !== 'number' || !Number.isFinite(budgetAud) || budgetAud <= 0 || budgetAud > 99999999)) || typeof customerNotes !== 'string' || customerNotes.length > 2000)
            return rejected('Check the optional budget and notes before submitting.');
          args = {customerConfirmed: true, serviceId: raw.serviceId, customerId, customer,
            address: {street: address.street.trim(), suburb: address.suburb.trim(), state: address.state.trim(), postcode: address.postcode},
            preferredSlots: raw.preferredSlots, budgetAud, customerNotes: customerNotes.trim()};
        }
        const existing = writes.get(name), fingerprint = canonical(args);
        if (existing) return existing.fingerprint === fingerprint ? existing.result : rejected('This call already has a saved or uncertain action. Staff must verify it; do not submit another.');
        if (name === 'create_inspection_request' && args.preferredSlots.some(slot => {
          const latest = [...checks].reverse().find(check => slot.date >= check.from && slot.date <= check.to);
          return !latest || latest.unavailable.has(`${slot.date}:${slot.timeRange}`);
        })) return {status: 'AVAILABILITY_REQUIRED', message: 'Successfully check availability for every preferred date and choose sessions that are not unavailable.'};
        writes.set(name, {fingerprint, requestKey: randomUUID(), result: unknown()});
      }
      try {
        const state = writes.get(name);
        const result = await remote(name, writeTools.includes(name) ? {...args, requestKey: state.requestKey} : args);
        if (writeTools.includes(name)) {
          const success = name === 'register_customer' ? ['CREATED', 'EXISTS'].includes(result?.status) && id(result.customerId)
            : ['PENDING_REVIEW', 'CONFIRMED'].includes(result?.status) && id(result.requestId);
          if (success) {
            state.result = result;
            if (name === 'register_customer') customers.set(result.customerId, contactKey(args.customer));
          } else if (result?.status === 'REJECTED' && typeof result.message === 'string') {
            if (result.code === 'REQUEST_KEY_CONFLICT') state.result = result;
            else writes.delete(name);
            return result;
          }
          return state.result;
        }
        if (name === 'list_services') {
          if (!Array.isArray(result) || result.some(service => !id(service?.id) || typeof service.name !== 'string')) throw new Error('Invalid services.');
          services.clear(); for (const service of result) services.add(service.id);
        }
        if (name === 'find_customer') {
          if (result?.status === 'MATCHED' && id(result.customerId)) customers.set(result.customerId, contactKey(args));
          else if (!['NOT_FOUND', 'REJECTED'].includes(result?.status)) throw new Error('Invalid customer match.');
        }
        if (name === 'get_available_slots') {
          if (result?.brand !== 'trade' || result.from !== args.from || result.to !== args.to || !Array.isArray(result.unavailable) ||
              result.unavailable.some(slot => !date(slot?.date) || !['morning', 'afternoon'].includes(slot.timeRange))) throw new Error('Invalid availability.');
          checks.push({from: args.from, to: args.to, unavailable: new Set(result.unavailable.map(slot => `${slot.date}:${slot.timeRange}`))});
          if (checks.length > 20) checks.shift();
        }
        return result;
      } catch {
        return writeTools.includes(name) ? writes.get(name).result : {status: 'UNAVAILABLE', message: 'The Trade lookup could not be verified. Do not invent customer details or availability.'};
      }
    },
  };
}
