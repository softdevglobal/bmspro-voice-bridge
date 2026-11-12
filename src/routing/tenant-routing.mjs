// This file's main responsibility is to identify which BMSPro product/business should handle an
// incoming telephone call and provide the correct API endpoint and authentication credentials.


// Loads the shared (Black) backend settings: the MCP URL and token from the environment.
import {loadBusinessConfig} from '../agents/black/business-tools.mjs';

// Runs once at startup. Reads .env, validates it, and builds the table of backend endpoints and secrets.
export function loadTenantRoutes(env = process.env) {
  // The shared bridge secret is required; without it the bridge cannot authenticate to the backend.
  if (!env.BMSPRO_BRIDGE_SECRET?.trim()) throw new Error('Set BMSPRO_BRIDGE_SECRET to the shared backend bridge credential.');
  // Load the shared backend config, using the bridge secret as the token. The expected DID is cleared because the DID is looked up per call.
  const config = loadBusinessConfig({...env, BMSPRO_MCP_SECRET: env.BMSPRO_BRIDGE_SECRET, BMSPRO_EXPECTED_DID: undefined});
  // Will hold the list of onboarding phone numbers (DIDs).
  let dids;
  // Parse the onboarding DID list from JSON; use an empty list if the variable is not set.
  try { dids = JSON.parse(env.BMSPRO_ONBOARDING_DIDS_JSON || '[]'); }
  // Stop with a clear message if the JSON is malformed.
  catch { throw new Error('BMSPRO_ONBOARDING_DIDS_JSON must be a JSON array of DID digits.'); }
  // The list must be an array of at most 20 unique strings, each 6-15 digits long.
  if (!Array.isArray(dids) || dids.length > 20 || dids.some(did => typeof did !== 'string' || !/^\d{6,15}$/.test(did)) || new Set(dids).size !== dids.length)
    throw new Error('Use unique 6-15 digit numbers in BMSPRO_ONBOARDING_DIDS_JSON.');
  // Trade (shared backend) endpoint: same host as the shared backend, Blue API path.
  const tradeUrl = new URL(config.url);
  tradeUrl.pathname = '/api/bms-blue/ai/mcp/';
  // Pink endpoint: same host, Pink API path.
  const pinkUrl = new URL(config.url);
  pinkUrl.pathname = '/api/bms-pink/ai/mcp/';
  // DID routing endpoint: asks the backend which product owns a dialled number.
  const routeUrl = new URL(config.url);
  routeUrl.pathname = '/api/ai/mcp/route/';
  // Frozen (read-only) Trade settings: endpoint plus the shared token.
  const trade = Object.freeze({url: tradeUrl.toString(), token: config.token});
  // Trade owns its DID assignments; the bridge only stores its endpoint and credential.
  // Direct Trade (a separate Trade server) is optional, so it starts as not configured.
  let directTrade = null;
  // Optional direct Trade endpoint from .env.
  const directUrl = env.BMSPRO_TRADE_MCP_URL?.trim();
  // Optional direct Trade secret from .env.
  const directSecret = env.BMSPRO_TRADE_BRIDGE_SECRET?.trim();
  // If either direct Trade setting is present, validate and enable direct Trade.
  if (directUrl || directSecret) {
    // The URL and the secret must be set together.
    if (!directUrl || !directSecret) throw new Error('Direct Trade requires its URL and a dedicated bridge secret.');
    // Parse the direct Trade URL.
    const url = new URL(directUrl);
    // Split the host into numbers (e.g. 100.80.10.20 -> [100, 80, 10, 20]) to test for a Tailscale address.
    const octets = url.hostname.split('.').map(Number);
    // True if the host is a valid IPv4 address in Tailscale's range 100.64.0.0 - 100.127.255.255.
    const tailscale = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255) && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
    // True if the host is this machine (localhost) or a Tailscale address.
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || tailscale;
    // The URL must use HTTPS (plain HTTP only for local/Tailscale hosts when BMSPRO_ALLOW_HTTP_FOR_LOCAL_TEST=true),
    // must not contain a username, password, query string or fragment, and the path must be /api/ai/mcp.
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local && env.BMSPRO_ALLOW_HTTP_FOR_LOCAL_TEST === 'true')) ||
        url.username || url.password || url.search || url.hash || !/^\/api\/ai\/mcp\/?$/.test(url.pathname))
      throw new Error('Direct Trade requires an HTTPS /api/ai/mcp URL, or explicitly enabled loopback/Tailscale HTTP for testing.');
    // The secret must be at least 32 characters, one line, not a placeholder,
    // and different from the shared token and the onboarding secret.
    if (directSecret.length < 32 || /[\r\n]/.test(directSecret) || /YOUR_|REPLACE_/.test(directSecret) ||
        directSecret === config.token || directSecret === env.BMSPRO_ONBOARDING_BRIDGE_SECRET?.trim())
      throw new Error('Use a separate direct Trade bridge secret of at least 32 characters.');
    // Discovery URL: the Trade endpoint that says which Trade business owns a DID.
    const discoveryUrl = new URL(url);
    discoveryUrl.pathname = '/api/ai/voice';
    // Save the direct Trade settings as a frozen (read-only) object.
    directTrade = Object.freeze({url: url.toString(), token: directSecret, discoveryUrl: discoveryUrl.toString()});
  }
  // Frozen Pink settings: endpoint plus the shared token.
  const pink = Object.freeze({url: pinkUrl.toString(), token: config.token});
  // Onboarding is optional, so it starts as not configured.
  let onboarding = null;
  // Only set up onboarding if at least one onboarding number is listed.
  if (dids.length) {
    // Onboarding uses its own secret.
    const token = env.BMSPRO_ONBOARDING_BRIDGE_SECRET?.trim() || '';
    // The secret must be at least 32 characters, one line, not a placeholder, and different from the shared token.
    if (token.length < 32 || /[\r\n]/.test(token) || /YOUR_|REPLACE_/.test(token) || token === config.token)
      throw new Error('Configure a separate BMSPRO_ONBOARDING_BRIDGE_SECRET for onboarding routes.');
    // Onboarding endpoint: same host as the shared backend, onboarding-call path.
    const url = new URL(config.url);
    url.pathname = '/api/ai/mcp/onboarding-call/';
    // Save the onboarding numbers (as a copy), endpoint and secret as a frozen object.
    onboarding = Object.freeze({dids: Object.freeze([...dids]), url: url.toString(), token});
  }
  // Return everything the bridge needs for routing, frozen so it cannot be changed later.
  return Object.freeze({config: Object.freeze(config), onboarding, trade, directTrade, pink, routeUrl: routeUrl.toString()});
}

