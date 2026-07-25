/**
 * Deterministic validation of the customer-led intervention flow (Stage 1
 * journey and Stage 2 customer-confirmed execution), following the
 * repository's validation convention: the exported async function
 * re-asserts the full scenario table on demand, and one pass is kicked off
 * at module load with loud failure logging.
 *
 * Nothing here calls Pinch or reads a clock: repositories, clock, token
 * generator, token hasher, every subscription/preview read effect and the
 * replacement-path invoker are injected fakes over synthetic identifiers.
 * The fake replacement path drives the REAL protected flow
 * (executeSubscriptionReplacement) with fake Pinch effects, so the
 * consumption ordering and no-retry contracts are exercised end to end
 * with no network access. No live merchant, payer, subscription, plan or
 * source IDs appear in the fixtures, and no real token is ever created.
 *
 * The eight Stage 1 scenarios:
 *  s1 scheduled scan creates one invitation for the designated opportunity;
 *  s2 a second scan creates no duplicate active invitation;
 *  s3 an expired invitation cannot select a date;
 *  s4 an approved date obtains the mocked Pinch preview and stores the
 *     exact returned schedule;
 *  s5 an alternative policy result does not execute and requires another
 *     selection;
 *  s6 an ambiguous active-subscription resolution creates no invitation;
 *  s7 decline prevents further preview and leaves confirmationId,
 *     operationId and newSubscriptionId null;
 *  s8 preview-ready keeps the exact schedules, leaves the Stage 2 fields
 *     null, and the final confirmation stays disabled because no verified
 *     transaction-verification record exists — derived, never hardcoded.
 *
 * The Stage 2 execution scenarios (s9-s14 call the internal
 * confirmInterventionExecution directly with fakes — the verification gate
 * is a prerequisite of the public surface, validated by s15, and is never
 * bypassed through any route):
 *  s9 one internal confirmation call executes the replacement exactly once
 *     and records the verified linkage;
 * s10 a second submission cannot execute — executed and in-flight records
 *     both refuse without invoking the path;
 * s11 a non-preview-ready invitation is blocked before any confirmation is
 *     created;
 * s12 an expired invitation is blocked before any confirmation is created;
 * s13 a failure after cancellation sets manual-recovery-required and is
 *     terminal — no resubmission, no decline;
 * s14 the accepted confirmation is consumed exactly once, before
 *     cancellation;
 * s15 the route-level transaction-verification gate refuses execution when
 *     no valid verified record exists: the internal function is never
 *     called, and no confirmation, operation, execution state or
 *     replacement dependency is touched.
 *
 * The policy-binding scenarios (every harness carries an isolated saved-
 * policy store with the frozen default pre-installed):
 * s16 the scan resolves and binds the active saved policy, and refuses
 *     with no invitation when none resolves or its ceiling forbids;
 * s17 a pending invitation stays bound to its creation-time version after
 *     a later activation;
 * s18 the stored version — not the currently active one — determines the
 *     customer evaluation outcome, in both directions;
 * s19 an unresolvable bound version refuses safely: no preview read, no
 *     execution state, no fallback to the active or frozen policy;
 * s20 a new invitation binds the newer active version while the earlier
 *     invitation keeps its own;
 * s21 policy binding leaves the transaction-verification gate closed.
 *
 * The atomic-claim scenarios (the dev confirmation route's composition —
 * preliminary read gate, then the authoritative repository claim, then the
 * internal execution function, with fakes only):
 * s22 the atomic claim gates internal execution: a failed claim calls
 *     nothing, a seeded claim consumes first and executes exactly once,
 *     and a policy activation writes nothing to the verification store;
 * s23 a pre-mutation internal refusal never restores the claimed
 *     verification — claims are terminal and write-once seeding prevents
 *     replacement;
 * s24 a manual-recovery outcome retains the consumed verification as
 *     evidence.
 */

import {
  createInMemoryInterventionNotificationRepository,
  createInMemoryInterventionRepository,
} from "./dev-intervention-store";
import {
  effectiveInterventionStatus,
  toCustomerInterventionProjection,
  toMerchantInterventionProjection,
  transactionVerificationExpectationFor,
  type DueLogicInterventionRecord,
  type DueLogicInterventionRepository,
  type InterventionNotificationRepository,
} from "./intervention";
import type { InterventionDemoFixture } from "./intervention-fixture";
import {
  confirmInterventionExecution,
  declineIntervention,
  evaluateSelectedDate,
  requireTransactionVerification,
  runScheduledInterventionScan,
  type InterventionExecutionDeps,
  type InterventionPreviewReadEffects,
  type InterventionReplacementPathRequest,
  type InterventionReplacementPathResult,
  type InterventionScanDeps,
} from "./intervention-service";
import {
  createInMemoryTransactionVerificationRepository,
  seedRehearsalTransactionVerification,
} from "./dev-transaction-verification-store";
import {
  createEmptyDevTransactionVerificationRepository,
  type ClaimableTransactionVerificationRepository,
  type TransactionVerificationRecord,
} from "./transaction-verification";
import { createInMemoryMerchantPolicyRepository } from "./policy/dev-policy-store";
import type {
  MerchantPolicyRepository,
  MerchantPolicySnapshot,
} from "./policy/policy-snapshot";
import { DEFAULT_DUELOGIC_POLICY } from "./policy/rules";
import { addCalendarDays } from "./calendar-date";
import type {
  SubscriptionDetailSnapshot,
  SubscriptionReadEffects,
} from "./subscription-resolver";
import type { ConfirmedSchedulePayment } from "@/lib/pinch/customer-confirmation";
import {
  consumeAcceptedCustomerConfirmation,
  evaluateConfirmationForReplacement,
  type CustomerConfirmationServiceDeps,
} from "@/lib/pinch/customer-confirmation-service";
import { createInMemoryCustomerConfirmationRepository } from "@/lib/pinch/dev-customer-confirmation-store";
import { createInMemoryReplacementOperationRepository } from "@/lib/pinch/dev-replacement-operation-store";
import type { SubscriptionReplacementRecoverySnapshot } from "@/lib/pinch/replacement-operation";
import {
  executeSubscriptionReplacement,
  type ReplacementExecutionEffects,
} from "@/lib/pinch/replacement-operation-flow";

export interface InterventionValidationRow {
  scenario: string;
  outcome: string;
}

