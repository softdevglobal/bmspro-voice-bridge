import {timingSafeEqual} from 'node:crypto';

// Read-only owner tools the Trade server may offer. The Trade server can send
// any of them (so the bridge and Trade can be deployed in either order), but
// never an unknown or repeated tool.
const toolNames = new Set([
  'get_daily_summary',
  'get_day_activity',
  'get_staff_day_report',
  'list_jobs_awaiting_scheduling',
  'get_staff_working_today',
]);

function validTools(tools) {
  return Array.isArray(tools) && tools.length > 0 && tools.length <= toolNames.size &&
    new Set(tools.map(tool => tool?.name)).size === tools.length &&
    tools.every(tool => tool?.type === 'function' && toolNames.has(tool.name));
}

function authorized(header, secret) {
  if (!secret || secret.length < 32) return false;
  const actual = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createOwnerVoiceHandler({secret, apiKey, model = 'gpt-realtime-2.1', fetcher = fetch}) {
  return async (request, response) => {
    const fail = status => {
      if (response.destroyed) return;
      response.writeHead(status, {'Cache-Control': 'no-store', Connection: 'close'});
      response.end();
    };
    if (request.method !== 'POST') return fail(405);
    if (!authorized(request.headers.authorization, secret)) return fail(401);
    if (request.headers['content-type'] !== 'application/json') return fail(415);

    const controller = new AbortController();
    const abort = () => controller.abort();
    response.once('close', abort);
    const bodyTimer = setTimeout(() => request.destroy(), 10_000);
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request.iterator({destroyOnReturn: false})) {
        size += chunk.length;
        if (size > 96 * 1024) return fail(413);
        chunks.push(chunk);
      }
      clearTimeout(bodyTimer);
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return fail(400); }
      const {sdp, session, safetyIdentifier} = payload ?? {};
      if (typeof sdp !== 'string' || !/^v=0\r?\n/.test(sdp) || Buffer.byteLength(sdp) > 64 * 1024 ||
          typeof safetyIdentifier !== 'string' || !/^[a-f0-9]{64}$/.test(safetyIdentifier) ||
          typeof session?.instructions !== 'string' || session.instructions.length > 4000 ||
          !validTools(session.tools)) {
        return fail(400);
      }

      const form = new FormData();
      form.set('sdp', sdp);
      form.set('session', JSON.stringify({
        type: 'realtime',
        model,
        audio: {output: {voice: 'shimmer'}},
        instructions: session.instructions,
        tools: session.tools,
      }));
      const upstream = await fetcher('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: {Authorization: `Bearer ${apiKey}`, 'OpenAI-Safety-Identifier': safetyIdentifier},
        body: form,
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      });
      if (!upstream.ok) {
        console.error('[owner-voice] Realtime connection rejected', {status: upstream.status});
        return fail(502);
      }
      const answer = await upstream.text();
      if (response.destroyed) return;
      response.writeHead(200, {'Content-Type': 'application/sdp', 'Cache-Control': 'no-store'});
      response.end(answer);
    } catch {
      fail(502);
    } finally {
      clearTimeout(bodyTimer);
      response.off('close', abort);
    }
  };
}
