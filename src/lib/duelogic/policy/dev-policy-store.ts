/**
 * Development-only, in-process implementation of the merchant policy
 * repository, following the dev intervention store pattern
 * (src/lib/duelogic/dev-intervention-store.ts).
 *
 * NON-DURABLE SANDBOX STORAGE: snapshots live in process memory, backed by
 * `globalThis` so `next dev` hot reloads keep them, but they do NOT survive
 * a process or deployment restart. No database has been added. This is
 * acceptable for the hackathon MVP stage only; durable storage replaces
 * this repository implementation, not the snapshot or repository contract.
 * Nothing here may ever be described as durable.
 *
 * Snapshots are append-only activation history: no update, delete or
 * replace exists, every write and read passes through structuredClone, and
 * previous snapshots are never dropped. When the shared development
 * repository is first created (empty store), DEFAULT_DUELOGIC_POLICY is
 * installed automatically as the initial active snapshot — the default
 * policy remains defined only in policy/rules.ts and its values are never
 * duplicated here.
 */

import { INTERVENTION_DEMO_FIXTURE } from "../intervention-fixture";
import {
  assertValidMerchantPolicySnapshot,
  type MerchantPolicyRepository,
  type MerchantPolicySnapshot,
} from "./policy-snapshot";
import { DEFAULT_DUELOGIC_POLICY } from "./rules";

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts: the
// `server-only` package is not installed in this project, so fail at import
// time if this module ever reaches browser code.
if (typeof window !== "undefined") {
  throw new Error(
    "The dev policy store is server-only and must not be imported into browser code.",
  );
}

/**
 * The merchant the development policy history belongs to: the managed
 * sandbox merchant already established by the DueLogic development context.
 */
export const DEV_POLICY_MERCHANT_ID = INTERVENTION_DEMO_FIXTURE.merchantId;

/** Per-merchant activation history, oldest first; the last entry is active. */
type PolicySnapshotMap = Map<string, MerchantPolicySnapshot[]>;

/**
 * Creates a fresh, isolated in-memory merchant policy repository. Used by
 * the deterministic validation so scenarios never touch the shared
 * development store. Snapshots are deep-copied on write and on read, so
 * stored state can never be mutated through a caller-held or
 * caller-returned object; activation validates the complete snapshot
 * (including the policy, through the engine's exported assertValidPolicy)
 * and rejects duplicate versions before anything is stored.
 */
export function createInMemoryMerchantPolicyRepository(
  snapshots: PolicySnapshotMap = new Map(),
): MerchantPolicyRepository {
  return {
    async activate(snapshot: MerchantPolicySnapshot): Promise<void> {
      assertValidMerchantPolicySnapshot(snapshot);
      const history = snapshots.get(snapshot.merchantId) ?? [];
      if (
        history.some((entry) => entry.policyVersion === snapshot.policyVersion)
      ) {
        throw new Error(
          `Policy store refused duplicate policyVersion "${snapshot.policyVersion}" for this merchant.`,
        );
      }
      // Append-only: earlier snapshots are never replaced or removed.
      snapshots.set(snapshot.merchantId, [
        ...history,
        structuredClone(snapshot),
      ]);
    },
    async readActive(
      merchantId: string,
    ): Promise<MerchantPolicySnapshot | null> {
      const history = snapshots.get(merchantId.trim());
      if (history === undefined || history.length === 0) {
        return null;
      }
      return structuredClone(history[history.length - 1]);
    },
    async readByVersion(
      merchantId: string,
      policyVersion: string,
    ): Promise<MerchantPolicySnapshot | null> {
      const history = snapshots.get(merchantId.trim()) ?? [];
      const found = history.find(
        (entry) => entry.policyVersion === policyVersion.trim(),
      );
      return found === undefined ? null : structuredClone(found);
    },
    async list(merchantId: string): Promise<MerchantPolicySnapshot[]> {
      const history = snapshots.get(merchantId.trim()) ?? [];
      return history.map((entry) => structuredClone(entry));
    },
  };
}

/**
 * Installs DEFAULT_DUELOGIC_POLICY as the initial active snapshot when the
 * repository holds no snapshot for the merchant, stamped with the injected
 * clock's reading. An existing snapshot is never silently overwritten or
 * recreated: any existing history leaves the repository untouched. The
 * initial version is DEFAULT_DUELOGIC_POLICY.version (duelogic-default-v1)
 * — read from the authoritative definition, never duplicated.
 */
export async function installInitialDefaultPolicySnapshot(
  repository: MerchantPolicyRepository,
  now: () => string,
  merchantId: string = DEV_POLICY_MERCHANT_ID,
): Promise<void> {
  const existing = await repository.list(merchantId);
  if (existing.length > 0) {
    return;
  }
  await repository.activate({
    policyVersion: DEFAULT_DUELOGIC_POLICY.version,
    merchantId,
    policy: DEFAULT_DUELOGIC_POLICY,
    activatedAt: now(),
    installedAsInitialDefault: true,
  });
}

const DEV_POLICY_VERSION_PATTERN = /^duelogic-(?:default|policy)-v(\d+)$/;

/**
 * The next server-generated development version: duelogic-policy-v{n},
 * one above the highest recognised existing version number (the initial
 * duelogic-default-v1 counts as v1), so later snapshots run
 * duelogic-policy-v2, duelogic-policy-v3 and so on.
 */
export function nextDevPolicyVersion(
  existingVersions: readonly string[],
): string {
  let highest = 1;
  for (const version of existingVersions) {
    const match = DEV_POLICY_VERSION_PATTERN.exec(version);
    if (match !== null) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  return `duelogic-policy-v${highest + 1}`;
}

/** The next server-generated version for the merchant's stored history. */
export async function generateNextDevPolicyVersion(
  repository: MerchantPolicyRepository,
  merchantId: string = DEV_POLICY_MERCHANT_ID,
): Promise<string> {
  const history = await repository.list(merchantId);
  return nextDevPolicyVersion(
    history.map((snapshot) => snapshot.policyVersion),
  );
}

interface GlobalWithPolicyStore {
  __duelogicDevPolicyStore?: PolicySnapshotMap;
}

/**
 * The shared development repository: one in-memory map per process,
 * surviving hot reloads but not restarts. When first created (empty
 * store), the authoritative default policy is installed automatically as
 * the initial active snapshot, stamped by the injected server clock.
 */
export async function getDevMerchantPolicyRepository(
  now: () => string = () => new Date().toISOString(),
): Promise<MerchantPolicyRepository> {
  const holder = globalThis as GlobalWithPolicyStore;
  holder.__duelogicDevPolicyStore ??= new Map();
  const repository = createInMemoryMerchantPolicyRepository(
    holder.__duelogicDevPolicyStore,
  );
  await installInitialDefaultPolicySnapshot(repository, now);
  return repository;
}

/** Reset helper for controlled validation or development use. */
export function clearDevMerchantPolicyStore(): void {
  const holder = globalThis as GlobalWithPolicyStore;
  holder.__duelogicDevPolicyStore?.clear();
}
