/**
 * Temporary payment-movement operation model: the server-side bindings,
 * verification, confirmation and operation evidence for moving ONE
 * scheduled Pinch payment (the Pinch payment ID never changes) through
 * the OTP-gated customer journey.
 *
 * Everything here is deliberately temporary-shaped: none of these types
 * reuse replacement-only vocabulary (planId, proposedStartDate, confirmed
 * subscription schedules), and nothing here touches the protected
 * permanent replacement path. The permanent records, stores, flow and
 * recovery ordering are completely unchanged.
 *
 * Pure data and deterministic functions only — no clock reads, storage,
 * Pinch calls or randomness. The dev stores live in
 * src/lib/duelogic/dev-temporary-operation-store.ts; the orchestration in
 * src/lib/duelogic/temporary-execution-service.ts.
 */

import type { PriorScheduleChange } from "./schema";

/**
 * The immutable server-side temporary operation selection: exactly one
 * Pinch payment and its exact current and proposed state, bound to the
 * intervention and its bound policy version. The browser is never
 * authoritative for any of these values; the final-confirmation request
 * can never supply or replace them. Only one active selection exists per
 * intervention; replacing it before verification invalidates every
 * earlier expectation, and after verification it is immutable (a re-bind
 * is refused while a verification record exists).
 */
export interface TemporaryOperationSelection {
  readonly kind: "temporary";
  readonly selectionId: string;
  readonly interventionId: string;
  readonly merchantId: string;
  readonly payerId: string;
  readonly paymentId: string;
  /** YYYY-MM-DD: the authoritative current transaction date at binding. */
  readonly originalTransactionDate: string;
  /** YYYY-MM-DD: the approved (or accepted-alternative) new date. */
  readonly proposedTransactionDate: string;
  readonly amountInCents: number;
  readonly currency: "AUD";
  readonly policyVersion: string;
  /** The deterministic decision evidence recorded at binding. */
  readonly policyReasonCode: string;
  readonly policyRuleFired: string;
  /** The date the customer originally asked for. */
  readonly requestedDate: string;
  /** Set when the bound date is an engine-offered alternative the customer accepted. */
  readonly acceptedAlternativeDate: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** The exact bound values a temporary verification or claim must match. */
export interface TemporaryVerificationExpectation {
  kind: "temporary";
  interventionId: string;
  merchantId: string;
  payerId: string;
  paymentId: string;
  originalTransactionDate: string;
  proposedTransactionDate: string;
  amountInCents: number;
  policyVersion: string;
}

/** Builds the claim expectation from the current active selection. */
export function temporaryVerificationExpectationFor(
  selection: TemporaryOperationSelection,
): TemporaryVerificationExpectation {
  return {
    kind: "temporary",
    interventionId: selection.interventionId,
    merchantId: selection.merchantId,
    payerId: selection.payerId,
    paymentId: selection.paymentId,
    originalTransactionDate: selection.originalTransactionDate,
    proposedTransactionDate: selection.proposedTransactionDate,
    amountInCents: selection.amountInCents,
    policyVersion: selection.policyVersion,
  };
}

/**
 * One OTP-created temporary transaction verification, bound to the exact
 * temporary movement it authorises. Single-use: the atomic claim sets
 * consumedAt exactly once and is terminal — never rolled back.
 */
export interface TemporaryTransactionVerificationRecord {
  readonly verificationId: string;
  readonly kind: "temporary";
  readonly interventionId: string;
  readonly merchantId: string;
  readonly payerId: string;
  readonly paymentId: string;
  readonly originalTransactionDate: string;
  readonly proposedTransactionDate: string;
  readonly amountInCents: number;
  readonly policyVersion: string;
  /** HMAC fingerprint of the trusted mobile the OTP was delivered to. */
  readonly trustedMobileFingerprint: string;
  readonly verifiedAt: string;
  readonly expiresAt: string;
  /** Claim linkage: non-null once an execution has consumed it. */
  readonly consumedAt: string | null;
}

export type TemporaryVerificationEvaluation =
  | { ok: true; record: TemporaryTransactionVerificationRecord }
  | {
      ok: false;
      reason: "missing" | "consumed" | "expired" | "invalid" | "mismatch";
    };

/**
 * Pure validity evaluation mirroring the permanent contract: unconsumed,
 * unexpired against the supplied clock, and binding every expected value
 * exactly — intervention, movement kind, payment ID, both dates, amount
 * and policy version. Any deviation refuses.
 */
export function evaluateTemporaryTransactionVerification(
  record: TemporaryTransactionVerificationRecord | null,
  expected: TemporaryVerificationExpectation,
  nowIso: string,
): TemporaryVerificationEvaluation {
  if (record === null) {
    return { ok: false, reason: "missing" };
  }
  if (record.consumedAt !== null) {
    return { ok: false, reason: "consumed" };
  }
  const now = Date.parse(nowIso);
  const verifiedAt = Date.parse(record.verifiedAt);
  const expiresAt = Date.parse(record.expiresAt);
  if (
    Number.isNaN(now) ||
    Number.isNaN(verifiedAt) ||
    Number.isNaN(expiresAt) ||
    record.verificationId.trim() === ""
  ) {
    return { ok: false, reason: "invalid" };
  }
  if (now >= expiresAt) {
    return { ok: false, reason: "expired" };
  }
  const bindings: Array<[string, string]> = [
    [record.kind, expected.kind],
    [record.interventionId, expected.interventionId],
    [record.merchantId, expected.merchantId],
    [record.payerId, expected.payerId],
    [record.paymentId, expected.paymentId],
    [record.originalTransactionDate, expected.originalTransactionDate],
    [record.proposedTransactionDate, expected.proposedTransactionDate],
    [record.policyVersion, expected.policyVersion],
  ];
  for (const [recorded, required] of bindings) {
    if (recorded !== required || required.trim() === "") {
      return { ok: false, reason: "mismatch" };
    }
  }
  if (
    !Number.isInteger(expected.amountInCents) ||
    expected.amountInCents <= 0 ||
    record.amountInCents !== expected.amountInCents
  ) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, record };
}

