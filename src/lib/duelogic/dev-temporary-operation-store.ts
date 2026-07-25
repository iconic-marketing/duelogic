/**
 * Development-only stores for the temporary payment-movement journey:
 * operation selections, temporary transaction verifications, temporary
 * customer confirmations and temporary operation evidence — following the
 * established dev-store pattern (structuredClone in and out, read-back
 * verified writes, event-loop-atomic single-use transitions).
 *
 * NON-DURABLE SANDBOX STORAGE: records live in process memory, backed by
 * `globalThis` (hot reloads keep them, restarts do not). Durable storage
 * replaces these repository implementations, never the contracts.
 *
 * Contract highlights:
 * - selections: exactly one active per intervention; `bind` replaces the
 *   previous selection (the verification-active guard lives in the
 *   service, which refuses re-binding while a verification exists);
 * - verifications: `create` is write-once per intervention;
 *   `claimForExecution` re-evaluates every bound field and consumes the
 *   record single-use in one event-loop-atomic operation — terminal,
 *   never rolled back;
 * - confirmations: write-once per confirmationId; `consume` is atomic
 *   single-use and binds the operation ID exactly once;
 * - operations: upsert with read-back verification, listable for the
 *   trusted usage derivation.
 */

import { randomUUID } from "node:crypto";
import {
  evaluateTemporaryTransactionVerification,
  type TemporaryCustomerConfirmationRecord,
  type TemporaryOperationSelection,
  type TemporaryPaymentOperationRecord,
  type TemporaryTransactionVerificationRecord,
  type TemporaryVerificationExpectation,
} from "./temporary-operation";

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts.
if (typeof window !== "undefined") {
  throw new Error(
    "The dev temporary-operation store is server-only and must not be imported into browser code.",
  );
}

/** Key names that must never appear in any stored temporary record. */
const FORBIDDEN_KEY_PATTERN =
  /token|secret|credential|password|apikey|api_key|card|cvv|cvc|bank|bsb|routing|iban|email|phone|mobileNumber/i;

function assertNoForbiddenKeys(value: object, store: string): void {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      // The key name is generic schema vocabulary, never a value.
      throw new Error(
        `${store} refused a record carrying forbidden material under key "${key}".`,
      );
    }
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

// ---------------------------------------------------------------------------
// Operation selections

export interface TemporaryOperationSelectionRepository {
  /** Replaces any previous selection for the intervention (read-back verified). */
  bind(selection: TemporaryOperationSelection): Promise<void>;
  readActive(
    interventionId: string,
  ): Promise<TemporaryOperationSelection | null>;
}

type SelectionMap = Map<string, TemporaryOperationSelection>;

export function createInMemoryTemporarySelectionRepository(
  selections: SelectionMap = new Map(),
): TemporaryOperationSelectionRepository {
  return {
    async bind(selection: TemporaryOperationSelection): Promise<void> {
      assertNoForbiddenKeys(selection, "Temporary selection store");
      const required: Array<[string, unknown]> = [
        ["selectionId", selection.selectionId],
        ["interventionId", selection.interventionId],
        ["merchantId", selection.merchantId],
        ["payerId", selection.payerId],
        ["paymentId", selection.paymentId],
        ["originalTransactionDate", selection.originalTransactionDate],
        ["proposedTransactionDate", selection.proposedTransactionDate],
        ["policyVersion", selection.policyVersion],
      ];
      for (const [field, value] of required) {
        if (!nonEmpty(value)) {
          throw new Error(
            `Temporary selection store refused an invalid record (field "${field}").`,
          );
        }
      }
      if (
        selection.kind !== "temporary" ||
        !Number.isInteger(selection.amountInCents) ||
        selection.amountInCents <= 0 ||
        Number.isNaN(Date.parse(selection.createdAt)) ||
        Number.isNaN(Date.parse(selection.expiresAt))
      ) {
        throw new Error(
          "Temporary selection store refused a structurally invalid record.",
        );
      }
      selections.set(selection.interventionId, structuredClone(selection));
      const readBack = selections.get(selection.interventionId);
      if (
        readBack === undefined ||
        JSON.stringify(readBack) !== JSON.stringify(selection)
      ) {
        throw new Error(
          "Temporary selection store could not read the selection back after writing.",
        );
      }
    },
    async readActive(
      interventionId: string,
    ): Promise<TemporaryOperationSelection | null> {
      const record = selections.get(interventionId.trim());
      return record === undefined ? null : structuredClone(record);
    },
  };
}

// ---------------------------------------------------------------------------
// Temporary transaction verifications

export interface TemporaryVerificationRepository {
  /** Write-once per intervention; a second record is always refused. */
  create(record: TemporaryTransactionVerificationRecord): Promise<void>;
  readForIntervention(
    interventionId: string,
  ): Promise<TemporaryTransactionVerificationRecord | null>;
  /**
   * ATOMIC single-use claim: re-evaluates every bound field against the
   * supplied expectation and consumes the record in one event-loop-atomic
   * operation. Refuses missing/expired/consumed/mismatched records
   * without consuming; a successful claim is terminal.
   */
  claimForExecution(
    interventionId: string,
    expectation: TemporaryVerificationExpectation,
    nowIso: string,
  ): Promise<TemporaryTransactionVerificationRecord | null>;
}

