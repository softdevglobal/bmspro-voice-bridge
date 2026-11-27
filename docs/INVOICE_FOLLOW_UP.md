# Invoice follow-up responses

Deploy the Trade invoice follow-up endpoint before installing this bridge update. Restart the bridge when no call is active:

```bash
cd ~/bmspro-voice-bridge-main
tar -xzf ~/invoice-follow-up-bridge.tar.gz
node --env-file=.env bridge.mjs
```

Outbound overdue-invoice calls expose `get_follow_up_invoice`, `record_invoice_response` and `flag_invoice_wrong_contact`, plus the existing callback, opt-out and hangup controls. Identity and availability are confirmed before the invoice is read. Reports of payment, disputes, hardship, payment-plan requests, promises and requests for help pause the invoice for owner review. An explicitly confirmed wrong-person answer flags the contact without reading debt details, and requires owner correction of the invoice number before resuming. The backend confirms the result; Sophie never records a payment, negotiates terms or claims an unverified pause succeeded.

The authenticated, read-only `/sophie-callback/status?id=...&did=...&businessId=...` endpoint lets Trade recover a lost invoice-call response without submitting another dial. Pending or unavailable results remain uncertain. Status is held in memory for one hour and is lost on restart. The archive therefore includes `trade-sophie-callback.mjs` as well as the invoice module and main server.

Call-frequency limits are unchanged. Production activation and a real test call are separate from the offline validation. No additional environment values are required.
