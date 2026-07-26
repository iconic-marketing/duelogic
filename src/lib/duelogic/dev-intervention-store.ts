/**
 * Development-only, in-process implementation of the intervention and
 * notification repositories, following the dev customer-confirmation store
 * pattern (src/lib/pinch/dev-customer-confirmation-store.ts).
 *
 * NON-DURABLE SANDBOX STORAGE: records live in process memory, backed by
 * `globalThis` so `next dev` hot reloads keep them, but they do NOT survive
 * a process or deployment restart. No database has been added. This is
 * sufficient only for the localhost-only Stage 1 journey; production needs
 * durable repositories before real customers receive invitations. Nothing
 * here may ever be described as durable.
 *
 * Intervention records store only the SHA-256 token hash; the notification
 * map holds the customer delivery artefacts, whose reviewPath is the single
 * permitted location of the raw link token. Notifications are customer
 * inbox content only and must never be returned through merchant
 * monitoring.
 */

import {
  findForbiddenInterventionRecordKey,
  type DueLogicInterventionRecord,
  type DueLogicInterventionRepository,
  type InterventionCustomerNotification,
  type InterventionNotificationRepository,
} from "./intervention";

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts: the
// `server-only` package is not installed in this project, so fail at import
// time if this module ever reaches browser code.
if (typeof window !== "undefined") {
  throw new Error(
    "The dev intervention store is server-only and must not be imported into browser code.",
  );
}

/** Oldest inserted records are dropped beyond this cap. */
const MAX_RECORDS = 100;

type InterventionMap = Map<string, DueLogicInterventionRecord>;
type NotificationMap = Map<string, InterventionCustomerNotification>;

/**
 * Creates a fresh, isolated in-memory intervention repository. Used by the
 * deterministic validation so scenarios never touch the shared development
 * store. Records are deep-copied on write and on read, so stored state can
 * never be mutated through a caller-held or caller-returned object, and
 * write() rejects any record carrying forbidden material (credentials, raw
 * tokens, card or bank details) or blank identity fields.
 */
export function createInMemoryInterventionRepository(
  interventions: InterventionMap = new Map(),
): DueLogicInterventionRepository {
  return {
    async write(record: DueLogicInterventionRecord): Promise<void> {
      if (
        typeof record.interventionId !== "string" ||
        record.interventionId.trim() === "" ||
        typeof record.tokenHash !== "string" ||
        record.tokenHash.trim() === ""
      ) {
        throw new Error(
          "Intervention store refused a record without an intervention ID and token hash.",
        );
      }
      const forbiddenKey = findForbiddenInterventionRecordKey(record);
      if (forbiddenKey !== null) {
        // The key name is generic schema vocabulary, never a value.
        throw new Error(
          `Intervention store refused a record carrying forbidden material under key "${forbiddenKey}".`,
        );
      }
      interventions.set(record.interventionId, structuredClone(record));
      while (interventions.size > MAX_RECORDS) {
        const oldest = interventions.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        interventions.delete(oldest);
      }
    },
    async readById(
      interventionId: string,
    ): Promise<DueLogicInterventionRecord | null> {
      const record = interventions.get(interventionId.trim());
      return record === undefined ? null : structuredClone(record);
    },
    async readByTokenHash(
      tokenHash: string,
    ): Promise<DueLogicInterventionRecord | null> {
      for (const record of interventions.values()) {
        if (record.tokenHash === tokenHash) {
          return structuredClone(record);
        }
      }
      return null;
    },
    async list(): Promise<DueLogicInterventionRecord[]> {
      return [...interventions.values()].map((record) =>
        structuredClone(record),
      );
    },
  };
}

/**
 * Creates a fresh, isolated in-memory notification repository. The
 * notification is the customer delivery artefact: its reviewPath carries
 * the raw link token by design, so this store applies no token-key guard —
 * it must simply never be exposed through merchant monitoring.
 */
export function createInMemoryInterventionNotificationRepository(
  notifications: NotificationMap = new Map(),
): InterventionNotificationRepository {
  return {
    async write(
      notification: InterventionCustomerNotification,
    ): Promise<void> {
      if (
        typeof notification.notificationId !== "string" ||
        notification.notificationId.trim() === "" ||
        typeof notification.interventionId !== "string" ||
        notification.interventionId.trim() === ""
      ) {
        throw new Error(
          "Notification store refused a record without notification and intervention IDs.",
        );
      }
      notifications.set(
        notification.notificationId,
        structuredClone(notification),
      );
      while (notifications.size > MAX_RECORDS) {
        const oldest = notifications.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        notifications.delete(oldest);
      }
    },
    async list(): Promise<InterventionCustomerNotification[]> {
      return [...notifications.values()].map((notification) =>
        structuredClone(notification),
      );
    },
  };
}

interface GlobalWithInterventionStore {
  __duelogicDevInterventionStore?: InterventionMap;
  __duelogicDevInterventionNotificationStore?: NotificationMap;
}

/**
 * The shared development repositories used by the dev routes and pages:
 * one in-memory map each per process, surviving hot reloads but not
 * restarts.
 */
export function getDevInterventionRepository(): DueLogicInterventionRepository {
  const holder = globalThis as GlobalWithInterventionStore;
  holder.__duelogicDevInterventionStore ??= new Map();
  return createInMemoryInterventionRepository(
    holder.__duelogicDevInterventionStore,
  );
}

export function getDevInterventionNotificationRepository(): InterventionNotificationRepository {
  const holder = globalThis as GlobalWithInterventionStore;
  holder.__duelogicDevInterventionNotificationStore ??= new Map();
  return createInMemoryInterventionNotificationRepository(
    holder.__duelogicDevInterventionNotificationStore,
  );
}

/** Demo reset helper: drops every stored intervention and notification. */
export function clearDevInterventionStore(): void {
  const holder = globalThis as GlobalWithInterventionStore;
  holder.__duelogicDevInterventionStore?.clear();
  holder.__duelogicDevInterventionNotificationStore?.clear();
}

/**
 * Development-store-only targeted deletion for demo preparation: removes
 * exactly the named intervention records and nothing else. Never part of
 * the production repository contract. Returns the number removed; missing
 * IDs are ignored. Defaults to the shared development map; validation
 * passes its own isolated map.
 */
export function deleteInterventionRecordsById(
  interventionIds: readonly string[],
  interventions?: InterventionMap,
): number {
  const holder = globalThis as GlobalWithInterventionStore;
  const target =
    interventions ?? (holder.__duelogicDevInterventionStore ??= new Map());
  let deleted = 0;
  for (const id of interventionIds) {
    if (target.delete(id)) {
      deleted += 1;
    }
  }
  return deleted;
}

/** Targeted deletion of exactly the named notification records. */
export function deleteInterventionNotificationsById(
  notificationIds: readonly string[],
  notifications?: NotificationMap,
): number {
  const holder = globalThis as GlobalWithInterventionStore;
  const target =
    notifications ??
    (holder.__duelogicDevInterventionNotificationStore ??= new Map());
  let deleted = 0;
  for (const id of notificationIds) {
    if (target.delete(id)) {
      deleted += 1;
    }
  }
  return deleted;
}
