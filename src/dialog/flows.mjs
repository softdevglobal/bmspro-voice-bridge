// Conversation flows: the ordered steps each agent walks the caller through.
//
// A step is done when one of its `doneBy` tools succeeds in this call.
// The current step is the first step that is not done. An `optional` step has
// no tool of its own to prove it, so it counts as passed once a later step is done.
// `gates` lists the steps that must be done before a write tool may run.
//
// These gates mirror rules the agent sessions and backend already enforce.
// The dialog manager checks them first so the AI gets one clear "what's next"
// answer instead of a backend rejection.

// Results with these statuses did not move the conversation forward.
export const FAILED_STATUSES = Object.freeze(new Set([
  'REJECTED', 'UNAVAILABLE', 'UNKNOWN', 'CONFLICT', 'INVALID_SLOT', 'EXPIRED_SLOT', 'DISABLED',
  'CONFIRMATION_REQUIRED', 'PREPARATION_REQUIRED', 'AVAILABILITY_REQUIRED',
  'STEP_REQUIRED', 'RETRY_LIMIT',
]));

// Tools that save something. Repeated failures of these are capped.
export const WRITE_TOOLS = Object.freeze(new Set([
  'create_booking', 'create_inspection_request', 'register_customer', 'complete_business_onboarding',
]));

const hasSlots = result => Array.isArray(result?.slots) && result.slots.length > 0;

export const FLOWS = Object.freeze({
  // BMS Black workshop receptionist.
  receptionist: {
    steps: [
      {id: 'service', doneBy: ['list_services'], hint: 'Find out which service the caller needs, using list_services.'},
      {id: 'availability', doneBy: ['get_available_slots'], hint: 'Ask for a preferred date and check get_available_slots, then offer the returned times.'},
      {id: 'booking', doneBy: ['create_booking'], hint: 'Collect name, email and phone, read back every detail, get a clear yes, then call create_booking.'},
    ],
    gates: {create_booking: ['availability']},
    success: {
      get_available_slots: hasSlots,
      create_booking: result => result?.status === 'PENDING_REVIEW',
    },
  },

  // BMS Trade inspections and advice requests.
  trade: {
    steps: [
      {id: 'service', doneBy: ['list_services', 'prepare_inspection_request'], optional: true, hint: 'Find out whether the caller wants a listed service (use list_services) or advice, and note the scope of work.'},
      {id: 'address', doneBy: ['prepare_inspection_request'], optional: true, hint: 'Collect the site address: street, suburb, state and four-digit postcode.'},
      {id: 'availability', doneBy: ['get_available_slots'], hint: 'Ask for a preferred date and morning or afternoon, and check get_available_slots for that date now.'},
      {id: 'contact', doneBy: ['find_customer', 'register_customer', 'prepare_inspection_request'], hint: 'Collect full name, mobile and email. A guest booking is fine.'},
      {id: 'readback', doneBy: ['prepare_inspection_request'], hint: 'Call prepare_inspection_request with the collected details, then read the summary back once.'},
      {id: 'submitted', doneBy: ['create_inspection_request'], hint: 'After the caller agrees, call create_inspection_request with customerConfirmed=true.'},
    ],
    gates: {
      prepare_inspection_request: ['availability'],
      create_inspection_request: ['readback'],
    },
    success: {
      prepare_inspection_request: result => result?.status === 'READY_FOR_CONFIRMATION',
      create_inspection_request: result => ['PENDING_REVIEW', 'CONFIRMED'].includes(result?.status),
      register_customer: result => ['CREATED', 'EXISTS'].includes(result?.status),
      find_customer: result => ['MATCHED', 'NOT_FOUND'].includes(result?.status),
    },
  },

  // BMS Pink salon receptionist.
  pink: {
    steps: [
      {id: 'service', doneBy: ['list_services'], hint: 'Find out which service the caller wants, using list_services.'},
      {id: 'availability', doneBy: ['get_available_slots'], hint: 'Ask for a preferred date and check get_available_slots for that one service.'},
      {id: 'booking', doneBy: ['create_booking'], hint: 'Collect the caller details, read back every detail, get a clear yes, then call create_booking.'},
    ],
    gates: {create_booking: ['service', 'availability']},
    success: {get_available_slots: hasSlots},
  },

  // New business sign-up. The backend draft drives the form; this tracks progress only.
  onboarding: {
    steps: [
      {id: 'details', doneBy: ['save_onboarding_draft'], hint: 'Save each answer with save_onboarding_draft before asking the next question.'},
      {id: 'complete', doneBy: ['complete_business_onboarding'], hint: 'Check get_onboarding_status, read back the setup, get consent, then call complete_business_onboarding.'},
    ],
    gates: {complete_business_onboarding: ['details']},
    success: {},
  },
});
