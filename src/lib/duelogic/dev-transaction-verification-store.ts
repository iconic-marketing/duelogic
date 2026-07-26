/**
 * Development-only transaction-verification store and controlled rehearsal
 * seeding, following the established dev-store pattern
 * (src/lib/duelogic/dev-intervention-store.ts).
 *
 * NON-DURABLE SANDBOX STORAGE: records live in process memory, backed by
 * `globalThis` so `next dev` hot reloads keep them, but they do NOT survive
 * a process restart. This is temporary rehearsal infrastructure for one
 * controlled sandbox execution — NOT the final SMS/OTP implementation,
 * which will create records through a separate verified code-entry path
 * behind the same claim contract.
 *
 * Contract highlights:
 * - `create` is write-once per intervention: a second record for the same
 *   intervention is always refused and never overwrites the first.
 * - `claimForExecution` is atomic within the single-threaded event loop:
 *   its body contains no await between reading and consuming, so two
 *   concurrent claims can never both succeed. A mismatched, expired or
 *   consumed record refuses WITHOUT consuming; a successful claim sets
 *   consumedAt and is terminal — there is no rollback to unconsumed, even
 *   when later execution refuses before any mutation. A fresh verification
 *   (new intervention) is required for any later attempt.
 * - Rehearsal seeding constructs every binding value from the trusted
 *   server-held intervention record; the browser supplies only the review
 *   token. Records expire 10 minutes after creation.
 */

import { randomUUID } from "node:crypto";
import {
  effectiveInterventionStatus,
  transactionVerificationExpectationFor,
  type DueLogicInterventionRecord,
  type DueLogicInterventionRepository,
} from "./intervention";
import type {
  MerchantPolicyRepository,
  MerchantPolicySnapshot,
} from "./policy/policy-snapshot";
import {
  evaluateTransactionVerification,
  type ClaimableTransactionVerificationRepository,
  type TransactionVerificationRecord,
} from "./transaction-verification";

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts: the
// `server-only` package is not installed in this project, so fail at import
// time if this module ever reaches browser code.
if (typeof window !== "undefined") {
  throw new Error(
    "The dev transaction-verification store is server-only and must not be imported into browser code.",
  );
}

/** Controlled rehearsal lifetime: a seeded verification lasts 10 minutes. */
export const REHEARSAL_VERIFICATION_LIFETIME_MINUTES = 10;

type VerificationMap = Map<string, TransactionVerificationRecord>;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Structural validity of a complete record before it may be stored. */
function recordDefect(record: TransactionVerificationRecord): string | null {
  const identityFields: Array<[string, unknown]> = [
    ["verificationId", record.verificationId],
    ["interventionId", record.interventionId],
    ["merchantId", record.merchantId],
    ["payerId", record.payerId],
    ["subscriptionId", record.subscriptionId],
    ["selectedDate", record.selectedDate],
    ["policyVersion", record.policyVersion],
  ];
  for (const [field, value] of identityFields) {
    if (!nonEmpty(value)) {
      return field;
    }
  }
  const verifiedAt = Date.parse(record.verifiedAt);
  const expiresAt = Date.parse(record.expiresAt);
  if (Number.isNaN(verifiedAt) || Number.isNaN(expiresAt)) {
    return "timestamps";
  }
  if (expiresAt <= verifiedAt) {
    return "expiresAt";
  }
  if (record.consumedAt !== null) {
    return "consumedAt";
  }
  const schedulesValid = [record.currentPayments, record.proposedPayments].every(
    (payments) =>
      Array.isArray(payments) &&
      payments.length === 3 &&
      payments.every(
        (payment) =>
          nonEmpty(payment.paymentDate) &&
          Number.isInteger(payment.amountInCents) &&
          payment.amountInCents > 0,
      ),
  );
  return schedulesValid ? null : "payments";
}

/**
 * Creates a fresh, isolated in-memory verification repository. Used by the
 * deterministic validation so scenarios never touch the shared development
 * store. Every read and write passes through structuredClone, so no caller
 * ever holds a mutable reference to stored state.
 */
