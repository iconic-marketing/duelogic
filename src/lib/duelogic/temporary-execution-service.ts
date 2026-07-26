/**
 * Protected temporary payment-movement service: deterministic selection
 * binding, temporary-shaped OTP verification and the single protected
 * execution entry point for moving ONE scheduled Pinch payment through
 * the OTP-gated customer journey.
 *
 * Everything is injected (repositories, clock, token hasher, secret
 * resolver, read-only payment and mobile effects, the payment-mutation
 * effect), so the deterministic validation drives these exact code paths
 * with fakes and no network access. NOTHING here touches the protected
 * permanent path: replacement-operation-flow.ts, the permanent
 * replacement route, permanent recovery ordering and
 * confirmInterventionExecution are all unchanged and unreferenced.
 *
 * Trust model: the browser supplies only the review token, a requested
 * date at binding time and the OTP code at verify time. The payment ID,
 * amount, original date, proposed date and policy version always come
 * from the server-held binding — the final-confirmation request can
 * never supply or replace any of them. The policy engine (under the
 * intervention-bound snapshot, with derived permanent AND temporary
 * history) remains the sole eligibility authority; Pinch remains the
 * authority for live payment state; the mutation is invoked exactly once
 * with no automatic retry, and success exists only after read-back
 * verification.
 */

import { calendarDaysBetween, parseCalendarDate } from "./calendar-date";
import {
  effectiveInterventionStatus,
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
  type TemporaryOtpChallengeExpectation,
  type TemporaryOtpChallengeRecord,
} from "./otp-challenge";
import type { OtpChallengeRepository } from "./dev-otp-store";
import type { DevSmsDeliveryAdapter, DevSmsMessage } from "./dev-sms-store";
import { OTP_VERIFICATION_LIFETIME_MINUTES } from "./otp-service";
import {
  evaluateScheduleChange,
  PolicyValidationError,
  type TemporaryPolicyEvaluationRequest,
} from "./policy/engine";
import type {
  MerchantPolicyRepository,
  MerchantPolicySnapshot,
} from "./policy/policy-snapshot";
import { toPriorScheduleChanges } from "./prior-change-history";
import {
  combinePriorScheduleChanges,
  temporaryVerificationExpectationFor,
  toTemporaryPriorScheduleChanges,
  type TemporaryCustomerConfirmationRecord,
  type TemporaryOperationSelection,
  type TemporaryPaymentOperationRecord,
  type TemporaryTransactionVerificationRecord,
} from "./temporary-operation";
import type {
  TemporaryConfirmationRepository,
  TemporaryOperationRepository,
  TemporaryOperationSelectionRepository,
  TemporaryVerificationRepository,
} from "./dev-temporary-operation-store";
import {
  executeVerifiedPaymentDateMovement,
  type AuthoritativePaymentSnapshot,
  type PaymentDateUpdateBody,
} from "@/lib/pinch/payment-movement";

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts.
if (typeof window !== "undefined") {
  throw new Error(
    "The temporary execution service is server-only and must not be imported into browser code.",
  );
}

export interface TemporaryJourneyDeps {
  interventions: DueLogicInterventionRepository;
  selections: TemporaryOperationSelectionRepository;
  temporaryVerifications: TemporaryVerificationRepository;
  temporaryConfirmations: TemporaryConfirmationRepository;
  temporaryOperations: TemporaryOperationRepository;
  /** Resolves the intervention-bound snapshot — never the active policy. */
  policies: MerchantPolicyRepository;
  challenges: OtpChallengeRepository;
  sms: DevSmsDeliveryAdapter;
  /** Read-only: the payer's one upcoming scheduled payment (fake today). */
  readUpcomingScheduledPayment(
    merchantId: string,
    payerId: string,
  ): Promise<AuthoritativePaymentSnapshot | null>;
  /** Read-only authoritative payment read (fake today; Pinch GET later). */
  readPayment(
    merchantId: string,
    paymentId: string,
  ): Promise<AuthoritativePaymentSnapshot | null>;
  /**
   * The one mutation effect: "ok" on definite success, "rejected" on a
   * definite upstream refusal, throw on unknown outcome. Called at most
   * once per execution. Fakes only in this stage — never live Pinch.
   */
  updatePaymentDate(
    merchantId: string,
    body: PaymentDateUpdateBody,
  ): Promise<"ok" | "rejected">;
  readPayerMobile(merchantId: string, payerId: string): Promise<string | null>;
  /** Explicit trusted arrears input — never inferred from history. */
  currentArrearsCents(): number;
  merchantTimezone: string;
  now(): string;
  hashToken(rawToken: string): string;
  otpHmacSecret(): string | null;
  generateSelectionId(): string;
  generateChallengeId(): string;
  generateSmsId(): string;
  generateVerificationId(): string;
  generateConfirmationId(): string;
  generateOperationId(): string;
  generateOtpCodeNumber(): number;
}

