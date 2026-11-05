// Dialog manager: per-call conversation state for a voice agent.
//
// One instance per call. bridge.mjs uses it around every tool call:
//   1. check(name)              before the tool runs: blocks a write whose earlier steps are not done
//   2. record(name, result)     after the tool runs: updates progress
//   3. annotate(result)         adds `dialogState` (current step + next hint) to what the AI sees
//
// Modes (BMSPRO_DIALOG_MANAGER):
//   on       (default) track, gate writes and add hints
//   observe  track and log only; never blocks or changes tool results
//   off      not created at all
import {FLOWS, FAILED_STATUSES, WRITE_TOOLS} from './flows.mjs';

export const DIALOG_MODES = Object.freeze(['on', 'observe', 'off']);
const MAX_WRITE_FAILURES = 3; // failed write attempts in a row, with no other progress in between

export function dialogModeFromEnv(env = process.env) {
  const value = String(env.BMSPRO_DIALOG_MANAGER || 'on').trim().toLowerCase();
  if (!DIALOG_MODES.includes(value)) throw new Error('BMSPRO_DIALOG_MANAGER must be on, observe or off.');
  return value;
}

/** True when a tool result moved the conversation forward. */
export function succeeded(flow, name, result) {
  if (!result || typeof result !== 'object') return false;
  if (!Array.isArray(result) && FAILED_STATUSES.has(result.status)) return false;
  const check = flow?.success?.[name];
  return check ? check(result) === true : true;
}

export function createDialogManager({mode, enforce = true, log = () => {}} = {}) {
  const flow = FLOWS[mode] ?? null;
  const succeededTools = new Set();
  const writeFailures = new Map();
  let toolCalls = 0;

  const isDone = step => step.doneBy.some(name => succeededTools.has(name));
  const status = () => {
    if (!flow) return {current: null, completed: []};
    const steps = flow.steps;
    const done = steps.map(isDone);
    // Optional steps count as passed once any later step is done.
    const passed = done.map((value, index) => value || (steps[index].optional === true && done.slice(index + 1).some(Boolean)));
    const currentIndex = passed.indexOf(false);
    return {
      current: currentIndex === -1 ? null : steps[currentIndex],
      completed: steps.filter((_, index) => passed[index]).map(step => step.id),
    };
  };

  const manager = {
    mode, enforce, flow,

    /** Current progress. `step` is null when every step is done. */
    snapshot() {
      const {current, completed} = status();
      return {step: current?.id ?? (flow ? 'done' : null), completed, next: current?.hint ?? null, toolCalls};
    },

    /** Returns a blocking result, or null when the tool may run. */
    check(name) {
      if (!flow) return null;
      const missing = (flow.gates[name] || []).filter(id => !status().completed.includes(id));
      let blocked = null;
      if (missing.length) {
        const hint = flow.steps.find(step => step.id === missing[0])?.hint || '';
        blocked = {status: 'STEP_REQUIRED', code: 'DIALOG_STEP_REQUIRED', missingSteps: missing,
          message: `Not yet. Finish this step first: ${hint} No action was performed.`};
      } else if (WRITE_TOOLS.has(name) && (writeFailures.get(name) || 0) >= MAX_WRITE_FAILURES) {
        blocked = {status: 'RETRY_LIMIT', code: 'DIALOG_RETRY_LIMIT',
          message: 'This action failed several times. Stop retrying. Tell the caller it could not be completed on this call and do not claim it was saved.'};
      }
      if (blocked) log(`Dialog: ${enforce ? 'blocked' : 'would block'} ${name} code=${blocked.code}${missing.length ? ` missing=${missing.join(',')}` : ''}`);
      return enforce ? blocked : null;
    },

    /** Update progress from a finished tool call. */
    record(name, result) {
      if (!flow) return;
      toolCalls++;
      const before = manager.snapshot().step;
      if (succeeded(flow, name, result)) {
        succeededTools.add(name);
        writeFailures.clear(); // any progress resets the retry counter
      } else if (WRITE_TOOLS.has(name)) {
        writeFailures.set(name, (writeFailures.get(name) || 0) + 1);
      }
      const after = manager.snapshot().step;
      if (after !== before) log(`Dialog: step ${before} -> ${after}`);
    },

    /** Add the current step and next hint to a tool result the AI will read. */
    annotate(result) {
      if (!flow || !enforce || !result || typeof result !== 'object' || Array.isArray(result)) return result;
      const {step, completed, next} = manager.snapshot();
      return {...result, dialogState: {step, completed, next}};
    },
  };
  return manager;
}

/** Extra instruction so the AI knows what `dialogState` means. */
export const DIALOG_INSTRUCTIONS = 'Some tool results include dialogState: the current conversation step, the completed steps and a hint for what to do next. Use it to keep the call on track, but always answer the caller\'s actual question first. A STEP_REQUIRED result means no action was performed; do the missing step, do not retry the same call unchanged.';
