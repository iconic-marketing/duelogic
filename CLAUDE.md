@AGENTS.md

# DueLogic Project Memory

**All monetary amounts are stored, calculated and sent to Pinch in cents. Convert to dollars only at the display boundary.**

## Pinch sandbox records

### Primary merchant test

- Merchant context: Iconic Marketing primary merchant
- Scoping: no `Current-Merchant` header was used for this original test
- Payer ID: `pyr_Dfl83zFyWsE3do`
- Source ID: `src_z1VdcmLSGNGVRR`
- Payment ID: `pmt_MvQiyVkg2EYWdg`
- Payment date changed through the API from `2026-07-31` to `2026-08-03`
- Final outcome: `approved`

### Managed merchant test

- Managed merchant ID: `mch_gsz9TbadIKto3N`
- Payer ID: `pyr_NEoNZK9KQTssSk`
- Source ID: `src_Ak2GaZAGuRs51k`
- Payment ID: `pmt_qgEZPSq3lzPoGz`
- Payment date changed through the API from `2026-07-31` to `2026-08-03`
- Final outcome: `approved`

These are sandbox records. Reuse them when inspecting the proven integration. Do not recreate them without a specific reason.

## Pinch API conventions

- From this point, all tenant-scoped Pinch API calls must operate under the managed merchant and pass `merchantId` to `pinchRequest`, producing:
  `Current-Merchant: mch_gsz9TbadIKto3N`
- Exceptions are OAuth token exchange, incoming webhook handling and an explicitly documented parent-merchant administrative call.
- Never put `merchantId` or `Current-Merchant` inside a Pinch JSON request body.
- Keep `pinch-version: 2020.1` on every Pinch API request.
- Scheduled-payment creation and other execution calls must use a nonce for replay protection.
- Never automatically retry an ambiguous successful mutation. The existing retry after an explicit HTTP 401 is permitted.

## Scheduled-payment update contract

- Read the payment first with:
  `GET /payments/{paymentId}`
- The payer ID on the read response is nested under:
  `payer.id`
- Update an existing scheduled payment with:
  `POST /payments`
- The update body contains:
  - `id`
  - `payerId`
  - `amount`
  - `transactionDate`
  - existing `description`, when present
- Preserve the payer, amount, description and other required existing values.
- Change only the approved field.
- Read the payment back after mutation and verify the new value before returning success.

## Nonce replay contract

- Reusing a Pinch payment nonce on `POST /payments` returns HTTP 403 with `isNonceReplay: true` and the existing payment under `data`; `data.id` carries the original `pmt_` payment ID.
- Treat a verified nonce replay as an idempotent success only after the normal `GET /payments/{paymentId}` read-back verification passes.
- Never repeat `POST /payments` after a nonce replay or an ambiguous mutation response.
- Pinch error bodies can contain tokenised payment-source data and payer personally identifiable information. Never log or return complete upstream bodies; log only route or operation, stage, error class, upstream HTTP status and safe identifiers.
- The payment read response may expose source identity at `attempts[].source.id` (proven live), as well as possibly `sourceId` or `source.id`. Do not probe other shapes.

## Calculated-payments contract

- `GET /plans/{planId}/calculated-payments` returns a bare JSON array.
- Each calculated payment carries `amountInCents` (integer cents), `paymentDate` (zoned ISO timestamp), `description` and `recurringPaymentIndex`.
- `recurringPaymentIndex` identifies the sequence order of the calculated payments.
- Pinch may return merchant-local midnight as a UTC timestamp dated the preceding UTC day (e.g. Sydney midnight appears as `T14:00:00Z` on the previous calendar date).
- Convert `paymentDate` to a calendar date with a timezone-aware formatter in the merchant timezone. Never slice the UTC timestamp or rely on the server timezone.
- The managed sandbox merchant timezone is `Australia/Sydney`.
- Production code must use `Merchant.timezone`, never a hard-coded constant or the server's own timezone.

## Subscription replacement rules

- Permanent schedule correction follows preview, explicit confirmation, cancellation, then replacement.
- A customer free-text request alone is insufficient authority to cancel a subscription. The customer must confirm the actual future dates and amounts.
- Pinch subscription replacement is not atomic: `DELETE /subscriptions/{id}` and `POST /subscriptions` are separate mutations.
- Never retry cancellation or creation after an ambiguous mutation response.
- A failure after verified cancellation requires manual recovery; report it, never guess or retry.
- A repeat call using the cancelled subscription ID must fail in preflight and must not create another replacement.
- A production implementation requires durable operation state before executing a replacement.
- The hackathon replacement route is localhost-only proof code, not a production transaction coordinator.

## Subscription replacement audit and recovery

