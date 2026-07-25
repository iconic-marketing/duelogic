/**
 * Development-only, in-process implementation of
 * CustomerConfirmationRepository, following the dev replacement-operation
 * store pattern (src/lib/pinch/dev-replacement-operation-store.ts).
 *
 * NON-DURABLE SANDBOX STORAGE: confirmation records live in process memory,
 * backed by `globalThis` so `next dev` hot reloads keep them, but they do
 * NOT survive a process or deployment restart. No database has been added.
 * This is sufficient only for the localhost-only sandbox flow; production
 * needs a durable CustomerConfirmationRepository (and real link delivery —
 * email and SMS are outside the current Build Weekend scope) before real
 * customers confirm anything. Nothing here may ever be described as durable.
 */

import {
  findForbiddenConfirmationRecordKey,
  type CustomerConfirmationRepository,
  type CustomerScheduleConfirmationRecord,
} from "./customer-confirmation";

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts: the
// `server-only` package is not installed in this project, so fail at import
// time if this module ever reaches browser code.
if (typeof window !== "undefined") {
  throw new Error(
    "The dev customer-confirmation store is server-only and must not be imported into browser code.",
  );
}

/** Oldest inserted confirmations are dropped beyond this cap. */
const MAX_CONFIRMATIONS = 100;

type ConfirmationMap = Map<string, CustomerScheduleConfirmationRecord>;

/**
 * Creates a fresh, isolated in-memory repository. Used by the deterministic
 * validation so scenarios never touch the shared development store. Records
 * are deep-copied on write and on read, so stored state can never be
 * mutated through a caller-held or caller-returned object, and write()
 * rejects any record carrying forbidden material (credentials, raw tokens,
 * card or bank details) or blank identity fields.
 */
export function createInMemoryCustomerConfirmationRepository(
  confirmations: ConfirmationMap = new Map(),
): CustomerConfirmationRepository {
  return {
    async write(record: CustomerScheduleConfirmationRecord): Promise<void> {
      if (
        typeof record.confirmationId !== "string" ||
        record.confirmationId.trim() === "" ||
        typeof record.tokenHash !== "string" ||
        record.tokenHash.trim() === ""
      ) {
        throw new Error(
          "Customer-confirmation store refused a record without a confirmation ID and token hash.",
        );
      }
      const forbiddenKey = findForbiddenConfirmationRecordKey(record);
      if (forbiddenKey !== null) {
        // The key name is generic schema vocabulary, never a value.
        throw new Error(
          `Customer-confirmation store refused a record carrying forbidden material under key "${forbiddenKey}".`,
        );
      }
      confirmations.set(record.confirmationId, structuredClone(record));
      while (confirmations.size > MAX_CONFIRMATIONS) {
        const oldest = confirmations.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        confirmations.delete(oldest);
      }
    },
    async readById(
      confirmationId: string,
    ): Promise<CustomerScheduleConfirmationRecord | null> {
      const record = confirmations.get(confirmationId.trim());
      return record === undefined ? null : structuredClone(record);
    },
    async readByTokenHash(
      tokenHash: string,
    ): Promise<CustomerScheduleConfirmationRecord | null> {
      for (const record of confirmations.values()) {
        if (record.tokenHash === tokenHash) {
          return structuredClone(record);
        }
      }
      return null;
    },
  };
}

interface GlobalWithCustomerConfirmationStore {
  __duelogicDevCustomerConfirmationStore?: ConfirmationMap;
}

/**
 * The shared development repository used by the dev routes: one in-memory
 * map per process, surviving hot reloads but not restarts.
 */
export function getDevCustomerConfirmationRepository(): CustomerConfirmationRepository {
  const holder = globalThis as GlobalWithCustomerConfirmationStore;
  holder.__duelogicDevCustomerConfirmationStore ??= new Map();
  return createInMemoryCustomerConfirmationRepository(
    holder.__duelogicDevCustomerConfirmationStore,
  );
}

/** Demo reset helper: drops every stored confirmation record. */
export function clearDevCustomerConfirmationStore(): void {
  const holder = globalThis as GlobalWithCustomerConfirmationStore;
  holder.__duelogicDevCustomerConfirmationStore?.clear();
}
