# DueLogic

DueLogic identifies recurring payment timing patterns and gives eligible
customers a governed way to move one upcoming payment or correct their
future payment schedule through Pinch.

Recovery tools retry failed payments. DueLogic identifies repeated
timing-linked patterns before the next payment and provides a controlled
schedule-change workflow.

## The problem

Merchants who collect recurring payments usually handle payment-date
requests manually: a customer emails, someone edits a schedule, and every
decision is made case by case. Retries recover an individual failed
payment, but they do not correct a recurring mismatch between the
customer's payment schedule and when payment later succeeds — the same
debit keeps failing at the same point in the cycle and keeps being
retried. Inconsistent manual decisions create administration for the
merchant, friction for the customer and operational risk for both.

DueLogic identifies timing-linked patterns that are worth reviewing and
runs the review under an explicit merchant policy. It does not claim to
prove why a payment failed, it does not detect payday, and it never
assesses income, affordability or financial hardship — eligibility and
execution are decided by deterministic, versioned policy code over
explicit inputs.

## What the prototype demonstrates

The implemented workflow, end to end:

1. The merchant configures a policy (the payment amount ceiling is
   merchant-configurable; safeguards and usage limits are fixed,
   versioned policy values).
2. DueLogic replays the policy against historical payment activity, with
   the governing assumptions displayed beside the results.
3. DueLogic analyses the payment book for repeated timing-linked
   patterns (insufficient-funds dishonours that cluster in a recurring
   window, later settled by approved retries outside it).
4. Eligible customers receive tokenised invitations, delivered in the
   prototype through a simulated customer email inbox.
5. The server derives the movement choices available to that customer.
6. The customer selects a permitted date for the chosen movement.
7. DueLogic presents the exact dates and amounts before anything is
   agreed.
8. A one-time SMS code, delivered through a separate simulated SMS
   channel, verifies the customer.
9. The customer provides final confirmation of the exact change.
10. DueLogic executes through the protected Pinch path — fresh
    preflight, single mutation, no automatic retry.
11. The result, read-back evidence, recovery state and audit evidence
    are recorded.

The customer can be offered up to three movement choices:

- **Move this payment only**
- **Change this and future payments**
- **Keep this payment and change future payments**

### Policy rules demonstrated

- A temporary payment-date move is limited to two completed and
  read-back-verified temporary moves per payer in a rolling 12-month
  period.
- A permanent schedule correction is limited to one completed and
  read-back-verified permanent change per payer in a rolling 12-month
  period.
- A temporary move changes one scheduled Payment only: it may move the
  payment later by no more than five calendar days, it retains the same
  Pinch Payment ID, and later recurring payments remain unchanged.
- A permanent correction can change the current and future payments, or
  retain the current payment and change future payments from the next
  cycle. The replacement schedule comes from Pinch calculated-payments
  using the trusted Plan cadence — never calculated locally.
- Only completed changes confirmed by authoritative read-back consume an
  allowance. Failed previews, abandoned journeys and unsuccessful
  operations do not consume completed usage.
- When a limit is reached, the affected option is removed server-side.

In the hackathon prototype, the payment amount ceiling is
merchant-configurable, while usage limits and the other safeguards are
fixed, versioned policy values — they are not editable in the current
interface. The intended production model is for approved limits to be
configurable through the merchant policy, subject to system-enforced
safeguards. Either way, each invitation remains bound to the policy
version that approved it.

Availability is derived server-side by probing the policy engine and
cadence resolver with the merchant policy bound to the invitation, the
customer's verified prior-change history, the trusted plan cadence,
rolling usage limits, explicitly supplied arrears and the current live
state. The browser never decides what is available, and a customer
request can never select an execution path.

Routine eligible requests do not require individual merchant approval.
The merchant configures and activates the policy, reviews opportunity
and activity information, and handles escalations or manual-recovery
cases. Routine verified outcomes are recorded automatically; ambiguous
or manual-recovery states are surfaced to the merchant and are never
automatically retried.

## Meaningful use of the Pinch API

Pinch is operationally central to DueLogic: every schedule fact the
customer confirms is Pinch-calculated, and every change is executed and
then re-read through Pinch. The repository uses these Pinch surfaces:

- **OAuth client-credentials authentication** — server-only token
  exchange with in-memory caching and a single refresh-and-retry on 401.
- **Payer reads** — `GET /payers/{id}`, including the trusted mobile
  number used for SMS verification (the customer can never supply or
  change it).
- **Payment reads** — `GET /payments/{id}` as the authoritative pre-read
  before any mutation and the authoritative read-back after it.
