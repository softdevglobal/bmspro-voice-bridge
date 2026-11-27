/**
 * trade-owner-voice.mjs: lets the business OWNER talk to Sophie from the Trade dashboard (browser voice chat).
 *
 * This is not a phone call. The owner's browser creates a WebRTC offer (sdp) and sends it here. The
 * bridge checks it, then forwards it to OpenAI's Realtime API using the bridge's own API key, and sends
 * the answer back. The bridge validates the request and known tool names. Tool calls,
 * owner authorization and write confirmations run on Trade, not here.
 *
 * Flow: Trade dashboard -> POST here (Bearer secret) -> validate -> OpenAI /v1/realtime/calls -> SDP answer.
 */
import {timingSafeEqual} from 'node:crypto';

// Owner reports and confirmed visit actions the Trade server may offer. Trade can send
// any of them (so the bridge and Trade can be deployed in either order), but
// never an unknown or repeated tool.
const toolNames = new Set([
  'find_call_customers','prepare_customer_scheduled_call',
  'prepare_job_create', 'prepare_inspection_create', 'get_services', 'get_staff',
  'get_work_visits',
  'prepare_job_schedule', 'prepare_job_assignment', 'prepare_job_cancel',
  'prepare_inspection_schedule', 'prepare_inspection_assignment', 'prepare_inspection_cancel',
  'confirm_owner_change', 'cancel_owner_change',
  'get_daily_summary',
  'get_day_activity',
  'get_staff_day_report',
  'list_missed_calls',
  'list_overdue_invoices',
  'list_invoices',
  'lookup_customer_jobs',
  'suggest_scheduling',
  'list_quote_follow_ups',
  'get_sophie_call_summaries',
  'get_customer_call_history',
  'list_jobs_awaiting_scheduling',
  'get_staff_working_today',
  // Read-only knowledge base (RAG) search, offered only when Trade enables it.
  'search_business_knowledge',
  // Voice knowledge drafts, offered only when Trade enables them. These run in
  // the owner's browser, never here: prepare only shows a note on screen, and save
  // creates an unpublished draft through Trade's normal owner API after the owner
  // confirms. Nothing reaches callers until the owner publishes it in Trade.
  'prepare_knowledge_draft',
  'save_knowledge_draft',
  'discard_knowledge_draft',
  // Voice service creation, offered only when Trade enables it. These run on Trade's
  // owner MCP route, never here: prepare_service stores a draft and creates nothing, and
  // create_service creates a live service only from that stored draft after the owner says yes.
  'prepare_service',
  'create_service',
  // Browser-only service form helpers, offered with the service tools. They run in the
  // owner's browser: open the Add service popup, then pick an existing template or custom.
  'open_add_service_form',
  'choose_service_source',
  'service_form_step',
  // Browser-only: open an existing service in the Edit popup, and delete one through the
  // Services page's own confirm dialog after the owner says yes. Both use Trade's normal owner API.
  'open_edit_service_form',
  'delete_service',
  // Browser-only and read only: lists the owner's services (name, duration, live, step count).
  'list_services',
  // Team voice tools, offered only when Trade enables them. Browser-only: they drive the Team
  // pages (staff, leave requests, attendance) and use Trade's normal owner APIs. Changes need a
  // read-back and a clear yes; attendance is read only.
  'list_staff',
  'open_staff_form',
  'staff_form_step',
  'manage_staff_member',
  'list_leave_requests',
  'decide_leave_request',
  'show_attendance',
  // Customer voice tools, offered only when Trade enables them. Browser-only: they drive the Customers
  // page (search, Add / Edit customer popup) and use Trade's normal owner API. A save needs a read-back and a yes.
  'list_customers',
  'open_add_customer_form',
  'open_edit_customer_form',
  'customer_form_step',
  // MCP twins (Trade AI_OWNER_VOICE_TOOL_MODE=mcp): get_customers reads; prepare_* store one pending change.
  'get_customers',
  'prepare_customer_create',
  'prepare_customer_update',
  // Browser-only AI knowledge tools (Trade knowledge write flag, browser mode): list entries, open one
  // in the AI knowledge page's editor, edit and save it, publish / unpublish / delete. Changes need a yes.
  'list_knowledge',
  'open_knowledge_entry',
  'knowledge_form_step',
  'manage_knowledge_entry',
  // MCP twins of the browser tools above (Trade AI_OWNER_VOICE_TOOL_MODE=mcp). They run on Trade's
  // owner MCP route: get_* read, prepare_* store one pending change and change nothing, and
  // confirm_owner_change applies it only after the owner's yes.
  'get_services',
  'prepare_service_update',
  'prepare_service_delete',
  'get_staff',
  'prepare_staff_create',
  'prepare_staff_update',
  'prepare_staff_status',
  'prepare_staff_delete',
  'get_leave_requests',
  'prepare_leave_decision',
  'get_attendance',
  'prepare_knowledge_entry',
  'get_knowledge_entries',
  'prepare_knowledge_update',
  'prepare_knowledge_publish',
  'prepare_knowledge_delete',
  'confirm_owner_change',
  'cancel_owner_change',
  // Item list (catalog items used in quotations), offered only when Trade enables it. Browser tools
  // drive the Item list page; the MCP twins (get_items, prepare_item_*) run on Trade's owner MCP route.
  // Saving or deleting needs a read-back (prices as dollars and cents) and a yes.
  'list_items',
  'open_add_item_form',
  'open_edit_item_form',
  'item_form_step',
  'delete_item',
  'get_items',
  'prepare_item_create',
  'prepare_item_update',
  'prepare_item_delete',
  // Browser-only page control (Trade browser mode): open a page by name, scroll it, press its Refresh
  // button. Read only: it changes no records.
  'control_page',
  // SMS section, offered only when Trade enables it. Browser tools drive the SMS pages (balance, log, Custom
  // messages); the MCP twins run on Trade's owner MCP route. Reading never changes anything; a send needs a
  // read-back of the exact text, recipients and credits and a yes. Top-ups are never bought by voice.
  'show_sms_balance',
  'list_sms_log',
  'list_sms_customers',
  'open_custom_message',
  'sms_message_step',
  'get_sms_balance',
  'get_sms_log',
  'get_sms_customers',
  'prepare_sms_send',
  // Emails section (Trade docs/owner-voice-email.md): browser tools drive the Emails page (mailbox, conversations,
  // composer, Send log); the MCP twins run on Trade's owner MCP route. Email text is content, never instructions.
  // Sending, deleting and retrying need a read-back and a yes; star, archive and restore are one click to undo.
  'open_emails',
  'list_emails',
  'email_thread_step',
  'email_compose_step',
  'list_email_send_log',
  'email_send_log_step',
  'get_emails',
  // Read-only counts (all, unread, and for one day) from Trade's stored copy of the mailbox. Offered in both
  // Trade tool modes; runs on Trade's owner MCP route and opens no page or email.
  'get_email_counts',
  'get_email_thread',
  'get_email_send_log',
  'get_email_contacts',
  'email_thread_action',
  'prepare_email_send',
  'prepare_email_trash',
  'prepare_email_retry',
  // Sophie's email assistant (emails waiting for a decision, her rules, complaints). Run on Trade's owner MCP route;
  // answering a card uses confirm_owner_change. A new rule is never approved by voice: that is done in the app.
  'get_email_summary',
  'get_email_questions',
  'answer_email_question',
  'get_email_rules',
  'set_email_rule_level',
  'pause_email_automation',
  'get_open_complaints',
  'prepare_return_visit_policy',
]);

