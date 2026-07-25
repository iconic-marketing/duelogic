/**
 * Merchant opportunity calculation.
 *
 * Pure deterministic aggregation of the detector's flags and the policy
 * engine's decisions into four headline metrics and one detail row per
 * qualifying payer: no clock reads, no randomness, no network, no
 * environment access, no input mutation, and output invariant to the order
 * of every input array. Monetary values stay integer cents; dollar
 * formatting happens only at the display boundary.
 *
 * The calculation quantifies what the supplied inputs already established
 * and nothing more. "Eligible" means an upcoming payment whose schedule
 * change the deterministic policy approved for review — never a prevented
 * dishonour, recovered revenue, avoided loss or any causal or affordability
 * claim. Non-approved outcomes remain visible in the detail rows but
 * contribute nothing to approved counts or eligible value.
 */

import type {
  PolicyDecision,
  TemporaryPolicyEvaluationRequest,
} from "./policy/engine";
import type { PatternFlag, Payer } from "./schema";

/** One dashboard policy evaluation: the exact request and its decision. */
export interface MerchantOpportunityEvaluation {
  request: TemporaryPolicyEvaluationRequest;
  decision: PolicyDecision;
}

export interface MerchantOpportunityInput {
  payers: readonly Payer[];
  flags: readonly PatternFlag[];
  evaluations: readonly MerchantOpportunityEvaluation[];
}

export interface MerchantOpportunityMetrics {
  qualifyingPayerCount: number;
  totalPayerCount: number;
  /** Unique detector-member insufficient-funds dishonour records. */
  patternDishonourCount: number;
  /** Flagged payers whose policy decision outcome is "approved". */
  approvedInterventionCount: number;
  /** Integer cents: one upcoming payment per approved payer, summed. */
  eligibleAmountCents: number;
}

export interface MerchantOpportunityRow {
  payerId: string;
  displayName: string;
  patternDishonourCount: number;
  /** Detector-derived wording only, e.g. "5 insufficient-funds dishonours, days 25–28". */
  evidenceSummary: string;
  policyOutcome: PolicyDecision["outcome"];
  reasonCode: string;
  approvedForReview: boolean;
  proposedShiftDays: number;
  /** Integer cents: the exact amount the policy evaluation used. */
  upcomingAmountCents: number;
  /** YYYY-MM-DD: the approved date when approved, else the requested date. */
  proposedDate: string;
}

export type MerchantOpportunityErrorCode =
  | "UNKNOWN_FLAGGED_PAYER"
  | "DUPLICATE_PATTERN_FLAG"
  | "MISSING_POLICY_EVALUATION"
  | "DUPLICATE_POLICY_EVALUATION"
  | "MISSING_UPCOMING_AMOUNT";

/**
 * Inconsistent input is a typed calculation error, never a silent zero.
 * Messages carry internal identifiers only — no amounts, no customer data.
 */
export type MerchantOpportunityResult =
  | {
      outcome: "calculated";
      metrics: MerchantOpportunityMetrics;
      rows: MerchantOpportunityRow[];
      /** Ascending unique record IDs behind patternDishonourCount. */
      patternDishonourRecordIds: string[];
    }
  | {
      outcome: "error";
      errorCode: MerchantOpportunityErrorCode;
      message: string;
    };

function calculationError(
  errorCode: MerchantOpportunityErrorCode,
  message: string,
): MerchantOpportunityResult {
  return { outcome: "error", errorCode, message };
}

/** Restates the flag's own evidence; adds no interpretation. */
function evidenceSummaryFor(flag: PatternFlag): string {
  const { evidence } = flag;
  const count = evidence.qualifyingDishonourCount;
  const dishonours = `${count} insufficient-funds ${count === 1 ? "dishonour" : "dishonours"}`;
  if (
    evidence.basis === "day-of-month" &&
    evidence.windowStartDay !== undefined &&
    evidence.windowEndDay !== undefined
  ) {
    return `${dishonours}, days ${evidence.windowStartDay}–${evidence.windowEndDay}`;
  }
  if (evidence.basis === "day-of-week" && evidence.weekday !== undefined) {
    return `${dishonours}, every ${evidence.weekday}`;
  }
  return dishonours;
}

