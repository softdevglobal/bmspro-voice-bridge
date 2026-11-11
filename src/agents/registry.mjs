// Agent registry: one place that maps a call mode to its agent.
// Each agent opens a call-scoped backend (MCP) session and has a fixed greeting.
import {openBusinessSession} from './black/business-tools.mjs';
import {openOnboardingSession} from './onboarding/onboarding-tools.mjs';
import {openTradeSession, tradeOpeningQuestion} from './trade/trade-tools.mjs';
import {openPinkSession} from './pink/pink-tools.mjs';

// Modes come from tenant-routing.mjs. Black uses 'receptionist'.
export const AGENT_MODES = Object.freeze(['receptionist', 'trade', 'pink', 'onboarding']);

/** Open the backend session for this call's mode. Unknown modes fall back to Black, as before. */
export function openAgentSession(config, timing) {
  if (config.mode === 'onboarding') return openOnboardingSession(config);
  if (config.mode === 'trade') return openTradeSession(config, timing);
  if (config.mode === 'pink') return openPinkSession(config, timing);
  return openBusinessSession(config, timing);
}

const greetingRules = 'Pronounce Sophie as SOH-fee. Then pause and listen. Do not call a tool before greeting.';
const speak = sentence => `Speak this greeting in English, preserving the complete sentence "My name is Sophie": "${sentence}" ${greetingRules}`;

/** The fixed opening line Sophie must say for this mode. */
export function openingGreeting(config) {
  if (config.mode === 'onboarding')
    return speak('Hi, thanks for calling BMS Pro. My name is Sophie, your AI assistant. Shall we get your business set up?');
  if (config.mode === 'pink')
    return speak(`Hello, thank you for calling ${JSON.stringify(config.businessName)}, ${JSON.stringify(config.branch)}. My name is Sophie, your AI receptionist. How can I help?`);
  if (config.mode === 'trade')
    return speak(`Hi, thanks for calling ${JSON.stringify(config.businessName)}. My name is Sophie, your AI receptionist. ${tradeOpeningQuestion(config)}`);
  return speak(`Hello, thank you for calling ${JSON.stringify(config.workshop)}, ${JSON.stringify(config.branch)}. My name is Sophie, your AI receptionist. How can I help?`);
}
