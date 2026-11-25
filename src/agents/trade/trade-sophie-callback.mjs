/**
 * trade-sophie-callback.mjs: lets Trade ask the bridge to phone a customer, with Sophie speaking on the call.
 * Used for missed-call callbacks and for overdue-invoice calls (purpose 'overdue_invoice').
 *
 * Flow: Trade -> POST here (Bearer secret) -> validate -> originate() asks the Asterisk PBX over AMI
 * (127.0.0.1:5038) to dial the customer -> when answered, the call enters the context
 * `bms-sophie-callback` carrying a one-time token -> the bridge uses take(token) to fetch the route and
 * purpose for that call.
 */
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {createConnection} from 'node:net';

/**
 * Dial `number` through Asterisk's AMI. Logs in, sends an Originate action, then waits for the result.
 * Resolves ANSWERED, NO_ANSWER, FAILED, or UNKNOWN (the dial was sent but the outcome was never seen,
 * so the caller must not assume it did or did not ring). `report(code, reason)` receives a diagnostic code.
 * `connect` is replaceable in tests.
 */
export function originate(
  {username, secret, number, did, token, prefix, report = () => {}},
  connect = createConnection,
) {
  return new Promise(resolve => {
    const socket = connect({host: '127.0.0.1', port: 5038});
    let buffer = '',
      submitted = false,
      finished = false;
    const finish = (status, code, reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      report(code, reason);
      resolve(status);
    };
    const timer = setTimeout(
      () => finish(submitted ? 'UNKNOWN' : 'FAILED', submitted ? 'AMI_RESULT_TIMEOUT' : 'AMI_LOGIN_TIMEOUT'),
      38_000,
    );
    socket.setEncoding('utf8');
    socket.on('connect', () =>
      socket.write(
        `Action: Login\r\nActionID: login\r\nUsername: ${username}\r\nSecret: ${secret}\r\nEvents: call\r\n\r\n`,
      ),
    );
    socket.on('error', () => finish(submitted ? 'UNKNOWN' : 'FAILED', 'AMI_SOCKET_ERROR'));
    socket.on('close', () => finish(submitted ? 'UNKNOWN' : 'FAILED', 'AMI_SOCKET_CLOSED'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 65536) return finish(submitted ? 'UNKNOWN' : 'FAILED', 'AMI_RESPONSE_TOO_LARGE');
      for (let end; (end = buffer.indexOf('\r\n\r\n')) !== -1; ) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 4);
        const field = name => new RegExp(`^${name}: ([^\\r\\n]*)`, 'im').exec(frame)?.[1];
        if (field('ActionID') === 'login' && !submitted) {
          if (field('Response') !== 'Success') return finish('FAILED', 'AMI_LOGIN_REJECTED');
          submitted = true;
          socket.write(
            [
              'Action: Originate',
              `ActionID: ${token}`,
              `Channel: PJSIP/${prefix}${number}@yeastar`,
              'Context: bms-sophie-callback',
              'Exten: s',
              'Priority: 1',
              'Timeout: 25000',
              `CallerID: ${did}`,
              'Async: true',
              `Variable: __BMS_CALLBACK_TOKEN=${token}`,
            ].join('\r\n') + '\r\n\r\n',
          );
        } else if (field('ActionID') === token) {
          if (field('Event') === 'OriginateResponse') {
            const reason = field('Reason');
            const safeReason = /^\d{1,3}$/.test(reason ?? '') ? reason : undefined;
            if (field('Response') === 'Success') return finish('ANSWERED', 'PBX_ANSWERED', safeReason);
            if (reason === '3') return finish('NO_ANSWER', 'PBX_NO_ANSWER', safeReason);
            return finish('FAILED', 'PBX_ORIGINATE_FAILED', safeReason);
          }
          if (field('Response') === 'Error')
            return finish(
              'FAILED',
              /permission denied/i.test(field('Message') ?? '')
                ? 'AMI_PERMISSION_DENIED'
                : 'AMI_ORIGINATE_REJECTED',
            );
        }
      }
    });
  });
}

/**
 * Build the callback service, or return null when it is disabled or misconfigured (needs
 * BMSPRO_CALLBACK_ENABLED=true, an AMI username and secret, and a bridge secret of 32+ chars).
 * `resolveRoute(did)` finds the Trade business for a number; `hasCapacity()` says whether the bridge can
 * take another call. Returns {take, handle}:
 *   take(token)   one-time lookup of the pending call's route; deleted when read or after 45 s
 *   handle(req, res, purpose)  the HTTP endpoint. Validates input, dedupes by request id (result kept for an
 *                              hour), allows one dial at a time and at most 100 tracked attempts (else 429).
 */
