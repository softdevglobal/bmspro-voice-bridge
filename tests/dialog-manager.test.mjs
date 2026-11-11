import test from 'node:test';
import assert from 'node:assert/strict';
import {createDialogManager, dialogModeFromEnv} from '../src/dialog/dialog-manager.mjs';
import {openingGreeting} from '../src/agents/registry.mjs';

test('Black flow walks service -> availability -> booking and gates create_booking', () => {
  const logs = [];
  const dialog = createDialogManager({mode: 'receptionist', log: line => logs.push(line)});
  assert.equal(dialog.snapshot().step, 'service');

  const blocked = dialog.check('create_booking');
  assert.equal(blocked.status, 'STEP_REQUIRED');
  assert.deepEqual(blocked.missingSteps, ['availability']);

  dialog.record('list_services', {services: []});
  assert.equal(dialog.snapshot().step, 'availability');
  dialog.record('get_available_slots', {slots: []}); // no free slots does not count
  assert.equal(dialog.snapshot().step, 'availability');
  dialog.record('get_available_slots', {slots: [{slotToken: 't1'}]});
  assert.equal(dialog.snapshot().step, 'booking');
  assert.equal(dialog.check('create_booking'), null);

  dialog.record('create_booking', {status: 'PENDING_REVIEW', bookingCode: 'B1'});
  assert.equal(dialog.snapshot().step, 'done');
  assert.ok(logs.some(line => line.includes('step availability -> booking')));
});

test('Trade flow: optional steps pass once later steps finish; submit needs a prepared readback', () => {
  const dialog = createDialogManager({mode: 'trade'});
  assert.equal(dialog.check('prepare_inspection_request').status, 'STEP_REQUIRED');
  assert.deepEqual(dialog.check('create_inspection_request').missingSteps, ['readback']);

  // Advice call: no list_services, availability checked first.
  dialog.record('get_available_slots', {brand: 'trade', from: '2026-11-10', to: '2026-11-10', unavailable: []});
  assert.equal(dialog.snapshot().step, 'contact');
  assert.equal(dialog.check('prepare_inspection_request'), null);

  dialog.record('prepare_inspection_request', {status: 'REJECTED', message: 'fix postcode'});
  assert.equal(dialog.snapshot().step, 'contact');
  dialog.record('prepare_inspection_request', {status: 'READY_FOR_CONFIRMATION', summary: {}});
  assert.equal(dialog.snapshot().step, 'submitted');
  assert.equal(dialog.check('create_inspection_request'), null);

  dialog.record('create_inspection_request', {status: 'CONFIRMED', requestId: 'r1'});
  assert.equal(dialog.snapshot().step, 'done');
  assert.deepEqual(dialog.snapshot().completed, ['service', 'address', 'availability', 'contact', 'readback', 'submitted']);
});

test('Trade job booking walks the inspection steps with the job tools', () => {
  const dialog = createDialogManager({mode: 'trade'});
  assert.deepEqual(dialog.check('prepare_job_booking').missingSteps, ['availability']);
  assert.deepEqual(dialog.check('create_job_booking').missingSteps, ['readback']);
  dialog.record('list_services', [{id: 's1', name: 'Switchboard'}]);
  dialog.record('get_available_slots', {brand: 'trade', from: '2099-11-05', to: '2099-11-05', unavailable: []});
  dialog.record('prepare_job_booking', {status: 'READY_FOR_CONFIRMATION', summary: {}});
  assert.equal(dialog.snapshot().step, 'submitted');
  assert.equal(dialog.check('create_job_booking'), null);
  dialog.record('create_job_booking', {status: 'PENDING_REVIEW', requestId: 'r1'});
  assert.equal(dialog.snapshot().step, 'done');
});

