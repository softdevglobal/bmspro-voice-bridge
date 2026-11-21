import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import {loadLiveJoin, originateLiveJoin} from '../src/agents/trade/trade-live-join.mjs';
import {createLiveListen} from '../src/agents/trade/trade-live-listen.mjs';
const config = {username: 'join-test', secret: 'test-secret-'.repeat(4)};
const target = {channel: 'PJSIP/yeastar-00000033', extension: '3101'};

test('join credentials are opt-in and reject AMI header injection', () => {
  assert.equal(loadLiveJoin({}), null);
  assert.throws(() => loadLiveJoin({BMSPRO_LIVE_JOIN_ENABLED: 'true'}));
  assert.throws(() => loadLiveJoin({BMSPRO_LIVE_JOIN_ENABLED: 'true', BMSPRO_LIVE_JOIN_AMI_USER: 'name\r\nAction: x', BMSPRO_LIVE_JOIN_AMI_SECRET: config.secret}));
});

test('AMI joins one exact channel and never retries an uncertain submission', async () => {
  const writes = [];
  let uncertain = true;
  const connect = () => {
    const socket = new EventEmitter(); socket.setEncoding = () => {};
    socket.destroy = () => {};
    socket.write = text => {
      writes.push(text);
      if (text.startsWith('Action: Login')) queueMicrotask(() => socket.emit('data', 'Response: Success\r\nActionID: login\r\n\r\n'));
      else queueMicrotask(() => uncertain ? socket.emit('close') : socket.emit('data',
        `Response: Success\r\n${text.split('\r\n').find(line => line.startsWith('ActionID:'))}\r\n\r\n`));
    };
    queueMicrotask(() => socket.emit('connect')); return socket;
  };
  assert.equal((await originateLiveJoin(config, target, () => true, connect)).status, 'UNKNOWN');
  assert.equal(writes.length, 2);
  assert.match(writes[1], /Channel: PJSIP\/3101@yeastar/);
  assert.match(writes[1], /Application: ChanSpy/);
  assert.match(writes[1], /Data: PJSIP\/yeastar-00000033,uBES/);
  uncertain = false;
  assert.equal((await originateLiveJoin(config, target, () => true, connect)).status, 'REQUESTED');
  writes.length = 0;
  assert.equal((await originateLiveJoin(config, target, () => false, connect)).status, 'FAILED');
  assert.equal(writes.length, 1, 'hangup during AMI login must not ring the owner');
  assert.equal((await originateLiveJoin(config, {...target, channel: 'PJSIP/yeastar'}, () => true, connect)).status, 'FAILED');
  assert.equal((await originateLiveJoin(config, {...target, extension: '2000'}, () => true, connect)).status, 'FAILED');
  assert.equal((await originateLiveJoin(config, {...target, extension: '3101\n'}, () => true, connect)).status, 'FAILED');
});

test('bridge binds joining to its exact business session, current route and original channel', async () => {
  const secret = 'live-join-shared-secret-'.repeat(3);
  const route = {mode: 'trade', did: '0359111403', businessId: 'business-a', forwardingExtension: '3101', discoveredProfile: {}};
  let currentRoute = route, dials = 0, finishJoin;
  const monitor = createLiveListen(secret, {joinConfig: config, resolveRoute: async () => currentRoute,
    join: async (_config, actual, active) => {
      assert.deepEqual(actual, {status: 'READY', ...target}); assert.equal(active(), true); dials++;
      await new Promise(resolve => { finishJoin = resolve; });
      return {status: 'REQUESTED'};
    }});
  const id = randomUUID();
  const feed = monitor.start(id, route, {variables: {BMS_CALLER_CHANNEL: target.channel}});
  const server = http.createServer((req,res) => { void monitor.handle(req,res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (path, business = 'business-a', method = 'POST', token = secret) => fetch(base + path, {
    method, headers: {Authorization: 'Bearer ' + token, 'X-BMSPro-Trade-Business': business},
  });
  try {
    const listed = await (await request('/live-listen/calls', 'business-a', 'GET')).json();
    assert.equal(listed[0].canJoin, true);
    assert.equal('channel' in listed[0], false);
    assert.equal((await request('/live-listen/join?id=' + id, 'business-b')).status, 404);
    assert.equal((await request('/live-listen/join?id=' + id, 'business-a', 'POST', 'wrong')).status, 403);
    const first = request('/live-listen/join?id=' + id);
    while (!finishJoin) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await request('/live-listen/join?id=' + id)).status, 409);
    finishJoin(); assert.equal((await first).status, 200); assert.equal(dials, 1);
    feed.close();
    assert.equal((await request('/live-listen/join?id=' + id)).status, 404);
    const stale = randomUUID();
    const staleFeed = monitor.start(stale, route, {variables: {BMS_CALLER_CHANNEL: target.channel}});
    currentRoute = {...route, businessId: 'business-b'};
    assert.equal((await request('/live-listen/join?id=' + stale)).status, 409);
    assert.equal(dials, 1); staleFeed.close();
    const missing = randomUUID();
    const missingFeed = monitor.start(missing, route);
    assert.equal((await request('/live-listen/join?id=' + missing)).status, 503);
    missingFeed.close();
  } finally { feed.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});
