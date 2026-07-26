# DueLogic
## Final product, build and polish scope, version 8

**Status:** Final source of truth as at 26 July 2026

- **Repository:** `iconic-marketing/duelogic`
- **Default branch:** `main`
- **Authoritative repository state:** Latest clean `main` state after the assigned-billing-cycle safeguard, README policy clarification and supporting documentation updates
- **Current phase:** Hackathon MVP complete. The public repository and judge-facing README are prepared; submission filming and polish week remain.

---

## 0. Authority, purpose and supersession

Version 8 is the authoritative DueLogic product and build scope. It supersedes versions 1 to 7 wherever they conflict with this document.

Version 8 reconciles:

- the original product strategy and defensibility rules
- the completed deterministic detector, policy and replay layers
- merchant policy versioning and activation
- the customer-led invitation architecture
- the three structured customer movement choices
- permanent and temporary execution safeguards
- OTP verification and final confirmation
- the completed live permanent Pinch replacement
- the deterministic temporary customer-journey proof
- the simulated customer email and SMS delivery channels
- the final hackathon demo boundary
- the full polish-week work plan

### 0.1 Decisions that supersede earlier scopes

The following are final:

1. **The customer journey is structured, not free-text.**
   - The MVP does not use a customer-facing AI agent or chat box.
   - The customer chooses from server-derived movement options.
   - Deterministic code controls availability, evaluation and execution.

2. **There are three customer-facing movement choices.**
   - Move this payment only.
   - Change this and future payments.
   - Keep this payment and change future payments.

3. **The merchant does not approve routine eligible requests.**
   - The merchant configures policy, reviews analysis, monitors results and handles exceptions.
   - DueLogic automatically invites, evaluates, verifies and executes routine eligible requests.

4. **Customer identity verification is required before final execution.**
   - The invitation link is delivered through the customer communication channel.
   - A six-digit OTP is delivered through a separate SMS channel.
   - Final confirmation remains a separate customer action after OTP verification.

5. **The policy snapshot bound to the intervention is authoritative.**
   - Later policy activation cannot alter a pending invitation.
   - The policy that produced the opportunity is the policy that governs the request.

6. **Rolling usage windows use the final approved boundary.**

   ```text
   executedDate > evaluationDate - 12 months
   and
   executedDate <= evaluationDate
   ```

   The lower boundary is exclusive. The evaluation date is inclusive.

7. **The current merchant-editable policy field is the amount ceiling.**
   - The other MVP rules are fixed, visible and versioned.
   - Broader rule editing belongs in polish week.

8. **Process-local records are acceptable for the hackathon MVP only.**
   - They must never be represented as durable.
   - Database persistence is the highest-priority production-hardening task.

9. **The permanent customer-led path is live-proven through Pinch.**
   - OTP, atomic verification claim, confirmation, recovery write, cancellation, replacement and read-back verification all completed successfully.

10. **The temporary customer-led path is fully implemented and deterministically validated.**
    - The underlying Pinch one-payment update contract was proven live earlier.
    - The final OTP-gated customer journey has not yet been run as a controlled live temporary mutation.

11. **The submission video does not need to repeat a destructive Pinch mutation.**
    - It may use the already completed live operation and current Pinch state as proof.
    - Previously captured evidence must be identified accurately.
    - Deterministic fixture execution must never be described as a fresh live Pinch mutation.

12. **Every revised date remains inside the billing cycle assigned to the affected payment.**
    - Temporary and permanent paths use trusted cycle metadata.
    - For monthly cadence, containment means the same merchant-local calendar month and year.
    - For weekly and fortnightly cadence, the trusted seven-day or fourteen-day assigned cycle governs, even when that cycle crosses a calendar-month boundary.
    - The rule prevents DueLogic from shifting an affected instalment into a later assigned cycle. It does not by itself prove compliance with every merchant contract.

13. **The temporary five-day limit and assigned-cycle limit apply together.**
    - Near a cycle boundary, fewer than five later dates may be available.
    - If no later compliant date remains, the temporary option is removed server-side.
    - Missing or malformed cycle metadata fails closed throughout availability, binding and execution.

14. **The repeatable demo is prepared locally through a development-only Demo Setup page.**
    - One preparation creates five labelled scenarios and fresh invitation links.
    - Preparation makes no Pinch requests, issues no OTP and performs no payment mutation.
    - Process-local demo records are recreated after a Node restart.

15. **The public repository is the authoritative submission artefact.**
    - The full repeatable demo runs locally through `next dev`.
    - A production deployment is not represented as the complete demo environment.

---

# Part I. Product definition

## 1. What DueLogic is

### 1.1 Authoritative claim

**Value arrives before configuration.** DueLogic first reviews a merchant's existing payment book to identify recurring timing-linked payment patterns. The merchant then reviews a pre-filled flexibility policy, tests it against historical activity and activates it after seeing the expected consequences.

> Payment recovery tools concentrate on what happens after a payment fails. DueLogic identifies recurring timing-linked patterns in a merchant's existing payment book, applies a merchant-controlled flexibility policy and gives eligible customers a governed way to move one payment or correct their future schedule before another failure.

### 1.2 Defensible positioning

Do not claim that DueLogic invented billing-date optimisation or that no other platform allows billing anchors, payment rescheduling or customer-selected dates.

DueLogic's defensible position is the combination of:

1. merchant payment-book diagnosis
2. inspectable timing-pattern evidence
3. historical policy replay before activation
4. versioned deterministic eligibility
5. automated customer invitation
6. structured customer scope selection
7. a governed one-payment move
8. governed permanent schedule correction
9. exact Pinch preview before confirmation
10. separate OTP verification
11. protected single-use execution
12. recovery evidence and old-to-new mapping
13. merchant monitoring and exception handling
14. separation of historical eligibility from realised outcomes

Any individual component may exist elsewhere. DueLogic combines them into one pre-failure workflow.

### 1.3 The problem

Payment-date and active-plan changes are commonly merchant-assisted operations. A payer contacts the merchant, a staff member interprets the request, applies informal rules and either moves one payment or rebuilds the recurring schedule.

That process creates:

- avoidable support contact
- inconsistent decisions
- delay while a payment approaches processing
- weak evidence of what was requested and approved
- operational risk during subscription cancellation and replacement
- repeated temporary changes without recognition of an underlying schedule mismatch

DueLogic turns the merchant's informal rules into a visible and versioned policy, identifies customers for whom schedule flexibility is worth offering, evaluates requests consistently and records the complete outcome.

### 1.4 Product boundary

#### Pinch owns

- the payer
- tokenised payment source
- payment rail
- Payment
- Plan
- Subscription
- payment and subscription lifecycle
- calculated-payment schedule
- transaction result and webhook events

#### DueLogic owns

- payment-book diagnosis
- timing-pattern evidence
- merchant policy and policy versions
- historical replay
- invitation eligibility
- tokenised customer communication
- customer movement choice
- deterministic decision and explanation
- exact preview orchestration
- OTP verification
- final confirmation
- protected execution orchestration
- operation evidence
- recovery state
- old-to-new mapping
- merchant monitoring
- escalation and manual-recovery routing
- realised-outcome comparison

### 1.5 Stage line

> DueLogic never touches money. Pinch does. DueLogic determines which schedule changes the merchant permits, records the customer's verified decision, writes that decision into Pinch and verifies what happened.

### 1.6 Who it is for

**Initial buyer:** vertical SaaS platforms that use Pinch to manage recurring payments for service businesses.

Recurring-collection businesses remain the end-merchant users and may also become direct buyers later.

Relevant sectors include:

- gyms and memberships
- allied health
- education and training
- childcare
- managed services
- equipment servicing
- professional retainers
- other contracted recurring services

**Users:**

- merchant administrator or operations team
- customer or payer reviewing a schedule option
- merchant staff handling escalations or recovery cases

**Why they pay:**

- fewer repeated support contacts
- a consistent and explainable decision process
- earlier intervention before a payment fails
- governed customer self-service
- reduced manual schedule reconstruction
- evidence for confirmation, execution and recovery
- clearer visibility into which customer schedules may warrant correction

---

## 2. Current MVP status

### 2.1 Overall status

The hackathon MVP is functionally complete and ready to demonstrate.

| Capability | Current status |
|---|---|
| Managed-merchant Pinch architecture | Complete |
| Payment-book diagnosis | Complete |
| Deterministic timing-pattern detector | Complete |
| Historical policy replay | Complete |
| Merchant policy activation and history | Complete |
| Automatic scheduled intervention scan | Complete |
| Tokenised invitation generation | Complete |
| Simulated customer email delivery | Complete |
| Structured customer movement choices | Complete |
| Temporary policy evaluation | Complete |
| Permanent policy evaluation | Complete |
| Exact permanent Pinch preview | Complete |
| Separate SMS OTP flow | Complete |
| Atomic single-use verification claim | Complete |
| Separate final customer confirmation | Complete |
| Protected temporary execution backend | Complete and deterministically validated |
| Assigned-billing-cycle safeguard | Complete for temporary and permanent modes; 25 deterministic assigned-cycle scenarios pass |
| Protected permanent replacement | Complete and live-proven |
| Recovery write-before-cancel | Complete and live-proven |
| Old-to-new Subscription mapping | Complete and live-proven |
| Merchant monitoring | Complete at MVP level |
| Manual-recovery state | Complete at MVP level |
| Repeatable Demo Setup | Complete with five labelled scenarios and no Pinch calls during preparation |
| Presentation-flow alignment | Complete across dashboard, demo setup, email, SMS and customer review pages |
| Public repository and judge-facing README | Complete |
| Durable persistence | Deferred to polish week |
| Real email and SMS delivery | Deferred to polish week |
| Production scheduler | Deferred to polish week |
| Production authentication | Deferred to polish week |

### 2.2 Proof boundary

#### Live-proven through Pinch

- managed-merchant authentication and reads
- scheduled Payment creation
- nonce replay protection
- one-payment date update and read-back
- webhook capture and visible outcome
- monthly Subscription preview and replacement
- weekly Subscription preview and replacement
- fortnightly Subscription preview and replacement
- recovery snapshot written and read back before cancellation
- protected customer-led permanent replacement with OTP and final confirmation
- cancellation of the original Subscription
- creation of one replacement Subscription
- read-back verification of the exact replacement schedule
- old-to-new Subscription mapping

#### Deterministically proven with fakes and process-local fixtures

- all three customer movement choices
- movement availability under the bound policy
- temporary alternative acceptance
- temporary OTP binding
- temporary transaction verification
- temporary customer confirmation
- protected temporary execution ordering
- temporary read-back verification behaviour
- temporary usage-history derivation
- temporary assigned-cycle containment at availability, preview binding and pre-claim execution
- monthly same-calendar-month-and-year containment
- weekly and fortnightly trusted-cycle containment, including calendar-month crossings
- fail-closed handling for missing, malformed and one-sided cycle metadata
- cross-kind replay resistance
- permanent current-cycle and next-cycle customer-choice dispatch
- customer-safe executed, escalation and recovery states

#### Not yet live-proven as a complete customer-led Pinch operation

- temporary move from customer invitation through OTP and final confirmation into a live scheduled Pinch Payment

This live temporary test is a polish-week validation task, not a hackathon-demo blocker.

### 2.3 Known MVP limitations

- intervention, notification, OTP, confirmation and operation stores are process-local
- a server restart clears current in-memory records
- email and SMS delivery are simulated
- scheduled scans are demonstrated through development controls rather than production scheduling
- merchant authentication and multi-tenant access controls are not production-ready
- only the amount ceiling is editable in the current merchant policy UI
- OTP attempt limits and resend throttles are not implemented
- the temporary customer path has not completed its final controlled live Pinch run
- later realised-payment outcomes are not yet durably correlated into long-term reporting
- the complete repeatable demo is localhost-only; a production deployment is not the complete demonstration environment

---

# Part II. Design and governance principles

## 3. Authoritative design principles

### 3.1 Deterministic code has authority

No language model decides eligibility, dates, warnings or execution.

Deterministic code:

- resolves the bound policy
- calculates availability
- evaluates selected dates
- returns the exact rule fired
- controls whether OTP can be issued
- controls whether final confirmation can execute
- selects the protected execution path

A future model may explain a deterministic result. It must never invent or override one.

### 3.2 Act before failure

The normal workflow runs while a Payment or Subscription remains operationally changeable.

Post-failure collections, dunning, hardship support and retry optimisation are separate products or workflows.

