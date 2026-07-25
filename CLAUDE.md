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

## Customer-led intervention flow (Stage 1)

- Permanent recurring schedule correction remains central to the MVP: the merchant configures the flexibility policy once and it is applied automatically; ordinary approved requests require no case-by-case merchant approval.
- Intervention invitations are generated automatically by the scheduled scan (dev trigger `POST /api/duelogic/dev/interventions/scan`, localhost-only): frozen detector evidence designates the opportunity, the frozen policy result must be approved, and the current active subscription is resolved read-only at runtime (`src/lib/duelogic/subscription-resolver.ts`) — never a hardcoded subscription ID, and an ambiguous or unreadable resolution is a development fixture error that creates no invitation.
- The customer selects the date on the tokenised page `/review/[token]`; the existing deterministic policy engine evaluates it as a permanent change built entirely from server-held trusted data; Pinch calculates the authoritative schedule — preview dates are never generated or substituted locally, and exactly three current and three proposed Pinch-returned payments are stored at preview-ready.
- No AI or natural-language interpretation is required for structured date selection, and no payday, income, employment, affordability or hardship inference is ever made.
- Stage 1 stops at preview-ready: the "Confirm and apply this schedule" button is rendered disabled with no handler, and `confirmationId`, `operationId` and `newSubscriptionId` remain null. Final confirmation will initiate execution in Stage 2 through the existing protected replacement path — the existing replacement and recovery logic stays untouched and there is never an automatic retry after an ambiguous mutation.
- The merchant monitors invitations and outcomes on the dashboard panel and handles escalations and manual-recovery cases; the monitoring projection never exposes the raw token, the token hash or the notification delivery artefact.
- Intervention tokens follow the confirmation security pattern (256-bit, SHA-256 hash stored, never logged); the raw token exists only in the customer notification's review link, delivered through the in-app dev inbox `/dev/duelogic/inbox`.
- The intervention flow lives in `src/lib/duelogic/intervention-service.ts` with injected repositories, clock, token functions and read-only Pinch effects (`intervention-pinch-reads.ts`, GET only); the store (`dev-intervention-store.ts`) is process-local, non-durable sandbox memory; the eight-scenario deterministic suite (`intervention-validation.ts`) never calls Pinch and is re-asserted by the scan route and the dashboard render.
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
- Permanent changes are not subject to the temporary five-day cap.
- Permanent policy supports weekly, fortnightly and monthly cadences.
- Cadence and billing-cycle boundaries are supplied explicitly from trusted metadata and are never inferred from payment spacing, descriptions or dishonour history.
- Permanent changes support `current-and-future` and `next-cycle-and-future`; a permanent payment may move earlier or later within its assigned billing cycle, and every revised payment remains within the billing cycle of the payment it replaces.
- Weekly anchors preserve their position inside a 7-day cycle; fortnightly inside a 14-day cycle; monthly anchors preserve their day of month, restricted to days 1-28 in the MVP.
- Current-cycle permanent anchors must be strictly after `evaluationDate`; an unavailable current-cycle anchor returns a next-cycle alternative when one can be validly derived.
- Close-payment warnings are cadence-specific: weekly below 3 days, fortnightly below 5, monthly below 7. A close gap is a warning and acknowledgement requirement, never an automatic rejection.
- Invalid cycle metadata is a validation error (`INVALID_CYCLE_METADATA`); a valid but unsupported cadence is a policy escalation. Never confuse the two.
- Arrears are supplied explicitly and never inferred from dishonour history.
- Only executed-verified changes consume usage limits; temporary and permanent counters are separate; rolling usage is anchored to the explicit `evaluationDate` (window start inclusive, evaluation date exclusive).
- The engine never uses the system clock and decides only — it never calls Pinch. Live Pinch status must be re-checked by the execution layer immediately before mutation; only a live payment with status `scheduled` may be changed.
- Policy support for a cadence does not itself prove live Pinch execution support for that cadence.

## Merchant policy snapshots

- The default policy remains defined only in `DEFAULT_DUELOGIC_POLICY` (`src/lib/duelogic/policy/rules.ts`); the snapshot foundation never duplicates its values, and no policy rule may be added or changed without Renee's explicit approval.
- A `MerchantPolicySnapshot` (`src/lib/duelogic/policy/policy-snapshot.ts`) is immutable, append-only activation history behind `MerchantPolicyRepository`: no update, delete or replace method exists, every write and read passes through `structuredClone`, and the latest successfully activated snapshot is the merchant's active policy.
- `policyVersion` must equal `policy.version`; activation validates the complete policy through the engine's exported `assertValidPolicy` (never a duplicated check) and rejects duplicate versions and version mismatches without changing stored history.
- The initial snapshot is `duelogic-default-v1`, installed automatically with `installedAsInitialDefault: true` when the shared development repository is first created, with `activatedAt` from the injected server clock; later development versions are server-generated `duelogic-policy-v{n}` (v2, v3, …).
- The store (`src/lib/duelogic/policy/dev-policy-store.ts`) is process-local, non-durable sandbox memory that resets with the development process; durable storage replaces the repository implementation, not the snapshot or repository contract.
- No consumer has been switched from the frozen policy yet: dashboard activation, historical-replay adoption, opportunity integration and intervention policy binding remain future controlled stages. The six-scenario suite (`policy-snapshot-validation.ts`) is re-asserted by the dashboard render.

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
