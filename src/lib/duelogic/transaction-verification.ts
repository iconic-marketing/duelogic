/**
 * Customer transaction-verification contract for Stage 2 execution gating.
 *
 * CLAUDE.md requires a separate one-time customer verification step before
 * final confirmation can initiate cancellation and replacement: possession
 * of the tokenised review link alone must never authorise a live Pinch
 * subscription mutation. This module defines the minimum record type, the
 * READ-ONLY repository contract and the pure validity evaluation that gate
 * needs — nothing more.
 *
 * Deliberately absent, by design: code generation, SMS delivery, code
 * entry, resend handling and any repository WRITE path. No verified record
 * can currently be created anywhere in the application, so the development
 * repository below always returns null and every execution gate refuses
 * today. The later OTP stage adds record creation and a real repository
 * implementation behind this same contract without changing
 * confirmInterventionExecution.
 *
 * Pure data and functions only — no Pinch calls, no clock reads, no
 * storage, no token or code material of any kind.
 */

import {
  confirmedPaymentsEqual,
  type ConfirmedSchedulePayment,
} from "@/lib/pinch/customer-confirmation";

/**
 * One verified customer transaction verification, bound to the exact
 * intervention and schedule it authorises. IDs, dates and integer cents
 * only — never phone numbers, codes, code hashes or delivery artefacts
 * (those belong to the future OTP stage's own storage, not here).
 */
export interface TransactionVerificationRecord {
  /** The verification/confirmation-attempt identifier. */
  readonly verificationId: string;
  readonly interventionId: string;
  readonly merchantId: string;
  readonly payerId: string;
  readonly subscriptionId: string;
  /** YYYY-MM-DD: the approved selected date this verification covers. */
  readonly selectedDate: string;
  /** The exact schedules shown when the customer verified. */
  readonly currentPayments: readonly ConfirmedSchedulePayment[];
  readonly proposedPayments: readonly ConfirmedSchedulePayment[];
  readonly policyVersion: string;
  /** ISO timestamp of the successful verification. */
  readonly verifiedAt: string;
  /** ISO timestamp; evaluated server-side on every read. */
  readonly expiresAt: string;
  /** Single-use state: non-null once an execution has consumed it. */
  readonly consumedAt: string | null;
}

/**
 * Read-only storage boundary: the gate may only ask whether a verified
 * record exists for an intervention. No write, update, consume or delete
 * behaviour is defined here — the later OTP stage owns record lifecycle.
 */
export interface TransactionVerificationRepository {
  readVerifiedForIntervention(
    interventionId: string,
  ): Promise<TransactionVerificationRecord | null>;
}

/** The server-held values a usable verification must bind exactly. */
export interface TransactionVerificationExpectation {
  interventionId: string;
  merchantId: string;
  payerId: string;
  subscriptionId: string;
  selectedDate: string;
  currentPayments: readonly ConfirmedSchedulePayment[];
  proposedPayments: readonly ConfirmedSchedulePayment[];
  policyVersion: string;
}

export type TransactionVerificationEvaluation =
  | { ok: true; record: TransactionVerificationRecord }
  | {
      ok: false;
      reason: "missing" | "consumed" | "expired" | "invalid" | "mismatch";
    };

/**
 * Pure validity evaluation: the record must exist, be unconsumed and
 * unexpired (against the supplied clock value — client time is never
 * authoritative), carry parseable timestamps, and bind exactly the
 * intervention, merchant, payer, subscription, selected date, both
 * schedules and the policy version of the pending change. Any deviation
 * refuses. Never calls Pinch and never reads a clock.
 */
export function evaluateTransactionVerification(
  record: TransactionVerificationRecord | null,
  expected: TransactionVerificationExpectation,
  nowIso: string,
): TransactionVerificationEvaluation {
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
  const identityBindings: Array<[string, string]> = [
    [record.interventionId, expected.interventionId],
    [record.merchantId, expected.merchantId],
    [record.payerId, expected.payerId],
    [record.subscriptionId, expected.subscriptionId],
    [record.selectedDate, expected.selectedDate],
    [record.policyVersion, expected.policyVersion],
  ];
  for (const [recorded, required] of identityBindings) {
    if (recorded !== required || required.trim() === "") {
      return { ok: false, reason: "mismatch" };
    }
  }
  if (
    expected.currentPayments.length === 0 ||
    expected.proposedPayments.length === 0 ||
    !confirmedPaymentsEqual(record.currentPayments, expected.currentPayments) ||
    !confirmedPaymentsEqual(record.proposedPayments, expected.proposedPayments)
  ) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, record };
}

/**
 * The development repository: deliberately empty. The application contains
 * no write path for transaction-verification records, so this always
 * returns null and every execution gate refuses. It exists so the wiring
 * (route, page, gate) is complete and the later OTP stage only has to
 * supply a real implementation behind the same read contract.
 */
export function createEmptyDevTransactionVerificationRepository(): TransactionVerificationRepository {
  return {
    async readVerifiedForIntervention(): Promise<TransactionVerificationRecord | null> {
      return null;
    },
  };
}