/** The calendar date of an ISO instant in the merchant timezone. */
function merchantCalendarDateOfInstant(
  iso: string,
  timezone: string,
): string | null {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(parsed));
}

/** Statuses from which a temporary journey step may proceed. */
function interventionUsable(
  record: DueLogicInterventionRecord,
  nowIso: string,
): boolean {
  const status = effectiveInterventionStatus(record, nowIso);
  return (
    status !== "expired" &&
    status !== "declined" &&
    status !== "escalated" &&
    status !== "executing" &&
    status !== "executed" &&
    status !== "manual-recovery-required" &&
    record.confirmationId === null &&
    record.operationId === null &&
    record.newSubscriptionId === null
  );
}

async function resolveBoundSnapshot(
  policies: MerchantPolicyRepository,
  record: DueLogicInterventionRecord,
): Promise<MerchantPolicySnapshot | null> {
  let snapshot: MerchantPolicySnapshot | null;
  try {
    snapshot = await policies.readByVersion(
      record.merchantId,
      record.policyVersion,
    );
  } catch {
    snapshot = null;
  }
  if (
    snapshot === null ||
    snapshot.merchantId !== record.merchantId ||
    snapshot.policyVersion !== record.policyVersion ||
    snapshot.policyVersion !== snapshot.policy.version
  ) {
    return null;
  }
  return snapshot;
}

/** Derived combined history: verified permanent + verified temporary. */
async function derivedCombinedHistory(
  deps: TemporaryJourneyDeps,
  record: DueLogicInterventionRecord,
) {
  return combinePriorScheduleChanges(
    toPriorScheduleChanges(
      await deps.interventions.list(),
      record.payerId,
      deps.merchantTimezone,
    ),
    toTemporaryPriorScheduleChanges(
      await deps.temporaryOperations.list(),
      record.payerId,
      record.merchantId,
      deps.merchantTimezone,
    ),
  );
}

// ---------------------------------------------------------------------------
// 1. Deterministic evaluation and selection binding

export type BindTemporarySelectionOutcome =
  | {
      ok: true;
      selection: TemporaryOperationSelection;
    }
  | { ok: false; reason: "alternative-offered"; alternativeDate: string }
  | {
      ok: false;
      reason:
        | "not-found"
        | "not-bindable"
        | "verification-active"
        | "policy-unresolved"
        | "payment-unavailable"
        | "payment-not-scheduled"
        | "merchant-review-required"
        | "validation"
        | "store";
      policyReasonCode?: string;
    };

/**
 * Evaluates one requested temporary date deterministically and binds the
 * approved exact operation to the intervention. Replaces any previous
 * unverified selection (which invalidates every earlier expectation); a
 * re-bind is REFUSED while a temporary verification record exists — the
 * bound operation is immutable after verification, and changing it would
 * require explicit invalidation plus a fresh verification (not built in
 * this stage). An over-limit request returns the engine's maximum
 * permitted alternative, which the customer must actively accept by
 * re-binding with that exact date.
 */