export function createSophieCallback({env, bridgeSecret, resolveRoute, hasCapacity, dial = originate}) {
  const did = env.BMSPRO_CALLBACK_PILOT_DID?.trim();
  const mobile = env.BMSPRO_CALLBACK_PILOT_MOBILE?.trim();
  const username = env.BMSPRO_CALLBACK_AMI_USER?.trim();
  const secret = env.BMSPRO_CALLBACK_AMI_SECRET?.trim();
  const prefix = env.BMSPRO_CALLBACK_DIAL_PREFIX?.trim() ?? '';
  if (
    env.BMSPRO_CALLBACK_ENABLED !== 'true' ||
    !username ||
    !secret ||
    /[\r\n]/.test(username + secret) ||
    !bridgeSecret ||
    bridgeSecret.length < 32
  )
    return null;

  const expected = Buffer.from(`Bearer ${bridgeSecret}`);
  const attempts = new Map();
  const media = new Map();
  let dialing = false;
  return {
    take(token) {
      const entry = media.get(token);
      media.delete(token);
      return entry;
    },
    async handle(request, response, purpose = 'missed_call') {
      const send = (code, body) => {
        if (response.destroyed) return;
        response.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
        response.end(JSON.stringify(body));
      };
      const actual = Buffer.from(request.headers.authorization ?? '');
      if (request.method !== 'POST') return send(405, {});
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return send(401, {});
      const timer = setTimeout(() => request.destroy(), 5000);
      let input;
      try {
        let body = '';
        for await (const chunk of request.iterator({destroyOnReturn: false})) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 8192) return send(413, {});
        }
        input = JSON.parse(body);
      } catch {
        return send(400, {});
      } finally {
        clearTimeout(timer);
      }
      if (
        typeof input?.id !== 'string' ||
        !/^[a-f0-9]{64}$/.test(input.id) ||
        !/^\d{6,15}$/.test(input.did ?? '') ||
        !/^(?:0[23478]\d{8}|947\d{8})$/.test(input.number ?? '') ||
        typeof input.businessId !== 'string' ||
        input.businessId.length > 128
      )
        return send(400, {});
      if (
        (purpose === 'overdue_invoice' || purpose === 'owner_requested' || purpose === 'owner_notification') &&
        (typeof input.customerName !== 'string' ||
          !input.customerName.trim() ||
          input.customerName.length > 120)
      )
        return send(400, {});
      if(purpose==='owner_requested'&&(!['service','complaint','quotation','invoice','other'].includes(input.ownerRequest?.category)||typeof input.ownerRequest?.instructions!=='string'||input.ownerRequest.instructions.trim().length<10||input.ownerRequest.instructions.length>1000))return send(400,{});
      if(purpose==='owner_notification'&&(!input.ownerNotification||typeof input.ownerNotification.requestCode!=='string'||!/^[-A-Za-z0-9 _]{1,80}$/.test(input.ownerNotification.requestCode)))return send(400,{});
      const existing = attempts.get(input.id);
      if (existing) return send(200, await existing);
      if (dialing || !hasCapacity() || attempts.size >= 100) return send(429, {});
      dialing = true;
      const attempt = (async () => {
        const route = await resolveRoute(input.did).catch(() => null);
        if (route?.mode !== 'trade' || route.businessId !== input.businessId)
          return {status: 'FAILED', code: 'TRADE_ROUTE_UNAVAILABLE'};
        if (!hasCapacity()) return {status: 'FAILED', code: 'BRIDGE_AT_CAPACITY'};
        const settings =
          route.callback ??
          (purpose === 'missed_call' &&
          input.automatic !== true &&
          input.did === did &&
          input.number === mobile
            ? {callerId: did, dialPrefix: prefix}
            : null);
        if (
          !settings ||
          (input.automatic === true && settings.automatic !== true) ||
          !/^\+?\d{6,15}$/.test(settings.callerId ?? '') ||
          !/^(?:\+|\d{0,6})$/.test(settings.dialPrefix ?? '')
        ) {
          return {status: 'FAILED', code: 'CALLBACK_ROUTE_DISABLED'};
        }
        const token = randomBytes(24).toString('hex');
        media.set(token, {
          route,
          number: input.number,
          attemptId: input.id,
          purpose,
          customerName: input.customerName,
          ...(purpose==='owner_notification'?{ownerNotification:{requestCode:input.ownerNotification.requestCode}}:{}),
          ...(purpose==='owner_requested'?{ownerRequest:{category:input.ownerRequest.category,instructions:input.ownerRequest.instructions}}:{}),
        });
        setTimeout(() => media.delete(token), 45_000).unref();
        let diagnostic;
        const status = await dial({
          username,
          secret,
          number: input.number,
          did: settings.callerId,
          token,
          prefix: settings.dialPrefix,
          report: (code, reason) => {
            diagnostic = {code, reason};
          },
        });
        if (status === 'FAILED' || status === 'NO_ANSWER') media.delete(token);
        return {status, ...diagnostic};
      })()
        .catch(() => ({status: 'FAILED', code: 'CALLBACK_INTERNAL_ERROR'}))
        .then(result => {
          console.info(
            `[sophie-callback] id=${input.id.slice(0, 8)} status=${result.status} code=${result.code}${result.reason ? ` reason=${result.reason}` : ''}`,
          );
          return result;
        })
        .finally(() => {
          dialing = false;
        });
      attempts.set(input.id, attempt);
      setTimeout(() => attempts.delete(input.id), 60 * 60_000).unref();
      return send(200, await attempt);
    },
  };
}
