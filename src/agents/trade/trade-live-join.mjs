import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';

export function loadLiveJoin(env = process.env) {
  if (env.BMSPRO_LIVE_JOIN_ENABLED !== 'true') return null;
  const username = env.BMSPRO_LIVE_JOIN_AMI_USER?.trim();
  const secret = env.BMSPRO_LIVE_JOIN_AMI_SECRET?.trim();
  if (!username || !secret || secret.length < 32 || /[\r\n\0]/.test(username + secret)) {
    throw new Error('Configure the live-join AMI username and secret together.');
  }
  return {username, secret};
}

/** Queues one owner leg. Never retries an uncertain AMI submission. */
export function originateLiveJoin(config, {channel, extension}, isActive, connect = createConnection) {
  if (typeof channel !== 'string' || channel !== channel.trim() || channel.length > 128 ||
      !/^PJSIP\/yeastar-[a-f0-9]+$/i.test(channel) || typeof extension !== 'string' || extension !== extension.trim() ||
      !/^\d{2,11}$/.test(extension) || extension === '2000') return Promise.resolve({status: 'FAILED'});
  return new Promise(resolve => {
    let socket, submitted = false, settled = false, buffer = '';
    const actionId = randomUUID();
    const finish = status => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket?.destroy(); resolve({status});
    };
    const timer = setTimeout(() => finish(submitted ? 'UNKNOWN' : 'FAILED'), 4000);
    try { socket = connect({host: '127.0.0.1', port: 5038}); }
    catch { finish('FAILED'); return; }
    socket.setEncoding('utf8');
    socket.on('error', () => finish(submitted ? 'UNKNOWN' : 'FAILED'));
    socket.on('close', () => finish(submitted ? 'UNKNOWN' : 'FAILED'));
    socket.on('connect', () => socket.write(`Action: Login\r\nActionID: login\r\nUsername: ${config.username}\r\nSecret: ${config.secret}\r\nEvents: off\r\n\r\n`));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 8192) return finish(submitted ? 'UNKNOWN' : 'FAILED');
      for (let end; (end = buffer.indexOf('\r\n\r\n')) !== -1;) {
        const frame = buffer.slice(0, end).split('\r\n'); buffer = buffer.slice(end + 4);
        if (!submitted && frame.includes('ActionID: login')) {
          if (!frame.includes('Response: Success') || !isActive()) return finish('FAILED');
          submitted = true;
          // u selects one fully specified channel (no prefix matching or DTMF
          // channel selection); B talks to both legs; E/S exit if it disappears.
          socket.write([
            'Action: Originate', `ActionID: ${actionId}`, `Channel: PJSIP/${extension}@yeastar`,
            'Application: ChanSpy', `Data: ${channel},uBES`, 'Timeout: 25000',
            'CallerID: Sophie live join', 'Async: true',
          ].join('\r\n') + '\r\n\r\n');
        } else if (submitted && frame.includes(`ActionID: ${actionId}`)) {
          return finish(frame.includes('Response: Success') ? 'REQUESTED' : 'FAILED');
        }
      }
    });
  });
}