### 3.3 Preserve the customer's chosen scope

The customer chooses one exact scope:

- one payment only
- current payment and future schedule
- future schedule beginning next cycle

DueLogic must never silently widen a temporary request into a permanent change or convert a next-cycle request into a current-cycle change.

### 3.4 A pattern can trigger an invitation, not a mutation

Historical timing evidence may justify inviting a customer to review options.

It may never automatically alter a Payment or Subscription.

### 3.5 Give a real alternative where policy permits one

- A temporary request beyond the maximum shift returns the furthest permitted date.
- An unavailable current-cycle permanent date may return a valid next-cycle alternative.
- The customer must explicitly accept the alternative before OTP verification.

### 3.6 Never assert causation

DueLogic identifies a timing-linked payment pattern. It does not claim why the pattern occurred.

Do not infer:

- payday
- employment
- income
- affordability
- financial hardship
- borrowing
- cash-flow cause

### 3.7 No risk scoring or customer profiling

Eligibility uses transparent inputs:

- amount
- explicit arrears input
- prior verified uses
- requested movement type
- requested date
- Plan cadence mapping
- cycle boundaries
- live Pinch status

### 3.8 This is not hardship assessment or credit decisioning

DueLogic applies a schedule policy to an existing service arrangement. It does not assess capacity to pay or make a regulated credit decision.

### 3.9 Replay is counterfactual, not realised savings

Historical replay reports what would have been eligible under the stated policy and assumptions.

Use wording equivalent to:

> Assuming eligible customers requested and accepted the permitted change, and the rescheduled payment later succeeded, the displayed historical dishonours may have been avoided. The replay cannot know whether a customer would have requested, accepted or succeeded on a different schedule.

Never describe replay as:

- proven savings
- prevented losses
- recovered revenue
- guaranteed reduction in dishonours

### 3.10 Policy and execution remain separate

The policy engine decides merchant-policy and calendar eligibility.

The execution layer separately re-reads the live Pinch object immediately before mutation and confirms that it is still operationally changeable.

### 3.11 The bound policy snapshot governs execution

An intervention stores the exact policy version that produced it.

A later policy activation must not change:

- movement availability
- selected date evaluation
- amount ceiling
- usage limits
- warnings
- execution expectations

for an already-issued invitation.

### 3.12 Pinch is authoritative for payment state and permanent schedules

DueLogic may calculate permitted date windows locally from the merchant's trusted Plan configuration.

Pinch remains authoritative for:

- current Payment state
- Payment identity and amount
- Subscription state
- Plan-generated replacement schedule
- final read-back result

DueLogic must not present a locally generated permanent schedule as authoritative.

### 3.13 Every revised payment stays inside its assigned billing cycle

Every temporary or permanent revised date must remain inside the billing cycle assigned to the affected payment.

For monthly cadence:

- the assigned cycle is the full merchant-local calendar month
- the revised date must remain in the same calendar month and year as the original scheduled Payment
- a January payment cannot become a February payment
- a December payment cannot become a January payment

For weekly and fortnightly cadence:

- trusted merchant Plan configuration defines the seven-day or fourteen-day assigned cycle
- containment follows that assigned cycle even when it crosses a calendar-month boundary
- cadence and cycle boundaries are never inferred from observed payment spacing

For temporary movement, the five-calendar-day cap applies in addition to cycle containment. Near a cycle boundary, the permitted window is shortened. If no later compliant date remains, the temporary option is unavailable.

This avoids silently:

- adding or removing a billing cycle
- shifting an obligation into a later assigned period
- extending a fixed schedule through an automatic date move
- creating an unintended extra payment

This control prevents DueLogic from moving the affected instalment beyond its assigned cycle. Contractual end dates, remaining instalment counts and other agreement-specific boundaries remain separate production controls unless verified from authoritative source data.

### 3.14 Close-payment spacing is a warning

A compressed gap is not automatically rejected.

The customer sees:

- the two adjacent dates
- the exact gap
- the resulting schedule
- a warning before confirmation

The customer must explicitly acknowledge the close-payment warning before OTP verification and final confirmation can proceed. The acknowledgement is bound to the exact preview. If the movement type, selected date or resulting schedule changes, the acknowledgement is invalidated and must be obtained again.

### 3.15 OTP and final confirmation are separate controls

Possession of the review link is not sufficient for mutation.

The customer must:

1. open the tokenised link
2. bind an exact movement and preview
3. receive an OTP through the separate SMS channel
4. enter the correct OTP
5. make a separate final confirmation

### 3.16 Verification is bound to the exact operation

The verification expectation includes the exact operation identity and values.

Changing any bound movement detail requires a new preview and verification.

A verification for a temporary move cannot execute a permanent change, and vice versa.

### 3.17 Verification and confirmation are single-use

- verification claims are atomic
- confirmation records are write-once
- consumed verification cannot execute again
- consumed confirmation cannot execute again
- the final endpoint does not accept authoritative identifiers from the browser

### 3.18 Never retry an ambiguous mutation blindly

Neither temporary Payment mutation nor permanent Subscription replacement may be automatically repeated when the outcome is uncertain.

Use safe reads to establish the resulting state.

If state cannot be established, route the operation to manual recovery or investigation.

### 3.19 Record recovery information before destructive mutation

Before cancelling an active Subscription, DueLogic must:

- validate all available values
- build the original reinstatement payload
- persist the immutable operation and recovery snapshot
- read the stored record back successfully
- bind the confirmation to the operation

If the record cannot be persisted and read back, the original Subscription remains active.

### 3.20 Every decision and mutation is auditable

Record, as applicable:

- intervention identity
- customer-selected movement type
- requested date
- accepted alternative date
- policy version
- rule fired
- warnings
- preview shown
- OTP verification
- customer acceptance
- confirmation record
- operation record
- original Pinch identifier
- replacement identifier
- mutation stage
- read-back state
- recovery availability
- final status
- later outcome

### 3.21 Evidence types must remain distinct

The interface and presentation must distinguish:

- synthetic checked-in history
- deterministic process-local fixture data
- live Pinch sandbox data
- previously captured live sandbox evidence
- production data, when introduced

### 3.22 Customer-facing pages expose no internal identifiers

Do not expose:

- payer ID
- merchant ID
- source ID
- Payment ID
- Subscription ID
- Plan ID
- policy JSON
- token hash
- operation internals

### 3.23 The merchant handles exceptions, not routine approvals

The merchant:

- configures and activates policy
- reviews analysis and opportunity figures
- monitors results
- handles escalations
- handles manual-recovery cases

The merchant does not approve each routine eligible customer request.

---

# Part III. End-to-end workflow

## 4. Authoritative product workflow

### 4.1 Merchant workflow

The merchant:

1. connects or is represented through the Pinch managed-merchant architecture
2. reviews the payment-book diagnosis
3. reviews exact timing-pattern evidence
4. reviews a pre-filled policy
5. adjusts the automatic amount ceiling in the current MVP
6. replays the active candidate policy against history
7. activates the policy
8. monitors invitations, executions and exceptions
9. handles merchant-review and manual-recovery cases

### 4.2 DueLogic workflow

DueLogic automatically:

1. reviews the merchant's payment book
2. detects qualifying timing-linked patterns
3. resolves an upcoming relevant Payment or Subscription
4. applies the active merchant policy
5. determines whether an invitation is appropriate
6. binds the exact policy version
7. creates a short-lived tokenised invitation
8. delivers the invitation through the configured customer communication channel
9. derives the movement options permitted for that intervention
10. evaluates the customer's movement type and selected date
11. returns approval, alternative, escalation or configuration handling
12. retrieves the authoritative payment context or Pinch permanent preview
13. presents exact dates and amounts
14. issues an OTP to the trusted mobile channel
15. creates a write-once verification record after the correct OTP
16. executes only after separate final customer confirmation
17. records confirmation and operation evidence
18. performs authoritative read-back verification
19. updates the intervention and merchant monitoring view
20. routes ambiguous or failed cases to the correct exception state

### 4.3 Customer workflow

The customer:

1. receives the invitation
2. opens the secure tokenised link
3. sees only movement types currently permitted
4. selects a movement type
5. selects a permitted date
6. receives an approved, alternative or review-required result
7. reviews the exact payment outcome
8. accepts any offered alternative explicitly
9. requests an OTP
10. enters the OTP sent to the trusted mobile number
11. gives separate final confirmation
12. receives a verified final result or customer-safe review message

---

# Part IV. Payment-book diagnosis

## 5. Deterministic timing-pattern detector

### 5.1 Purpose

The detector identifies customers whose historical activity contains a recurring timing-linked pattern worth testing against the merchant's flexibility policy.

It does not diagnose a cause.

### 5.2 Qualifying pattern

A payer is flagged only when:

1. at least two payments in the rolling lookback have:
   - outcome `dishonoured`
   - dishonour reason `insufficient-funds`
2. those qualifying dishonours cluster by:
   - day of month inside one inclusive four-day non-wrapping window, or
   - exact weekday with at least two occurrences
3. at least one clustered dishonour has:
   - an approved retry or later approved settlement
   - a valid later date
   - a later date outside the full selected cluster window

### 5.3 Exclusions

Do not treat these as timing-linked evidence:

- blocked-by-bank
- expired or invalid payment method
- closed account
- unrelated one-off dishonour
- insufficient-funds without later successful-settlement evidence
- events outside the lookback

### 5.4 Deterministic requirements

- default lookback: 12 months
- default minimum qualifying dishonours: 2
- default day-of-month window: 4 inclusive days
- explicit `asOfDate`, or stable anchoring to supplied records
- no `Date.now()` in deterministic validation
- no server-timezone influence
- no input mutation
- stable output ordering
- stable flag identities
- input-order invariance

### 5.5 Day-of-month window semantics

Evaluate non-wrapping windows only.

Examples:

- 25 to 28 is valid
- 28 to 31 is valid
- 30 to 2 is invalid

The evidence stores the full selected window, not only the observed member days.

### 5.6 Tie-breaking

#### Day of month

1. highest qualifying dishonour count
2. highest approved later-settlement evidence count
3. narrowest observed member-day span
4. earliest selected window start

#### Day of week

1. highest qualifying dishonour count
2. highest approved later-settlement evidence count
3. Monday through Sunday order

#### Pattern basis

1. highest qualifying dishonour count
2. highest approved later-settlement evidence count
3. day of month on an exact tie

### 5.7 Proposed shift

- collect positive later-settlement delays from qualifying evidence
- sort them
- use the median
- for an even count, use the lower middle
- minimum proposed shift: 1 day

The proposed shift is a date worth testing. It is not a claim that the historical failure would have been prevented.

### 5.8 Checked-in validation history

The current deterministic history contains:

- 8 payers
- 96 payments
- 14 dishonours
- 11 insufficient-funds dishonours
- 2 deliberately planted recurring timing-linked patterns

Expected flagged payers:

- `payer-01`, proposed shift 4 days, monthly window 25 to 28
- `payer-02`, proposed shift 5 days, monthly window 24 to 27

Synthetic history must remain labelled in the interface.

### 5.9 Whole-book classification

DueLogic may classify the broader payment book into:

- timing-linked patterns eligible for DueLogic analysis
- payment-method or data faults handled elsewhere
- isolated events without a recurring pattern

The MVP acts on the timing-linked category only.

A fuller dishonour-cause summary remains optional polish. Do not build remediation for payment-method faults into DueLogic.

---

# Part V. Merchant policy, plan configuration and replay

## 6. Merchant policy model

### 6.1 Policy lifecycle

A policy is:

- merchant-scoped
- declarative
- versioned
- replayable
- activated explicitly
- immutable once bound to an intervention

The merchant can inspect:

- active version
- activation time
- amount ceiling
- fixed MVP rules
- previous versions
- replay and opportunity effects

### 6.2 Current MVP editability

The current merchant UI allows the merchant to change:

- automatic amount ceiling

The following rules are implemented and versioned but fixed in the current UI:

- temporary enablement
- temporary maximum uses
- temporary rolling period
- temporary maximum shift
- permanent enablement
- permanent maximum uses
- permanent rolling period
- supported cadences
- monthly anchor range
- cycle-containment requirement
- close-payment warning thresholds
- arrears escalation
- unsupported-Plan handling

Broader editing is a polish-week task.

### 6.3 Default policy