export async function evaluateAndBindTemporarySelection(
  input: {
    token: string;
    requestedDate: string;
    acceptOfferedAlternative?: boolean;
  },
  deps: TemporaryJourneyDeps,
): Promise<BindTemporarySelectionOutcome> {
  const record = await deps.interventions.readByTokenHash(
    deps.hashToken(input.token.trim()),
  );
  if (record === null) {
    return { ok: false, reason: "not-found" };
  }
  const nowIso = deps.now();
  if (!interventionUsable(record, nowIso)) {
    return { ok: false, reason: "not-bindable" };
  }

  // Post-verification immutability: while a temporary verification exists
  // (consumed or not), the bound operation may not be replaced.
  try {
    if (
      (await deps.temporaryVerifications.readForIntervention(
        record.interventionId,
      )) !== null
    ) {
      return { ok: false, reason: "verification-active" };
    }
  } catch {
    return { ok: false, reason: "store" };
  }

  const snapshot = await resolveBoundSnapshot(deps.policies, record);
  if (snapshot === null) {
    return { ok: false, reason: "policy-unresolved" };
  }

  let payment: AuthoritativePaymentSnapshot | null;
  try {
    payment = await deps.readUpcomingScheduledPayment(
      record.merchantId,
      record.payerId,
    );
  } catch {
    payment = null;
  }
  if (payment === null || payment.payerId !== record.payerId) {
    return { ok: false, reason: "payment-unavailable" };
  }
  if (payment.status.toLowerCase() !== "scheduled") {
    return { ok: false, reason: "payment-not-scheduled" };
  }

  const evaluationDate = merchantCalendarDateOfInstant(
    nowIso,
    deps.merchantTimezone,
  );
  if (evaluationDate === null) {
    return { ok: false, reason: "validation" };
  }

  const request: TemporaryPolicyEvaluationRequest = {
    changeType: "temporary",
    payerId: record.payerId,
    paymentId: payment.id,
    amountCents: payment.amountInCents,
    evaluationDate,
    currentArrearsCents: deps.currentArrearsCents(),
    currentPaymentDate: payment.transactionDate,
    requestedDate: input.requestedDate.trim(),
    // Trusted assigned-cycle bounds stored on the intervention at
    // creation: the engine refuses any revised date beyond the cycle end
    // and returns the latest compliant date as the alternative.
    currentCycleStartDate: record.currentCycleStartDate,
    currentCycleEndDate: record.currentCycleEndDate,
  };

  let decision;
  try {
    decision = evaluateScheduleChange(
      request,
      await derivedCombinedHistory(deps, record),
      snapshot.policy,
    );
  } catch (error) {
    if (error instanceof PolicyValidationError) {
      return { ok: false, reason: "validation" };
    }
    throw error;
  }

  if (decision.outcome === "shorter-alternative") {
    // The engine's maximum permitted date. The customer must actively
    // accept it by re-binding with exactly this date.
    return {
      ok: false,
      reason: "alternative-offered",
      alternativeDate: decision.alternativeDate,
    };
  }
  if (decision.outcome !== "approved") {
    // Escalations (ceiling, arrears, usage limit, …) are merchant review —
    // never described as an absolute denial.
    return {
      ok: false,
      reason: "merchant-review-required",
      policyReasonCode: decision.reasonCode,
    };
  }

  const selection: TemporaryOperationSelection = {
    kind: "temporary",
    selectionId: deps.generateSelectionId(),
    interventionId: record.interventionId,
    merchantId: record.merchantId,
    payerId: record.payerId,
    paymentId: payment.id,
    originalTransactionDate: payment.transactionDate,
    proposedTransactionDate: request.requestedDate,
    amountInCents: payment.amountInCents,
    currency: "AUD",
    policyVersion: record.policyVersion,
    policyReasonCode: decision.reasonCode,
    policyRuleFired: decision.ruleFired,
    requestedDate: request.requestedDate,
    acceptedAlternativeDate:
      input.acceptOfferedAlternative === true ? request.requestedDate : null,
    createdAt: nowIso,
    // A selection can never outlive its invitation.
    expiresAt: record.expiresAt,
  };
  try {
    await deps.selections.bind(selection);
  } catch {
    return { ok: false, reason: "store" };
  }
  return { ok: true, selection };
}

// ---------------------------------------------------------------------------
// 2. Temporary OTP request and verify

export type RequestTemporaryOtpOutcome =
  | { ok: true; maskedMobile: string; challengeExpiresAt: string }
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
    };

async function readNormalisedMobile(
  deps: TemporaryJourneyDeps,
  record: DueLogicInterventionRecord,
): Promise<
  | { outcome: "ok"; normalised: string }
  | { outcome: "unavailable" }
  | { outcome: "invalid" }
