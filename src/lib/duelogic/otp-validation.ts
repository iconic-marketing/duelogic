/**
 * Deterministic validation of the barebones customer OTP demo path,
 * following the repository's validation convention: the exported async
 * function re-asserts the scenario table on demand, and one pass is
 * kicked off at module load with loud failure logging.
 *
 * Nothing here calls Pinch or reads a clock: repositories, clock, token
 * hasher, secret resolver, code generator, payer-mobile effect and SMS
 * adapter are injected fakes over synthetic identifiers. No live
 * merchant, payer, subscription, plan or source IDs appear, no real
 * token exists, and no scenario invokes confirmation, execution or the
 * protected replacement path.
 *
 * The six scenarios:
 * otp1 a request issues one six-digit challenge (leading zeroes
 *      preserved), stores only the HMAC digest, delivers the plaintext
 *      code only to the separate SMS adapter, returns no code — and a
 *      missing secret or missing mobile fails closed with nothing
 *      created;
 * otp2 an incorrect code refuses (otp-incorrect) creating no
 *      TransactionVerificationRecord and touching no execution state;
 * otp3 an expired code refuses (otp-expired) creating nothing;
 * otp4 a re-request replaces the previous challenge: the first code no
 *      longer verifies, the second does;
 * otp5 the exact code creates exactly one TransactionVerificationRecord,
 *      finalConfirmationEnabled becomes true, and a second use of the
 *      same OTP refuses (otp-already-used) — still exactly one record,
 *      still no execution;
 * otp6 the existing execution gate is untouched: OTP verification never
 *      calls confirmInterventionExecution, generates no operation or
 *      confirmation linkage, the gate opens only through the created
 *      record, and confirmation still requires the existing atomic
 *      single-use claim.
 */

import { createInMemoryInterventionRepository } from "./dev-intervention-store";
import {
  createInMemoryOtpChallengeRepository,
  type OtpChallengeRepository,
} from "./dev-otp-store";
import {
  createInMemoryDevSmsStore,
  type DevSmsDeliveryAdapter,
} from "./dev-sms-store";
import { createInMemoryTransactionVerificationRepository } from "./dev-transaction-verification-store";
import {
  toCustomerInterventionProjection,
  transactionVerificationExpectationFor,
  type DueLogicInterventionRecord,
  type DueLogicInterventionRepository,
} from "./intervention";
import { requireTransactionVerification } from "./intervention-service";
import {
  requestInterventionOtp,
  verifyInterventionOtp,
  OTP_VERIFICATION_LIFETIME_MINUTES,
  type InterventionOtpDeps,
} from "./otp-service";
import { createInMemoryMerchantPolicyRepository } from "./policy/dev-policy-store";
import { DEFAULT_DUELOGIC_POLICY } from "./policy/rules";
import type { ClaimableTransactionVerificationRepository } from "./transaction-verification";
import type { ConfirmedSchedulePayment } from "@/lib/pinch/customer-confirmation";

export interface OtpValidationRow {
  scenario: string;
  outcome: string;
}

