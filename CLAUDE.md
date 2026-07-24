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


## Working rules

- Read this file before planning or editing.
- Inspect the existing implementation before changing it.
- Keep each build step narrowly scoped.
- Run `npm run lint`, `npm run build` and `git diff --check` before committing.
- Renee Gersteling must be the sole commit author and committer.
- Never add `Co-authored-by`, `Generated-by`, `Signed-off-by`, Claude attribution, AI attribution or another commit trailer.
- Never commit `.env.local`, credentials, tokens, webhook secrets or generated files.