```ts
{
  version: "duelogic-default-v1",

  amountCeilingCents: 50000,

  temporaryChange: {
    enabled: true,
    maxVerifiedUses: 2,
    rollingPeriodMonths: 12,
    maxShiftDays: 5
  },

  permanentChange: {
    enabled: true,
    maxVerifiedUses: 1,
    rollingPeriodMonths: 12,

    supportedCadences: [
      "weekly",
      "fortnightly",
      "monthly"
    ],

    keepPaymentWithinAssignedCycle: true,

    cycleLengthDays: {
      weekly: 7,
      fortnightly: 14
    },

    monthlyAnchorDay: {
      minimum: 1,
      maximum: 28
    },

    allowSameDayCurrentCycleChange: false,

    closePaymentWarningDays: {
      weekly: 3,
      fortnightly: 5,
      monthly: 7
    },

    closePaymentAction: "warn-and-confirm",
    unsupportedCadenceAction: "escalate",
    overLimitAction: "escalate"
  },

  arrears: {
    disqualifyWhenCurrentArrearsCentsAbove: 0,
    action: "escalate"
  }
}
```

All Pinch monetary values are cents internally. Convert only for display.

### 6.4 Rolling usage

Temporary and permanent counters are separate.

Count only prior changes where:

- merchant matches
- payer matches
- change type matches
- final status is completed and read-back verified
- execution date satisfies:

  ```text
  executedDate > evaluationDate - rollingPeriod
  and
  executedDate <= evaluationDate
  ```

Do not count:

- previews
- invitations
- OTP verification alone
- acceptance alone
- refused operations
- abandoned operations
- execution failures
- ambiguous unverified operations
- manual-recovery-required operations
- the other movement category
- another payer
- records outside the window

### 6.5 Rule precedence

1. validate policy
2. validate request
3. validate cycle metadata where required
4. validate history
5. calculate verified usage
6. apply explicit arrears rule
7. apply amount ceiling
8. apply relevant usage limit
9. apply supported cadence rule
10. apply schedule-specific rules
11. calculate warnings
12. approve or offer a permitted alternative

Consequences:

- malformed input is not reframed as a policy escalation
- explicit arrears wins over amount, usage and alternatives
- amount wins over usage and alternatives
- usage limits win over alternatives and warnings
- warnings appear only after blocking rules pass

---

## 7. Merchant Plan schedule configuration

### 7.1 Purpose

Pinch Plan and Subscription responses do not provide the trusted cadence context DueLogic requires for cycle-boundary policy decisions.

The merchant therefore maintains a merchant-scoped Plan-to-schedule mapping.

### 7.2 Supported definitions

Each exact merchant and Plan ID maps to:

- weekly, with a seven-day cycle anchor
- fortnightly, with a fourteen-day cycle anchor
- monthly, using full calendar months

### 7.3 Rules

- cadence must never be guessed from payment spacing
- an unmapped Plan escalates for merchant review
- malformed configuration is a configuration error
- missing, malformed or one-sided assigned-cycle metadata fails closed in customer availability, preview binding and execution
- a mapped Plan whose observed context contradicts configuration returns a schedule-context mismatch
- policy values and Plan schedule definitions remain separate

### 7.4 Supported MVP cadences

- weekly
- fortnightly
- monthly

### 7.5 Unsupported cadence handling

Known but unsupported cadences, including four-weekly or custom schedules, route to merchant review.

They are not silently converted to a supported cadence.

---

## 8. Historical replay and merchant opportunity

### 8.1 Purpose

Replay applies the same deterministic policy engine to historical requests or constructed historical scenarios.

### 8.2 Replay outputs

Report separately:

1. historical payments eligible for temporary flexibility
2. customers eligible for invitation to review a permanent correction
3. requests that would receive a shorter temporary alternative
4. requests that would receive a next-cycle permanent alternative
5. requests that would escalate
6. requests that would trigger a close-payment warning
7. customers who would reach a usage limit
8. fees associated with eligible transactions, labelled as exposure only

### 8.3 Required assumption wording

The replay assumption must be visible near the figures, not hidden in a footnote.

Use wording equivalent to:

> Assuming eligible customers requested and accepted the permitted change, and the rescheduled payment later succeeded, the displayed historical dishonours may have been avoided. The replay cannot know whether a customer would have requested, accepted or succeeded on a different schedule.

### 8.4 Activation behaviour

- replay uses the candidate policy
- activation creates a new immutable policy version
- scheduled scanning uses the active saved policy
- generated invitations bind that policy version
- later activation does not change pending invitations

---

# Part VI. Invitation and customer entry

## 9. Automatic intervention scanning

### 9.1 Current MVP behaviour

The scheduled scan logic:

1. reviews upcoming payment context
2. identifies a qualifying timing-linked pattern
3. applies the active merchant policy
4. resolves the exact payer and relevant Payment or Subscription context
5. creates an intervention
6. binds the policy version
7. generates a secure token
8. writes a customer notification

The hackathon uses a development scan control. Production scheduling is a polish-week task.

### 9.2 Reminder timing

Default intended reminder timing:

```text
7 days before the upcoming payment
```

The reminder invites review. It does not promise approval.

### 9.3 Intervention status model

The customer-led flow uses states equivalent to:

- invitation-created
- awaiting-selection
- evaluating
- alternative-offered
- preview-ready
- executing
- executed
- escalated or policy-review-required
- manual-recovery-required
- expired

The exact code status names remain authoritative where they differ.

---

## 10. Simulated customer email

### 10.1 Current delivery channel

For the hackathon MVP, DueLogic delivers invitation notifications through:

```text
/dev/duelogic/inbox
```

The page is titled:

> Development Customer Email Inbox

### 10.2 Email presentation

Each invitation is presented as a simulated email showing:

- From: DueLogic
- To: Customer email on file, unless a safe masked address exists
- Subject: Review an alternative payment date
- sent time in Australia/Sydney
- current payment amount and date where safe
- customer-facing explanation
- Review payment schedule button
- link expiry
- Development simulation label outside the email body

### 10.3 Email copy

Use wording equivalent to:

> An upcoming payment may be eligible for an alternative date.
>
> Review the available option and the exact payment dates and amounts before making your decision. No change will be made unless you complete verification and give final confirmation.

### 10.4 Security

- the raw token is not printed as visible text
- the full review URL is not shown as copy
- internal identifiers are not shown
- OTP codes are never shown in the email inbox
- rendering the inbox does not regenerate an invitation
- rendering the inbox does not call Pinch

### 10.5 Production direction

Production delivery may use:

- an email provider
- the merchant's communications platform
- an authenticated customer portal

The secure invitation channel remains separate from the SMS OTP channel.

---

## 11. Tokenised review link

### 11.1 Route

Current route:

```text
/review/[token]
```

### 11.2 Token properties

- bearer credential
- generated with sufficient entropy
- stored or compared safely
- scoped to one intervention
- short-lived
- cannot list other customer records
- does not expose payment-source details
- becomes non-executable after expiry or terminal execution

### 11.3 Customer page progression

The page can render:

- movement-choice state
- date-selection state
- approved preview
- alternative offer
- merchant-review message
- OTP request and entry
- final confirmation
- executed temporary result
- executed permanent result
- manual-recovery or ambiguous result

---

# Part VII. Movement availability and policy decisions

## 12. Server-derived movement availability

### 12.1 Movement types

The authoritative discriminated values are:

```text
temporary
permanent-current-cycle
permanent-next-cycle
```

### 12.2 Customer-facing labels

#### Temporary

**Move this payment only**

> Choose a later date for this upcoming payment within its current billing cycle. Your regular payment schedule will stay the same.

#### Permanent current cycle

**Change this and future payments**

> Move the upcoming payment and use the new date for future payments.

#### Permanent next cycle

**Keep this payment and change future payments**

> Leave the upcoming payment unchanged and begin the new regular payment date from the next billing cycle.

### 12.3 Availability inputs

Availability is calculated server-side using:

- bound policy snapshot
- amount
- explicit arrears input
- verified prior temporary history
- verified prior permanent history
- trusted Plan cadence mapping
- current and next cycle boundaries
- evaluation date
- current Payment or Subscription context
- detector suggestion where relevant

### 12.4 Availability states

The page may show:

- temporary only
- both permanent modes
- temporary plus one or both permanent modes
- permanent only after the temporary limit is reached
- next-cycle permanent only when current-cycle movement is no longer available
- no executable option, requiring merchant review

A permanent-current-only state is not expected under the approved rules because a valid current-cycle option generally coexists with a valid next-cycle option.

### 12.5 Suggested label

Where detector evidence supports it, a permanent option may show:

> Suggested based on your recent payment changes

The label is informational. It is never mandatory.

---

# Part VIII. Temporary payment movement

## 13. Temporary movement rules

### 13.1 Meaning

A temporary movement changes one existing scheduled Payment.

- one Payment changes
- later recurring payments remain unchanged
- the Pinch Payment ID remains the same
- no Subscription replacement occurs

### 13.2 Date and assigned-cycle rule

A temporary proposed date must:

- be strictly later than the authoritative current Payment date
- be no more than five calendar days later
- remain inside the billing cycle already assigned to that Payment
- use merchant-local calendar semantics

For monthly cadence, the proposed date must remain in the same calendar month and year as the original Payment.

For weekly and fortnightly cadence, the trusted assigned cycle governs even where it crosses a month boundary.

Examples:

```text
Current date: 10 August
Assigned monthly cycle: 1 to 31 August
Permitted automatic dates: 11 to 15 August
```

```text
Current date: 29 August
Assigned monthly cycle: 1 to 31 August
Permitted automatic dates: 30 to 31 August
September dates: unavailable
```

```text
Current date: 31 August
Assigned monthly cycle: 1 to 31 August
Permitted automatic dates: none
Temporary option: unavailable
```

Earlier dates are unavailable in the current temporary policy.

### 13.3 Shorter alternative and no-date handling

The furthest permitted alternative is the earlier of:

- the current Payment date plus the policy maximum shift
- the end of the assigned billing cycle

Example:

```text
Current date: 29 August
Requested: 3 September
Five-day cap: 3 September
Assigned-cycle end: 31 August
Outcome: shorter-alternative
Offered date: 31 August
```

The offered date must be explicitly accepted before binding and OTP verification.

If the original Payment is already on the final day of its assigned cycle, no later compliant date exists and the temporary option is removed server-side.

### 13.4 Other automatic conditions

Temporary movement requires:

- temporary movements enabled
- amount at or below the bound policy ceiling
- no explicitly supplied positive current arrears
- fewer than two completed and verified temporary movements in the rolling 12-month window
- trusted assigned-cycle metadata is present, valid and contains the original Payment date
- the selected date remains inside that assigned cycle
- live Payment status `scheduled` immediately before mutation

Do not infer arrears from history.

### 13.5 Temporary preview

Show:

- current date
- new date
- exact amount
- statement that later recurring payments remain unchanged
- assigned-cycle explanation, including same-calendar-month wording for monthly cadence

Use wording equivalent to:

> Your payment can be moved later within its current billing cycle, up to five calendar days from its current date.

For monthly cadence, also state:

> The revised date must remain within the same calendar month.

> Only this payment will move. Your regular payment schedule will continue after it.

Do not show Subscription replacement terminology.

---

## 14. Temporary operation binding and security

### 14.1 Stored operation selection

The temporary selection binds:

- kind `temporary`
- intervention ID
- merchant ID
- payer ID
- Payment ID
- original transaction date
- proposed transaction date
- exact amount in cents
- currency where available
- authoritative current-cycle start and end from the intervention
- trusted cadence context where available
- bound policy version
- policy result
- requested date
- accepted alternative date where applicable
- creation time
- expiry

The browser does not supply authoritative identifiers at final confirmation.

### 14.2 Temporary OTP binding

The OTP challenge is bound to:

- intervention
- movement kind
- Payment ID
- original date
- proposed date
- amount
- policy version
- trusted mobile fingerprint
- challenge expiry

### 14.3 Temporary transaction verification

The write-once verification record binds the same operation details and records:

- verification ID
- verified time
- expiry
- consumed time

The atomic claim fails on any mismatch.

### 14.4 Temporary customer confirmation

The confirmation record includes:

- confirmation ID
- intervention
- merchant and payer
- Payment
- original date
- confirmed date
- amount
- policy version
- accepted time
- consumed time
- operation ID
- final confirmation state

### 14.5 Temporary operation record

Record:

- operation ID
- confirmation ID
- payment identity
- original and proposed dates
- amount
- policy version
- preflight state
- mutation state
- read-back state
- failure stage
- verified date
- final status

Supported result categories include:

- temporary-change-verified
- refused-before-mutation
- temporary-change-ambiguous
- manual-recovery-required

---

## 15. Protected temporary execution

### 15.1 Required ordering

1. reload intervention
2. require preview-ready, unexpired and non-terminal
3. resolve the bound temporary selection
4. require movement kind `temporary`
5. resolve the immutable policy snapshot
6. freshly read the authoritative Pinch Payment
7. require status exactly `scheduled`
8. require Payment ID, date and amount to match the binding
9. re-validate the bound policy shift cap
10. re-validate that the original and proposed dates are inside the intervention's stored assigned-cycle bounds
11. refuse missing, malformed, stale or next-cycle selection before any claim or effect
12. atomically claim the exact transaction verification
13. create the temporary confirmation record
14. record customer acceptance
15. create and read back operation evidence before mutation
16. consume confirmation and bind operation ID
17. invoke the Payment mutation exactly once
18. read the Payment back
19. verify the Payment ID is unchanged
20. verify the confirmed transaction date persisted
21. verify the amount remains correct where available
22. mark the operation verified
23. write confirmation and operation linkage to the intervention
24. set the intervention executed only after read-back verification

### 15.2 Mutation service

The reusable temporary movement service:

- performs authoritative pre-read
- requires `scheduled`
- validates expected identity, date and amount
- sends one update using the existing Payment ID
- does not automatically retry
- performs read-back
- returns a typed verified, refused or ambiguous result

### 15.3 Refusal before mutation

Examples:

- Payment no longer scheduled
- original date changed
- amount changed
- intervention expired
- policy snapshot unavailable
- assigned-cycle metadata missing, malformed or inconsistent
- original or proposed date outside the assigned cycle
- verification expired
- bound selection mismatch

Requirements:

- no Payment update
- no retry
- customer-safe response
- evidence retained where applicable
- merchant review when required

### 15.4 Ambiguous result

- never repeat the update blindly
- use GET to establish the current Payment state
- exact confirmed date on read-back may prove success
- exact unchanged state may prove a known rejection
- unresolved state becomes ambiguous or manual recovery
- no customer retry control

### 15.5 Usage evidence

Only a `temporary-change-verified` operation with verified read-back becomes temporary usage history.


### 15.6 Assigned-cycle failure semantics

The temporary customer journey fails closed when trusted cycle metadata is unavailable or invalid.

The following must refuse before mutation:

- blank or malformed cycle start or end
- only one cycle bound supplied
- malformed original or proposed transaction date
- cycle start later than cycle end
- original Payment outside the stored cycle
- proposed date outside the stored cycle
- proposed date not strictly later than the original date
- proposed date beyond the bound five-calendar-day cap
- a stale binding that no longer satisfies the cycle invariant

The final pre-claim check strictly parses the cycle start, cycle end, original transaction date and proposed transaction date with the repository's merchant-local `parseCalendarDate` utility before any comparison. `calendarDaysBetween` is used only after all four parses succeed. This prevents a malformed string from passing through lexicographic ordering.

The execution refusal reason is customer-safe. The deterministic implementation records the internal reason `selection-outside-assigned-cycle` where applicable. Refusal occurs before verification claim or consumption, confirmation creation or consumption, operation evidence and any Pinch mutation. It consumes no rolling usage.

---

# Part IX. Permanent schedule movement

## 16. Permanent movement model

A permanent movement changes the recurring schedule from a chosen cycle onward.

Pinch does not expose an update-Subscription operation for this purpose. DueLogic uses a protected cancel-and-recreate workflow.

The replacement should retain:

- merchant
- payer
- Plan
- source
- amount and commercial configuration

The Subscription ID changes.

---

## 17. Permanent policy rules

### 17.1 Common rules

Permanent movement requires:

- permanent movements enabled
- amount at or below the bound ceiling
- no explicitly supplied positive current arrears
- no prior completed and verified permanent movement inside the rolling 12-month window
- a supported and valid trusted cadence mapping

A second permanent request routes to merchant review. It is not described as a permanent prohibition.

### 17.2 Weekly cadence

- each assigned cycle contains seven inclusive calendar days
- selected current-cycle date stays inside the current cycle
- selected next-cycle date stays inside the next cycle
- future payments advance by seven days

### 17.3 Fortnightly cadence

- each assigned cycle contains fourteen inclusive calendar days
- selected current-cycle date stays inside the current cycle
- selected next-cycle date stays inside the next cycle
- future payments advance by fourteen days

### 17.4 Monthly cadence

- current cycle is the full calendar month
- next cycle is the full following calendar month
- new recurring anchor is day 1 through day 28
- future payments preserve that day of month

### 17.5 No-op rule

A permanent request must produce a real schedule change.

- current-cycle mode compares the selected date to the current Payment date
- next-cycle mode compares the selected date to the existing next Payment date
- a derived alternative must also differ from the existing schedule

---

## 18. Permanent current-cycle mode

### 18.1 Customer meaning

**Change this and future payments**

The upcoming payment moves and the new anchor continues into future cycles.

### 18.2 Rules

- selected date may be earlier or later than the current scheduled date
- selected date must stay inside the assigned current cycle
- selected date must be strictly after evaluation and execution time
- selected date must be later than the previous real payment
- same-day no-op changes are unavailable

### 18.3 Example

```text
Weekly cycle: 10 to 16 August
Original current payment: 10 August
Selected date: 12 August
Replacement schedule:
12 August
19 August
26 August
```

---

## 19. Permanent next-cycle mode

### 19.1 Customer meaning

**Keep this payment and change future payments**

The current upcoming payment remains unchanged. The replacement schedule begins in the next assigned cycle.

### 19.2 Rules

- current Payment remains unchanged
- selected anchor stays inside the next cycle
- selected anchor differs from the existing next Payment date
- replacement begins at the selected next-cycle date

### 19.3 Example

```text
Current weekly payment: 10 August, unchanged
Next cycle: 17 to 23 August
Selected anchor: 19 August
Replacement schedule:
19 August
26 August
2 September
```

---

## 20. Permanent alternatives and warnings

### 20.1 Next-cycle alternative

When the requested current-cycle date has passed or cannot create a valid positive transition, DueLogic may offer a valid next-cycle alternative.

The customer must accept the alternative explicitly.

### 20.2 Close-payment warning thresholds

Warn when the positive gap between the two real adjacent payments is below:

| Cadence | Warning threshold |
|---|---:|
| Weekly | 3 days |
| Fortnightly | 5 days |
| Monthly | 7 days |

Therefore:

- weekly gap 1 or 2 days: warning
- weekly gap 3 days: no warning
- fortnightly gap 1 to 4 days: warning
- fortnightly gap 5 days: no warning
- monthly gap 1 to 6 days: warning
- monthly gap 7 days: no warning

### 20.3 Warning semantics

The warning:

- does not reject the request
- does not automatically escalate
- identifies both adjacent dates
- states the gap
- appears before OTP and final confirmation
- requires explicit customer acknowledgement before OTP and final confirmation are enabled
- is bound to the exact movement type, selected date and Pinch preview
- is invalidated if any bound operation detail or preview changes

---

## 21. Permanent preview

### 21.1 DueLogic validation

DueLogic determines whether the selected date is inside the permitted cycle and passes merchant policy.

### 21.2 Pinch preview

Pinch calculated-payments determines the exact recurring schedule.

### 21.3 Current-cycle preview must show

- current Payment will move
- replacement start date
- exact next three Pinch dates
- amount for each date
- cadence
- close-payment warning where applicable
- statement that the existing Subscription will be replaced

### 21.4 Next-cycle preview must show

- current Payment remains unchanged
- current Payment date and amount
- replacement start date in the next cycle
- exact next three replacement dates and amounts
- cadence
- warning where applicable
- statement that the existing Subscription will be replaced

The unchanged current Payment is not presented as part of the replacement Subscription schedule.

---

## 22. Protected permanent execution

### 22.1 Required ordering

1. reload intervention
2. require preview-ready, unexpired and non-terminal
3. resolve exact stored permanent mode and preview
4. atomically claim the matching verification
5. create customer confirmation
6. record customer acceptance
7. build original reinstatement payload
8. write immutable operation and recovery snapshot
9. read the operation back successfully
10. consume confirmation and bind operation ID
11. perform fresh Pinch preflight
12. require the original Subscription remains active and exact
13. cancel the original Subscription
14. record original-cancelled stage
15. create one replacement Subscription
16. use the returned replacement Subscription ID for all later reads
17. read replacement Subscription and schedule back
18. verify Plan, payer, source, start date, dates and amounts
19. mark operation `replacement-verified`
20. write confirmation ID, operation ID and new Subscription ID to the intervention
21. set intervention executed

### 22.2 Recovery rule

If recovery evidence cannot be written and read back, stop before cancellation.

If failure occurs after cancellation and automatic correctness cannot be established:

- mark `manual-recovery-required`
- retain original reinstatement data
- retain old-to-new or partial mapping
- do not retry automatically
- surface the case to the merchant

### 22.3 Success evidence

Successful replacement records:

- original Subscription ID
- new Subscription ID
- confirmed start date
- exact confirmed preview
- exact final read-back schedule
- operation stage history
- recovery availability
- confirmation consumption ordering

---

# Part X. OTP, verification and final confirmation

## 23. OTP controls

### 23.1 Current implementation

- six-digit numeric code
- generated with `crypto.randomInt`
- HMAC-SHA256 digest using a server secret
- code itself is not stored as plaintext in the challenge store
- five-minute OTP expiry
- trusted mobile fingerprint binding
- simulated SMS delivery
- wrong-code refusal
- expired-code refusal
- reissue replaces the active challenge
- successful OTP creates a ten-minute TransactionVerificationRecord

### 23.2 Development SMS inbox

Route:

```text
/dev/duelogic/sms
```

The SMS inbox:

- contains OTP messages
- contains no review link
- is separate from the email inbox
- is process-local
- clears on server restart

### 23.3 Deferred OTP hardening

Polish week must add:

- attempt limit
- resend delay
- issue cap
- abuse monitoring
- concurrency hardening
- explicit invalidation chains
- durable persistence
- production SMS provider

---

## 24. Final-confirmation dispatcher

The final request body remains limited to:

```json
{
  "token": "<secure review token>"
}
```

The server:

1. resolves the intervention
2. resolves the stored movement kind
3. refuses unsupported or mismatched state
4. invokes exactly one protected executor

Dispatch:

```text
temporary
  -> executeTemporaryPaymentChange

permanent-current-cycle
  -> protected permanent confirmation and replacement

permanent-next-cycle
  -> protected permanent confirmation and replacement
```

The browser cannot override:

- movement kind
- Payment ID
- Subscription ID
- amount
- policy version
- exact dates
- preview schedule

No automatic retry is permitted.

---

# Part XI. Merchant monitoring and exception handling

## 25. Merchant dashboard

### 25.1 Current sections

The dashboard includes:

- merchant summary
- merchant opportunity and replay figures
- recurring payment history
- detected timing patterns
- policy configuration and activation
- active policy and history
- permanent schedule correction monitoring
- customer-led schedule correction monitoring
- development controls and validation results

### 25.2 Merchant opportunity

The dashboard should communicate:

- eligible historical activity
- number of customers with qualifying patterns
- invitation opportunity
- associated fees as exposure only
- replay assumptions
- changes when the amount ceiling changes

### 25.3 Monitoring states

At minimum, the merchant can see counts and rows for:

- invitations
- preview-ready
- executed
- merchant review or escalated
- manual recovery

### 25.4 Movement labels

Where displayed, use customer-safe movement labels:

- Temporary payment move
- Permanent schedule change

### 25.5 Merchant review

A request routes to merchant review when, for example:

- amount exceeds ceiling
- positive arrears are explicitly supplied
- temporary usage limit is reached
- permanent usage limit is reached
- Plan mapping is absent
- cadence is unsupported
- no executable option remains

The customer sees a safe message. No mutation control appears.

### 25.6 Manual recovery

Manual recovery cases retain:

- exact operation identity
- original object identity
- proposed result
- stage reached
- recovery snapshot
- current known Pinch state
- failure or ambiguity code

The customer sees no retry control.

---

# Part XII. Logical data model

## 26. Durable target model

The current hackathon implementation uses process-local repositories for several entities. The durable target model is below.

### 26.1 Merchant

```text
Merchant
  id
  name
  escalation_contact
  timezone
  status
```

### 26.2 Policy and version

