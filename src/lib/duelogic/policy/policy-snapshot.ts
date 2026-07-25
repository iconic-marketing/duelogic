/**
 * Merchant policy snapshot model and repository contract.
 *
 * A snapshot is the immutable record of one policy activation for one
 * merchant: the complete DueLogicPolicy object (the single policy
 * representation — never a parallel copy of its shape), the version it
 * carries, the activation timestamp from the injected server clock and
 * whether it was installed automatically as the initial development
 * default. Activated snapshots are append-only history: the repository
 * contract exposes no update, delete or replace method, previous snapshots
 * are always preserved, and the latest successfully activated snapshot is
 * the merchant's active policy.
 *
 * Snapshot validation happens once here — structural checks plus the
 * engine's existing exported assertValidPolicy — so no repository
 * implementation reproduces the engine's policy checks.
 */

import type { DueLogicPolicy } from "../schema";
import { assertValidPolicy } from "./engine";

export interface MerchantPolicySnapshot {
  /** Must equal policy.version exactly. */
  readonly policyVersion: string;
  readonly merchantId: string;
  /** The complete policy object — the only policy representation. */
  readonly policy: DueLogicPolicy;
  /** ISO 8601 timestamp from the injected server clock at activation. */
  readonly activatedAt: string;
  /** True only for the automatically installed initial default snapshot. */
  readonly installedAsInitialDefault: boolean;
}

/**
 * Safe merchant-facing projection for later dashboard use: display fields
 * only — never repository implementation detail.
 */
export interface MerchantPolicySnapshotProjection {
  readonly policyVersion: string;
  readonly activatedAt: string;
  readonly installedAsInitialDefault: boolean;
  readonly amountCeilingCents: number;
}

export function toMerchantPolicySnapshotProjection(
  snapshot: MerchantPolicySnapshot,
): MerchantPolicySnapshotProjection {
  return {
    policyVersion: snapshot.policyVersion,
    activatedAt: snapshot.activatedAt,
    installedAsInitialDefault: snapshot.installedAsInitialDefault,
    amountCeilingCents: snapshot.policy.amountCeilingCents,
  };
}

/** An ISO 8601 date-and-time string parseable to a real instant. */
function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/**
 * Structural snapshot validation plus the existing engine policy
 * validation. Throws on the first violated constraint; messages name
 * fields and version vocabulary only.
 */
export function assertValidMerchantPolicySnapshot(
  snapshot: MerchantPolicySnapshot,
): void {
  if (
    typeof snapshot.merchantId !== "string" ||
    snapshot.merchantId.trim() === ""
  ) {
    throw new Error(
      "Policy snapshot merchantId must be a non-empty identifier.",
    );
  }
  if (
    typeof snapshot.policyVersion !== "string" ||
    snapshot.policyVersion.trim() === ""
  ) {
    throw new Error(
      "Policy snapshot policyVersion must be a non-empty identifier.",
    );
  }
  if (!isIsoTimestamp(snapshot.activatedAt)) {
    throw new Error(
      "Policy snapshot activatedAt must be a valid ISO 8601 timestamp.",
    );
  }
  if (typeof snapshot.installedAsInitialDefault !== "boolean") {
    throw new Error(
      "Policy snapshot installedAsInitialDefault must be a boolean.",
    );
  }
  if (snapshot.policyVersion !== snapshot.policy?.version) {
    throw new Error(
      "Policy snapshot policyVersion must equal policy.version.",
    );
  }
  assertValidPolicy(snapshot.policy);
}

/**
 * Append-only merchant policy activation history. Deliberately no update,
 * delete, replace or mutate-in-place method exists on this contract.
 */
export interface MerchantPolicyRepository {
  /**
   * Validates and appends a snapshot, making it the active policy. Rejects
   * a duplicate policyVersion for the merchant, a policyVersion that does
   * not equal policy.version, and any policy the engine validation refuses
   * — leaving stored history untouched on every rejection.
   */
  activate(snapshot: MerchantPolicySnapshot): Promise<void>;
  readActive(merchantId: string): Promise<MerchantPolicySnapshot | null>;
  readByVersion(
    merchantId: string,
    policyVersion: string,
  ): Promise<MerchantPolicySnapshot | null>;
  /** Activation order, oldest first; the last entry is the active snapshot. */
  list(merchantId: string): Promise<MerchantPolicySnapshot[]>;
}