- **Scheduled Payment date movement** — `POST /payments` retaining the
  existing payment ID, with nonce replay protection. Verified live in
  the Pinch sandbox: payment dates were moved and the payments settled
  with approved outcomes.
- **Plans and Subscriptions** — plan lookups and subscription reads
  under managed-merchant scoping (`Current-Merchant` header).
- **Calculated-payment schedule previews** —
  `GET /plans/{planId}/calculated-payments`, converted to merchant-local
  calendar dates with a timezone-aware formatter. The preview is the
  only source of proposed dates; DueLogic never generates schedule dates
  locally.
- **Subscription cancellation and replacement** —
  `DELETE /subscriptions/{id}` then `POST /subscriptions`, treated as
  the non-atomic sequence it is: recovery evidence is written and read
  back before cancellation, nothing is retried after an ambiguous
  response, and failures after cancellation become explicit
  manual-recovery states. Verified live in the Pinch sandbox.
- **Payment source preservation** — the replacement keeps the existing
  payer and payment source; source identity is confirmed from the
  payment read-back.
- **Read-back verification** — every mutation is confirmed by re-reading
  the changed resource; the read-back, not the mutation response, is the
  source of truth.
- **Webhook payment-outcome evidence** — a signature-verified webhook
  receiver (`pinch-signature` over the raw body, five-minute timestamp
  tolerance) captured the live `scheduled-process` and `bank-results`
  events for the moved payments.

Pinch controls the payment. DueLogic controls the governed decision
about when that payment should run.

