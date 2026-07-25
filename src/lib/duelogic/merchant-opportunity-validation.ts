/**
 * Development-time validation of the merchant opportunity calculation.
 * Follows the established suite pattern: the checks run once at module load
 * — cheap at this size — so any regression fails fast wherever this module
 * is imported, and the exported function lets the dashboard re-assert per
 * render. No testing dependency required.
 *
 * The seed scenarios consume the exact evaluation pathway the dashboard
 * renders (buildSeedPolicyEvaluations); fixture scenarios derive their
 * decisions from the real policy engine, never from hand-written outcomes.
 */

import { addCalendarDays } from "./calendar-date";
import {
  calculateMerchantOpportunity,
  type MerchantOpportunityInput,
  type MerchantOpportunityResult,
} from "./merchant-opportunity";
import { evaluateScheduleChange } from "./policy/engine";
import { DEFAULT_DUELOGIC_POLICY } from "./policy/rules";
import { buildSeedPolicyEvaluations } from "./seed-policy-evaluations";
import { seedPayers, seedPaymentRecords } from "./seed-payment-history";

function assertOpportunity(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(
      `DueLogic merchant-opportunity validation failed: ${message}`,
    );
  }
}

/** Safe summary only: counts, integer cents and error codes — no live Pinch IDs, no customer financial information. */
export interface MerchantOpportunityScenarioSummary {
  scenario: string;
  outcome: "calculated" | "error";
  qualifyingPayerCount: number | null;
  patternDishonourCount: number | null;
  approvedInterventionCount: number | null;
  eligibleAmountInCents: number | null;
  errorCode: string | null;
}

export interface MerchantOpportunityValidationResult {
  scenarioCount: number;
  scenarios: MerchantOpportunityScenarioSummary[];
}