// Reads the dialled number (DID) from the MEDIA_START event that Asterisk sends when a call begins.
export function didForMediaStart(event) {
  // Asterisk passes the route marker inside channel_variables.
  const variables = event.channel_variables;
  // If there are no channel variables, the call cannot be routed.
  if (!variables || typeof variables !== 'object') throw new Error('Missing Asterisk route variable.');
  // The variable can arrive under any of three names; collect the value from each one that is present.
  const values = ['BMS_ROUTE_INFO', '_BMS_ROUTE_INFO', '__BMS_ROUTE_INFO']
    .filter(key => Object.hasOwn(variables, key)).map(key => variables[key]);
  // There must be at least one value, every value must be text, and all values must be identical.
  if (!values.length || values.some(value => typeof value !== 'string' || value !== values[0]))
    throw new Error('Missing or conflicting Asterisk route marker.');
  // A literal header value only; never fetch the Alert-Info URI.
  // Expected format: <some-uri>;info=bmsdid0359111403 (the number is 6-15 digits).
  const match = /^<[^<>\r\n]{1,200}>\s*;\s*info=(bmsdid\d{6,15})\s*$/i.exec(values[0].trim());
  // Reject anything that does not match that exact format.
  if (!match) throw new Error('Invalid route marker.');
  // Drop the "bmsdid" prefix (6 characters) and return just the digits.
  return match[1].slice(6);
}

// Builds the call configuration (mode, endpoint, token) for a DID once its product (brand) is known.
export function configForDid(did, routes, brand) {
  // The DID must be 6-15 digits, with no spaces or "+".
  if (!/^\d{6,15}$/.test(did)) throw new Error('Use 6-15 DID digits without spaces or +.');
  // Onboarding numbers are decided locally from .env and always win.
  if (routes.onboarding?.dids.includes(did)) return {mode: 'onboarding', url: routes.onboarding.url, token: routes.onboarding.token, did};
  // Trade: shared Trade endpoint, with the DID sent as a routing header.
  if (brand === 'trade') return {mode: 'trade', url: routes.trade.url, token: routes.trade.token, did, routingHeaders: {'X-BMSPro-DID': did}};
  // Pink: Pink endpoint, with the DID sent as a routing header.
  if (brand === 'pink') return {mode: 'pink', url: routes.pink.url, token: routes.pink.token, did, routingHeaders: {'X-BMSPro-DID': did}};
  // Black: the shared workshop receptionist config.
  if (brand === 'black') return {...routes.config, mode: 'receptionist', did, routingHeaders: {'X-BMSPro-DID': did}};
  // Any other brand means the backend did not identify the product.
  throw new Error('DID product has not been resolved by the backend.');
}