Demo Setup itself makes none of these calls — see
[Evidence and proof status](#evidence-and-proof-status).

## Evidence and proof status

The prototype is explicit about what each piece of evidence is.

### Deterministic development evidence

- The merchant payment history is a synthetic, frozen seed.
- Pattern detection is deterministic and re-validated on every dashboard
  render.
- Policy evaluation and historical replay run under the active saved
  merchant policy snapshot, deterministically.
- Customer movement availability is derived by the same deterministic
  engine and resolver.
- OTP, confirmation, operation, recovery and demo-preparation behaviour
  is covered by deterministic validation suites (process-local fakes,
  never Pinch) that are re-asserted on page renders.
- The completed temporary demonstration result is a **deterministic
  development fixture**.
- Demo Setup scenarios are repeatable process-local fixtures on
  synthetic payers.

### Previously verified live Pinch sandbox evidence

- Permanent Subscription cancellation and replacement.
- The Pinch-calculated replacement schedule.
- Read-back verification of the replacement.
- The verified old-to-new Subscription mapping.
- The completed permanent result shown by Demo Setup, labelled as a
  **development representation of a previously verified live Pinch
  sandbox result**.

Accurate status statements:

- Demo Setup makes no Pinch requests or mutations — it rebuilds
  process-local demonstration state only.
- The completed permanent scenario represents a previously verified live
  Pinch sandbox replacement; it is never presented as a new live
  execution.
- The completed temporary scenario is deterministic development
  evidence.
- Scheduled-payment date movement was verified live through the
  development payment screen; the full customer-led temporary journey
  runs against a process-local fixture payment store by construction and
  has not been executed live end to end.

## Running locally

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

Copy `.env.example` to `.env.local` and fill in your Pinch sandbox
values first — see
[Environment variables](#environment-variables).

All DueLogic development pages and API routes answer only direct
localhost requests under `next dev`; tunnelled, proxied and deployed
requests are rejected. `GET /api/pinch/health` checks Pinch connectivity
without exposing token material.

## Demo scenarios

Open **Demo Setup** at `/dev/duelogic/demo` and press **Prepare demo**.
One click rebuilds all five scenarios with fresh secure invitation
links, removing only the previous demo run's records. Preparation makes
no Pinch requests, issues no OTP and writes no SMS message.

| Scenario | What it shows |
| --- | --- |
| **Demo 1: Move one payment** | Temporary-only customer journey: only "Move this payment only" is available (the plan has no trusted cadence mapping, so both permanent modes are unavailable). |
| **Demo 2: Choose from all available options** | Customer journey with all three movement choices available under a mapped plan cadence. |
| **Demo 3: Permanent schedule correction** | Permanent-only customer journey: this scenario's synthetic payer has already used its rolling temporary allowance (two seeded verified temporary operations), so the policy engine itself hides the temporary option. |
| **Completed result: Temporary payment move** | Completed temporary result — a deterministic development fixture showing the original date, new date and amount, with later recurring payments unchanged. |
| **Completed result: Permanent schedule correction** | Completed permanent result — a development representation of previously verified live Pinch sandbox evidence, showing the previous and verified new schedules. |

Every scenario card carries its evidence-provenance label, and the same
label appears on the scenario's customer page.

## Recommended demo sequence

1. **Merchant policy** — open the merchant dashboard at `/` and show the
   policy configuration panel (amount ceiling, fixed safeguards,
   activation history).
2. **Historical policy impact** — walk the policy replay decisions and
   their displayed assumptions.
3. **Payment-book analysis** — show the opportunity figures and eligible
   upcoming payment value under the active policy version.
4. **Detected timing pattern** — show the per-customer pattern evidence
   and the twelve-month payment and settlement history behind it.
5. **Simulated customer email** — open `/dev/duelogic/inbox` and follow
   an invitation's review link.
6. **Customer movement choice** — on the review page, choose one of the
   server-derived movement options.
7. **Exact schedule preview** — check a permitted date and show the
   exact dates and amounts presented before anything is agreed.
8. **Separate SMS verification** — request the code, then open
   `/dev/duelogic/sms` for the one-time code; the SMS channel never
   carries a review link.
9. **Final confirmation** — enter the code and give the single final
   confirmation.
10. **Completed evidence** — open both completed-result cards from Demo
    Setup and show their provenance labels.

Demo records are process-local and reset when the development server
restarts — run Prepare demo again afterwards.

## Environment variables

Copy `.env.example` to `.env.local` and fill in your own values. The
variables the code reads:

| Variable | Used for |
| --- | --- |
| `PINCH_APP_ID` | Pinch OAuth client-credentials authentication |
| `PINCH_APP_SECRET` | Pinch OAuth client-credentials authentication |
| `PINCH_API_BASE_URL` | Pinch sandbox API base URL |
| `PINCH_WEBHOOK_SECRET` | Webhook `pinch-signature` verification |
| `DUELOGIC_OTP_HMAC_SECRET` | HMAC digests for the demo OTP codes (missing secret fails closed) |

Never commit `.env.local` or any credential. `.env.example` carries
variable names only.

## Validation

```bash
npm run lint
npm run build
```

There is deliberately no separate `npm test` command: the repository's
deterministic validation suites live in validation modules and execute
through the development pages. Every merchant dashboard render re-runs
the twelve suites
covering pattern detection, the policy engine, plan-schedule resolution,
merchant opportunity, replacement recovery, customer confirmation, the
customer-led intervention flow, policy snapshots, transaction
verification, OTP, temporary operations and movement availability; every
Demo Setup render re-runs the thirty-scenario demo-preparation suite
(whose first preparation runs with network access blocked, proving the
no-Pinch guarantee). A regression fails the render loudly rather than
showing stale claims. All suites use process-local fakes and never call
Pinch.

## Architecture and safety controls

- **Deterministic policy decisions** — detection, policy evaluation and
  movement availability are pure, deterministic modules with injected
  repositories, clocks and effects: no clock reads, no randomness and no
  Pinch calls inside decision code. No AI model participates in
  eligibility or execution decisions.
- **Immutable policy snapshots** — merchant policies are versioned,
  append-only activation history; each invitation is bound at creation
  to the policy version that approved it, and later activations never
  alter a pending invitation.
- **Tokenised invitations** — customer links use 256-bit tokens; only
  the SHA-256 hash is stored, and the raw token exists only inside the
  delivery artefact's link.
- **Cryptographically generated OTP** — six-digit codes come from
  Node's cryptographic random source and are stored only as HMAC-SHA256
  digests with timing-safe comparison; the trusted mobile is read
  server-side from the Pinch payer record and only ever displayed
  masked. Email and SMS are separate channels by construction: the
  review link never enters the SMS store, and OTP codes never appear in
  email.
- **Close-payment warning** — a warning and acknowledgement are
  required when the chosen date falls close to the following scheduled
  payment under the trusted cadence. The acknowledgement is bound to
  the movement, selected date and exact preview, and changing the
  selection invalidates it. It is an acknowledgement requirement, never
  an automatic rejection and never a manual escalation.
- **Time-limited verification** — OTP codes expire after five minutes
  and verification records after ten; expiry is evaluated server-side.
- **Separate final confirmation** — verification never confirms or
  executes anything; final confirmation is a distinct customer action,
  gated behind an atomic single-use verification claim that is never
  rolled back.
- **Single-use confirmation consumption** — a customer confirmation is
  consumed exactly once and bound to its operation ID; a consumed or
  mismatched confirmation refuses execution.
- **Protected execution** — a fresh authoritative pre-read precedes
  every mutation, exactly one mutation is issued, and an ambiguous
  result is never retried; failures become explicit recorded states.
- **Read-back verification** — every mutation is confirmed by re-reading
  the changed resource; the read-back, not the mutation response, is the
  source of truth.
- **Recovery records** — for the destructive cancel-then-create
  replacement, a recovery snapshot is written and read back before
  cancellation, and any failure after cancellation becomes an explicit
  manual-recovery state with its failure stage recorded.
- **Rolling usage limits** — verified changes consume payer-keyed
  rolling allowances; cancelling and replacing a subscription never
  resets a customer's allowance.
- **Evidence provenance labels** — demonstration evidence is labelled at
  its source: development scenarios, deterministic development fixtures,
  and the development representation of previously verified live Pinch
  sandbox evidence.
- Monetary amounts are integer cents everywhere (dollars only at the
  display boundary); development pages require `next dev` plus a
  direct-localhost header check; logs never contain tokens, secrets,
  signatures or upstream response bodies.

## Current MVP limitations

- Development workflow records (policies, invitations, verifications,
  operations, demo state) are process-local sandbox memory. They are
  lost when the Node process restarts, and Demo Setup must be prepared
  again after a restart. What does persist: the repository code and the
  actual Pinch sandbox mutations already performed.
- Durable database persistence remains future work; nothing here claims
  process-local records are permanently stored.
- Email and SMS delivery are simulated in-app channels; production
  delivery is future integration work.
- The `/dev/duelogic/*` routes and pages are development-only and
  intended for localhost; a production deployment is not the complete
  demo environment — the complete repeatable demo runs locally.
- Production authentication and multi-merchant onboarding are not
  included.
- The demo OTP path deliberately omits attempt limits, resend delay and
  issue caps; the full approved OTP control set is not yet implemented.
- Live temporary execution through the customer journey remains a
  separate, controlled future stage.
- The demonstration merchant timezone is a development constant;
  production must use the merchant's own timezone record.
- No figure in the prototype claims prevented losses, recovered revenue
  or proof of why any payment failed.

## Commercial pathway

The initial buyer is vertical SaaS platforms that use Pinch to manage
recurring payments for service businesses — platforms serving merchant
categories such as gyms, allied health providers and training
organisations. For those platforms, DueLogic turns ad-hoc payment-date
requests into a consistent, policy-governed, auditable workflow.

The prototype's boundaries were drawn so the path to production is a
set of substitutions, not a redesign:

- Durable storage replaces the process-local repository implementations
  behind the same contracts — the flows, bindings and audit semantics do
  not change.
- A production email provider and SMS gateway replace the simulated
  inboxes behind the same delivery interfaces.
- The full approved OTP control set (attempt limits, resend delay, issue
  caps, durable challenge storage) hardens the existing verification
  boundary.
- The already-gated live temporary execution stage connects the customer
  journey to the same proven scheduled-payment movement path.
- The policy engine already evaluates whatever policy it is given, so
  per-merchant policies need no engine changes.
- Webhook-driven payment outcomes extend the merchant's monitoring view.

The value proposition stays deliberately modest: fewer manual
payment-date requests, consistent policy-governed decisions, and an
audit trail for every change.

## Hackathon build disclosure

Before the official build period, the repository contained the Next.js
scaffold, basic Pinch authentication plumbing and a connectivity health
check. DueLogic's product logic, policy workflow, pattern detection,
customer journey, OTP, execution orchestration, recovery controls and
demo experience were developed during the hackathon build period. The
repository's commit history reflects this sequence.

All Pinch activity occurred in the Pinch sandbox under test merchants
and test payers — no real customers, no production data and no live
merchant operations. The evidence classes above state exactly which
results were verified live in the sandbox and which are deterministic
development fixtures; the README deliberately claims nothing beyond
what the repository and its recorded sandbox evidence support.

## Repository status

- The default branch is `main`, and it holds the complete prototype:
  the merchant dashboard, the Demo Setup page, the simulated email and
  SMS inboxes, the tokenised customer review journey, the protected
  execution paths and the deterministic validation suites.
- This is a hackathon proof of concept, and this public repository is
  the authoritative prototype submission.
- The complete repeatable demo runs locally: prepare it with one click
  via Demo Setup after starting (or restarting) the development server.
- `npm run lint` and `npm run build` pass, and every validation suite is
  green on render.
- This is prototype software for sandbox demonstration, not a production
  payments system.
