/**
 * Types and pure helpers for the subscription-replacement audit and recovery
 * record. Permanent subscription changes in Pinch are a destructive
 * cancel-then-create sequence, so the execution layer must persist, before
 * cancelling anything, everything a human (or a future recovery command)
 * needs to reinstate the original subscription — and must keep a permanent
 * old-to-new subscription ID mapping once a replacement is verified.
 *
 * This module is pure data and functions: no Pinch calls, no clock reads and
 * no storage. The repository interface at the bottom is deliberately small so
 * a durable store can replace the in-memory sandbox implementation
 * (src/lib/pinch/dev-replacement-operation-store.ts) without touching the
 * orchestration flow or the routes.
 */

export const SUBSCRIPTION_REPLACEMENT_OPERATION_STATUSES = [
  "preflight-complete",
  "recovery-recorded",
  "original-cancelled",
  "replacement-created",
  "replacement-verified",
  "manual-recovery-required",
] as const;

export type SubscriptionReplacementOperationStatus =
  (typeof SUBSCRIPTION_REPLACEMENT_OPERATION_STATUSES)[number];

/**
 * The exact stage the operation last confirmed (progress stages) or the exact
 * stage at which it failed (failure stages). "replacement-ambiguous" mirrors
 * the existing route stage of the same name: creation reported success but no
 * subscription ID could be extracted, so a replacement may exist.
 */
export const SUBSCRIPTION_REPLACEMENT_OPERATION_STAGES = [
  "preflight",
  "recovery-recorded",
  "original-cancelled",
  "replacement-created",
  "replacement-verified",
  "cancel-verification-failed",
  "replacement-create-failed",
  "replacement-ambiguous",
  "replacement-verification-failed",
] as const;

export type SubscriptionReplacementOperationStage =
  (typeof SUBSCRIPTION_REPLACEMENT_OPERATION_STAGES)[number];

/**
 * The exact body POST /subscriptions would receive to reinstate the original
 * subscription — the same four (or five) allowed fields the live route
 * submits for a replacement, never merchantId (header-only), never operation
 * metadata. totalAmount appears only when the plan requires it.
 */
export interface SubscriptionReinstatementCreateBody {
  planId: string;
  payerId: string;
  sourceId: string;
  /** YYYY-MM-DD. */
  startDate: string;
  /** Integer cents; present only when the plan requires totalAmount. */
  totalAmount?: number;
}

export interface CalculatedPaymentSummary {
  /** YYYY-MM-DD in the merchant timezone. */
  transactionDate: string;
  /** Integer cents. */
  amountCents: number;
}

/**
 * Immutable snapshot captured before the original subscription is cancelled:
 * the merchant-scoped values required to reinstate it without reconstructing
 * anything from memory. IDs, dates and integer cents only — never
 * credentials, tokens, card, bank or customer identity data.
 */
export interface SubscriptionReplacementRecoverySnapshot {
  merchantId: string;
  payerId: string;
  sourceId: string;
  planId: string;
  /** YYYY-MM-DD; the start date a reinstated subscription would use. */
  originalStartDate: string;
  /** Integer cents; present only when the plan requires totalAmount. */
  totalAmountCents?: number;
  /** Traceability back to the subscription this snapshot can reinstate. */
  oldSubscriptionId: string;
  reinstatementCreateBody: SubscriptionReinstatementCreateBody;
  /**
   * First calculated payments of the ORIGINAL schedule (original start
   * date), so a human can check a reinstatement against what existed.
   */
  originalCalculatedPayments: CalculatedPaymentSummary[];
}

/**
 * The verified old-to-new subscription mapping recorded after read-back
 * verification succeeds. sourceId is present only where the read-back
 * exposed it.
 */
export interface VerifiedReplacementMapping {
  oldSubscriptionId: string;
  newSubscriptionId: string;
  /** YYYY-MM-DD; the start date confirmed by read-back. */
  verifiedStartDate: string;
  planId: string;
  payerId: string;
  sourceId?: string;
  /** First three verified payment dates, YYYY-MM-DD, in schedule order. */
  paymentDates: string[];
  /** Integer cents, aligned with paymentDates. */
  paymentAmountsCents: number[];
}