/** The date the policy result put forward: approved date, else requested. */
function proposedDateFor(evaluation: MerchantOpportunityEvaluation): string {
  const { decision, request } = evaluation;
  if (decision.outcome === "approved") {
    return "approvedPaymentDate" in decision
      ? decision.approvedPaymentDate
      : decision.firstRevisedPaymentDate;
  }
  return request.requestedDate;
}

export function calculateMerchantOpportunity(
  input: MerchantOpportunityInput,
): MerchantOpportunityResult {
  const payersById = new Map(input.payers.map((payer) => [payer.id, payer]));

  const evaluationsByPayerId = new Map<string, MerchantOpportunityEvaluation>();
  for (const evaluation of input.evaluations) {
    const payerId = evaluation.request.payerId;
    if (evaluationsByPayerId.has(payerId)) {
      return calculationError(
        "DUPLICATE_POLICY_EVALUATION",
        `More than one policy evaluation was supplied for ${payerId}.`,
      );
    }
    evaluationsByPayerId.set(payerId, evaluation);
  }

  // Deterministic row order regardless of input order.
  const sortedFlags = [...input.flags].sort((a, b) =>
    a.payerId < b.payerId ? -1 : a.payerId > b.payerId ? 1 : 0,
  );

  const seenPayerIds = new Set<string>();
  const patternDishonourRecordIds = new Set<string>();
  const rows: MerchantOpportunityRow[] = [];
  let approvedInterventionCount = 0;
  let eligibleAmountCents = 0;

  for (const flag of sortedFlags) {
    if (seenPayerIds.has(flag.payerId)) {
      return calculationError(
        "DUPLICATE_PATTERN_FLAG",
        `More than one pattern flag was supplied for ${flag.payerId}.`,
      );
    }
    seenPayerIds.add(flag.payerId);

    const payer = payersById.get(flag.payerId);
    if (payer === undefined) {
      return calculationError(
        "UNKNOWN_FLAGGED_PAYER",
        `Pattern flag for ${flag.payerId} references a payer that was not supplied.`,
      );
    }
    const evaluation = evaluationsByPayerId.get(flag.payerId);
    if (evaluation === undefined) {
      return calculationError(
        "MISSING_POLICY_EVALUATION",
        `No policy evaluation was supplied for flagged payer ${flag.payerId}.`,
      );
    }
    const upcomingAmountCents = evaluation.request.amountCents;
    if (!Number.isInteger(upcomingAmountCents) || upcomingAmountCents <= 0) {
      return calculationError(
        "MISSING_UPCOMING_AMOUNT",
        `The policy evaluation for ${flag.payerId} carries no positive integer upcoming amount.`,
      );
    }

    // Only the detector's own member dishonour records are counted — never
    // unrelated dishonour codes, clean records or approved retries.
    for (const recordId of flag.evidence.qualifyingPaymentRecordIds) {
      patternDishonourRecordIds.add(recordId);
    }

    const approvedForReview = evaluation.decision.outcome === "approved";
    if (approvedForReview) {
      approvedInterventionCount += 1;
      eligibleAmountCents += upcomingAmountCents;
    }

    rows.push({
      payerId: flag.payerId,
      displayName: payer.displayName,
      patternDishonourCount: flag.evidence.qualifyingPaymentRecordIds.length,
      evidenceSummary: evidenceSummaryFor(flag),
      policyOutcome: evaluation.decision.outcome,
      reasonCode: evaluation.decision.reasonCode,
      approvedForReview,
      proposedShiftDays: flag.proposedShiftDays,
      upcomingAmountCents,
      proposedDate: proposedDateFor(evaluation),
    });
  }

  return {
    outcome: "calculated",
    metrics: {
      qualifyingPayerCount: rows.length,
      totalPayerCount: input.payers.length,
      patternDishonourCount: patternDishonourRecordIds.size,
      approvedInterventionCount,
      eligibleAmountCents,
    },
    rows,
    patternDishonourRecordIds: [...patternDishonourRecordIds].sort(),
  };
}