```text
PolicyVersion
  id
  merchant_id
  version
  status
  activated_at
  superseded_at
  amount_ceiling_cents
  temporary_enabled
  temporary_max_verified_uses
  temporary_rolling_period_months
  temporary_max_shift_days
  permanent_enabled
  permanent_max_verified_uses
  permanent_rolling_period_months
  supported_cadences
  monthly_anchor_min_day
  monthly_anchor_max_day
  close_warning_thresholds
  arrears_threshold_cents
  policy_json
  created_at
```

### 26.3 Merchant Plan schedule configuration

```text
MerchantPlanScheduleConfiguration
  id
  merchant_id
  pinch_plan_id
  cadence
  cycle_length_days
  cycle_anchor_date
  enabled
  configured_at
  updated_at
```

### 26.4 Customer reference

```text
CustomerReference
  id
  merchant_id
  pinch_payer_id
  masked_name
  masked_email
  masked_mobile
  current_arrears_cents
  created_at
```

DueLogic does not store raw payment credentials.

### 26.5 Payment history

```text
PaymentHistory
  id
  merchant_id
  payer_id
  pinch_payment_id
  scheduled_date
  processed_date
  amount_cents
  outcome
  dishonour_reason
  retry_date
  retry_outcome
  dishonour_fee_cents
  evidence_source
  synthetic
```

### 26.6 Pattern flag

```text
PatternFlag
  id
  merchant_id
  payer_id
  pattern_type
  proposed_shift_days
  detected_as_of_date
  evidence_json
  created_at
```

### 26.7 Replay

```text
Replay
  id
  merchant_id
  policy_version
  policy_snapshot_json
  temporary_eligible_count
  permanent_review_customer_count
  alternative_count
  escalation_count
  warning_count
  associated_fees_cents
  over_limit_customer_count
  assumption_text
  run_at
```

### 26.8 Intervention

```text
Intervention
  id
  merchant_id
  payer_id
  source_id
  payment_id
  subscription_id
  plan_id
  policy_version
  status
  invitation_expires_at
  selected_movement_kind
  selected_date
  trusted_cadence
  current_cycle_start_date
  current_cycle_end_date
  next_cycle_start_date
  next_cycle_end_date
  policy_outcome
  warnings_json
  warning_acknowledged_at
  current_schedule_json
  proposed_schedule_json
  confirmation_id
  operation_id
  new_subscription_id
  verified_temporary_transaction_date
  executed_at
  created_at
  updated_at
```

### 26.9 Customer notification

```text
CustomerNotification
  id
  intervention_id
  channel
  masked_recipient
  subject
  review_token_hash
  review_path
  sent_at
  expires_at
  delivery_status
```

### 26.10 Movement selection

```text
MovementSelection
  id
  intervention_id
  kind
  policy_version
  requested_date
  accepted_alternative_date
  exact_binding_json
  preview_json
  warnings_json
  warning_acknowledged_at
  created_at
  expires_at
  invalidated_at
```

`exact_binding_json` is a strict discriminated structure, not arbitrary client data.

### 26.11 OTP challenge

```text
OtpChallenge
  id
  intervention_id
  movement_kind
  expectation_hash
  code_digest
  mobile_fingerprint
  issued_at
  expires_at
  invalidated_at
  verified_at
```

### 26.12 Transaction verification

```text
TransactionVerification
  id
  intervention_id
  movement_kind
  exact_expectation_json
  mobile_fingerprint
  verified_at
  expires_at
  consumed_at
  operation_id
```

### 26.13 Temporary confirmation

```text
TemporaryCustomerConfirmation
  id
  intervention_id
  payment_id
  original_transaction_date
  confirmed_transaction_date
  amount_cents
  policy_version
  accepted_at
  consumed_at
  operation_id
  status
```

### 26.14 Temporary operation

```text
TemporaryPaymentOperation
  id
  intervention_id
  confirmation_id
  merchant_id
  payer_id
  payment_id
  original_transaction_date
  proposed_transaction_date
  amount_cents
  policy_version
  preflight_state
  mutation_state
  readback_state
  status
  failure_stage
  verified_transaction_date
  created_at
  updated_at
  verified_at
```

### 26.15 Permanent confirmation

```text
PermanentCustomerConfirmation
  id
  intervention_id
  merchant_id
  payer_id
  source_id
  plan_id
  subscription_id
  proposed_start_date
  confirmed_payments_json
  policy_version
  accepted_at
  consumed_at
  operation_id
  status
```

### 26.16 Subscription change operation

```text
SubscriptionChangeOperation
  id
  intervention_id
  confirmation_id
  operation_id
  merchant_id
  payer_id
  plan_id
  source_id
  old_subscription_id
  new_subscription_id
  previous_start_date
  requested_start_date
  status
  current_stage
  recovery_snapshot_json
  previous_subscription_snapshot_json
  cycle_context_snapshot_json
  preview_schedule_json
  final_verified_schedule_json
  failure_code
  failure_message
  recovery_available
  created_at
  updated_at
  verified_at
```

### 26.17 Prior schedule change projection

```text
PriorScheduleChange
  operation_id
  merchant_id
  payer_id
  change_type
  status
  executed_date
```

Only completed and verified operation records feed this projection.

### 26.18 Escalation and manual recovery

```text
ExceptionCase
  id
  intervention_id
  operation_id
  type
  status
  reason_code
  customer_message
  merchant_summary
  recovery_snapshot_json
  assigned_to
  created_at
  resolved_at
```

---

# Part XIII. Pinch integration

## 27. Managed-merchant architecture

### 27.1 Authentication

- client credentials grant
- token caching
- pinned `pinch-version: 2020.1`
- `Current-Merchant` header for managed-merchant requests
- one retry on authentication failure only where safe
- no mutation retry solely because an outcome is ambiguous

### 27.2 Merchant scoping

Payers, sources, Payments, Plans and Subscriptions are merchant-scoped.

Every operation must carry the exact merchant context.

### 27.3 Monetary values

All Pinch amounts are cents.

```text
$125.00 = 12500
```

Store cents internally. Convert at display boundaries only.

---

## 28. Pinch touch points

### 28.1 Diagnosis and context

- list or retrieve payer Payments
- retrieve scheduled Payments
- retrieve processed Payments
- retrieve Subscription
- retrieve Plan
- retrieve calculated payments

### 28.2 Temporary move

1. GET Payment
2. DueLogic policy evaluation
3. customer confirmation
4. GET Payment immediately before execution
5. require `scheduled`
6. POST `/payments` with the existing Payment ID and confirmed date
7. GET Payment
8. verify identity and date
9. observe later outcome through webhook or read

### 28.3 Permanent correction

1. GET Subscription and Plan
2. resolve merchant Plan mapping
3. DueLogic policy evaluation
4. request calculated-payment preview
5. show exact dates and amounts
6. OTP and customer confirmation
7. write and read recovery evidence
8. re-read active Subscription
9. cancel original Subscription
10. create replacement Subscription
11. read replacement using returned ID
12. verify exact schedule
13. record mapping

### 28.4 Webhooks

The production outcome loop requires:

- merchant-scoped webhook subscription
- signature verification
- event persistence
- correlation to intervention and operation
- realised-outcome update

Webhook mechanics are proven at MVP level. Durable outcome reporting remains polish work.

### 28.5 Nonce and idempotency

Use a caller-supplied nonce on Payment creation to prevent duplicate creation.

Do not assume a nonce makes update or replacement operations safe to retry. Mutation-specific ambiguity rules still apply.

---

# Part XIV. Development fixtures and evidence

## 29. Evidence sources

### 29.1 Checked-in synthetic history

Used for:

- deterministic pattern detection
- replay
- stable demo evidence
- regression tests

Must be labelled synthetic.

### 29.2 Process-local customer journey fixtures

The repeatable submission demo prepares five visible scenarios:

1. temporary-only customer journey
2. customer journey with all three movement choices
3. permanent-only journey after two seeded verified temporary uses consume the rolling temporary allowance
4. completed temporary deterministic result
5. completed permanent representation of previously verified live Pinch sandbox evidence

Additional deterministic fixtures and validation states cover alternatives, warning states, next-cycle-only availability and no-executable-option handling.

All fixtures must be labelled as development scenarios, deterministic development fixtures or a development representation of previously verified live Pinch sandbox evidence.

### 29.3 Live Pinch sandbox evidence

Used for:

- live Payment update proof
- webhook outcome proof
- permanent replacement proof
- final old-to-new mapping

Must be labelled live sandbox evidence.

### 29.4 Previously captured live evidence

May be used when a destructive operation should not be repeated for recording.

It must be described as previously captured from a verified live sandbox operation.

### 29.5 Repeatable Demo Setup

Route:

```text
/dev/duelogic/demo
```

The page is development-only and direct-localhost only.

One **Prepare demo** action:

- removes only the prior demo run's manifest-listed process-local records
- assigns a fresh `demoRunId`
- creates the five labelled scenarios
- creates fresh secure invitation tokens and simulated emails
- invalidates active links from the prior prepared run
- generates no OTP and writes no SMS message during preparation
- makes no Pinch request or mutation
- provides direct navigation to Demo Setup, Merchant dashboard, Customer email, SMS inbox and customer journeys

The current page order is:

1. development and evidence-provenance notice
2. preparation status and action
3. recommended demonstration sequence
4. direct navigation
5. active customer journeys
6. completed temporary evidence
7. completed permanent evidence
8. restart reminder
9. technical details, including `demoRunId`

Process-local state is lost when the Node process restarts. The presenter must run **Prepare demo** again after restart.

### 29.6 Forced-dishonour and time-travel controls

Any controlled sandbox-history tooling must:

- remain localhost-only
- use explicit per-request time-travel timestamps
- keep forced-failure directives on historical fixture Payments only
- keep intervention Payments clean
- preserve raw Pinch descriptions in integration data
- remove test directives only from customer-facing display copy
- never alter live Payment records merely to make a result appear successful

These controls are not part of the normal merchant workflow.

---

# Part XV. Validation and quality status

## 30. Deterministic validation suites

At the authoritative checkpoint, the application reports passing suites including:

| Suite | Scenarios |
|---|---:|
| Policy engine | 78 |
| Customer-led intervention | 35 |
| Temporary movement backend | 29 |
| Movement-choice journey | 40 |
| Assigned-billing-cycle safeguard | 24 |
| Demo preparation | 30 |
| Customer confirmation | 30 |
| Plan schedule resolver | 23 |
| Policy snapshot | 21 |
| Recovery operation | 15 |
| Merchant opportunity | 14 |
| Transaction verification | 10 |
| Customer OTP | 6 |
| Seed flags | 2 |

### 30.1 Validation coverage includes

- detector stability and exclusions
- rule precedence
- amount and arrears handling
- rolling usage boundaries
- temporary shorter alternative clamped to both the five-day cap and assigned-cycle end
- temporary option removal where no later compliant date exists
- monthly same-calendar-month-and-year containment, including leap-year and year-boundary cases
- weekly and fortnightly assigned-cycle containment, including permitted calendar-month crossings
- forged and stale next-cycle temporary dates refused before effects
- missing, malformed and one-sided cycle metadata fails closed at availability, binding and execution
- weekly, fortnightly and monthly cycle rules
- current-cycle and next-cycle permanent modes
- close-payment warning boundaries
- required close-payment warning acknowledgement
- warning acknowledgement invalidation after movement, date or preview changes
- unmapped and malformed Plan handling
- policy snapshot immutability
- OTP challenge expiry and mismatch
- atomic single-use verification
- confirmation consumption
- write-before-cancel recovery ordering
- partial failure handling
- temporary operation binding
- temporary mutation ambiguity handling
- movement availability combinations
- cross-kind replay resistance
- final-confirmation dispatch
- customer-safe terminal states
- no internal identifier leakage
- email and SMS channel separation

### 30.2 Build quality

At the final build stages:

- `npm run lint` passed
- `npm run build` passed
- `git diff --check` passed
- protected permanent replacement files remained unchanged during the assigned-cycle correction
- the temporary execution service changed only under the explicitly scoped assigned-cycle stage to add the pre-claim fail-closed re-check
- the assigned-cycle audit confirmed refusal occurs before verification consumption, evidence writes and mutation
- no unintended Pinch calls occurred during deterministic stages

### 30.3 Assigned-cycle safeguard audit

The final audit classified the pre-stage implementation as partial:

- permanent current-cycle and next-cycle paths already enforced assigned-cycle containment
- temporary movement previously enforced only the later-date and five-day rules
- temporary availability, binding and execution now use the intervention's trusted cycle bounds unconditionally

The 25-scenario suite proves:

- ordinary monthly movement
- month-end clamping
- no-date handling on the final cycle day
- February leap-year and non-leap-year behaviour
- December-to-January refusal
- weekly and fortnightly trusted-cycle behaviour
- permitted crossings of a calendar-month boundary inside the same assigned fortnightly cycle
- forged and stale next-cycle refusal
- zero mutation, zero operation evidence and unconsumed verification on pre-claim refusal
- no rolling-usage consumption for refused operations
- permanent current-cycle and next-cycle invariants remain intact
- missing stored cycle metadata fails closed at availability, preview binding and execution
- malformed cycle start or end is strictly rejected at final execution preflight before any verification claim or effect
- malformed original or proposed transaction dates are strictly rejected before comparison
- corrupted non-date cycle bounds cannot pass through lexicographic ordering

Scenario `ac25` completes a valid journey through OTP verification, then corrupts the stored cycle end and cycle start with non-date values. Both executions refuse with `selection-outside-assigned-cycle`, with zero mutation calls, zero operation evidence, an unconsumed verification record and an unexecuted intervention.

The compiled identifiers are:

- `TEMPORARY_OUTSIDE_ASSIGNED_CYCLE`
- `TEMPORARY_NO_DATE_IN_ASSIGNED_CYCLE`
- `temporaryChange.assignedBillingCycle`
- `INVALID_CYCLE_METADATA`
- `selection-outside-assigned-cycle`

---

# Part XVI. Live proof record

## 31. Customer-led permanent replacement proof

### 31.1 Result

```text
replacement-verified
```

### 31.2 Verified flow

```text
Invitation
-> permanent movement selection
-> bound exact Pinch preview
-> OTP challenge
-> OTP-created transaction verification
-> atomic claim
-> customer confirmation
-> recovery write and read-back
-> original cancellation
-> replacement creation
-> read-back verification
-> executed intervention
```

### 31.3 Verified schedule

```text
1 September 2026   $125.00
15 September 2026  $125.00
29 September 2026  $125.00
```

### 31.4 Verified outcomes

- original Subscription became inactive
- exactly one replacement Subscription became active
- Plan remained the same
- payer remained the same
- source remained the same
- replacement start date matched the confirmed date
- exact next three dates and amounts matched the Pinch preview
- verification was consumed
- confirmation was consumed before cancellation
- recovery evidence existed before cancellation
- operation status became `replacement-verified`
- intervention became executed
- merchant dashboard showed Executed 1 and Manual recovery 0
- no retry occurred
- Git remained unchanged during the controlled execution

### 31.5 Public evidence handling

The public scope records the verified result, schedule and control ordering without publishing internal Pinch object identifiers, invitation tokens, confirmation identifiers or operation identifiers.

Internal sandbox references remain in private development evidence only. Customer-facing pages and public documentation expose no internal identifiers.

---

# Part XVII. Hackathon demonstration

## 32. Demo objective

The video must make the specific product distinction understandable:

```text
Recurring timing-linked pattern
-> merchant policy configured once
-> historical replay and opportunity
-> automatic secure invitation
-> server-derived customer movement choice
-> assigned-cycle and usage safeguards
-> exact Pinch dates and amounts
-> separate SMS verification
-> final confirmation
-> verified Pinch evidence
```

The demonstration should establish that DueLogic is purpose-built payment schedule intelligence rather than a general payment assistant. Routine eligible requests do not wait for individual merchant approval.

## 33. Preferred 60-second sequence

| Time | Screen | Spoken point |
|---|---|---|
| 0:00 to 0:08 | Detected customer pattern and supporting payment history | This customer repeatedly fails at the same point in the payment cycle, then successfully settles several days later. DueLogic identifies the recurring timing-linked pattern before the next payment. |
| 0:08 to 0:16 | Policy configuration | The merchant sets the policy once. It controls eligibility, permitted dates, the amount ceiling and rolling use limits. |
| 0:16 to 0:23 | Historical policy replay and opportunity | DueLogic replays the policy against payment history and identifies upcoming payments eligible for controlled schedule correction. |
| 0:23 to 0:30 | Simulated customer email, Demo 2 | An eligible customer receives a secure invitation. Routine requests do not wait for individual merchant approval. |
| 0:30 to 0:39 | All three server-derived movement choices | The customer sees only the options permitted by the bound policy. Every revised payment must remain inside its assigned billing cycle. |
| 0:39 to 0:47 | Selected date and exact Pinch preview | DueLogic shows the exact dates and amounts calculated by Pinch before anything changes. |
| 0:47 to 0:53 | Separate SMS inbox | A separate SMS code verifies the customer before final confirmation. |
| 0:53 to 1:00 | Completed permanent evidence | The previously verified Pinch sandbox result shows the replacement schedule read back and recorded. Pinch controls the payment. DueLogic controls the governed decision about when it should run. |

## 34. What must be visible somewhere in the demo package

- payment-book pattern evidence
- replay assumption
- active merchant policy, including two temporary uses and one permanent use per rolling 12 months
- assigned-cycle safeguard and shortened date availability near cycle boundaries
- simulated customer email
- separate SMS OTP channel
- at least one customer movement-choice screen
- exact dates and amounts
- separate final confirmation
- a previously verified live Pinch sandbox outcome labelled accurately
- evidence provenance label
- executed status
- Manual recovery count
- old-to-new mapping or clear replacement evidence

Not every item must remain legible in the 60-second edit. The screens must be available for a longer demonstration or judging questions.

## 35. Evidence and claim rules

### Safe claims

- DueLogic reviews a payment book for timing-linked patterns.
- Eligibility is deterministic and policy-bound.
- The customer can choose among the permitted temporary and permanent scopes.
- Every revised date remains inside the assigned billing cycle; temporary moves are also capped at five calendar days.
- Two verified temporary moves and one verified permanent correction are permitted per payer in separate rolling 12-month windows under the current fixed MVP policy.
- One-payment Pinch date mutation is proven live.
- monthly, weekly and fortnightly Subscription replacement are proven in the sandbox.
- the OTP-gated customer-led permanent replacement is proven live.
- the temporary customer path is implemented and deterministically validated.
- recovery evidence is written before destructive cancellation.
- the final replacement schedule is verified through Pinch read-back.

### Claims to avoid

- DueLogic knows why a customer paid late.
- DueLogic assesses affordability or hardship.
- DueLogic prevented a stated number of failures.
- DueLogic recovered a stated amount of revenue.
- every merchant policy rule is currently editable.
- all records are durably persisted.
- the final temporary customer path has already been live-proven through Pinch.
- a fixture result is a live Pinch mutation.

## 36. Demo freeze

Do not add core functionality before filming unless an existing screen is broken or materially misleading.

Do not add today:

- database persistence
- real email or SMS
- more policy rules
- live temporary mutation
- new recovery behaviour
- production scheduler
- broad redesign
- new AI capability

---

# Part XVIII. Hackathon definition of done

## 37. Submission floor

- merchant sees a clear timing-linked pattern and supporting records
- deterministic policy returns the outcome and exact rule
- customer chooses a permitted scope and date
- exact payment outcome is shown
- OTP verification and final confirmation are separate
- a protected Pinch mutation has been proven
- Pinch read-back verifies the result
- final status and operation evidence are available
- evidence types are labelled accurately

## 38. Strong submission

Everything above, plus:

- detector and replay
- active merchant policy and version history
- automatic invitation generation
- simulated email and separate SMS channel
- all three customer movement choices
- temporary shorter alternative
- permanent current-cycle and next-cycle options
- close-payment warning
- atomic single-use verification
- protected temporary backend
- protected permanent replacement
- recovery snapshot written and read back before cancellation
- old-to-new mapping
- merchant monitoring and exception states

## 39. Best-submission extras

These are useful but not required before filming:

- controlled live Pinch history demonstrating detector precision
- explicit classification of unrelated dishonour categories
- a fresh disposable live Subscription prepared for a judging demonstration
- live customer-led temporary Payment movement
- complete captured backup evidence
- polished demo navigation
- direct visual comparison of replay before and after policy change

---

# Part XIX. Polish week, 27 to 31 July 2026

## 40. Polish-week objective

Convert the hackathon MVP from process-local demonstration software into a repeatable, secure and credible pilot-ready product while preserving the proven execution paths.

No refactor should weaken or replace the protected temporary or permanent execution ordering.

---

## 41. Priority 1: durable persistence

### 41.1 Replace process-local stores

Persist at minimum:

- merchants
- policy versions and activation history
- Plan schedule mappings
- pattern flags
- replay results
- interventions
- invitation notifications and token hashes
- movement selections
- OTP challenges
- transaction verifications
- temporary confirmations
- permanent confirmations
- temporary operations
- Subscription replacement operations
- escalation and recovery cases
- webhook events
- prior verified change projections

### 41.2 Persistence requirements

- atomic writes where claim or consumption is involved
- database-enforced uniqueness for write-once records
- transaction boundaries for verification claim and operation linkage
- optimistic or pessimistic concurrency controls where required
- durable timestamps
- immutable evidence snapshots
- indexes for merchant, payer, intervention and status queries
- retention and deletion policy
- migration scripts
- development seed and reset scripts that cannot run in production

### 41.3 Restart acceptance test

After server restart:

- active policy survives
- pending invitation survives
- review token remains valid until expiry
- movement preview survives
- OTP challenge and verification state survive appropriately
- completed operations remain visible
- usage-history limits still count verified prior changes
- merchant dashboard counts remain accurate

---

## 42. Priority 2: production scheduler and event processing

### 42.1 Scheduled intervention scan

Replace the development scan button with a production job that:

- runs on merchant-local date boundaries
- finds upcoming Payments within configured reminder windows
- prevents duplicate intervention creation
- records scan run and result
- handles partial failures
- supports safe replay
- can be paused per merchant

### 42.2 Reminder timing controls

Add merchant configuration for:

- days before payment
- allowed communication hours
- timezone
- invitation expiry
- suppression conditions

### 42.3 Webhook persistence

- verify signature
- store raw event safely
- deduplicate events
- correlate to merchant, payer, Payment, Subscription, intervention and operation
- update realised outcome
- expose processing failures
- support event replay

---

## 43. Priority 3: production communications

### 43.1 Email

Integrate a production email provider or merchant communication adapter.

Required controls:

- verified sender domain
- templated customer-safe copy
- secure link insertion
- masked recipient display
- delivery status
- bounce handling
- retry policy for delivery, not payment mutation
- suppression list
- audit record
- preview mode

### 43.2 SMS

Integrate a production SMS provider for OTP.

Required controls:

- destination validation
- masked display
- delivery status
- regional sender compliance
- provider error handling
- cost monitoring
- no review link in OTP SMS

### 43.3 Channel separation

The invitation and OTP remain separate channels wherever practicable.

If the merchant chooses same-channel delivery in a future version, the security implications must be assessed explicitly.

---

## 44. Priority 4: OTP and token hardening

Add:

- maximum wrong attempts
- challenge lockout
- resend delay
- rolling issue cap
- per-IP and per-token rate limiting
- challenge invalidation on operation change
- verification invalidation workflow
- secure secret rotation
- audit logging without code disclosure
- concurrency tests
- constant-time comparisons throughout
- protection against replay across intervention kinds
- token revocation
- optional review-link rotation
- CSRF and origin checks for mutation routes

Review whether verification lifetime should remain 10 minutes in production.

---

## 45. Priority 5: merchant authentication and multi-tenancy

Add:

- merchant login
- role-based access
- secure merchant session
- strict tenant scoping
- separation of platform operator and merchant roles
- audit logs for policy activation and exception handling
- managed-merchant onboarding workflow or connection state
- secure storage of merchant-scoped configuration
- environment separation between sandbox and production

Potential roles:

- merchant administrator
- operations reviewer
- recovery operator
- read-only analyst
- platform administrator

---

## 46. Priority 6: full merchant policy editing

### 46.1 Expand editable controls

Add structured merchant editing for:

- temporary enabled or disabled
- permanent enabled or disabled
- maximum temporary shift
- temporary usage limit
- permanent usage limit
- rolling periods
- amount ceiling
- supported cadences
- close-payment warning thresholds
- reminder timing
- arrears escalation
- unsupported-Plan handling
- escalation contact

### 46.2 Policy safeguards