> {
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
 * Issues (or replaces) the temporary OTP challenge for the intervention's
 * ACTIVE bound selection, delivering the code only through the separate
 * simulated SMS channel. The challenge is cryptographically bound to the
 * exact selection values plus the trusted-mobile fingerprint.
 */
export async function requestTemporaryOtp(
  input: { token: string },
  deps: TemporaryJourneyDeps,
): Promise<RequestTemporaryOtpOutcome> {
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
  if (!interventionUsable(record, nowIso)) {
    return { ok: false, reason: "otp-not-eligible" };
  }
  const selection = await deps.selections.readActive(record.interventionId);
  if (
    selection === null ||
    Date.parse(nowIso) >= Date.parse(selection.expiresAt)
  ) {
    return { ok: false, reason: "otp-not-eligible" };
  }
  try {
    if (
      (await deps.temporaryVerifications.readForIntervention(
        record.interventionId,
      )) !== null
    ) {
      return { ok: false, reason: "otp-not-eligible" };
    }
  } catch {
    return { ok: false, reason: "store-failed" };
  }
  if ((await resolveBoundSnapshot(deps.policies, record)) === null) {
    return { ok: false, reason: "policy-unresolved" };
  }

  const mobile = await readNormalisedMobile(deps, record);
  if (mobile.outcome === "unavailable") {
    return { ok: false, reason: "mobile-unavailable" };
  }
  if (mobile.outcome === "invalid") {
    return { ok: false, reason: "mobile-invalid" };
  }

  const code = formatOtpCode(deps.generateOtpCodeNumber());
  if (code === null) {
    return { ok: false, reason: "configuration-error" };
  }
  const issuedMs = Date.parse(nowIso);
  if (Number.isNaN(issuedMs)) {
    return { ok: false, reason: "store-failed" };
  }
  const challengeId = deps.generateChallengeId();
  const challenge: TemporaryOtpChallengeRecord = {
    kind: "temporary",
    challengeId,
    interventionId: selection.interventionId,
    merchantId: selection.merchantId,
    payerId: selection.payerId,
    paymentId: selection.paymentId,
    originalTransactionDate: selection.originalTransactionDate,
    proposedTransactionDate: selection.proposedTransactionDate,
    amountInCents: selection.amountInCents,
    policyVersion: selection.policyVersion,
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
    return { ok: false, reason: "store-failed" };
  }

  const message: DevSmsMessage = {
    smsId: deps.generateSmsId(),
    interventionId: selection.interventionId,
    maskedRecipient: challenge.maskedMobile,
    body: `DueLogic: your verification code is ${code}. It expires in ${OTP_CHALLENGE_LIFETIME_MINUTES} minutes.`,
    sentAt: nowIso,
  };
  try {
    await deps.sms.send(message);
  } catch {
    return { ok: false, reason: "delivery-failed" };
  }
  return {
    ok: true,
    maskedMobile: challenge.maskedMobile,
    challengeExpiresAt: challenge.expiresAt,
  };
}

export type VerifyTemporaryOtpOutcome =
  | { ok: true; verification: TemporaryTransactionVerificationRecord }
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
    };

/**
 * Verifies the entered code against the intervention's current temporary
 * challenge and — on success — creates the temporary transaction
 * verification bound to the exact selection. Never confirms, executes or
 * mutates anything.
 */
