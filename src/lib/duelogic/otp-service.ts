/**
 * Barebones customer OTP verification service (hackathon demo path):
 * request a six-digit code delivered to the SEPARATE simulated SMS
 * channel, then verify the entered code and — on success — create the
 * EXISTING TransactionVerificationRecord through the existing write-once
 * repository contract. Nothing here confirms, executes, claims or calls
 * any mutating Pinch endpoint: the atomic verification claim, the
 * confirmation route, confirmInterventionExecution and the protected
 * replacement path all remain completely unchanged, and final
 * confirmation remains a separate customer action.
 *
 * Every function takes injected dependencies (repositories, clock, token
 * hasher, secret resolver, code generator, read-only payer-mobile
 * effect, SMS adapter), so the deterministic OTP validation drives these
 * exact code paths with fakes and no network access. The dev routes
 * supply the real implementations; the payer-mobile effect is a Pinch
 * GET only.
 *
 * Secret handling: the HMAC secret is resolved by the injected provider
 * at request execution time (the routes read DUELOGIC_OTP_HMAC_SECRET);
 * a missing secret fails closed with "configuration-error" and the
 * secret is never logged, stored or returned. The plaintext code exists
 * transiently inside this service for delivery only: it reaches the
 * challenge store as an HMAC digest and the customer only through the
 * simulated SMS channel — never through a customer-facing API response.
 *
 * Barebones scope (tonight): no attempt limits, no resend delay, no
 * issue caps — a new request replaces the intervention's previous
 * challenge and the replaced code can no longer verify. The full
 * approved control set remains polishing-week work.
 */

import { randomInt, randomUUID } from "node:crypto";
import {
  effectiveInterventionStatus,
  transactionVerificationExpectationFor,
  type DueLogicInterventionRecord,
  type DueLogicInterventionRepository,
} from "./intervention";
import {
  computeOtpCodeDigest,
  computeTrustedMobileFingerprint,
  formatOtpCode,
  maskNormalisedMobile,
  normaliseAustralianMobile,
  OTP_CHALLENGE_LIFETIME_MINUTES,
  type OtpChallengeExpectation,
  type OtpChallengeRecord,
} from "./otp-challenge";
import type { OtpChallengeRepository } from "./dev-otp-store";
import type { DevSmsDeliveryAdapter, DevSmsMessage } from "./dev-sms-store";
import type {
  MerchantPolicyRepository,
  MerchantPolicySnapshot,
} from "./policy/policy-snapshot";
import {
  evaluateTransactionVerification,
  type ClaimableTransactionVerificationRepository,
  type TransactionVerificationRecord,
} from "./transaction-verification";

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts.
if (typeof window !== "undefined") {
  throw new Error(
    "The OTP service is server-only and must not be imported into browser code.",
  );
}

/**
 * The TransactionVerificationRecord a successful OTP creates lasts ten
 * minutes — the same lifetime the controlled rehearsal seeding used, so
 * the confirmation window is unchanged.
 */
export const OTP_VERIFICATION_LIFETIME_MINUTES = 10;

export interface InterventionOtpDeps {
  interventions: DueLogicInterventionRepository;
  verifications: ClaimableTransactionVerificationRepository;
  /** Resolves the intervention-bound policy snapshot — never the active one. */
  policies: MerchantPolicyRepository;
  challenges: OtpChallengeRepository;
  sms: DevSmsDeliveryAdapter;
  /** Read-only payer-mobile effect (Pinch GET in the route; a fake in validation). */
  readPayerMobile(merchantId: string, payerId: string): Promise<string | null>;
  now(): string;
  hashToken(rawToken: string): string;
  /** Resolved at execution time; null fails closed. Never logged or returned. */
  otpHmacSecret(): string | null;
  generateChallengeId(): string;
  generateSmsId(): string;
  generateVerificationId(): string;
  /** Returns an integer 0..999999; injectable for deterministic validation. */
  generateOtpCodeNumber(): number;
}

