import assert from 'node:assert/strict';
import test from 'node:test';
import {createTradeActionPolicy} from '../src/agents/trade/trade-action-policy.mjs';

const names = ['get_business_profile', 'list_services', 'find_customer', 'get_available_slots', 'register_customer', 'create_inspection_request'];
const customer = {fullName: 'Test Customer', email: 'test@example.test', phone: '0412345678'};
const booking = {customerConfirmed: true, customer, serviceId: 'service-a', customerId: null,
  address: {street: '1 Test Street', suburb: 'Lynbrook', state: 'VIC', postcode: '3975'}, preferredSlots: [{date: '2099-11-05', timeRange: 'morning'}]};
function fixture({uncertain = false, rejected = false, blocked = false} = {}) {
  const calls = [];
  const policy = createTradeActionPolicy(new Map(names.map(name => [name, {}])), async (name, args) => {
    calls.push({name, args});
    if (name === 'list_services') return [{id: 'service-a', name: 'Inspection'}];
    if (name === 'find_customer') return {status: 'MATCHED', customerId: 'customer-a'};
    if (name === 'get_available_slots') return {brand: 'trade', ...args, unavailable: blocked ? booking.preferredSlots : []};
    if (uncertain) throw Error('connection lost after write');
    if (rejected) return {status: 'REJECTED', message: 'Please correct the details.'};
    return name === 'register_customer' ? {status: 'CREATED', customerId: 'customer-a'} : {status: 'PENDING_REVIEW', requestId: 'request-a'};
  });
  return {policy, calls};
}
const ready = async policy => {
  await policy.call('list_services', {});
  await policy.call('get_available_slots', {from: '2099-11-05', to: '2099-11-05'});
};
test('registration requires consent, uses a private key and caches repeated submissions', async () => {
  const {policy, calls} = fixture();
  assert.equal((await policy.call('register_customer', {customer})).status, 'CONFIRMATION_REQUIRED');
  assert.equal(calls.length, 0);
  const args = {customer, customerConfirmed: true};
  assert.equal((await policy.call('register_customer', {...args, requestKey: 'model-key'})).status, 'REJECTED');
  assert.equal((await policy.call('register_customer', args)).status, 'CREATED');
  assert.equal((await policy.call('register_customer', args)).status, 'CREATED');
  assert.equal(calls.length, 1); assert.match(calls[0].args.requestKey, /^[a-f0-9-]{36}$/);
  assert.equal((await policy.call('register_customer', {...args, customer: {...customer, email: 'other@example.test'}})).status, 'REJECTED');
});
test('booking requires listed services, checked free sessions and scoped customer references', async () => {
  const {policy, calls} = fixture();
  assert.equal((await policy.call('create_inspection_request', booking)).status, 'REJECTED');
  await policy.call('list_services', {});
  assert.equal((await policy.call('create_inspection_request', booking)).status, 'AVAILABILITY_REQUIRED');
  await ready(policy);
  assert.equal((await policy.call('create_inspection_request', {...booking, customerId: 'guessed-id'})).status, 'REJECTED');
  await policy.call('find_customer', {email: customer.email, phone: customer.phone});
  assert.equal((await policy.call('create_inspection_request', {...booking, customerId: 'customer-a', customer: {...customer, phone: '0499999999'}})).status, 'REJECTED');
  const args = {...booking, customerId: 'customer-a'};
  assert.equal((await policy.call('create_inspection_request', args)).status, 'PENDING_REVIEW');
  assert.equal((await policy.call('create_inspection_request', args)).status, 'PENDING_REVIEW');
  assert.equal(calls.filter(call => call.name === 'create_inspection_request').length, 1);
  const blocked = fixture({blocked: true}); await ready(blocked.policy);
  assert.equal((await blocked.policy.call('create_inspection_request', booking)).status, 'AVAILABILITY_REQUIRED');
});
test('guest bookings work without registering and unknown outcomes cannot be resubmitted', async () => {
  const {policy, calls} = fixture({uncertain: true}); await ready(policy);
  assert.equal((await policy.call('create_inspection_request', booking)).status, 'UNKNOWN');
  assert.equal((await policy.call('create_inspection_request', booking)).status, 'UNKNOWN');
  assert.equal((await policy.call('create_inspection_request', {...booking, customerNotes: 'changed'})).status, 'REJECTED');
  assert.equal(calls.filter(call => call.name === 'create_inspection_request').length, 1);
  assert.equal(calls.some(call => call.name === 'register_customer'), false);
});
test('definitively rejected actions permit corrections with fresh retry identities', async () => {
  const {policy, calls} = fixture({rejected: true});
  await policy.call('register_customer', {customer, customerConfirmed: true});
  await policy.call('register_customer', {customer: {...customer, fullName: 'Corrected Name'}, customerConfirmed: true});
  assert.equal(calls.length, 2); assert.notEqual(calls[0].args.requestKey, calls[1].args.requestKey);
});