export function validateMerchantOpportunity(): MerchantOpportunityValidationResult {
  const scenarios: MerchantOpportunityScenarioSummary[] = [];
  const summarize = (
    scenario: string,
    result: MerchantOpportunityResult,
  ): void => {
    if (result.outcome === "calculated") {
      scenarios.push({
        scenario,
        outcome: "calculated",
        qualifyingPayerCount: result.metrics.qualifyingPayerCount,
        patternDishonourCount: result.metrics.patternDishonourCount,
        approvedInterventionCount: result.metrics.approvedInterventionCount,
        eligibleAmountInCents: result.metrics.eligibleAmountCents,
        errorCode: null,
      });
    } else {
      scenarios.push({
        scenario,
        outcome: "error",
        qualifyingPayerCount: null,
        patternDishonourCount: null,
        approvedInterventionCount: null,
        eligibleAmountInCents: null,
        errorCode: result.errorCode,
      });
    }
  };

  // The exact inputs the dashboard passes to the panel.
  const { flags, policyItems } = buildSeedPolicyEvaluations();
  const seedInput: MerchantOpportunityInput = {
    payers: seedPayers,
    flags,
    evaluations: policyItems.map(({ request, decision }) => ({
      request,
      decision,
    })),
  };
  const inputSnapshot = JSON.stringify(seedInput);

  const baseline = calculateMerchantOpportunity(seedInput);
  assertOpportunity(
    baseline.outcome === "calculated",
    "the seed calculation must succeed",
  );
  if (baseline.outcome !== "calculated") {
    throw new Error("unreachable");
  }

  // 1. Qualifying customers: 2 of 8, derived from the detector output.
  assertOpportunity(
    baseline.metrics.qualifyingPayerCount === 2 &&
      baseline.metrics.totalPayerCount === 8,
    `expected 2 qualifying customers of 8, found ${baseline.metrics.qualifyingPayerCount} of ${baseline.metrics.totalPayerCount}`,
  );
  summarize("seed-qualifying-customers", baseline);

  // 2. Pattern-linked insufficient-funds dishonours: 9, from the detector's
  // own member record IDs.
  assertOpportunity(
    baseline.metrics.patternDishonourCount === 9 &&
      baseline.patternDishonourRecordIds.length === 9,
    `expected 9 pattern-linked dishonours, found ${baseline.metrics.patternDishonourCount}`,
  );
  summarize("seed-pattern-dishonours", baseline);

  // 3. Policy-approved interventions: 2.
  assertOpportunity(
    baseline.metrics.approvedInterventionCount === 2,
    `expected 2 approved interventions, found ${baseline.metrics.approvedInterventionCount}`,
  );
  summarize("seed-approved-interventions", baseline);

  // 4. Eligible value equals the sum of the actual upcoming amounts on the
  // approved evaluations — never a hardcoded figure.
  const approvedAmountSum = policyItems
    .filter((item) => item.decision.outcome === "approved")
    .reduce((sum, item) => sum + item.request.amountCents, 0);
  assertOpportunity(
    approvedAmountSum > 0 &&
      baseline.metrics.eligibleAmountCents === approvedAmountSum,
    `eligible value ${baseline.metrics.eligibleAmountCents} must equal the approved upcoming amounts ${approvedAmountSum}`,
  );
  summarize("seed-eligible-value-sum", baseline);

  // 5. Detail rows contain Alicia and Ben only, in payer-ID order.
  assertOpportunity(
    baseline.rows.length === 2 &&
      baseline.rows[0].payerId === "payer-01" &&
      baseline.rows[0].displayName.includes("Alicia") &&
      baseline.rows[1].payerId === "payer-02" &&
      baseline.rows[1].displayName.includes("Ben"),
    "detail rows must contain exactly Alicia (payer-01) then Ben (payer-02)",
  );
  summarize("seed-detail-rows-alicia-ben", baseline);

  // 6. Every counted record is an insufficient-funds dishonour; unrelated
  // dishonour codes never enter the count.
  const recordById = new Map(
    seedPaymentRecords.map((record) => [record.id, record]),
  );
  for (const recordId of baseline.patternDishonourRecordIds) {
    const record = recordById.get(recordId);
    assertOpportunity(
      record !== undefined &&
        record.outcome === "dishonoured" &&
        record.dishonourReason === "insufficient-funds",
      `counted record ${recordId} is not an insufficient-funds dishonour`,
    );
  }
  const unrelatedDishonourIds = seedPaymentRecords
    .filter(
      (record) =>
        record.outcome === "dishonoured" &&
        record.dishonourReason !== "insufficient-funds",
    )
    .map((record) => record.id);
  assertOpportunity(
    unrelatedDishonourIds.length > 0 &&
      unrelatedDishonourIds.every(
        (recordId) => !baseline.patternDishonourRecordIds.includes(recordId),
      ),
    "unrelated dishonour codes must be excluded from the pattern count",
  );
  summarize("seed-excludes-unrelated-dishonour-codes", baseline);

  // 7. Approved payments (including isolated insufficient-funds events that
  // never joined a qualifying flag) are excluded: the count stays below the
  // seed's total insufficient-funds figure and no approved record is counted.
  const totalInsufficientFunds = seedPaymentRecords.filter(
    (record) => record.dishonourReason === "insufficient-funds",
  ).length;
  assertOpportunity(
    baseline.metrics.patternDishonourCount < totalInsufficientFunds,
    "non-qualifying insufficient-funds events must not be counted",
  );
  const approvedRecordIds = new Set(
    seedPaymentRecords
      .filter((record) => record.outcome === "approved")
      .map((record) => record.id),
  );
  assertOpportunity(
    baseline.patternDishonourRecordIds.every(
      (recordId) => !approvedRecordIds.has(recordId),
    ),
    "approved payments must never be counted as pattern dishonours",
  );
  summarize("seed-excludes-approved-retries", baseline);

  // 8. Reordered payer, flag and evaluation inputs produce deeply equal
  // output (the calculation's ordering is fully specified, so canonical JSON
  // comparison is an exact deep-equality check).
  const reordered = calculateMerchantOpportunity({
    payers: [...seedInput.payers].reverse(),
    flags: [...seedInput.flags].reverse(),
    evaluations: [...seedInput.evaluations].reverse(),
  });
  assertOpportunity(
    JSON.stringify(reordered) === JSON.stringify(baseline),
    "reordered inputs changed the output",
  );
  summarize("reordered-inputs-deep-equal", reordered);

  // 9. No qualifying patterns: zero metrics and an empty detail list.
  const empty = calculateMerchantOpportunity({
    payers: seedPayers,
    flags: [],
    evaluations: [],
  });
  assertOpportunity(
    empty.outcome === "calculated" &&
      empty.metrics.qualifyingPayerCount === 0 &&
      empty.metrics.patternDishonourCount === 0 &&
      empty.metrics.approvedInterventionCount === 0 &&
      empty.metrics.eligibleAmountCents === 0 &&
      empty.metrics.totalPayerCount === 8 &&
      empty.rows.length === 0,
    "no qualifying patterns must return zero metrics and no rows",
  );
  summarize("no-qualifying-patterns-zero-metrics", empty);

  // Fixture evaluations for the mixed-outcome scenarios, produced by the
  // real policy engine against modified requests — never hand-written.
  const alicia = policyItems.find((item) => item.request.payerId === "payer-01");
  const ben = policyItems.find((item) => item.request.payerId === "payer-02");
  assertOpportunity(
    alicia !== undefined && ben !== undefined,
    "seed evaluations for payer-01 and payer-02 are required for fixtures",
  );
  if (alicia === undefined || ben === undefined) {
    throw new Error("unreachable");
  }

  // 10. An escalated result stays visible but contributes no approved count
  // or eligible value.
  const overCeilingRequest = {
    ...alicia.request,
    amountCents: DEFAULT_DUELOGIC_POLICY.amountCeilingCents + 100,
  };
  const escalated = calculateMerchantOpportunity({
    payers: seedPayers,
    flags,
    evaluations: [
      {
        request: overCeilingRequest,
        decision: evaluateScheduleChange(
          overCeilingRequest,
          [],
          DEFAULT_DUELOGIC_POLICY,
        ),
      },
      { request: ben.request, decision: ben.decision },
    ],
  });
  assertOpportunity(
    escalated.outcome === "calculated" &&
      escalated.metrics.qualifyingPayerCount === 2 &&
      escalated.metrics.approvedInterventionCount === 1 &&
      escalated.metrics.eligibleAmountCents === ben.request.amountCents &&
      escalated.rows[0].policyOutcome === "escalate" &&
      escalated.rows[0].approvedForReview === false &&
      escalated.rows[0].reasonCode === "AMOUNT_CEILING_EXCEEDED",
    "an escalated result must stay visible without contributing approved count or eligible value",
  );
  summarize("escalated-visible-not-counted", escalated);

  // 11. A non-approved refusal-style result (the engine expresses this as a
  // shorter-alternative, its nearest to a rejection of the requested date)
  // stays visible but contributes no approved count or eligible value.
  const overShiftDate = addCalendarDays(
    alicia.request.currentPaymentDate,
    DEFAULT_DUELOGIC_POLICY.temporaryChange.maxShiftDays + 4,
  );
  assertOpportunity(
    overShiftDate !== null,
    "the over-shift fixture date must be derivable",
  );
  const overShiftRequest = {
    ...alicia.request,
    requestedDate: overShiftDate as string,
  };
  const notApproved = calculateMerchantOpportunity({
    payers: seedPayers,
    flags,
    evaluations: [
      {
        request: overShiftRequest,
        decision: evaluateScheduleChange(
          overShiftRequest,
          [],
          DEFAULT_DUELOGIC_POLICY,
        ),
      },
      { request: ben.request, decision: ben.decision },
    ],
  });
  assertOpportunity(
    notApproved.outcome === "calculated" &&
      notApproved.metrics.qualifyingPayerCount === 2 &&
      notApproved.metrics.approvedInterventionCount === 1 &&
      notApproved.metrics.eligibleAmountCents === ben.request.amountCents &&
      notApproved.rows[0].policyOutcome === "shorter-alternative" &&
      notApproved.rows[0].approvedForReview === false,
    "a non-approved result must stay visible without contributing approved count or eligible value",
  );
  summarize("non-approved-visible-not-counted", notApproved);

  // 12. A missing associated amount is a typed calculation error — never a
  // silent zero.
  const missingAmount = calculateMerchantOpportunity({
    payers: seedPayers,
    flags,
    evaluations: [
      {
        request: { ...alicia.request, amountCents: Number.NaN },
        decision: alicia.decision,
      },
      { request: ben.request, decision: ben.decision },
    ],
  });
  assertOpportunity(
    missingAmount.outcome === "error" &&
      missingAmount.errorCode === "MISSING_UPCOMING_AMOUNT",
    "a missing upcoming amount must produce MISSING_UPCOMING_AMOUNT",
  );
  summarize("missing-amount-calculation-error", missingAmount);

  // 13. No input array or object was mutated by any scenario above.
  assertOpportunity(
    JSON.stringify(seedInput) === inputSnapshot,
    "the calculation mutated its input",
  );
  summarize("inputs-not-mutated", baseline);

  // 14. All money remains integer cents until display formatting.
  assertOpportunity(
    Number.isInteger(baseline.metrics.eligibleAmountCents) &&
      baseline.rows.every((row) => Number.isInteger(row.upcomingAmountCents)),
    "monetary values must remain integer cents",
  );
  summarize("integer-cents-until-display", baseline);

  return { scenarioCount: scenarios.length, scenarios };
}

validateMerchantOpportunity();
