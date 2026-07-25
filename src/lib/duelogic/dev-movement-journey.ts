/**
 * Development wiring for the movement journey: composes the shared
 * process-local stores, the read-only Pinch payer-mobile GET and the
 * FIXTURE-BACKED payment effects into the dependency objects the dev
 * routes and the tokenised page use.
 *
 * IMPORTANT STAGE BOUNDARY: the temporary journey's payment reads AND its
 * mutation effect operate on the process-local fixture payment store only
 * — live Pinch payment discovery and live temporary mutation remain a
 * later controlled validation stage, so no live Pinch payment can be
 * touched through this composition by construction. The only Pinch call
 * wired here is the read-only payer GET used for the trusted mobile.
 */

import { getDevInterventionRepository } from "./dev-intervention-store";
import {
  getDevFixturePaymentRepository,
  getDevMovementChoiceRepository,
} from "./dev-movement-store";
import { getDevOtpChallengeRepository } from "./dev-otp-store";
import { getDevSmsStore } from "./dev-sms-store";
import {
  generateTemporaryConfirmationId,
  generateTemporaryOperationId,
  generateTemporarySelectionId,
  generateTemporaryVerificationId,
  getDevTemporaryConfirmationRepository,
  getDevTemporaryOperationRepository,
  getDevTemporarySelectionRepository,
  getDevTemporaryVerificationRepository,
} from "./dev-temporary-operation-store";
import { getDevTransactionVerificationRepository } from "./dev-transaction-verification-store";
import { INTERVENTION_DEMO_FIXTURE } from "./intervention-fixture";
import { hashInterventionToken } from "./intervention-service";
import type { MovementAvailabilityDeps } from "./movement-availability";
import type {
  ChooseMovementDeps,
  MovementProjectionDeps,
} from "./movement-journey";
import {
  generateDevSmsId,
  generateOtpChallengeId,
  generateSecureOtpCodeNumber,
} from "./otp-service";
import { getDevMerchantPolicyRepository } from "./policy/dev-policy-store";
import type { TemporaryJourneyDeps } from "./temporary-execution-service";
import { pinchRequest } from "@/lib/pinch/client";

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts.
if (typeof window !== "undefined") {
  throw new Error(
    "The dev movement-journey composition is server-only and must not be imported into browser code.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read-only Pinch GET: the payer's mobileNumber, or null when absent. */
async function readPayerMobile(
  merchantId: string,
  payerId: string,
): Promise<string | null> {
  const result = await pinchRequest<unknown>(
    `payers/${encodeURIComponent(payerId)}`,
    { merchantId },
  );
  if (!isRecord(result)) {
    return null;
  }
  const mobile = result.mobileNumber;
  return typeof mobile === "string" && mobile.trim() !== ""
    ? mobile.trim()
    : null;
}

/** Availability deps over the shared dev stores and fixture payments. */
export async function buildDevMovementAvailabilityDeps(): Promise<MovementAvailabilityDeps> {
  const fixturePayments = getDevFixturePaymentRepository();
  return {
    policies: await getDevMerchantPolicyRepository(),
    interventions: getDevInterventionRepository(),
    temporaryOperations: getDevTemporaryOperationRepository(),
    readUpcomingScheduledPayment: (merchantId, payerId) =>
      fixturePayments.readUpcomingForPayer(payerId),
    planScheduleConfiguration:
      INTERVENTION_DEMO_FIXTURE.planScheduleConfiguration,
    merchantTimezone: INTERVENTION_DEMO_FIXTURE.merchantTimezone,
    currentArrearsCents: () => INTERVENTION_DEMO_FIXTURE.currentArrearsCents,
    now: () => new Date().toISOString(),
  };
}

export async function buildDevMovementProjectionDeps(): Promise<MovementProjectionDeps> {
  return {
    choices: getDevMovementChoiceRepository(),
    selections: getDevTemporarySelectionRepository(),
    temporaryVerifications: getDevTemporaryVerificationRepository(),
    availability: await buildDevMovementAvailabilityDeps(),
    now: () => new Date().toISOString(),
  };
}

export async function buildDevChooseMovementDeps(): Promise<ChooseMovementDeps> {
  const permanentVerifications = getDevTransactionVerificationRepository();
  return {
    interventions: getDevInterventionRepository(),
    choices: getDevMovementChoiceRepository(),
    selections: getDevTemporarySelectionRepository(),
    temporaryVerifications: getDevTemporaryVerificationRepository(),
    permanentVerificationExists: async (interventionId) =>
      (await permanentVerifications.readVerifiedForIntervention(
        interventionId,
      )) !== null,
    availability: await buildDevMovementAvailabilityDeps(),
    now: () => new Date().toISOString(),
    hashToken: hashInterventionToken,
  };
}

/**
 * The complete temporary-journey dependency set for the dev routes:
 * fixture-backed payment effects (never Pinch), the read-only payer
 * mobile GET, the shared OTP/SMS stores and the process-local temporary
 * stores. The HMAC secret is resolved at execution time from the
 * environment and fails closed when absent.
 */
export async function buildDevTemporaryJourneyDeps(): Promise<TemporaryJourneyDeps> {
  const fixturePayments = getDevFixturePaymentRepository();
  return {
    interventions: getDevInterventionRepository(),
    selections: getDevTemporarySelectionRepository(),
    temporaryVerifications: getDevTemporaryVerificationRepository(),
    temporaryConfirmations: getDevTemporaryConfirmationRepository(),
    temporaryOperations: getDevTemporaryOperationRepository(),
    policies: await getDevMerchantPolicyRepository(),
    challenges: getDevOtpChallengeRepository(),
    sms: getDevSmsStore(),
    readUpcomingScheduledPayment: (merchantId, payerId) =>
      fixturePayments.readUpcomingForPayer(payerId),
    readPayment: (merchantId, paymentId) =>
      fixturePayments.readById(paymentId),
    // Fixture-store mutation only in this stage — never a Pinch call.
    updatePaymentDate: (merchantId, body) =>
      fixturePayments.applyDateUpdate(body),
    readPayerMobile,
    currentArrearsCents: () => INTERVENTION_DEMO_FIXTURE.currentArrearsCents,
    merchantTimezone: INTERVENTION_DEMO_FIXTURE.merchantTimezone,
    now: () => new Date().toISOString(),
    hashToken: hashInterventionToken,
    otpHmacSecret: () => process.env.DUELOGIC_OTP_HMAC_SECRET ?? null,
    generateSelectionId: generateTemporarySelectionId,
    generateChallengeId: generateOtpChallengeId,
    generateSmsId: generateDevSmsId,
    generateVerificationId: generateTemporaryVerificationId,
    generateConfirmationId: generateTemporaryConfirmationId,
    generateOperationId: generateTemporaryOperationId,
    generateOtpCodeNumber: generateSecureOtpCodeNumber,
  };
}