test('Trade job cancel needs only a verified lookup; reschedule needs availability first', () => {
  const cancel = createDialogManager({mode: 'trade'});
  cancel.record('find_job', {status: 'NOT_FOUND'});
  assert.equal(cancel.snapshot().step, 'service');
  cancel.record('find_job', {status: 'MATCHED', jobCode: 'BK 4K7H2M9PQ', job: {canChange: true}});
  assert.equal(cancel.check('cancel_job'), null);
  cancel.record('cancel_job', {status: 'CANCELLED', jobCode: 'BK 4K7H2M9PQ'});
  assert.equal(cancel.snapshot().step, 'done');

  const move = createDialogManager({mode: 'trade'});
  move.record('find_job', {status: 'MATCHED', jobCode: 'BK 4K7H2M9PQ', job: {canChange: true}});
  assert.deepEqual(move.check('reschedule_job').missingSteps, ['availability']);
  move.record('get_available_slots', {brand: 'trade', from: '2099-11-05', to: '2099-11-05', unavailable: []});
  assert.equal(move.check('reschedule_job'), null);
  move.record('reschedule_job', {status: 'CONFIRMED', jobCode: 'BK 4K7H2M9PQ'});
  assert.equal(move.snapshot().step, 'done');
});

test('Pink list_services returns an array; annotate leaves arrays unchanged', () => {
  const dialog = createDialogManager({mode: 'pink'});
  const services = [{id: 's1', name: 'Cut'}];
  dialog.record('list_services', services);
  assert.equal(dialog.snapshot().step, 'availability');
  assert.equal(dialog.annotate(services), services);
  const annotated = dialog.annotate({brand: 'pink', slots: []});
  assert.equal(annotated.dialogState.step, 'availability');
  assert.match(annotated.dialogState.next, /get_available_slots/);
});

test('three failed writes in a row hit the retry limit; any progress resets it', () => {
  const dialog = createDialogManager({mode: 'receptionist'});
  dialog.record('get_available_slots', {slots: [{slotToken: 't'}]});
  for (let i = 0; i < 3; i++) {
    assert.equal(dialog.check('create_booking'), null);
    dialog.record('create_booking', {status: 'REJECTED', message: 'bad email'});
  }
  assert.equal(dialog.check('create_booking').status, 'RETRY_LIMIT');
  dialog.record('list_services', {services: []}); // progress
  assert.equal(dialog.check('create_booking'), null);
});

test('observe mode logs but never blocks or changes results', () => {
  const logs = [];
  const dialog = createDialogManager({mode: 'receptionist', enforce: false, log: line => logs.push(line)});
  assert.equal(dialog.check('create_booking'), null);
  assert.ok(logs.some(line => line.includes('would block create_booking')));
  const result = {status: 'OK'};
  assert.equal(dialog.annotate(result), result);
});

test('unknown modes are a no-op and the env setting is validated', () => {
  const dialog = createDialogManager({mode: 'something-else'});
  assert.equal(dialog.check('create_booking'), null);
  assert.equal(dialog.snapshot().step, null);
  assert.equal(dialogModeFromEnv({}), 'on');
  assert.equal(dialogModeFromEnv({BMSPRO_DIALOG_MANAGER: 'Observe'}), 'observe');
  assert.throws(() => dialogModeFromEnv({BMSPRO_DIALOG_MANAGER: 'maybe'}));
});

test('Trade offers both intake paths when enabled and keeps the other mode greetings', () => {
  const tail = ' Pronounce Sophie as SOH-fee. Then pause and listen. Do not call a tool before greeting.';
  const head = 'Speak this greeting in English, preserving the complete sentence "My name is Sophie": ';
  assert.equal(openingGreeting({mode: 'onboarding'}),
    `${head}"Hi, thanks for calling BMS Pro. My name is Sophie, your AI assistant. Shall we get your business set up?"${tail}`);
  assert.equal(openingGreeting({mode: 'pink', businessName: 'Glow', branch: 'City'}),
    `${head}"Hello, thank you for calling "Glow", "City". My name is Sophie, your AI receptionist. How can I help?"${tail}`);
  assert.equal(openingGreeting({mode: 'trade', businessName: 'Roofs', canBookJobs: true, canRequestInspection: true}),
    `${head}"Hi, thanks for calling "Roofs". My name is Sophie, your AI receptionist. Would you like to request an inspection or book a job directly?"${tail}`);
  assert.equal(openingGreeting({mode: 'trade', businessName: 'Roofs', canRequestInspection: true}),
    `${head}"Hi, thanks for calling "Roofs". My name is Sophie, your AI receptionist. Would you like an existing service, or do you need advice?"${tail}`);
  assert.equal(openingGreeting({mode: 'receptionist', workshop: 'Niranga', branch: 'Dambulla'}),
    `${head}"Hello, thank you for calling "Niranga", "Dambulla". My name is Sophie, your AI receptionist. How can I help?"${tail}`);
});
