/**
 * Deterministic decision-table validation of the DueLogic policy engine.
 *
 * Follows the repository's validation convention: the checks run once at
 * module load — cheap at this size — so any regression fails fast wherever
 * this module is imported, and the exported function re-asserts on demand.
 * No testing dependency required. All fixtures are isolated synthetic policy
 * fixtures — the payment-history seed is not used or modified — and the
 * exported decision table contains rule identifiers and outcomes only: no
 * customer names, contact details, Pinch IDs, payment-source IDs, inferred
 * financial circumstances or stack traces.
 */

import type { DueLogicPolicy, PriorScheduleChange, ScheduleCadence } from "../schema";
import { DEFAULT_DUELOGIC_POLICY } from "./rules";
import {
  evaluateScheduleChange,
  PolicyValidationError,
  type ApprovedPermanentPolicyDecision,
  type ApprovedTemporaryPolicyDecision,
  type EscalatePolicyDecision,
  type PermanentNextCycleAlternativeDecision,
  type PermanentPolicyEvaluationRequest,
  type PolicyDecision,
  type PolicyEvaluationRequest,
  type PolicyValidationCode,
  type TemporaryPolicyEvaluationRequest,
  type TemporaryShorterAlternativeDecision,
} from "./engine";

// ---------------------------------------------------------------------------
// Safe decision-table report types

export type PolicyDecisionTableRow =
  | {
      scenario: string;
      outcome: "approved" | "shorter-alternative" | "next-cycle-alternative" | "escalate";
      changeType: "temporary" | "permanent";
      reasonCode: string;
      ruleFired: string;
      confirmationRequired: boolean;
      warningCodes: string[];
      scheduleCadence?: string;
    }
  | {
      scenario: string;
      outcome: "validation-error";
      validationCode: PolicyValidationCode;
    };

export interface PolicyEngineValidationResult {
  scenarioCount: number;
  decisionTable: PolicyDecisionTableRow[];
}

// ---------------------------------------------------------------------------
// Fixtures — synthetic internal identifiers only

const PAYER_ID = "payer-fixture-01";
const OTHER_PAYER_ID = "payer-fixture-99";

function temporaryRequest(
  overrides: Partial<TemporaryPolicyEvaluationRequest> = {},
): TemporaryPolicyEvaluationRequest {
  return {
    changeType: "temporary",
    payerId: PAYER_ID,
    paymentId: "payment-fixture-01",
    amountCents: 40000,
    currentArrearsCents: 0,
    evaluationDate: "2026-01-05",
    currentPaymentDate: "2026-01-10",
    requestedDate: "2026-01-15",
    ...overrides,
  };
}

function monthlyRequest(
  overrides: Partial<PermanentPolicyEvaluationRequest> = {},
): PermanentPolicyEvaluationRequest {
  return {
    changeType: "permanent",
    payerId: PAYER_ID,
    paymentId: "payment-fixture-02",
    amountCents: 40000,
    currentArrearsCents: 0,
    evaluationDate: "2026-01-05",
    scheduleCadence: "monthly",
    effectiveCycle: "current-and-future",
    previousPaymentDate: "2025-12-31",
    currentPaymentDate: "2026-01-31",
    nextPaymentDate: "2026-02-28",
    currentCycleStartDate: "2026-01-01",
    currentCycleEndDate: "2026-01-31",
    nextCycleStartDate: "2026-02-01",
    nextCycleEndDate: "2026-02-28",
    requestedAnchorDate: "2026-01-12",
    ...overrides,
  };
}

function weeklyRequest(
  overrides: Partial<PermanentPolicyEvaluationRequest> = {},
): PermanentPolicyEvaluationRequest {
  return {
    changeType: "permanent",
    payerId: PAYER_ID,
    paymentId: "payment-fixture-03",
    amountCents: 40000,
    currentArrearsCents: 0,
    evaluationDate: "2026-01-05",
    scheduleCadence: "weekly",
    effectiveCycle: "current-and-future",
    previousPaymentDate: "2026-01-02",
    currentPaymentDate: "2026-01-09",
    nextPaymentDate: "2026-01-16",
    currentCycleStartDate: "2026-01-05",
    currentCycleEndDate: "2026-01-11",
    nextCycleStartDate: "2026-01-12",
    nextCycleEndDate: "2026-01-18",
    requestedAnchorDate: "2026-01-07",
    ...overrides,
  };
}

function fortnightlyRequest(
  overrides: Partial<PermanentPolicyEvaluationRequest> = {},
): PermanentPolicyEvaluationRequest {
  return {
    changeType: "permanent",
    payerId: PAYER_ID,
    paymentId: "payment-fixture-04",
    amountCents: 40000,
    currentArrearsCents: 0,
    evaluationDate: "2026-01-02",
    scheduleCadence: "fortnightly",
    effectiveCycle: "current-and-future",
    previousPaymentDate: "2025-12-30",
    currentPaymentDate: "2026-01-05",
    nextPaymentDate: "2026-01-19",
    currentCycleStartDate: "2026-01-01",
    currentCycleEndDate: "2026-01-14",
    nextCycleStartDate: "2026-01-15",
    nextCycleEndDate: "2026-01-28",
    requestedAnchorDate: "2026-01-08",
    ...overrides,
  };
}

