import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {ownerHandoffReadiness, redirectToOwner} from '../src/server/owner-handoff.mjs';

const config = {businessId: 'nira', username: 'handoff-test', secret: 'fixture-secret'};
const route = {mode: 'trade', did: '0359111403', businessId: 'nira'};
const caller = 'PJSIP/yeastar-00000033';

test('handoff requires the Nira DID, pinned business and original Yeastar caller channel', () => {
  const variables = {__BMS_CALLER_CHANNEL: caller};
  assert.deepEqual(ownerHandoffReadiness(config, route, variables), {status: 'READY', channel: caller});
  assert.equal(ownerHandoffReadiness(null, route, variables).status, 'NOT_CONFIGURED');
  assert.equal(ownerHandoffReadiness(config, {...route, businessId: 'other'}, variables).status, 'BUSINESS_MISMATCH');
  assert.equal(ownerHandoffReadiness(config, {...route, did: '0359111404'}, variables).status, 'NOT_NIRA_ROUTE');
  assert.equal(ownerHandoffReadiness(config, route, {}).status, 'MISSING_CALLER_CHANNEL');
  assert.equal(ownerHandoffReadiness(config, route, {...variables, BMS_CALLER_CHANNEL: caller + 'a'}).status, 'INVALID_CALLER_CHANNEL');
  assert.equal(ownerHandoffReadiness(config, route, {BMS_CALLER_CHANNEL: caller + '\n'}).status, 'INVALID_CALLER_CHANNEL');
});

test('AMI authenticates on loopback and redirects only the original caller to the fixed handoff context', async () => {
  const messages = [];
  const connect = (options) => {
    assert.deepEqual(options, {host: '127.0.0.1', port: 5038});
    const socket = new EventEmitter();
    socket.setEncoding = () => {};
    socket.destroy = () => {};
    socket.write = (value) => {
      messages.push(value);
      queueMicrotask(() => {
        if (messages.length === 1) {
          socket.emit('data', 'Asterisk Call Manager/11.0\r\nResponse: Succ');
          socket.emit('data', 'ess\r\nActionID: login\r\n\r\n');
        } else {
          socket.emit('data', 'Response: Success\r\nActionID: redirect\r\n\r\n');
        }
      });
    };
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  };
  assert.equal(await redirectToOwner(config, caller, connect), true);
  assert.match(messages[0], /Action: Login/);
  assert.match(messages[1], /Channel: PJSIP\/yeastar-00000033\r\nContext: bms-nira-owner-handoff\r\nExten: s/);
  assert.equal(await redirectToOwner(config, caller + '\n', () => assert.fail('invalid channel must not connect')), false);
});