- Permanent subscription changes use a destructive cancel-then-create sequence; the replacement operation record is mandatory execution state, not optional logging.
- A recovery snapshot — merchant-scoped IDs, the original start date, the exact reinstatement `POST /subscriptions` payload and the original first-three calculated-payment summary — must be written to the operation store and read back successfully before the original subscription is cancelled.
- A failed recovery-record write or read-back aborts the operation before any mutation: no DELETE, no POST, original subscription untouched.
- A successful replacement retains a permanent old-to-new subscription ID mapping: verified start date, plan, payer, source where exposed, and the first three verified payment dates and amounts.
- Any failure after cancellation sets status `manual-recovery-required` with the exact failure stage (`cancel-verification-failed`, `replacement-create-failed`, `replacement-ambiguous`, `replacement-verification-failed`).
- Ambiguous create or verification results are never retried automatically; a created-but-unverified replacement may be active, so no claim is made that the payer has no subscription.
- Recovery records hold IDs, dates and integer cents only — never credentials, tokens, card, bank or customer identity data; the store write rejects records carrying forbidden keys.
- The operation store (`src/lib/pinch/dev-replacement-operation-store.ts`, behind `SubscriptionReplacementOperationRepository`) is process-local, non-durable sandbox memory: it survives hot reloads only and must never be described as durable. Durable storage replaces the repository implementation, not the flow or route contracts.
- The mutation sequence runs in `src/lib/pinch/replacement-operation-flow.ts` with injected storage, effects and clock; its deterministic validation (`src/lib/pinch/replacement-operation-validation.ts`) never calls Pinch and is re-asserted by `GET /api/pinch/dev/replacement-operations?operationId=...`, the localhost-only lookup that returns the safe projection only.
- Automated recovery or reinstatement is outside the MVP: the snapshot enables a human or a future recovery command; nothing executes it automatically.

## Customer schedule confirmation

- A permanent schedule replacement requires a separate, server-recorded customer confirmation; the merchant UI acknowledgement checkbox is an operator safeguard, never customer consent.
- The confirmation record (`src/lib/pinch/customer-confirmation.ts`, service in `customer-confirmation-service.ts`) is bound to the exact merchant, payer, source, subscription, plan, proposed start date and the exact three payment dates and integer-cent amounts from the live Pinch preview; any mismatch refuses execution.
- The live Pinch preflight remains authoritative for schedule content — the confirmation proves consent only and never replaces Pinch-side validation.
- Confirmation links are time limited (30 minutes in development) and single use; expiry is evaluated server-side and client time is never authoritative.
- Raw confirmation tokens (256-bit, Node crypto) are returned exactly once inside the customer URL at creation; only a SHA-256 hash is stored, and the raw token is never logged, never exposed by merchant lookup and never placed in the replacement audit record.
- The customer responds through `/confirm/[token]` (localhost-only dev page) with explicit accept or decline; pending → accepted/declined, contradictory repeats are rejected, identical repeats are idempotent, expired and consumed records accept no response.
- The replacement route requires an accepted, unexpired, unused confirmation and independently re-verifies every binding before any Pinch call; the confirmation is consumed (with operationId and consumedAt, verified by read-back) after all read-only preflight checks and before recovery-record persistence.
- Any confirmation failure — pending, declined, expired, consumed, mismatched, store or consumption failure — aborts before any Pinch mutation and is never a manual-recovery state; manual-recovery-required remains reserved for failures after cancellation.
- The replacement operation record and its safe projection carry `confirmationId` only — never token material or the confirmation record itself.
- The confirmation store (`src/lib/pinch/dev-customer-confirmation-store.ts`, behind `CustomerConfirmationRepository`) is process-local, non-durable sandbox memory; the deterministic suite lives in `customer-confirmation-validation.ts` and is re-asserted by the dev confirmation routes and the dashboard render.
- Email/SMS link delivery and durable confirmation persistence are polish-week work, outside the Build Weekend scope.

## Customer-led intervention flow