export type RequestInterventionOtpOutcome =
  | {
      ok: true;
      record: DueLogicInterventionRecord;
      maskedMobile: string;
      challengeExpiresAt: string;
    }
  | {
      ok: false;
      reason:
        | "not-found"
        | "otp-not-eligible"
        | "policy-unresolved"
        | "mobile-unavailable"
        | "mobile-invalid"
        | "configuration-error"
        | "store-failed"
        | "delivery-failed";
      record?: DueLogicInterventionRecord;
    };

export type VerifyInterventionOtpOutcome =
  | {
      ok: true;
      record: DueLogicInterventionRecord;
      verification: TransactionVerificationRecord;
    }
  | {
      ok: false;
      reason:
        | "not-found"
        | "configuration-error"
        | "otp-incorrect"
        | "otp-expired"
        | "otp-invalidated"
        | "otp-already-used"
        | "otp-mismatch"
        | "verification-already-exists"
        | "verification-store-failed";
      record?: DueLogicInterventionRecord;
    };

/**
 * OTP-eligible state: exactly the rehearsal-seedable contract — an
 * unexpired preview-ready invitation with an approved outcome, the exact
 * stored three-payment schedules, and no execution linkage.
 */
function otpEligible(
  record: DueLogicInterventionRecord,
  nowIso: string,
): boolean {
  return (
    effectiveInterventionStatus(record, nowIso) === "preview-ready" &&
    record.policyOutcome === "approved" &&
    record.selectedDate !== null &&
    record.currentPayments !== null &&
    record.currentPayments.length === 3 &&
    record.proposedPayments !== null &&
    record.proposedPayments.length === 3 &&
    record.proposedPayments[0].paymentDate === record.selectedDate &&
    record.confirmationId === null &&
    record.operationId === null &&
    record.newSubscriptionId === null
  );
}

/** The bound policy snapshot must resolve consistently, exactly as elsewhere. */
async function boundPolicyResolves(
  policies: MerchantPolicyRepository,
  record: DueLogicInterventionRecord,
): Promise<boolean> {
  let snapshot: MerchantPolicySnapshot | null;
  try {
    snapshot = await policies.readByVersion(
      record.merchantId,
      record.policyVersion,
    );
  } catch {
    snapshot = null;
  }
  return (
    snapshot !== null &&
    snapshot.merchantId === record.merchantId &&
    snapshot.policyVersion === record.policyVersion &&
    snapshot.policyVersion === snapshot.policy.version
  );
}

/** Reads and normalises the trusted payer mobile; null when unavailable. */
async function readNormalisedMobile(
  deps: InterventionOtpDeps,
  record: DueLogicInterventionRecord,
): Promise<{ outcome: "ok"; normalised: string } | { outcome: "unavailable" } | { outcome: "invalid" }> {
  let raw: string | null;
  try {
    raw = await deps.readPayerMobile(record.merchantId, record.payerId);
  } catch {
    raw = null;
  }
  if (raw === null || raw.trim() === "") {
    return { outcome: "unavailable" };
  }
  const normalised = normaliseAustralianMobile(raw);
  if (normalised === null) {
    return { outcome: "invalid" };
  }
  return { outcome: "ok", normalised };
}

/**
 * Issues (or replaces) the intervention's OTP challenge and delivers the
 * code through the separate simulated SMS channel. The plaintext code
 * never appears in the return value.
 */