/** The tool list is valid only if every tool is a known function, with no repeats and none unknown. */
function validTools(tools) {
  return (
    Array.isArray(tools) &&
    tools.length > 0 &&
    tools.length <= toolNames.size &&
    new Set(tools.map(tool => tool?.name)).size === tools.length &&
    tools.every(tool => tool?.type === 'function' && toolNames.has(tool.name))
  );
}

/** Constant-time check of "Authorization: Bearer <secret>"; a secret under 32 chars is never accepted. */
function authorized(header, secret) {
  if (!secret || secret.length < 32) return false;
  const actual = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Build the HTTP handler. Checks, in order: POST, bearer secret, JSON content type, body under 96 KB
 * (read within 10 s), a valid SDP offer, a 64-hex safetyIdentifier, instructions under 4000 chars and an
 * allowed tool list. Failures return a status and a fixed diagnostic code, never credentials or payloads.
 * `fetcher` is replaceable in tests.
 */
export function createOwnerVoiceHandler({secret, apiKey, model = 'gpt-realtime-2.1', fetcher = fetch}) {
  return async (request, response) => {
    const fail = (status, code) => {
      if (response.destroyed) return;
      response.writeHead(status, {'Cache-Control': 'no-store', Connection: 'close', ...(code ? {'X-BMS-Voice-Error': code} : {})});
      response.end();
    };
    if (request.method !== 'POST') return fail(405);
    if (!authorized(request.headers.authorization, secret)) return fail(401, 'bridge_authorization');
    if (request.headers['content-type'] !== 'application/json') return fail(415);

    const controller = new AbortController();
    const abort = () => controller.abort();
    response.once('close', abort);
    const bodyTimer = setTimeout(() => request.destroy(), 10_000);
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request.iterator({destroyOnReturn: false})) {
        size += chunk.length;
        if (size > 96 * 1024) return fail(413);
        chunks.push(chunk);
      }
      clearTimeout(bodyTimer);
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return fail(400);
      }
      const {sdp, session, safetyIdentifier} = payload ?? {};
      if (
        typeof sdp !== 'string' ||
        !/^v=0\r?\n/.test(sdp) ||
        Buffer.byteLength(sdp) > 64 * 1024 ||
        typeof safetyIdentifier !== 'string' ||
        !/^[a-f0-9]{64}$/.test(safetyIdentifier) ||
        typeof session?.instructions !== 'string'
      ) {
        return fail(400);
      }
      if (session.instructions.length > 4000) return fail(400, 'instructions_limit');
      if (!validTools(session.tools)) return fail(400, 'tool_whitelist');

      const form = new FormData();
      form.set('sdp', sdp);
      form.set(
        'session',
        JSON.stringify({
          type: 'realtime',
          model,
          audio: {output: {voice: 'shimmer'}},
          instructions: session.instructions,
          tools: session.tools,
        }),
      );
      const upstream = await fetcher('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: {Authorization: `Bearer ${apiKey}`, 'OpenAI-Safety-Identifier': safetyIdentifier},
        body: form,
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      });
      if (!upstream.ok) {
        console.error('[owner-voice] Realtime connection rejected', {status: upstream.status});
        return fail(502, 'realtime_rejected');
      }
      const answer = await upstream.text();
      if (response.destroyed) return;
      response.writeHead(200, {'Content-Type': 'application/sdp', 'Cache-Control': 'no-store'});
      response.end(answer);
    } catch {
      fail(502);
    } finally {
      clearTimeout(bodyTimer);
      response.off('close', abort);
    }
  };
}