- Permanent recurring schedule correction remains central to the MVP: the merchant configures the flexibility policy once and it is applied automatically; ordinary approved requests require no case-by-case merchant approval.
- Intervention invitations are generated automatically by the scheduled scan (dev trigger `POST /api/duelogic/dev/interventions/scan`, localhost-only): the scan resolves the active saved merchant policy snapshot once (an inconsistent or missing snapshot fails safely and creates no invitation — never a silent frozen-default fallback), detector evidence designates the opportunity, the policy result and the amount-ceiling suitability check both use that active snapshot, and the created intervention stores its `policyVersion` — bound at creation, authoritative for the invitation's whole life. The current active subscription is resolved read-only at runtime (`src/lib/duelogic/subscription-resolver.ts`) — never a hardcoded subscription ID, and an ambiguous or unreadable resolution is a development fixture error that creates no invitation.
- The customer selects the date on the tokenised page `/review/[token]`; the deterministic policy engine evaluates it under the intervention-bound snapshot resolved with `readByVersion(record.merchantId, record.policyVersion)` — never the currently active policy and never a frozen-default fallback; an unresolvable bound version refuses safely (`policy-unresolved`) with no Pinch preview. A later policy activation never alters a pending invitation; new invitations bind the version active at their creation. Pinch calculates the authoritative schedule — preview dates are never generated or substituted locally, and exactly three current and three proposed Pinch-returned payments are stored at preview-ready.
- No AI or natural-language interpretation is required for structured date selection, and no payday, income, employment, affordability or hardship inference is ever made.
- Stage 2 internal execution exists but is gated behind the customer transaction-verification requirement. The single internal entry point `confirmInterventionExecution` (`intervention-service.ts`) performs: reload/gating → "executing" latch with a server-generated operation ID → exact customer confirmation from stored values → recorded acceptance → one invocation of the existing protected replacement route (unchanged, over localhost — its own fresh Pinch preflight, confirmation consumption, recovery write, cancellation, creation, verification, never a retry) → `executed` / `manual-recovery-required` write-back; pre-mutation refusals revert to preview-ready with the linkage cleared. It contains no OTP logic — verification is a prerequisite checked in front of it by `requireTransactionVerification`.
- The gate requires a verified `TransactionVerificationRecord` (`src/lib/duelogic/transaction-verification.ts`) bound to the exact intervention, merchant, payer, subscription, selected date, both stored schedules and policyVersion, unexpired and unconsumed; `finalConfirmationEnabled` is derived from the record (never hardcoded), the confirm button stays disabled without one, and token possession alone can never initiate execution.
- The process-local development verification store (`src/lib/duelogic/dev-transaction-verification-store.ts`, behind `ClaimableTransactionVerificationRepository`) supports exact record creation (write-once per intervention, structuredClone in and out, read-back verified) and ATOMIC single-use claim: `claimForExecution` re-evaluates every bound field at claim time in one event-loop-atomic operation, refuses missing/expired/consumed/mismatched records without consuming, and a successful claim is terminal — never rolled back, even when later execution refuses before any mutation; a manual-recovery or ambiguous outcome retains the consumed record as evidence. The dev confirmation route atomically claims BEFORE calling `confirmInterventionExecution`; a failed claim refuses with `verification-required` and creates nothing.
- Controlled rehearsal seeding: `POST /api/duelogic/dev/verifications/rehearsal` (localhost-and-development-only) accepts exactly `{ token }` and builds the one verification record entirely from the trusted stored preview-ready intervention (identity, selected date, exact schedules, amounts, bound policyVersion — the customer can supply none of it); records expire after 10 minutes; a second seed refuses without replacing the first. This is temporary rehearsal infrastructure: the final SMS/OTP implementation will create records through a separate verified code-entry path while retaining the same claim and execution boundary. This stage executes no replacement.
- Execution statuses `executing`, `executed` and `manual-recovery-required` survive expiry as historical/in-flight facts; decline is refused once execution begins; the dashboard panel shows executed and manual-recovery counts with execution labelled as gated pending customer verification.
- The merchant monitors invitations and outcomes on the dashboard panel and handles escalations and manual-recovery cases; the monitoring projection never exposes the raw token, the token hash or the notification delivery artefact.
- Intervention tokens follow the confirmation security pattern (256-bit, SHA-256 hash stored, never logged); the raw token exists only in the customer notification's review link, delivered through the in-app dev inbox `/dev/duelogic/inbox`.
- Invitations are generated automatically by the scheduled scan, and the hackathon MVP delivers them through `/dev/duelogic/inbox` presented as the simulated Development Customer Email Inbox (presentation layer only — invitation, notification, token, policy and execution logic are untouched). The secure review link is delivered in the email channel only; OTP codes arrive only through the separate development SMS inbox `/dev/duelogic/sms` — the two channels are never combined. The notification record carries no recipient email, so the card shows "Customer email on file"; production email delivery remains polishing-week integration work.
- The intervention flow lives in `src/lib/duelogic/intervention-service.ts` with injected repositories (including the saved-policy `MerchantPolicyRepository`), clock, token functions, read-only Pinch effects (`intervention-pinch-reads.ts`, GET only) and the injected replacement-path invoker; the store (`dev-intervention-store.ts`) is process-local, non-durable sandbox memory; the thirty-five-scenario deterministic suite (`intervention-validation.ts`) never calls Pinch — the internal execution scenarios drive the real replacement flow with injected fakes only, the gate-refusal scenario proves missing verification blocks execution, the binding scenarios prove creation-time policy binding with safe refusal, and the prior-change-history scenarios prove payer-keyed rolling-allowance enforcement — and is re-asserted by the scan route and the dashboard render.
- A customer decline is terminal for the invitation: no further selection or preview, no Pinch call, no confirmation record.

## Customer transaction verification

