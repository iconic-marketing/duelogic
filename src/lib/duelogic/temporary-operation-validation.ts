/**
 * Deterministic validation of the protected temporary payment-movement
 * backend, following the repository's validation convention: the exported
 * async function re-asserts the scenario table on demand, and one pass is
 * kicked off at module load with loud failure logging.
 *
 * Nothing here calls Pinch or reads a clock: repositories, clock, token
 * hasher, secret resolver, code generator, payment effects, mobile effect
 * and the mutation effect are injected fakes over synthetic identifiers.
 * No scenario touches the protected permanent path, the live fixture
 * intervention or any live subscription or payment.
 *
 * Scenario map (t-numbers follow the approved stage list):
 * t1  selection binds payment ID, original date, proposed date, amount
 *     and policy version;
 * t2  selection replacement before verification invalidates the earlier
 *     expectation (the old challenge no longer verifies);
 * t3  selection replacement after verification is refused;
 * t4  the temporary OTP challenge contains the temporary binding and the
 *     digest only;
 * t5  a wrong OTP is refused;   t6 an expired OTP is refused;
 * t7  the correct OTP creates a temporary transaction verification;
 * t8  the claim succeeds for an exact match;
 * t9-t12 the claim fails for a different payment ID, date, amount or
 *     policy version;   t13 a consumed verification cannot be re-claimed;
 * t14 the temporary confirmation records the exact accepted values;
 * t15 a confirmation cannot be consumed twice;
 * t16-t18 preflight refuses when the live status is not scheduled, the
 *     authoritative date differs, or the authoritative amount differs —
 *     all without consuming the verification;
 * t19 the mutation is invoked exactly once;   t20 no retry occurs after
 *     an ambiguous mutation;
 * t21 read-back verifies the unchanged payment ID;   t22 read-back is
 *     authoritative for the persisted transactionDate;
 * t23 a verified movement writes confirmationId and operationId;
 * t24 temporary execution never populates newSubscriptionId;
 * t25 a verified movement sets the intervention to executed;
 * t26 a refused movement does not count towards usage;   t27 an
 *     ambiguous unverified movement does not count;   t28 a verified
 *     movement counts towards rolling usage;
 * t29 the rolling lower boundary is exclusive;   t30 the rolling upper
 *     boundary is inclusive;
 * t31 a third temporary movement escalates after two verified movements;
 * t35 completed permanent intervention rendering is unchanged.
 * (t32-t34 — the permanent verification, confirmation and replacement
 * suites — run unchanged as their own modules, re-asserted per dashboard
 * render.)
 */

import { createInMemoryInterventionRepository } from "./dev-intervention-store";
import { createInMemoryOtpChallengeRepository } from "./dev-otp-store";
import { createInMemoryDevSmsStore } from "./dev-sms-store";
import {
  createInMemoryTemporaryConfirmationRepository,
  createInMemoryTemporaryOperationRepository,
  createInMemoryTemporarySelectionRepository,
  createInMemoryTemporaryVerificationRepository,
} from "./dev-temporary-operation-store";
import {
  toCustomerInterventionProjection,
  toMerchantInterventionProjection,
  type DueLogicInterventionRecord,
} from "./intervention";
import {
  evaluateScheduleChange,
  type TemporaryPolicyEvaluationRequest,
} from "./policy/engine";
import { createInMemoryMerchantPolicyRepository } from "./policy/dev-policy-store";
import { DEFAULT_DUELOGIC_POLICY } from "./policy/rules";
import {
  temporaryVerificationExpectationFor,
  toTemporaryPriorScheduleChanges,
  type TemporaryPaymentOperationRecord,
} from "./temporary-operation";
import {
  evaluateAndBindTemporarySelection,
  executeTemporaryPaymentChange,
  requestTemporaryOtp,
  verifyTemporaryOtp,
  type TemporaryJourneyDeps,
} from "./temporary-execution-service";
import type { AuthoritativePaymentSnapshot } from "@/lib/pinch/payment-movement";

export interface TemporaryOperationValidationRow {
  scenario: string;
  outcome: string;
}