export interface OtpValidationResult {
  scenarioCount: number;
  decisionTable: OtpValidationRow[];
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`OTP validation failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Injected deterministic dependencies — synthetic identifiers only

const RAW_TOKEN = "raw-otp-demo-01";
const TEST_SECRET = "otp-validation-test-secret";
const FAKE_MOBILE = "0491570156"; // ACMA-reserved fictional AU mobile.

function fakeHash(raw: string): string {
  return `fakehash:${raw.split("").reverse().join("")}`;
}

function paymentsFrom(dates: readonly string[]): ConfirmedSchedulePayment[] {
  return dates.map((paymentDate) => ({ paymentDate, amountInCents: 12500 }));
}

const CURRENT_DATES = ["2026-08-28", "2026-09-11", "2026-09-25"] as const;
const PROPOSED_DATES = ["2026-09-01", "2026-09-15", "2026-09-29"] as const;

/** A preview-ready, approved, unexpired invitation with no linkage. */
function previewReadyRecord(nowIso: string): DueLogicInterventionRecord {
  return {
    interventionId: "int_otp_demo_01",
    notificationId: "ntf_otp_demo_01",
    tokenHash: fakeHash(RAW_TOKEN),
    merchantId: "mch_demo",
    payerId: "pyr_demo",
    sourceId: "src_demo",
    subscriptionId: "sub_demo_active",
    planId: "pln_demo",
    patternFlagId: "flag_otp_demo",
    policyVersion: DEFAULT_DUELOGIC_POLICY.version,
    scheduleCadence: "fortnightly",
    changeMode: "permanent",
    currentStartDate: "2026-08-28",
    currentPaymentAmountInCents: 12500,
    currentCycleStartDate: "2026-08-25",
    currentCycleEndDate: "2026-09-07",
    suggestedDate: "2026-09-01",
    selectedDate: "2026-09-01",
    offeredAlternativeDate: null,
    policyOutcome: "approved",
    policyReasonCode: "POLICY_APPROVED",
    policyRuleFired: "all-policy-rules-passed",
    policyExplanation: null,
    policyWarnings: [],
    currentPayments: paymentsFrom(CURRENT_DATES),
    proposedPayments: paymentsFrom(PROPOSED_DATES),
    currency: "AUD",
    confirmationId: null,
    operationId: null,
    newSubscriptionId: null,
    status: "preview-ready",
    createdAt: nowIso,
    expiresAt: "2026-08-10T00:00:00.000Z",
    openedAt: nowIso,
    selectedAt: nowIso,
    declinedAt: null,
    updatedAt: nowIso,
  };
}

interface OtpHarness {
  deps: InterventionOtpDeps;
  interventions: DueLogicInterventionRepository;
  verifications: ClaimableTransactionVerificationRepository;
  challenges: OtpChallengeRepository;
  sms: DevSmsDeliveryAdapter;
  advanceMinutes(minutes: number): void;
  now(): string;
}

/**
 * Fresh isolated harness per scenario. `codeNumbers` feeds the injected
 * generator in order (the first default, 7, proves leading-zero
 * formatting: "000007"); overrides model missing secret / mobile.
 */
async function makeOtpHarness(options?: {
  codeNumbers?: number[];
  secret?: string | null;
  mobile?: string | null;
}): Promise<OtpHarness> {
  const interventions = createInMemoryInterventionRepository();
  const verifications = createInMemoryTransactionVerificationRepository();
  const challenges = createInMemoryOtpChallengeRepository();
  const sms = createInMemoryDevSmsStore();
  const policies = createInMemoryMerchantPolicyRepository();

  let currentMs = Date.parse("2026-07-26T00:00:00.000Z");
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
  await interventions.write(previewReadyRecord(now()));

  const codeNumbers = [...(options?.codeNumbers ?? [7, 123456, 654321])];
  let challengeCounter = 0;
  let smsCounter = 0;
  let verificationCounter = 0;

  return {
    interventions,
    verifications,
    challenges,
    sms,
    now,
    advanceMinutes: (minutes: number): void => {
      currentMs += minutes * 60_000;
    },
    deps: {
      interventions,
      verifications,
      policies,
      challenges,
      sms,
      readPayerMobile: async () =>
        options?.mobile === undefined ? FAKE_MOBILE : options.mobile,
      now,
      hashToken: fakeHash,
      otpHmacSecret: () =>
        options?.secret === undefined ? TEST_SECRET : options.secret,
      generateChallengeId: () => {
        challengeCounter += 1;
        return `otpch_demo_${String(challengeCounter).padStart(2, "0")}`;
      },
      generateSmsId: () => {
        smsCounter += 1;
        return `sms_demo_${String(smsCounter).padStart(2, "0")}`;
      },
      generateVerificationId: () => {
        verificationCounter += 1;
        return `ver_demo_${String(verificationCounter).padStart(2, "0")}`;
      },
      generateOtpCodeNumber: () => {
        const next = codeNumbers.shift();
        if (next === undefined) {
          throw new Error("OTP validation exhausted its injected code list.");
        }
        return next;
      },
    },
  };
}

/** The plaintext code from the latest simulated SMS. Test-side only. */
async function latestSmsCode(sms: DevSmsDeliveryAdapter): Promise<string> {
  const messages = await sms.list();
  const body = messages[messages.length - 1]?.body ?? "";
  const match = /\b(\d{6})\b/.exec(body);
  check(match !== null, "fixture: the latest SMS must contain a six-digit code");
  return (match as RegExpExecArray)[1];
}

// ---------------------------------------------------------------------------
// Scenario table

export async function validateOtpFlow(): Promise<OtpValidationResult> {
  const table: OtpValidationRow[] = [];
  const record = (scenario: string, outcome: string): void => {
    table.push({ scenario, outcome });
  };

  // otp1: request creates one challenge (digest only) and one SMS carrying
  // the plaintext six-digit code with leading zeroes preserved; the
  // customer-facing result contains no code. Missing secret and missing
  // mobile fail closed with nothing created.
  {
    const harness = await makeOtpHarness({ codeNumbers: [7] });
    const outcome = await requestInterventionOtp(
      { token: RAW_TOKEN },
      harness.deps,
    );
    check(outcome.ok, "otp1: the request must issue a challenge");
    check(
      outcome.ok && outcome.maskedMobile === "•••• ••• 156",
      "otp1: the masked mobile must show only the last three digits",
    );
    const messages = await harness.sms.list();
    check(
      messages.length === 1 &&
        messages[0].body.includes("000007") &&
        messages[0].maskedRecipient === "•••• ••• 156",
      "otp1: the separate SMS channel must carry the six-digit code with leading zeroes",
    );
    const challenge = await harness.challenges.readCurrent("int_otp_demo_01");
    check(
      challenge !== null &&
        /^[0-9a-f]{64}$/.test(challenge.codeDigest) &&
        challenge.verifiedAt === null &&
        challenge.invalidatedAt === null,
      "otp1: the stored challenge must carry an HMAC digest and a fresh lifecycle",
    );
    check(
      !JSON.stringify(challenge).includes("000007"),
      "otp1: the plaintext code must never be stored in the challenge",
    );
    check(
      !JSON.stringify(outcome).includes("000007"),
      "otp1: the request outcome must never contain the code",
    );
    check(
      !JSON.stringify(challenge).includes(FAKE_MOBILE.slice(1)) &&
        !JSON.stringify(challenge).includes(FAKE_MOBILE),
      "otp1: the complete mobile must never be stored in the challenge",
    );

    // Fail closed: missing secret creates nothing.
    const noSecret = await makeOtpHarness({ secret: null });
    const secretRefusal = await requestInterventionOtp(
      { token: RAW_TOKEN },
      noSecret.deps,
    );
    check(
      !secretRefusal.ok && secretRefusal.reason === "configuration-error",
      "otp1: a missing HMAC secret must fail closed",
    );
    check(
      (await noSecret.challenges.readCurrent("int_otp_demo_01")) === null &&
        (await noSecret.sms.list()).length === 0,
      "otp1: the failed-closed request must create no challenge and no SMS",
    );

    // Fail closed: missing trusted mobile creates nothing.
    const noMobile = await makeOtpHarness({ mobile: null });
    const mobileRefusal = await requestInterventionOtp(
      { token: RAW_TOKEN },
      noMobile.deps,
    );
    check(
      !mobileRefusal.ok && mobileRefusal.reason === "mobile-unavailable",
      "otp1: a missing trusted mobile must fail closed",
    );
    check(
      (await noMobile.challenges.readCurrent("int_otp_demo_01")) === null &&
        (await noMobile.sms.list()).length === 0,
      "otp1: the mobile refusal must create no challenge and no SMS",
    );
    record("otp1-request-issues-challenge-and-sms", "digest-only");
  }

  // otp2: an incorrect code refuses without creating a verification record
  // and without touching confirmation, operation or execution state.
  {
    const harness = await makeOtpHarness({ codeNumbers: [111222] });
    check(
      (await requestInterventionOtp({ token: RAW_TOKEN }, harness.deps)).ok,
      "otp2: the request fixture must issue",
    );
    const wrong = await verifyInterventionOtp(
      { token: RAW_TOKEN, code: "999999" },
      harness.deps,
    );
    check(
      !wrong.ok && wrong.reason === "otp-incorrect",
      "otp2: an incorrect code must refuse as otp-incorrect",
    );
    check(
      (await harness.verifications.readVerifiedForIntervention(
        "int_otp_demo_01",
      )) === null,
      "otp2: no TransactionVerificationRecord may be created",
    );
    const stored = await harness.interventions.readById("int_otp_demo_01");
    check(
      stored !== null &&
        stored.status === "preview-ready" &&
        stored.confirmationId === null &&
        stored.operationId === null &&
        stored.newSubscriptionId === null,
      "otp2: no confirmation, operation or execution state may change",
    );
    record("otp2-incorrect-code-refuses", "otp-incorrect");
  }

  // otp3: an expired code refuses, creating nothing.
  {
    const harness = await makeOtpHarness({ codeNumbers: [222333] });
    check(
      (await requestInterventionOtp({ token: RAW_TOKEN }, harness.deps)).ok,
      "otp3: the request fixture must issue",
    );
    const code = await latestSmsCode(harness.sms);
    harness.advanceMinutes(6); // Past the five-minute challenge lifetime.
    const expired = await verifyInterventionOtp(
      { token: RAW_TOKEN, code },
      harness.deps,
    );
    check(
      !expired.ok && expired.reason === "otp-expired",
      "otp3: an expired code must refuse as otp-expired",
    );
    check(
      (await harness.verifications.readVerifiedForIntervention(
        "int_otp_demo_01",
      )) === null,
      "otp3: no TransactionVerificationRecord may be created for an expired code",
    );
    record("otp3-expired-code-refuses", "otp-expired");
  }

  // otp4: a re-request replaces the previous challenge — the first code no
  // longer verifies, the second one does.
  {
    const harness = await makeOtpHarness({ codeNumbers: [333444, 555666] });
    check(
      (await requestInterventionOtp({ token: RAW_TOKEN }, harness.deps)).ok,
      "otp4: the first request must issue",
    );
    const firstCode = await latestSmsCode(harness.sms);
    check(
      (await requestInterventionOtp({ token: RAW_TOKEN }, harness.deps)).ok,
      "otp4: the second request must issue",
    );
    const secondCode = await latestSmsCode(harness.sms);
    check(
      (await harness.sms.list()).length === 2 && firstCode !== secondCode,
      "otp4: each issue must deliver its own code",
    );
    const replaced = await verifyInterventionOtp(
      { token: RAW_TOKEN, code: firstCode },
      harness.deps,
    );
    check(
      !replaced.ok,
      "otp4: the replaced first code must no longer verify",
    );
    check(
      (await harness.verifications.readVerifiedForIntervention(
        "int_otp_demo_01",
      )) === null,
      "otp4: the replaced code must create nothing",
    );
    const current = await verifyInterventionOtp(
      { token: RAW_TOKEN, code: secondCode },
      harness.deps,
    );
    check(current.ok, "otp4: the current code must verify");
    check(
      (await harness.verifications.readVerifiedForIntervention(
        "int_otp_demo_01",
      )) !== null,
      "otp4: the current code must create the verification record",
    );
    record("otp4-reissue-replaces-previous", "replaced");
  }

  // otp5: the exact code creates exactly one TransactionVerificationRecord
  // (ten-minute lifetime, unconsumed), finalConfirmationEnabled becomes
  // true, and a second use of the same OTP refuses with nothing further
  // created and no execution.
  {
    const harness = await makeOtpHarness({ codeNumbers: [444555] });
    check(
      (await requestInterventionOtp({ token: RAW_TOKEN }, harness.deps)).ok,
      "otp5: the request fixture must issue",
    );
    const code = await latestSmsCode(harness.sms);
    const verified = await verifyInterventionOtp(
      { token: RAW_TOKEN, code },
      harness.deps,
    );
    check(verified.ok, "otp5: the exact code must verify");
    const verification =
      await harness.verifications.readVerifiedForIntervention(
        "int_otp_demo_01",
      );
    check(
      verification !== null &&
        verification.consumedAt === null &&
        Date.parse(verification.expiresAt) -
          Date.parse(verification.verifiedAt) ===
          OTP_VERIFICATION_LIFETIME_MINUTES * 60_000,
      "otp5: exactly one unconsumed ten-minute verification record must exist",
    );
    const stored = (await harness.interventions.readById(
      "int_otp_demo_01",
    )) as DueLogicInterventionRecord;
    check(
      toCustomerInterventionProjection(stored, harness.now(), verification)
        .finalConfirmationEnabled === true,
      "otp5: finalConfirmationEnabled must become true from the created record",
    );
    const reuse = await verifyInterventionOtp(
      { token: RAW_TOKEN, code },
      harness.deps,
    );
    check(
      !reuse.ok && reuse.reason === "otp-already-used",
      "otp5: a second use of the OTP must refuse",
    );
    check(
      JSON.stringify(
        await harness.verifications.readVerifiedForIntervention(
          "int_otp_demo_01",
        ),
      ) === JSON.stringify(verification),
      "otp5: the second use must not create or alter verification records",
    );
    check(
      stored.status === "preview-ready" &&
        stored.confirmationId === null &&
        stored.operationId === null &&
        stored.newSubscriptionId === null,
      "otp5: no execution may occur",
    );
    record("otp5-correct-code-creates-verification-once", "single-use");
  }

  // otp6: the existing execution gate is unchanged. OTP verification never
  // calls confirmInterventionExecution — no operation ID or confirmation
  // record is generated — the gate opens only because the record now
  // exists, and confirmation still requires the existing atomic
  // single-use claim before any execution could ever run.
  {
    const harness = await makeOtpHarness({ codeNumbers: [666777] });
    check(
      (await requestInterventionOtp({ token: RAW_TOKEN }, harness.deps)).ok,
      "otp6: the request fixture must issue",
    );
    const code = await latestSmsCode(harness.sms);
    check(
      (await verifyInterventionOtp({ token: RAW_TOKEN, code }, harness.deps))
        .ok,
      "otp6: the exact code must verify",
    );
    const stored = (await harness.interventions.readById(
      "int_otp_demo_01",
    )) as DueLogicInterventionRecord;
    check(
      stored.status === "preview-ready" &&
        stored.confirmationId === null &&
        stored.operationId === null &&
        stored.newSubscriptionId === null,
      "otp6: OTP verification must generate no operation, confirmation or execution linkage",
    );
    const gate = await requireTransactionVerification(
      { token: RAW_TOKEN },
      {
        repository: harness.interventions,
        verifications: harness.verifications,
        now: harness.now,
        hashToken: fakeHash,
      },
    );
    check(
      gate.ok,
      "otp6: the gate must open only through the created verification record",
    );
    // Confirmation still requires the atomic claim: it succeeds exactly
    // once and is terminal — OTP verification consumed nothing.
    const claimed = await harness.verifications.claimForExecution(
      stored.interventionId,
      transactionVerificationExpectationFor(stored),
      harness.now(),
    );
    check(
      claimed !== null && claimed.consumedAt !== null,
      "otp6: the existing atomic claim must still be required and available",
    );
    const reclaim = await harness.verifications.claimForExecution(
      stored.interventionId,
      transactionVerificationExpectationFor(stored),
      harness.now(),
    );
    check(reclaim === null, "otp6: the claim must remain single-use");
    record("otp6-execution-gate-unchanged", "gate-intact");
  }

  return { scenarioCount: table.length, decisionTable: table };
}

// ---------------------------------------------------------------------------
// Module-load kick-off, mirroring the sibling validation modules.

void validateOtpFlow().catch((error: unknown) => {
  console.error("OTP validation failed at module load.", {
    errorClass: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  });
});