export function createInMemoryTransactionVerificationRepository(
  verifications: VerificationMap = new Map(),
): ClaimableTransactionVerificationRepository {
  return {
    async readVerifiedForIntervention(
      interventionId: string,
    ): Promise<TransactionVerificationRecord | null> {
      const record = verifications.get(interventionId.trim());
      return record === undefined ? null : structuredClone(record);
    },

    async create(record: TransactionVerificationRecord): Promise<void> {
      const defect = recordDefect(record);
      if (defect !== null) {
        // The defect name is generic schema vocabulary, never a value.
        throw new Error(
          `Transaction-verification store refused an invalid record (field "${defect}").`,
        );
      }
      if (verifications.has(record.interventionId)) {
        throw new Error(
          "Transaction-verification store refused a second record for the intervention; records are write-once.",
        );
      }
      verifications.set(record.interventionId, structuredClone(record));
      const readBack = verifications.get(record.interventionId);
      if (
        readBack === undefined ||
        JSON.stringify(readBack) !== JSON.stringify(record)
      ) {
        throw new Error(
          "Transaction-verification store could not read the record back after writing.",
        );
      }
    },

    // Atomic within the single-threaded event loop: NO await may ever
    // appear between the read and the consuming write below, so a second
    // concurrent claim always observes consumedAt already set and refuses.
    // A mismatched, expired or consumed record refuses without consuming;
    // a successful claim is terminal and never rolled back.
    async claimForExecution(interventionId, expectation, nowIso) {
      const stored = verifications.get(interventionId.trim());
      if (stored === undefined) {
        return null;
      }
      const evaluation = evaluateTransactionVerification(
        structuredClone(stored),
        expectation,
        nowIso,
      );
      if (!evaluation.ok) {
        return null;
      }
      const consumed: TransactionVerificationRecord = {
        ...structuredClone(stored),
        consumedAt: nowIso,
      };
      verifications.set(consumed.interventionId, structuredClone(consumed));
      const readBack = verifications.get(consumed.interventionId);
      if (readBack === undefined || readBack.consumedAt !== nowIso) {
        return null;
      }
      return structuredClone(consumed);
    },
  };
}

interface GlobalWithVerificationStore {
  __duelogicDevTransactionVerificationStore?: VerificationMap;
}

/**
 * The shared development repository used by the routes and pages: one
 * in-memory map per process, surviving hot reloads but not restarts.
 */
export function getDevTransactionVerificationRepository(): ClaimableTransactionVerificationRepository {
  const holder = globalThis as GlobalWithVerificationStore;
  holder.__duelogicDevTransactionVerificationStore ??= new Map();
  return createInMemoryTransactionVerificationRepository(
    holder.__duelogicDevTransactionVerificationStore,
  );
}

/** Reset helper for controlled development or validation use only. */
export function clearDevTransactionVerificationStore(): void {
  const holder = globalThis as GlobalWithVerificationStore;
  holder.__duelogicDevTransactionVerificationStore?.clear();
}

/**
 * Development-store-only targeted deletion for demo preparation: removes
 * the verification records belonging to exactly the named interventions
 * and nothing else. Returns the number removed; missing IDs are ignored.
 * Defaults to the shared development map; validation passes its own
 * isolated map. Never part of the claim contract.
 */
export function deleteTransactionVerificationsForInterventions(
  interventionIds: readonly string[],
  verifications?: VerificationMap,
): number {
  const holder = globalThis as GlobalWithVerificationStore;
  const target =
    verifications ??
    (holder.__duelogicDevTransactionVerificationStore ??= new Map());
  let deleted = 0;
  for (const id of interventionIds) {
    if (target.delete(id)) {
      deleted += 1;
    }
  }
  return deleted;
}