export async function requestInterventionOtp(
  input: { token: string },
  deps: InterventionOtpDeps,
): Promise<RequestInterventionOtpOutcome> {
  // Fail closed before anything else when the HMAC secret is missing.
  const secret = deps.otpHmacSecret();
  if (secret === null || secret.trim() === "") {
    return { ok: false, reason: "configuration-error" };
  }

  const record = await deps.interventions.readByTokenHash(
    deps.hashToken(input.token.trim()),
  );
  if (record === null) {
    return { ok: false, reason: "not-found" };
  }
  const nowIso = deps.now();
  if (!otpEligible(record, nowIso)) {
    return { ok: false, reason: "otp-not-eligible", record };
  }

  // A verification record already exists (usable, consumed or expired):
  // the write-once verification store could never accept another, so a
  // fresh code would be pointless — refuse instead of issuing.
  try {
    if (
      (await deps.verifications.readVerifiedForIntervention(
        record.interventionId,
      )) !== null
    ) {
      return { ok: false, reason: "otp-not-eligible", record };
    }
  } catch {
    return { ok: false, reason: "store-failed", record };
  }

  if (!(await boundPolicyResolves(deps.policies, record))) {
    return { ok: false, reason: "policy-unresolved", record };
  }

  const mobile = await readNormalisedMobile(deps, record);
  if (mobile.outcome === "unavailable") {
    return { ok: false, reason: "mobile-unavailable", record };
  }
  if (mobile.outcome === "invalid") {
    return { ok: false, reason: "mobile-invalid", record };
  }

  const code = formatOtpCode(deps.generateOtpCodeNumber());
  if (code === null) {
    return { ok: false, reason: "configuration-error", record };
  }

  const issuedMs = Date.parse(nowIso);
  if (Number.isNaN(issuedMs)) {
    return { ok: false, reason: "store-failed", record };
  }
  const challengeId = deps.generateChallengeId();
  const challenge: OtpChallengeRecord = {
    challengeId,
    interventionId: record.interventionId,
    merchantId: record.merchantId,
    payerId: record.payerId,
    subscriptionId: record.subscriptionId,
    selectedDate: record.selectedDate as string,
    currentPayments: (record.currentPayments ?? []).map((payment) => ({
      ...payment,
    })),
    proposedPayments: (record.proposedPayments ?? []).map((payment) => ({
      ...payment,
    })),
    policyVersion: record.policyVersion,
    trustedMobileFingerprint: computeTrustedMobileFingerprint(
      secret,
      mobile.normalised,
    ),
    maskedMobile: maskNormalisedMobile(mobile.normalised),
    codeDigest: computeOtpCodeDigest(secret, challengeId, code),
    issuedAt: nowIso,
    expiresAt: new Date(
      issuedMs + OTP_CHALLENGE_LIFETIME_MINUTES * 60_000,
    ).toISOString(),
    verifiedAt: null,
    invalidatedAt: null,
  };

  try {
    await deps.challenges.issue(challenge);
  } catch {
    return { ok: false, reason: "store-failed", record };
  }

  // The one and only place the plaintext code leaves this service: the
  // separate simulated SMS channel. No link, token or identifier joins it.
  const message: DevSmsMessage = {
    smsId: deps.generateSmsId(),
    interventionId: record.interventionId,
    maskedRecipient: challenge.maskedMobile,
    body: `DueLogic: your verification code is ${code}. It expires in ${OTP_CHALLENGE_LIFETIME_MINUTES} minutes.`,
    sentAt: nowIso,
  };
  try {
    await deps.sms.send(message);
  } catch {
    return { ok: false, reason: "delivery-failed", record };
  }

  return {
    ok: true,
    record,
    maskedMobile: challenge.maskedMobile,
    challengeExpiresAt: challenge.expiresAt,
  };
}

/**
 * Verifies an entered code against the intervention's current challenge
 * and, on success, creates the EXISTING TransactionVerificationRecord
 * (ten-minute lifetime, consumedAt null) through the unchanged write-once
 * repository contract. No confirmation, claim or execution happens here.
 */
