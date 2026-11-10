import assert from 'node:assert/strict';
import test from 'node:test';
import {createTradeActionPolicy} from '../src/agents/trade/trade-action-policy.mjs';

const jobTools = ['find_job', 'create_job_booking', 'reschedule_job', 'cancel_job'];
const base = ['get_business_profile', 'list_services', 'find_customer', 'get_available_slots'];
const customer = {fullName: 'Test Customer', email: 'test@example.test', phone: '0412345678'};
const contact = {email: customer.email, phone: customer.phone};
const code = 'BK 4K7H2M9PQ';
const site = {street: '1 Test Street', suburb: 'Lynbrook', state: 'VIC', postcode: '3975'};
const slot = {date: '2099-11-05', timeRange: 'morning', startTime: '10:30'};
function fixture({canChange = true, names = [...base, ...jobTools], moveStatus = 'CONFIRMED'} = {}) {
  const calls = [];
  const policy = createTradeActionPolicy(new Map(names.map(name => [name, {}])), async (name, args) => {
    calls.push({name, args});
    if (name === 'list_services') return [{id: 'service-a', name: 'Switchboard'}];
    if (name === 'get_available_slots') return {brand: 'trade', ...args, unavailable: [{date: '2099-11-06', timeRange: 'morning'}]};
    if (name === 'find_job') return args.phone === contact.phone ? {status: 'MATCHED', jobCode: code, job: {canChange}} : {status: 'NOT_FOUND', message: 'none'};
    if (name === 'cancel_job') return {status: 'CANCELLED', jobCode: code};
    if (name === 'reschedule_job' && moveStatus !== 'CONFIRMED') return {status: moveStatus, message: 'No time'};
    return {status: 'CONFIRMED', jobCode: code, appointment: {date: slot.date, startTime: '10:30'}};
  });
  return {policy, calls, writes: () => calls.filter(call => call.name !== 'get_available_slots' && call.name !== 'list_services' && call.name !== 'find_job')};
}
const checked = policy => policy.call('get_available_slots', {from: '2099-11-05', to: '2099-11-06'});

test('job tools are advertised only with their lookup and availability prerequisites', () => {
  assert.deepEqual(fixture().policy.names.filter(name => jobTools.includes(name)), jobTools);
  assert.deepEqual(fixture({names: ['get_business_profile', 'list_services', 'reschedule_job', 'cancel_job']}).policy.names, ['get_business_profile', 'list_services']);
});

test('job booking needs a listed service, checked availability and confirmation, and keeps exact start times', async () => {
  const {policy, calls, writes} = fixture();
  const args = {customerConfirmed: true, serviceId: 'service-a', customerId: null, customer, address: site, preferredSlots: [slot]};
  assert.equal((await policy.call('create_job_booking', args)).status, 'REJECTED');
  await policy.call('list_services', {});
  assert.equal((await policy.call('create_job_booking', args)).status, 'AVAILABILITY_REQUIRED');
  await checked(policy);
  assert.equal((await policy.call('create_job_booking', {...args, customerConfirmed: false})).status, 'CONFIRMATION_REQUIRED');
  assert.equal((await policy.call('create_job_booking', {...args, preferredSlots: [{...slot, startTime: '9am'}]})).status, 'REJECTED');
  assert.equal((await policy.call('create_job_booking', {...args, preferredSlots: [{...slot, date: '2099-11-06'}]})).status, 'AVAILABILITY_REQUIRED');
  assert.equal(writes().length, 0);
  assert.equal((await policy.call('create_job_booking', args)).status, 'CONFIRMED');
  assert.equal((await policy.call('create_job_booking', args)).status, 'CONFIRMED');
  assert.equal(writes().length, 1);
  const sent = calls.find(call => call.name === 'create_job_booking').args;
  assert.equal(sent.preferredSlots[0].startTime, '10:30'); assert.ok(sent.requestKey.length >= 16);
});

test('job changes require a matching lookup in this call and reuse its verified contacts', async () => {
  const {policy, calls, writes} = fixture();
  await checked(policy);
  assert.equal((await policy.call('cancel_job', {customerConfirmed: true, jobCode: code})).status, 'LOOKUP_REQUIRED');
  assert.equal((await policy.call('find_job', {jobCode: 'bk 4k7h2m9pq', ...contact, phone: '0499999999'})).status, 'NOT_FOUND');
  assert.equal((await policy.call('cancel_job', {customerConfirmed: true, jobCode: code})).status, 'LOOKUP_REQUIRED');
  assert.equal((await policy.call('find_job', {jobCode: 'bk 4k7h 2m9pq', ...contact})).status, 'MATCHED');
  assert.equal((await policy.call('cancel_job', {customerConfirmed: true, jobCode: code, email: 'other@example.test'})).status, 'REJECTED');
  assert.equal((await policy.call('reschedule_job', {customerConfirmed: true, jobCode: code, preferredSlots: [{...slot, date: '2099-11-06'}]})).status, 'AVAILABILITY_REQUIRED');
  assert.equal(writes().length, 0);
  assert.equal((await policy.call('reschedule_job', {customerConfirmed: true, jobCode: code, preferredSlots: [slot]})).status, 'CONFIRMED');
  const sent = calls.find(call => call.name === 'reschedule_job').args;
  assert.equal(sent.email, contact.email); assert.equal(sent.phone, contact.phone); assert.ok(sent.requestKey);
  // A successful move clears the verified lookup, so a cancel must look the job up again.
  assert.equal((await policy.call('cancel_job', {customerConfirmed: true, jobCode: code})).status, 'LOOKUP_REQUIRED');
});

test('prepared job retains optional finish and owner deferral through caller confirmation', async () => {
  const {policy, writes} = fixture();
  await policy.call('list_services', {});
  await checked(policy);
  const args = {serviceId: 'service-a', customer, address: site, deferScheduling: true};
  assert.equal((await policy.prepare({...args, preferredSlots: [{...slot, endTime: '09:30'}]}, 'create_job_booking')).status, 'REJECTED');
  const preference = {...slot, endTime: '13:00'};
  const prepared = await policy.prepare({...args, preferredSlots: [preference]}, 'create_job_booking');
  assert.equal(prepared.status, 'READY_FOR_CONFIRMATION');
  assert.deepEqual(prepared.summary.preferredSlots, [preference]);
  assert.equal(writes().length, 0);
  await policy.submit({customerConfirmed: true}, 'create_job_booking');
  assert.deepEqual(writes()[0].args.preferredSlots, [preference]);
  assert.equal(writes()[0].args.deferScheduling, true);
});

test('team-only jobs cannot be changed and rejected moves may be retried with a new key', async () => {
  const locked = fixture({canChange: false});
  await locked.policy.call('find_job', {jobCode: code, ...contact});
  assert.equal((await locked.policy.call('cancel_job', {customerConfirmed: true, jobCode: code})).status, 'REJECTED');
  assert.equal(locked.writes().length, 0);
  const busy = fixture({moveStatus: 'REJECTED'});
  await checked(busy.policy);
  await busy.policy.call('find_job', {jobCode: code, ...contact});
  assert.equal((await busy.policy.call('reschedule_job', {customerConfirmed: true, jobCode: code, preferredSlots: [slot]})).status, 'REJECTED');
  await busy.policy.call('reschedule_job', {customerConfirmed: true, jobCode: code, preferredSlots: [{...slot, startTime: '11:00'}]});
  const keys = busy.calls.filter(call => call.name === 'reschedule_job').map(call => call.args.requestKey);
  assert.equal(keys.length, 2); assert.notEqual(keys[0], keys[1]);
});