- The tokenised customer link authorises limited access only: reviewing the payment, selecting a date, receiving the deterministic policy result, previewing the exact Pinch schedule and declining the invitation. Possession of the tokenised link alone must never authorise a live Pinch subscription mutation.
- Before final customer confirmation can initiate cancellation and replacement, the customer must complete a separate one-time verification step. For the hackathon MVP the intended method is a one-time SMS code sent to a pre-existing trusted mobile number associated with the payer; the customer must not be able to enter, replace or update that number through the tokenised review flow.
- The invitation link should be delivered through email or another channel separate from the SMS verification channel; if the same channel would provide both the link and the code, the case must not be treated as automatically verified without a separately approved control.
- Successful verification must be bound server-side to the exact intervention, merchant, payer, subscription, selected date, current schedule, proposed schedule, amounts, policyVersion and confirmation attempt; any change to the selected date or the authoritative Pinch preview invalidates the earlier verification.
- The code must be short-lived and single-use; verification attempts and resend requests must be rate-limited. Exact code length, expiry, attempt limits, resend limits, SMS provider and contact-data source remain subject to a separate inspection and explicit approval.
- If no trusted mobile number is available, the code cannot be delivered, the code expires or verification fails, DueLogic must not execute automatically; the case moves to merchant review, escalation or another separately approved verified channel.
- Routine requests that successfully pass policy evaluation, exact schedule review and transaction verification still require no later merchant approval.
- A fresh Pinch preflight remains mandatory after successful verification and immediately before any mutation.
- Stage 2 must reuse the existing protected confirmation, recovery and replacement path — never a second execution implementation.

## Customer OTP verification (barebones demo path)

- A deliberately reduced OTP path exists for the hackathon demonstration: a preview-ready approved customer requests a six-digit code (`crypto.randomInt(0, 1_000_000)`, leading zeroes preserved), the code is delivered only to the separate development SMS inbox `/dev/duelogic/sms`, and entering the correct code creates the existing 10-minute `TransactionVerificationRecord` — which is the only thing that turns `finalConfirmationEnabled` true. Final confirmation remains a separate customer action behind the unchanged atomic claim; OTP verification never confirms, executes or touches the protected replacement path.
- Challenges (`src/lib/duelogic/otp-challenge.ts`, store `dev-otp-store.ts`, service `otp-service.ts`, routes `/api/duelogic/dev/interventions/otp/request|verify`) live five minutes and store only an HMAC-SHA256 code digest keyed by `DUELOGIC_OTP_HMAC_SECRET` (resolved at request execution time; a missing secret fails closed; never logged or returned) plus an HMAC fingerprint of the trusted mobile — never the plaintext code, never the complete mobile, never the review token. Digest comparison is timing-safe.
- The trusted mobile is read server-side from the Pinch payer record by GET at request and verify time; the browser supplies only `{ token }` / `{ token, code }` and can never supply or change the mobile. Only a masked value (at most the last three digits) is ever displayed, with the wording "We'll send a verification code to the mobile number held on your payer record."
- Wrong and expired codes refuse (`otp-incorrect` / `otp-expired`) without creating anything; a successful code is single-use (`otp-already-used` on reuse); the challenge is bound to the exact intervention state (selected date, both schedules, policyVersion, mobile fingerprint) and any change refuses as `otp-mismatch`.
- DEMO-ONLY REDUCTIONS, by explicit decision: no failed-attempt limit, no resend delay and no maximum issue count exist — requesting another code replaces the intervention's previous challenge (the replaced code no longer verifies). Attempt limits, resend delay, issue caps, production SMS delivery, concurrency hardening and durable challenge/SMS storage remain polishing-week work; the full approved OTP control set is NOT yet implemented.
- The six-scenario deterministic suite (`otp-validation.ts`, fakes only, never calls Pinch) is re-asserted by the dashboard render; the OTP stores are process-local, non-durable sandbox memory.

## Temporary payment movement (protected backend)

- Temporary movement changes ONE scheduled payment: the existing Pinch payment ID is retained (POST /payments with the existing id), future recurring payments stay unchanged, and live status exactly `scheduled` is required immediately before mutation. The reusable movement service (`src/lib/pinch/payment-movement.ts`) preserves the proven dev-route contract: authoritative pre-read, exact ID/date/amount match, one mutation invocation with no automatic retry, and authoritative read-back as the source of truth — ambiguity is resolved only by the read-back, never by re-POSTing.
- The customer-facing execution path is OTP-gated with separate final confirmation: an exact temporary operation selection (`src/lib/duelogic/temporary-operation.ts`, stores in `dev-temporary-operation-store.ts`) binds paymentId, original and proposed dates, integer-cent amount and the bound policyVersion server-side BEFORE verification — the final-confirmation request can never supply or replace any of them. The temporary OTP challenge and temporary TransactionVerificationRecord are temporary-shaped (discriminated from the permanent replacement shapes, never forced into subscription-schedule fields), and the claim is atomic and single-use with every bound field re-checked at claim time.
- Replacing the bound selection before verification invalidates every earlier challenge and expectation; after verification the selection is immutable (re-binding refuses) — changing the operation requires a fresh verification.
- The single protected entry point `executeTemporaryPaymentChange` (`temporary-execution-service.ts`) orders: reload/gate → bound selection → bound policy snapshot → fresh authoritative payment read (scheduled; ID/date/amount match) → atomic claim → temporary confirmation with recorded acceptance → operation evidence written and read back before mutation → confirmation consumed and bound → one mutation → read-back verification → `temporary-change-verified` and intervention `executed` with confirmationId/operationId and the verified date. Temporary execution NEVER populates `newSubscriptionId`. Refusals before the claim consume nothing; post-invocation failures are `refused-before-mutation`, `temporary-change-ambiguous` or `manual-recovery-required` — never retried, surfaced to the merchant.
- Only `temporary-change-verified` operations with a verified read-back count towards the rolling temporary usage limit (derived by `toTemporaryPriorScheduleChanges`, payer-keyed, engine-counted under the approved lower-exclusive/upper-inclusive boundary); previews, OTP verifications, acceptance alone, refused, ambiguous and failed operations never count. The engine receives combined permanent+temporary derived history and remains the sole counting authority.
- The customer movement-choice UI, temporary date picker and final-confirmation dispatcher remain a later stage; no live temporary Pinch mutation has been performed — the deterministic suite (`temporary-operation-validation.ts`, 29 recorded scenarios covering the approved list; the untouched permanent suites cover the rest) runs on fakes only and is re-asserted by the dashboard render.