export async function verifyInterventionOtp(
  input: { token: string; code: string },
  deps: InterventionOtpDeps,
): Promise<VerifyInterventionOtpOutcome> {
  const secret = deps.otpHmacSecret();
  if (secret === null || secret.trim() === "") {
    return { ok: false, reason: "configuration-error" };
  }

  const record = await deps.interventions.readByTokenHash(
    deps.hashToken(input.token.trim()),
  );
  if (record === null) {
    return { ok: false, reason: "not-found" };
  }
  const nowIso = deps.now();
  // A no-longer-eligible invitation (declined, expired, escalated, or
  // carrying execution linkage) can never match a usable challenge's
  // bound state contract: refuse as a binding mismatch.
  if (!otpEligible(record, nowIso)) {
    return { ok: false, reason: "otp-mismatch", record };
  }

  // Reload the trusted mobile: a changed or missing mobile invalidates
  // the outstanding challenge through the fingerprint binding.
  const mobile = await readNormalisedMobile(deps, record);
  if (mobile.outcome !== "ok") {
    return { ok: false, reason: "otp-mismatch", record };
  }

  const expectation: OtpChallengeExpectation = {
    ...transactionVerificationExpectationFor(record),
    trustedMobileFingerprint: computeTrustedMobileFingerprint(
      secret,
      mobile.normalised,
    ),
  };

  const verifyOutcome = await deps.challenges.verify(
    record.interventionId,
    expectation,
    nowIso,
    (challengeId) => computeOtpCodeDigest(secret, challengeId, input.code),
  );
  if (!verifyOutcome.ok) {
    const reason =
      verifyOutcome.reason === "incorrect"
        ? "otp-incorrect"
        : verifyOutcome.reason === "expired"
          ? "otp-expired"
          : verifyOutcome.reason === "already-used"
            ? "otp-already-used"
            : verifyOutcome.reason === "mismatch"
              ? "otp-mismatch"
              : verifyOutcome.reason === "store"
                ? "verification-store-failed"
                : // "missing", "invalidated" and structurally "invalid"
                  // challenges all mean no live challenge exists.
                  "otp-invalidated";
    return { ok: false, reason, record };
  }

  // Success: create the existing TransactionVerificationRecord — the same
  // record shape, lifetime and write-once store the rehearsal seeding
  // used, so the claim and execution boundary is completely unchanged.
  const verifiedMs = Date.parse(nowIso);
  if (Number.isNaN(verifiedMs)) {
    return { ok: false, reason: "verification-store-failed", record };
  }
  const bindings = transactionVerificationExpectationFor(record);
  const verification: TransactionVerificationRecord = {
    verificationId: deps.generateVerificationId(),
    interventionId: bindings.interventionId,
    merchantId: bindings.merchantId,
    payerId: bindings.payerId,
    subscriptionId: bindings.subscriptionId,
    selectedDate: bindings.selectedDate,
    currentPayments: bindings.currentPayments.map((payment) => ({
      ...payment,
    })),
    proposedPayments: bindings.proposedPayments.map((payment) => ({
      ...payment,
    })),
    policyVersion: bindings.policyVersion,
    verifiedAt: nowIso,
    expiresAt: new Date(
      verifiedMs + OTP_VERIFICATION_LIFETIME_MINUTES * 60_000,
    ).toISOString(),
    consumedAt: null,
  };
  try {
    await deps.verifications.create(verification);
  } catch {
    // The write-once store refused (a record already exists) or failed;
    // distinguish honestly, never retry.
    let existing: TransactionVerificationRecord | null;
    try {
      existing = await deps.verifications.readVerifiedForIntervention(
        record.interventionId,
      );
    } catch {
      existing = null;
    }
    return {
      ok: false,
      reason:
        existing !== null
          ? "verification-already-exists"
          : "verification-store-failed",
      record,
    };
  }

  // Sanity: the created record must evaluate as usable for this exact
  // intervention right now, or the gate would stay closed dishonestly.
  const usable = evaluateTransactionVerification(
    verification,
    transactionVerificationExpectationFor(record),
    deps.now(),
  );
  if (!usable.ok) {
    return { ok: false, reason: "verification-store-failed", record };
  }

  return { ok: true, record, verification };
}

// ---------------------------------------------------------------------------
// Real implementations for the dev routes. The validation suite injects
// deterministic fakes instead.

/** Cryptographically secure code number in 0..999999 inclusive. */
export function generateSecureOtpCodeNumber(): number {
  return randomInt(0, 1_000_000);
}

export function generateOtpChallengeId(): string {
  return `otpch_${randomUUID()}`;
}

export function generateDevSmsId(): string {
  return `sms_${randomUUID()}`;
}
