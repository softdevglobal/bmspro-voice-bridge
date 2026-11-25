# Owner calls for new inspection requests

Implemented locally behind an off-by-default platform flag and explicit owner consent. This is a distinct recipient type from owner-requested CUSTOMER calls. It does not enable daily-summary, invoice or missed-call owner alerts.

## Behaviour

Business Settings → Sophie → Voice permissions → Calls to the owner lets the current business owner save a personal/direct contact number, choose a mapped outbound business DID and opt into automatic new-inspection notifications. A manual Queue owner call action accepts an exact inspection reference and requires an explicit confirmation checkbox showing the saved phone ending. Unsaved contact changes prevent manual calls. The manual action queues intent; it does not promise an immediate ring.

New inspection creation queues one deterministic notification per request. Customer portal, call-centre and normal owner inspection requests are included. Direct job, quotation and invoice placeholders are excluded. Historical requests are not backfilled. Notification enqueue failure is logged without undoing an already saved inspection; the owner can use the manual action for that request. Existing customer/business notifications continue independently.

Calls use the existing scheduled callback worker, batch size six, business calling hours/timezone and bridge capacity controls. Owner notifications are spaced at least five minutes apart per business. Alerts expire after 24 hours; no-answer, failed and unknown results are not automatically redialled. Only the existing explicit bridge-busy response defers a dial. Disabling consent, changing owner/number/DID/settings version, cancelling/completing the inspection or disabling the platform cancels/prevents the pending call. Customer do-not-call preferences remain separate from owner notification consent.

Pending rows use OWNER_SCHEDULED in ai_scheduled_callbacks. This isolates new owner calls from older customer-only workers during rolling deployment. New workers read the extra due-state query only when the owner-notification platform flag is on, then share the same six-call batch. Existing status/scheduledAt indexes cover both states. The dashboard displays it as Scheduled. Already-claimed calls cannot be recalled through Cancel.

Sophie identifies herself and asks for the named owner. Until confirmation, no business activity is mentioned. Wrong-person/voicemail calls end without details. After confirmation she announces the new inspection and reference. At the owner's explicit configuration choice, the saved destination number authorizes a read-only lookup of that one inspection through get_notified_inspection; no additional OTP/dashboard approval is required. This is number-based access, not proof of the speaker's identity: anyone answering that saved phone could hear the details.

The lookup rechecks the tenant, DID, current owner and saved contact/consent/settings version, recent call attempt, expiry and actionable inspection. Only CALLING/ANSWERED attempts less than 15 minutes old without a finalized linked call log are eligible. The model cannot select another inspection, phone or business. Returned fields are service/scope, customer name, site address, preferred and scheduled times, status and customer notes. Customer phone/email, internal notes, images, financial information and other records are excluded. Request text is untrusted data. The call cannot approve, schedule, cancel, take payment or change settings. These details may appear in the existing owner call transcript under its normal retention policy.

Owner calls use a personal greeting (for example, "Hi Niranga, it's Sophie. Is now a good time for a quick update?"). They do not introduce Sophie as the AI receptionist or repeat the business name. Sophie answers honestly if asked whether she is AI. After the inspection update she asks whether the owner wants more details or anything else checked, listens, and ends only when the owner is done, unavailable or asks to end.

The dedicated /api/ai/callbacks/owner-briefing endpoint provides an explicit allowlist of 13 existing owner read tools for call histories/summaries, missed calls, invoices/overdues, quotes, jobs/customer job history, schedules, staff and activity reports. Tool listing and every invocation recheck the same saved owner destination, consent, current owner, business/DID and recent notification attempt. Arguments use strict schemas; business IDs and record scope cannot be injected. list_missed_calls rejects followUp, so it cannot start or prepare callbacks. No creation, changes, messages, payment or callback action tools are exposed. Tools are built from the same briefing registry used by signed-in Talk to Sophie, but a logged-in owner token is never minted or forwarded for the phone call. Customer calls do not receive these tools. If briefing setup fails, Sophie can still deliver the notification and use the linked-inspection lookup, but must explain that other business lookups are unavailable.

Results appear under Calls → Scheduled calls as Owner notification · New inspection. The normal conversation log is linked after hangup, with owner recipient metadata. Log retention uses the existing call-log policy, not a second transcript copy. Owner answers are reviewable; phone answered does not prove identity. Manual call IDs are idempotent so retrying a lost HTTP response does not enqueue another call.

## Deployment

1. Deploy the updated Trade app/worker and firestore.rules. The new ai_owner_call_settings collection is Admin SDK only; actual-owner authenticated routes manage it. Keep the platform flag off while deploying.
2. Upload the latest deepgram-main-bridge.tar.gz to the existing server and extract in ~/bmspro-voice-bridge-main. It now also includes src/agents/trade/trade-owner-notification.mjs and the updated trade-sophie-callback.mjs. Restart the bridge while idle using the existing base/direct-Trade/Deepgram env command. No new bridge env or Asterisk/Yeastar route is needed.
3. Enable on the Trade SERVER/worker environment:

       AI_SOPHIE_OWNER_NOTIFICATIONS_ENABLED=true
       AI_SOPHIE_CALLBACK_ENABLED=true

   Call logging must remain enabled (AI_VOICE_CALL_LOGS_ENABLED must not be false). Existing bridge callback AMI credentials, callback DID mapping and caller ID must already work. Do not use the receptionist DID as the owner contact.
4. Restart/deploy the worker with these values. Local testing requires the existing SOPHIE_CALLBACK_DEV_POLL=true; production uses the existing cron route. No additional cron is added. Server-to-bridge reachability still needs a valid bridge URL/tunnel for that environment.
5. Sign in as the actual business owner, open Settings → Business → Sophie voice permissions, save the personal number/DID/consent and new-inspection checkbox. Default is off for every business.

## Test before production enablement

- Use an owner-controlled test number. First save permission with automatic alerts off. Copy a pending inspection reference, confirm and queue a manual owner call during configured calling hours.
- Check Scheduled calls for queue/dial/result; listen for correct business and intended owner. Test wrong-person and busy responses. Confirm private customer information is never disclosed and no inspection mutation is claimed.
- Enable the new-inspection checkbox and create ONE authorized test inspection. Confirm exactly one notification. Do not recreate the same inspection to recover a notification error; use the manual action.
- Create two test inspections close together and verify the five-minute spacing. Disable consent while another is pending and verify cancellation. Check cancelled/completed requests are skipped.
- Test two tenants with their separate owner contact/DID settings. Check that the other tenant's reference cannot be used in a manual call.
- Verify the normal missed-call, customer scheduled-call and invoice callback flows remain operational.

Offline tests use mocked Firestore and dialing; no real phone calls are placed. Live phone, voice quality and actual deployment have not been validated by the local implementation.
