// Read-only diagnostics. Never prints credentials, response bodies or caller data.
const url = new URL(process.env.BMSPRO_TRADE_MCP_URL || 'http://127.0.0.1:3001/api/ai/mcp');
const secret = process.env.BMSPRO_TRADE_BRIDGE_SECRET;
const did = process.argv[2];
if (!secret || !/^\d{6,15}$/.test(did || '')) throw new Error('Load the pilot env file and supply DID digits.');
const code = value => String(value || 'UNKNOWN').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
console.log(`Trade diagnostic: endpoint=${url.origin}${url.pathname} did=${did}`);
async function check(label, init) {
  const started = performance.now();
  try {
    const response = await fetch(url, {...init, redirect: 'error', signal: AbortSignal.timeout(30000)});
    console.log(`${label}: HTTP ${response.status} durationMs=${Math.round(performance.now() - started)}`);
    return response;
  } catch (error) {
    console.log(`${label}: FAILED code=${code(error?.cause?.code || error?.code || error?.name)} durationMs=${Math.round(performance.now() - started)}`);
    console.log('No HTTP response received. Check Tailscale reachability, TCP port 3001 and Windows inbound firewall rules.');
    process.exitCode = 1;
    return null;
  }
}
const reachability = await check('Network/GET', {method: 'GET'});
if (reachability) {
  await reachability.body?.cancel();
  const response = await check('MCP initialize', {
    method: 'POST',
    headers: {Authorization: `Bearer ${secret}`, 'X-BMSPro-DID': did,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'trade-readonly-diagnostic', version: '1.0.0'},
    }}),
  });
  if (response) {
    try {
      const result = await response.json();
      console.log(`MCP result: initialized=${Boolean(result.result?.protocolVersion)} rpcErrorCode=${code(result.error?.code || 'none')}`);
      if (!response.ok || !result.result?.protocolVersion) process.exitCode = 1;
    } catch { console.log('MCP response is not JSON. Check proxy or development-server output.'); process.exitCode = 1; }
  }
}