/**
 * The customer's recorded acceptance of one exact temporary movement.
 * Write-once and single-use: consumption binds the operation ID exactly
 * once. Proves what the customer accepted — never reused for any other
 * payment, date or amount.
 */
export interface TemporaryCustomerConfirmationRecord {
  readonly confirmationId: string;
  readonly interventionId: string;
  readonly merchantId: string;
  readonly payerId: string;
  readonly paymentId: string;
  readonly originalTransactionDate: string;
  readonly confirmedTransactionDate: string;
  readonly amountInCents: number;
  readonly policyVersion: string;
  readonly acceptedAt: string;
  readonly consumedAt: string | null;
  readonly operationId: string | null;
  readonly status: "accepted" | "consumed";
}

export const TEMPORARY_OPERATION_STATUSES = [
  "pending",
  "temporary-change-verified",
  "refused-before-mutation",
  "temporary-change-ambiguous",
  "manual-recovery-required",
] as const;

export type TemporaryOperationStatus =
  (typeof TEMPORARY_OPERATION_STATUSES)[number];

/**
 * Auditable evidence of one temporary payment operation: written and read
 * back BEFORE the mutation, updated through invocation and read-back, and
 * marked temporary-change-verified only after the Pinch read-back proves
 * the unchanged payment ID and the persisted confirmed transactionDate.
 */
export interface TemporaryPaymentOperationRecord {
  readonly operationId: string;
  readonly interventionId: string;
  readonly confirmationId: string;
  readonly merchantId: string;
  readonly payerId: string;
  readonly paymentId: string;
  readonly originalTransactionDate: string;
  readonly proposedTransactionDate: string;
  readonly amountInCents: number;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The fresh pre-claim authoritative read matched the binding. */
  readonly preflightState: "verified";
  readonly mutationState: "not-invoked" | "invoked";
  readonly readBackState: "not-read" | "verified" | "mismatched" | "unreadable";
  readonly status: TemporaryOperationStatus;
  /** Safe stage vocabulary for refusals, failures and ambiguity. */
  readonly failureStage: string | null;
  /** Set only on read-back-verified success. */
  readonly verifiedAt: string | null;
  readonly verifiedTransactionDate: string | null;
}

// ---------------------------------------------------------------------------
// Trusted temporary usage history

/**
 * The calendar date of an ISO instant in the merchant timezone (en-CA
 * renders numeric dates as YYYY-MM-DD) — the same proven conversion the
 * permanent prior-change derivation uses; never UTC slicing.
 */
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

/**
 * Derives the payer's trusted temporary prior-change history. ONLY
 * operations with final status temporary-change-verified AND a verified
 * read-back for the same merchant and payer produce an entry; previews,
 * OTP verifications, acceptance alone, refused, ambiguous, failed and
 * evidence-less attempts never count. Deduplicated by operationId
 * (earliest executed date wins, input-order invariant), sorted by id.
 * The rolling window itself is applied only by the policy engine's
 * approved boundary — this derivation states what verifiably happened.
 */
export function toTemporaryPriorScheduleChanges(
  operations: readonly TemporaryPaymentOperationRecord[],
  payerId: string,
  merchantId: string,
  merchantTimezone: string,
): readonly PriorScheduleChange[] {
  const byOperationId = new Map<string, PriorScheduleChange>();
  for (const operation of operations) {
    if (
      operation.payerId !== payerId ||
      operation.merchantId !== merchantId ||
      operation.status !== "temporary-change-verified" ||
      operation.readBackState !== "verified" ||
      operation.verifiedAt === null
    ) {
      continue;
    }
    const executedDate = merchantCalendarDateOfInstant(
      operation.verifiedAt,
      merchantTimezone,
    );
    if (executedDate === null) {
      continue;
    }
    const existing = byOperationId.get(operation.operationId);
    if (
      existing !== undefined &&
      existing.executedDate !== undefined &&
      existing.executedDate <= executedDate
    ) {
      continue;
    }
    byOperationId.set(operation.operationId, {
      id: operation.operationId,
      payerId: operation.payerId,
      changeType: "temporary",
      status: "executed-verified",
      executedDate,
    });
  }
  return [...byOperationId.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

/**
 * Combined policy-history input where the engine needs both movement
 * categories: a plain concatenation — the engine itself filters by payer
 * and change type, and remains the sole rolling-window authority.
 */
export function combinePriorScheduleChanges(
  ...lists: ReadonlyArray<readonly PriorScheduleChange[]>
): readonly PriorScheduleChange[] {
  return lists.flatMap((list) => list.map((entry) => ({ ...entry })));
}