/** Well-formed contiguous 28-day cycles: valid metadata, unsupported cadence. */
function fourWeeklyRequest(
  overrides: Partial<PermanentPolicyEvaluationRequest> = {},
): PermanentPolicyEvaluationRequest {
  return {
    changeType: "permanent",
    payerId: PAYER_ID,
    paymentId: "payment-fixture-05",
    amountCents: 40000,
    currentArrearsCents: 0,
    evaluationDate: "2026-01-05",
    scheduleCadence: "four-weekly",
    effectiveCycle: "current-and-future",
    previousPaymentDate: "2025-12-20",
    currentPaymentDate: "2026-01-15",
    nextPaymentDate: "2026-02-10",
    currentCycleStartDate: "2026-01-01",
    currentCycleEndDate: "2026-01-28",
    nextCycleStartDate: "2026-01-29",
    nextCycleEndDate: "2026-02-25",
    requestedAnchorDate: "2026-01-20",
    ...overrides,
  };
}

function verifiedChange(
  id: string,
  changeType: "temporary" | "permanent",
  executedDate: string,
  payerId: string = PAYER_ID,
): PriorScheduleChange {
  return { id, payerId, changeType, status: "executed-verified", executedDate };
}

function permanentPolicyWith(
  overrides: Partial<DueLogicPolicy["permanentChange"]>,
): DueLogicPolicy {
  return {
    ...DEFAULT_DUELOGIC_POLICY,
    permanentChange: { ...DEFAULT_DUELOGIC_POLICY.permanentChange, ...overrides },
  };
}

// ---------------------------------------------------------------------------
// Validation run

