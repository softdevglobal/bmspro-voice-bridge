import {createConnection} from 'node:net';

const channelPattern = /^PJSIP\/yeastar-[a-f0-9]+$/i;
const validChannel = channel => typeof channel === 'string' && channel === channel.trim() && channelPattern.test(channel);
const validExtension = extension => typeof extension === 'string' && extension === extension.trim() &&
  /^\d{2,11}$/.test(extension) && extension !== '2000';

export function loadOwnerHandoff(env = process.env) {
  const username = env.BMSPRO_HANDOFF_AMI_USER?.trim();
  const secret = env.BMSPRO_HANDOFF_AMI_SECRET?.trim();
  if (!username && !secret) return null;
  if (!username || !secret || secret.length < 32 || [username, secret].some(value => /[\r\n\0]/.test(value))) {
    throw new Error('Configure the local AMI username and secret together.');
  }
  return {username, secret};
}

export function ownerHandoffReadiness(config, route, variables) {
  if (route.mode !== 'trade') return {status: 'NOT_TRADE_ROUTE'};
  const extension = route.forwardingExtension;
  if (!extension) return {status: 'NOT_MAPPED'};
  if (!validExtension(extension)) return {status: 'INVALID_EXTENSION'};
  if (!config) return {status: 'NOT_CONFIGURED'};
  if (!variables || typeof variables !== 'object') return {status: 'MISSING_CALLER_CHANNEL'};
  const channels = ['BMS_CALLER_CHANNEL', '_BMS_CALLER_CHANNEL', '__BMS_CALLER_CHANNEL']
    .filter(key => Object.hasOwn(variables, key)).map(key => variables[key]);
  if (!channels.length) return {status: 'MISSING_CALLER_CHANNEL'};
  const channel = channels[0];
  return validChannel(channel) && channels.every(value => value === channel)
    ? {status: 'READY', channel, extension} : {status: 'INVALID_CALLER_CHANNEL'};
}

export function redirectToOwner(config, {channel, extension}, connect = createConnection, onFailure = () => {}) {
  if (!validChannel(channel) || !validExtension(extension)) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = connect({host: '127.0.0.1', port: 5038});
    let buffer = '';
    let phase = 'login';
    let settled = false;
    const finish = (success, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (!success) onFailure(reason);
      resolve(success);
    };
    const timeout = setTimeout(() => finish(false, phase === 'login' ? 'AMI_LOGIN_TIMEOUT' : 'AMI_REDIRECT_TIMEOUT'), 4000);
    socket.setEncoding('utf8');
    socket.on('error', error => finish(false, error.code === 'ECONNREFUSED' ? 'AMI_CONNECTION_REFUSED' : 'AMI_SOCKET_ERROR'));
    socket.on('close', () => finish(false, phase === 'login' ? 'AMI_LOGIN_CLOSED' : 'AMI_REDIRECT_CLOSED'));
    socket.on('connect', () => {
      socket.write(`Action: Login\r\nActionID: login\r\nUsername: ${config.username}\r\nSecret: ${config.secret}\r\nEvents: off\r\n\r\n`);
    });
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 8192) return finish(false, 'AMI_RESPONSE_TOO_LARGE');
      let separator;
      while ((separator = buffer.indexOf('\r\n\r\n')) >= 0) {
        const frame = buffer.slice(0, separator).split('\r\n');
        buffer = buffer.slice(separator + 4);
        if (!frame.includes(`ActionID: ${phase}`)) continue;
        if (!frame.includes('Response: Success')) {
          if (phase === 'login') return finish(false, 'AMI_LOGIN_REJECTED');
          const message = frame.find(line => line.startsWith('Message:')) ?? '';
          if (/permission denied/i.test(message)) return finish(false, 'AMI_REDIRECT_PERMISSION_DENIED');
          if (/no such channel|does not exist/i.test(message)) return finish(false, 'AMI_CALLER_CHANNEL_GONE');
          return finish(false, 'AMI_REDIRECT_REJECTED');
        }
        if (phase === 'redirect') return finish(true);
        phase = 'redirect';
        socket.write(`Action: Redirect\r\nActionID: redirect\r\nChannel: ${channel}\r\nContext: bms-trade-owner-handoff\r\nExten: ${extension}\r\nPriority: 1\r\n\r\n`);
      }
    });
  });
}
