/**
 * Deterministic validation of the development transaction-verification
 * repository, the atomic single-use claim and the controlled rehearsal
 * seeding, following the repository's validation convention: the exported
 * async function re-asserts the scenario table on demand, and one pass is
 * kicked off at module load with loud failure logging.
 *
 * Nothing here calls Pinch or reads a real clock: isolated in-memory
 * repositories, a controlled tick clock and synthetic identifiers only.
 *
 * The ten scenarios:
 *  tv1 an exact verification record can be created and read back;
 *  tv2 a second create for the same intervention is refused without
 *      changing the first record (write-once);
 *  tv3 returned records are immutable copies — caller mutation never
 *      alters stored state;
 *  tv4 finalConfirmationEnabled follows the record exactly: enabled only
 *      by an exact, unexpired, unconsumed record; disabled for missing,
 *      expired, consumed and every mismatched binding;
 *  tv5 the atomic claim succeeds exactly once, is terminal, and the
 *      post-claim projection is disabled;
 *  tv6 two concurrent claims can never both succeed;
 *  tv7 a mismatched claim refuses WITHOUT consuming — the exact claim
 *      still succeeds afterwards;
 *  tv8 rehearsal seeding constructs the record only from trusted
 *      server-held intervention fields, with a 10-minute expiry, and a
 *      second seed refuses without replacing the first;
 *  tv9 seeding refuses non-preview-ready, unresolvable-policy and
 *      unknown-token cases, creating nothing;
 * tv10 browser-supplied identity, schedule, policy or verification fields
 *      are rejected, and no record means no claim — no bypass exists.
 */

import { createInMemoryInterventionRepository } from "./dev-intervention-store";
import {
  createInMemoryTransactionVerificationRepository,
  parseRehearsalVerificationSeedInput,
  REHEARSAL_VERIFICATION_LIFETIME_MINUTES,
  seedRehearsalTransactionVerification,
  type RehearsalVerificationSeedDeps,
} from "./dev-transaction-verification-store";
import {
  toCustomerInterventionProjection,
  transactionVerificationExpectationFor,
  type DueLogicInterventionRecord,
} from "./intervention";
import { createInMemoryMerchantPolicyRepository } from "./policy/dev-policy-store";
import { DEFAULT_DUELOGIC_POLICY } from "./policy/rules";
import type {
  ClaimableTransactionVerificationRepository,
  TransactionVerificationRecord,
} from "./transaction-verification";

export interface TransactionVerificationValidationRow {
  scenario: string;
  outcome: string;
}

