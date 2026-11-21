import {timingSafeEqual} from 'node:crypto';
import {ownerHandoffReadiness} from './trade-owner-handoff.mjs';
import {originateLiveJoin} from './trade-live-join.mjs';

const callIdPattern = /^[0-9a-f-]{36}$/;
const silence = Buffer.alloc(160, 0xff);

export function createLiveListen(secret, {joinConfig = null, resolveRoute, join = originateLiveJoin} = {}) {
  const calls = new Map();
  const expected = Buffer.from('Bearer ' + secret);

  return {
    start(id, route, {variables} = {}) {
      if (!route.discoveredProfile || route.mode !== 'trade') return null;
      const target = ownerHandoffReadiness(joinConfig, route, variables);
      console.info(`[live-join] readiness=${target.status}`);
      const call = {id, did: route.did, businessId: route.businessId, startedAt: Date.now(), listeners: new Set(), caller: null,
        target, joinRequested: false};
      calls.set(id, call);
      return {
        input(frame) {
          if (call.listeners.size) call.caller = Buffer.from(frame);
        },
        output(frame) {
          if (!call.listeners.size) return;
          const packet = Buffer.concat([call.caller ?? silence, frame]);
          call.caller = null;
          for (const listener of call.listeners) {
            if (listener.writableLength > 32_000) listener.destroy();
            else listener.write(packet);
          }
        },
        close() {
          calls.delete(id);
          for (const listener of call.listeners) listener.end();
          call.listeners.clear();
        },
      };
    },
    async handle(req, res) {
      const actual = Buffer.from(req.headers.authorization ?? '');
      const businessId = req.headers['x-bmspro-trade-business'];
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected) ||
          typeof businessId !== 'string' || !businessId || businessId.length > 128) {
        res.writeHead(403).end();
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      const send = (status, body) => res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}).end(JSON.stringify(body));
      if (url.pathname === '/live-listen/join') {
        if (req.method !== 'POST') return send(405, {});
        const id = url.searchParams.get('id') ?? '';
        const call = callIdPattern.test(id) ? calls.get(id) : null;
        if (!call || call.businessId !== businessId) return send(404, {error: 'This live call is no longer available.'});
        if (call.target.status !== 'READY' || !resolveRoute) return send(503, {error: 'Bridge joining is not configured for this call. Check live-join AMI settings and the mapped owner extension.'});
        if (call.joinRequested) return send(409, {error: 'A join was already requested for this call. Check your extension before retrying.'});
        call.joinRequested = true;
        try {
          const route = await resolveRoute(call.did);
          if (route?.mode !== 'trade' || route.businessId !== businessId || route.did !== call.did ||
              !route.discoveredProfile || route.forwardingExtension !== call.target.extension || calls.get(id) !== call) {
            return send(409, {error: 'The call or its business mapping changed. Refresh live calls.'});
          }
          const result = await join(joinConfig, call.target, () => calls.get(id) === call);
          if (result.status === 'REQUESTED') return send(200, {ok: true, status: 'REQUESTED'});
          return send(502, {error: result.status === 'UNKNOWN'
            ? 'The join result is unverified. Check your extension; do not submit another request.'
            : 'Asterisk could not accept the join request. Check live-join AMI permissions.'});
        } catch {
          return send(502, {error: 'Joining could not be confirmed. Check your extension before retrying.'});
        }
      }
      if (req.method !== 'GET') return send(405, {});
      if (url.pathname === '/live-listen/calls') {
        const list = [...calls.values()].filter(call => call.businessId === businessId)
          .map(({id, did, startedAt, target, joinRequested}) => ({id, did, startedAt,
            canJoin: target.status === 'READY' && !joinRequested,
            joinStatus: joinRequested ? 'ALREADY_REQUESTED' : target.status}));
        res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}).end(JSON.stringify(list));
        return;
      }
      const id = url.searchParams.get('id') ?? '';
      const call = callIdPattern.test(id) ? calls.get(id) : null;
      if (!call || call.businessId !== businessId) { res.writeHead(404).end(); return; }
      if (call.listeners.size >= 2) { res.writeHead(429).end(); return; }
      res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'});
      res.flushHeaders();
      call.listeners.add(res);
      res.once('close', () => {
        call.listeners.delete(res);
        if (!call.listeners.size) call.caller = null;
      });
    },
  };
}
