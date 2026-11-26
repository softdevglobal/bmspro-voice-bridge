# Sophie quotation follow-up

## Behaviour

Create or edit a quotation, open the Send tab, and select **Enable Sophie follow-up** before saving/sending. The preference is saved on the quotation and restored when editing it. Drafts do not call anyone. After the existing send operation completes with a generated PDF, the opted-in quotation is queued for 48 hours later. This uses the application's existing best-effort email/SMS send action; it is not proof of delivery to the recipient. Saving edits invalidates the old follow-up revision; save and send the updated quote to start a new 48-hour period. Old quotations are not backfilled.

The existing local callback poller and authenticated Sophie cron run the new worker. Each batch loads up to six due quotes using an indexed query. Calls respect business timezone/calling hours, customer Sophie do-not-call settings, tenant/module availability, a single configured outbound DID, bridge capacity and the existing per-customer calling lease. Reception DIDs cannot be customer destinations. There is one automatic attempt per sent revision; no-answer, failed and unknown results do not automatically redial. A definite busy response defers one minute. Already decided, converted, cancelled, expired, edited or disabled quotes are skipped. Quotes whose validity expires before the follow-up cannot be offered for acceptance.

Sophie asks for the intended customer and a good time before reading quote details. Wrong person/voicemail gets no details. She can read the saved service, line items, total AUD, taxes, deposit, validity, notes and terms; these are untrusted reference data, not instructions. The model cannot select a different quote, customer or business. Questions, silence, hesitation, conditional agreement and requests for more time do not accept/reject a quote. Acceptance requires a readback of reference, service and full total followed by an explicit confirmation. Rejection requires an explicit readback/confirmation too. A verified detail lookup must precede a decision.

The backend rechecks the current tenant/DID, customer phone, global flags, opt-out, sent revision, commercial fingerprint, validity, recent call attempt and request mirror. It atomically writes the existing `customerDecision: accepted|rejected` fields on both quotation and request, decision source/call ID, and one deterministic owner portal notification. Conflicting or existing portal decisions are not overwritten. The owner receives the normal quotation accepted/rejected notification in Trade and a mobile push when configured; this does not place another owner phone call.

Acceptance then runs the existing accepted-quotation invoice-draft automation, with a leased/retryable post-decision task. It never means a booked job, sent invoice or paid invoice. Rejection does not draft an invoice. Side-effect failures retry up to three times, then remain `REVIEW` for staff; the saved decision and portal notification remain durable. Push delivery itself uses the existing best-effort push implementation. Conversation history links to the existing AI call log rather than duplicating a transcript. Finalization prevents further detail/decision access, and live lookup authorization also expires 15 minutes after the dial attempt. Caller statements about payment are not verified payments.

The feature is off by default at platform level. No production flags were enabled and no real calls were placed during implementation.

## Deployment

1. Deploy the updated Trade app and bridge before enabling the flag. Keep current callback/shared-secret, DID mapping, Deepgram and calling-hour settings.
2. Deploy the new `quotations(sophieFollowUpStatus, sophieFollowUpDueAt)` index and the rules protecting `ai_quotation_followup_calls`:

   `firebase deploy --only firestore:indexes,firestore:rules --project bmspro-trade`

3. Set `AI_SOPHIE_QUOTATION_CALLS_ENABLED=true` in Trade's backend environment. Existing `AI_SOPHIE_CALLBACK_ENABLED=true` and voice call logs must be enabled. Do not put this variable or credentials in NEXT_PUBLIC variables.
4. Restart/deploy Trade. For local automatic processing, retain `SOPHIE_CALLBACK_DEV_POLL=true`; production uses the existing `/api/cron/sophie-callbacks` schedule. No new cron or PBX dialplan is needed.
5. Use the cumulative `deepgram-main-bridge.tar.gz` archive and existing three-env bridge launch. The bridge adds `/sophie-quotation-call`; existing customer and owner routes remain intact.

## Validation

- Automated tests mock Firestore, dialing, invoice drafting and notifications. They cover 48-hour timing, opt-in, hours/opt-out, busy retry, duplicate prevention, price changes, portal decisions, cross-tenant/wrong-number attempts, customer confirmation gates, acceptance, rejection and one invoice draft.
- For a live test, use a dedicated customer contact you control, enable the preference, and send one quotation. It becomes due after 48 hours, with the first dial during permitted hours. Do not change real customer timestamps to accelerate tests; use the offline fixture suite/emulator for clock scenarios.
- Test accept, reject and undecided responses on separate test quotations. Check Customer accepted/rejected on Quotations, the owner's notification, and Calls → AI calls for the linked conversation. Verify no customer call is made for a disabled/expired/decided quote and no private owner tools are offered during this customer call.
- Inspect `[sophie-quotation-calls]` worker logs for errors. Attempts are Admin-SDK-only in `ai_quotation_followup_calls`; the quote stores the preference, due time, revision and processing state.

## Telephone explanation and audio buffering

After confirming the intended recipient can speak, Sophie first establishes whether they remember requesting a quote from the business. She must not imply a job was already completed. She explains the saved service in plain language, asks whether they have seen the quotation, and offers to explain it if not. Main inclusions, total and further details are discussed in short turns with one question at a time, rather than reading the reference, items and terms in a monologue. The reference is used when requested or during the exact decision readback. Existing explicit acceptance/rejection confirmation gates remain in place.

Deepgram can generate audio faster than telephone playback. The main bridge now allows a bounded 60-second PCMU output buffer for Deepgram instead of applying the GPT Live ten-second limit. This does not delay playback or change its rate. A separate ten-second no-drain watchdog, existing media socket backpressure guard and paced audio clock still detect stalled playback; caller interruptions immediately clear queued speech. GPT Live keeps its original ten-second size bound. No new environment variable or PBX configuration is needed.