export async function verifyTemporaryOtp(
  input: { token: string; code: string },
  deps: TemporaryJourneyDeps,
): Promise<VerifyTemporaryOtpOutcome> {
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
  const selection = await deps.selections.readActive(record.interventionId);
  if (selection === null || !interventionUsable(record, nowIso)) {
    return { ok: false, reason: "otp-mismatch" };
  }
  const mobile = await readNormalisedMobile(deps, record);
  if (mobile.outcome !== "ok") {
    return { ok: false, reason: "otp-mismatch" };
  }

  const expectation: TemporaryOtpChallengeExpectation = {
    kind: "temporary",
    interventionId: selection.interventionId,
    merchantId: selection.merchantId,
    payerId: selection.payerId,
    paymentId: selection.paymentId,
    originalTransactionDate: selection.originalTransactionDate,
    proposedTransactionDate: selection.proposedTransactionDate,
    amountInCents: selection.amountInCents,
    policyVersion: selection.policyVersion,
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
                : "otp-invalidated";
    return { ok: false, reason };
  }

  const verifiedMs = Date.parse(nowIso);
  if (Number.isNaN(verifiedMs)) {
    return { ok: false, reason: "verification-store-failed" };
  }
  const verification: TemporaryTransactionVerificationRecord = {
    verificationId: deps.generateVerificationId(),
    kind: "temporary",
    interventionId: selection.interventionId,
    merchantId: selection.merchantId,
    payerId: selection.payerId,
    paymentId: selection.paymentId,
    originalTransactionDate: selection.originalTransactionDate,
    proposedTransactionDate: selection.proposedTransactionDate,
    amountInCents: selection.amountInCents,
    policyVersion: selection.policyVersion,
    trustedMobileFingerprint: expectation.trustedMobileFingerprint,
    verifiedAt: nowIso,
    expiresAt: new Date(
      verifiedMs + OTP_VERIFICATION_LIFETIME_MINUTES * 60_000,
    ).toISOString(),
    consumedAt: null,
  };
  try {
    await deps.temporaryVerifications.create(verification);
  } catch {
    let existing: TemporaryTransactionVerificationRecord | null;
    try {
      existing = await deps.temporaryVerifications.readForIntervention(
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
    };
  }
  return { ok: true, verification };
}

// ---------------------------------------------------------------------------
// 3. Protected temporary execution

export type ExecuteTemporaryChangeOutcome =
  | {
      ok: true;
      record: DueLogicInterventionRecord;
      operation: TemporaryPaymentOperationRecord;
    }
  | {
      ok: false;
      reason:
        | "not-found"
        | "not-confirmable"
        | "selection-missing"
        | "policy-unresolved"
        | "payment-unreadable"
        | "payment-not-scheduled"
        | "payment-mismatch"
        | "selection-outside-assigned-cycle"
        | "verification-required"
        | "confirmation-failed"
        | "operation-evidence-failed"
        | "refused"
        | "temporary-change-ambiguous"
        | "manual-recovery-required";
      stage?: string;
      record?: DueLogicInterventionRecord;
    };

/**
 * The single protected temporary execution entry point, for later use by
 * the final-confirmation dispatcher. The browser contributes only the
 * token; every operation value comes from the stored binding.
 *
 * Ordering: reload and gate → resolve bound selection → resolve bound
 * policy snapshot → fresh authoritative payment read (status exactly
 * "scheduled"; ID, original date and amount must match the binding) →
 * ATOMIC single-use verification claim → temporary confirmation created
 * and acceptance recorded → operation evidence written and read back
 * BEFORE mutation → confirmation consumed and bound to the operation →
 * ONE mutation invocation (never retried) → authoritative read-back →
 * verified only when the unchanged payment ID and the confirmed
 * transactionDate are proven → intervention linkage written and status
 * set to executed. Refusals before the claim consume nothing; the claim
 * itself is terminal — mirroring the permanent path's conservatism.
 */
export async function executeTemporaryPaymentChange(
  input: { token: string },
  deps: TemporaryJourneyDeps,
): Promise<ExecuteTemporaryChangeOutcome> {
  // 1-2. Reload and gate.
  const record = await deps.interventions.readByTokenHash(
    deps.hashToken(input.token.trim()),
  );
  if (record === null) {
    return { ok: false, reason: "not-found" };
  }
  const nowIso = deps.now();
  if (!interventionUsable(record, nowIso)) {
    return { ok: false, reason: "not-confirmable", record };
  }

  // 3-4. The bound temporary operation selection.
  const selection = await deps.selections.readActive(record.interventionId);
  if (
    selection === null ||
    selection.kind !== "temporary" ||
    Date.parse(nowIso) >= Date.parse(selection.expiresAt)
  ) {
    return { ok: false, reason: "selection-missing", record };
  }

  // 6. The bound immutable policy snapshot must still resolve.
  const snapshot = await resolveBoundSnapshot(deps.policies, record);
  if (snapshot === null) {
    return { ok: false, reason: "policy-unresolved", record };
  }

  // 7-9. Fresh authoritative payment read — before the claim, so a stale
  // binding refuses without burning the customer's verification.
  let payment: AuthoritativePaymentSnapshot | null;
  try {
    payment = await deps.readPayment(record.merchantId, selection.paymentId);
  } catch {
    payment = null;
  }
  if (payment === null) {
    return { ok: false, reason: "payment-unreadable", record };
  }
  if (payment.status.toLowerCase() !== "scheduled") {
    return { ok: false, reason: "payment-not-scheduled", record };
  }
  if (
    payment.id !== selection.paymentId ||
    payment.payerId !== record.payerId ||
    payment.transactionDate !== selection.originalTransactionDate ||
    payment.amountInCents !== selection.amountInCents
  ) {
    return { ok: false, reason: "payment-mismatch", record };
  }

  // 9b. Assigned-billing-cycle re-check, deterministically re-asserted
  // immediately before the claim against the intervention's stored trusted
  // cycle bounds and the bound policy's shift cap: a forged, stale or
  // next-cycle bound date refuses here — before any claim, confirmation,
  // evidence or mutation — and consumes nothing. Every value is strictly
  // validated as a calendar date FIRST: lexical comparison alone could be
  // fooled by a corrupted non-date string that sorts after valid ISO
  // dates, so malformed stored metadata refuses outright.
  const cycleDatesValid =
    parseCalendarDate(record.currentCycleStartDate) !== null &&
    parseCalendarDate(record.currentCycleEndDate) !== null &&
    parseCalendarDate(selection.originalTransactionDate) !== null &&
    parseCalendarDate(selection.proposedTransactionDate) !== null;
  const boundShiftDays = cycleDatesValid
    ? calendarDaysBetween(
        selection.originalTransactionDate,
        selection.proposedTransactionDate,
      )
    : null;
  if (
    !cycleDatesValid ||
    boundShiftDays === null ||
    boundShiftDays < 1 ||
    boundShiftDays > snapshot.policy.temporaryChange.maxShiftDays ||
    record.currentCycleStartDate > record.currentCycleEndDate ||
    selection.originalTransactionDate < record.currentCycleStartDate ||
    selection.originalTransactionDate > record.currentCycleEndDate ||
    selection.proposedTransactionDate < record.currentCycleStartDate ||
    selection.proposedTransactionDate > record.currentCycleEndDate
  ) {
    return { ok: false, reason: "selection-outside-assigned-cycle", record };
  }

  // 10. ATOMIC single-use claim of the exact temporary verification.
  const claimed = await deps.temporaryVerifications.claimForExecution(
    record.interventionId,
    temporaryVerificationExpectationFor(selection),
    nowIso,
  );
  if (claimed === null) {
    return { ok: false, reason: "verification-required", record };
  }

  // 11-12. The temporary confirmation: the customer's final-confirmation
  // click is the acceptance being recorded, bound to the exact movement.
  const confirmationId = deps.generateConfirmationId();
  const confirmation: TemporaryCustomerConfirmationRecord = {
    confirmationId,
    interventionId: selection.interventionId,
    merchantId: selection.merchantId,
    payerId: selection.payerId,
    paymentId: selection.paymentId,
    originalTransactionDate: selection.originalTransactionDate,
    confirmedTransactionDate: selection.proposedTransactionDate,
    amountInCents: selection.amountInCents,
    policyVersion: selection.policyVersion,
    acceptedAt: deps.now(),
    consumedAt: null,
    operationId: null,
    status: "accepted",
  };
  try {
    await deps.temporaryConfirmations.create(confirmation);
  } catch {
    return { ok: false, reason: "confirmation-failed", record };
  }

  // 13. Operation evidence, written and read back BEFORE any mutation.
  const operationId = deps.generateOperationId();
  const baseOperation: TemporaryPaymentOperationRecord = {
    operationId,
    interventionId: selection.interventionId,
    confirmationId,
    merchantId: selection.merchantId,
    payerId: selection.payerId,
    paymentId: selection.paymentId,
    originalTransactionDate: selection.originalTransactionDate,
    proposedTransactionDate: selection.proposedTransactionDate,
    amountInCents: selection.amountInCents,
    policyVersion: selection.policyVersion,
    createdAt: deps.now(),
    updatedAt: deps.now(),
    preflightState: "verified",
    mutationState: "not-invoked",
    readBackState: "not-read",
    status: "pending",
    failureStage: null,
    verifiedAt: null,
    verifiedTransactionDate: null,
  };
  try {
    await deps.temporaryOperations.write(baseOperation);
  } catch {
    return { ok: false, reason: "operation-evidence-failed", record };
  }

  const updateOperation = async (
    changes: Partial<TemporaryPaymentOperationRecord>,
  ): Promise<TemporaryPaymentOperationRecord> => {
    const updated: TemporaryPaymentOperationRecord = {
      ...baseOperation,
      ...changes,
      updatedAt: deps.now(),
    };
    try {
      await deps.temporaryOperations.write(updated);
    } catch {
      // Post-invocation store failures must never flip the reported
      // outcome or trigger any retry; the in-memory record is returned.
    }
    return updated;
  };

  // 14. Consume the confirmation and bind it to the operation.
  const consumed = await deps.temporaryConfirmations.consume(
    confirmationId,
    operationId,
    deps.now(),
  );
  if (consumed === null) {
    await updateOperation({
      status: "refused-before-mutation",
      failureStage: "confirmation-consumption",
    });
    return {
      ok: false,
      reason: "refused",
      stage: "confirmation-consumption",
      record,
    };
  }

  // 15-17. One mutation invocation and its authoritative read-back, via
  // the reusable movement service — never retried on any branch.
  const movement = await executeVerifiedPaymentDateMovement(
    {
      paymentId: selection.paymentId,
      expectedTransactionDate: selection.originalTransactionDate,
      expectedAmountInCents: selection.amountInCents,
      confirmedTransactionDate: selection.proposedTransactionDate,
    },
    {
      readPayment: () =>
        deps.readPayment(record.merchantId, selection.paymentId),
      updatePaymentDate: (body) =>
        deps.updatePaymentDate(record.merchantId, body),
    },
  );

  if (movement.outcome === "refused") {
    // The service's own pre-mutation checks refused: nothing was invoked
    // and the payment is untouched. The claim remains consumed (terminal).
    await updateOperation({
      status: "refused-before-mutation",
      failureStage: movement.stage,
    });
    return { ok: false, reason: "refused", stage: movement.stage, record };
  }

  if (movement.outcome === "verified") {
    // 18-21. Verified: evidence first, then intervention linkage.
    const verifiedAtIso = deps.now();
    const operation = await updateOperation({
      mutationState: "invoked",
      readBackState: "verified",
      status: "temporary-change-verified",
      verifiedAt: verifiedAtIso,
      verifiedTransactionDate: movement.verifiedTransactionDate,
    });
    const executed: DueLogicInterventionRecord = {
      ...record,
      status: "executed",
      confirmationId,
      operationId,
      executedMovementKind: "temporary",
      verifiedTemporaryTransactionDate: movement.verifiedTransactionDate,
      updatedAt: deps.now(),
    };
    try {
      await deps.interventions.write(executed);
    } catch {
      // The verified outcome stands; the in-memory record is returned.
    }
    return { ok: true, record: executed, operation };
  }

  if (movement.outcome === "mutation-rejected") {
    // Known unchanged failure after invocation: merchant review, no retry.
    await updateOperation({
      mutationState: "invoked",
      readBackState: "mismatched",
      status: "manual-recovery-required",
      failureStage: "mutation-rejected",
    });
    const failed: DueLogicInterventionRecord = {
      ...record,
      status: "manual-recovery-required",
      confirmationId,
      operationId,
      executedMovementKind: "temporary",
      updatedAt: deps.now(),
    };
    try {
      await deps.interventions.write(failed);
    } catch {
      // Reported outcome never flips on a store failure.
    }
    return {
      ok: false,
      reason: "manual-recovery-required",
      stage: "mutation-rejected",
      record: failed,
    };
  }

  // Ambiguous: the outcome could not be proven either way. Never retried;
  // surfaced to the merchant. Evidence retains the exact payment, dates
  // and operation identifiers.
  await updateOperation({
    mutationState: "invoked",
    readBackState:
      movement.stage === "read-back-unreadable" ? "unreadable" : "mismatched",
    status: "temporary-change-ambiguous",
    failureStage: movement.stage,
  });
  const ambiguous: DueLogicInterventionRecord = {
    ...record,
    status: "manual-recovery-required",
    confirmationId,
    operationId,
    executedMovementKind: "temporary",
    updatedAt: deps.now(),
  };
  try {
    await deps.interventions.write(ambiguous);
  } catch {
    // Reported outcome never flips on a store failure.
  }
  return {
    ok: false,
    reason: "temporary-change-ambiguous",
    stage: movement.stage,
    record: ambiguous,
  };
}
