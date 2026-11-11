import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import {createLiveListen} from '../src/server/live-listen.mjs';

test('live audio is restricted to the answered call’s business and stops at hangup', async () => {
  const secret = 'trade-live-listen-test-secret-00000000';
  const monitor = createLiveListen(secret);
  const id = randomUUID();
  const feed = monitor.start(id, {mode: 'trade', did: '0359111403', businessId: 'business-a', discoveredProfile: {}});
  const server = http.createServer(monitor.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (path, businessId, token = secret) => fetch(base + path, {
    headers: {Authorization: 'Bearer ' + token, 'X-BMSPro-Trade-Business': businessId},
  });
  try {
    assert.equal((await request('/live-listen/calls', 'business-a', 'wrong')).status, 403);
    assert.deepEqual(await (await request('/live-listen/calls', 'business-b')).json(), []);
    const [call] = await (await request('/live-listen/calls', 'business-a')).json();
    assert.equal(call.id, id);
    assert.equal((await request('/live-listen/audio?id=' + id, 'business-b')).status, 404);
    const audio = await request('/live-listen/audio?id=' + id, 'business-a');
    assert.equal(audio.status, 200);
    feed.input(Buffer.alloc(160, 10));
    feed.output(Buffer.alloc(160, 20));
    feed.close();
    assert.deepEqual(Buffer.from(await audio.arrayBuffer()), Buffer.concat([Buffer.alloc(160, 10), Buffer.alloc(160, 20)]));
    assert.deepEqual(await (await request('/live-listen/calls', 'business-a')).json(), []);
  } finally {
    feed.close();
    await new Promise(resolve => server.close(resolve));
  }
});
