import {VOICE_TOOLS, checkBusinessTools} from './business-tools.mjs';
import {loadTenantRoutes, resolveConfigForDid} from './tenant-routing.mjs';
import {openOnboardingSession, ONBOARDING_TOOLS} from './onboarding-tools.mjs';
import {openTradeSession} from './trade-tools.mjs';
import {openPinkSession} from './pink-tools.mjs';

try {
  const routes = loadTenantRoutes();
  const did = process.argv[2];
  if (!did) throw new Error('Specify a DID to verify: node --env-file=.env check-mcp.mjs 0359111403. No DID list is stored on the bridge.');
  const config = await resolveConfigForDid(did, routes);
  console.log(`DID route: mode=${config.mode} endpoint=${config.url}`);
  if (config.mode === 'onboarding') {
    const session = await openOnboardingSession(config);
    await session.close();
    console.log(`Onboarding MCP ready for DID ${did}: ${ONBOARDING_TOOLS.join(', ')}.`);
    console.log('This check created a setup draft. It did not call OpenAI, approve, provision or activate an account.');
  } else if (config.mode === 'trade') {
    const session = await openTradeSession(config, {onTiming: (phase, elapsedMs) => console.log(`MCP startup: phase=${phase} durationMs=${elapsedMs}`)});
    try {
      const services = await session.call('list_services', {});
      if (!Array.isArray(services)) throw new Error('Trade service lookup failed.');
      console.log(`Trade MCP ready for DID ${did}: business verified; ${services.length} active services.`);
      console.log(`Enabled voice tools: ${session.tools.map(tool => tool.name).join(', ')}.`);
      console.log('This read-only check did not call OpenAI or create an inspection request.');
    } finally { await session.close(); }
  } else if (config.mode === 'pink') {
    const session = await openPinkSession(config, {onTiming: (phase, elapsedMs) => console.log(`MCP startup: phase=${phase} durationMs=${elapsedMs}`)});
    try {
      const services = await session.call('list_services', {});
      if (!Array.isArray(services)) throw new Error('Pink service lookup failed.');
      console.log(`Pink MCP ready for DID ${did}: salon and branch verified; ${services.length} active services.`);
      console.log(`Enabled voice tools: ${session.tools.map(tool => tool.name).join(', ')}.`);
      console.log('This read-only check did not call OpenAI or create a booking.');
    } finally { await session.close(); }
  } else {
  const result = await checkBusinessTools(config, {
    onTiming: (phase, elapsedMs) => console.log(`MCP startup: phase=${phase} durationMs=${elapsedMs}`),
  });
  console.log(`MCP ready for DID ${did}: backend mapping verified; ${result.serviceCount} configured services.`);
  console.log(`Enabled voice tools: ${VOICE_TOOLS.join(', ')}.`);
  console.log('Availability tool presence verified; date-specific availability is checked during the call.');
  console.log('This check did not call OpenAI or create a booking.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'MCP readiness check failed.');
  process.exitCode = 1;
}