export interface TemporaryOperationValidationResult {
  scenarioCount: number;
  decisionTable: TemporaryOperationValidationRow[];
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Temporary-operation validation failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Injected deterministic dependencies — synthetic identifiers only

const TEMP_TOKEN = "raw-temp-demo-01";
const TEST_SECRET = "temporary-validation-test-secret";
const FAKE_MOBILE = "0491570156"; // ACMA-reserved fictional AU mobile.

function fakeHash(raw: string): string {
  return `fakehash:${raw.split("").reverse().join("")}`;
}

/** Preview-ready invitation with no execution linkage. */
function temporaryFixtureIntervention(
  nowIso: string,
): DueLogicInterventionRecord {
  return {
    interventionId: "int_temp_demo_01",
    notificationId: "ntf_temp_demo_01",
    tokenHash: fakeHash(TEMP_TOKEN),
    merchantId: "mch_demo",
    payerId: "pyr_demo",
    sourceId: "src_demo",
    subscriptionId: "sub_demo_active",
    planId: "pln_demo",
    patternFlagId: "flag_temp_demo",
    policyVersion: DEFAULT_DUELOGIC_POLICY.version,
    scheduleCadence: "fortnightly",
    changeMode: "permanent",
    currentStartDate: "2026-08-10",
    currentPaymentAmountInCents: 12500,
    currentCycleStartDate: "2026-08-04",
    currentCycleEndDate: "2026-08-17",
    suggestedDate: "2026-08-12",
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
    status: "preview-ready",
    createdAt: nowIso,
    expiresAt: "2026-09-01T00:00:00.000Z",
    openedAt: nowIso,
    selectedAt: null,
    declinedAt: null,
    updatedAt: nowIso,
  };
}

type UpdateBehaviour = "apply" | "reject" | "throw" | "silent-ok";

interface TemporaryHarness {
  deps: TemporaryJourneyDeps;
  interventions: ReturnType<typeof createInMemoryInterventionRepository>;
  selections: ReturnType<typeof createInMemoryTemporarySelectionRepository>;
  verifications: ReturnType<
    typeof createInMemoryTemporaryVerificationRepository
  >;
  confirmations: ReturnType<
    typeof createInMemoryTemporaryConfirmationRepository
  >;
  operations: ReturnType<typeof createInMemoryTemporaryOperationRepository>;
  sms: ReturnType<typeof createInMemoryDevSmsStore>;
  payment: AuthoritativePaymentSnapshot;
  updateCalls(): number;
  setUpdateBehaviour(behaviour: UpdateBehaviour): void;
  advanceMinutes(minutes: number): void;
  now(): string;
}

/**
 * Fresh isolated harness. The fake payment starts scheduled on
 * 2026-08-10 at 12,500 cents; the clock starts on 2026-08-01 (Sydney), so
 * the five-day window is 2026-08-11..2026-08-15.
 */
async function makeTemporaryHarness(options?: {
  codeNumbers?: number[];
  arrearsCents?: number;
  paymentAmountInCents?: number;
}): Promise<TemporaryHarness> {
  const interventions = createInMemoryInterventionRepository();
  const selections = createInMemoryTemporarySelectionRepository();
  const verifications = createInMemoryTemporaryVerificationRepository();
  const confirmations = createInMemoryTemporaryConfirmationRepository();
  const operations = createInMemoryTemporaryOperationRepository();
  const challenges = createInMemoryOtpChallengeRepository();
  const sms = createInMemoryDevSmsStore();
  const policies = createInMemoryMerchantPolicyRepository();

  let currentMs = Date.parse("2026-08-01T00:00:00.000Z");
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
  await interventions.write(temporaryFixtureIntervention(now()));

  const payment: AuthoritativePaymentSnapshot = {
    id: "pmt_demo_01",
    payerId: "pyr_demo",
    amountInCents: options?.paymentAmountInCents ?? 12500,
    transactionDate: "2026-08-10",
    status: "scheduled",
  };

  let behaviour: UpdateBehaviour = "apply";
  let updateCallCount = 0;
  const codeNumbers = [...(options?.codeNumbers ?? [111222, 333444, 555666])];
  let idCounter = 0;
  const nextId = (prefix: string): string => {
    idCounter += 1;
    return `${prefix}_demo_${String(idCounter).padStart(2, "0")}`;
  };

  return {
    interventions,
    selections,
    verifications,
    confirmations,
    operations,
    sms,
    payment,
    updateCalls: () => updateCallCount,
    setUpdateBehaviour: (next: UpdateBehaviour): void => {
      behaviour = next;
    },
    advanceMinutes: (minutes: number): void => {
      currentMs += minutes * 60_000;
    },
    now,
    deps: {
      interventions,
      selections,
      temporaryVerifications: verifications,
      temporaryConfirmations: confirmations,
      temporaryOperations: operations,
      policies,
      challenges,
      sms,
      readUpcomingScheduledPayment: async () => structuredClone(payment),
      readPayment: async () => structuredClone(payment),
      updatePaymentDate: async (_merchantId, body) => {
        updateCallCount += 1;
        if (behaviour === "throw") {
          throw new Error("SimulatedUnknownOutcome");
        }
        if (behaviour === "reject") {
          return "rejected";
        }
        if (behaviour === "apply") {
          payment.transactionDate = body.transactionDate;
        }
        return "ok";
      },
      readPayerMobile: async () => FAKE_MOBILE,
      currentArrearsCents: () => options?.arrearsCents ?? 0,
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
          throw new Error(
            "Temporary validation exhausted its injected code list.",
          );
        }
        return next;
      },
    },
  };
}

