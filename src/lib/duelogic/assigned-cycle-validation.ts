/**
 * Deterministic validation of the assigned-billing-cycle movement
 * safeguard: a revised payment date must remain inside the billing cycle
 * already assigned to the affected payment — for monthly schedules the
 * same merchant-local calendar month and year; for weekly and
 * fortnightly schedules the trusted-cadence cycle bound to the
 * intervention. Covers the engine rule, the availability clamp, the
 * binding boundary and the protected execution preflight re-check.
 * Follows the repository's validation convention (exported async
 * re-assertion plus a module-load kick-off with loud failure logging).
 *
 * Nothing here calls Pinch or reads a clock: repositories, clocks,
 * payments, mobiles, secrets and codes are injected fakes over synthetic
 * identifiers, and the execution scenarios count the mutation effect's
 * invocations to prove refusals happen before any effect.
 */

import { createInMemoryInterventionRepository } from "./dev-intervention-store";
import { createInMemoryFixturePaymentRepository } from "./dev-movement-store";
import { createInMemoryOtpChallengeRepository } from "./dev-otp-store";
import { createInMemoryDevSmsStore, type DevSmsMessage } from "./dev-sms-store";
import {
  createInMemoryTemporaryConfirmationRepository,
  createInMemoryTemporaryOperationRepository,
  createInMemoryTemporarySelectionRepository,
  createInMemoryTemporaryVerificationRepository,
} from "./dev-temporary-operation-store";
import type { DueLogicInterventionRecord } from "./intervention";
import {
  deriveMovementAvailability,
  type MovementAvailabilityDeps,
} from "./movement-availability";
import {
  evaluateScheduleChange,
  PolicyValidationError,
  type PermanentPolicyEvaluationRequest,
  type TemporaryPolicyEvaluationRequest,
} from "./policy/engine";
import { createInMemoryMerchantPolicyRepository } from "./policy/dev-policy-store";
import { DEFAULT_DUELOGIC_POLICY } from "./policy/rules";
import type { MerchantPlanScheduleConfiguration } from "./schema";
import {
  evaluateAndBindTemporarySelection,
  executeTemporaryPaymentChange,
  requestTemporaryOtp,
  verifyTemporaryOtp,
  type TemporaryJourneyDeps,
} from "./temporary-execution-service";
import {
  toTemporaryPriorScheduleChanges,
  type TemporaryOperationSelection,
  type TemporaryPaymentOperationRecord,
  type TemporaryTransactionVerificationRecord,
} from "./temporary-operation";
import type { AuthoritativePaymentSnapshot } from "@/lib/pinch/payment-movement";

export interface AssignedCycleValidationRow {
  scenario: string;
  outcome: string;
}

