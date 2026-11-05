import {loadBusinessConfig} from '../agents/black/business-tools.mjs';

export function loadTenantRoutes(env = process.env) {
  if (!env.BMSPRO_BRIDGE_SECRET?.trim()) throw new Error('Set BMSPRO_BRIDGE_SECRET to the shared backend bridge credential.');
  const config = loadBusinessConfig({...env, BMSPRO_MCP_SECRET: env.BMSPRO_BRIDGE_SECRET, BMSPRO_EXPECTED_DID: undefined});
  let dids;
  try { dids = JSON.parse(env.BMSPRO_ONBOARDING_DIDS_JSON || '[]'); }
  catch { throw new Error('BMSPRO_ONBOARDING_DIDS_JSON must be a JSON array of DID digits.'); }
  if (!Array.isArray(dids) || dids.length > 20 || dids.some(did => typeof did !== 'string' || !/^\d{6,15}$/.test(did)) || new Set(dids).size !== dids.length)
    throw new Error('Use unique 6-15 digit numbers in BMSPRO_ONBOARDING_DIDS_JSON.');
  const tradeUrl = new URL(config.url);
  tradeUrl.pathname = '/api/bms-blue/ai/mcp/';
  const pinkUrl = new URL(config.url);
  pinkUrl.pathname = '/api/bms-pink/ai/mcp/';
  const routeUrl = new URL(config.url);
  routeUrl.pathname = '/api/ai/mcp/route/';
  const trade = Object.freeze({url: tradeUrl.toString(), token: config.token});
  // Trade owns its DID assignments; the bridge only stores its endpoint and credential.
  let directTrade = null;
  const directUrl = env.BMSPRO_TRADE_MCP_URL?.trim();
  const directSecret = env.BMSPRO_TRADE_BRIDGE_SECRET?.trim();
  if (directUrl || directSecret) {
    if (!directUrl || !directSecret) throw new Error('Direct Trade requires its URL and a dedicated bridge secret.');
    const url = new URL(directUrl);
    const octets = url.hostname.split('.').map(Number);
    const tailscale = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255) && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || tailscale;
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local && env.BMSPRO_ALLOW_HTTP_FOR_LOCAL_TEST === 'true')) ||
        url.username || url.password || url.search || url.hash || !/^\/api\/ai\/mcp\/?$/.test(url.pathname))
      throw new Error('Direct Trade requires an HTTPS /api/ai/mcp URL, or explicitly enabled loopback/Tailscale HTTP for testing.');
    if (directSecret.length < 32 || /[\r\n]/.test(directSecret) || /YOUR_|REPLACE_/.test(directSecret) ||
        directSecret === config.token || directSecret === env.BMSPRO_ONBOARDING_BRIDGE_SECRET?.trim())
      throw new Error('Use a separate direct Trade bridge secret of at least 32 characters.');
    const discoveryUrl = new URL(url);
    discoveryUrl.pathname = '/api/ai/voice';
    directTrade = Object.freeze({url: url.toString(), token: directSecret, discoveryUrl: discoveryUrl.toString()});
  }
  const pink = Object.freeze({url: pinkUrl.toString(), token: config.token});
  let onboarding = null;
  if (dids.length) {
    const token = env.BMSPRO_ONBOARDING_BRIDGE_SECRET?.trim() || '';
    if (token.length < 32 || /[\r\n]/.test(token) || /YOUR_|REPLACE_/.test(token) || token === config.token)
      throw new Error('Configure a separate BMSPRO_ONBOARDING_BRIDGE_SECRET for onboarding routes.');
    const url = new URL(config.url);
    url.pathname = '/api/ai/mcp/onboarding-call/';
    onboarding = Object.freeze({dids: Object.freeze([...dids]), url: url.toString(), token});
  }
  return Object.freeze({config: Object.freeze(config), onboarding, trade, directTrade, pink, routeUrl: routeUrl.toString()});
}

