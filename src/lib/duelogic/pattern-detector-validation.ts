/**
 * Development-time validation of the pattern detector against the synthetic
 * seed. Follows the seed module's own pattern: the checks run once at module
 * load — cheap at this size — so any regression fails fast wherever this
 * module is imported (including `next build` via the inspection route), and
 * the exported function lets the route re-assert per request. No testing
 * dependency required.
 */

import type { PatternFlag, PaymentRecord } from "./schema";
import { detectTimingLinkedPatterns } from "./pattern-detector";
import { seedPaymentRecords } from "./seed-payment-history";

/** The intentionally planted recurring-pattern payers in the seed. */
const EXPECTED_FLAGGED_PAYER_IDS = ["payer-01", "payer-02"] as const;
/** Payers with a single isolated insufficient-funds event. */
const ISOLATED_PAYER_IDS = ["payer-03", "payer-04"] as const;

function assertDetection(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(
      `DueLogic pattern-detector seed validation failed: ${message}`,
    );
  }
}

export interface SeedPatternValidationResult {
  flagCount: number;
  flaggedPayerIds: string[];
}

// ---------------------------------------------------------------------------
// Window-semantics regression fixtures, independent of the main seed. Both
// payers dishonour twice on day 28, so the earliest four-day detection window
// is 25-28; only the retry's position relative to that *full* window differs.

const FIXTURE_MERCHANT_ID = "merchant-fixture-01";

function fixtureDishonour(input: {
  id: string;
  payerId: string;
  scheduledDate: string;
  processedDate: string;
  /** When present, the record carries an approved retry on this date. */
  retryDate?: string;
}): PaymentRecord {
  const record: PaymentRecord = {
    id: input.id,
    merchantId: FIXTURE_MERCHANT_ID,
    payerId: input.payerId,
    amountCents: 10_000,
    scheduledDate: input.scheduledDate,
    processedDate: input.processedDate,
    outcome: "dishonoured",
    dishonourReason: "insufficient-funds",
    retryOutcome: input.retryDate !== undefined ? "approved" : null,
    sourceType: "bank-account",
    synthetic: true,
  };
  if (input.retryDate !== undefined) {
    record.retryDate = input.retryDate;
  }
  return record;
}

export function validateDetectionWindowSemantics(): void {
  // Inside-window retry is rejected: the day-26 retry sits inside the
  // selected 25-28 window even though both dishonours fell on day 28, so no
  // settlement evidence exists and the payer must not be flagged. (The two
  // scheduled dates fall on different weekdays, so no day-of-week cluster
  // can qualify instead.)
  const insideWindowRetry = detectTimingLinkedPatterns([
    fixtureDishonour({
      id: "fixture-a-01", payerId: "fixture-payer-a",
      scheduledDate: "2026-01-28", processedDate: "2026-01-28",
      retryDate: "2026-02-26",
    }),
    fixtureDishonour({
      id: "fixture-a-02", payerId: "fixture-payer-a",
      scheduledDate: "2026-02-28", processedDate: "2026-02-28",
    }),
  ]);
  assertDetection(
    insideWindowRetry.length === 0,
    "a retry on day 26 is inside the selected 25-28 window and must not produce a flag",
  );

  // Outside-window retry qualifies: identical shape, but the retry lands on
  // day 1 of the following month — outside the 25-28 window (windows never
  // wrap, so a low day is always outside a late window).
  const outsideWindowRetry = detectTimingLinkedPatterns([
    fixtureDishonour({
      id: "fixture-b-01", payerId: "fixture-payer-b",
      scheduledDate: "2026-01-28", processedDate: "2026-01-28",
      retryDate: "2026-02-01",
    }),
    fixtureDishonour({
      id: "fixture-b-02", payerId: "fixture-payer-b",
      scheduledDate: "2026-02-28", processedDate: "2026-02-28",
    }),
  ]);
  assertDetection(
    outsideWindowRetry.length === 1,
    "a day-1 retry outside the selected 25-28 window must allow a flag",
  );
  const flag = outsideWindowRetry[0];
  assertDetection(
    flag.payerId === "fixture-payer-b" &&
      flag.evidence.basis === "day-of-month" &&
      flag.evidence.windowStartDay === 25 &&
      flag.evidence.windowEndDay === 28,
    "the selected detection window must be reported as 25-28",
  );
  assertDetection(
    flag.evidence.settlementEvidence.length === 1 &&
      flag.evidence.settlementEvidence[0].delayDays === 4 &&
      flag.proposedShiftDays === 4,
    "the outside-window retry must be the sole settlement evidence (4-day delay)",
  );
}