- validate before save
- preview plain-English summary
- replay candidate before activation
- compare candidate to active version
- show changed rules
- require explicit activation
- retain immutable history
- support rollback by activating a previous configuration as a new version
- never mutate an existing bound version

### 46.3 Plan schedule configuration UI

Add merchant controls for:

- exact Plan selection
- weekly anchor
- fortnightly anchor
- monthly cadence
- enable or disable mapping
- configuration validation
- mismatch diagnostics

---

## 47. Priority 7: live temporary customer-path validation

Prepare a dedicated sandbox fixture with:

- separate payer
- clean future scheduled Payment
- amount below ceiling
- Payment date far enough from processing
- no prior temporary limit conflict
- no impact on the completed permanent fixture

Run one controlled operation:

```text
invitation
-> temporary option
-> exact preview
-> OTP
-> final confirmation
-> one Payment update
-> same Payment ID
-> read-back new date
-> recurring Subscription unchanged
-> verified usage evidence
```

Requirements:

- one mutation only
- no automatic retry
- capture before and after Pinch state
- capture operation record
- verify later recurring schedule remains unchanged
- record proof in this document or a linked validation report

---

## 48. Priority 8: customer journey completion

### 48.1 Decline and exit path

Add:

- explicit decline option
- go-back behaviour
- abandonment state
- confirmation that no change was made
- audit record without counting usage

### 48.2 Alternative handling

Refine:

- temporary shorter-alternative copy
- permanent next-cycle alternative copy
- explicit alternative acceptance
- fresh preview after acceptance

### 48.3 Consent copy

Review customer wording for:

- one-payment movement
- Subscription replacement
- current Payment treatment
- recurring schedule effect
- close-payment warning
- no automatic change without confirmation
- customer identity verification

### 48.4 Accessibility and usability

- keyboard navigation
- focus management
- semantic headings
- error announcement
- readable date and currency formatting
- mobile layout
- loading and disabled states
- double-click protection
- plain-language review

---

## 49. Priority 9: merchant escalation and recovery interface

### 49.1 Escalation queue

Build a merchant view showing:

- customer reference
- movement requested
- policy reason
- exact rule fired
- relevant dates and amount
- safe evidence summary
- customer status
- merchant action and notes

Routine execution remains automated. The queue is for exceptions only.

### 49.2 Manual-recovery workspace

Show:

- operation ID
- original Subscription
- replacement or attempted replacement
- stage reached
- recovery snapshot
- known Pinch state
- recommended operator steps
- operator acknowledgement
- resolution notes
- final resolution status

Do not add automatic reinstatement until it has its own protected and verified design.

---

## 50. Priority 10: realised outcomes and reporting

Add durable reporting for:

- invitation sent
- invitation opened
- movement selected
- alternative accepted
- OTP issued and verified
- customer confirmed or declined
- execution verified
- merchant review
- manual recovery
- later payment outcome
- Subscription outcome

### 50.1 Counterfactual separation

Keep separate:

- historical policy eligibility
- customer engagement
- executed movement
- later realised payment result

Do not combine them into a single claimed savings figure.

### 50.2 Merchant metrics

Potential metrics:

- invitations generated
- open rate
- preview rate
- verification rate
- confirmation rate
- verified temporary movements
- verified permanent corrections
- merchant-review rate
- manual-recovery rate
- later approved-payment rate
- repeated temporary-to-permanent conversion
- support contacts avoided, only when independently evidenced

---

## 51. Priority 11: observability and operational safety

Add:

- structured logs with correlation IDs
- redaction of token, OTP and personal data
- operation-stage metrics
- error and ambiguity alerts
- scheduler health
- webhook health
- email and SMS delivery health
- Pinch latency and error monitoring
- dashboard for recovery-required cases
- no-mutation audit mode
- environment banners
- sandbox and production separation

### 51.1 Alert examples

- mutation response ambiguous
- original cancelled and replacement not verified
- verification consumed but operation missing
- duplicate active intervention
- expired preview used
- policy snapshot missing
- webhook signature failure
- repeated OTP issue attempts

---

## 52. Priority 12: testing and assurance

### 52.1 Automated tests

Add:

- database repository tests
- transactional claim tests
- concurrent final-confirmation tests
- route integration tests
- browser end-to-end tests
- webhook replay tests
- scheduler duplicate-suppression tests
- email and SMS adapter tests
- tenant-isolation tests
- accessibility tests
- production-build smoke tests

### 52.2 Pinch contract verification

- re-check endpoint field names against current Pinch documentation
- preserve pinned version until a deliberate upgrade
- add contract fixtures for Payment and Subscription reads
- validate mutation payloads
- validate webhook event shapes
- test merchant-scoped failures

### 52.3 Security review

- threat-model bearer-token links
- review OTP abuse and replay
- verify tenant boundaries
- review personal-data retention
- review logging and redaction
- review recovery access
- review secret handling
- review production route guards

---

## 53. Priority 13: interface and presentation polish

### 53.1 Merchant dashboard

Improve:

- hierarchy and scanability
- separation of diagnosis, policy, activity and exceptions
- shorter explanatory copy
- visible evidence labels
- responsive tables
- status filters
- operation detail drawer or page
- old-to-new mapping presentation

### 53.2 Customer journey

Improve:

- movement option comparison
- date-picker guidance
- clear current versus proposed schedule
- permanent replacement disclosure
- warning presentation
- OTP entry and resend state
- confirmation copy
- completed-result summary
- merchant-review and recovery copy

### 53.3 Demo setup

The development-only Demo Setup page is complete. Polish may improve presentation without changing its evidence semantics.

Current controls:

- one-click preparation of five process-local scenarios
- targeted clearing through the prior demo manifest
- fresh invitation tokens on every preparation
- evidence-provenance labels on cards and customer pages
- direct navigation across the demo workflow
- no Pinch calls, mutations, OTP issue or SMS write during preparation
- direct-localhost and development-only route protection

Polish tasks are limited to copy, spacing, presenter navigation and durable-fixture substitution after database persistence is introduced.

---

## 54. Priority 14: deployment and documentation

### 54.1 Deployment

The public GitHub repository is the authoritative hackathon submission. The complete repeatable demo runs locally and does not depend on Vercel.

For a later pilot deployment:

- confirm any Vercel project uses `main`
- configure production and preview environments
- set secrets safely
- configure database
- configure scheduler
- configure webhook URL
- configure email and SMS providers
- apply environment-specific route protections
- create rollback plan

### 54.2 Documentation

Completed for submission:

- `CLAUDE.md` reflects the current validation count and implementation boundaries
- `README.md` is the judge-facing product and local-demo guide
- `.env.example` contains variable names only and is intentionally tracked
- this version 8 scope is the detailed supporting technical document

Remaining documentation work:

- architecture diagram
- data-flow diagram
- Pinch integration guide
- policy rule reference
- execution state machines
- recovery runbook
- demo runbook
- environment setup
- test commands
- deployment checklist
- security and privacy notes

Version 8 remains the product and build source of truth. Code-specific implementation details may be documented separately.

---

## 55. Suggested polish-week sequence

### Monday: persistence foundation

- finalise durable schema
- implement repositories and migrations
- migrate policy, intervention, notification and operation stores
- prove restart resilience

### Tuesday: scheduler and communications

- production scan job
- duplicate suppression
- email adapter
- SMS adapter
- delivery evidence

### Wednesday: merchant controls and operations

- full policy editing
- Plan mapping UI
- escalation queue
- recovery detail view

### Thursday: security and customer polish

- OTP limits and rate controls
- token hardening
- customer decline flow
- consent and warning copy
- accessibility and mobile pass

### Friday: live validation and release readiness

- controlled live temporary customer-path test
- full end-to-end regression
- webhook and realised-outcome check
- deployment verification
- documentation and runbooks
- final pilot-readiness assessment

This sequence may be adjusted if database integration reveals higher-risk dependencies.

---

## 56. Polish-week definition of done

The polish-week build is complete when:

- application state survives restart
- all write-once and claim controls are database-enforced
- production scheduler creates no duplicate interventions
- real email invitation delivery works
- real SMS OTP delivery works
- OTP abuse controls are active
- merchant authentication and tenant isolation work
- merchant can configure the intended policy rules safely
- Plan mappings can be managed and validated
- customer decline is recorded without mutation
- temporary customer-led movement is live-proven through Pinch
- permanent customer-led replacement remains regression-proven
- escalation and recovery cases are operable
- webhook events are durable and correlated
- customer and merchant pages are accessible and usable on mobile
- logs and alerts support investigation
- all validation, lint, build and end-to-end tests pass
- documentation and recovery runbooks are current

---

# Part XX. Post-polish backlog and exclusions

## 57. Explicitly outside the current MVP and polish-week commitment

Unless separately prioritised, defer:

- AI customer support agent
- free-text intent extraction
- portable Pinch MCP product
- payment-source replacement
- data-fault remediation
- silent-subscription monitoring
- hardship assessment
- regulated credit decisioning
- customer risk scoring
- machine-learning detector
- automatic proration
- irregular and arbitrary custom cadence automation
- four-weekly automatic permanent correction
- automatic Subscription reinstatement
- production-grade compensating transactions
- inbound SMS conversation
- full accounting-platform integration marketplace
- multi-currency commercial logic
- automatic contract interpretation
- automated merchant exception approval

### 57.1 Future AI boundary

A future AI layer may:

- explain deterministic results
- summarise evidence for merchant review
- help draft policy descriptions
- assist recovery operators with a factual summary

It must not:

- decide eligibility
- infer financial circumstances
- alter a bound operation
- approve an exception
- initiate a mutation without deterministic and customer-confirmed controls

---

# Part XXI. Repository and implementation control

## 58. Authoritative repository state

```text
Repository: iconic-marketing/duelogic
Default branch: main
Public submission: yes
Author and committer: Renee Gersteling <reneeg@iconic.marketing>
```

The authoritative state is the latest clean `main` commit after:

- customer-led temporary and permanent execution
- repeatable Demo Setup
- presentation-flow alignment
- judge-facing README and safe `.env.example`
- policy usage-limit clarification
- assigned-billing-cycle safeguard and 25-scenario audit
- this version 8 scope update

At every final stage:

- all reported deterministic validation suites passed
- `npm run lint` passed
- `npm run build` passed
- `git diff --check` passed
- no unintended Pinch request or mutation occurred

### 58.1 Protected implementation boundaries

Do not casually modify or refactor:

- permanent replacement operation flow
- protected replacement route
- recovery write-before-cancel ordering
- temporary protected execution service
- temporary verified Payment movement service
- policy engine decision semantics
- atomic verification claim behaviour

Changes to these areas require:

- explicit stage scope
- deterministic validation
- regression of both temporary and permanent paths
- no unreviewed live mutation

---

# Part XXII. Final source-of-truth summary

## 59. What DueLogic does now

DueLogic:

- reviews a merchant's payment book
- identifies inspectable timing-linked patterns
- lets the merchant activate a versioned flexibility policy
- replays that policy against historical activity
- automatically creates secure customer invitations
- presents the movement choices permitted for that customer
- supports one-payment temporary movement within the original assigned billing cycle and five-calendar-day cap
- supports current-cycle permanent correction
- supports next-cycle permanent correction
- gives real alternatives where policy permits them
- retrieves authoritative Pinch payment context and permanent schedules
- verifies the customer through a separate OTP channel
- requires separate final confirmation
- dispatches to one protected execution path
- verifies the result through Pinch read-back
- records confirmation, operation and recovery evidence
- shows the outcome to the customer and merchant
- routes exceptions for merchant review or manual recovery
- prepares a repeatable five-scenario local demo with explicit evidence provenance
- documents the complete local workflow through the public repository README

## 60. What remains

The product foundation is complete.

Polish week converts it into a repeatable pilot-ready system through:

- durable persistence
- production scheduling
- real communications
- full merchant policy controls
- production authentication
- OTP hardening
- live temporary customer-path proof
- escalation and recovery operations
- outcome reporting
- observability
- security review
- interface refinement
- documentation and deployment readiness

# Part XXIII. Objection surface

## 61. Product and technical objections