type VerificationMap = Map<string, TemporaryTransactionVerificationRecord>;

export function createInMemoryTemporaryVerificationRepository(
  verifications: VerificationMap = new Map(),
): TemporaryVerificationRepository {
  return {
    async create(
      record: TemporaryTransactionVerificationRecord,
    ): Promise<void> {
      assertNoForbiddenKeys(record, "Temporary verification store");
      if (
        record.kind !== "temporary" ||
        !nonEmpty(record.verificationId) ||
        !nonEmpty(record.interventionId) ||
        !nonEmpty(record.paymentId) ||
        !nonEmpty(record.trustedMobileFingerprint) ||
        !Number.isInteger(record.amountInCents) ||
        record.amountInCents <= 0 ||
        Number.isNaN(Date.parse(record.verifiedAt)) ||
        Number.isNaN(Date.parse(record.expiresAt)) ||
        record.consumedAt !== null
      ) {
        throw new Error(
          "Temporary verification store refused a structurally invalid record.",
        );
      }
      if (verifications.has(record.interventionId)) {
        throw new Error(
          "Temporary verification store refused a second record for the intervention; records are write-once.",
        );
      }
      verifications.set(record.interventionId, structuredClone(record));
      const readBack = verifications.get(record.interventionId);
      if (
        readBack === undefined ||
        JSON.stringify(readBack) !== JSON.stringify(record)
      ) {
        throw new Error(
          "Temporary verification store could not read the record back after writing.",
        );
      }
    },

    async readForIntervention(
      interventionId: string,
    ): Promise<TemporaryTransactionVerificationRecord | null> {
      const record = verifications.get(interventionId.trim());
      return record === undefined ? null : structuredClone(record);
    },

    // Atomic within the single-threaded event loop: NO await between the
    // read and the consuming write. A mismatched, expired or consumed
    // record refuses without consuming; a successful claim is terminal.
    async claimForExecution(interventionId, expectation, nowIso) {
      const stored = verifications.get(interventionId.trim());
      if (stored === undefined) {
        return null;
      }
      const evaluation = evaluateTemporaryTransactionVerification(
        structuredClone(stored),
        expectation,
        nowIso,
      );
      if (!evaluation.ok) {
        return null;
      }
      const consumed: TemporaryTransactionVerificationRecord = {
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

// ---------------------------------------------------------------------------
// Temporary customer confirmations

export interface TemporaryConfirmationRepository {
  /** Write-once by confirmationId. */
  create(record: TemporaryCustomerConfirmationRecord): Promise<void>;
  readById(
    confirmationId: string,
  ): Promise<TemporaryCustomerConfirmationRecord | null>;
  /**
   * ATOMIC single-use consumption: binds the operation ID exactly once.
   * Returns null (consuming nothing) when the record is missing or
   * already consumed.
   */
  consume(
    confirmationId: string,
    operationId: string,
    nowIso: string,
  ): Promise<TemporaryCustomerConfirmationRecord | null>;
}

type ConfirmationMap = Map<string, TemporaryCustomerConfirmationRecord>;

export function createInMemoryTemporaryConfirmationRepository(
  confirmations: ConfirmationMap = new Map(),
): TemporaryConfirmationRepository {
  return {
    async create(record: TemporaryCustomerConfirmationRecord): Promise<void> {
      assertNoForbiddenKeys(record, "Temporary confirmation store");
      if (
        !nonEmpty(record.confirmationId) ||
        !nonEmpty(record.interventionId) ||
        !nonEmpty(record.paymentId) ||
        !nonEmpty(record.originalTransactionDate) ||
        !nonEmpty(record.confirmedTransactionDate) ||
        !Number.isInteger(record.amountInCents) ||
        record.amountInCents <= 0 ||
        Number.isNaN(Date.parse(record.acceptedAt)) ||
        record.consumedAt !== null ||
        record.operationId !== null ||
        record.status !== "accepted"
      ) {
        throw new Error(
          "Temporary confirmation store refused a structurally invalid record.",
        );
      }
      if (confirmations.has(record.confirmationId)) {
        throw new Error(
          "Temporary confirmation store refused a duplicate confirmationId; records are write-once.",
        );
      }
      confirmations.set(record.confirmationId, structuredClone(record));
      const readBack = confirmations.get(record.confirmationId);
      if (
        readBack === undefined ||
        JSON.stringify(readBack) !== JSON.stringify(record)
      ) {
        throw new Error(
          "Temporary confirmation store could not read the record back after writing.",
        );
      }
    },

    async readById(
      confirmationId: string,
    ): Promise<TemporaryCustomerConfirmationRecord | null> {
      const record = confirmations.get(confirmationId.trim());
      return record === undefined ? null : structuredClone(record);
    },

    // Atomic within the single-threaded event loop: no await between read
    // and consuming write; a consumed record can never be consumed again.
    async consume(confirmationId, operationId, nowIso) {
      const stored = confirmations.get(confirmationId.trim());
      if (
        stored === undefined ||
        stored.status !== "accepted" ||
        stored.consumedAt !== null ||
        !nonEmpty(operationId) ||
        Number.isNaN(Date.parse(nowIso))
      ) {
        return null;
      }
      const consumed: TemporaryCustomerConfirmationRecord = {
        ...structuredClone(stored),
        status: "consumed",
        consumedAt: nowIso,
        operationId,
      };
      confirmations.set(consumed.confirmationId, structuredClone(consumed));
      const readBack = confirmations.get(consumed.confirmationId);
      if (readBack === undefined || readBack.consumedAt !== nowIso) {
        return null;
      }
      return structuredClone(consumed);
    },
  };
}

// ---------------------------------------------------------------------------
// Temporary operation evidence

export interface TemporaryOperationRepository {
  /** Upsert with verified read-back (evidence-before-mutation contract). */
  write(record: TemporaryPaymentOperationRecord): Promise<void>;
  read(operationId: string): Promise<TemporaryPaymentOperationRecord | null>;
  list(): Promise<TemporaryPaymentOperationRecord[]>;
}

type OperationMap = Map<string, TemporaryPaymentOperationRecord>;

export function createInMemoryTemporaryOperationRepository(
  operations: OperationMap = new Map(),
): TemporaryOperationRepository {
  return {
    async write(record: TemporaryPaymentOperationRecord): Promise<void> {
      assertNoForbiddenKeys(record, "Temporary operation store");
      if (
        !nonEmpty(record.operationId) ||
        !nonEmpty(record.interventionId) ||
        !nonEmpty(record.confirmationId) ||
        !nonEmpty(record.paymentId) ||
        !Number.isInteger(record.amountInCents) ||
        record.amountInCents <= 0
      ) {
        throw new Error(
          "Temporary operation store refused a structurally invalid record.",
        );
      }
      operations.set(record.operationId, structuredClone(record));
      const readBack = operations.get(record.operationId);
      if (
        readBack === undefined ||
        JSON.stringify(readBack) !== JSON.stringify(record)
      ) {
        throw new Error(
          "Temporary operation store could not read the record back after writing.",
        );
      }
    },
    async read(
      operationId: string,
    ): Promise<TemporaryPaymentOperationRecord | null> {
      const record = operations.get(operationId.trim());
      return record === undefined ? null : structuredClone(record);
    },
    async list(): Promise<TemporaryPaymentOperationRecord[]> {
      return [...operations.values()].map((record) => structuredClone(record));
    },
  };
}

// ---------------------------------------------------------------------------
// Shared development repositories (globalThis-backed, per process)

interface GlobalWithTemporaryStores {
  __duelogicDevTemporarySelectionStore?: SelectionMap;
  __duelogicDevTemporaryVerificationStore?: VerificationMap;
  __duelogicDevTemporaryConfirmationStore?: ConfirmationMap;
  __duelogicDevTemporaryOperationStore?: OperationMap;
}

export function getDevTemporarySelectionRepository(): TemporaryOperationSelectionRepository {
  const holder = globalThis as GlobalWithTemporaryStores;
  holder.__duelogicDevTemporarySelectionStore ??= new Map();
  return createInMemoryTemporarySelectionRepository(
    holder.__duelogicDevTemporarySelectionStore,
  );
}

export function getDevTemporaryVerificationRepository(): TemporaryVerificationRepository {
  const holder = globalThis as GlobalWithTemporaryStores;
  holder.__duelogicDevTemporaryVerificationStore ??= new Map();
  return createInMemoryTemporaryVerificationRepository(
    holder.__duelogicDevTemporaryVerificationStore,
  );
}

export function getDevTemporaryConfirmationRepository(): TemporaryConfirmationRepository {
  const holder = globalThis as GlobalWithTemporaryStores;
  holder.__duelogicDevTemporaryConfirmationStore ??= new Map();
  return createInMemoryTemporaryConfirmationRepository(
    holder.__duelogicDevTemporaryConfirmationStore,
  );
}

export function getDevTemporaryOperationRepository(): TemporaryOperationRepository {
  const holder = globalThis as GlobalWithTemporaryStores;
  holder.__duelogicDevTemporaryOperationStore ??= new Map();
  return createInMemoryTemporaryOperationRepository(
    holder.__duelogicDevTemporaryOperationStore,
  );
}

export function generateTemporarySelectionId(): string {
  return `tsel_${randomUUID()}`;
}

export function generateTemporaryVerificationId(): string {
  return `tver_${randomUUID()}`;
}

export function generateTemporaryConfirmationId(): string {
  return `tconf_${randomUUID()}`;
}

export function generateTemporaryOperationId(): string {
  return `duelogic-tmp-${randomUUID()}`;
}