/** Server-generated verification identifier. Never accepted from a browser. */
export function generateTransactionVerificationId(): string {
  return `ver_${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Controlled rehearsal seeding

/**
 * Strict parse of the rehearsal seeding body: exactly `{ token }`. Any
 * other key — including any attempt to supply policyVersion, merchantId,
 * payerId, subscriptionId, dates, schedules, amounts, verificationId,
 * expiry, consumedAt or a complete record — rejects the request.
 */
export function parseRehearsalVerificationSeedInput(
  input: unknown,
): { token: string } | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "token") {
      return null;
    }
  }
  if (
    typeof record.token !== "string" ||
    record.token.trim() === "" ||
    record.token.length > 200
  ) {
    return null;
  }
  return { token: record.token };
}

export interface RehearsalVerificationSeedDeps {
  interventions: DueLogicInterventionRepository;
  verifications: ClaimableTransactionVerificationRepository;
  policies: MerchantPolicyRepository;
  now(): string;
  hashToken(rawToken: string): string;
  generateVerificationId(): string;
}

export type RehearsalVerificationSeedOutcome =
  | {
      ok: true;
      record: DueLogicInterventionRecord;
      /** Server-side only; routes must never return the full record. */
      verification: TransactionVerificationRecord;
    }
  | {
      ok: false;
      reason:
        | "not-found"
        | "not-seedable"
        | "policy-unresolved"
        | "already-seeded"
        | "store";
      record?: DueLogicInterventionRecord;
    };

/**
 * Creates the one controlled rehearsal verification record for a
 * preview-ready intervention. Every binding value — identity, selected
 * date, both exact schedules with amounts and the bound policyVersion —
 * comes from the trusted server-held intervention record; the caller
 * supplies only the customer review token. Expiry is exactly 10 minutes
 * after the server clock's verifiedAt. Write-once: a second seeding
 * attempt for the same intervention refuses and never replaces or extends
 * the first record.
 */
export async function seedRehearsalTransactionVerification(
  input: { token: string },
  deps: RehearsalVerificationSeedDeps,
): Promise<RehearsalVerificationSeedOutcome> {
  const record = await deps.interventions.readByTokenHash(
    deps.hashToken(input.token.trim()),
  );
  if (record === null) {
    return { ok: false, reason: "not-found" };
  }
  const nowIso = deps.now();

  // Seedable state: an unexpired preview-ready invitation with an approved
  // outcome, the exact stored schedules, and no execution linkage.
  if (
    effectiveInterventionStatus(record, nowIso) !== "preview-ready" ||
    record.policyOutcome !== "approved" ||
    record.selectedDate === null ||
    record.currentPayments === null ||
    record.currentPayments.length !== 3 ||
    record.proposedPayments === null ||
    record.proposedPayments.length !== 3 ||
    record.proposedPayments[0].paymentDate !== record.selectedDate ||
    record.confirmationId !== null ||
    record.operationId !== null ||
    record.newSubscriptionId !== null
  ) {
    return { ok: false, reason: "not-seedable", record };
  }

  // The bound policy version must still resolve — a verification must
  // never be seeded for an invitation whose governing policy is gone.
  let boundSnapshot: MerchantPolicySnapshot | null;
  try {
    boundSnapshot = await deps.policies.readByVersion(
      record.merchantId,
      record.policyVersion,
    );
  } catch {
    boundSnapshot = null;
  }
  if (
    boundSnapshot === null ||
    boundSnapshot.merchantId !== record.merchantId ||
    boundSnapshot.policyVersion !== record.policyVersion ||
    boundSnapshot.policyVersion !== boundSnapshot.policy.version
  ) {
    return { ok: false, reason: "policy-unresolved", record };
  }

  // Write-once: refuse before constructing anything when a record already
  // exists for this intervention (consumed or not).
  try {
    if (
      (await deps.verifications.readVerifiedForIntervention(
        record.interventionId,
      )) !== null
    ) {
      return { ok: false, reason: "already-seeded", record };
    }
  } catch {
    return { ok: false, reason: "store", record };
  }

  const verifiedMs = Date.parse(nowIso);
  if (Number.isNaN(verifiedMs)) {
    return { ok: false, reason: "store", record };
  }
  const expectation = transactionVerificationExpectationFor(record);
  const verification: TransactionVerificationRecord = {
    verificationId: deps.generateVerificationId(),
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
    expiresAt: new Date(
      verifiedMs + REHEARSAL_VERIFICATION_LIFETIME_MINUTES * 60_000,
    ).toISOString(),
    consumedAt: null,
  };
  try {
    await deps.verifications.create(verification);
  } catch {
    // Covers a concurrent seed that won the write-once race as well as any
    // store failure; nothing was replaced or extended either way.
    return { ok: false, reason: "already-seeded", record };
  }
  return { ok: true, record, verification };
}
