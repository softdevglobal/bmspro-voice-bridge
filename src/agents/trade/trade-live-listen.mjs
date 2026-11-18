import {timingSafeEqual} from 'node:crypto';

const callIdPattern = /^[0-9a-f-]{36}$/;
const silence = Buffer.alloc(160, 0xff);

export function createLiveListen(secret) {
  const calls = new Map();
  const expected = Buffer.from('Bearer ' + secret);

  return {
    start(id, route) {
      if (!route.discoveredProfile || route.mode !== 'trade') return null;
      const call = {id, did: route.did, businessId: route.businessId, startedAt: Date.now(), listeners: new Set(), caller: null};
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
    handle(req, res) {
      const actual = Buffer.from(req.headers.authorization ?? '');
      const businessId = req.headers['x-bmspro-trade-business'];
      if (req.method !== 'GET' || actual.length !== expected.length || !timingSafeEqual(actual, expected) ||
          typeof businessId !== 'string' || !businessId || businessId.length > 128) {
        res.writeHead(403).end();
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/live-listen/calls') {
        const list = [...calls.values()].filter(call => call.businessId === businessId)
          .map(({id, did, startedAt}) => ({id, did, startedAt}));
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