export function didForMediaStart(event) {
  const variables = event.channel_variables;
  if (!variables || typeof variables !== 'object') throw new Error('Missing Asterisk route variable.');
  const values = ['BMS_ROUTE_INFO', '_BMS_ROUTE_INFO', '__BMS_ROUTE_INFO']
    .filter(key => Object.hasOwn(variables, key)).map(key => variables[key]);
  if (!values.length || values.some(value => typeof value !== 'string' || value !== values[0]))
    throw new Error('Missing or conflicting Asterisk route marker.');
  // A literal header value only; never fetch the Alert-Info URI.
  const match = /^<[^<>\r\n]{1,200}>\s*;\s*info=(bmsdid\d{6,15})\s*$/i.exec(values[0].trim());
  if (!match) throw new Error('Invalid route marker.');
  return match[1].slice(6);
}

export function configForDid(did, routes, brand) {
  if (!/^\d{6,15}$/.test(did)) throw new Error('Use 6-15 DID digits without spaces or +.');
  if (routes.onboarding?.dids.includes(did)) return {mode: 'onboarding', url: routes.onboarding.url, token: routes.onboarding.token, did};
  if (brand === 'trade') return {mode: 'trade', url: routes.trade.url, token: routes.trade.token, did, routingHeaders: {'X-BMSPro-DID': did}};
  if (brand === 'pink') return {mode: 'pink', url: routes.pink.url, token: routes.pink.token, did, routingHeaders: {'X-BMSPro-DID': did}};
  if (brand === 'black') return {...routes.config, mode: 'receptionist', did, routingHeaders: {'X-BMSPro-DID': did}};
  throw new Error('DID product has not been resolved by the backend.');
}

export async function resolveConfigForDid(did, routes, fetcher = fetch) {
  if (!/^\d{6,15}$/.test(did)) throw new Error('Use 6-15 DID digits without spaces or +.');
  if (routes.onboarding?.dids.includes(did)) return configForDid(did, routes);
  let discoveryFailure;
  if (routes.directTrade) {
    let discovery;
    try {
      discovery = await fetcher(routes.directTrade.discoveryUrl, {
        method: 'POST', headers: {Authorization: `Bearer ${routes.directTrade.token}`, 'X-BMSPro-DID': did},
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
    } catch { discoveryFailure = 'Trade DID discovery could not be reached.'; }
    if (discovery?.status === 403) throw new Error('Trade DID or business is disabled. Check Trade dashboard DID mappings.');
    if (discovery?.ok) {
      let route;
      try { route = await discovery.json(); } catch { throw new Error('Trade DID discovery response is invalid.'); }
      if (route?.did !== did || typeof route?.matched !== 'boolean') throw new Error('Trade DID discovery response does not match the call.');
      if (route.matched) {
        if (route.brand !== 'trade' || typeof route.businessId !== 'string' || !route.businessId.trim() || route.businessId !== route.businessId.trim() ||
            route.businessId.length > 128 || route.businessId.includes('/') || ['.', '..'].includes(route.businessId))
          throw new Error('Trade DID discovery returned an invalid business.');
        return {mode: 'trade', url: routes.directTrade.url, token: routes.directTrade.token, did, businessId: route.businessId,
          activityUrl: routes.config.url, activityToken: routes.config.token, routingHeaders: {'X-BMSPro-DID': did, 'X-BMSPro-Trade-Business': route.businessId}};
      }
    } else if (discovery) discoveryFailure = `Trade DID discovery failed (HTTP ${discovery.status}).`;
  }
  let response;
  try {
    response = await fetcher(routes.routeUrl, {
      method: 'POST',
      headers: {Authorization: `Bearer ${routes.config.token}`, 'X-BMSPro-DID': did},
      signal: AbortSignal.timeout(12000),
      redirect: 'error',
    });
  } catch { throw new Error('Backend DID routing lookup failed.'); }
  if (!response.ok) throw new Error(`Backend DID routing lookup failed (HTTP ${response.status}).`);
  let route;
  try { route = await response.json(); } catch { throw new Error('Backend DID routing response is invalid.'); }
  if (route?.did !== did || !['black', 'trade', 'pink'].includes(route?.brand)) throw new Error('Backend DID routing response does not match the call.');
  // An outage, missing assignment or stale backend Trade route cannot bypass Trade's dashboard.
  if (route.brand === 'trade' && routes.directTrade) throw new Error(discoveryFailure || 'This Trade DID must be enabled in Trade dashboard DID mappings.');
  return configForDid(did, routes, route.brand);
}

export async function resolveMediaStartRoute(event, routes, fetcher = fetch) {
  return resolveConfigForDid(didForMediaStart(event), routes, fetcher);
}
