/**
 * Deterministic validation of the customer movement-choice wiring:
 * server-derived availability, selection binding, invalidation, OTP and
 * confirmation dispatch, and the customer-safe projections. Follows the
 * repository's validation convention (exported async re-assertion plus a
 * module-load kick-off with loud failure logging).
 *
 * Nothing here calls Pinch or reads a clock. Repositories, clocks,
 * secrets, codes, payments and mobiles are injected fakes over synthetic
 * identifiers; execution dispatch is proven with counting executors and
 * the protected execution paths themselves are exercised only through
 * their own dedicated suites.
 *
 * Rows m1..m40 map one-to-one onto the approved scenario list for this
 * stage. Notable determinations:
 * - m2 (permanent current-cycle only): under the approved rules a state
 *   with the current cycle available but the next cycle unavailable is
 *   not structurally reachable (a valid next-cycle anchor always exists
 *   when the current cycle has one), so m2 asserts the current-cycle
 *   option's independent presence in the standard state; the projection
 *   renders exactly what the engine returns in any case.
 */

import { createInMemoryInterventionRepository } from "./dev-intervention-store";
import {
  createInMemoryFixturePaymentRepository,
  createInMemoryMovementChoiceRepository,
} from "./dev-movement-store";
import { createInMemoryOtpChallengeRepository } from "./dev-otp-store";
import { createInMemoryDevSmsStore } from "./dev-sms-store";
import {
  createInMemoryTemporaryConfirmationRepository,
  createInMemoryTemporaryOperationRepository,
  createInMemoryTemporarySelectionRepository,
  createInMemoryTemporaryVerificationRepository,
} from "./dev-temporary-operation-store";
import { createInMemoryTransactionVerificationRepository } from "./dev-transaction-verification-store";
import {
  toCustomerInterventionProjection,
  type DueLogicInterventionRecord,
} from "./intervention";
import {
  deriveMovementAvailability,
  type MovementAvailabilityDeps,
} from "./movement-availability";
import {
  buildCustomerMovementProjection,
  chooseMovementKind,
  dispatchFinalConfirmation,
  resolveMovementKindForExecution,
  type ChooseMovementDeps,
  type MovementProjectionDeps,
} from "./movement-journey";
import { evaluateOtpChallenge } from "./otp-challenge";
import {
  requestInterventionOtp,
  verifyInterventionOtp,
  type InterventionOtpDeps,
} from "./otp-service";
import {
  evaluateScheduleChange,
  PolicyValidationError,
} from "./policy/engine";
import { createInMemoryMerchantPolicyRepository } from "./policy/dev-policy-store";
import { DEFAULT_DUELOGIC_POLICY } from "./policy/rules";
import type { MerchantPlanScheduleConfiguration } from "./schema";
import {
  evaluateAndBindTemporarySelection,
  requestTemporaryOtp,
  verifyTemporaryOtp,
  type TemporaryJourneyDeps,
} from "./temporary-execution-service";
import type { TemporaryPaymentOperationRecord } from "./temporary-operation";
import type { AuthoritativePaymentSnapshot } from "@/lib/pinch/payment-movement";

export interface MovementValidationRow {
  scenario: string;
  outcome: string;
}