/** The plaintext code from the latest simulated SMS. Test-side only. */
async function latestSmsCode(harness: TemporaryHarness): Promise<string> {
  const messages = await harness.sms.list();
  const body = messages[messages.length - 1]?.body ?? "";
  const match = /\b(\d{6})\b/.exec(body);
  check(match !== null, "fixture: the latest SMS must contain a six-digit code");
  return (match as RegExpExecArray)[1];
}

/** Bind an approved in-window date. */
async function bindApproved(
  harness: TemporaryHarness,
  requestedDate: string,
): Promise<void> {
  const outcome = await evaluateAndBindTemporarySelection(
    { token: TEMP_TOKEN, requestedDate },
    harness.deps,
  );
  check(outcome.ok, `fixture: binding ${requestedDate} must be approved`);
}

/** Bind, request the OTP and verify it — the verified-and-ready state. */
async function bindAndVerify(
  harness: TemporaryHarness,
  requestedDate: string,
): Promise<void> {
  await bindApproved(harness, requestedDate);
  const requested = await requestTemporaryOtp(
    { token: TEMP_TOKEN },
    harness.deps,
  );
  check(requested.ok, "fixture: the temporary OTP request must issue");
  const code = await latestSmsCode(harness);
  const verified = await verifyTemporaryOtp(
    { token: TEMP_TOKEN, code },
    harness.deps,
  );
  check(verified.ok, "fixture: the temporary OTP must verify");
}

/** A crafted verified operation record for usage-history scenarios. */
function syntheticVerifiedOperation(
  operationId: string,
  verifiedAtIso: string,
  overrides: Partial<TemporaryPaymentOperationRecord> = {},
): TemporaryPaymentOperationRecord {
  return {
    operationId,
    interventionId: `int_hist_${operationId}`,
    confirmationId: `tconf_hist_${operationId}`,
    merchantId: "mch_demo",
    payerId: "pyr_demo",
    paymentId: "pmt_demo_hist",
    originalTransactionDate: "2026-05-10",
    proposedTransactionDate: "2026-05-12",
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
    verifiedTransactionDate: "2026-05-12",
    ...overrides,
  };
}