test('preparation holds exact details without writing; confirmation submits once without reconstructing contacts', async () => {
  const {policy, calls} = fixture(); await ready(policy);
  const {customerConfirmed: _confirmation, ...details} = booking;
  assert.equal((await policy.submit({customerConfirmed: true})).status, 'PREPARATION_REQUIRED');
  const prepared = await policy.prepare(details);
  assert.equal(prepared.status, 'READY_FOR_CONFIRMATION');
  assert.deepEqual(prepared.summary.customer, customer);
  assert.equal(calls.filter(call => call.name === 'create_inspection_request').length, 0);
  details.customer = {...customer, email: 'changed-outside@example.test'};
  assert.equal((await policy.submit({customerConfirmed: false})).status, 'CONFIRMATION_REQUIRED');
  assert.equal((await policy.submit({customerConfirmed: true})).status, 'PENDING_REVIEW');
  assert.equal((await policy.submit({customerConfirmed: true})).status, 'PENDING_REVIEW');
  const writes = calls.filter(call => call.name === 'create_inspection_request');
  assert.equal(writes.length, 1); assert.deepEqual(writes[0].args.customer, customer);
});

test('failed corrected preparation cannot submit stale details and uncertain prepared writes never duplicate', async () => {
  const {policy, calls} = fixture({uncertain: true}); await ready(policy);
  const {customerConfirmed: _confirmation, ...details} = booking;
  await policy.prepare(details);
  const invalid = await policy.prepare({...details, customer: {...customer, email: 'bad'}});
  assert.equal(invalid.status, 'REJECTED');
  assert.deepEqual(invalid.invalidFields, ['email']);
  assert.equal((await policy.submit({customerConfirmed: true})).status, 'PREPARATION_REQUIRED');
  assert.equal(calls.filter(call => call.name === 'create_inspection_request').length, 0);
  await policy.prepare(details);
  assert.equal((await policy.submit({customerConfirmed: true})).status, 'UNKNOWN');
  assert.equal((await policy.submit({customerConfirmed: true})).status, 'UNKNOWN');
  await policy.prepare({...details, customerNotes: 'bypass attempt'});
  assert.equal((await policy.submit({customerConfirmed: true})).status, 'PREPARATION_REQUIRED');
  assert.equal(calls.filter(call => call.name === 'create_inspection_request').length, 1);
});

test('advice can prepare and submit without a published service while retaining availability and confirmation gates', async () => {
  const {policy, calls} = fixture();
  const {customerConfirmed: _confirmation, ...details} = booking;
  const advice = {...details, requestType: 'custom_quote', serviceId: null, customRequest: {title: 'Need advice on a recurring fault', description: 'Happens after rain.'}};
  assert.equal((await policy.prepare(advice)).status, 'AVAILABILITY_REQUIRED');
  await policy.call('get_available_slots', {from: '2099-11-05', to: '2099-11-05'});
  assert.equal((await policy.prepare({...advice, serviceId: 'service-a'})).status, 'REJECTED');
  assert.equal((await policy.prepare({...advice, customRequest: {title: 'ab'}})).status, 'REJECTED');
  assert.equal((await policy.prepare({...advice, customRequest: {title: 'Valid scope', description: 'x'.repeat(1501)}})).status, 'REJECTED');
  assert.equal((await policy.prepare(advice)).status, 'READY_FOR_CONFIRMATION');
  assert.equal((await policy.submit({customerConfirmed: false})).status, 'CONFIRMATION_REQUIRED');
  assert.equal((await policy.submit({customerConfirmed: true})).status, 'PENDING_REVIEW');
  await policy.submit({customerConfirmed: true});
  const sent = calls.filter(call => call.name === 'create_inspection_request');
  assert.equal(sent.length, 1); assert.equal(sent[0].args.requestType, 'custom_quote');
  assert.equal(sent[0].args.serviceId, null); assert.deepEqual(sent[0].args.customRequest, advice.customRequest);
  assert.equal(calls.some(call => call.name === 'list_services'), false);
});
