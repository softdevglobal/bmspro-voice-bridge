import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {createOwnerVoiceHandler} from '../src/server/owner-voice.mjs';

test('owner voice setup requires the Trade bridge secret and uses the bridge OpenAI key', async (t) => {
  const secret = 'trade-bridge-test-secret-0000000000000000';
  const apiKey = 'fixture-bridge-openai-key';
  const toolNames = ['get_daily_summary', 'list_jobs_awaiting_scheduling', 'get_staff_working_today'];
  const upstream = t.mock.fn(async (url, request) => {
    assert.equal(url, 'https://api.openai.com/v1/realtime/calls');
    assert.equal(request.headers.Authorization, `Bearer ${apiKey}`);
    assert.equal(request.body.get('sdp'), 'v=0\r\no=fixture');
    const session = JSON.parse(request.body.get('session'));
    assert.equal(session.model, 'fixture-realtime-model');
    assert.deepEqual(session.tools.map(tool => tool.name), toolNames);
    return new Response('v=0\r\no=answer');
  });
  const server = createServer(createOwnerVoiceHandler({secret, apiKey, model: 'fixture-realtime-model', fetcher: upstream}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/owner-voice/session`;
  const payload = {
    sdp: 'v=0\r\no=fixture',
    safetyIdentifier: 'a'.repeat(64),
    session: {instructions: 'Give the owner a briefing.', tools: toolNames.map(name => ({type: 'function', name}))},
  };
  const post = (token, body = payload) => fetch(url, {
    method: 'POST', body: JSON.stringify(body),
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
  });
  assert.equal((await post('wrong')).status, 401);
  assert.equal((await post(secret, {...payload, sdp: 'invalid'})).status, 400);
  assert.equal((await post(secret, {...payload, sdp: 'v=0\r\n' + 'x'.repeat(100_000)})).status, 413);
  assert.equal(upstream.mock.callCount(), 0);
  const response = await post(secret);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/sdp');
  assert.equal(await response.text(), 'v=0\r\no=answer');
  assert.equal(upstream.mock.callCount(), 1);
});