export interface AssignedCycleValidationResult {
  scenarioCount: number;
  decisionTable: AssignedCycleValidationRow[];
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assigned-cycle validation failed: ${message}`);
  }
}

function fakeHash(raw: string): string {
  return `fakehash:${raw.split("").reverse().join("")}`;
}

const RAW_TOKEN = "raw-cycle-demo-01";
const TEST_SECRET = "assigned-cycle-test-secret";
const FAKE_MOBILE = "0491570156"; // ACMA-reserved fictional AU mobile.

/** Clock fixed so the Sydney evaluation date is 2026-08-01. */
const CLOCK_START = "2026-08-01T00:00:00.000Z";

/** Trusted fortnightly mapping: 14-day cycles anchored 2026-07-28. */
const PLAN_CONFIG: MerchantPlanScheduleConfiguration = {
  merchantId: "mch_demo",
  plans: {
    pln_cycle_fortnightly: {
      cadence: "fortnightly",
      cycleDefinition: "fixed-days",
      cycleLengthDays: 14,
      cycleAnchorDate: "2026-07-28",
    },
  },
};

// ---------------------------------------------------------------------------
// Engine request builders

function temporaryRequest(shape: {
  current: string;
  requested: string;
  cycleStart?: string;
  cycleEnd?: string;
  evaluation?: string;
}): TemporaryPolicyEvaluationRequest {
  return {
    changeType: "temporary",
    payerId: "pyr_cycle_demo",
    paymentId: "pmt_cycle_demo",
    amountCents: 12500,
    evaluationDate: shape.evaluation ?? "2026-08-01",
    currentArrearsCents: 0,
    currentPaymentDate: shape.current,
    requestedDate: shape.requested,
    ...(shape.cycleStart !== undefined && shape.cycleEnd !== undefined
      ? {
          currentCycleStartDate: shape.cycleStart,
          currentCycleEndDate: shape.cycleEnd,
        }
      : {}),
  };
}

function permanentRequest(shape: {
  effectiveCycle: "current-and-future" | "next-cycle-and-future";
  anchor: string;
}): PermanentPolicyEvaluationRequest {
  return {
    changeType: "permanent",
    payerId: "pyr_cycle_demo",
    paymentId: "sub_cycle_demo-first-payment",
    amountCents: 12500,
    evaluationDate: "2026-08-01",
    currentArrearsCents: 0,
    scheduleCadence: "fortnightly",
    effectiveCycle: shape.effectiveCycle,
    previousPaymentDate: "2026-07-22",
    currentPaymentDate: "2026-08-05",
    nextPaymentDate: "2026-08-19",
    currentCycleStartDate: "2026-07-28",
    currentCycleEndDate: "2026-08-10",
    nextCycleStartDate: "2026-08-11",
    nextCycleEndDate: "2026-08-24",
    requestedAnchorDate: shape.anchor,
  };
}

// ---------------------------------------------------------------------------
// Journey harness

function cycleRecord(shape: {
  currentStartDate?: string;
}): DueLogicInterventionRecord {
  return {
    interventionId: "int_cycle_demo_01",
    notificationId: "ntf_cycle_demo_01",
    tokenHash: fakeHash(RAW_TOKEN),
    merchantId: "mch_demo",
    payerId: "pyr_cycle_demo",
    sourceId: "src_cycle_demo",
    subscriptionId: "sub_cycle_demo",
    planId: "pln_cycle_fortnightly",
    patternFlagId: "flag_cycle_demo",
    policyVersion: DEFAULT_DUELOGIC_POLICY.version,
    scheduleCadence: "fortnightly",
    changeMode: "permanent",
    currentStartDate: shape.currentStartDate ?? "2026-08-05",
    currentPaymentAmountInCents: 12500,
    currentCycleStartDate: "2026-07-28",
    currentCycleEndDate: "2026-08-10",
    suggestedDate: "2026-08-07",
    selectedDate: null,
    offeredAlternativeDate: null,
    policyOutcome: null,
    policyReasonCode: null,
    policyRuleFired: null,
    policyExplanation: null,
    policyWarnings: [],
    currentPayments: null,
    proposedPayments: null,
    currency: "AUD",
    confirmationId: null,
    operationId: null,
    newSubscriptionId: null,
    status: "opened",
    createdAt: CLOCK_START,
    expiresAt: "2026-09-01T00:00:00.000Z",
    openedAt: CLOCK_START,
    selectedAt: null,
    declinedAt: null,
    updatedAt: CLOCK_START,
  };
}

interface CycleHarness {
  deps: TemporaryJourneyDeps;
  availability: MovementAvailabilityDeps;
  selectionMap: Map<string, TemporaryOperationSelection>;
  verificationMap: Map<string, TemporaryTransactionVerificationRecord>;
  operationMap: Map<string, TemporaryPaymentOperationRecord>;
  smsMap: Map<string, DevSmsMessage>;
  mutationCalls(): number;
  now(): string;
}

async function makeCycleHarness(
  record: DueLogicInterventionRecord,
): Promise<CycleHarness> {
  const interventions = createInMemoryInterventionRepository();
  const payments = createInMemoryFixturePaymentRepository();
  const policies = createInMemoryMerchantPolicyRepository();
  const selectionMap = new Map<string, TemporaryOperationSelection>();
  const verificationMap = new Map<
    string,
    TemporaryTransactionVerificationRecord
  >();
  const operationMap = new Map<string, TemporaryPaymentOperationRecord>();
  const smsMap = new Map<string, DevSmsMessage>();

  let currentMs = Date.parse(CLOCK_START);
  const now = (): string => {
    currentMs += 1_000;
    return new Date(currentMs).toISOString();
  };

  await policies.activate({
    policyVersion: DEFAULT_DUELOGIC_POLICY.version,
    merchantId: "mch_demo",
    policy: DEFAULT_DUELOGIC_POLICY,
    activatedAt: now(),
    installedAsInitialDefault: true,
  });
  await interventions.write(record);
  const payment: AuthoritativePaymentSnapshot = {
    id: "pmt_cycle_demo_01",
    payerId: record.payerId,
    amountInCents: record.currentPaymentAmountInCents,
    transactionDate: record.currentStartDate,
    status: "scheduled",
  };
  await payments.upsert(record.payerId, payment);

  const temporaryOperations =
    createInMemoryTemporaryOperationRepository(operationMap);
  let mutations = 0;
  const codeNumbers = [111222, 333444, 555666];
  let idCounter = 0;
  const nextId = (prefix: string): string => {
    idCounter += 1;
    return `${prefix}_cycle_${String(idCounter).padStart(2, "0")}`;
  };

  const availability: MovementAvailabilityDeps = {
    policies,
    interventions,
    temporaryOperations,
    readUpcomingScheduledPayment: (merchantId, payerId) =>
      payments.readUpcomingForPayer(payerId),
    planScheduleConfiguration: PLAN_CONFIG,
    merchantTimezone: "Australia/Sydney",
    currentArrearsCents: () => 0,
    now,
  };

  return {
    availability,
    selectionMap,
    verificationMap,
    operationMap,
    smsMap,
    mutationCalls: () => mutations,
    now,
    deps: {
      interventions,
      selections: createInMemoryTemporarySelectionRepository(selectionMap),
      temporaryVerifications:
        createInMemoryTemporaryVerificationRepository(verificationMap),
      temporaryConfirmations: createInMemoryTemporaryConfirmationRepository(),
      temporaryOperations,
      policies,
      challenges: createInMemoryOtpChallengeRepository(),
      sms: createInMemoryDevSmsStore(smsMap),
      readUpcomingScheduledPayment: (merchantId, payerId) =>
        payments.readUpcomingForPayer(payerId),
      readPayment: (merchantId, paymentId) => payments.readById(paymentId),
      updatePaymentDate: async (merchantId, body) => {
        mutations += 1;
        return payments.applyDateUpdate(body);
      },
      readPayerMobile: async () => FAKE_MOBILE,
      currentArrearsCents: () => 0,
      merchantTimezone: "Australia/Sydney",
      now,
      hashToken: fakeHash,
      otpHmacSecret: () => TEST_SECRET,
      generateSelectionId: () => nextId("tsel"),
      generateChallengeId: () => nextId("otpch"),
      generateSmsId: () => nextId("sms"),
      generateVerificationId: () => nextId("tver"),
      generateConfirmationId: () => nextId("tconf"),
      generateOperationId: () => nextId("top"),
      generateOtpCodeNumber: () => {
        const next = codeNumbers.shift();
        if (next === undefined) {
          throw new Error("Assigned-cycle validation exhausted its code list.");
        }
        return next;
      },
    },
  };
}

function latestSmsCode(smsMap: Map<string, DevSmsMessage>): string {
  const messages = [...smsMap.values()];
  const body = messages[messages.length - 1]?.body ?? "";
  const match = /\b(\d{6})\b/.exec(body);
  check(match !== null, "fixture: the latest SMS must contain a six-digit code");
  return (match as RegExpExecArray)[1];
}

// ---------------------------------------------------------------------------
// Scenario table

export async function validateAssignedCycleEnforcement(): Promise<AssignedCycleValidationResult> {
  const table: AssignedCycleValidationRow[] = [];
  const record = (scenario: string, outcome: string): void => {
    table.push({ scenario, outcome });
  };
  const evaluate = (request: TemporaryPolicyEvaluationRequest) =>
    evaluateScheduleChange(request, [], DEFAULT_DUELOGIC_POLICY);

  // ac1: monthly, 10 August moved to each of 11-15 August is permitted.
  for (let day = 11; day <= 15; day += 1) {
    const decision = evaluate(
      temporaryRequest({
        current: "2026-08-10",
        requested: `2026-08-${day}`,
        cycleStart: "2026-08-01",
        cycleEnd: "2026-08-31",
      }),
    );
    check(
      decision.outcome === "approved",
      `ac1: 10 August to ${day} August must be approved`,
    );
  }
  record("ac1-monthly-aug10-to-11-15", "approved");

  // ac2: monthly, 29 August to 30 and 31 August is permitted.
  for (const requested of ["2026-08-30", "2026-08-31"]) {
    check(
      evaluate(
        temporaryRequest({
          current: "2026-08-29",
          requested,
          cycleStart: "2026-08-01",
          cycleEnd: "2026-08-31",
        }),
      ).outcome === "approved",
      "ac2: 29 August to 30-31 August must be approved",
    );
  }
  record("ac2-monthly-aug29-to-30-31", "approved");

  // ac3: monthly, 29 August into September refused with the latest
  // compliant same-month alternative.
  {
    const decision = evaluate(
      temporaryRequest({
        current: "2026-08-29",
        requested: "2026-09-01",
        cycleStart: "2026-08-01",
        cycleEnd: "2026-08-31",
      }),
    );
    check(
      decision.outcome === "shorter-alternative" &&
        decision.alternativeDate === "2026-08-31" &&
        decision.reasonCode === "TEMPORARY_OUTSIDE_ASSIGNED_CYCLE",
      "ac3: 29 August into September must return 31 August as the alternative",
    );
    record("ac3-monthly-september-refused", "cycle-clamped-alternative");
  }

  // ac4: 30 April has no later same-month temporary date.
  {
    const decision = evaluate(
      temporaryRequest({
        current: "2026-04-30",
        requested: "2026-05-02",
        cycleStart: "2026-04-01",
        cycleEnd: "2026-04-30",
        evaluation: "2026-04-25",
      }),
    );
    check(
      decision.outcome === "escalate" &&
        decision.reasonCode === "TEMPORARY_NO_DATE_IN_ASSIGNED_CYCLE",
      "ac4: 30 April must have no later same-month date",
    );
    record("ac4-april30-no-later-date", "escalate");
  }

  // ac5: 31 August has no temporary date at all.
  {
    const decision = evaluate(
      temporaryRequest({
        current: "2026-08-31",
        requested: "2026-09-02",
        cycleStart: "2026-08-01",
        cycleEnd: "2026-08-31",
      }),
    );
    check(
      decision.outcome === "escalate" &&
        decision.reasonCode === "TEMPORARY_NO_DATE_IN_ASSIGNED_CYCLE",
      "ac5: 31 August must have no temporary date",
    );
    record("ac5-aug31-no-temporary-date", "escalate");
  }

  // ac6: 27 February in a non-leap year permits 28 February only.
  {
    const nonLeap = {
      current: "2027-02-27",
      cycleStart: "2027-02-01",
      cycleEnd: "2027-02-28",
      evaluation: "2027-02-20",
    };
    check(
      evaluate(temporaryRequest({ ...nonLeap, requested: "2027-02-28" }))
        .outcome === "approved",
      "ac6: 27 February non-leap must permit 28 February",
    );
    const over = evaluate(
      temporaryRequest({ ...nonLeap, requested: "2027-03-01" }),
    );
    check(
      over.outcome === "shorter-alternative" &&
        over.alternativeDate === "2027-02-28",
      "ac6: 27 February non-leap must clamp March to 28 February",
    );
    record("ac6-feb27-nonleap-28-only", "clamped-to-28");
  }

  // ac7: 27 February in a leap year permits 28 and 29 February.
  {
    const leap = {
      current: "2028-02-27",
      cycleStart: "2028-02-01",
      cycleEnd: "2028-02-29",
      evaluation: "2028-02-20",
    };
    for (const requested of ["2028-02-28", "2028-02-29"]) {
      check(
        evaluate(temporaryRequest({ ...leap, requested })).outcome ===
          "approved",
        "ac7: 27 February leap must permit 28 and 29 February",
      );
    }
    const over = evaluate(
      temporaryRequest({ ...leap, requested: "2028-03-01" }),
    );
    check(
      over.outcome === "shorter-alternative" &&
        over.alternativeDate === "2028-02-29",
      "ac7: 27 February leap must clamp March to 29 February",
    );
    record("ac7-feb27-leap-28-and-29", "clamped-to-29");
  }

  // ac8: December-to-January rollover refused.
  {
    const decision = evaluate(
      temporaryRequest({
        current: "2026-12-29",
        requested: "2027-01-02",
        cycleStart: "2026-12-01",
        cycleEnd: "2026-12-31",
        evaluation: "2026-12-20",
      }),
    );
    check(
      decision.outcome === "shorter-alternative" &&
        decision.alternativeDate === "2026-12-31" &&
        decision.reasonCode === "TEMPORARY_OUTSIDE_ASSIGNED_CYCLE",
      "ac8: a December payment must not become a January payment",
    );
    record("ac8-december-january-rollover-refused", "cycle-clamped");
  }

  // ac9: fortnightly, a later date inside the original assigned cycle is
  // permitted.
  check(
    evaluate(
      temporaryRequest({
        current: "2026-08-05",
        requested: "2026-08-08",
        cycleStart: "2026-07-28",
        cycleEnd: "2026-08-10",
      }),
    ).outcome === "approved",
    "ac9: a later in-cycle fortnightly date must be approved",
  );
  record("ac9-fortnightly-in-cycle-permitted", "approved");

  // ac10: fortnightly, a date in the next assigned cycle is refused even
  // within the five-day cap.
  {
    const decision = evaluate(
      temporaryRequest({
        current: "2026-08-07",
        requested: "2026-08-11",
        cycleStart: "2026-07-28",
        cycleEnd: "2026-08-10",
      }),
    );
    check(
      decision.outcome === "shorter-alternative" &&
        decision.alternativeDate === "2026-08-10" &&
        decision.reasonCode === "TEMPORARY_OUTSIDE_ASSIGNED_CYCLE",
      "ac10: a next-cycle fortnightly date must clamp to the cycle end",
    );
    record("ac10-fortnightly-next-cycle-refused", "cycle-clamped");
  }

  // ac11: cycle resolution uses the trusted Plan cadence — the availability
  // window derives from the mapped anchored cycle and is clamped to it.
  {
    const harness = await makeCycleHarness(
      cycleRecord({ currentStartDate: "2026-08-08" }),
    );
    const derived = await deriveMovementAvailability(
      cycleRecord({ currentStartDate: "2026-08-08" }),
      harness.availability,
    );
    const temporary =
      derived.outcome === "resolved"
        ? derived.availability.options.find((o) => o.kind === "temporary")
        : undefined;
    check(
      temporary !== undefined &&
        temporary.windowStartDate === "2026-08-09" &&
        temporary.windowEndDate === "2026-08-10",
      "ac11: the availability window must clamp to the trusted-cadence cycle end",
    );
    record("ac11-trusted-cadence-window-clamped", "clamped");
  }

  // ac12: crossing a calendar-month boundary INSIDE the assigned
  // fortnightly cycle is permitted — the assigned-cycle rule, never an
  // invented month-only comparison or local schedule.
  check(
    evaluate(
      temporaryRequest({
        current: "2026-07-30",
        requested: "2026-08-02",
        cycleStart: "2026-07-28",
        cycleEnd: "2026-08-10",
      }),
    ).outcome === "approved",
    "ac12: an in-cycle month-boundary crossing must be approved",
  );
  record("ac12-month-boundary-inside-cycle-permitted", "approved");

  // ac13: with no compliant later date, the temporary option disappears
  // server-side.
  {
    const harness = await makeCycleHarness(
      cycleRecord({ currentStartDate: "2026-08-10" }),
    );
    const derived = await deriveMovementAvailability(
      cycleRecord({ currentStartDate: "2026-08-10" }),
      harness.availability,
    );
    check(
      derived.outcome === "resolved" &&
        !derived.availability.options.some((o) => o.kind === "temporary"),
      "ac13: a payment on its cycle end must have no temporary option",
    );
    record("ac13-no-compliant-date-removes-option", "option-absent");
  }

  // ac14: malformed cycle metadata is a validation error, never repaired.
  {
    let outsideRefused = false;
    try {
      evaluate(
        temporaryRequest({
          current: "2026-08-05",
          requested: "2026-08-07",
          cycleStart: "2026-08-10",
          cycleEnd: "2026-08-20",
        }),
      );
    } catch (error) {
      outsideRefused =
        error instanceof PolicyValidationError &&
        error.code === "INVALID_CYCLE_METADATA";
    }
    let oneSidedRefused = false;
    try {
      evaluate({
        ...temporaryRequest({ current: "2026-08-05", requested: "2026-08-07" }),
        currentCycleEndDate: "2026-08-10",
      });
    } catch (error) {
      oneSidedRefused =
        error instanceof PolicyValidationError &&
        error.code === "INVALID_CYCLE_METADATA";
    }
    check(
      outsideRefused && oneSidedRefused,
      "ac14: malformed or contradictory cycle metadata must be a validation error",
    );
    record("ac14-malformed-cycle-metadata", "validation-error");
  }

  // ac15: baseline without cycle bounds is unchanged (the replay path).
  {
    const over = evaluate(
      temporaryRequest({ current: "2026-08-05", requested: "2026-08-12" }),
    );
    check(
      over.outcome === "shorter-alternative" &&
        over.alternativeDate === "2026-08-10" &&
        over.reasonCode === "TEMPORARY_SHIFT_EXCEEDS_MAXIMUM" &&
        evaluate(
          temporaryRequest({ current: "2026-08-05", requested: "2026-08-08" }),
        ).outcome === "approved",
      "ac15: behaviour without cycle bounds must be unchanged",
    );
    record("ac15-no-bounds-baseline-unchanged", "unchanged");
  }

  // ac16: a forged next-cycle preview is refused at binding — nothing is
  // bound until the customer accepts a compliant date.
  {
    const harness = await makeCycleHarness(
      cycleRecord({ currentStartDate: "2026-08-07" }),
    );
    const outcome = await evaluateAndBindTemporarySelection(
      { token: RAW_TOKEN, requestedDate: "2026-08-11" },
      harness.deps,
    );
    check(
      !outcome.ok &&
        outcome.reason === "alternative-offered" &&
        outcome.alternativeDate === "2026-08-10" &&
        (await harness.deps.selections.readActive("int_cycle_demo_01")) ===
          null,
      "ac16: a forged next-cycle preview must be refused at binding",
    );
    record("ac16-forged-next-cycle-preview-refused", "not-bound");
  }

  // ac17: the compliant journey completes, and the confirmation remains
  // bound to the exact movement, date and amount.
  {
    const harness = await makeCycleHarness(cycleRecord({}));
    check(
      (
        await evaluateAndBindTemporarySelection(
          { token: RAW_TOKEN, requestedDate: "2026-08-09" },
          harness.deps,
        )
      ).ok,
      "ac17 fixture: the compliant binding must approve",
    );
    check(
      (await requestTemporaryOtp({ token: RAW_TOKEN }, harness.deps)).ok,
      "ac17 fixture: the OTP must issue",
    );
    check(
      (
        await verifyTemporaryOtp(
          { token: RAW_TOKEN, code: latestSmsCode(harness.smsMap) },
          harness.deps,
        )
      ).ok,
      "ac17 fixture: the OTP must verify",
    );
    const executed = await executeTemporaryPaymentChange(
      { token: RAW_TOKEN },
      harness.deps,
    );
    check(
      executed.ok &&
        executed.operation.status === "temporary-change-verified" &&
        executed.operation.verifiedTransactionDate === "2026-08-09" &&
        executed.operation.proposedTransactionDate === "2026-08-09" &&
        executed.operation.amountInCents === 12500 &&
        harness.mutationCalls() === 1,
      "ac17: the compliant in-cycle execution must verify",
    );
    const confirmation = executed.ok
      ? await harness.deps.temporaryConfirmations.readById(
          executed.operation.confirmationId,
        )
      : null;
    check(
      confirmation !== null &&
        confirmation.status === "consumed" &&
        confirmation.operationId ===
          (executed.ok ? executed.operation.operationId : "") &&
        confirmation.confirmedTransactionDate === "2026-08-09" &&
        confirmation.amountInCents === 12500,
      "ac17: the confirmation must remain bound to the exact movement",
    );
    record("ac17-compliant-execution-and-binding", "verified-and-bound");
  }

  // ac18 + ac19: a forged or stale next-cycle binding is refused at the
  // protected execution preflight BEFORE any effect — the verification is
  // not consumed, no mutation or operation evidence exists, and no rolling
  // usage is consumed.
  {
    const harness = await makeCycleHarness(cycleRecord({}));
    check(
      (
        await evaluateAndBindTemporarySelection(
          { token: RAW_TOKEN, requestedDate: "2026-08-09" },
          harness.deps,
        )
      ).ok,
      "ac18 fixture: the initial binding must approve",
    );
    check(
      (await requestTemporaryOtp({ token: RAW_TOKEN }, harness.deps)).ok &&
        (
          await verifyTemporaryOtp(
            { token: RAW_TOKEN, code: latestSmsCode(harness.smsMap) },
            harness.deps,
          )
        ).ok,
      "ac18 fixture: the verification must exist",
    );
    // Simulate a stale or forged binding from before the rule existed:
    // both the selection and its verification carry a next-cycle date
    // that still satisfies the old five-day check.
    const boundSelection = harness.selectionMap.get("int_cycle_demo_01");
    const boundVerification = harness.verificationMap.get("int_cycle_demo_01");
    check(
      boundSelection !== undefined && boundVerification !== undefined,
      "ac18 fixture: the bound records must exist",
    );
    harness.selectionMap.set("int_cycle_demo_01", {
      ...(boundSelection as TemporaryOperationSelection),
      proposedTransactionDate: "2026-08-12",
    });
    harness.verificationMap.set("int_cycle_demo_01", {
      ...(boundVerification as TemporaryTransactionVerificationRecord),
      proposedTransactionDate: "2026-08-12",
    });
    const refused = await executeTemporaryPaymentChange(
      { token: RAW_TOKEN },
      harness.deps,
    );
    check(
      !refused.ok && refused.reason === "selection-outside-assigned-cycle",
      "ac18: a next-cycle bound date must refuse at the execution preflight",
    );
    check(
      harness.mutationCalls() === 0 &&
        harness.operationMap.size === 0 &&
        harness.verificationMap.get("int_cycle_demo_01")?.consumedAt === null,
      "ac18: the refusal must happen before any effect and consume no verification",
    );
    record("ac18-forged-execution-refused-before-effects", "refused-pre-claim");

    const usage = toTemporaryPriorScheduleChanges(
      [...harness.operationMap.values()],
      "pyr_cycle_demo",
      "mch_demo",
      "Australia/Sydney",
    );
    check(
      usage.length === 0,
      "ac19: a refused attempt must not consume rolling usage",
    );
    record("ac19-refusal-consumes-no-usage", "zero-usage");
  }

  // ac20: permanent current-and-future cannot move the affected current
  // payment into the next assigned cycle — the engine refuses the anchor.
  {
    let refused = false;
    try {
      evaluateScheduleChange(
        permanentRequest({
          effectiveCycle: "current-and-future",
          anchor: "2026-08-12",
        }),
        [],
        DEFAULT_DUELOGIC_POLICY,
      );
    } catch (error) {
      refused =
        error instanceof PolicyValidationError &&
        error.code === "INVALID_CYCLE_METADATA";
    }
    check(
      refused,
      "ac20: a current-cycle anchor in the next cycle must be refused",
    );
    record("ac20-permanent-current-stays-in-cycle", "refused");
  }

  // ac21: permanent next-cycle-and-future preserves the unchanged current
  // payment.
  {
    const decision = evaluateScheduleChange(
      permanentRequest({
        effectiveCycle: "next-cycle-and-future",
        anchor: "2026-08-12",
      }),
      [],
      DEFAULT_DUELOGIC_POLICY,
    );
    check(
      decision.outcome === "approved" &&
        decision.changeType === "permanent" &&
        decision.currentPaymentAction === "keep" &&
        decision.resultingCurrentPaymentDate === "2026-08-05",
      "ac21: the next-cycle mode must keep the current payment unchanged",
    );
    record("ac21-permanent-next-cycle-keeps-current", "kept");
  }

  // ac22: missing (blank) stored cycle metadata fails closed at
  // AVAILABILITY — the temporary option is never offered.
  {
    const corrupted: DueLogicInterventionRecord = {
      ...cycleRecord({}),
      currentCycleStartDate: "",
      currentCycleEndDate: "",
    };
    const harness = await makeCycleHarness(corrupted);
    const derived = await deriveMovementAvailability(
      corrupted,
      harness.availability,
    );
    check(
      derived.outcome !== "resolved" ||
        !derived.availability.options.some((o) => o.kind === "temporary"),
      "ac22: missing cycle metadata must remove the temporary option",
    );
    record("ac22-missing-metadata-availability-closed", "option-absent");
  }

  // ac23: missing stored cycle metadata fails closed at PREVIEW BINDING —
  // the engine refuses the malformed bounds and nothing is bound.
  {
    const corrupted: DueLogicInterventionRecord = {
      ...cycleRecord({}),
      currentCycleStartDate: "",
      currentCycleEndDate: "",
    };
    const harness = await makeCycleHarness(corrupted);
    const outcome = await evaluateAndBindTemporarySelection(
      { token: RAW_TOKEN, requestedDate: "2026-08-07" },
      harness.deps,
    );
    check(
      !outcome.ok &&
        outcome.reason === "validation" &&
        (await harness.deps.selections.readActive("int_cycle_demo_01")) ===
          null,
      "ac23: missing cycle metadata must refuse preview binding",
    );
    record("ac23-missing-metadata-binding-closed", "validation-refusal");
  }

  // ac24: cycle metadata lost AFTER a valid journey fails closed at the
  // FINAL EXECUTION PREFLIGHT — refused before any claim or effect.
  {
    const harness = await makeCycleHarness(cycleRecord({}));
    check(
      (
        await evaluateAndBindTemporarySelection(
          { token: RAW_TOKEN, requestedDate: "2026-08-09" },
          harness.deps,
        )
      ).ok &&
        (await requestTemporaryOtp({ token: RAW_TOKEN }, harness.deps)).ok &&
        (
          await verifyTemporaryOtp(
            { token: RAW_TOKEN, code: latestSmsCode(harness.smsMap) },
            harness.deps,
          )
        ).ok,
      "ac24 fixture: the compliant journey must verify",
    );
    await harness.deps.interventions.write({
      ...cycleRecord({}),
      currentCycleStartDate: "",
      currentCycleEndDate: "",
    });
    const refused = await executeTemporaryPaymentChange(
      { token: RAW_TOKEN },
      harness.deps,
    );
    check(
      !refused.ok &&
        refused.reason === "selection-outside-assigned-cycle" &&
        harness.mutationCalls() === 0 &&
        harness.operationMap.size === 0 &&
        harness.verificationMap.get("int_cycle_demo_01")?.consumedAt === null,
      "ac24: lost cycle metadata must refuse execution before any effect",
    );
    record("ac24-missing-metadata-execution-closed", "refused-pre-claim");
  }

  // ac25: a corrupted NON-DATE cycle bound that sorts lexicographically
  // after valid ISO dates fails closed at the final execution preflight —
  // the strict calendar-date validation refuses before any claim,
  // confirmation, evidence or mutation, for both bounds.
  {
    const harness = await makeCycleHarness(cycleRecord({}));
    check(
      (
        await evaluateAndBindTemporarySelection(
          { token: RAW_TOKEN, requestedDate: "2026-08-09" },
          harness.deps,
        )
      ).ok &&
        (await requestTemporaryOtp({ token: RAW_TOKEN }, harness.deps)).ok &&
        (
          await verifyTemporaryOtp(
            { token: RAW_TOKEN, code: latestSmsCode(harness.smsMap) },
            harness.deps,
          )
        ).ok,
      "ac25 fixture: the compliant journey must verify",
    );
    // "not-a-date" begins with "n", which sorts after every "2..."-prefixed
    // ISO date — the exact shape a lexical-only comparison would miss.
    await harness.deps.interventions.write({
      ...cycleRecord({}),
      currentCycleEndDate: "not-a-date",
    });
    const endRefused = await executeTemporaryPaymentChange(
      { token: RAW_TOKEN },
      harness.deps,
    );
    check(
      !endRefused.ok &&
        endRefused.reason === "selection-outside-assigned-cycle",
      "ac25: a corrupted non-date cycle end must refuse execution",
    );
    // Same guarantee for a corrupted cycle start.
    await harness.deps.interventions.write({
      ...cycleRecord({}),
      currentCycleStartDate: "not-a-date",
    });
    const startRefused = await executeTemporaryPaymentChange(
      { token: RAW_TOKEN },
      harness.deps,
    );
    check(
      !startRefused.ok &&
        startRefused.reason === "selection-outside-assigned-cycle",
      "ac25: a corrupted non-date cycle start must refuse execution",
    );
    const storedRecord = await harness.deps.interventions.readById(
      "int_cycle_demo_01",
    );
    check(
      harness.mutationCalls() === 0 &&
        harness.operationMap.size === 0 &&
        harness.verificationMap.get("int_cycle_demo_01")?.consumedAt === null &&
        storedRecord !== null &&
        storedRecord.status !== "executed" &&
        storedRecord.confirmationId === null &&
        storedRecord.operationId === null,
      "ac25: the refusal must precede every effect and the intervention must not execute",
    );
    record("ac25-nondate-metadata-execution-closed", "refused-pre-claim");
  }

  return { scenarioCount: table.length, decisionTable: table };
}

// ---------------------------------------------------------------------------
// Module-load kick-off, mirroring the sibling validation modules.

void validateAssignedCycleEnforcement().catch((error: unknown) => {
  console.error("Assigned-cycle validation failed at module load.", {
    errorClass: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  });
});