// Works out which business and mode a DID belongs to. Checks onboarding, then direct Trade, then the backend.
// `fetcher` is the HTTP function; tests can replace it.
export async function resolveConfigForDid(did, routes, fetcher = fetch) {
  // The DID must be 6-15 digits, with no spaces or "+".
  if (!/^\d{6,15}$/.test(did)) throw new Error('Use 6-15 DID digits without spaces or +.');
  // Onboarding numbers are known locally, so no network lookup is needed.
  if (routes.onboarding?.dids.includes(did)) return configForDid(did, routes);
  // Remembers why direct Trade discovery failed, for a clearer error later.
  let discoveryFailure;
  // If direct Trade is configured, ask it first whether it owns this number.
  if (routes.directTrade) {
    // Will hold Trade's HTTP response.
    let discovery;
    try {
      // POST to Trade's discovery endpoint with the Trade secret and the DID.
      discovery = await fetcher(routes.directTrade.discoveryUrl, {
        method: 'POST', headers: {Authorization: `Bearer ${routes.directTrade.token}`, 'X-BMSPro-DID': did},
        // Give up after 15 seconds, and refuse redirects.
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
    // Network failure: remember it and carry on.
    } catch { discoveryFailure = 'Trade DID discovery could not be reached.'; }
    // HTTP 403 means this Trade number or its business is turned off.
    if (discovery?.status === 403) throw new Error('Trade DID or business is disabled. Check Trade dashboard DID mappings.');
    // A successful reply: read what Trade says about this number.
    if (discovery?.ok) {
      // Will hold Trade's JSON answer.
      let route;
      // Parse the JSON; stop if the body is not valid JSON.
      try { route = await discovery.json(); } catch { throw new Error('Trade DID discovery response is invalid.'); }
      // The reply must be for the same DID and must say matched true/false.
      if (route?.did !== did || typeof route?.matched !== 'boolean') throw new Error('Trade DID discovery response does not match the call.');
      // Trade owns this number.
      if (route.matched) {
        // Validate the business id: brand must be trade, id must be a clean string of at most 128 characters,
        // with no "/" and not "." or ".." (protects against path tricks).
        if (route.brand !== 'trade' || typeof route.businessId !== 'string' || !route.businessId.trim() || route.businessId !== route.businessId.trim() ||
            route.businessId.length > 128 || route.businessId.includes('/') || ['.', '..'].includes(route.businessId))
          throw new Error('Trade DID discovery returned an invalid business.');
        // Profile from discovery lets Sophie greet before the tool session is ready.
        const profile = route.profile && {
          brand: 'trade', did, businessId: route.businessId,
          businessName: route.profile.businessName, timezone: route.profile.timezone,
        };
        // Return the direct Trade config pinned to this business. The shared backend (activityUrl/Token) is used for activity records.
        return {mode: 'trade', url: routes.directTrade.url, token: routes.directTrade.token, did, businessId: route.businessId,
          ...(typeof route.forwardingExtension === 'string' && {forwardingExtension: route.forwardingExtension}),
          ...(profile && {discoveredProfile: profile}),
          activityUrl: routes.config.url, activityToken: routes.config.token, routingHeaders: {'X-BMSPro-DID': did, 'X-BMSPro-Trade-Business': route.businessId}};
      }
    // Any other HTTP error from Trade: remember it for the error message.
    } else if (discovery) discoveryFailure = `Trade DID discovery failed (HTTP ${discovery.status}).`;
  }
  // Fall back to the shared backend's routing lookup. Will hold its HTTP response.
  let response;
  try {
    // POST to the backend routing endpoint with the shared token and the DID.
    response = await fetcher(routes.routeUrl, {
      method: 'POST',
      headers: {Authorization: `Bearer ${routes.config.token}`, 'X-BMSPro-DID': did},
      // Give up after 12 seconds, and refuse redirects.
      signal: AbortSignal.timeout(12000),
      redirect: 'error',
    });
  // Network failure reaching the backend.
  } catch { throw new Error('Backend DID routing lookup failed.'); }
  // Any non-success HTTP status from the backend is an error.
  if (!response.ok) throw new Error(`Backend DID routing lookup failed (HTTP ${response.status}).`);
  // Will hold the backend's JSON answer.
  let route;
  // Parse the JSON; stop if the body is not valid JSON.
  try { route = await response.json(); } catch { throw new Error('Backend DID routing response is invalid.'); }
  // The reply must be for the same DID and name a known product (black, trade or pink).
  if (route?.did !== did || !['black', 'trade', 'pink'].includes(route?.brand)) throw new Error('Backend DID routing response does not match the call.');
  // An outage, missing assignment or stale backend Trade route cannot bypass Trade's dashboard.
  // If direct Trade is configured, a Trade answer from the backend is not trusted; Trade's own mapping must allow it.
  if (route.brand === 'trade' && routes.directTrade) throw new Error(discoveryFailure || 'This Trade DID must be enabled in Trade dashboard DID mappings.');
  // Build the final call config for the product the backend named.
  return configForDid(did, routes, route.brand);
}

// Entry point used by the bridge when a call starts: read the DID from the Asterisk event, then resolve its config.
export async function resolveMediaStartRoute(event, routes, fetcher = fetch) {
  return resolveConfigForDid(didForMediaStart(event), routes, fetcher);
}