export interface InterventionValidationResult {
  scenarioCount: number;
  decisionTable: InterventionValidationRow[];
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Intervention validation failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Injected deterministic dependencies

/** Strictly increasing synthetic clock; advanceMinutes models waiting. */
function makeClock(startIso: string) {
  let currentMs = Date.parse(startIso);
  return {
    now: (): string => {
      currentMs += 1_000;
      return new Date(currentMs).toISOString();
    },
    advanceMinutes: (minutes: number): void => {
      currentMs += minutes * 60_000;
    },
  };
}

/**
 * Deterministic token deps. The fake hash reverses the raw token so the
 * stored hash never contains the raw token as a substring — letting
 * scenarios assert the raw token appears nowhere in stored intervention
 * state or merchant projections.
 */
function makeTokenDeps() {
  let interventionCounter = 0;
  let notificationCounter = 0;
  let tokenCounter = 0;
  return {
    generateInterventionId: (): string => {
      interventionCounter += 1;
      return `int_demo_${String(interventionCounter).padStart(2, "0")}`;
    },
    generateNotificationId: (): string => {
      notificationCounter += 1;
      return `ntf_demo_${String(notificationCounter).padStart(2, "0")}`;
    },
    generateToken: (): string => {
      tokenCounter += 1;
      return `raw-demo-invitation-${String(tokenCounter).padStart(2, "0")}`;
    },
    hashToken: (raw: string): string =>
      `fakehash:${raw.split("").reverse().join("")}`,
  };
}

// ---------------------------------------------------------------------------
// Synthetic fixtures — no live IDs

const DEMO_FIXTURE: InterventionDemoFixture = {
  merchantId: "mch_demo",
  payerId: "pyr_demo",
  sourceId: "src_demo",
  planId: "pln_demo",
  expectedRecurringAmountCents: 12500,
  scheduleCadence: "fortnightly",
  planScheduleConfiguration: {
    merchantId: "mch_demo",
    plans: {
      pln_demo: {
        cadence: "fortnightly",
        cycleDefinition: "fixed-days",
        cycleLengthDays: 14,
        cycleAnchorDate: "2026-08-11",
      },
    },
  },
  merchantTimezone: "Australia/Sydney",
  designatedSeedPayerId: "payer-01",
  demonstrationPreviousSettledDebitDate: "2026-06-28",
  currentArrearsCents: 0,
  currency: "AUD",
};

/**
 * The synthetic active subscription the fakes serve: starts 2026-08-14
 * inside the anchored cycle 2026-08-11..2026-08-24. With the seed
 * detector's proposedShiftDays of 4 for payer-01, the suggested date is
 * 2026-08-18.
 */
function demoSubscription(): SubscriptionDetailSnapshot {
  return {
    id: "sub_demo_active",
    payerId: "pyr_demo",
    planId: "pln_demo",
    status: "Active",
    startDate: "2026-08-14",
    sourceId: "src_demo",
    recurringAmountCents: 12500,
  };
}

/** Scan clock: before the subscription start, so the schedule is future. */
const SCAN_CLOCK_START = "2026-07-25T00:00:00.000Z";

function makeSubscriptionReads(subscriptions: SubscriptionDetailSnapshot[]) {
  const calls: string[] = [];
  const effects: SubscriptionReadEffects = {
    async listPayerSubscriptions(merchantId, payerId) {
      calls.push(`list:${merchantId}:${payerId}`);
      return subscriptions.map((entry) => ({
        id: entry.id,
        status: entry.status,
      }));
    },
    async readSubscription(merchantId, subscriptionId) {
      calls.push(`read:${subscriptionId}`);
      const found = subscriptions.find(
        (entry) => entry.id === subscriptionId,
      );
      return found === undefined ? null : { ...found };
    },
  };
  return { calls, effects };
}

/** Exactly three fortnightly payments from the requested start date. */
function threePaymentsFrom(startDate: string): ConfirmedSchedulePayment[] {
  return [0, 14, 28].map((days) => ({
    paymentDate: addCalendarDays(startDate, days) as string,
    amountInCents: 12500,
  }));
}

function makePreviewReads(subscription: SubscriptionDetailSnapshot) {
  const calls: string[] = [];
  const effects: InterventionPreviewReadEffects = {
    async readSubscription(merchantId, subscriptionId) {
      calls.push(`subscription:${subscriptionId}`);
      return subscription.id === subscriptionId ? { ...subscription } : null;
    },
    async readPlan(merchantId, planId) {
      calls.push(`plan:${planId}`);
      return { id: planId, requiresTotalAmount: false };
    },
    async readCalculatedPayments(merchantId, planId, startDate) {
      calls.push(`calculated:${startDate}`);
      return threePaymentsFrom(startDate);
    },
  };
  return { calls, effects };
}

interface Harness {
  repository: DueLogicInterventionRepository;
  notifications: InterventionNotificationRepository;
  clock: ReturnType<typeof makeClock>;
  tokenDeps: ReturnType<typeof makeTokenDeps>;
  scanDeps: InterventionScanDeps;
  subscriptionCalls: string[];
  /** Isolated saved-policy store; the frozen default is pre-installed. */
  policies: MerchantPolicyRepository;
}

/**
 * A later saved-policy snapshot for the demo merchant: the frozen default
 * frame with only the version and ceiling changed — never a new rule.
 */
function policySnapshotFor(
  policyVersion: string,
  amountCeilingCents: number,
  activatedAt: string,
): MerchantPolicySnapshot {
  return {
    policyVersion,
    merchantId: DEMO_FIXTURE.merchantId,
    policy: { ...DEFAULT_DUELOGIC_POLICY, version: policyVersion, amountCeilingCents },
    activatedAt,
    installedAsInitialDefault: false,
  };
}

async function makeHarness(
  clockStart: string = SCAN_CLOCK_START,
  subscriptions: SubscriptionDetailSnapshot[] = [demoSubscription()],
  policies?: MerchantPolicyRepository,
): Promise<Harness> {
  const repository = createInMemoryInterventionRepository();
  const notifications = createInMemoryInterventionNotificationRepository();
  const clock = makeClock(clockStart);
  const tokenDeps = makeTokenDeps();
  const reads = makeSubscriptionReads(subscriptions);
  const policyRepository =
    policies ?? createInMemoryMerchantPolicyRepository();
  // Pre-install the frozen default as the initial active snapshot for the
  // demo merchant, mirroring the shared development repository's
  // first-creation behaviour. Skipped when a supplied shared store already
  // holds history.
  if ((await policyRepository.list(DEMO_FIXTURE.merchantId)).length === 0) {
    await policyRepository.activate({
      policyVersion: DEFAULT_DUELOGIC_POLICY.version,
      merchantId: DEMO_FIXTURE.merchantId,
      policy: DEFAULT_DUELOGIC_POLICY,
      activatedAt: clock.now(),
      installedAsInitialDefault: true,
    });
  }
  return {
    repository,
    notifications,
    clock,
    tokenDeps,
    subscriptionCalls: reads.calls,
    policies: policyRepository,
    scanDeps: {
      repository,
      notifications,
      subscriptionReads: reads.effects,
      policies: policyRepository,
      now: clock.now,
      ...tokenDeps,
      invitationLifetimeMinutes: 30,
    },
  };
}

/** The raw token issued by the deterministic token deps' first invitation. */
const FIRST_RAW_TOKEN = "raw-demo-invitation-01";

async function scanCreated(
  harness: Harness,
): Promise<DueLogicInterventionRecord> {
  const outcome = await runScheduledInterventionScan(
    DEMO_FIXTURE,
    harness.scanDeps,
  );
  check(
    outcome.outcome === "created",
    `scan must create an invitation (got ${outcome.outcome})`,
  );
  return (outcome as { record: DueLogicInterventionRecord }).record;
}

/** Scan plus an approved suggested-date evaluation: a preview-ready record. */
async function toPreviewReady(
  harness: Harness,
): Promise<DueLogicInterventionRecord> {
  const created = await scanCreated(harness);
  const preview = makePreviewReads(demoSubscription());
  const outcome = await evaluateSelectedDate(
    { token: FIRST_RAW_TOKEN, selectedDate: created.suggestedDate },
    DEMO_FIXTURE,
    {
      repository: harness.repository,
      policies: harness.policies,
      now: harness.clock.now,
      hashToken: harness.tokenDeps.hashToken,
      previewReads: preview.effects,
    },
  );
  check(
    outcome.ok && outcome.record.status === "preview-ready",
    "execution fixture: the suggested date must reach preview-ready",
  );
  return (outcome as { record: DueLogicInterventionRecord }).record;
}

/**
 * A synthetic verified transaction verification bound exactly to the
 * supplied intervention record — what the future OTP stage would create.
 * Used to prove the gate and finalConfirmationEnabled derive from the
 * record rather than being hardcoded. Never persisted anywhere.
 */
function fakeVerifiedTransactionVerification(
  interventionRecord: DueLogicInterventionRecord,
  nowIso: string,
): TransactionVerificationRecord {
  return {
    verificationId: "ver_demo_01",
    interventionId: interventionRecord.interventionId,
    merchantId: interventionRecord.merchantId,
    payerId: interventionRecord.payerId,
    subscriptionId: interventionRecord.subscriptionId,
    selectedDate: interventionRecord.selectedDate ?? "",
    currentPayments: (interventionRecord.currentPayments ?? []).map(
      (payment) => ({ ...payment }),
    ),
    proposedPayments: (interventionRecord.proposedPayments ?? []).map(
      (payment) => ({ ...payment }),
    ),
    policyVersion: interventionRecord.policyVersion,
    verifiedAt: nowIso,
    expiresAt: new Date(Date.parse(nowIso) + 10 * 60_000).toISOString(),
    consumedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Stage 2 execution harness: injected fakes only. The fake replacement
// path mimics the protected route's composition — the confirmation gate,
// then the REAL executeSubscriptionReplacement driven by fake Pinch
// effects — so consumption ordering and the no-retry contract are
// exercised end to end without any network access.

interface ExecutionHarness {
  deps: InterventionExecutionDeps;
  confirmationRepository: ReturnType<
    typeof createInMemoryCustomerConfirmationRepository
  >;
  /** Ordered effect log across every path invocation. */
  pathCalls: string[];
  confirmationsCreated(): number;
  operationsStarted(): number;
}

function makeExecutionHarness(
  harness: Harness,
  behaviour: { createFails?: boolean } = {},
): ExecutionHarness {
  const confirmationRepository = createInMemoryCustomerConfirmationRepository();
  let confirmationCounter = 0;
  let confirmationTokenCounter = 0;
  const confirmationDeps: CustomerConfirmationServiceDeps = {
    repository: confirmationRepository,
    now: harness.clock.now,
    generateConfirmationId: (): string => {
      confirmationCounter += 1;
      return `conf_demo_${String(confirmationCounter).padStart(2, "0")}`;
    },
    generateToken: (): string => {
      confirmationTokenCounter += 1;
      return `raw-demo-confirmation-${String(confirmationTokenCounter).padStart(2, "0")}`;
    },
    hashToken: (raw: string): string =>
      `fakehash:${raw.split("").reverse().join("")}`,
    lifetimeMinutes: 30,
  };

  const operationRepository = createInMemoryReplacementOperationRepository();
  const pathCalls: string[] = [];
  let subscriptionStatus = "active";

  const executeReplacementPath = async (
    request: InterventionReplacementPathRequest,
  ): Promise<InterventionReplacementPathResult> => {
    pathCalls.push(`execute:${request.operationId}`);

    // The protected route's own confirmation gate, with unchanged
    // semantics: accepted, unexpired, unused and bound to this exact
    // replacement.
    const confirmationRecord = await confirmationRepository.readById(
      request.confirmationId,
    );
    const evaluation = evaluateConfirmationForReplacement(
      confirmationRecord,
      {
        merchantId: request.merchantId,
        payerId: request.payerId,
        sourceId: request.sourceId,
        subscriptionId: request.subscriptionId,
        proposedStartDate: request.proposedStartDate,
        confirmedPayments: request.confirmedPayments,
      },
      harness.clock.now(),
    );
    if (!evaluation.ok) {
      return { kind: "refused", stage: `confirmation-${evaluation.reason}` };
    }

    const effects: ReplacementExecutionEffects = {
      consumeCustomerConfirmation: async () => {
        pathCalls.push("consume-confirmation");
        return consumeAcceptedCustomerConfirmation(
          {
            confirmationId: request.confirmationId,
            operationId: request.operationId,
          },
          { repository: confirmationRepository, now: harness.clock.now },
        );
      },
      cancelOriginal: async () => {
        pathCalls.push("cancel-original");
        subscriptionStatus = "cancelled";
      },
      readOriginalStatus: async () => {
        pathCalls.push("verify-cancellation");
        return { id: request.subscriptionId, status: subscriptionStatus };
      },
      createReplacement: async () => {
        pathCalls.push("create-replacement");
        if (behaviour.createFails === true) {
          throw new Error("SimulatedCreateFailure");
        }
        return { id: "sub_demo_replacement" };
      },
      verifyReplacement: async (newSubscriptionId) => {
        pathCalls.push("verify-replacement");
        return {
          oldSubscriptionId: request.subscriptionId,
          newSubscriptionId,
          verifiedStartDate: request.proposedStartDate,
          planId: "pln_demo",
          payerId: request.payerId,
          paymentDates: request.confirmedPayments.map(
            (payment) => payment.paymentDate,
          ),
          paymentAmountsCents: request.confirmedPayments.map(
            (payment) => payment.amountInCents,
          ),
        };
      },
    };

    const recoverySnapshot: SubscriptionReplacementRecoverySnapshot = {
      merchantId: request.merchantId,
      payerId: request.payerId,
      sourceId: request.sourceId,
      planId: "pln_demo",
      originalStartDate: "2026-08-14",
      oldSubscriptionId: request.subscriptionId,
      reinstatementCreateBody: {
        planId: "pln_demo",
        payerId: request.payerId,
        sourceId: request.sourceId,
        startDate: "2026-08-14",
      },
      originalCalculatedPayments: threePaymentsFrom("2026-08-14").map(
        (payment) => ({
          transactionDate: payment.paymentDate,
          amountCents: payment.amountInCents,
        }),
      ),
    };

    const result = await executeSubscriptionReplacement(
      {
        operationId: request.operationId,
        confirmationId: request.confirmationId,
        merchantId: request.merchantId,
        payerId: request.payerId,
        planId: "pln_demo",
        sourceId: request.sourceId,
        oldSubscriptionId: request.subscriptionId,
        previousStartDate: "2026-08-14",
        requestedStartDate: request.proposedStartDate,
        previousTotalAmountCents: null,
        requestedTotalAmountCents: null,
        recoverySnapshot,
      },
      operationRepository,
      effects,
      harness.clock.now,
      () => {},
    );
    if (result.outcome === "replacement-verified") {
      return {
        kind: "verified",
        newSubscriptionId: result.record.newSubscriptionId as string,
      };
    }
    if (
      result.outcome === "confirmation-consumption-failed" ||
      result.outcome === "recovery-record-failed"
    ) {
      return { kind: "refused", stage: result.outcome };
    }
    return {
      kind: "manual-recovery",
      stage: result.outcome,
      newSubscriptionId: result.record.newSubscriptionId,
    };
  };

  let operationCounter = 0;
  return {
    deps: {
      repository: harness.repository,
      now: harness.clock.now,
      hashToken: harness.tokenDeps.hashToken,
      generateOperationId: (): string => {
        operationCounter += 1;
        return `op_demo_${String(operationCounter).padStart(2, "0")}`;
      },
      confirmationDeps,
      executeReplacementPath,
    },
    confirmationRepository,
    pathCalls,
    confirmationsCreated: () => confirmationCounter,
    operationsStarted: () => operationCounter,
  };
}

// ---------------------------------------------------------------------------
// Scenario table

export async function validateInterventionFlow(): Promise<InterventionValidationResult> {
  const table: InterventionValidationRow[] = [];
  const record = (scenario: string, outcome: string): void => {
    table.push({ scenario, outcome });
  };

  // s1: the scheduled scan creates exactly one invitation for the
  // designated eligible opportunity, bound to the resolved subscription and
  // the trusted cycle, holding only the token hash, with the raw token
  // present only in the notification delivery artefact.
  {
    const harness = await makeHarness();
    const created = await scanCreated(harness);
    check(
      created.subscriptionId === "sub_demo_active",
      "s1: the invitation must bind the resolved subscription",
    );
    check(
      created.changeMode === "permanent" &&
        created.scheduleCadence === "fortnightly",
      "s1: the invitation must be a permanent fortnightly change",
    );
    check(
      created.currentStartDate === "2026-08-14" &&
        created.currentCycleStartDate === "2026-08-11" &&
        created.currentCycleEndDate === "2026-08-24",
      "s1: the trusted cycle bounds must come from the merchant-held plan mapping",
    );
    check(
      created.suggestedDate === "2026-08-18",
      "s1: the suggested date must be the start date plus the detector's proposed shift",
    );
    check(
      created.patternFlagId.trim() !== "" &&
        created.status === "invitation-created" &&
        created.currentPaymentAmountInCents === 12500,
      "s1: the invitation must carry the pattern flag, status and amount",
    );
    check(
      created.confirmationId === null &&
        created.operationId === null &&
        created.newSubscriptionId === null,
      "s1: Stage 2 fields must start null",
    );
    const stored = await harness.repository.list();
    const notifications = await harness.notifications.list();
    check(
      stored.length === 1 && notifications.length === 1,
      "s1: exactly one intervention and one notification must exist",
    );
    check(
      !JSON.stringify(stored).includes(FIRST_RAW_TOKEN),
      "s1: the raw token must not appear anywhere in stored intervention state",
    );
    check(
      notifications[0].reviewPath === `/review/${FIRST_RAW_TOKEN}` &&
        notifications[0].title === "Payment schedule review" &&
        notifications[0].amountInCents === 12500 &&
        notifications[0].currentScheduledDate === "2026-08-14",
      "s1: the notification delivery artefact must carry the customer link and display fields",
    );
    record("s1-scan-creates-designated-invitation", "created");
  }

  // s2: a second scan run does not create a duplicate active invitation for
  // the same subscription — repeated clicks return the existing invitation.
  {
    const harness = await makeHarness();
    const created = await scanCreated(harness);
    const second = await runScheduledInterventionScan(
      DEMO_FIXTURE,
      harness.scanDeps,
    );
    check(
      second.outcome === "already-active",
      "s2: the second scan must report the existing active invitation",
    );
    check(
      second.outcome === "already-active" &&
        second.record.interventionId === created.interventionId,
      "s2: the second scan must reference the same invitation",
    );
    const stored = await harness.repository.list();
    const notifications = await harness.notifications.list();
    check(
      stored.length === 1 && notifications.length === 1,
      "s2: no duplicate intervention or notification may exist",
    );
    record("s2-no-duplicate-active-invitation", "prevented");
  }

  // s3: an expired invitation cannot select a date; the refusal happens
  // before any policy evaluation or preview read.
  {
    const harness = await makeHarness();
    const created = await scanCreated(harness);
    harness.clock.advanceMinutes(31);
    const preview = makePreviewReads(demoSubscription());
    const outcome = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: created.suggestedDate },
      DEMO_FIXTURE,
      {
        repository: harness.repository,
        policies: harness.policies,
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
        previewReads: preview.effects,
      },
    );
    check(
      !outcome.ok && outcome.reason === "expired",
      "s3: an expired invitation must refuse date selection",
    );
    check(
      preview.calls.length === 0,
      "s3: no preview read may run for an expired invitation",
    );
    const stored = await harness.repository.readById(created.interventionId);
    check(
      stored !== null &&
        stored.selectedDate === null &&
        stored.policyOutcome === null &&
        effectiveInterventionStatus(stored, harness.clock.now()) === "expired",
      "s3: the expired invitation must record no selection or decision",
    );
    record("s3-expired-invitation-refuses-selection", "refused");
  }

  // s4: an approved selected date proceeds to the mocked read-only Pinch
  // preview and stores the exact returned current and proposed schedules.
  {
    const harness = await makeHarness();
    const created = await scanCreated(harness);
    const preview = makePreviewReads(demoSubscription());
    const outcome = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: "2026-08-18" },
      DEMO_FIXTURE,
      {
        repository: harness.repository,
        policies: harness.policies,
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
        previewReads: preview.effects,
      },
    );
    check(outcome.ok, "s4: the suggested date must be approved");
    const updated = outcome.ok ? outcome.record : null;
    check(
      updated !== null &&
        updated.status === "preview-ready" &&
        updated.policyOutcome === "approved" &&
        updated.policyReasonCode === "POLICY_APPROVED" &&
        updated.policyRuleFired === "all-policy-rules-passed" &&
        updated.selectedDate === "2026-08-18",
      "s4: the approved decision and rule fired must be persisted",
    );
    check(
      updated !== null &&
        JSON.stringify(updated.currentPayments) ===
          JSON.stringify(threePaymentsFrom("2026-08-14")) &&
        JSON.stringify(updated.proposedPayments) ===
          JSON.stringify(threePaymentsFrom("2026-08-18")),
      "s4: the exact mocked Pinch schedules must be stored unmodified",
    );
    check(
      preview.calls.includes("subscription:sub_demo_active") &&
        preview.calls.includes("plan:pln_demo") &&
        preview.calls.includes("calculated:2026-08-14") &&
        preview.calls.includes("calculated:2026-08-18"),
      "s4: the preview must read the subscription, plan and both schedules",
    );
    check(
      updated !== null && updated.interventionId === created.interventionId,
      "s4: the evaluation must update the created invitation",
    );
    record("s4-approved-date-stores-exact-preview", "preview-ready");
  }

  // s5: an alternative policy result does not execute — no preview read —
  // and requires another selection; selecting the offered next-cycle date
  // then proceeds through a fresh deterministic evaluation to the preview.
  {
    // Later clock: the invitation is created and evaluated on 2026-08-13,
    // so an in-cycle date at or before the evaluation date is unavailable.
    const harness = await makeHarness("2026-08-13T00:00:00.000Z");
    await scanCreated(harness);
    const preview = makePreviewReads(demoSubscription());
    const deps = {
      repository: harness.repository,
      policies: harness.policies,
      now: harness.clock.now,
      hashToken: harness.tokenDeps.hashToken,
      previewReads: preview.effects,
    };
    const alternative = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: "2026-08-12" },
      DEMO_FIXTURE,
      deps,
    );
    check(
      alternative.ok &&
        alternative.record.status === "alternative-offered" &&
        alternative.record.policyOutcome === "next-cycle-alternative" &&
        alternative.record.offeredAlternativeDate === "2026-08-26",
      "s5: the unavailable in-cycle date must yield the derived next-cycle alternative",
    );
    check(
      alternative.ok && alternative.record.proposedPayments === null,
      "s5: an alternative result must store no preview schedule",
    );
    check(
      preview.calls.length === 0,
      "s5: an alternative result must trigger no preview read",
    );
    const outsideWindow = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: "2026-08-27" },
      DEMO_FIXTURE,
      deps,
    );
    check(
      !outsideWindow.ok && outsideWindow.reason === "outside-window",
      "s5: a next-cycle date other than the offered one must be refused",
    );
    const accepted = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: "2026-08-26" },
      DEMO_FIXTURE,
      deps,
    );
    check(
      accepted.ok &&
        accepted.record.status === "preview-ready" &&
        accepted.record.policyOutcome === "approved" &&
        JSON.stringify(accepted.record.proposedPayments) ===
          JSON.stringify(threePaymentsFrom("2026-08-26")),
      "s5: selecting the offered date must re-evaluate deterministically and reach the preview",
    );
    record("s5-alternative-requires-new-selection", "re-evaluated");
  }

  // s6: an ambiguous active-subscription resolution is a development
  // fixture error and creates no invitation and no notification.
  {
    const second: SubscriptionDetailSnapshot = {
      ...demoSubscription(),
      id: "sub_demo_second",
    };
    const harness = await makeHarness(SCAN_CLOCK_START, [
      demoSubscription(),
      second,
    ]);
    const outcome = await runScheduledInterventionScan(
      DEMO_FIXTURE,
      harness.scanDeps,
    );
    check(
      outcome.outcome === "fixture-error" &&
        outcome.reason === "subscription-resolution-failed",
      "s6: two equally eligible active subscriptions must be a fixture error",
    );
    const stored = await harness.repository.list();
    const notifications = await harness.notifications.list();
    check(
      stored.length === 0 && notifications.length === 0,
      "s6: an ambiguous resolution must create no invitation or notification",
    );
    record("s6-ambiguous-resolution-creates-nothing", "fixture-error");
  }

  // s7: decline prevents further date selection and preview, is idempotent
  // on repeat, and leaves confirmationId, operationId and
  // newSubscriptionId null.
  {
    const harness = await makeHarness();
    const created = await scanCreated(harness);
    const declineDeps = {
      repository: harness.repository,
      now: harness.clock.now,
      hashToken: harness.tokenDeps.hashToken,
    };
    const declined = await declineIntervention(
      { token: FIRST_RAW_TOKEN },
      declineDeps,
    );
    check(
      declined.ok && declined.changed && declined.record.status === "declined",
      "s7: decline must transition the invitation to declined",
    );
    const repeat = await declineIntervention(
      { token: FIRST_RAW_TOKEN },
      declineDeps,
    );
    check(
      repeat.ok && !repeat.changed,
      "s7: a repeated decline must be idempotent",
    );
    const preview = makePreviewReads(demoSubscription());
    const afterDecline = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: created.suggestedDate },
      DEMO_FIXTURE,
      {
        repository: harness.repository,
        policies: harness.policies,
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
        previewReads: preview.effects,
      },
    );
    check(
      !afterDecline.ok && afterDecline.reason === "declined",
      "s7: a declined invitation must refuse further date selection",
    );
    check(
      preview.calls.length === 0,
      "s7: no preview read may run after decline",
    );
    const stored = await harness.repository.readById(created.interventionId);
    check(
      stored !== null &&
        stored.declinedAt !== null &&
        stored.confirmationId === null &&
        stored.operationId === null &&
        stored.newSubscriptionId === null,
      "s7: decline must leave the Stage 2 fields null",
    );
    record("s7-decline-prevents-preview", "declined");
  }

  // s8: preview-ready remains valid with the exact Pinch-preview schedules
  // present and the Stage 2 identifiers null; the customer's final
  // confirmation control stays disabled because no verified
  // transaction-verification record exists — the false is derived from the
  // missing record (a bound verified record would enable it), never
  // hardcoded — and no internal identifiers or token material leak from
  // either projection.
  {
    const harness = await makeHarness();
    const created = await scanCreated(harness);
    const preview = makePreviewReads(demoSubscription());
    const outcome = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: created.suggestedDate },
      DEMO_FIXTURE,
      {
        repository: harness.repository,
        policies: harness.policies,
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
        previewReads: preview.effects,
      },
    );
    check(
      outcome.ok && outcome.record.status === "preview-ready",
      "s8: the approved suggested date must reach preview-ready",
    );
    const stored = await harness.repository.readById(created.interventionId);
    check(
      stored !== null &&
        stored.status === "preview-ready" &&
        stored.confirmationId === null &&
        stored.operationId === null &&
        stored.newSubscriptionId === null,
      "s8: preview-ready must leave the Stage 2 fields null",
    );
    check(
      stored !== null &&
        stored.currentPayments !== null &&
        stored.currentPayments.length === 3 &&
        stored.proposedPayments !== null &&
        stored.proposedPayments.length === 3,
      "s8: the exact Pinch-preview schedules must remain present",
    );
    const customerView = toCustomerInterventionProjection(
      stored as DueLogicInterventionRecord,
      harness.clock.now(),
    );
    check(
      customerView.finalConfirmationEnabled === false,
      "s8: the confirmation button must stay disabled — no verified transaction-verification record exists",
    );
    // Not hardcoded: the identical record with a bound verified
    // transaction verification would enable the control, and a consumed
    // one would not.
    const boundVerification = fakeVerifiedTransactionVerification(
      stored as DueLogicInterventionRecord,
      harness.clock.now(),
    );
    check(
      toCustomerInterventionProjection(
        stored as DueLogicInterventionRecord,
        harness.clock.now(),
        boundVerification,
      ).finalConfirmationEnabled === true,
      "s8: a bound verified record must enable the control — the false derives from the missing record",
    );
    check(
      toCustomerInterventionProjection(
        stored as DueLogicInterventionRecord,
        harness.clock.now(),
        { ...boundVerification, consumedAt: harness.clock.now() },
      ).finalConfirmationEnabled === false,
      "s8: a consumed verification must not enable the control",
    );
    const customerJson = JSON.stringify(customerView);
    check(
      !customerJson.includes("mch_demo") &&
        !customerJson.includes("pyr_demo") &&
        !customerJson.includes("src_demo") &&
        !customerJson.includes("sub_demo_active") &&
        !customerJson.includes("pln_demo") &&
        !customerJson.includes("tokenHash") &&
        !customerJson.includes(FIRST_RAW_TOKEN),
      "s8: the customer projection must expose no internal IDs or token material",
    );
    const merchantView = toMerchantInterventionProjection(
      stored as DueLogicInterventionRecord,
      harness.clock.now(),
    );
    const merchantJson = JSON.stringify(merchantView);
    check(
      !merchantJson.includes("tokenHash") &&
        !merchantJson.includes(FIRST_RAW_TOKEN) &&
        !merchantJson.includes("/review/"),
      "s8: the merchant projection must expose no token material or customer link",
    );
    record("s8-preview-ready-stage2-seam-disabled", "seam-intact");
  }

  // s9: one valid internal confirmInterventionExecution call executes the
  // replacement exactly once and records the verified linkage on the
  // intervention, the confirmation and the operation record.
  {
    const harness = await makeHarness();
    await toPreviewReady(harness);
    const execution = makeExecutionHarness(harness);
    const outcome = await confirmInterventionExecution(
      { token: FIRST_RAW_TOKEN },
      execution.deps,
    );
    check(outcome.ok, "s9: the internal confirmation call must execute");
    const executedRecord = outcome.ok ? outcome.record : null;
    check(
      executedRecord !== null &&
        executedRecord.status === "executed" &&
        executedRecord.newSubscriptionId === "sub_demo_replacement" &&
        executedRecord.confirmationId === "conf_demo_01" &&
        executedRecord.operationId === "op_demo_01",
      "s9: the executed record must carry the verified linkage",
    );
    const stored = await harness.repository.readById(
      (executedRecord as DueLogicInterventionRecord).interventionId,
    );
    check(
      stored !== null &&
        stored.status === "executed" &&
        stored.newSubscriptionId === "sub_demo_replacement",
      "s9: the executed state must be persisted",
    );
    const confirmation =
      await execution.confirmationRepository.readById("conf_demo_01");
    check(
      confirmation !== null &&
        confirmation.status === "consumed" &&
        confirmation.acceptedAt !== null &&
        confirmation.operationId === "op_demo_01",
      "s9: the confirmation must be accepted then consumed by this operation",
    );
    check(
      execution.pathCalls.filter((call) => call.startsWith("execute:"))
        .length === 1 &&
        execution.pathCalls.filter((call) => call === "cancel-original")
          .length === 1 &&
        execution.pathCalls.filter((call) => call === "create-replacement")
          .length === 1 &&
        execution.pathCalls.includes("verify-replacement"),
      "s9: the protected path must run exactly once through verification",
    );
    check(
      toCustomerInterventionProjection(
        stored as DueLogicInterventionRecord,
        harness.clock.now(),
      ).finalConfirmationEnabled === false,
      "s9: an executed record must never offer confirmation again",
    );
    record("s9-confirm-executes-once", "executed");
  }

  // s10: a second submission cannot execute — an already-executed record
  // and an in-flight "executing" latch both refuse without invoking the
  // path or creating another confirmation.
  {
    const harness = await makeHarness();
    await toPreviewReady(harness);
    const execution = makeExecutionHarness(harness);
    const first = await confirmInterventionExecution(
      { token: FIRST_RAW_TOKEN },
      execution.deps,
    );
    check(first.ok, "s10: the first submission must execute");
    const callsAfterFirst = execution.pathCalls.length;
    const second = await confirmInterventionExecution(
      { token: FIRST_RAW_TOKEN },
      execution.deps,
    );
    check(
      !second.ok && second.reason === "already-executed",
      "s10: a second submission must refuse",
    );
    check(
      execution.pathCalls.length === callsAfterFirst &&
        execution.confirmationsCreated() === 1 &&
        execution.operationsStarted() === 1,
      "s10: the second submission must not invoke the path or create anything",
    );

    // An in-flight latch refuses too: a fresh preview-ready record written
    // to "executing" simulates a concurrent submission mid-execution.
    const latchHarness = await makeHarness();
    const previewRecord = await toPreviewReady(latchHarness);
    await latchHarness.repository.write({
      ...previewRecord,
      status: "executing",
      operationId: "op_demo_latch",
    });
    const latchExecution = makeExecutionHarness(latchHarness);
    const during = await confirmInterventionExecution(
      { token: FIRST_RAW_TOKEN },
      latchExecution.deps,
    );
    check(
      !during.ok &&
        during.reason === "already-executing" &&
        latchExecution.pathCalls.length === 0 &&
        latchExecution.confirmationsCreated() === 0,
      "s10: an in-flight execution must refuse without any side effect",
    );
    record("s10-second-submission-cannot-execute", "blocked");
  }

  // s11: a non-preview-ready intervention is blocked before any
  // confirmation is created — both a pre-selection state and a declined
  // record refuse.
  {
    const harness = await makeHarness();
    await scanCreated(harness);
    const execution = makeExecutionHarness(harness);
    const outcome = await confirmInterventionExecution(
      { token: FIRST_RAW_TOKEN },
      execution.deps,
    );
    check(
      !outcome.ok && outcome.reason === "not-confirmable",
      "s11: a pre-selection invitation must be blocked",
    );
    check(
      execution.pathCalls.length === 0 &&
        execution.confirmationsCreated() === 0 &&
        execution.operationsStarted() === 0,
      "s11: the blocked call must create nothing and invoke nothing",
    );
    const declined = await declineIntervention(
      { token: FIRST_RAW_TOKEN },
      {
        repository: harness.repository,
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
      },
    );
    check(declined.ok, "s11: the decline fixture must apply");
    const afterDecline = await confirmInterventionExecution(
      { token: FIRST_RAW_TOKEN },
      execution.deps,
    );
    check(
      !afterDecline.ok && afterDecline.reason === "declined",
      "s11: a declined invitation must be blocked",
    );
    record("s11-non-preview-ready-blocked", "blocked");
  }

  // s12: an expired invitation is blocked before any confirmation is
  // created, and its stored state is untouched.
  {
    const harness = await makeHarness();
    const previewRecord = await toPreviewReady(harness);
    harness.clock.advanceMinutes(31);
    const execution = makeExecutionHarness(harness);
    const outcome = await confirmInterventionExecution(
      { token: FIRST_RAW_TOKEN },
      execution.deps,
    );
    check(
      !outcome.ok && outcome.reason === "expired",
      "s12: an expired invitation must be blocked",
    );
    check(
      execution.pathCalls.length === 0 &&
        execution.confirmationsCreated() === 0 &&
        execution.operationsStarted() === 0,
      "s12: the expired refusal must create nothing and invoke nothing",
    );
    const stored = await harness.repository.readById(
      previewRecord.interventionId,
    );
    check(
      stored !== null &&
        stored.confirmationId === null &&
        stored.operationId === null &&
        stored.newSubscriptionId === null,
      "s12: the expired invitation must keep its execution fields null",
    );
    record("s12-expired-blocked", "blocked");
  }

  // s13: a simulated failure after cancellation produces
  // manual-recovery-required, which is terminal: no resubmission and no
  // decline can follow, and the consumed confirmation stays consumed.
  {
    const harness = await makeHarness();
    await toPreviewReady(harness);
    const execution = makeExecutionHarness(harness, { createFails: true });
    const outcome = await confirmInterventionExecution(
      { token: FIRST_RAW_TOKEN },
      execution.deps,
    );
    check(
      !outcome.ok && outcome.reason === "manual-recovery-required",
      "s13: a post-cancellation failure must report manual recovery",
    );
    const failedRecord = outcome.ok ? null : (outcome.record ?? null);
    check(
      failedRecord !== null &&
        failedRecord.status === "manual-recovery-required" &&
        failedRecord.confirmationId === "conf_demo_01" &&
        failedRecord.operationId === "op_demo_01" &&
        failedRecord.newSubscriptionId === null,
      "s13: the failure must keep the linkage with no replacement ID",
    );
    check(
      execution.pathCalls.includes("cancel-original") &&
        execution.pathCalls.includes("create-replacement") &&
        !execution.pathCalls.includes("verify-replacement"),
      "s13: the failure must occur after cancellation, before verification",
    );
    const confirmation =
      await execution.confirmationRepository.readById("conf_demo_01");
    check(
      confirmation !== null && confirmation.status === "consumed",
      "s13: the consumed confirmation must stay consumed",
    );
    const callsAfterFailure = execution.pathCalls.length;
    const repeat = await confirmInterventionExecution(
      { token: FIRST_RAW_TOKEN },
      execution.deps,
    );
    check(
      !repeat.ok &&
        repeat.reason === "manual-recovery-required" &&
        execution.pathCalls.length === callsAfterFailure,
      "s13: manual recovery is terminal — no resubmission may execute",
    );
    const decline = await declineIntervention(
      { token: FIRST_RAW_TOKEN },
      {
        repository: harness.repository,
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
      },
    );
    check(
      !decline.ok && decline.reason === "manual-recovery-required",
      "s13: a decline after execution began must be refused",
    );
    record("s13-post-cancellation-failure", "manual-recovery-required");
  }

  // s14: the accepted confirmation is consumed exactly once, strictly
  // before the cancellation step — the write-before-cancel contract seen
  // from the intervention side.
  {
    const harness = await makeHarness();
    await toPreviewReady(harness);
    const execution = makeExecutionHarness(harness);
    const outcome = await confirmInterventionExecution(
      { token: FIRST_RAW_TOKEN },
      execution.deps,
    );
    check(outcome.ok, "s14: the confirmation must execute");
    const consumeIndex = execution.pathCalls.indexOf("consume-confirmation");
    const cancelIndex = execution.pathCalls.indexOf("cancel-original");
    check(
      consumeIndex !== -1 && cancelIndex !== -1 && consumeIndex < cancelIndex,
      "s14: the confirmation must be consumed before cancellation",
    );
    check(
      execution.pathCalls.filter((call) => call === "consume-confirmation")
        .length === 1,
      "s14: consumption must happen exactly once",
    );
    record("s14-consumption-before-cancellation", "ordered");
  }

  // s15: the route-level transaction-verification gate refuses execution
  // when no valid verified record exists — the exact composition the dev
  // confirmation route uses: requireTransactionVerification first, and
  // confirmInterventionExecution only on a passing gate. Records exist
  // only through the controlled rehearsal seeding surface (none exists
  // here), so token possession alone can never reach the internal
  // function.
  {
    const harness = await makeHarness();
    await toPreviewReady(harness);
    const execution = makeExecutionHarness(harness);
    const before = JSON.stringify(await harness.repository.list());
    const gate = await requireTransactionVerification(
      { token: FIRST_RAW_TOKEN },
      {
        repository: harness.repository,
        verifications: createEmptyDevTransactionVerificationRepository(),
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
      },
    );
    check(
      !gate.ok && gate.reason === "verification-required",
      "s15: the gate must refuse without a verified record",
    );
    // The route calls confirmInterventionExecution only when the gate
    // passes, so a refusal means the internal function was never called:
    // no confirmation, no operation, no path invocation and no execution
    // state may exist.
    check(
      execution.pathCalls.length === 0 &&
        execution.confirmationsCreated() === 0 &&
        execution.operationsStarted() === 0,
      "s15: the refusal must invoke no execution dependency",
    );
    check(
      JSON.stringify(await harness.repository.list()) === before,
      "s15: the refusal must write no intervention execution state",
    );
    // Counter-proof: a verified record bound to this exact intervention
    // opens the gate, so the refusal derives from the missing record and
    // the later OTP stage only has to create records.
    const storedRecords = await harness.repository.list();
    const boundVerification = fakeVerifiedTransactionVerification(
      storedRecords[0],
      harness.clock.now(),
    );
    const wouldPass = await requireTransactionVerification(
      { token: FIRST_RAW_TOKEN },
      {
        repository: harness.repository,
        verifications: {
          async readVerifiedForIntervention() {
            return boundVerification;
          },
        },
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
      },
    );
    check(
      wouldPass.ok,
      "s15: a bound verified record must open the gate — the refusal is not hardcoded",
    );
    record("s15-gate-refuses-without-verification", "verification-required");
  }

  // s16: the scan resolves the active saved policy, evaluates the
  // opportunity and the suitability ceiling under it, and binds its
  // version to the invitation. Differential proof: under the frozen
  // default (ceiling 50000) both runs would create — a permissive v2
  // creates and binds v2, a low-ceiling v2 refuses with nothing created,
  // and an empty policy store fails safely.
  {
    const harness = await makeHarness();
    await harness.policies.activate(
      policySnapshotFor("duelogic-policy-v2", 30_000, harness.clock.now()),
    );
    const created = await scanCreated(harness);
    check(
      created.policyVersion === "duelogic-policy-v2",
      "s16: the invitation must store the active policyVersion",
    );

    const lowHarness = await makeHarness();
    await lowHarness.policies.activate(
      policySnapshotFor("duelogic-policy-v2", 12_000, lowHarness.clock.now()),
    );
    const refused = await runScheduledInterventionScan(
      DEMO_FIXTURE,
      lowHarness.scanDeps,
    );
    check(
      refused.outcome === "fixture-error" &&
        refused.reason === "no-designated-opportunity",
      "s16: a low active ceiling must prevent invitation creation",
    );
    check(
      (await lowHarness.repository.list()).length === 0,
      "s16: the refused scan must create nothing",
    );

    const noPolicy = await runScheduledInterventionScan(DEMO_FIXTURE, {
      ...lowHarness.scanDeps,
      policies: createInMemoryMerchantPolicyRepository(),
    });
    check(
      noPolicy.outcome === "fixture-error" &&
        noPolicy.reason === "policy-resolution-failed",
      "s16: a missing active policy must fail safely with no invitation",
    );
    check(
      (await lowHarness.repository.list()).length === 0,
      "s16: the policy-resolution failure must create nothing",
    );
    record("s16-scan-uses-active-policy", "bound");
  }

  // s17: a pending invitation remains bound to its creation-time policy.
  // v3's 12000-cent ceiling would escalate the 12500-cent payment; the
  // invitation bound to v2 (30000) still approves after v3 activates.
  {
    const harness = await makeHarness();
    await harness.policies.activate(
      policySnapshotFor("duelogic-policy-v2", 30_000, harness.clock.now()),
    );
    const created = await scanCreated(harness);
    await harness.policies.activate(
      policySnapshotFor("duelogic-policy-v3", 12_000, harness.clock.now()),
    );
    const preview = makePreviewReads(demoSubscription());
    const outcome = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: created.suggestedDate },
      DEMO_FIXTURE,
      {
        repository: harness.repository,
        policies: harness.policies,
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
        previewReads: preview.effects,
      },
    );
    check(
      outcome.ok &&
        outcome.record.status === "preview-ready" &&
        outcome.record.policyOutcome === "approved",
      "s17: evaluation must approve under the bound v2 despite active v3",
    );
    check(
      outcome.ok && outcome.record.policyVersion === "duelogic-policy-v2",
      "s17: the pending invitation must remain bound to v2",
    );
    record("s17-pending-intervention-stays-bound", "bound-v2");
  }

  // s18: the exact stored version drives the evaluation in both
  // directions: bound v2 approves while active v3 would escalate; rebound
  // to v3 escalates while the newer active v4 would approve.
  {
    const harness = await makeHarness();
    await harness.policies.activate(
      policySnapshotFor("duelogic-policy-v2", 30_000, harness.clock.now()),
    );
    const created = await scanCreated(harness);
    await harness.policies.activate(
      policySnapshotFor("duelogic-policy-v3", 12_000, harness.clock.now()),
    );
    const preview = makePreviewReads(demoSubscription());
    const deps = {
      repository: harness.repository,
      policies: harness.policies,
      now: harness.clock.now,
      hashToken: harness.tokenDeps.hashToken,
      previewReads: preview.effects,
    };
    const underV2 = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: created.suggestedDate },
      DEMO_FIXTURE,
      deps,
    );
    check(
      underV2.ok && underV2.record.policyOutcome === "approved",
      "s18: the stored v2 binding must approve",
    );

    const stored = (await harness.repository.readById(
      created.interventionId,
    )) as DueLogicInterventionRecord;
    await harness.repository.write({
      ...stored,
      policyVersion: "duelogic-policy-v3",
    });
    await harness.policies.activate(
      policySnapshotFor("duelogic-policy-v4", 30_000, harness.clock.now()),
    );
    const underV3 = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: created.suggestedDate },
      DEMO_FIXTURE,
      deps,
    );
    check(
      underV3.ok &&
        underV3.record.policyOutcome === "escalate" &&
        underV3.record.policyReasonCode === "AMOUNT_CEILING_EXCEEDED" &&
        underV3.record.policyVersion === "duelogic-policy-v3",
      "s18: the stored v3 binding must escalate although the active v4 would approve",
    );
    record("s18-bound-version-drives-evaluation", "stored-version-governs");
  }

  // s19: an unresolvable bound version refuses safely — before any
  // evaluation or preview read, recording no decision and no execution
  // state, with no fallback to the active policy or the frozen default.
  {
    const harness = await makeHarness();
    await harness.policies.activate(
      policySnapshotFor("duelogic-policy-v2", 30_000, harness.clock.now()),
    );
    const created = await scanCreated(harness);
    const stored = (await harness.repository.readById(
      created.interventionId,
    )) as DueLogicInterventionRecord;
    await harness.repository.write({
      ...stored,
      policyVersion: "duelogic-policy-v9",
    });
    const preview = makePreviewReads(demoSubscription());
    const outcome = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: created.suggestedDate },
      DEMO_FIXTURE,
      {
        repository: harness.repository,
        policies: harness.policies,
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
        previewReads: preview.effects,
      },
    );
    check(
      !outcome.ok && outcome.reason === "policy-unresolved",
      "s19: an unresolvable bound version must refuse",
    );
    check(preview.calls.length === 0, "s19: no preview read may occur");
    const after = await harness.repository.readById(created.interventionId);
    check(
      after !== null &&
        after.policyVersion === "duelogic-policy-v9" &&
        after.selectedDate === null &&
        after.policyOutcome === null &&
        after.confirmationId === null &&
        after.operationId === null &&
        after.newSubscriptionId === null,
      "s19: the refusal must record no decision and no execution state",
    );
    record("s19-missing-bound-version-refuses", "refused");
  }

  // s20: a new invitation binds the version active at its own creation.
  // Two isolated intervention repositories share one policy store: the
  // earlier invitation binds v2; after v3 activates, a separate eligible
  // invitation binds v3 and the earlier one keeps v2.
  {
    const sharedPolicies = createInMemoryMerchantPolicyRepository();
    const firstHarness = await makeHarness(
      SCAN_CLOCK_START,
      [demoSubscription()],
      sharedPolicies,
    );
    await sharedPolicies.activate(
      policySnapshotFor("duelogic-policy-v2", 30_000, firstHarness.clock.now()),
    );
    const earlier = await scanCreated(firstHarness);
    check(
      earlier.policyVersion === "duelogic-policy-v2",
      "s20: the earlier invitation must bind v2",
    );

    await sharedPolicies.activate(
      policySnapshotFor("duelogic-policy-v3", 30_000, firstHarness.clock.now()),
    );
    const secondHarness = await makeHarness(
      SCAN_CLOCK_START,
      [demoSubscription()],
      sharedPolicies,
    );
    const newer = await scanCreated(secondHarness);
    check(
      newer.policyVersion === "duelogic-policy-v3",
      "s20: the new invitation must bind the newer active version",
    );
    const earlierStored = await firstHarness.repository.readById(
      earlier.interventionId,
    );
    check(
      earlierStored !== null &&
        earlierStored.policyVersion === "duelogic-policy-v2",
      "s20: the earlier invitation must remain bound to v2",
    );
    record("s20-new-invitation-uses-newer-policy", "per-creation-binding");
  }

  // s21: policy binding leaves the transaction-verification gate closed —
  // no verification record exists or can be created, the confirmation
  // control stays disabled, the gate refuses, and no internal execution
  // call occurs anywhere in this stage.
  {
    const harness = await makeHarness();
    await harness.policies.activate(
      policySnapshotFor("duelogic-policy-v2", 30_000, harness.clock.now()),
    );
    const created = await scanCreated(harness);
    const preview = makePreviewReads(demoSubscription());
    const outcome = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: created.suggestedDate },
      DEMO_FIXTURE,
      {
        repository: harness.repository,
        policies: harness.policies,
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
        previewReads: preview.effects,
      },
    );
    check(
      outcome.ok && outcome.record.status === "preview-ready",
      "s21: the bound evaluation must reach preview-ready",
    );
    const verifications = createEmptyDevTransactionVerificationRepository();
    check(
      (await verifications.readVerifiedForIntervention(
        created.interventionId,
      )) === null,
      "s21: policy binding must create no transaction-verification record",
    );
    const stored = (await harness.repository.readById(
      created.interventionId,
    )) as DueLogicInterventionRecord;
    check(
      toCustomerInterventionProjection(stored, harness.clock.now())
        .finalConfirmationEnabled === false,
      "s21: the confirmation button must remain disabled",
    );
    const gate = await requireTransactionVerification(
      { token: FIRST_RAW_TOKEN },
      {
        repository: harness.repository,
        verifications,
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
      },
    );
    check(
      !gate.ok && gate.reason === "verification-required",
      "s21: the execution gate must still refuse",
    );
    const execution = makeExecutionHarness(harness);
    check(
      execution.pathCalls.length === 0 &&
        execution.confirmationsCreated() === 0 &&
        execution.operationsStarted() === 0,
      "s21: no internal execution call may occur in this stage",
    );
    record("s21-verification-gate-still-closed", "still-gated");
  }

  // Helpers for the atomic-claim scenarios: rehearsal seeding over the
  // harness's own stores, and the dev confirmation route's exact
  // composition — read the intervention, atomically claim, and only then
  // call the internal execution function.
  const seedVerificationFor = async (
    harness: Harness,
  ): Promise<ClaimableTransactionVerificationRepository> => {
    const verifications = createInMemoryTransactionVerificationRepository();
    const outcome = await seedRehearsalTransactionVerification(
      { token: FIRST_RAW_TOKEN },
      {
        interventions: harness.repository,
        verifications,
        policies: harness.policies,
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
        generateVerificationId: () => "ver_demo_01",
      },
    );
    check(outcome.ok, "claim fixture: rehearsal seeding must succeed");
    return verifications;
  };
  const claimThenExecute = async (
    harness: Harness,
    verifications: ClaimableTransactionVerificationRepository,
    executionDeps: InterventionExecutionDeps,
  ) => {
    const stored = await harness.repository.readByTokenHash(
      harness.tokenDeps.hashToken(FIRST_RAW_TOKEN),
    );
    check(stored !== null, "claim fixture: the invitation must resolve");
    const current = stored as DueLogicInterventionRecord;
    const claimed = await verifications.claimForExecution(
      current.interventionId,
      transactionVerificationExpectationFor(current),
      harness.clock.now(),
    );
    if (claimed === null) {
      return { claimed: null, outcome: null } as const;
    }
    return {
      claimed,
      outcome: await confirmInterventionExecution(
        { token: FIRST_RAW_TOKEN },
        executionDeps,
      ),
    } as const;
  };

  // s22: the atomic claim gates internal execution. Without a record the
  // claim refuses and confirmInterventionExecution is never called; after
  // the controlled rehearsal seeding the claim consumes FIRST and
  // execution runs exactly once. A policy activation writes nothing to
  // the verification store.
  {
    const harness = await makeHarness();
    await toPreviewReady(harness);
    const execution = makeExecutionHarness(harness);
    const blocked = await claimThenExecute(
      harness,
      createInMemoryTransactionVerificationRepository(),
      execution.deps,
    );
    check(
      blocked.claimed === null && blocked.outcome === null,
      "s22: a failed claim must not call confirmInterventionExecution",
    );
    check(
      execution.pathCalls.length === 0 &&
        execution.confirmationsCreated() === 0 &&
        execution.operationsStarted() === 0,
      "s22: the blocked path must invoke nothing",
    );

    const verifications = await seedVerificationFor(harness);
    await harness.policies.activate(
      policySnapshotFor("duelogic-policy-v2", 30_000, harness.clock.now()),
    );
    const interventionId = (await harness.repository.list())[0].interventionId;
    const afterActivation =
      await verifications.readVerifiedForIntervention(interventionId);
    check(
      afterActivation !== null && afterActivation.consumedAt === null,
      "s22: a policy activation must neither create nor consume verification records",
    );

    const executed = await claimThenExecute(harness, verifications, execution.deps);
    check(
      executed.claimed !== null && executed.claimed.consumedAt !== null,
      "s22: the claim must consume before execution",
    );
    check(
      executed.outcome !== null &&
        executed.outcome.ok &&
        executed.outcome.record.status === "executed",
      "s22: execution must run exactly once after a successful claim",
    );
    const reclaim = await verifications.claimForExecution(
      interventionId,
      transactionVerificationExpectationFor(
        (await harness.repository.readById(
          interventionId,
        )) as DueLogicInterventionRecord,
      ),
      harness.clock.now(),
    );
    check(reclaim === null, "s22: the claim is single-use");
    record("s22-claim-gates-internal-execution", "claim-first");
  }

  // s23: a pre-mutation internal refusal does NOT restore the claimed
  // verification. Claims are terminal, and write-once seeding refuses a
  // replacement — a fresh verification would require a new invitation.
  {
    const harness = await makeHarness();
    await toPreviewReady(harness);
    const execution = makeExecutionHarness(harness);
    const refusingDeps: InterventionExecutionDeps = {
      ...execution.deps,
      executeReplacementPath: async () => ({
        kind: "refused",
        stage: "confirmation-stale",
      }),
    };
    const verifications = await seedVerificationFor(harness);
    const result = await claimThenExecute(harness, verifications, refusingDeps);
    check(
      result.claimed !== null,
      "s23: the claim must succeed before the refusal",
    );
    check(
      result.outcome !== null &&
        !result.outcome.ok &&
        result.outcome.reason === "refused",
      "s23: the internal path must refuse before any mutation",
    );
    const reverted = await harness.repository.readByTokenHash(
      harness.tokenDeps.hashToken(FIRST_RAW_TOKEN),
    );
    check(
      reverted !== null &&
        reverted.status === "preview-ready" &&
        reverted.confirmationId === null &&
        reverted.operationId === null,
      "s23: the refusal must revert the intervention with nothing external changed",
    );
    const storedVerification = await verifications.readVerifiedForIntervention(
      (reverted as DueLogicInterventionRecord).interventionId,
    );
    check(
      storedVerification !== null && storedVerification.consumedAt !== null,
      "s23: the verification must remain consumed after the refusal",
    );
    const reclaim = await verifications.claimForExecution(
      (reverted as DueLogicInterventionRecord).interventionId,
      transactionVerificationExpectationFor(
        reverted as DueLogicInterventionRecord,
      ),
      harness.clock.now(),
    );
    check(reclaim === null, "s23: no reclaim is possible — claims are terminal");
    const reseed = await seedRehearsalTransactionVerification(
      { token: FIRST_RAW_TOKEN },
      {
        interventions: harness.repository,
        verifications,
        policies: harness.policies,
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
        generateVerificationId: () => "ver_demo_02",
      },
    );
    check(
      !reseed.ok && reseed.reason === "already-seeded",
      "s23: write-once seeding must refuse replacing the consumed verification",
    );
    record("s23-refusal-keeps-claim-consumed", "terminal");
  }

  // s24: a manual-recovery outcome retains the consumed verification as
  // evidence — no rollback, no reclaim, no re-execution.
  {
    const harness = await makeHarness();
    await toPreviewReady(harness);
    const execution = makeExecutionHarness(harness, { createFails: true });
    const verifications = await seedVerificationFor(harness);
    const result = await claimThenExecute(harness, verifications, execution.deps);
    check(result.claimed !== null, "s24: the claim must succeed first");
    check(
      result.outcome !== null &&
        !result.outcome.ok &&
        result.outcome.reason === "manual-recovery-required",
      "s24: the simulated post-cancellation failure must report manual recovery",
    );
    const stored = await harness.repository.readByTokenHash(
      harness.tokenDeps.hashToken(FIRST_RAW_TOKEN),
    );
    check(
      stored !== null && stored.status === "manual-recovery-required",
      "s24: the intervention must record the manual-recovery state",
    );
    const storedVerification = await verifications.readVerifiedForIntervention(
      (stored as DueLogicInterventionRecord).interventionId,
    );
    check(
      storedVerification !== null && storedVerification.consumedAt !== null,
      "s24: the consumed verification must be retained as evidence",
    );
    record("s24-failure-retains-consumed-verification", "evidence-retained");
  }

  return { scenarioCount: table.length, decisionTable: table };
}

// ---------------------------------------------------------------------------
// Module-load kick-off, mirroring the customer-confirmation validation: one
// full async pass whose failure is logged loudly; the dev intervention scan
// route and the dashboard render re-assert the table on every request.

void validateInterventionFlow().catch((error: unknown) => {
  console.error("Intervention validation failed at module load.", {
    errorClass: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  });
});
