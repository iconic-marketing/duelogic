/**
 * Merchant policy activation helper for the development dashboard.
 *
 * Pure server-side request handling over injected dependencies: strict
 * parsing of the single merchant-configurable value, server-side
 * construction of the complete policy from the DEFAULT_DUELOGIC_POLICY
 * frame, activation through the append-only snapshot repository, and
 * merchant-safe view building. The browser never supplies policy identity:
 * policyVersion, policy.version, merchantId, activatedAt,
 * installedAsInitialDefault and every fixed rule value are server-generated
 * or server-held, and any input beyond `{ amountCeilingCents }` is
 * rejected.
 *
 * amountCeilingCents is the only merchant-configurable policy value in
 * this MVP stage: a positive safe integer of cents with no additional
 * arbitrary upper ceiling. Full policy validity is asserted by the
 * repository through the engine's exported assertValidPolicy — never a
 * duplicated check here.
 */

import type { DueLogicPolicy } from "../schema";
import { nextDevPolicyVersion } from "./dev-policy-store";
import {
  toMerchantPolicySnapshotProjection,
  type MerchantPolicyRepository,
  type MerchantPolicySnapshotProjection,
} from "./policy-snapshot";
import { DEFAULT_DUELOGIC_POLICY } from "./rules";

/**
 * Merchant-safe policy view: display projections only — never the merchant
 * ID, a complete policy object or repository internals.
 */
export interface MerchantPolicyView {
  active: MerchantPolicySnapshotProjection | null;
  /** Activation order, oldest first; the last entry is the active one. */
  history: MerchantPolicySnapshotProjection[];
}

export async function buildMerchantPolicyView(
  repository: MerchantPolicyRepository,
  merchantId: string,
): Promise<MerchantPolicyView> {
  const snapshots = await repository.list(merchantId);
  const history = snapshots.map(toMerchantPolicySnapshotProjection);
  return {
    active: history.length === 0 ? null : history[history.length - 1],
    history,
  };
}

const ALLOWED_INPUT_KEYS = new Set(["amountCeilingCents"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict parse of the activation request body: exactly
 * `{ amountCeilingCents }` carrying a positive safe integer of cents.
 * Unknown keys — including any attempt to supply policyVersion, version,
 * merchantId, activatedAt, installedAsInitialDefault or a fixed policy
 * field — cause rejection, as do missing values, booleans, strings,
 * decimals, zero and negatives. No new upper limit is imposed.
 */
export function parsePolicyActivationInput(
  input: unknown,
): { amountCeilingCents: number } | null {
  if (!isPlainObject(input)) {
    return null;
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      return null;
    }
  }
  const value = input.amountCeilingCents;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return { amountCeilingCents: value };
}

export interface PolicyActivationDeps {
  repository: MerchantPolicyRepository;
  /** Resolved server-side — never taken from the request. */
  merchantId: string;
  now: () => string;
}

export type PolicyActivationOutcome =
  | { ok: true; view: MerchantPolicyView }
  | { ok: false; stage: "validation" };

/**
 * Handles one activation request: strict parse, server-generated next
 * version, complete policy built from the fixed default frame with only
 * `version` and `amountCeilingCents` changed, then activation through the
 * append-only repository (which validates the full policy via the engine's
 * exported validation). A rejected input performs no repository write, and
 * no existing snapshot is ever modified.
 */
export async function processPolicyActivationRequest(
  input: unknown,
  deps: PolicyActivationDeps,
): Promise<PolicyActivationOutcome> {
  const parsed = parsePolicyActivationInput(input);
  if (parsed === null) {
    return { ok: false, stage: "validation" };
  }
  const history = await deps.repository.list(deps.merchantId);
  const policyVersion = nextDevPolicyVersion(
    history.map((snapshot) => snapshot.policyVersion),
  );
  // The complete policy is the fixed default frame; only the version and
  // the approved merchant-configurable ceiling differ.
  const policy: DueLogicPolicy = {
    ...DEFAULT_DUELOGIC_POLICY,
    version: policyVersion,
    amountCeilingCents: parsed.amountCeilingCents,
  };
  await deps.repository.activate({
    policyVersion,
    merchantId: deps.merchantId,
    policy,
    activatedAt: deps.now(),
    installedAsInitialDefault: false,
  });
  return {
    ok: true,
    view: await buildMerchantPolicyView(deps.repository, deps.merchantId),
  };
}