export interface TransactionVerificationValidationResult {
  scenarioCount: number;
  decisionTable: TransactionVerificationValidationRow[];
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Transaction-verification validation failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Deterministic fixtures — synthetic identifiers only

const CLOCK_START = "2026-07-25T00:00:00.000Z";

/** Strictly increasing controlled clock; the first reading is the start. */
function makeClock(startIso: string = CLOCK_START): () => string {
  let tick = 0;
  return (): string => {
    const reading = new Date(Date.parse(startIso) + tick * 1_000);
    tick += 1;
    return reading.toISOString();
  };
}

const PAYMENTS_CURRENT = [
  { paymentDate: "2026-08-14", amountInCents: 12500 },
  { paymentDate: "2026-08-28", amountInCents: 12500 },
  { paymentDate: "2026-09-11", amountInCents: 12500 },
] as const;

const PAYMENTS_PROPOSED = [
  { paymentDate: "2026-08-18", amountInCents: 12500 },
  { paymentDate: "2026-09-01", amountInCents: 12500 },
  { paymentDate: "2026-09-15", amountInCents: 12500 },
] as const;

const RAW_TOKEN = "raw-demo-verification-token";

/** A preview-ready synthetic intervention with the exact stored schedules. */
function previewReadyIntervention(): DueLogicInterventionRecord {
  return {
    interventionId: "int_demo_ver_01",
    notificationId: "ntf_demo_ver_01",
    tokenHash: `fakehash:${RAW_TOKEN}`,
    merchantId: "mch_demo",
    payerId: "pyr_demo",
    sourceId: "src_demo",
    subscriptionId: "sub_demo_active",
    planId: "pln_demo",
    patternFlagId: "flag_demo_01",
    policyVersion: DEFAULT_DUELOGIC_POLICY.version,
    scheduleCadence: "fortnightly",
    changeMode: "permanent",
    currentStartDate: "2026-08-14",
    currentPaymentAmountInCents: 12500,
    currentCycleStartDate: "2026-08-11",
    currentCycleEndDate: "2026-08-24",
    suggestedDate: "2026-08-18",
    selectedDate: "2026-08-18",
    offeredAlternativeDate: null,
    policyOutcome: "approved",
    policyReasonCode: "POLICY_APPROVED",
    policyRuleFired: "all-policy-rules-passed",
    policyExplanation: "The payment remains within its assigned billing cycle.",
    policyWarnings: [],
    currentPayments: PAYMENTS_CURRENT.map((payment) => ({ ...payment })),
    proposedPayments: PAYMENTS_PROPOSED.map((payment) => ({ ...payment })),
    currency: "AUD",
    confirmationId: null,
    operationId: null,
    newSubscriptionId: null,
    status: "preview-ready",
    createdAt: CLOCK_START,
    expiresAt: "2026-08-01T00:00:00.000Z",
    openedAt: null,
    selectedAt: CLOCK_START,
    declinedAt: null,
    updatedAt: CLOCK_START,
  };
}

/** A verification record bound exactly to the intervention. */
function verificationFor(
  record: DueLogicInterventionRecord,
  nowIso: string,
  overrides: Partial<TransactionVerificationRecord> = {},
): TransactionVerificationRecord {
  const expectation = transactionVerificationExpectationFor(record);
  return {
    verificationId: "ver_demo_01",
    interventionId: expectation.interventionId,
    merchantId: expectation.merchantId,
    payerId: expectation.payerId,
    subscriptionId: expectation.subscriptionId,
    selectedDate: expectation.selectedDate,
    currentPayments: expectation.currentPayments.map((payment) => ({
      ...payment,
    })),
    proposedPayments: expectation.proposedPayments.map((payment) => ({
      ...payment,
    })),
    policyVersion: expectation.policyVersion,
    verifiedAt: nowIso,
    expiresAt: new Date(Date.parse(nowIso) + 10 * 60_000).toISOString(),
    consumedAt: null,
    ...overrides,
  };
}

/** Isolated seeding dependencies over a stored synthetic intervention. */
async function makeSeedDeps(
  record: DueLogicInterventionRecord = previewReadyIntervention(),
): Promise<{
  deps: RehearsalVerificationSeedDeps;
  verifications: ClaimableTransactionVerificationRepository;
  interventions: ReturnType<typeof createInMemoryInterventionRepository>;
  clock: () => string;
}> {
  const interventions = createInMemoryInterventionRepository();
  await interventions.write(record);
  const verifications = createInMemoryTransactionVerificationRepository();
  const policies = createInMemoryMerchantPolicyRepository();
  const clock = makeClock();
  await policies.activate({
    policyVersion: DEFAULT_DUELOGIC_POLICY.version,
    merchantId: record.merchantId,
    policy: DEFAULT_DUELOGIC_POLICY,
    activatedAt: clock(),
    installedAsInitialDefault: true,
  });
  let verificationCounter = 0;
  return {
    deps: {
      interventions,
      verifications,
      policies,
      now: clock,
      hashToken: (raw: string): string => `fakehash:${raw}`,
      generateVerificationId: (): string => {
        verificationCounter += 1;
        return `ver_demo_${String(verificationCounter).padStart(2, "0")}`;
      },
    },
    verifications,
    interventions,
    clock,
  };
}

// ---------------------------------------------------------------------------
// Scenario table

export async function validateTransactionVerification(): Promise<TransactionVerificationValidationResult> {
  const table: TransactionVerificationValidationRow[] = [];
  const record = (scenario: string, outcome: string): void => {
    table.push({ scenario, outcome });
  };

  // tv1: an exact record can be created and read back identically.
  {
    const clock = makeClock();
    const repository = createInMemoryTransactionVerificationRepository();
    const intervention = previewReadyIntervention();
    const verification = verificationFor(intervention, clock());
    await repository.create(verification);
    const read = await repository.readVerifiedForIntervention(
      intervention.interventionId,
    );
    check(
      read !== null && JSON.stringify(read) === JSON.stringify(verification),
      "tv1: the stored record must read back identically",
    );
    record("tv1-create-and-read", "stored");
  }

  // tv2: create is write-once per intervention — a second record refuses
  // and the first is unchanged.
  {
    const clock = makeClock();
    const repository = createInMemoryTransactionVerificationRepository();
    const intervention = previewReadyIntervention();
    const first = verificationFor(intervention, clock());
    await repository.create(first);
    let refused = false;
    try {
      await repository.create(
        verificationFor(intervention, clock(), { verificationId: "ver_demo_02" }),
      );
    } catch {
      refused = true;
    }
    check(refused, "tv2: a second create for the intervention must refuse");
    const read = await repository.readVerifiedForIntervention(
      intervention.interventionId,
    );
    check(
      read !== null && JSON.stringify(read) === JSON.stringify(first),
      "tv2: the first record must be unchanged",
    );
    record("tv2-write-once", "refused-second");
  }

  // tv3: returned records are immutable copies.
  {
    const clock = makeClock();
    const repository = createInMemoryTransactionVerificationRepository();
    const intervention = previewReadyIntervention();
    const verification = verificationFor(intervention, clock());
    await repository.create(verification);
    const read = (await repository.readVerifiedForIntervention(
      intervention.interventionId,
    )) as TransactionVerificationRecord;
    (read as { selectedDate: string }).selectedDate = "1999-01-01";
    (read as { consumedAt: string | null }).consumedAt = clock();
    const reread = await repository.readVerifiedForIntervention(
      intervention.interventionId,
    );
    check(
      reread !== null &&
        reread.selectedDate === "2026-08-18" &&
        reread.consumedAt === null,
      "tv3: caller mutation must never alter stored state",
    );
    record("tv3-immutable-copies", "immutable");
  }

  // tv4: finalConfirmationEnabled follows the record exactly.
  {
    const clock = makeClock();
    const intervention = previewReadyIntervention();
    const nowIso = clock();
    const exact = verificationFor(intervention, nowIso);
    const enabled = (
      verification: TransactionVerificationRecord | null,
    ): boolean =>
      toCustomerInterventionProjection(intervention, clock(), verification)
        .finalConfirmationEnabled;
    check(enabled(null) === false, "tv4: no record must disable confirmation");
    check(enabled(exact) === true, "tv4: an exact record must enable confirmation");
    check(
      enabled({ ...exact, expiresAt: nowIso }) === false,
      "tv4: an expired record must disable confirmation",
    );
    check(
      enabled({ ...exact, consumedAt: nowIso }) === false,
      "tv4: a consumed record must disable confirmation",
    );
    check(
      enabled({ ...exact, selectedDate: "2026-08-19" }) === false,
      "tv4: a selected-date mismatch must disable confirmation",
    );
    check(
      enabled({ ...exact, policyVersion: "duelogic-policy-v9" }) === false,
      "tv4: a policyVersion mismatch must disable confirmation",
    );
    check(
      enabled({
        ...exact,
        currentPayments: exact.currentPayments.map((payment, index) =>
          index === 0 ? { ...payment, amountInCents: 999 } : { ...payment },
        ),
      }) === false,
      "tv4: a current-schedule mismatch must disable confirmation",
    );
    check(
      enabled({
        ...exact,
        proposedPayments: exact.proposedPayments.map((payment, index) =>
          index === 2 ? { ...payment, paymentDate: "2026-09-16" } : { ...payment },
        ),
      }) === false,
      "tv4: a proposed-schedule mismatch must disable confirmation",
    );
    record("tv4-projection-follows-record", "derived");
  }

  // tv5: the atomic claim succeeds exactly once, is terminal, and the
  // post-claim projection is disabled.
  {
    const clock = makeClock();
    const repository = createInMemoryTransactionVerificationRepository();
    const intervention = previewReadyIntervention();
    await repository.create(verificationFor(intervention, clock()));
    const expectation = transactionVerificationExpectationFor(intervention);
    const claimIso = clock();
    const claimed = await repository.claimForExecution(
      intervention.interventionId,
      expectation,
      claimIso,
    );
    check(
      claimed !== null && claimed.consumedAt === claimIso,
      "tv5: the first claim must succeed and consume",
    );
    const stored = await repository.readVerifiedForIntervention(
      intervention.interventionId,
    );
    check(
      stored !== null && stored.consumedAt === claimIso,
      "tv5: the stored record must be consumed",
    );
    check(
      toCustomerInterventionProjection(intervention, clock(), stored)
        .finalConfirmationEnabled === false,
      "tv5: the post-claim projection must be disabled",
    );
    const second = await repository.claimForExecution(
      intervention.interventionId,
      expectation,
      clock(),
    );
    check(second === null, "tv5: a repeated claim must return null");
    record("tv5-atomic-claim-once", "terminal");
  }

  // tv6: two concurrent claims can never both succeed.
  {
    const clock = makeClock();
    const repository = createInMemoryTransactionVerificationRepository();
    const intervention = previewReadyIntervention();
    await repository.create(verificationFor(intervention, clock()));
    const expectation = transactionVerificationExpectationFor(intervention);
    const [first, second] = await Promise.all([
      repository.claimForExecution(
        intervention.interventionId,
        expectation,
        clock(),
      ),
      repository.claimForExecution(
        intervention.interventionId,
        expectation,
        clock(),
      ),
    ]);
    const successes = [first, second].filter(
      (outcome) => outcome !== null,
    ).length;
    check(successes === 1, "tv6: exactly one concurrent claim may succeed");
    record("tv6-concurrent-claims", "single-winner");
  }

  // tv7: a mismatched claim refuses WITHOUT consuming; the exact claim
  // still succeeds afterwards.
  {
    const clock = makeClock();
    const repository = createInMemoryTransactionVerificationRepository();
    const intervention = previewReadyIntervention();
    await repository.create(verificationFor(intervention, clock()));
    const expectation = transactionVerificationExpectationFor(intervention);
    const mismatches = [
      { ...expectation, selectedDate: "2026-08-19" },
      {
        ...expectation,
        proposedPayments: expectation.proposedPayments.map((payment, index) =>
          index === 0 ? { ...payment, amountInCents: 999 } : { ...payment },
        ),
      },
      {
        ...expectation,
        currentPayments: expectation.currentPayments.map((payment, index) =>
          index === 1 ? { ...payment, paymentDate: "2026-08-29" } : { ...payment },
        ),
      },
      { ...expectation, policyVersion: "duelogic-policy-v9" },
    ];
    for (const mismatch of mismatches) {
      const refused = await repository.claimForExecution(
        intervention.interventionId,
        mismatch,
        clock(),
      );
      check(refused === null, "tv7: a mismatched claim must refuse");
    }
    const stored = await repository.readVerifiedForIntervention(
      intervention.interventionId,
    );
    check(
      stored !== null && stored.consumedAt === null,
      "tv7: mismatched claims must not consume the record",
    );
    const exact = await repository.claimForExecution(
      intervention.interventionId,
      expectation,
      clock(),
    );
    check(exact !== null, "tv7: the exact claim must still succeed afterwards");
    record("tv7-mismatch-does-not-consume", "recheck-enforced");
  }

  // tv8: rehearsal seeding builds the record only from the trusted stored
  // intervention, with the 10-minute expiry; a second seed refuses without
  // replacing the first.
  {
    const harness = await makeSeedDeps();
    const outcome = await seedRehearsalTransactionVerification(
      { token: RAW_TOKEN },
      harness.deps,
    );
    check(outcome.ok, "tv8: seeding a preview-ready intervention must succeed");
    const verification = outcome.ok ? outcome.verification : null;
    const intervention = previewReadyIntervention();
    const expectation = transactionVerificationExpectationFor(intervention);
    check(
      verification !== null &&
        verification.interventionId === expectation.interventionId &&
        verification.merchantId === expectation.merchantId &&
        verification.payerId === expectation.payerId &&
        verification.subscriptionId === expectation.subscriptionId &&
        verification.selectedDate === expectation.selectedDate &&
        verification.policyVersion === expectation.policyVersion &&
        JSON.stringify(verification.currentPayments) ===
          JSON.stringify(expectation.currentPayments) &&
        JSON.stringify(verification.proposedPayments) ===
          JSON.stringify(expectation.proposedPayments) &&
        verification.consumedAt === null,
      "tv8: every binding must come from the stored intervention",
    );
    check(
      verification !== null &&
        Date.parse(verification.expiresAt) -
          Date.parse(verification.verifiedAt) ===
          REHEARSAL_VERIFICATION_LIFETIME_MINUTES * 60_000,
      "tv8: the expiry must be exactly ten minutes after verifiedAt",
    );
    const storedIntervention = await harness.interventions.readById(
      intervention.interventionId,
    );
    check(
      storedIntervention !== null &&
        JSON.stringify(storedIntervention) === JSON.stringify(intervention),
      "tv8: seeding must not change the stored intervention",
    );
    const again = await seedRehearsalTransactionVerification(
      { token: RAW_TOKEN },
      harness.deps,
    );
    check(
      !again.ok && again.reason === "already-seeded",
      "tv8: a second seed must refuse",
    );
    const kept = await harness.verifications.readVerifiedForIntervention(
      intervention.interventionId,
    );
    check(
      kept !== null &&
        verification !== null &&
        kept.verificationId === verification.verificationId,
      "tv8: the first record must not be replaced or extended",
    );
    record("tv8-seeding-trusted-only", "seeded-once");
  }

  // tv9: seeding refuses unusable states and creates nothing.
  {
    const declined = {
      ...previewReadyIntervention(),
      status: "declined" as const,
      declinedAt: CLOCK_START,
    };
    const declinedHarness = await makeSeedDeps(declined);
    const notSeedable = await seedRehearsalTransactionVerification(
      { token: RAW_TOKEN },
      declinedHarness.deps,
    );
    check(
      !notSeedable.ok && notSeedable.reason === "not-seedable",
      "tv9: a non-preview-ready intervention must refuse seeding",
    );
    check(
      (await declinedHarness.verifications.readVerifiedForIntervention(
        declined.interventionId,
      )) === null,
      "tv9: the refused seed must create nothing",
    );

    const unresolvable = {
      ...previewReadyIntervention(),
      policyVersion: "duelogic-policy-v9",
    };
    const unresolvableHarness = await makeSeedDeps(unresolvable);
    const policyUnresolved = await seedRehearsalTransactionVerification(
      { token: RAW_TOKEN },
      unresolvableHarness.deps,
    );
    check(
      !policyUnresolved.ok && policyUnresolved.reason === "policy-unresolved",
      "tv9: an unresolvable bound policy must refuse seeding",
    );

    const freshHarness = await makeSeedDeps();
    const unknown = await seedRehearsalTransactionVerification(
      { token: "unknown-token" },
      freshHarness.deps,
    );
    check(
      !unknown.ok && unknown.reason === "not-found",
      "tv9: an unknown token must refuse generically",
    );
    record("tv9-seeding-gates", "refused-safely");
  }

  // tv10: browser-supplied identity, schedule, policy or verification
  // fields are rejected at parse, and no record means no claim — the only
  // path to an enabled confirmation is a server-constructed record.
  {
    const rejected: unknown[] = [
      { token: RAW_TOKEN, policyVersion: "duelogic-policy-v9" },
      { token: RAW_TOKEN, merchantId: "mch_other" },
      { token: RAW_TOKEN, payerId: "pyr_other" },
      { token: RAW_TOKEN, subscriptionId: "sub_other" },
      { token: RAW_TOKEN, selectedDate: "2026-08-19" },
      { token: RAW_TOKEN, proposedPayments: [] },
      { token: RAW_TOKEN, amountInCents: 1 },
      { token: RAW_TOKEN, verificationId: "ver_evil" },
      { token: RAW_TOKEN, expiresAt: "2099-01-01T00:00:00.000Z" },
      { token: RAW_TOKEN, consumedAt: null },
      { token: RAW_TOKEN, record: {} },
      {},
      { token: "" },
      "token",
      null,
      [RAW_TOKEN],
    ];
    for (const input of rejected) {
      check(
        parseRehearsalVerificationSeedInput(input) === null,
        "tv10: only the exact { token } body may be accepted",
      );
    }
    check(
      parseRehearsalVerificationSeedInput({ token: RAW_TOKEN }) !== null,
      "tv10: the exact { token } body must be accepted",
    );
    const repository = createInMemoryTransactionVerificationRepository();
    const intervention = previewReadyIntervention();
    const unclaimed = await repository.claimForExecution(
      intervention.interventionId,
      transactionVerificationExpectationFor(intervention),
      makeClock()(),
    );
    check(
      unclaimed === null,
      "tv10: no stored record means no claim — no bypass exists",
    );
    record("tv10-no-bypass", "strict");
  }

  return { scenarioCount: table.length, decisionTable: table };
}

// ---------------------------------------------------------------------------
// Module-load kick-off, mirroring the sibling validation modules: one full
// async pass whose failure is logged loudly; the dashboard render re-asserts
// the table on every request.

void validateTransactionVerification().catch((error: unknown) => {
  console.error("Transaction-verification validation failed at module load.", {
    errorClass: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  });
});