export function validatePolicyEngine(): PolicyEngineValidationResult {
  const table: PolicyDecisionTableRow[] = [];

  const check = (condition: boolean, message: string): void => {
    if (!condition) {
      throw new Error(`DueLogic policy-engine validation failed: ${message}`);
    }
  };

  const decide = (
    scenario: string,
    request: PolicyEvaluationRequest,
    history: readonly PriorScheduleChange[] = [],
    policy: DueLogicPolicy = DEFAULT_DUELOGIC_POLICY,
  ): PolicyDecision => {
    const decision = evaluateScheduleChange(request, history, policy);
    table.push({
      scenario,
      outcome: decision.outcome,
      changeType: decision.changeType,
      reasonCode: decision.reasonCode,
      ruleFired: decision.ruleFired,
      confirmationRequired: decision.confirmationRequired,
      warningCodes: decision.warnings.map((warning) => warning.code),
      ...("scheduleCadence" in decision
        ? { scheduleCadence: decision.scheduleCadence }
        : {}),
    });
    return decision;
  };

  const expectError = (
    scenario: string,
    expectedCode: PolicyValidationCode,
    run: () => void,
  ): void => {
    let observed: PolicyValidationCode | null = null;
    try {
      run();
    } catch (error) {
      if (!(error instanceof PolicyValidationError)) {
        throw error;
      }
      observed = error.code;
    }
    check(
      observed === expectedCode,
      `${scenario}: expected validation error ${expectedCode}, observed ${observed ?? "no error"}`,
    );
    table.push({ scenario, outcome: "validation-error", validationCode: expectedCode });
  };

  const asApprovedTemporary = (
    scenario: string,
    decision: PolicyDecision,
  ): ApprovedTemporaryPolicyDecision => {
    check(
      decision.outcome === "approved" && decision.changeType === "temporary",
      `${scenario}: expected an approved temporary decision, observed ${decision.outcome}/${decision.reasonCode}`,
    );
    return decision as ApprovedTemporaryPolicyDecision;
  };

  const asApprovedPermanent = (
    scenario: string,
    decision: PolicyDecision,
  ): ApprovedPermanentPolicyDecision => {
    check(
      decision.outcome === "approved" && decision.changeType === "permanent",
      `${scenario}: expected an approved permanent decision, observed ${decision.outcome}/${decision.reasonCode}`,
    );
    return decision as ApprovedPermanentPolicyDecision;
  };

  const asShorterAlternative = (
    scenario: string,
    decision: PolicyDecision,
  ): TemporaryShorterAlternativeDecision => {
    check(
      decision.outcome === "shorter-alternative",
      `${scenario}: expected shorter-alternative, observed ${decision.outcome}/${decision.reasonCode}`,
    );
    return decision as TemporaryShorterAlternativeDecision;
  };

  const asNextCycleAlternative = (
    scenario: string,
    decision: PolicyDecision,
  ): PermanentNextCycleAlternativeDecision => {
    check(
      decision.outcome === "next-cycle-alternative",
      `${scenario}: expected next-cycle-alternative, observed ${decision.outcome}/${decision.reasonCode}`,
    );
    return decision as PermanentNextCycleAlternativeDecision;
  };

  const asEscalation = (
    scenario: string,
    decision: PolicyDecision,
    reasonCode: EscalatePolicyDecision["reasonCode"],
    ruleFired: string,
  ): EscalatePolicyDecision => {
    check(
      decision.outcome === "escalate" &&
        decision.reasonCode === reasonCode &&
        decision.ruleFired === ruleFired,
      `${scenario}: expected escalation ${reasonCode} via ${ruleFired}, observed ${decision.outcome}/${decision.reasonCode}/${decision.ruleFired}`,
    );
    return decision as EscalatePolicyDecision;
  };

  const samePreview = (
    scenario: string,
    observed: readonly string[],
    expected: readonly [string, string, string],
  ): void => {
    check(
      observed.length === 3 &&
        observed[0] === expected[0] &&
        observed[1] === expected[1] &&
        observed[2] === expected[2],
      `${scenario}: expected preview ${expected.join(", ")}, observed ${observed.join(", ")}`,
    );
  };

  // -------------------------------------------------------------------------
  // A. Temporary changes

  {
    const decision = asApprovedTemporary(
      "01-temporary-within-limits",
      decide(
        "01-temporary-within-limits",
        temporaryRequest({ amountCents: 50000 }),
        [verifiedChange("prior-01", "temporary", "2025-08-10")],
      ),
    );
    check(
      decision.reasonCode === "POLICY_APPROVED" &&
        decision.shiftDays === 5 &&
        decision.approvedPaymentDate === "2026-01-15" &&
        decision.usage.verifiedUsesInPeriod === 1 &&
        decision.usage.permittedUses === 2 &&
        decision.confirmationRequired === false,
      "01: approved five-day shift with one verified use expected",
    );
  }

  {
    const decision = asShorterAlternative(
      "02-temporary-shift-six-days",
      decide("02-temporary-shift-six-days", temporaryRequest({ requestedDate: "2026-01-16" })),
    );
    check(
      decision.reasonCode === "TEMPORARY_SHIFT_EXCEEDS_MAXIMUM" &&
        decision.ruleFired === "temporaryChange.maxShiftDays" &&
        decision.requestedShiftDays === 6 &&
        decision.maximumShiftDays === 5 &&
        decision.alternativeDate === "2026-01-15",
      "02: alternative exactly five days after the current date expected",
    );
  }

  asEscalation(
    "03-temporary-limit-reached",
    decide(
      "03-temporary-limit-reached",
      temporaryRequest(),
      [
        verifiedChange("prior-02", "temporary", "2025-08-10"),
        verifiedChange("prior-03", "temporary", "2025-11-01"),
      ],
    ),
    "TEMPORARY_CHANGE_LIMIT_REACHED",
    "temporaryChange.maxVerifiedUses",
  );

  asApprovedTemporary(
    "04-amount-exactly-at-ceiling",
    decide("04-amount-exactly-at-ceiling", temporaryRequest({ amountCents: 50000 })),
  );

  {
    const decision = asEscalation(
      "05-amount-one-cent-above-ceiling",
      decide("05-amount-one-cent-above-ceiling", temporaryRequest({ amountCents: 50001 })),
      "AMOUNT_CEILING_EXCEEDED",
      "amountCeilingCents",
    );
    check(
      decision.explanation.includes("$500.00"),
      "05: default ceiling explanation must derive $500.00 from policy",
    );
  }

  {
    const decision = asEscalation(
      "06-custom-ceiling-explanation",
      decide(
        "06-custom-ceiling-explanation",
        temporaryRequest({ amountCents: 75001 }),
        [],
        { ...DEFAULT_DUELOGIC_POLICY, amountCeilingCents: 75000 },
      ),
      "AMOUNT_CEILING_EXCEEDED",
      "amountCeilingCents",
    );
    check(
      decision.explanation.includes("$750.00") && !decision.explanation.includes("$500.00"),
      "06: custom ceiling explanation must derive $750.00 from the active policy",
    );
  }

  asApprovedTemporary(
    "07-arrears-zero",
    decide("07-arrears-zero", temporaryRequest({ currentArrearsCents: 0 })),
  );

  {
    const decision = asEscalation(
      "08-arrears-one-cent",
      decide("08-arrears-one-cent", temporaryRequest({ currentArrearsCents: 1 })),
      "CURRENT_ARREARS_PRESENT",
      "arrears.disqualifyWhenCurrentArrearsCentsAbove",
    );
    check(
      decision.explanation ===
        "This request requires manual review because the account currently has an outstanding amount.",
      "08: arrears explanation must be the neutral manual-review sentence",
    );
  }

  {
    const decision = asApprovedTemporary(
      "09-temporary-crossing-month",
      decide(
        "09-temporary-crossing-month",
        temporaryRequest({ currentPaymentDate: "2026-01-30", requestedDate: "2026-02-03" }),
      ),
    );
    check(
      decision.shiftDays === 4 && decision.approvedPaymentDate === "2026-02-03",
      "09: a four-day shift across the month boundary must be approved",
    );
  }

  // -------------------------------------------------------------------------
  // B. Monthly permanent changes

  {
    const decision = asApprovedPermanent(
      "10-monthly-current-move-earlier",
      decide("10-monthly-current-move-earlier", monthlyRequest()),
    );
    check(
      decision.currentPaymentAction === "move-earlier" &&
        decision.resultingCurrentPaymentDate === "2026-01-12" &&
        decision.firstRevisedPaymentDate === "2026-01-12" &&
        decision.confirmationRequired === true &&
        decision.warnings.length === 0,
      "10: monthly move-earlier approval expected",
    );
    samePreview("10-monthly-current-move-earlier", decision.revisedSchedulePreview, [
      "2026-01-12",
      "2026-02-12",
      "2026-03-12",
    ]);
  }

  {
    const decision = asApprovedPermanent(
      "11-monthly-current-move-later",
      decide(
        "11-monthly-current-move-later",
        monthlyRequest({
          previousPaymentDate: "2025-12-28",
          currentPaymentDate: "2026-01-08",
          nextPaymentDate: "2026-02-08",
          requestedAnchorDate: "2026-01-25",
        }),
      ),
    );
    check(
      decision.currentPaymentAction === "move-later",
      "11: monthly move-later approval expected",
    );
    samePreview("11-monthly-current-move-later", decision.revisedSchedulePreview, [
      "2026-01-25",
      "2026-02-25",
      "2026-03-25",
    ]);
  }

  {
    const decision = asApprovedPermanent(
      "12-monthly-next-cycle",
      decide(
        "12-monthly-next-cycle",
        monthlyRequest({
          effectiveCycle: "next-cycle-and-future",
          requestedAnchorDate: "2026-02-12",
        }),
      ),
    );
    check(
      decision.currentPaymentAction === "keep" &&
        decision.resultingCurrentPaymentDate === "2026-01-31" &&
        decision.firstRevisedPaymentDate === "2026-02-12",
      "12: monthly next-cycle approval keeping the current payment expected",
    );
    samePreview("12-monthly-next-cycle", decision.revisedSchedulePreview, [
      "2026-02-12",
      "2026-03-12",
      "2026-04-12",
    ]);
  }

  {
    const decision = asApprovedPermanent(
      "13-monthly-close-payment-warning",
      decide(
        "13-monthly-close-payment-warning",
        monthlyRequest({
          effectiveCycle: "next-cycle-and-future",
          requestedAnchorDate: "2026-02-02",
        }),
      ),
    );
    const warning = decision.warnings[0];
    check(
      decision.warnings.length === 1 &&
        warning.code === "PAYMENTS_CLOSE_TOGETHER" &&
        warning.ruleFired === "permanentChange.closePaymentWarningDays" &&
        warning.earlierPaymentDate === "2026-01-31" &&
        warning.laterPaymentDate === "2026-02-02" &&
        warning.gapDays === 2 &&
        warning.thresholdDays === 7 &&
        warning.scheduleCadence === "monthly" &&
        decision.warningAcknowledgementRequired === true,
      "13: two-day monthly gap must warn with threshold 7 and require acknowledgement",
    );
  }

  {
    const decision = asApprovedPermanent(
      "14-monthly-gap-exactly-seven",
      decide(
        "14-monthly-gap-exactly-seven",
        monthlyRequest({
          effectiveCycle: "next-cycle-and-future",
          requestedAnchorDate: "2026-02-07",
        }),
      ),
    );
    check(
      decision.warnings.length === 0 && decision.warningAcknowledgementRequired === false,
      "14: a gap exactly equal to the monthly threshold must not warn",
    );
  }

  asApprovedPermanent(
    "15-monthly-anchor-day-28",
    decide("15-monthly-anchor-day-28", monthlyRequest({ requestedAnchorDate: "2026-01-28" })),
  );

  expectError("16-monthly-anchor-day-29", "INVALID_MONTHLY_ANCHOR_DAY", () =>
    evaluateScheduleChange(monthlyRequest({ requestedAnchorDate: "2026-01-29" }), []),
  );

  expectError("17-monthly-partial-cycle", "INVALID_CYCLE_METADATA", () =>
    evaluateScheduleChange(monthlyRequest({ currentCycleStartDate: "2026-01-02" }), []),
  );

  // -------------------------------------------------------------------------
  // C. Weekly permanent changes

  {
    const decision = asApprovedPermanent(
      "18-weekly-current-move-earlier",
      decide("18-weekly-current-move-earlier", weeklyRequest()),
    );
    check(
      decision.currentPaymentAction === "move-earlier" &&
        decision.firstRevisedPaymentDate === "2026-01-07",
      "18: weekly move-earlier approval expected",
    );
    samePreview("18-weekly-current-move-earlier", decision.revisedSchedulePreview, [
      "2026-01-07",
      "2026-01-14",
      "2026-01-21",
    ]);
  }

  {
    const decision = asApprovedPermanent(
      "19-weekly-current-move-later",
      decide(
        "19-weekly-current-move-later",
        weeklyRequest({
          previousPaymentDate: "2026-01-01",
          currentPaymentDate: "2026-01-07",
          requestedAnchorDate: "2026-01-10",
        }),
      ),
    );
    check(
      decision.currentPaymentAction === "move-later",
      "19: weekly move-later approval expected",
    );
    samePreview("19-weekly-current-move-later", decision.revisedSchedulePreview, [
      "2026-01-10",
      "2026-01-17",
      "2026-01-24",
    ]);
  }

  {
    const decision = asApprovedPermanent(
      "20-weekly-next-cycle",
      decide(
        "20-weekly-next-cycle",
        weeklyRequest({
          effectiveCycle: "next-cycle-and-future",
          requestedAnchorDate: "2026-01-13",
        }),
      ),
    );
    check(
      decision.currentPaymentAction === "keep" &&
        decision.resultingCurrentPaymentDate === "2026-01-09",
      "20: weekly next-cycle approval keeping the current payment expected",
    );
    samePreview("20-weekly-next-cycle", decision.revisedSchedulePreview, [
      "2026-01-13",
      "2026-01-20",
      "2026-01-27",
    ]);
  }

  {
    const decision = asApprovedPermanent(
      "21-weekly-warning-gap-2",
      decide(
        "21-weekly-warning-gap-2",
        weeklyRequest({
          effectiveCycle: "next-cycle-and-future",
          currentPaymentDate: "2026-01-10",
          requestedAnchorDate: "2026-01-12",
        }),
      ),
    );
    check(
      decision.warnings.length === 1 &&
        decision.warnings[0].gapDays === 2 &&
        decision.warnings[0].thresholdDays === 3,
      "21: two-day weekly gap must warn with threshold 3",
    );
  }

  {
    const decision = asApprovedPermanent(
      "22-weekly-warning-gap-3",
      decide(
        "22-weekly-warning-gap-3",
        weeklyRequest({
          effectiveCycle: "next-cycle-and-future",
          requestedAnchorDate: "2026-01-12",
        }),
      ),
    );
    check(decision.warnings.length === 0, "22: three-day weekly gap must not warn");
  }

  expectError("23-weekly-six-day-cycle", "INVALID_CYCLE_METADATA", () =>
    evaluateScheduleChange(weeklyRequest({ currentCycleStartDate: "2026-01-06" }), []),
  );

  // -------------------------------------------------------------------------
  // D. Fortnightly permanent changes

  {
    const decision = asApprovedPermanent(
      "24-fortnightly-current-and-future",
      decide("24-fortnightly-current-and-future", fortnightlyRequest()),
    );
    samePreview("24-fortnightly-current-and-future", decision.revisedSchedulePreview, [
      "2026-01-08",
      "2026-01-22",
      "2026-02-05",
    ]);
  }

  {
    const decision = asApprovedPermanent(
      "25-fortnightly-next-cycle",
      decide(
        "25-fortnightly-next-cycle",
        fortnightlyRequest({
          effectiveCycle: "next-cycle-and-future",
          requestedAnchorDate: "2026-01-22",
        }),
      ),
    );
    check(
      decision.currentPaymentAction === "keep",
      "25: fortnightly next-cycle approval keeping the current payment expected",
    );
    samePreview("25-fortnightly-next-cycle", decision.revisedSchedulePreview, [
      "2026-01-22",
      "2026-02-05",
      "2026-02-19",
    ]);
  }

  {
    const decision = asApprovedPermanent(
      "26-fortnightly-warning-gap-4",
      decide(
        "26-fortnightly-warning-gap-4",
        fortnightlyRequest({
          effectiveCycle: "next-cycle-and-future",
          currentPaymentDate: "2026-01-12",
          requestedAnchorDate: "2026-01-16",
        }),
      ),
    );
    check(
      decision.warnings.length === 1 &&
        decision.warnings[0].gapDays === 4 &&
        decision.warnings[0].thresholdDays === 5,
      "26: four-day fortnightly gap must warn with threshold 5",
    );
  }

  {
    const decision = asApprovedPermanent(
      "27-fortnightly-warning-gap-5",
      decide(
        "27-fortnightly-warning-gap-5",
        fortnightlyRequest({
          effectiveCycle: "next-cycle-and-future",
          currentPaymentDate: "2026-01-12",
          requestedAnchorDate: "2026-01-17",
        }),
      ),
    );
    check(decision.warnings.length === 0, "27: five-day fortnightly gap must not warn");
  }

  expectError("28-fortnightly-13-day-cycle", "INVALID_CYCLE_METADATA", () =>
    evaluateScheduleChange(
      fortnightlyRequest({
        currentCycleEndDate: "2026-01-13",
        nextCycleStartDate: "2026-01-14",
        nextCycleEndDate: "2026-01-27",
      }),
      [],
    ),
  );

  // -------------------------------------------------------------------------
  // E. Current-cycle alternatives and precedence

  {
    const decision = asNextCycleAlternative(
      "29-anchor-on-or-before-evaluation",
      decide(
        "29-anchor-on-or-before-evaluation",
        monthlyRequest({ evaluationDate: "2026-01-15", requestedAnchorDate: "2026-01-10" }),
      ),
    );
    check(
      decision.reasonCode === "PERMANENT_CURRENT_CYCLE_DATE_UNAVAILABLE" &&
        decision.ruleFired === "permanentChange.currentCycleAvailability" &&
        decision.derivedNextCycleAnchorDate === "2026-02-10" &&
        decision.resultingCurrentPaymentDate === "2026-01-31" &&
        decision.firstRevisedPaymentDate === "2026-02-10" &&
        decision.currentPaymentAction === "keep" &&
        decision.suggestedEffectiveCycle === "next-cycle-and-future",
      "29: an anchor on or before evaluationDate must derive the next-cycle alternative",
    );
    samePreview("29-anchor-on-or-before-evaluation", decision.revisedSchedulePreview, [
      "2026-02-10",
      "2026-03-10",
      "2026-04-10",
    ]);
  }

  asNextCycleAlternative(
    "30-anchor-on-or-before-previous",
    decide(
      "30-anchor-on-or-before-previous",
      monthlyRequest({
        previousPaymentDate: "2026-01-08",
        evaluationDate: "2026-01-08",
        requestedAnchorDate: "2026-01-06",
      }),
    ),
  );

  {
    const decision = asNextCycleAlternative(
      "31-anchor-breaches-both-checks",
      decide(
        "31-anchor-breaches-both-checks",
        monthlyRequest({
          previousPaymentDate: "2026-01-05",
          evaluationDate: "2026-01-05",
          requestedAnchorDate: "2026-01-03",
        }),
      ),
    );
    check(
      decision.derivedNextCycleAnchorDate === "2026-02-03",
      "31: one next-cycle alternative expected regardless of which check failed",
    );
  }

  expectError("32-no-valid-alternative", "PERMANENT_DATE_UNCHANGED", () =>
    evaluateScheduleChange(
      monthlyRequest({
        evaluationDate: "2026-01-15",
        requestedAnchorDate: "2026-01-12",
        nextPaymentDate: "2026-02-12",
      }),
      [],
    ),
  );

  expectError("33-derived-anchor-equals-next-payment", "PERMANENT_DATE_UNCHANGED", () =>
    evaluateScheduleChange(
      weeklyRequest({
        evaluationDate: "2026-01-08",
        requestedAnchorDate: "2026-01-07",
        nextPaymentDate: "2026-01-14",
      }),
      [],
    ),
  );

  // -------------------------------------------------------------------------
  // F. No-op validation

  expectError("34-current-anchor-equals-current-payment", "PERMANENT_DATE_UNCHANGED", () =>
    evaluateScheduleChange(
      monthlyRequest({
        currentPaymentDate: "2026-01-20",
        nextPaymentDate: "2026-02-20",
        requestedAnchorDate: "2026-01-20",
      }),
      [],
    ),
  );

  expectError("35-next-anchor-equals-next-payment", "PERMANENT_DATE_UNCHANGED", () =>
    evaluateScheduleChange(
      monthlyRequest({
        effectiveCycle: "next-cycle-and-future",
        requestedAnchorDate: "2026-02-28",
      }),
      [],
    ),
  );

  // -------------------------------------------------------------------------
  // G. Unsupported cadence versus bad metadata

  {
    const decision = asEscalation(
      "36-four-weekly-valid-metadata",
      decide("36-four-weekly-valid-metadata", fourWeeklyRequest()),
      "PERMANENT_SCHEDULE_CADENCE_UNSUPPORTED",
      "permanentChange.supportedCadences",
    );
    check(
      decision.explanation.includes("four-weekly"),
      "36: unsupported-cadence explanation must identify the supplied cadence",
    );
  }

  asEscalation(
    "37-custom-valid-metadata",
    decide(
      "37-custom-valid-metadata",
      fourWeeklyRequest({
        scheduleCadence: "custom",
        paymentId: "payment-fixture-06",
        previousPaymentDate: "2025-12-28",
        currentPaymentDate: "2026-01-06",
        nextPaymentDate: "2026-01-16",
        evaluationDate: "2026-01-02",
        currentCycleStartDate: "2026-01-01",
        currentCycleEndDate: "2026-01-10",
        nextCycleStartDate: "2026-01-11",
        nextCycleEndDate: "2026-01-20",
        requestedAnchorDate: "2026-01-08",
      }),
    ),
    "PERMANENT_SCHEDULE_CADENCE_UNSUPPORTED",
    "permanentChange.supportedCadences",
  );

  expectError("38-unknown-cadence-string", "INVALID_CADENCE", () =>
    evaluateScheduleChange(
      fourWeeklyRequest({ scheduleCadence: "every-third-tuesday" as ScheduleCadence }),
      [],
    ),
  );

  expectError("39-unsupported-cadence-malformed-dates", "INVALID_CYCLE_METADATA", () =>
    evaluateScheduleChange(fourWeeklyRequest({ currentCycleEndDate: "2026-01-32" }), []),
  );

  expectError("40-next-cycle-overlaps-current", "INVALID_CYCLE_METADATA", () =>
    evaluateScheduleChange(monthlyRequest({ nextCycleStartDate: "2026-01-31" }), []),
  );

  expectError("41-gap-between-cycles", "INVALID_CYCLE_METADATA", () =>
    evaluateScheduleChange(monthlyRequest({ nextCycleStartDate: "2026-02-02" }), []),
  );

  expectError("42-current-payment-outside-cycle", "INVALID_CYCLE_METADATA", () =>
    evaluateScheduleChange(monthlyRequest({ currentPaymentDate: "2026-02-02" }), []),
  );

  expectError("43-next-payment-outside-cycle", "INVALID_CYCLE_METADATA", () =>
    evaluateScheduleChange(monthlyRequest({ nextPaymentDate: "2026-03-05" }), []),
  );

  expectError("44-anchor-outside-selected-cycle", "INVALID_CYCLE_METADATA", () =>
    evaluateScheduleChange(monthlyRequest({ requestedAnchorDate: "2026-02-10" }), []),
  );

  // -------------------------------------------------------------------------
  // H. Usage counting

  asEscalation(
    "45-permanent-limit-reached",
    decide(
      "45-permanent-limit-reached",
      monthlyRequest(),
      [verifiedChange("prior-04", "permanent", "2025-06-10")],
    ),
    "PERMANENT_CHANGE_LIMIT_REACHED",
    "permanentChange.maxVerifiedUses",
  );

  {
    const decision = asApprovedPermanent(
      "46-temporary-usage-not-permanent",
      decide(
        "46-temporary-usage-not-permanent",
        monthlyRequest(),
        [
          verifiedChange("prior-05", "temporary", "2025-08-10"),
          verifiedChange("prior-06", "temporary", "2025-11-01"),
        ],
      ),
    );
    check(
      decision.usage.verifiedUsesInPeriod === 0 && decision.usage.permittedUses === 1,
      "46: temporary uses must not consume the permanent allowance",
    );
  }

  {
    const decision = asApprovedTemporary(
      "47-permanent-usage-not-temporary",
      decide(
        "47-permanent-usage-not-temporary",
        temporaryRequest(),
        [verifiedChange("prior-07", "permanent", "2025-08-10")],
      ),
    );
    check(
      decision.usage.verifiedUsesInPeriod === 0 && decision.usage.permittedUses === 2,
      "47: permanent uses must not consume the temporary allowance",
    );
  }

  {
    const decision = asApprovedTemporary(
      "48-change-on-window-start",
      decide(
        "48-change-on-window-start",
        temporaryRequest(),
        [verifiedChange("prior-08", "temporary", "2025-01-05")],
      ),
    );
    check(
      decision.usage.verifiedUsesInPeriod === 1,
      "48: a change exactly on the rolling-window start must count",
    );
  }

  {
    const decision = asApprovedTemporary(
      "49-change-before-window-start",
      decide(
        "49-change-before-window-start",
        temporaryRequest(),
        [verifiedChange("prior-09", "temporary", "2025-01-04")],
      ),
    );
    check(
      decision.usage.verifiedUsesInPeriod === 0,
      "49: a change one day before the rolling-window start must not count",
    );
  }

  {
    const decision = asApprovedTemporary(
      "50-change-on-evaluation-date",
      decide(
        "50-change-on-evaluation-date",
        temporaryRequest(),
        [verifiedChange("prior-10", "temporary", "2026-01-05")],
      ),
    );
    check(
      decision.usage.verifiedUsesInPeriod === 0,
      "50: a change on the exclusive evaluationDate must not count",
    );
  }

  const nonCountingStatuses = [
    ["51-refused-does-not-count", "refused"],
    ["52-abandoned-does-not-count", "abandoned"],
    ["53-execution-failed-does-not-count", "execution-failed"],
    ["54-manual-recovery-does-not-count", "manual-recovery"],
  ] as const;
  for (const [scenario, status] of nonCountingStatuses) {
    const decision = asApprovedTemporary(
      scenario,
      decide(scenario, temporaryRequest(), [
        {
          id: `prior-${scenario}`,
          payerId: PAYER_ID,
          changeType: "temporary",
          status,
          executedDate: "2025-08-10",
        },
      ]),
    );
    check(
      decision.usage.verifiedUsesInPeriod === 0,
      `${scenario}: status ${status} must not consume the allowance`,
    );
  }

  expectError("55-executed-verified-without-date", "EXECUTED_CHANGE_DATE_REQUIRED", () =>
    evaluateScheduleChange(temporaryRequest(), [
      {
        id: "prior-11",
        payerId: PAYER_ID,
        changeType: "temporary",
        status: "executed-verified",
      },
    ]),
  );

  {
    const decision = asApprovedTemporary(
      "56-other-payer-does-not-count",
      decide(
        "56-other-payer-does-not-count",
        temporaryRequest(),
        [verifiedChange("prior-12", "temporary", "2025-08-10", OTHER_PAYER_ID)],
      ),
    );
    check(
      decision.usage.verifiedUsesInPeriod === 0,
      "56: another payer's verified change must not count",
    );
  }

  // -------------------------------------------------------------------------
  // I. Rule precedence

  asEscalation(
    "57-arrears-beats-amount-and-shift",
    decide(
      "57-arrears-beats-amount-and-shift",
      temporaryRequest({
        currentArrearsCents: 500,
        amountCents: 60000,
        requestedDate: "2026-01-20",
      }),
    ),
    "CURRENT_ARREARS_PRESENT",
    "arrears.disqualifyWhenCurrentArrearsCentsAbove",
  );

  asEscalation(
    "58-amount-beats-usage-and-shift",
    decide(
      "58-amount-beats-usage-and-shift",
      temporaryRequest({ amountCents: 60000, requestedDate: "2026-01-20" }),
      [
        verifiedChange("prior-13", "temporary", "2025-08-10"),
        verifiedChange("prior-14", "temporary", "2025-11-01"),
      ],
    ),
    "AMOUNT_CEILING_EXCEEDED",
    "amountCeilingCents",
  );

  asEscalation(
    "59-usage-beats-shorter-alternative",
    decide(
      "59-usage-beats-shorter-alternative",
      temporaryRequest({ requestedDate: "2026-01-20" }),
      [
        verifiedChange("prior-15", "temporary", "2025-08-10"),
        verifiedChange("prior-16", "temporary", "2025-11-01"),
      ],
    ),
    "TEMPORARY_CHANGE_LIMIT_REACHED",
    "temporaryChange.maxVerifiedUses",
  );

  asEscalation(
    "60-usage-beats-next-cycle-alternative",
    decide(
      "60-usage-beats-next-cycle-alternative",
      monthlyRequest({ evaluationDate: "2026-01-15", requestedAnchorDate: "2026-01-10" }),
      [verifiedChange("prior-17", "permanent", "2025-06-10")],
    ),
    "PERMANENT_CHANGE_LIMIT_REACHED",
    "permanentChange.maxVerifiedUses",
  );

  {
    const decision = asEscalation(
      "61-usage-beats-close-payment-warning",
      decide(
        "61-usage-beats-close-payment-warning",
        monthlyRequest({
          effectiveCycle: "next-cycle-and-future",
          requestedAnchorDate: "2026-02-02",
        }),
        [verifiedChange("prior-18", "permanent", "2025-06-10")],
      ),
      "PERMANENT_CHANGE_LIMIT_REACHED",
      "permanentChange.maxVerifiedUses",
    );
    check(
      decision.warnings.length === 0,
      "61: an escalation must carry no close-payment warnings",
    );
  }

  asEscalation(
    "62-arrears-beats-unsupported-cadence",
    decide(
      "62-arrears-beats-unsupported-cadence",
      fourWeeklyRequest({ currentArrearsCents: 100 }),
    ),
    "CURRENT_ARREARS_PRESENT",
    "arrears.disqualifyWhenCurrentArrearsCentsAbove",
  );

  asEscalation(
    "63-amount-beats-unsupported-cadence",
    decide("63-amount-beats-unsupported-cadence", fourWeeklyRequest({ amountCents: 50001 })),
    "AMOUNT_CEILING_EXCEEDED",
    "amountCeilingCents",
  );

  // -------------------------------------------------------------------------
  // J. Determinism and invalid values

  const determinismHistory: PriorScheduleChange[] = [
    verifiedChange("prior-19", "temporary", "2025-08-10"),
    { id: "prior-20", payerId: PAYER_ID, changeType: "permanent", status: "refused" },
    { id: "prior-21", payerId: PAYER_ID, changeType: "temporary", status: "abandoned" },
    verifiedChange("prior-22", "permanent", "2025-09-01", OTHER_PAYER_ID),
    { id: "prior-23", payerId: PAYER_ID, changeType: "permanent", status: "execution-failed" },
    { id: "prior-24", payerId: PAYER_ID, changeType: "permanent", status: "manual-recovery" },
  ];

  const original = decide("64-original-history-order", monthlyRequest(), determinismHistory);
  const reversed = decide(
    "65-reversed-history-order",
    monthlyRequest(),
    [...determinismHistory].reverse(),
  );
  check(
    JSON.stringify(reversed) === JSON.stringify(original),
    "65: reversed history order changed the decision",
  );
  const rerun = decide("66-consecutive-execution", monthlyRequest(), determinismHistory);
  check(
    JSON.stringify(rerun) === JSON.stringify(original),
    "66: two consecutive executions differed",
  );

  expectError("67-fractional-amount", "INVALID_AMOUNT_CENTS", () =>
    evaluateScheduleChange(temporaryRequest({ amountCents: 500.5 }), []),
  );

  expectError("68-negative-arrears", "INVALID_ARREARS_CENTS", () =>
    evaluateScheduleChange(temporaryRequest({ currentArrearsCents: -1 }), []),
  );

  expectError("69-malformed-date", "INVALID_DATE", () =>
    evaluateScheduleChange(temporaryRequest({ requestedDate: "2026-02-30" }), []),
  );

  expectError("70-invalid-payment-date-sequence", "INVALID_DATE_SEQUENCE", () =>
    evaluateScheduleChange(monthlyRequest({ evaluationDate: "2026-02-05" }), []),
  );

  expectError("71-blank-payer-id", "INVALID_IDENTIFIER", () =>
    evaluateScheduleChange(temporaryRequest({ payerId: "   " }), []),
  );

  expectError("72-invalid-custom-amount-ceiling", "INVALID_POLICY_VALUE", () =>
    evaluateScheduleChange(temporaryRequest(), [], {
      ...DEFAULT_DUELOGIC_POLICY,
      amountCeilingCents: 0,
    }),
  );

  expectError("73-zero-rolling-months", "INVALID_POLICY_VALUE", () =>
    evaluateScheduleChange(temporaryRequest(), [], {
      ...DEFAULT_DUELOGIC_POLICY,
      temporaryChange: {
        ...DEFAULT_DUELOGIC_POLICY.temporaryChange,
        rollingPeriodMonths: 0,
      },
    }),
  );

  expectError("74-weekly-threshold-7", "INVALID_POLICY_VALUE", () =>
    evaluateScheduleChange(
      weeklyRequest(),
      [],
      permanentPolicyWith({
        closePaymentWarningDays: { weekly: 7, fortnightly: 5, monthly: 7 },
      }),
    ),
  );

  expectError("75-fortnightly-threshold-14", "INVALID_POLICY_VALUE", () =>
    evaluateScheduleChange(
      fortnightlyRequest(),
      [],
      permanentPolicyWith({
        closePaymentWarningDays: { weekly: 3, fortnightly: 14, monthly: 7 },
      }),
    ),
  );

  expectError("76-monthly-threshold-28", "INVALID_POLICY_VALUE", () =>
    evaluateScheduleChange(
      monthlyRequest(),
      [],
      permanentPolicyWith({
        closePaymentWarningDays: { weekly: 3, fortnightly: 5, monthly: 28 },
      }),
    ),
  );

  expectError("77-missing-threshold-for-supported-cadence", "INVALID_POLICY_VALUE", () =>
    evaluateScheduleChange(
      monthlyRequest(),
      [],
      permanentPolicyWith({
        closePaymentWarningDays: { weekly: 3, fortnightly: 5 },
      }),
    ),
  );

  expectError("78-duplicate-supported-cadence", "INVALID_POLICY_VALUE", () =>
    evaluateScheduleChange(
      monthlyRequest(),
      [],
      permanentPolicyWith({
        supportedCadences: ["weekly", "weekly", "monthly"],
      }),
    ),
  );

  check(table.length === 78, `expected 78 decision-table rows, produced ${table.length}`);

  return { scenarioCount: table.length, decisionTable: table };
}

validatePolicyEngine();