export function validateSeedPatternDetection(): SeedPatternValidationResult {
  const flags = detectTimingLinkedPatterns(seedPaymentRecords);

  assertDetection(
    flags.length === 2,
    `expected exactly 2 flags, found ${flags.length}`,
  );
  const flaggedPayerIds = flags.map((flag) => flag.payerId);
  for (const payerId of EXPECTED_FLAGGED_PAYER_IDS) {
    assertDetection(
      flaggedPayerIds.includes(payerId),
      `planted pattern payer ${payerId} was not flagged`,
    );
  }
  for (const payerId of ISOLATED_PAYER_IDS) {
    assertDetection(
      !flaggedPayerIds.includes(payerId),
      `isolated insufficient-funds payer ${payerId} must not be flagged`,
    );
  }

  const recordById = new Map(
    seedPaymentRecords.map((record) => [record.id, record]),
  );
  const assertInsufficientFundsRecord = (
    flag: PatternFlag,
    paymentRecordId: string,
  ): void => {
    const record = recordById.get(paymentRecordId);
    assertDetection(
      record !== undefined,
      `${flag.payerId}: evidence references unknown record ${paymentRecordId}`,
    );
    assertDetection(
      record !== undefined &&
        record.outcome === "dishonoured" &&
        record.dishonourReason === "insufficient-funds",
      `${flag.payerId}: record ${paymentRecordId} in evidence is not an insufficient-funds dishonour`,
    );
  };

  for (const flag of flags) {
    assertDetection(
      flag.evidence.qualifyingDishonourCount >= 2 &&
        flag.evidence.qualifyingPaymentRecordIds.length ===
          flag.evidence.qualifyingDishonourCount,
      `${flag.payerId}: fewer than 2 qualifying dishonours`,
    );
    for (const paymentRecordId of flag.evidence.qualifyingPaymentRecordIds) {
      assertInsufficientFundsRecord(flag, paymentRecordId);
    }
    assertDetection(
      flag.evidence.settlementEvidence.length >= 1,
      `${flag.payerId}: no approved later-settlement evidence`,
    );
    for (const item of flag.evidence.settlementEvidence) {
      assertInsufficientFundsRecord(flag, item.paymentRecordId);
      assertDetection(
        item.retryDate > item.processedDate,
        `${flag.payerId}: retryDate is not after processedDate for ${item.paymentRecordId}`,
      );
      assertDetection(
        Number.isInteger(item.delayDays) && item.delayDays > 0,
        `${flag.payerId}: delayDays is not a positive integer for ${item.paymentRecordId}`,
      );
    }
    assertDetection(
      Number.isInteger(flag.proposedShiftDays) && flag.proposedShiftDays > 0,
      `${flag.payerId}: proposedShiftDays is not a positive integer`,
    );
  }

  // Selected detection windows and proposed shifts for the planted payers:
  // both cluster on a single late day (28 and 27), so the earliest four-day
  // window containing that day is the selected window.
  const expectedWindows: ReadonlyArray<{
    payerId: string;
    windowStartDay: number;
    windowEndDay: number;
    proposedShiftDays: number;
  }> = [
    { payerId: "payer-01", windowStartDay: 25, windowEndDay: 28, proposedShiftDays: 4 },
    { payerId: "payer-02", windowStartDay: 24, windowEndDay: 27, proposedShiftDays: 5 },
  ];
  for (const expected of expectedWindows) {
    const flag = flags.find((item) => item.payerId === expected.payerId);
    assertDetection(
      flag !== undefined &&
        flag.evidence.basis === "day-of-month" &&
        flag.evidence.windowStartDay === expected.windowStartDay &&
        flag.evidence.windowEndDay === expected.windowEndDay,
      `${expected.payerId}: selected window must be ${expected.windowStartDay}-${expected.windowEndDay}`,
    );
    assertDetection(
      flag !== undefined &&
        flag.proposedShiftDays === expected.proposedShiftDays,
      `${expected.payerId}: proposedShiftDays must remain ${expected.proposedShiftDays}`,
    );
  }

  // Deterministic: consecutive runs and reversed input order must produce
  // deeply equal output (the detector's ordering is fully specified, so a
  // canonical JSON comparison is an exact deep-equality check here).
  const rerun = detectTimingLinkedPatterns(seedPaymentRecords);
  assertDetection(
    JSON.stringify(rerun) === JSON.stringify(flags),
    "two consecutive runs differed",
  );
  const reversed = detectTimingLinkedPatterns(
    [...seedPaymentRecords].reverse(),
  );
  assertDetection(
    JSON.stringify(reversed) === JSON.stringify(flags),
    "reversed input order changed the output",
  );

  return { flagCount: flags.length, flaggedPayerIds };
}

validateSeedPatternDetection();
validateDetectionWindowSemantics();
