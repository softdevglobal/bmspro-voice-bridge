import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {originate} from '../src/agents/trade/trade-sophie-callback.mjs';

test('AMI queue acknowledgement is distinct from the callback result', async () => {
  const socket = new EventEmitter();
  const commands = [];
  socket.write = value => commands.push(value);
  socket.setEncoding = () => {};
  socket.destroy = () => {};
  const token = 'a'.repeat(48);
  let settled = false;
  let diagnostic;
  const result = originate({username: 'callback', secret: 'test-secret', number: '0412345678',
    did: '0359111403', token, prefix: '9', report: (code, reason) => { diagnostic = {code, reason}; }}, address => {
    assert.deepEqual(address, {host: '127.0.0.1', port: 5038});
    return socket;
  }).then(value => { settled = true; return value; });
  socket.emit('connect');
  socket.emit('data', 'Asterisk Call Manager/11\r\nResponse: Success\r\nActionID: login\r\n\r\n');
  assert.match(commands[1], /Channel: PJSIP\/90412345678@yeastar\r\n/);
  assert.match(commands[1], /CallerID: 0359111403\r\n/);
  assert.ok(commands[1].includes(`Variable: __BMS_CALLBACK_TOKEN=${token}\r\n`));
  socket.emit('data', `Response: Success\r\nActionID: ${token}\r\n\r\n`);
  await Promise.resolve();
  assert.equal(settled, false);
  socket.emit('data', `Event: OriginateResponse\r\nActionID: ${token}\r\nResponse: Failure\r\nReason: 3\r\n\r\n`);
  assert.equal(await result, 'NO_ANSWER');
  assert.deepEqual(diagnostic, {code: 'PBX_NO_ANSWER', reason: '3'});
});