/** Engine request used for direct boundary assertions. */
function boundaryTemporaryRequest(
  overrides: Partial<TemporaryPolicyEvaluationRequest> = {},
): TemporaryPolicyEvaluationRequest {
  return {
    changeType: "temporary",
    payerId: "pyr_demo",
    paymentId: "pmt_demo_01",
    amountCents: 12500,
    currentArrearsCents: 0,
    evaluationDate: "2026-08-01",
    currentPaymentDate: "2026-08-10",
    requestedDate: "2026-08-12",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scenario table

export async function validateTemporaryOperations(): Promise<TemporaryOperationValidationResult> {
  const table: TemporaryOperationValidationRow[] = [];
  const record = (scenario: string, outcome: string): void => {
    table.push({ scenario, outcome });
  };

  // t1: the approved selection binds the exact payment identity and state.
  {
    const harness = await makeTemporaryHarness();
    const outcome = await evaluateAndBindTemporarySelection(
      { token: TEMP_TOKEN, requestedDate: "2026-08-12" },
      harness.deps,
    );
    check(outcome.ok, "t1: an in-window later date must bind");
    const selection = await harness.selections.readActive("int_temp_demo_01");
    check(
      selection !== null &&
        selection.kind === "temporary" &&
        selection.paymentId === "pmt_demo_01" &&
        selection.originalTransactionDate === "2026-08-10" &&
        selection.proposedTransactionDate === "2026-08-12" &&
        selection.amountInCents === 12500 &&
        selection.policyVersion === DEFAULT_DUELOGIC_POLICY.version,
      "t1: the selection must bind payment ID, dates, amount and policy version",
    );
    record("t1-selection-binds-exact-operation", "bound");
  }

  // t2: replacing the selection before verification invalidates the
  // earlier expectation — the earlier challenge's code no longer verifies.
  {
    const harness = await makeTemporaryHarness();
    await bindApproved(harness, "2026-08-12");
    check(
      (await requestTemporaryOtp({ token: TEMP_TOKEN }, harness.deps)).ok,
      "t2: the first OTP must issue",
    );
    const firstCode = await latestSmsCode(harness);
    await bindApproved(harness, "2026-08-13"); // replaces the selection
    const stale = await verifyTemporaryOtp(
      { token: TEMP_TOKEN, code: firstCode },
      harness.deps,
    );
    check(
      !stale.ok && stale.reason === "otp-mismatch",
      "t2: the earlier challenge must no longer verify after replacement",
    );
    check(
      (await harness.verifications.readForIntervention("int_temp_demo_01")) ===
        null,
      "t2: no verification may be created from the stale challenge",
    );
    record("t2-replacement-invalidates-expectation", "invalidated");
  }

  // t3: replacing the selection after verification is refused.
  {
    const harness = await makeTemporaryHarness();
    await bindAndVerify(harness, "2026-08-12");
    const replace = await evaluateAndBindTemporarySelection(
      { token: TEMP_TOKEN, requestedDate: "2026-08-13" },
      harness.deps,
    );
    check(
      !replace.ok && replace.reason === "verification-active",
      "t3: re-binding after verification must be refused",
    );
    record("t3-replacement-after-verification-refused", "immutable");
  }

  // t4: the temporary challenge carries the temporary binding, digest only.
  {
    const harness = await makeTemporaryHarness({ codeNumbers: [7] });
    await bindApproved(harness, "2026-08-12");
    check(
      (await requestTemporaryOtp({ token: TEMP_TOKEN }, harness.deps)).ok,
      "t4: the OTP must issue",
    );
    const challenge = await harness.deps.challenges.readCurrent(
      "int_temp_demo_01",
    );
    check(
      challenge !== null &&
        challenge.kind === "temporary" &&
        challenge.paymentId === "pmt_demo_01" &&
        challenge.originalTransactionDate === "2026-08-10" &&
        challenge.proposedTransactionDate === "2026-08-12" &&
        challenge.amountInCents === 12500 &&
        /^[0-9a-f]{64}$/.test(challenge.codeDigest),
      "t4: the challenge must carry the temporary binding and an HMAC digest",
    );
    check(
      !JSON.stringify(challenge).includes("000007"),
      "t4: the plaintext code must never be stored",
    );
    const messages = await harness.sms.list();
    check(
      messages.length === 1 && messages[0].body.includes("000007"),
      "t4: the separate SMS channel must carry the six-digit code",
    );
    record("t4-temporary-challenge-binding", "digest-only");
  }

  // t5 + t6: wrong and expired codes refuse.
  {
    const harness = await makeTemporaryHarness();
    await bindApproved(harness, "2026-08-12");
    check(
      (await requestTemporaryOtp({ token: TEMP_TOKEN }, harness.deps)).ok,
      "t5: the OTP must issue",
    );
    const wrong = await verifyTemporaryOtp(
      { token: TEMP_TOKEN, code: "999999" },
      harness.deps,
    );
    check(
      !wrong.ok && wrong.reason === "otp-incorrect",
      "t5: a wrong code must refuse",
    );
    record("t5-wrong-otp-refused", "otp-incorrect");

    const code = await latestSmsCode(harness);
    harness.advanceMinutes(6);
    const expired = await verifyTemporaryOtp(
      { token: TEMP_TOKEN, code },
      harness.deps,
    );
    check(
      !expired.ok && expired.reason === "otp-expired",
      "t6: an expired code must refuse",
    );
    check(
      (await harness.verifications.readForIntervention("int_temp_demo_01")) ===
        null,
      "t6: no verification may exist after refusals",
    );
    record("t6-expired-otp-refused", "otp-expired");
  }

  // t7: the correct code creates the temporary transaction verification.
  {
    const harness = await makeTemporaryHarness();
    await bindAndVerify(harness, "2026-08-12");
    const verification = await harness.verifications.readForIntervention(
      "int_temp_demo_01",
    );
    check(
      verification !== null &&
        verification.kind === "temporary" &&
        verification.paymentId === "pmt_demo_01" &&
        verification.originalTransactionDate === "2026-08-10" &&
        verification.proposedTransactionDate === "2026-08-12" &&
        verification.amountInCents === 12500 &&
        verification.consumedAt === null &&
        Date.parse(verification.expiresAt) -
          Date.parse(verification.verifiedAt) ===
          10 * 60_000,
      "t7: the correct code must create the exact ten-minute temporary verification",
    );
    record("t7-correct-otp-creates-verification", "created");
  }

  // t8-t13: claim binding matrix and single-use.
  {
    const harness = await makeTemporaryHarness();
    await bindAndVerify(harness, "2026-08-12");
    const selection = await harness.selections.readActive("int_temp_demo_01");
    check(selection !== null, "t8 fixture: the bound selection must resolve");
    const expectation = temporaryVerificationExpectationFor(
      selection as NonNullable<typeof selection>,
    );

    const wrongPayment = await harness.verifications.claimForExecution(
      "int_temp_demo_01",
      { ...expectation, paymentId: "pmt_demo_99" },
      harness.now(),
    );
    check(wrongPayment === null, "t9: a different payment ID must not claim");
    const wrongDate = await harness.verifications.claimForExecution(
      "int_temp_demo_01",
      { ...expectation, proposedTransactionDate: "2026-08-14" },
      harness.now(),
    );
    check(wrongDate === null, "t10: a different date must not claim");
    const wrongAmount = await harness.verifications.claimForExecution(
      "int_temp_demo_01",
      { ...expectation, amountInCents: 99999 },
      harness.now(),
    );
    check(wrongAmount === null, "t11: a different amount must not claim");
    const wrongPolicy = await harness.verifications.claimForExecution(
      "int_temp_demo_01",
      { ...expectation, policyVersion: "duelogic-policy-v9" },
      harness.now(),
    );
    check(wrongPolicy === null, "t12: a different policy version must not claim");
    record("t9-t12-claim-binding-mismatches-refuse", "refused");

    const claimed = await harness.verifications.claimForExecution(
      "int_temp_demo_01",
      expectation,
      harness.now(),
    );
    check(
      claimed !== null && claimed.consumedAt !== null,
      "t8: an exact-match claim must succeed and consume",
    );
    record("t8-exact-claim-succeeds", "claimed");

    const reclaim = await harness.verifications.claimForExecution(
      "int_temp_demo_01",
      expectation,
      harness.now(),
    );
    check(reclaim === null, "t13: a consumed verification must not re-claim");
    record("t13-consumed-claim-refused", "single-use");
  }

  // t14 + t15 + t19 + t21-t25: the complete verified execution.
  {
    const harness = await makeTemporaryHarness();
    await bindAndVerify(harness, "2026-08-12");
    const outcome = await executeTemporaryPaymentChange(
      { token: TEMP_TOKEN },
      harness.deps,
    );
    check(outcome.ok, "t19: the protected execution must verify");
    check(
      harness.updateCalls() === 1,
      "t19: the mutation must be invoked exactly once",
    );
    record("t19-mutation-invoked-exactly-once", "once");

    check(
      harness.payment.id === "pmt_demo_01" &&
        harness.payment.transactionDate === "2026-08-12",
      "t21/t22: the read-back state must show the unchanged ID and persisted date",
    );
    record("t21-read-back-verifies-payment-id", "unchanged");
    record("t22-read-back-verifies-transaction-date", "persisted");

    const executed = outcome.ok ? outcome.record : null;
    check(
      executed !== null &&
        executed.status === "executed" &&
        executed.confirmationId !== null &&
        executed.operationId !== null &&
        executed.executedMovementKind === "temporary" &&
        executed.verifiedTemporaryTransactionDate === "2026-08-12",
      "t23/t25: the verified movement must write linkage and set executed",
    );
    check(
      executed !== null && executed.newSubscriptionId === null,
      "t24: temporary execution must never populate newSubscriptionId",
    );
    record("t23-linkage-written", "linked");
    record("t24-no-new-subscription-id", "null");
    record("t25-intervention-executed", "executed");

    const operation = outcome.ok ? outcome.operation : null;
    check(
      operation !== null &&
        operation.status === "temporary-change-verified" &&
        operation.readBackState === "verified" &&
        operation.verifiedTransactionDate === "2026-08-12",
      "t19: the operation evidence must record the verified read-back",
    );
    const confirmation = await harness.confirmations.readById(
      (operation as TemporaryPaymentOperationRecord).confirmationId,
    );
    check(
      confirmation !== null &&
        confirmation.status === "consumed" &&
        confirmation.paymentId === "pmt_demo_01" &&
        confirmation.originalTransactionDate === "2026-08-10" &&
        confirmation.confirmedTransactionDate === "2026-08-12" &&
        confirmation.amountInCents === 12500 &&
        confirmation.operationId ===
          (operation as TemporaryPaymentOperationRecord).operationId,
      "t14: the confirmation must record the exact accepted movement",
    );
    record("t14-confirmation-records-exact-values", "recorded");

    const reconsume = await harness.confirmations.consume(
      (operation as TemporaryPaymentOperationRecord).confirmationId,
      "top_demo_other",
      harness.now(),
    );
    check(reconsume === null, "t15: a confirmation must not consume twice");
    record("t15-confirmation-single-use", "single-use");

    // t28: the verified movement counts towards rolling usage.
    const derived = toTemporaryPriorScheduleChanges(
      await harness.operations.list(),
      "pyr_demo",
      "mch_demo",
      "Australia/Sydney",
    );
    check(
      derived.length === 1 &&
        derived[0].changeType === "temporary" &&
        derived[0].status === "executed-verified",
      "t28: the verified movement must derive one executed-verified entry",
    );
    record("t28-verified-counts-towards-usage", "counted");
  }

  // t16-t18: preflight refusals leave the verification unconsumed and
  // never invoke the mutation.
  {
    const notScheduled = await makeTemporaryHarness();
    await bindAndVerify(notScheduled, "2026-08-12");
    notScheduled.payment.status = "approved";
    const refusedStatus = await executeTemporaryPaymentChange(
      { token: TEMP_TOKEN },
      notScheduled.deps,
    );
    check(
      !refusedStatus.ok && refusedStatus.reason === "payment-not-scheduled",
      "t16: a non-scheduled live payment must refuse",
    );
    check(
      notScheduled.updateCalls() === 0,
      "t16: no mutation may be invoked on refusal",
    );
    const unconsumed = await notScheduled.verifications.readForIntervention(
      "int_temp_demo_01",
    );
    check(
      unconsumed !== null && unconsumed.consumedAt === null,
      "t16: a pre-claim refusal must not consume the verification",
    );
    record("t16-preflight-status-refusal", "refused");

    const dateDrift = await makeTemporaryHarness();
    await bindAndVerify(dateDrift, "2026-08-12");
    dateDrift.payment.transactionDate = "2026-08-11";
    const refusedDate = await executeTemporaryPaymentChange(
      { token: TEMP_TOKEN },
      dateDrift.deps,
    );
    check(
      !refusedDate.ok &&
        refusedDate.reason === "payment-mismatch" &&
        dateDrift.updateCalls() === 0,
      "t17: an authoritative date drift must refuse without mutation",
    );
    record("t17-preflight-date-refusal", "refused");

    const amountDrift = await makeTemporaryHarness();
    await bindAndVerify(amountDrift, "2026-08-12");
    amountDrift.payment.amountInCents = 13000;
    const refusedAmount = await executeTemporaryPaymentChange(
      { token: TEMP_TOKEN },
      amountDrift.deps,
    );
    check(
      !refusedAmount.ok &&
        refusedAmount.reason === "payment-mismatch" &&
        amountDrift.updateCalls() === 0,
      "t18: an authoritative amount drift must refuse without mutation",
    );
    record("t18-preflight-amount-refusal", "refused");

    // t26: refusals never count towards usage.
    const derived = toTemporaryPriorScheduleChanges(
      await amountDrift.operations.list(),
      "pyr_demo",
      "mch_demo",
      "Australia/Sydney",
    );
    check(derived.length === 0, "t26: a refused movement must not count");
    record("t26-refused-does-not-count", "not-counted");
  }

  // t20 + t27: ambiguous outcomes never retry and never count.
  {
    const harness = await makeTemporaryHarness();
    await bindAndVerify(harness, "2026-08-12");
    harness.setUpdateBehaviour("throw");
    const outcome = await executeTemporaryPaymentChange(
      { token: TEMP_TOKEN },
      harness.deps,
    );
    check(
      !outcome.ok && outcome.reason === "temporary-change-ambiguous",
      "t20: an unknown mutation outcome must classify as ambiguous",
    );
    check(
      harness.updateCalls() === 1,
      "t20: no retry may occur after an ambiguous mutation",
    );
    const operations = await harness.operations.list();
    check(
      operations.length === 1 &&
        operations[0].status === "temporary-change-ambiguous" &&
        operations[0].mutationState === "invoked",
      "t20: the ambiguous evidence must be retained",
    );
    check(
      toTemporaryPriorScheduleChanges(
        operations,
        "pyr_demo",
        "mch_demo",
        "Australia/Sydney",
      ).length === 0,
      "t27: an ambiguous unverified movement must not count",
    );
    record("t20-no-retry-after-ambiguous", "no-retry");
    record("t27-ambiguous-does-not-count", "not-counted");

    // Read-back authority: an "ok" response that did not persist stays
    // ambiguous rather than trusting the mutation response.
    const silent = await makeTemporaryHarness();
    await bindAndVerify(silent, "2026-08-12");
    silent.setUpdateBehaviour("silent-ok");
    const silentOutcome = await executeTemporaryPaymentChange(
      { token: TEMP_TOKEN },
      silent.deps,
    );
    check(
      !silentOutcome.ok &&
        silentOutcome.reason === "temporary-change-ambiguous",
      "t22: the read-back, not the mutation response, must be authoritative",
    );
  }

  // t29 + t30: the approved rolling-window boundary over derived history.
  {
    // Evaluation date 2026-08-01 → exclusive lower boundary 2025-08-01.
    const onBoundary = toTemporaryPriorScheduleChanges(
      [
        // 2025-08-01T02:00Z is 2025-08-01 in Sydney — exactly the boundary.
        syntheticVerifiedOperation("top_hist_a", "2025-08-01T02:00:00.000Z"),
      ],
      "pyr_demo",
      "mch_demo",
      "Australia/Sydney",
    );
    const boundaryDecision = evaluateScheduleChange(
      boundaryTemporaryRequest(),
      onBoundary,
      DEFAULT_DUELOGIC_POLICY,
    );
    check(
      boundaryDecision.outcome === "approved" &&
        boundaryDecision.usage.verifiedUsesInPeriod === 0,
      "t29: a movement dated exactly 12 months earlier must not count",
    );
    const insideWindow = toTemporaryPriorScheduleChanges(
      [syntheticVerifiedOperation("top_hist_b", "2025-08-02T02:00:00.000Z")],
      "pyr_demo",
      "mch_demo",
      "Australia/Sydney",
    );
    const insideDecision = evaluateScheduleChange(
      boundaryTemporaryRequest(),
      insideWindow,
      DEFAULT_DUELOGIC_POLICY,
    );
    check(
      insideDecision.outcome === "approved" &&
        insideDecision.usage.verifiedUsesInPeriod === 1,
      "t29: one day inside the lower boundary must count",
    );
    record("t29-lower-boundary-exclusive", "engine-exact");

    // Upper boundary inclusive: verified on the evaluation date counts.
    const sameDay = toTemporaryPriorScheduleChanges(
      [syntheticVerifiedOperation("top_hist_c", "2026-08-01T02:00:00.000Z")],
      "pyr_demo",
      "mch_demo",
      "Australia/Sydney",
    );
    const sameDayDecision = evaluateScheduleChange(
      boundaryTemporaryRequest(),
      sameDay,
      DEFAULT_DUELOGIC_POLICY,
    );
    check(
      sameDayDecision.usage.verifiedUsesInPeriod === 1,
      "t30: a movement verified on the evaluation date must count immediately",
    );
    record("t30-upper-boundary-inclusive", "engine-exact");
  }

  // t31: a third temporary movement escalates after two verified ones —
  // through the real binding path, so the derived history feeds the
  // engine exactly as production would.
  {
    const harness = await makeTemporaryHarness();
    await harness.operations.write(
      syntheticVerifiedOperation("top_hist_one", "2026-06-01T02:00:00.000Z"),
    );
    await harness.operations.write(
      syntheticVerifiedOperation("top_hist_two", "2026-07-01T02:00:00.000Z"),
    );
    const third = await evaluateAndBindTemporarySelection(
      { token: TEMP_TOKEN, requestedDate: "2026-08-12" },
      harness.deps,
    );
    check(
      !third.ok &&
        third.reason === "merchant-review-required" &&
        third.policyReasonCode === "TEMPORARY_CHANGE_LIMIT_REACHED",
      "t31: the third movement must escalate to merchant review",
    );
    record("t31-third-movement-escalates", "merchant-review-required");
  }

  // t35: completed permanent intervention rendering is unchanged by the
  // optional movement-kind fields (absent on permanent records).
  {
    const nowIso = "2026-08-01T00:00:10.000Z";
    const permanentExecuted: DueLogicInterventionRecord = {
      ...temporaryFixtureIntervention(nowIso),
      interventionId: "int_perm_demo_01",
      tokenHash: fakeHash("raw-perm-demo-01"),
      selectedDate: "2026-08-12",
      policyOutcome: "approved",
      policyReasonCode: "POLICY_APPROVED",
      policyRuleFired: "all-policy-rules-passed",
      currentPayments: [
        { paymentDate: "2026-08-10", amountInCents: 12500 },
        { paymentDate: "2026-08-24", amountInCents: 12500 },
        { paymentDate: "2026-09-07", amountInCents: 12500 },
      ],
      proposedPayments: [
        { paymentDate: "2026-08-12", amountInCents: 12500 },
        { paymentDate: "2026-08-26", amountInCents: 12500 },
        { paymentDate: "2026-09-09", amountInCents: 12500 },
      ],
      confirmationId: "conf_demo_01",
      operationId: "op_demo_01",
      newSubscriptionId: "sub_demo_replacement",
      status: "executed",
    };
    const merchantView = toMerchantInterventionProjection(
      permanentExecuted,
      nowIso,
    );
    const customerView = toCustomerInterventionProjection(
      permanentExecuted,
      nowIso,
    );
    check(
      merchantView.status === "executed" &&
        merchantView.newSubscriptionId === "sub_demo_replacement" &&
        merchantView.confirmationId === "conf_demo_01" &&
        merchantView.operationId === "op_demo_01",
      "t35: the merchant projection of a completed permanent intervention is unchanged",
    );
    check(
      customerView.status === "executed" &&
        customerView.finalConfirmationEnabled === false &&
        customerView.proposedPayments !== null,
      "t35: the customer projection of a completed permanent intervention is unchanged",
    );
    record("t35-permanent-rendering-unchanged", "unchanged");
  }

  return { scenarioCount: table.length, decisionTable: table };
}

// ---------------------------------------------------------------------------
// Module-load kick-off, mirroring the sibling validation modules.

void validateTemporaryOperations().catch((error: unknown) => {
  console.error("Temporary-operation validation failed at module load.", {
    errorClass: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  });
});