export interface SubscriptionReplacementOperationRecord {
  operationId: string;
  merchantId: string;
  payerId: string;
  planId: string;
  sourceId: string;
  oldSubscriptionId: string;
  /** Null until a replacement subscription ID has been extracted. */
  newSubscriptionId: string | null;
  /** YYYY-MM-DD; the original subscription's start date. */
  previousStartDate: string;
  /** YYYY-MM-DD; the requested replacement start date. */
  requestedStartDate: string;
  /** Integer cents; null where the plan does not require totalAmount. */
  previousTotalAmountCents: number | null;
  /** Integer cents; null where the plan does not require totalAmount. */
  requestedTotalAmountCents: number | null;
  status: SubscriptionReplacementOperationStatus;
  currentStage: SubscriptionReplacementOperationStage;
  recoverySnapshot: SubscriptionReplacementRecoverySnapshot;
  /** Null until read-back verification succeeds. */
  verifiedReplacement: VerifiedReplacementMapping | null;
  /** Stable failure code, null while no failure has occurred. */
  failureCode: string | null;
  /**
   * Sanitised human-readable failure text: error class and upstream HTTP
   * status only — never upstream response content.
   */
  failureMessage: string | null;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp. */
  updatedAt: string;
}

/**
 * Small persistence boundary so durable storage can replace the in-memory
 * sandbox store later. write() creates or replaces the record stored under
 * record.operationId; read() returns an independent copy or null.
 */
export interface SubscriptionReplacementOperationRepository {
  write(record: SubscriptionReplacementOperationRecord): Promise<void>;
  read(
    operationId: string,
  ): Promise<SubscriptionReplacementOperationRecord | null>;
}

/**
 * Key names that must never appear anywhere in a stored operation record:
 * credentials, tokens and card/bank source material. Matched
 * case-insensitively against every nested object key. The record schema
 * above contains no matching key; anything that does match indicates unsafe
 * material was smuggled into a record and the write must be rejected.
 */
const FORBIDDEN_RECORD_KEY_PATTERN =
  /token|secret|credential|password|apikey|api_key|card|cvv|cvc|expiry|bank|bsb|account|routing|iban|email|phone|address/i;

/**
 * Depth-first search for a forbidden key anywhere in the value. Returns the
 * first offending key name, or null when the value is safe to store.
 */
export function findForbiddenRecordKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findForbiddenRecordKey(entry);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_RECORD_KEY_PATTERN.test(key)) {
        return key;
      }
      const found = findForbiddenRecordKey(nested);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/**
 * The safe projection returned by the operation lookup route: status, stage,
 * IDs, the old-to-new mapping, recovery availability, sanitised failure
 * information and timestamps. The recovery snapshot itself (including the
 * reinstatement payload) is deliberately not projected — recovery is a
 * manual, server-side concern.
 */
export interface SafeReplacementOperationProjection {
  operationId: string;
  status: SubscriptionReplacementOperationStatus;
  currentStage: SubscriptionReplacementOperationStage;
  oldSubscriptionId: string;
  newSubscriptionId: string | null;
  mapping: VerifiedReplacementMapping | null;
  recoveryAvailable: boolean;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toSafeReplacementOperationProjection(
  record: SubscriptionReplacementOperationRecord,
): SafeReplacementOperationProjection {
  return {
    operationId: record.operationId,
    status: record.status,
    currentStage: record.currentStage,
    oldSubscriptionId: record.oldSubscriptionId,
    newSubscriptionId: record.newSubscriptionId,
    mapping:
      record.verifiedReplacement === null
        ? null
        : {
            oldSubscriptionId: record.verifiedReplacement.oldSubscriptionId,
            newSubscriptionId: record.verifiedReplacement.newSubscriptionId,
            verifiedStartDate: record.verifiedReplacement.verifiedStartDate,
            planId: record.verifiedReplacement.planId,
            payerId: record.verifiedReplacement.payerId,
            ...(record.verifiedReplacement.sourceId !== undefined
              ? { sourceId: record.verifiedReplacement.sourceId }
              : {}),
            paymentDates: [...record.verifiedReplacement.paymentDates],
            paymentAmountsCents: [
              ...record.verifiedReplacement.paymentAmountsCents,
            ],
          },
    recoveryAvailable:
      record.recoverySnapshot.reinstatementCreateBody.planId !== "" &&
      record.recoverySnapshot.oldSubscriptionId === record.oldSubscriptionId,
    failureCode: record.failureCode,
    failureMessage: record.failureMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