## Customer movement choice (wiring stage)

- The tokenised customer journey now presents up to three movement choices: "Move this payment only" (`temporary` — one payment, Pinch payment ID retained), "Change this and future payments" (`permanent-current-cycle` — upcoming and future schedule replaced) and "Keep this payment and change future payments" (`permanent-next-cycle` — upcoming payment untouched, replacement starts in the next assigned cycle). Availability is derived server-side (`movement-availability.ts`) by PROBING the policy engine and cadence resolver under the intervention's bound snapshot with derived permanent+temporary history and explicit arrears — never hard-coded, never computed in the browser, never re-implemented rules. Nothing available → customer-safe merchant-review wording and the existing escalation state.
- The chosen movement kind is bound server-side (`movement-journey.ts`, choice store in `dev-movement-store.ts`); date evaluation, OTP issuance and final confirmation all dispatch off the STORED choice — request data can never select or override an execution path. Choosing/changing an option or date before verification invalidates prior previews and challenges (binding checks refuse stale expectations); after any verification exists the choice is immutable (`verification-active`).
- The final-confirmation route resolves the stored kind (defaulting to the permanent journey for pre-choice invitations) and `dispatchFinalConfirmation` invokes exactly one protected path: temporary → `executeTemporaryPaymentChange`; both permanent modes → the unchanged permanent gate/claim/`confirmInterventionExecution` composition. OTP challenges are kind-discriminated and bound to the exact selected operation; cross-kind reuse is structurally impossible.
- STAGE BOUNDARY: the temporary journey's payment reads and its mutation effect run against the process-local FIXTURE payment store only (`dev-movement-journey.ts` composition) — live Pinch payment discovery and live temporary execution remain a separate controlled validation stage, so no live Pinch payment can be touched by construction. Fixture demonstration states seed through the localhost-only `POST /api/duelogic/dev/movement-fixtures` (`temporary-only` | `all-options` | `review-required`), with synthetic payers distinct from the live demonstration payer.
- The merchant remains monitoring/escalation/recovery only; the forty-row movement suite (`movement-availability-validation.ts`) is re-asserted by the dashboard render (note recorded there: a permanent-current-only state is structurally unreachable under the approved rules since a valid next-cycle anchor always exists when the current cycle has one).

## Demo Setup page

