/**
 * Development-only, in-process implementation of
 * SubscriptionReplacementOperationRepository, following the dev outcome
 * store pattern (src/lib/pinch/dev-outcome-store.ts).
 *
 * NON-DURABLE SANDBOX STORAGE: records live in process memory, backed by
 * `globalThis` so `next dev` hot reloads keep them, but they do NOT survive a
 * process or deployment restart. This is sufficient only for the
 * localhost-only sandbox proof routes; a production implementation must
 * provide a durable SubscriptionReplacementOperationRepository before
 * executing real replacements. Nothing here may ever be described as durable.
 */

import {
  findForbiddenRecordKey,
  type SubscriptionReplacementOperationRecord,
  type SubscriptionReplacementOperationRepository,
} from "./replacement-operation";

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts: the
// `server-only` package is not installed in this project, so fail at import
// time if this module ever reaches browser code.
if (typeof window !== "undefined") {
  throw new Error(
    "The dev replacement-operation store is server-only and must not be imported into browser code.",
  );
}

/** Oldest inserted operations are dropped beyond this cap. */
const MAX_OPERATIONS = 50;

type OperationMap = Map<string, SubscriptionReplacementOperationRecord>;

/**
 * Creates a fresh, isolated in-memory repository. Used by the deterministic
 * validation so scenarios never touch the shared development store. Records
 * are deep-copied on write and on read, so stored state can never be mutated
 * through a caller-held or caller-returned object, and write() rejects any
 * record carrying forbidden material (credentials, tokens, card or bank
 * details) or a blank operation ID.
 */
export function createInMemoryReplacementOperationRepository(
  operations: OperationMap = new Map(),
): SubscriptionReplacementOperationRepository {
  return {
    async write(record: SubscriptionReplacementOperationRecord): Promise<void> {
      if (
        typeof record.operationId !== "string" ||
        record.operationId.trim() === ""
      ) {
        throw new Error(
          "Replacement-operation store refused a record without an operation ID.",
        );
      }
      const forbiddenKey = findForbiddenRecordKey(record);
      if (forbiddenKey !== null) {
        // The key name is generic schema vocabulary, never a value.
        throw new Error(
          `Replacement-operation store refused a record carrying forbidden material under key "${forbiddenKey}".`,
        );
      }
      operations.set(record.operationId, structuredClone(record));
      while (operations.size > MAX_OPERATIONS) {
        const oldest = operations.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        operations.delete(oldest);
      }
    },
    async read(
      operationId: string,
    ): Promise<SubscriptionReplacementOperationRecord | null> {
      const record = operations.get(operationId.trim());
      return record === undefined ? null : structuredClone(record);
    },
  };
}

interface GlobalWithReplacementOperationStore {
  __duelogicDevReplacementOperationStore?: OperationMap;
}

/**
 * The shared development repository used by the dev routes: one in-memory
 * map per process, surviving hot reloads but not restarts.
 */
export function getDevReplacementOperationRepository(): SubscriptionReplacementOperationRepository {
  const holder = globalThis as GlobalWithReplacementOperationStore;
  holder.__duelogicDevReplacementOperationStore ??= new Map();
  return createInMemoryReplacementOperationRepository(
    holder.__duelogicDevReplacementOperationStore,
  );
}

/** Demo reset helper: drops every stored operation record. */
export function clearDevReplacementOperationStore(): void {
  const holder = globalThis as GlobalWithReplacementOperationStore;
  holder.__duelogicDevReplacementOperationStore?.clear();
}