| Objection | Authoritative answer |
|---|---|
| Does Pinch already allow payment and plan changes? | Pinch provides the payment rails and merchant operations. DueLogic adds payment-book diagnosis, merchant policy, automatic invitation, customer scope selection, identity verification, protected execution and audit evidence. |
| Is DueLogic competing with the Pinch Customer Portal? | No. Pinch owns payment methods and payment processing. DueLogic owns the governed schedule-change conversation and decision layer. |
| Does DueLogic send the customer invitation? | The MVP automatically generates the invitation and secure link and presents it through a simulated customer email inbox. Production delivery will use an email provider, merchant communication platform or portal adapter. |
| Why is OTP sent separately? | The invitation link and OTP are separate factors. The OTP is bound to the exact selected operation, and final confirmation remains a separate action. |
| Is this a chatbot? | No. The current customer journey uses structured choices and deterministic server logic. A language model is not required for eligibility or execution. |
| Can the customer move one payment only? | Yes. The Payment ID remains unchanged, the date is updated once and later recurring payments remain where they are. The new date must be later, no more than five calendar days later and inside the original assigned billing cycle. |
| Can a temporary move cross into the next month? | For monthly cadence, no. It must remain in the same merchant-local calendar month and year. Weekly and fortnightly movement follows the trusted assigned cycle, which may legitimately cross a month boundary. |
| Can the customer permanently change the schedule? | Yes. They can change the upcoming and future schedule, or keep the upcoming Payment and start the new schedule in the next cycle. |
| Why does permanent movement cancel and recreate the Subscription? | Pinch does not expose the required direct Subscription-update operation. DueLogic previews, records recovery evidence, cancels the original, creates one replacement and verifies it. |
| Is cancel and recreate safe? | It is non-atomic, so DueLogic writes and reads back a recovery snapshot before cancellation, uses one mutation path, does not retry blindly and routes unresolved partial failure to manual recovery. |
| What if there are multiple active Subscriptions? | The operation carries the exact Subscription ID throughout. It does not rely on payer-level discovery when identity could be ambiguous. |
| How do you know the billing cadence? | The merchant maps each exact Pinch Plan ID to a weekly, fortnightly or monthly schedule definition. DueLogic never guesses cadence from observed spacing. |
| What about four-weekly or irregular schedules? | They route to merchant review in the MVP. DueLogic does not apply the wrong calendar model. |
| Why must every revised date remain inside its assigned cycle? | It prevents the automatic workflow from shifting the affected instalment into a later assigned period. This applies to temporary and permanent changes and does not by itself prove compliance with every merchant contract. |
| Can the permanent date move earlier? | Yes, in current-cycle mode, provided it stays inside the assigned cycle and remains strictly after the evaluation and execution date. |
| What if the current-cycle date is no longer available? | DueLogic may offer a valid next-cycle alternative. The customer must explicitly accept it. |
| What if two payments become close together? | DueLogic displays the exact adjacent dates and a cadence-specific warning. The warning is not an automatic refusal. |
| Why are warning thresholds different by cadence? | A short gap is relative to the normal collection interval. Weekly uses 3 days, fortnightly 5 and monthly 7. |
| Is the $500 amount ceiling hardcoded? | No. `50000` cents is the default. The current merchant UI allows an amount-ceiling override, and the bound policy value controls evaluation. |
| Can the merchant edit every rule today? | No. The amount ceiling is currently editable. The other approved rules are visible, fixed and versioned in the hackathon MVP. Full structured editing is polish work. |
| What happens if the Payment starts processing after approval? | The execution layer reads Pinch immediately before mutation and requires live status exactly `scheduled`. No invented business-day cut-off replaces the live check. |
| Can DueLogic infer payday or affordability? | No. It observes dates, reasons and outcomes only. It does not diagnose financial circumstances. |
| Is this hardship assessment? | No. Explicit arrears can route a request to a person, but DueLogic does not assess capacity to pay. |
| Can historical replay prove a failure was prevented? | No. Replay reports eligibility under a visible assumption. Realised outcomes must be measured later. |
| Does the merchant approve every request? | No. Routine eligible requests are evaluated and executed automatically after customer verification and confirmation. The merchant handles configuration, monitoring, escalations and recovery. |
| Is the temporary customer path live-proven? | The underlying Pinch one-payment date-update contract is live-proven. The final OTP-gated temporary customer path is implemented and deterministically validated, with its controlled live run scheduled for polish week. |
| Is the permanent customer path live-proven? | Yes. The complete OTP-gated permanent replacement executed through Pinch and finished `replacement-verified`. |
| Is the video simulated? | The interface may use deterministic fixtures for repeatable navigation. Real execution claims rely on the completed live Pinch proof. Previously captured evidence must be identified accurately. |
| What survives a server restart? | Committed code and Pinch sandbox mutations survive. Current process-local invitations, OTP records, confirmations, operations and dashboard state do not. Durable persistence is the first polish priority. |
| Why not add automatic recovery? | Automatic compensation creates another destructive execution path. The MVP preserves exact recovery evidence and routes the case to a person. |
| Why not use AI to decide? | Transparent deterministic rules are easier to test, explain and audit. A future AI layer may explain results but cannot control execution. |

---

# Part XXIV. Honest assessment

## 62. Current readiness assessment

DueLogic is a strong hackathon MVP with an unusually complete safety and audit boundary for a weekend build. The product logic is coherent from diagnosis through customer confirmation and verified execution.

The immediate risk is presentation clarity, not missing core product functionality.

### 62.1 Strengths

- clear pre-failure product position
- payment-book diagnosis before merchant configuration
- inspectable deterministic detector
- explicit exclusion of unrelated dishonour reasons
- versioned policy and historical replay
- bound policy snapshot through execution
- structured customer movement choices
- temporary and permanent scopes remain distinct
- assigned-cycle containment across temporary and permanent modes
- fail-closed temporary availability, binding and execution when cycle metadata is invalid
- weekly, fortnightly and monthly permanent policy support
- exact merchant Plan mapping instead of cadence guessing
- real alternatives instead of blanket refusal
- separate invitation, OTP and final confirmation
- atomic single-use verification
- protected temporary backend
- live-proven permanent replacement
- write-before-cancel recovery evidence
- old-to-new Subscription mapping
- no automatic mutation retry
- customer-safe escalation and recovery states
- clear separation of synthetic, fixture and live evidence

### 62.2 Weaknesses and risks

1. Process-local state is not durable and resets with the server.
2. Production email, SMS and scheduling are not connected.
3. Merchant authentication and tenant access controls are not production-ready.
4. Only the amount ceiling is currently editable through the merchant policy UI.
5. Every supported permanent Plan requires an explicit schedule mapping.
6. Subscription replacement remains inherently non-atomic.
7. OTP rate limits, issue caps and concurrency hardening remain incomplete.
8. The final temporary customer path still needs one controlled live Pinch validation.
9. Long-term realised-outcome reporting is not durably connected.
10. The current dashboard contains more detail than a 60-second video can communicate.
11. A repeatable live destructive demonstration requires a fresh disposable object.
12. Market and competitor claims require current external verification before public use.

### 62.3 Commercial assessment

The product has a credible SaaS or embedded-platform direction because it combines:

- a merchant-level diagnostic
- a reusable policy layer
- customer self-service
- managed-merchant architecture
- operation evidence
- repeatable exception handling

The strongest initial market is likely organisations with recurring direct-debit or card collections, frequent payment-date support requests and meaningful operational cost from manual intervention.

The next commercial proof should measure:

- invitation uptake
- confirmed movement rate
- later payment outcomes
- support contacts avoided
- merchant acceptance of automatic policy execution
- value of permanent correction after repeated temporary movements

---

# Part XXV. Consolidated decision log

## 63. Final decisions through version 8

| Decision | Final result |
|---|---|
| Product name | DueLogic |
| Primary product position | Pre-failure payment-schedule diagnosis and governed correction |
| Novelty claim | Claim the combination, not ownership of billing-date optimisation |
| Decision authority | Deterministic code only |
| Customer interaction | Structured movement choices, not free-text chat |
| Customer movement types | Temporary, permanent current cycle, permanent next cycle |
| Merchant role | Configure, analyse, monitor, escalate and recover, without routine approval |
| Payment-book detector | Repeated `insufficient-funds` pattern plus later approved-settlement evidence |
| Detector causation | Never infer or claim financial cause |
| Stable history | Checked-in synthetic history with inspectable evidence |
| Pattern exclusions | Other dishonour reasons and unpatterned events excluded |
| Historical analysis term | Replay, not simulation |
| Replay claim | Eligibility under assumptions, never proven savings |
| Policy model | Merchant-scoped, versioned and activated |
| Current policy editability | Amount ceiling editable; remaining MVP rules fixed and visible |
| Bound policy | Exact intervention policy snapshot governs later evaluation and execution |
| Default amount ceiling | `50000` cents |
| Temporary maximum use | 2 completed and verified movements in rolling 12 months |
| Permanent maximum use | 1 completed and verified movement in rolling 12 months |
| Rolling boundary | Lower-exclusive, upper-inclusive |
| Temporary shift | Later only, maximum 5 calendar days and inside the original assigned billing cycle |
| Temporary monthly boundary | Same merchant-local calendar month and year as the original Payment |
| Temporary weekly and fortnightly boundary | Trusted seven-day or fourteen-day assigned cycle, even if it crosses a calendar-month boundary |
| Temporary no-date state | Remove the option server-side when no later compliant date remains |
| Temporary invalid cycle metadata | Fail closed at availability, preview binding and pre-claim execution |
| Temporary out-of-range request | Offer the furthest date permitted by both the five-day cap and assigned-cycle end |
| Temporary identity | Existing Pinch Payment ID remains unchanged |
| Temporary live gate | Payment status must be exactly `scheduled` immediately before mutation |
| Temporary evidence | Count usage only after read-back verification |
| Permanent implementation | Protected Subscription cancellation and replacement |
| Permanent cadence source | Merchant-held exact Plan mapping |
| Supported permanent cadences | Weekly, fortnightly and monthly |
| Unsupported cadence | Merchant review, no guessing |
| Monthly anchor | Day 1 through 28 |
| Current-cycle mode | Move upcoming and future payments inside current assigned cycle |
| Next-cycle mode | Keep upcoming Payment, change future schedule in next cycle |
| Permanent alternative | Offer valid next-cycle date when current-cycle request cannot proceed |
| No-op handling | Selected mode must create a real schedule change |
| Close-payment warnings | Weekly 3 days, fortnightly 5, monthly 7, warning rather than refusal; explicit acknowledgement required and bound to the exact preview |
| Permanent preview | Exact Pinch calculated-payments result |
| Permanent confirmation | Separate from request, selection and OTP |
| Invitation delivery | Simulated customer email inbox for hackathon |
| OTP delivery | Separate simulated SMS inbox |
| OTP code | Six digits, cryptographically generated and HMAC-digested |
| OTP lifetime | 5 minutes |
| Transaction verification lifetime | 10 minutes |
| Verification claim | Atomic, exact-match and single-use |
| Option or date change | Invalidates preview before verification; refused after verification without fresh verification |
| Final request body | Secure token only |
| Final dispatch | Stored movement kind selects exactly one protected executor |
| Ambiguous mutation | Read to establish state, never retry blindly |
| Permanent recovery gate | Persist and read back recovery evidence before cancellation |
| Automatic compensation | Outside MVP |
| Permanent proof | Full OTP-gated customer replacement live-proven |
| Temporary customer proof | Backend and UI deterministically proven; live customer run deferred to polish week |
| Simulated email and SMS | Presentation adapters only, no real delivery claim |
| Process-local stores | Hackathon-only and explicitly non-durable |
| Demo evidence | Five labelled local scenarios for repeatability, with real Pinch proof for execution claims |
| Demo preparation | Development-only, process-local, fresh secure links, targeted clearing and no Pinch calls or OTP issue |
| Demo mutation | No need to repeat destructive operation solely for filming |
| Demo wording | Never describe fixture execution as fresh live Pinch execution |
| Current branch | `main` |
| Authoritative repository state | Latest clean `main` commit after assigned-cycle safeguard and scope documentation |
| Public submission artefact | Public GitHub repository; complete repeatable demo runs locally |
| Assigned-cycle validation | 25 deterministic scenarios, plus existing suite regression |
| First polish priority | Durable persistence |
| Primary polish validation | Controlled live temporary customer movement |

---

## 64. Maintenance rule for version 8

Version 8 is a living source of truth during polish week.

After each approved stage:

1. confirm the latest clean `main` state remains authoritative and record a commit only where historical traceability is useful
2. update the current status table
3. move completed polish items into the proof record
4. record new live validation evidence
5. update known limitations
6. add material product decisions to the consolidated decision log
7. do not silently change policy semantics without an explicit decision entry

---

**End of DueLogic Build Scope v8.**