- `/dev/duelogic/demo` is development-only (localhost + `next dev` guard). "Prepare demo" (`POST /api/duelogic/dev/demo`, empty body — the browser supplies nothing) recreates the complete process-local presentation state in one click: three tokenised customer journeys (temporary-only, all-options, permanent-only — the last via two seeded verified temporary operations exhausting the rolling limit on that scenario's own synthetic payer) plus two completed-result fixtures.
- Preparation makes zero Pinch requests (including reads), issues no OTP and writes no SMS; OTP codes are requested separately during the customer journey. Scenario links use fresh tokenised invitations each run; the raw token exists only inside stored reviewPath hrefs.
- Preparation clears ONLY the previous demo run: the manifest (`demo-preparation.ts`, store `dev-demo-store.ts`, wiring `dev-demo-composition.ts`) records every created ID, and the next run deletes exactly those records plus journey artefacts keyed to those intervention IDs via the dev-store-only targeted deletion helpers. Unrelated records, the completed live intervention and `sub_eQMjuw9iGUbjww` are never touched.
- Evidence labels are accurate: the completed temporary result is a deterministic development fixture; the completed permanent result is a development representation of the previously verified live Pinch sandbox replacement (referencing `sub_eQMjuw9iGUbjww` internally only) — never presented as a new live execution. Dashboard rows for `int_fixture_` records carry a "Development fixture" label.
- The demo manifest is process-local sandbox memory, NOT durable persistence: demo records disappear when the development server restarts — run Prepare demo again. The thirty-scenario suite (`demo-preparation-validation.ts`, fakes only, first preparation runs under a fetch blocker) is re-asserted by the Demo Setup page render.

## Verified prior-change history

- Verified permanent corrections are converted into `PriorScheduleChange` policy history by the pure module `src/lib/duelogic/prior-change-history.ts`: an intervention with terminal status `executed` and the complete verified linkage (confirmationId, operationId, newSubscriptionId) becomes one `executed-verified` permanent entry with `id` = operationId. `executedDate` is the merchant-calendar date (timezone-aware formatter, never UTC slicing) of the executed record's `updatedAt` — the successful execution write-back instant, immutable because `executed` is terminal.
- Permanent-use history is keyed by the payer, never a subscription ID: cancelling and replacing the subscription never resets the rolling allowance. The old-to-new replacement mapping remains the audit trail only and is never traversed for counting.
- The scheduled scan and customer date evaluation both pass the derived history to `evaluateScheduleChange` (the scan under the active saved snapshot, customer evaluation under the intervention-bound snapshot); the policy engine remains the sole authority for rolling-period counting and escalation — no second usage counter exists anywhere.
- An exhausted permanent allowance (`PERMANENT_CHANGE_LIMIT_REACHED`, rule `permanentChange.maxVerifiedUses`) makes the scan return the merchant-safe `policy-review-required` stage — no routine invitation, token, notification or preview — and makes customer date evaluation escalate before any Pinch preview read.
- `manual-recovery-required` maps to a non-counting `manual-recovery` audit entry; refused/reverted, declined, expired, escalated, still-executing and linkage-missing records produce no history; duplicate evidence for one operationId deduplicates to one entry (earliest executed date).
- The rolling window is lower-exclusive and upper-inclusive (Renee-approved): a verified correction completed on the evaluation merchant date counts immediately, an entry dated exactly 12 months before the evaluation date is outside the window, and future-dated entries never count. This is the approved date-only MVP interpretation — `PriorScheduleChange` carries `executedDate`, not a timestamp, and trusted history comes only from already completed interventions; timestamp-level persistence and precision remain production hardening.
- History derives from the process-local intervention store — an MVP limitation; durable persistence remains required before production reliance.
- No policy rule may be added or changed without Renee's explicit approval; this stage added enforcement wiring only, never a rule or threshold change.

## Outcome events

The proven payment lifecycle events are:

- `scheduled-process`
- `bank-results`

The verified `bank-results` event carried the approved payment outcome.

The webhook receiver:

- verifies `pinch-signature` against the raw request body
- applies a five-minute timestamp tolerance
- accepts camelCase and PascalCase event envelopes
- must remain publicly reachable
- must never log secrets, signatures or complete webhook bodies

## Local live-payment screen

- `/dev/pinch/payment` is the minimum visible Pinch execution proof: a localhost-only development screen over the proven payment-date routes and webhook.
- Payment state shown on the screen must be read from Pinch through the dev read endpoint, never hardcoded.
- Only webhook events that passed signature, timestamp and JSON verification may enter the development outcome store (`src/lib/pinch/dev-outcome-store.ts`).
- The development outcome store holds safe summaries only: paymentId, eventId, type, eventDate, receivedAt. Never bodies, signatures, headers, amounts, payer or source data.
- The store is in-process memory, deduplicated by event ID, capped at 10 events per payment, and resets on process restart. It is not persistence.
- `scheduled-process` means processing started.
- `bank-results` means a result event arrived; the current payment status from the read endpoint remains the outcome source of truth.
- A failed payment-date mutation must never be automatically repeated.
- The date-change confirmation is temporary operation feedback, not payment state: it is cleared once a later webhook event arrives or the payment is no longer scheduled, and the move controls are disabled whenever the current Pinch status is not scheduled.

## Timing-pattern detector

- Pattern detection is deterministic: pure functions in `src/lib/duelogic/pattern-detector.ts` — no clock reads, randomness, network, environment access or input mutation.
- Only `insufficient-funds` dishonours are candidates; other dishonour reasons never enter pattern evidence.
- A flag requires at least two clustered candidate dishonours (day-of-month within one inclusive four-day window, or at least two on the same weekday).
- A flag also requires approved later-settlement evidence: an approved retry strictly after processedDate that falls outside the full selected detection window (day-of-month) or on a different weekday (day-of-week).
- `windowStartDay` and `windowEndDay` record the full inclusive detection window that selected the cluster, not the observed member-day extremes; when several windows contain the same member set, the earliest window start is the selected window.
- The detector identifies timing-linked payment patterns only — never payday, employment, affordability, income, hardship or any financial cause.
- `proposedShiftDays` is the lower-median of observed approved-retry delays (minimum 1): a shift worth testing, not a claim any dishonour would have been prevented.
- Seed validation (`src/lib/duelogic/pattern-detector-validation.ts`) must continue to find exactly the intentionally planted pattern payers and no others.
- Detection must be invariant to input record order, with stable flag IDs derived from payerId and the as-of date.

## DueLogic analysis rules

- Pattern detection filters to dishonours with the `insufficient-funds` reason only.
- Do not treat every dishonour as evidence of a payment-timing mismatch.
- Do not assert prevented losses, recovered revenue or causal impact from historical replay.
- Report historical payments that would have been eligible for intervention under the stated policy assumptions.
- Display the governing assumption beside the result, not in a footnote.
- The model may interpret customer language, but deterministic code makes eligibility and execution decisions.

## Merchant opportunity reporting

- Merchant opportunity metrics (`src/lib/duelogic/merchant-opportunity.ts`) are derived only from detector output and the deterministic policy evaluations the dashboard already renders — never a second evaluation pathway.
- Eligible value means upcoming payment value approved for schedule review under the displayed policy; it must never be described as prevented loss, recovered revenue or guaranteed success.
- Unapproved cases (escalations and alternatives) remain visible in the detail rows but are excluded from approved-intervention counts and eligible-value totals.
- A missing upcoming amount is a typed calculation error, never a silent zero.

## Policy and eligibility engine

- The policy is declarative and versioned; all thresholds live in `DEFAULT_DUELOGIC_POLICY` (`src/lib/duelogic/policy/rules.ts`), and the engine always evaluates the supplied policy's values (e.g. `policy.amountCeilingCents`), so merchant-specific policies override defaults without engine changes.
- Defaults: payment amount ceiling 50000 cents; 2 executed-verified temporary changes per rolling 12 months; 1 executed-verified permanent change per rolling 12 months.
- Temporary shifts are limited to 5 calendar days; a longer request returns the furthest permitted date, not a rejection.
- A revised date must remain inside the billing cycle already assigned to the affected payment (Renee-approved restored safeguard). Temporary evaluation accepts optional trusted `currentCycleStartDate`/`currentCycleEndDate` bounds (supplied together; the payment must lie inside them, else `INVALID_CYCLE_METADATA`); the customer journey always supplies the intervention's stored bounds, replay without bounds is unchanged. Beyond the cycle end the alternative clamps to the cycle end (`TEMPORARY_OUTSIDE_ASSIGNED_CYCLE`); with no compliant later date the request escalates (`TEMPORARY_NO_DATE_IN_ASSIGNED_CYCLE`) and availability removes the temporary option server-side; `executeTemporaryPaymentChange` re-asserts the rule immediately before the claim (`selection-outside-assigned-cycle`, consuming nothing). The execution preflight strictly validates all four dates with `parseCalendarDate` before any comparison, so corrupted non-date metadata refuses outright. The twenty-five-scenario suite (`assigned-cycle-validation.ts`, including missing- and malformed-metadata fail-closed coverage at availability, binding and execution preflight) is re-asserted by the dashboard render.
- Permanent changes are not subject to the temporary five-day cap.
- Permanent policy supports weekly, fortnightly and monthly cadences.
- Cadence and billing-cycle boundaries are supplied explicitly from trusted metadata and are never inferred from payment spacing, descriptions or dishonour history.
- Permanent changes support `current-and-future` and `next-cycle-and-future`; a permanent payment may move earlier or later within its assigned billing cycle, and every revised payment remains within the billing cycle of the payment it replaces.
- Weekly anchors preserve their position inside a 7-day cycle; fortnightly inside a 14-day cycle; monthly anchors preserve their day of month, restricted to days 1-28 in the MVP.
- Current-cycle permanent anchors must be strictly after `evaluationDate`; an unavailable current-cycle anchor returns a next-cycle alternative when one can be validly derived.
- Close-payment warnings are cadence-specific: weekly below 3 days, fortnightly below 5, monthly below 7. A close gap is a warning and acknowledgement requirement, never an automatic rejection.
- Invalid cycle metadata is a validation error (`INVALID_CYCLE_METADATA`); a valid but unsupported cadence is a policy escalation. Never confuse the two.
- Arrears are supplied explicitly and never inferred from dishonour history.
- Only executed-verified changes consume usage limits; temporary and permanent counters are separate; rolling usage is anchored to the explicit `evaluationDate` with the Renee-approved boundary: lower boundary exclusive, evaluation date inclusive — a verified use counts when `executedDate > evaluationDate - rollingPeriodMonths` and `executedDate <= evaluationDate`.
- The engine never uses the system clock and decides only — it never calls Pinch. Live Pinch status must be re-checked by the execution layer immediately before mutation; only a live payment with status `scheduled` may be changed.
- Policy support for a cadence does not itself prove live Pinch execution support for that cadence.

## Merchant policy snapshots

- The default policy remains defined only in `DEFAULT_DUELOGIC_POLICY` (`src/lib/duelogic/policy/rules.ts`); the snapshot foundation never duplicates its values, and no policy rule may be added or changed without Renee's explicit approval.
- A `MerchantPolicySnapshot` (`src/lib/duelogic/policy/policy-snapshot.ts`) is immutable, append-only activation history behind `MerchantPolicyRepository`: no update, delete or replace method exists, every write and read passes through `structuredClone`, and the latest successfully activated snapshot is the merchant's active policy.
- `policyVersion` must equal `policy.version`; activation validates the complete policy through the engine's exported `assertValidPolicy` (never a duplicated check) and rejects duplicate versions and version mismatches without changing stored history.
- The initial snapshot is `duelogic-default-v1`, installed automatically with `installedAsInitialDefault: true` when the shared development repository is first created, with `activatedAt` from the injected server clock; later development versions are server-generated `duelogic-policy-v{n}` (v2, v3, …).
- The store (`src/lib/duelogic/policy/dev-policy-store.ts`) is process-local, non-durable sandbox memory that resets with the development process; durable storage replaces the repository implementation, not the snapshot or repository contract.
- The development merchant views, saves and activates immutable policy snapshots on the dashboard "Policy configuration" panel (`src/app/policy-config-panel.tsx`) through the localhost-only route `/api/duelogic/dev/policy`; `amountCeilingCents` is the only merchant-configurable policy value (a positive safe integer of cents, no arbitrary upper limit), and versions and activation metadata are server-generated.
- The API accepts exactly `{ amountCeilingCents }` and rejects unknown keys and any browser-supplied policy identity or fixed rule value (`policyVersion`, `version`, `merchantId`, `activatedAt`, `installedAsInitialDefault`, rule fields); the complete policy is rebuilt server-side from the `DEFAULT_DUELOGIC_POLICY` frame (`policy-activation.ts`) and validated through the engine before activation. Responses and the panel carry merchant-safe projections only — never merchant IDs, complete policy objects or store internals.
- Historical replay and merchant opportunity figures now adopt the active saved policy: `buildSeedPolicyEvaluations(policy = DEFAULT_DUELOGIC_POLICY)` evaluates under the supplied policy, and the dashboard (rendered per request via `force-dynamic`) reads the active snapshot on each request, evaluates replay under it, derives the opportunity figures from those same evaluations (never a second pathway), and displays the governing policy version — activating a policy then refreshing updates all three.
- Saved policy snapshots now govern every adopted lifecycle point: replay and opportunity figures use the snapshot active at each dashboard request, and interventions bind the snapshot active at their creation (scan and customer evaluation, above). `buildSeedPolicyEvaluations` retains `DEFAULT_DUELOGIC_POLICY` as its default argument for compatibility only — the scan now always passes the active snapshot's policy. Transaction verification and gated execution are unaffected by policy adoption and binding — neither creates a verification record nor can open the execution gate. The process-local development-store limitation remains. The twenty-one-scenario suite (`policy-snapshot-validation.ts`) is re-asserted by the dashboard render and the dev policy route.

## Plan-to-schedule configuration

- The Pinch Plan and Subscription responses used by DueLogic do not currently provide a trusted cadence field.
- Cadence is supplied through merchant-held plan-to-schedule configuration (`MerchantPlanScheduleConfiguration`, resolved by `src/lib/duelogic/policy/plan-schedule-resolver.ts`); plan IDs are merchant-scoped.
- Plan mappings remain separate from `DEFAULT_DUELOGIC_POLICY`: the policy defines permitted behaviour, the plan map defines schedule structure, and the default policy stays reusable across merchants.
- Cadence is never inferred from payment spacing or calculated-payment dates — not by the resolver and not by the policy engine.
- Weekly and fortnightly mappings contain an authoritative `cycleAnchorDate` (the first day of one cycle, not necessarily a payment date); monthly mappings use full calendar months and need no anchor.
- An unmapped plan escalates for merchant review (`PERMANENT_PLAN_SCHEDULE_UNMAPPED`) — never a guessed cadence, never silent monthly rules.
- Malformed plan configuration is a validation error (`INVALID_PLAN_SCHEDULE_CONFIGURATION`).
- A mapped plan whose payment dates contradict its configured cycle sequence produces `PLAN_SCHEDULE_CONTEXT_MISMATCH`.
- Policy evaluation only receives resolved cadence and cycle boundaries; live Pinch status remains an execution-layer check.
- Shared pure date helpers live in `src/lib/duelogic/calendar-date.ts` — the engine and resolver must not duplicate inconsistent date logic.

## Working rules

- Read this file before planning or editing.
- Inspect the existing implementation before changing it.
- Keep each build step narrowly scoped.
- Run `npm run lint`, `npm run build` and `git diff --check` before committing.
- Renee Gersteling must be the sole commit author and committer.
- Never add `Co-authored-by`, `Generated-by`, `Signed-off-by`, Claude attribution, AI attribution or another commit trailer.
- Never commit `.env.local`, credentials, tokens, webhook secrets or generated files.