export interface MovementValidationResult {
  scenarioCount: number;
  decisionTable: MovementValidationRow[];
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Movement validation failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures — synthetic identifiers only

const RAW_TOKEN = "raw-move-demo-01";
const TEST_SECRET = "movement-validation-test-secret";
const FAKE_MOBILE = "0491570156"; // ACMA-reserved fictional AU mobile.

function fakeHash(raw: string): string {
  return `fakehash:${raw.split("").reverse().join("")}`;
}

/** Weekly, fortnightly and monthly mapped plans plus a probe payer. */
const PLAN_CONFIG: MerchantPlanScheduleConfiguration = {
  merchantId: "mch_demo",
  plans: {
    pln_demo_fortnightly: {
      cadence: "fortnightly",
      cycleDefinition: "fixed-days",
      cycleLengthDays: 14,
      cycleAnchorDate: "2026-07-28",
    },
    pln_demo_weekly: {
      cadence: "weekly",
      cycleDefinition: "fixed-days",
      cycleLengthDays: 7,
      cycleAnchorDate: "2026-07-28",
    },
    pln_demo_monthly: {
      cadence: "monthly",
      cycleDefinition: "calendar-month",
    },
    pln_demo_edge: {
      cadence: "fortnightly",
      cycleDefinition: "fixed-days",
      cycleLengthDays: 14,
      cycleAnchorDate: "2026-07-19",
    },
  },
};

/** Clock fixed so the Sydney evaluation date is 2026-08-01. */
const CLOCK_START = "2026-08-01T00:00:00.000Z";

interface RecordShape {
  planId?: string;
  currentStartDate?: string;
  cycleStart?: string;
  cycleEnd?: string;
  amountInCents?: number;
  cadence?: "weekly" | "fortnightly" | "monthly";
  suggestedDate?: string;
}

function movementRecord(shape: RecordShape = {}): DueLogicInterventionRecord {
  const start = shape.currentStartDate ?? "2026-08-05";
  return {
    interventionId: "int_move_demo_01",
    notificationId: "ntf_move_demo_01",
    tokenHash: fakeHash(RAW_TOKEN),
    merchantId: "mch_demo",
    payerId: "pyr_demo",
    sourceId: "src_demo",
    subscriptionId: "sub_demo_active",
    planId: shape.planId ?? "pln_demo_fortnightly",
    patternFlagId: "flag_move_demo",
    policyVersion: DEFAULT_DUELOGIC_POLICY.version,
    scheduleCadence: shape.cadence ?? "fortnightly",
    changeMode: "permanent",
    currentStartDate: start,
    currentPaymentAmountInCents: shape.amountInCents ?? 12500,
    currentCycleStartDate: shape.cycleStart ?? "2026-07-28",
    currentCycleEndDate: shape.cycleEnd ?? "2026-08-10",
    suggestedDate: shape.suggestedDate ?? "2026-08-07",
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

function verifiedTemporaryOperation(
  operationId: string,
  verifiedAtIso: string,
): TemporaryPaymentOperationRecord {
  return {
    operationId,
    interventionId: `int_hist_${operationId}`,
    confirmationId: `tconf_hist_${operationId}`,
    merchantId: "mch_demo",
    payerId: "pyr_demo",
    paymentId: "pmt_demo_hist",
    originalTransactionDate: "2026-06-10",
    proposedTransactionDate: "2026-06-12",
    amountInCents: 12500,
    policyVersion: DEFAULT_DUELOGIC_POLICY.version,
    createdAt: verifiedAtIso,
    updatedAt: verifiedAtIso,
    preflightState: "verified",
    mutationState: "invoked",
    readBackState: "verified",
    status: "temporary-change-verified",
    failureStage: null,
    verifiedAt: verifiedAtIso,
    verifiedTransactionDate: "2026-06-12",
  };
}

function executedPermanentIntervention(): DueLogicInterventionRecord {
  return {
    ...movementRecord(),
    interventionId: "int_move_executed_perm",
    tokenHash: fakeHash("raw-move-executed-perm"),
    selectedDate: "2026-08-07",
    policyOutcome: "approved",
    policyReasonCode: "POLICY_APPROVED",
    policyRuleFired: "all-policy-rules-passed",
    currentPayments: [
      { paymentDate: "2026-08-05", amountInCents: 12500 },
      { paymentDate: "2026-08-19", amountInCents: 12500 },
      { paymentDate: "2026-09-02", amountInCents: 12500 },
    ],
    proposedPayments: [
      { paymentDate: "2026-08-07", amountInCents: 12500 },
      { paymentDate: "2026-08-21", amountInCents: 12500 },
      { paymentDate: "2026-09-04", amountInCents: 12500 },
    ],
    confirmationId: "conf_demo_perm",
    operationId: "op_demo_perm",
    newSubscriptionId: "sub_demo_replacement",
    status: "executed",
    updatedAt: "2026-07-20T02:00:00.000Z",
  };
}

interface MovementHarness {
  deps: MovementAvailabilityDeps;
  interventions: ReturnType<typeof createInMemoryInterventionRepository>;
  temporaryOperations: ReturnType<
    typeof createInMemoryTemporaryOperationRepository
  >;
  payments: ReturnType<typeof createInMemoryFixturePaymentRepository>;
  now(): string;
}

async function makeMovementHarness(options?: {
  record?: DueLogicInterventionRecord;
  payment?: AuthoritativePaymentSnapshot | null;
  arrearsCents?: number;
  temporaryOps?: TemporaryPaymentOperationRecord[];
  extraInterventions?: DueLogicInterventionRecord[];
  planConfig?: MerchantPlanScheduleConfiguration;
}): Promise<{ harness: MovementHarness; record: DueLogicInterventionRecord }> {
  const interventions = createInMemoryInterventionRepository();
  const temporaryOperations = createInMemoryTemporaryOperationRepository();
  const payments = createInMemoryFixturePaymentRepository();
  const policies = createInMemoryMerchantPolicyRepository();

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
  const record = options?.record ?? movementRecord();
  await interventions.write(record);
  for (const extra of options?.extraInterventions ?? []) {
    await interventions.write(extra);
  }
  for (const operation of options?.temporaryOps ?? []) {
    await temporaryOperations.write(operation);
  }
  if (options?.payment !== null) {
    const payment: AuthoritativePaymentSnapshot = options?.payment ?? {
      id: "pmt_move_demo_01",
      payerId: "pyr_demo",
      amountInCents: record.currentPaymentAmountInCents,
      transactionDate: record.currentStartDate,
      status: "scheduled",
    };
    await payments.upsert(payment.payerId, payment);
  }

  return {
    record,
    harness: {
      interventions,
      temporaryOperations,
      payments,
      now,
      deps: {
        policies,
        interventions,
        temporaryOperations,
        readUpcomingScheduledPayment: (merchantId, payerId) =>
          payments.readUpcomingForPayer(payerId),
        planScheduleConfiguration: options?.planConfig ?? PLAN_CONFIG,
        merchantTimezone: "Australia/Sydney",
        currentArrearsCents: () => options?.arrearsCents ?? 0,
        now,
      },
    },
  };
}

function optionKinds(
  result: Awaited<ReturnType<typeof deriveMovementAvailability>>,
): string[] {
  return result.outcome === "resolved"
    ? result.availability.options.map((option) => option.kind)
    : [];
}

/** Full temporary-journey deps over a movement harness. */
function temporaryDepsOver(
  harness: MovementHarness,
  options?: { codeNumbers?: number[] },
): TemporaryJourneyDeps & {
  selections: ReturnType<typeof createInMemoryTemporarySelectionRepository>;
  challenges: ReturnType<typeof createInMemoryOtpChallengeRepository>;
  sms: ReturnType<typeof createInMemoryDevSmsStore>;
  temporaryVerifications: ReturnType<
    typeof createInMemoryTemporaryVerificationRepository
  >;
} {
  const selections = createInMemoryTemporarySelectionRepository();
  const temporaryVerifications =
    createInMemoryTemporaryVerificationRepository();
  const temporaryConfirmations =
    createInMemoryTemporaryConfirmationRepository();
  const challenges = createInMemoryOtpChallengeRepository();
  const sms = createInMemoryDevSmsStore();
  const codeNumbers = [...(options?.codeNumbers ?? [111222, 333444, 555666])];
  let idCounter = 0;
  const nextId = (prefix: string): string => {
    idCounter += 1;
    return `${prefix}_move_${String(idCounter).padStart(2, "0")}`;
  };
  return {
    interventions: harness.interventions,
    selections,
    temporaryVerifications,
    temporaryConfirmations,
    temporaryOperations: harness.temporaryOperations,
    policies: harness.deps.policies,
    challenges,
    sms,
    readUpcomingScheduledPayment: harness.deps.readUpcomingScheduledPayment,
    readPayment: (merchantId, paymentId) =>
      harness.payments.readById(paymentId),
    updatePaymentDate: (merchantId, body) =>
      harness.payments.applyDateUpdate(body),
    readPayerMobile: async () => FAKE_MOBILE,
    currentArrearsCents: harness.deps.currentArrearsCents,
    merchantTimezone: "Australia/Sydney",
    now: harness.now,
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
        throw new Error("Movement validation exhausted its code list.");
      }
      return next;
    },
  };
}

async function latestSmsCode(
  sms: ReturnType<typeof createInMemoryDevSmsStore>,
): Promise<string> {
  const messages = await sms.list();
  const body = messages[messages.length - 1]?.body ?? "";
  const match = /\b(\d{6})\b/.exec(body);
  check(match !== null, "fixture: the latest SMS must contain a six-digit code");
  return (match as RegExpExecArray)[1];
}

// ---------------------------------------------------------------------------
// Scenario table

export async function validateMovementJourney(): Promise<MovementValidationResult> {
  const table: MovementValidationRow[] = [];
  const record = (scenario: string, outcome: string): void => {
    table.push({ scenario, outcome });
  };

  // m1 + m11: unmapped plan with a live payment → temporary only; the
  // permanent options escalate to merchant review by absence.
  {
    const { harness, record: fixture } = await makeMovementHarness({
      record: movementRecord({ planId: "pln_unmapped" }),
    });
    const derived = await deriveMovementAvailability(fixture, harness.deps);
    check(
      JSON.stringify(optionKinds(derived)) === JSON.stringify(["temporary"]),
      "m1: an unmapped plan with a scheduled payment must offer temporary only",
    );
    record("m1-temporary-only", "temporary-only");
    record("m11-unmapped-plan-hides-permanent", "merchant-review-by-absence");
  }

  // m2 + m4: the standard mapped state offers both permanent modes; the
  // current-cycle option is present independently (see header note on the
  // structural unreachability of current-only under approved rules).
  {
    const { harness, record: fixture } = await makeMovementHarness({
      payment: null,
    });
    const derived = await deriveMovementAvailability(fixture, harness.deps);
    const kinds = optionKinds(derived);
    check(
      kinds.includes("permanent-current-cycle") &&
        kinds.includes("permanent-next-cycle") &&
        !kinds.includes("temporary"),
      "m2/m4: the mapped no-payment state must offer exactly the two permanent modes",
    );
    record("m2-permanent-current-available", "available");
    record("m4-both-permanent-modes", "both");
  }

  // m3: current cycle ends on the evaluation date → next-cycle only.
  {
    const { harness, record: fixture } = await makeMovementHarness({
      record: movementRecord({
        planId: "pln_demo_edge",
        currentStartDate: "2026-08-01",
        cycleStart: "2026-07-19",
        cycleEnd: "2026-08-01",
        suggestedDate: "2026-08-01",
      }),
      payment: null,
    });
    const derived = await deriveMovementAvailability(fixture, harness.deps);
    check(
      JSON.stringify(optionKinds(derived)) ===
        JSON.stringify(["permanent-next-cycle"]),
      "m3: an exhausted current cycle must leave the next-cycle option only",
    );
    record("m3-permanent-next-only", "next-only");
  }

  // m5: mapped plan plus a scheduled payment → all three movement types.
  {
    const { harness, record: fixture } = await makeMovementHarness();
    const derived = await deriveMovementAvailability(fixture, harness.deps);
    const kinds = optionKinds(derived);
    check(
      kinds.length === 3 &&
        kinds.includes("temporary") &&
        kinds.includes("permanent-current-cycle") &&
        kinds.includes("permanent-next-cycle"),
      "m5: the full state must offer all three movement types",
    );
    record("m5-all-three-types", "all");
  }

  // m6 + m37: nothing available → review required; choosing escalates to
  // the existing merchant state with no confirmation control.
  {
    const { harness, record: fixture } = await makeMovementHarness({
      record: movementRecord({ planId: "pln_unmapped" }),
      payment: null,
    });
    const derived = await deriveMovementAvailability(fixture, harness.deps);
    check(
      derived.outcome === "resolved" &&
        derived.availability.reviewRequired &&
        derived.availability.options.length === 0,
      "m6: nothing available must project merchant review",
    );
    const chooseDeps: ChooseMovementDeps = {
      interventions: harness.interventions,
      choices: createInMemoryMovementChoiceRepository(),
      selections: createInMemoryTemporarySelectionRepository(),
      temporaryVerifications: createInMemoryTemporaryVerificationRepository(),
      permanentVerificationExists: async () => false,
      availability: harness.deps,
      now: harness.now,
      hashToken: fakeHash,
    };
    const chosen = await chooseMovementKind(
      { token: RAW_TOKEN, kind: "temporary" },
      chooseDeps,
    );
    check(
      !chosen.ok &&
        chosen.reason === "merchant-review-required" &&
        chosen.record !== undefined &&
        chosen.record.status === "escalated",
      "m37: choosing with nothing available must escalate to merchant review",
    );
    const projection = toCustomerInterventionProjection(
      chosen.record as DueLogicInterventionRecord,
      harness.now(),
    );
    check(
      projection.finalConfirmationEnabled === false,
      "m37: the merchant-review state must expose no confirmation control",
    );
    record("m6-neither-available", "review-required");
    record("m37-merchant-review-no-confirmation", "no-control");
  }

  // m7: the temporary rolling limit hides the temporary option only.
  {
    const { harness, record: fixture } = await makeMovementHarness({
      temporaryOps: [
        verifiedTemporaryOperation("top_hist_a", "2026-06-01T02:00:00.000Z"),
        verifiedTemporaryOperation("top_hist_b", "2026-07-01T02:00:00.000Z"),
      ],
    });
    const derived = await deriveMovementAvailability(fixture, harness.deps);
    const kinds = optionKinds(derived);
    check(
      !kinds.includes("temporary") &&
        kinds.includes("permanent-current-cycle") &&
        kinds.includes("permanent-next-cycle"),
      "m7: the temporary usage limit must hide the temporary option only",
    );
    record("m7-temporary-limit-hides-temporary", "hidden");
  }

  // m8: the permanent rolling limit hides both permanent options only.
  {
    const { harness, record: fixture } = await makeMovementHarness({
      extraInterventions: [executedPermanentIntervention()],
    });
    const derived = await deriveMovementAvailability(fixture, harness.deps);
    const kinds = optionKinds(derived);
    check(
      kinds.includes("temporary") &&
        !kinds.includes("permanent-current-cycle") &&
        !kinds.includes("permanent-next-cycle"),
      "m8: the permanent usage limit must hide both permanent options only",
    );
    record("m8-permanent-limit-hides-permanent", "hidden");
  }

  // m9: explicit positive arrears escalate everything.
  {
    const { harness, record: fixture } = await makeMovementHarness({
      arrearsCents: 500,
    });
    const derived = await deriveMovementAvailability(fixture, harness.deps);
    check(
      derived.outcome === "resolved" && derived.availability.reviewRequired,
      "m9: explicit positive arrears must require merchant review",
    );
    record("m9-arrears-escalates", "review-required");
  }

  // m10: the bound policy's amount ceiling applies to every movement.
  {
    const { harness, record: fixture } = await makeMovementHarness({
      record: movementRecord({ amountInCents: 60000 }),
      payment: {
        id: "pmt_move_demo_01",
        payerId: "pyr_demo",
        amountInCents: 60000,
        transactionDate: "2026-08-05",
        status: "scheduled",
      },
    });
    const derived = await deriveMovementAvailability(fixture, harness.deps);
    check(
      derived.outcome === "resolved" && derived.availability.reviewRequired,
      "m10: an amount above the bound ceiling must require merchant review",
    );
    record("m10-amount-ceiling-applied", "review-required");
  }

  // m12: a malformed plan configuration is a configuration error.
  {
    const malformed: MerchantPlanScheduleConfiguration = {
      merchantId: "mch_demo",
      plans: {
        pln_demo_fortnightly: {
          cadence: "fortnightly",
          cycleDefinition: "fixed-days",
          cycleLengthDays: 14,
          // Missing cycleAnchorDate: malformed for a fixed-days mapping.
        } as MerchantPlanScheduleConfiguration["plans"][string],
      },
    };
    const { harness, record: fixture } = await makeMovementHarness({
      payment: null,
      planConfig: malformed,
    });
    const derived = await deriveMovementAvailability(fixture, harness.deps);
    check(
      derived.outcome === "configuration-error",
      "m12: a malformed plan configuration must be a configuration error",
    );
    record("m12-malformed-plan-configuration", "configuration-error");
  }

  // m13-m15: temporary window is later-only and capped; out-of-range
  // returns the maximum alternative; acceptance must be explicit.
  {
    const { harness, record: fixture } = await makeMovementHarness();
    const derived = await deriveMovementAvailability(fixture, harness.deps);
    check(derived.outcome === "resolved", "m13 fixture: availability resolves");
    const temporary =
      derived.outcome === "resolved"
        ? derived.availability.options.find((o) => o.kind === "temporary")
        : undefined;
    check(
      temporary !== undefined &&
        temporary.windowStartDate === "2026-08-06" &&
        temporary.windowEndDate === "2026-08-10",
      "m13: the temporary window must be one to five days after the payment",
    );
    record("m13-temporary-window-later-only", "1-to-5-days");

    const temporaryDeps = temporaryDepsOver(harness);
    const outside = await evaluateAndBindTemporarySelection(
      { token: RAW_TOKEN, requestedDate: "2026-08-12" },
      temporaryDeps,
    );
    check(
      !outside.ok &&
        outside.reason === "alternative-offered" &&
        outside.alternativeDate === "2026-08-10",
      "m14: an out-of-range date must return the maximum permitted alternative",
    );
    check(
      (await temporaryDeps.selections.readActive(fixture.interventionId)) ===
        null,
      "m15: the alternative must not bind until explicitly accepted",
    );
    const accepted = await evaluateAndBindTemporarySelection(
      {
        token: RAW_TOKEN,
        requestedDate: "2026-08-10",
        acceptOfferedAlternative: true,
      },
      temporaryDeps,
    );
    check(accepted.ok, "m15: accepting the alternative must bind");
    const bound = await temporaryDeps.selections.readActive(
      fixture.interventionId,
    );
    check(
      bound !== null &&
        bound.proposedTransactionDate === "2026-08-10" &&
        bound.acceptedAlternativeDate === "2026-08-10",
      "m15: the accepted alternative must be recorded on the binding",
    );
    record("m14-out-of-range-returns-alternative", "alternative-offered");
    record("m15-alternative-explicit-acceptance", "explicit");
  }

  // m16-m19: weekly and fortnightly current- and next-cycle windows come
  // from the trusted cycle boundaries.
  {
    const weekly = await makeMovementHarness({
      record: movementRecord({
        planId: "pln_demo_weekly",
        cadence: "weekly",
        currentStartDate: "2026-08-05",
        cycleStart: "2026-08-04",
        cycleEnd: "2026-08-10",
        suggestedDate: "2026-08-06",
      }),
      payment: null,
    });
    const weeklyDerived = await deriveMovementAvailability(
      weekly.record,
      weekly.harness.deps,
    );
    const weeklyCurrent =
      weeklyDerived.outcome === "resolved"
        ? weeklyDerived.availability.options.find(
            (o) => o.kind === "permanent-current-cycle",
          )
        : undefined;
    const weeklyNext =
      weeklyDerived.outcome === "resolved"
        ? weeklyDerived.availability.options.find(
            (o) => o.kind === "permanent-next-cycle",
          )
        : undefined;
    check(
      weeklyCurrent !== undefined &&
        weeklyCurrent.windowStartDate === "2026-08-04" &&
        weeklyCurrent.windowEndDate === "2026-08-10",
      "m16: the weekly current-cycle window must be the assigned 7-day cycle",
    );
    check(
      weeklyNext !== undefined &&
        weeklyNext.windowStartDate === "2026-08-11" &&
        weeklyNext.windowEndDate === "2026-08-17",
      "m17: the weekly next-cycle window must be the following 7-day cycle",
    );
    record("m16-weekly-current-window", "cycle-exact");
    record("m17-weekly-next-window", "cycle-exact");

    const { harness, record: fixture } = await makeMovementHarness({
      payment: null,
    });
    const fortnightly = await deriveMovementAvailability(
      fixture,
      harness.deps,
    );
    const fortnightlyCurrent =
      fortnightly.outcome === "resolved"
        ? fortnightly.availability.options.find(
            (o) => o.kind === "permanent-current-cycle",
          )
        : undefined;
    const fortnightlyNext =
      fortnightly.outcome === "resolved"
        ? fortnightly.availability.options.find(
            (o) => o.kind === "permanent-next-cycle",
          )
        : undefined;
    check(
      fortnightlyCurrent !== undefined &&
        fortnightlyCurrent.windowStartDate === "2026-08-02" &&
        fortnightlyCurrent.windowEndDate === "2026-08-10",
      "m18: the fortnightly current window must be in-cycle and strictly after evaluation",
    );
    check(
      fortnightlyNext !== undefined &&
        fortnightlyNext.windowStartDate === "2026-08-11" &&
        fortnightlyNext.windowEndDate === "2026-08-24",
      "m19: the fortnightly next window must be the following 14-day cycle",
    );
    record("m18-fortnightly-current-window", "cycle-exact");
    record("m19-fortnightly-next-window", "cycle-exact");
  }

  // m20: monthly anchors stay within days 1-28 — the engine refuses day
  // 29 outright, and the monthly windows are the calendar months.
  {
    const { harness, record: fixture } = await makeMovementHarness({
      record: movementRecord({
        planId: "pln_demo_monthly",
        cadence: "monthly",
        currentStartDate: "2026-08-15",
        cycleStart: "2026-08-01",
        cycleEnd: "2026-08-31",
        suggestedDate: "2026-08-18",
      }),
      payment: null,
    });
    const derived = await deriveMovementAvailability(fixture, harness.deps);
    const kinds = optionKinds(derived);
    check(
      kinds.includes("permanent-current-cycle") &&
        kinds.includes("permanent-next-cycle"),
      "m20: monthly permanent options must derive from the calendar months",
    );
    let day29Refused = false;
    try {
      evaluateScheduleChange(
        {
          changeType: "permanent",
          payerId: "pyr_demo",
          paymentId: "sub_demo_active-first-payment",
          amountCents: 12500,
          evaluationDate: "2026-08-01",
          currentArrearsCents: 0,
          scheduleCadence: "monthly",
          effectiveCycle: "next-cycle-and-future",
          previousPaymentDate: "2026-07-15",
          currentPaymentDate: "2026-08-15",
          nextPaymentDate: "2026-09-15",
          currentCycleStartDate: "2026-08-01",
          currentCycleEndDate: "2026-08-31",
          nextCycleStartDate: "2026-09-01",
          nextCycleEndDate: "2026-09-30",
          requestedAnchorDate: "2026-09-29",
        },
        [],
        DEFAULT_DUELOGIC_POLICY,
      );
    } catch (error) {
      day29Refused = error instanceof PolicyValidationError;
    }
    check(day29Refused, "m20: a day-29 monthly anchor must be refused");
    record("m20-monthly-anchors-1-28", "engine-refuses-29");
  }

  // m21 + m22 + m25: the movement choice is stored server-side, cannot
  // name an unavailable kind, and is immutable after verification.
  {
    const { harness } = await makeMovementHarness({ payment: null });
    const choices = createInMemoryMovementChoiceRepository();
    const chooseDeps: ChooseMovementDeps = {
      interventions: harness.interventions,
      choices,
      selections: createInMemoryTemporarySelectionRepository(),
      temporaryVerifications: createInMemoryTemporaryVerificationRepository(),
      permanentVerificationExists: async () => false,
      availability: harness.deps,
      now: harness.now,
      hashToken: fakeHash,
    };
    const unavailable = await chooseMovementKind(
      { token: RAW_TOKEN, kind: "temporary" },
      chooseDeps,
    );
    check(
      !unavailable.ok && unavailable.reason === "movement-unavailable",
      "m22: an unavailable kind named by the browser must be refused",
    );
    const chosen = await chooseMovementKind(
      { token: RAW_TOKEN, kind: "permanent-next-cycle" },
      chooseDeps,
    );
    check(chosen.ok, "m21: choosing an available kind must bind");
    const stored = await choices.readChoice("int_move_demo_01");
    check(
      stored !== null && stored.kind === "permanent-next-cycle",
      "m21: the movement selection must be stored server-side",
    );
    record("m21-selection-stored-server-side", "stored");
    record("m22-browser-cannot-force-kind", "refused");

    const lockedDeps: ChooseMovementDeps = {
      ...chooseDeps,
      permanentVerificationExists: async () => true,
    };
    const locked = await chooseMovementKind(
      { token: RAW_TOKEN, kind: "permanent-current-cycle" },
      lockedDeps,
    );
    check(
      !locked.ok && locked.reason === "verification-active",
      "m25: changing the option after verification must be refused",
    );
    record("m25-option-change-after-verification-refused", "immutable");
  }

  // m23 + m24: option or date changes invalidate the prior preview — a
  // stale challenge no longer verifies after the binding moved on.
  {
    const { harness } = await makeMovementHarness();
    const temporaryDeps = temporaryDepsOver(harness);
    check(
      (
        await evaluateAndBindTemporarySelection(
          { token: RAW_TOKEN, requestedDate: "2026-08-07" },
          temporaryDeps,
        )
      ).ok,
      "m23 fixture: the first binding must approve",
    );
    check(
      (await requestTemporaryOtp({ token: RAW_TOKEN }, temporaryDeps)).ok,
      "m23 fixture: the OTP must issue for the first binding",
    );
    const staleCode = await latestSmsCode(temporaryDeps.sms);
    check(
      (
        await evaluateAndBindTemporarySelection(
          { token: RAW_TOKEN, requestedDate: "2026-08-08" },
          temporaryDeps,
        )
      ).ok,
      "m24 fixture: the date change must re-bind",
    );
    const stale = await verifyTemporaryOtp(
      { token: RAW_TOKEN, code: staleCode },
      temporaryDeps,
    );
    check(
      !stale.ok && stale.reason === "otp-mismatch",
      "m23/m24: the prior preview's challenge must be invalid after the change",
    );
    record("m23-option-change-invalidates-preview", "invalidated");
    record("m24-date-change-invalidates-preview", "invalidated");
  }

  // m26-m30: OTP dispatch by kind, temporary verification creation,
  // unchanged permanent behaviour and no cross-kind reuse.
  {
    const { harness } = await makeMovementHarness();
    const temporaryDeps = temporaryDepsOver(harness, {
      codeNumbers: [212121, 434343],
    });
    check(
      (
        await evaluateAndBindTemporarySelection(
          { token: RAW_TOKEN, requestedDate: "2026-08-07" },
          temporaryDeps,
        )
      ).ok,
      "m26 fixture: the temporary binding must approve",
    );
    check(
      (await requestTemporaryOtp({ token: RAW_TOKEN }, temporaryDeps)).ok,
      "m26: the temporary dispatcher must issue the temporary challenge",
    );
    const temporaryChallenge = await temporaryDeps.challenges.readCurrent(
      "int_move_demo_01",
    );
    check(
      temporaryChallenge !== null && temporaryChallenge.kind === "temporary",
      "m26: the issued challenge must be the temporary kind",
    );
    record("m26-temporary-otp-dispatch", "temporary-challenge");

    const code = await latestSmsCode(temporaryDeps.sms);
    const verified = await verifyTemporaryOtp(
      { token: RAW_TOKEN, code },
      temporaryDeps,
    );
    check(
      verified.ok && verified.verification.kind === "temporary",
      "m28: the temporary OTP must create the temporary verification",
    );
    record("m28-temporary-otp-creates-verification", "created");

    // m30: no cross-kind reuse — the temporary challenge can never satisfy
    // a permanent expectation, and vice versa.
    check(
      temporaryChallenge !== null &&
        evaluateOtpChallenge(
          temporaryChallenge,
          {
            kind: "permanent",
            interventionId: "int_move_demo_01",
            merchantId: "mch_demo",
            payerId: "pyr_demo",
            subscriptionId: "sub_demo_active",
            selectedDate: "2026-08-07",
            currentPayments: [
              { paymentDate: "2026-08-05", amountInCents: 12500 },
            ],
            proposedPayments: [
              { paymentDate: "2026-08-07", amountInCents: 12500 },
            ],
            policyVersion: DEFAULT_DUELOGIC_POLICY.version,
            trustedMobileFingerprint:
              temporaryChallenge.trustedMobileFingerprint,
          },
          harness.now(),
        ).ok === false,
      "m30: a temporary challenge must never satisfy a permanent expectation",
    );
    record("m30-no-cross-kind-reuse", "kind-bound");

    // m27 + m29: the permanent OTP path behaves exactly as before over a
    // preview-ready permanent record.
    const permanentHarness = await makeMovementHarness({
      record: {
        ...executedPermanentIntervention(),
        interventionId: "int_move_perm_ready",
        tokenHash: fakeHash("raw-move-perm-ready"),
        status: "preview-ready",
        confirmationId: null,
        operationId: null,
        newSubscriptionId: null,
      },
      payment: null,
    });
    const permanentVerifications =
      createInMemoryTransactionVerificationRepository();
    const permanentChallenges = createInMemoryOtpChallengeRepository();
    const permanentSms = createInMemoryDevSmsStore();
    let permanentCounter = 0;
    const permanentOtpDeps: InterventionOtpDeps = {
      interventions: permanentHarness.harness.interventions,
      verifications: permanentVerifications,
      policies: permanentHarness.harness.deps.policies,
      challenges: permanentChallenges,
      sms: permanentSms,
      readPayerMobile: async () => FAKE_MOBILE,
      now: permanentHarness.harness.now,
      hashToken: fakeHash,
      otpHmacSecret: () => TEST_SECRET,
      generateChallengeId: () => {
        permanentCounter += 1;
        return `otpch_perm_${permanentCounter}`;
      },
      generateSmsId: () => {
        permanentCounter += 1;
        return `sms_perm_${permanentCounter}`;
      },
      generateVerificationId: () => {
        permanentCounter += 1;
        return `ver_perm_${permanentCounter}`;
      },
      generateOtpCodeNumber: () => 787878,
    };
    check(
      (
        await requestInterventionOtp(
          { token: "raw-move-perm-ready" },
          permanentOtpDeps,
        )
      ).ok,
      "m27: the permanent dispatcher must issue the permanent challenge",
    );
    const permanentChallenge = await permanentChallenges.readCurrent(
      "int_move_perm_ready",
    );
    check(
      permanentChallenge !== null &&
        (permanentChallenge.kind ?? "permanent") === "permanent",
      "m27: the issued challenge must be the permanent kind",
    );
    const permanentVerified = await verifyInterventionOtp(
      { token: "raw-move-perm-ready", code: "787878" },
      permanentOtpDeps,
    );
    check(
      permanentVerified.ok &&
        (await permanentVerifications.readVerifiedForIntervention(
          "int_move_perm_ready",
        )) !== null,
      "m29: the permanent OTP behaviour must remain unchanged",
    );
    record("m27-permanent-otp-dispatch", "permanent-challenge");
    record("m29-permanent-otp-unchanged", "unchanged");
  }

  // m31-m34: the final-confirmation dispatcher runs exactly one executor
  // per resolved kind and never retries a failed or ambiguous result.
  {
    const choices = createInMemoryMovementChoiceRepository();
    await choices.setChoice({
      interventionId: "int_move_demo_01",
      kind: "temporary",
      chosenAt: CLOCK_START,
    });
    check(
      (await resolveMovementKindForExecution("int_move_demo_01", choices)) ===
        "temporary" &&
        (await resolveMovementKindForExecution("int_move_none", choices)) ===
          "permanent-current-cycle",
      "m31: the dispatcher must resolve the stored kind, defaulting to permanent",
    );

    const counters = { temporary: 0, permanent: 0 };
    const executors = {
      temporary: async () => {
        counters.temporary += 1;
        return "temporary-result";
      },
      permanent: async () => {
        counters.permanent += 1;
        return "permanent-result";
      },
    };
    check(
      (await dispatchFinalConfirmation("temporary", executors)) ===
        "temporary-result" &&
        (await dispatchFinalConfirmation("permanent-current-cycle", executors)) ===
          "permanent-result" &&
        (await dispatchFinalConfirmation("permanent-next-cycle", executors)) ===
          "permanent-result",
      "m31-m33: each kind must dispatch to its own executor",
    );
    check(
      counters.temporary === 1 && counters.permanent === 2,
      "m31-m33: exactly one executor must run per dispatch",
    );
    record("m31-temporary-dispatches-once", "once");
    record("m32-permanent-current-dispatches-once", "once");
    record("m33-permanent-next-dispatches-once", "once");

    const failingCounters = { temporary: 0, permanent: 0 };
    let failed = false;
    try {
      await dispatchFinalConfirmation("temporary", {
        temporary: async () => {
          failingCounters.temporary += 1;
          throw new Error("SimulatedAmbiguousResult");
        },
        permanent: async () => {
          failingCounters.permanent += 1;
          return "never";
        },
      });
    } catch {
      failed = true;
    }
    check(
      failed &&
        failingCounters.temporary === 1 &&
        failingCounters.permanent === 0,
      "m34: an ambiguous result must never trigger a retry or fallback",
    );
    record("m34-no-retry-after-ambiguous", "no-retry");
  }

  // m35 + m36: the executed projections carry the right movement facts —
  // temporary exposes the verified new date; permanent stays unchanged.
  {
    const temporaryExecuted: DueLogicInterventionRecord = {
      ...movementRecord(),
      interventionId: "int_move_exec_temp",
      tokenHash: fakeHash("raw-move-exec-temp"),
      status: "executed",
      confirmationId: "tconf_demo_done",
      operationId: "top_demo_done",
      executedMovementKind: "temporary",
      verifiedTemporaryTransactionDate: "2026-08-07",
    };
    const temporaryProjection = toCustomerInterventionProjection(
      temporaryExecuted,
      "2026-08-01T01:00:00.000Z",
    );
    check(
      temporaryProjection.status === "executed" &&
        temporaryProjection.executedMovementKind === "temporary" &&
        temporaryProjection.verifiedTemporaryTransactionDate === "2026-08-07" &&
        temporaryProjection.finalConfirmationEnabled === false,
      "m35: the executed temporary projection must carry the verified movement facts",
    );
    record("m35-temporary-executed-projection", "verified-date-shown");

    const permanentProjection = toCustomerInterventionProjection(
      executedPermanentIntervention(),
      "2026-08-01T01:00:00.000Z",
    );
    check(
      permanentProjection.status === "executed" &&
        permanentProjection.executedMovementKind === undefined &&
        permanentProjection.verifiedTemporaryTransactionDate === undefined &&
        permanentProjection.proposedPayments !== null,
      "m36: the executed permanent projection must be unchanged",
    );
    record("m36-permanent-executed-unchanged", "unchanged");
  }

  // m38: the manual-recovery state exposes no confirmation or retry
  // control (finalConfirmationEnabled false; the page renders the calm
  // neutral state for that status).
  {
    const manual: DueLogicInterventionRecord = {
      ...movementRecord(),
      interventionId: "int_move_manual",
      tokenHash: fakeHash("raw-move-manual"),
      status: "manual-recovery-required",
      confirmationId: "tconf_demo_mr",
      operationId: "top_demo_mr",
      executedMovementKind: "temporary",
    };
    const projection = toCustomerInterventionProjection(
      manual,
      "2026-08-01T01:00:00.000Z",
    );
    check(
      projection.status === "manual-recovery-required" &&
        projection.finalConfirmationEnabled === false,
      "m38: the manual-recovery state must expose no retry control",
    );
    record("m38-manual-recovery-no-retry", "no-control");
  }

  // m39: the channels stay separate — the SMS store structurally refuses
  // review-link content, so no review URL can ever enter the SMS channel.
  {
    const sms = createInMemoryDevSmsStore();
    let refused = false;
    try {
      await sms.send({
        smsId: "sms_move_bad",
        interventionId: "int_move_demo_01",
        maskedRecipient: "•••• ••• 156",
        body: "Open /review/some-token to continue",
        sentAt: CLOCK_START,
      });
    } catch {
      refused = true;
    }
    check(refused, "m39: the SMS store must refuse review-link content");
    record("m39-channels-remain-separate", "structurally-enforced");
  }

  // m40: no raw token and no internal Pinch identifiers appear in the
  // customer movement projection or the customer intervention projection.
  {
    const { harness, record: fixture } = await makeMovementHarness();
    const temporaryDeps = temporaryDepsOver(harness);
    check(
      (
        await evaluateAndBindTemporarySelection(
          { token: RAW_TOKEN, requestedDate: "2026-08-07" },
          temporaryDeps,
        )
      ).ok,
      "m40 fixture: the binding must approve",
    );
    const projectionDeps: MovementProjectionDeps = {
      choices: createInMemoryMovementChoiceRepository(),
      selections: temporaryDeps.selections,
      temporaryVerifications: temporaryDeps.temporaryVerifications,
      availability: harness.deps,
      now: harness.now,
    };
    await projectionDeps.choices.setChoice({
      interventionId: fixture.interventionId,
      kind: "temporary",
      chosenAt: CLOCK_START,
    });
    const movement = await buildCustomerMovementProjection(
      fixture,
      projectionDeps,
    );
    const serialised =
      JSON.stringify(movement) +
      JSON.stringify(toCustomerInterventionProjection(fixture, harness.now()));
    check(
      !serialised.includes(RAW_TOKEN) &&
        !serialised.includes("pmt_move_demo_01") &&
        !serialised.includes("sub_demo_active") &&
        !serialised.includes("pyr_demo") &&
        !serialised.includes("mch_demo") &&
        !serialised.includes("pln_demo") &&
        !serialised.includes("src_demo") &&
        !serialised.includes("tokenHash"),
      "m40: no raw token or internal identifier may appear in customer projections",
    );
    record("m40-no-token-or-identifier-leak", "clean");
  }

  return { scenarioCount: table.length, decisionTable: table };
}

// ---------------------------------------------------------------------------
// Module-load kick-off, mirroring the sibling validation modules.

void validateMovementJourney().catch((error: unknown) => {
  console.error("Movement validation failed at module load.", {
    errorClass: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  });
});
