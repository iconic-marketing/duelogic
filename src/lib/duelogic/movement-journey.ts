/**
 * Customer movement-journey service: server-side movement-choice binding,
 * the customer-safe movement projection, and the final-confirmation
 * dispatcher that routes one stored movement kind to exactly one existing
 * protected execution function.
 *
 * The browser never selects an execution path: routes resolve the STORED
 * choice (defaulting to the permanent current-cycle journey for
 * invitations that predate movement choices) and request data can never
 * override it. Availability and eligibility come from
 * deriveMovementAvailability — the policy engine and cadence resolver
 * remain the only authorities.
 */

import {
  deriveMovementAvailability,
  MOVEMENT_KINDS,
  type CustomerMovementOption,
  type MovementAvailabilityDeps,
  type MovementKind,
} from "./movement-availability";
import type {
  MovementChoiceRepository,
} from "./dev-movement-store";
import {
  effectiveInterventionStatus,
  type DueLogicInterventionRecord,
  type DueLogicInterventionRepository,
} from "./intervention";
import {
  evaluateTemporaryTransactionVerification,
  temporaryVerificationExpectationFor,
} from "./temporary-operation";
import type {
  TemporaryOperationSelectionRepository,
  TemporaryVerificationRepository,
} from "./dev-temporary-operation-store";

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts.
if (typeof window !== "undefined") {
  throw new Error(
    "The movement-journey service is server-only and must not be imported into browser code.",
  );
}

export function isMovementKind(value: unknown): value is MovementKind {
  return (
    typeof value === "string" && MOVEMENT_KINDS.includes(value as MovementKind)
  );
}

/**
 * Customer-safe movement projection rendered by the tokenised page:
 * availability, the stored choice, and — for the temporary journey — the
 * exact bound preview and whether the temporary verification currently
 * enables final confirmation. No IDs, no policy internals.
 */
export interface CustomerMovementProjection {
  chosenKind: MovementKind | null;
  options: CustomerMovementOption[];
  reviewRequired: boolean;
  /** The exact bound temporary movement, when one exists. */
  temporaryPreview: {
    currentDate: string;
    newDate: string;
    amountInCents: number;
  } | null;
  /** Server-derived: an unexpired unconsumed temporary verification exists. */
  temporaryConfirmationEnabled: boolean;
}

export interface MovementProjectionDeps {
  choices: MovementChoiceRepository;
  selections: TemporaryOperationSelectionRepository;
  temporaryVerifications: TemporaryVerificationRepository;
  availability: MovementAvailabilityDeps;
  now(): string;
}

/**
 * Builds the customer movement projection. Availability derivation is
 * skipped for terminal records (executed, declined, escalated, expired,
 * manual recovery): the projection then carries only the choice and any
 * bound temporary preview so completed pages can render their result.
 */
export async function buildCustomerMovementProjection(
  record: DueLogicInterventionRecord,
  deps: MovementProjectionDeps,
): Promise<CustomerMovementProjection> {
  const nowIso = deps.now();
  const status = effectiveInterventionStatus(record, nowIso);
  const choice = await deps.choices.readChoice(record.interventionId);

  let temporaryPreview: CustomerMovementProjection["temporaryPreview"] = null;
  let temporaryConfirmationEnabled = false;
  const selection = await deps.selections.readActive(record.interventionId);
  if (selection !== null) {
    temporaryPreview = {
      currentDate: selection.originalTransactionDate,
      newDate: selection.proposedTransactionDate,
      amountInCents: selection.amountInCents,
    };
    if (choice?.kind === "temporary" && status === "preview-ready") {
      let verification = null;
      try {
        verification =
          await deps.temporaryVerifications.readForIntervention(
            record.interventionId,
          );
      } catch {
        verification = null;
      }
      temporaryConfirmationEnabled = evaluateTemporaryTransactionVerification(
        verification,
        temporaryVerificationExpectationFor(selection),
        nowIso,
      ).ok;
    }
  }

  const terminal =
    status === "executed" ||
    status === "executing" ||
    status === "manual-recovery-required" ||
    status === "declined" ||
    status === "escalated" ||
    status === "expired";
  if (terminal) {
    return {
      chosenKind: choice?.kind ?? null,
      options: [],
      reviewRequired: false,
      temporaryPreview,
      temporaryConfirmationEnabled: false,
    };
  }

  const derived = await deriveMovementAvailability(record, deps.availability);
  if (derived.outcome !== "resolved") {
    // Unresolvable policy or configuration: customer-safe review wording,
    // no executable options.
    return {
      chosenKind: choice?.kind ?? null,
      options: [],
      reviewRequired: true,
      temporaryPreview,
      temporaryConfirmationEnabled: false,
    };
  }
  return {
    chosenKind: choice?.kind ?? null,
    options: derived.availability.options,
    reviewRequired: derived.availability.reviewRequired,
    temporaryPreview,
    temporaryConfirmationEnabled,
  };
}

// ---------------------------------------------------------------------------
// Movement-choice binding

export type ChooseMovementOutcome =
  | { ok: true; record: DueLogicInterventionRecord }
  | {
      ok: false;
      reason:
        | "not-found"
        | "not-choosable"
        | "verification-active"
        | "movement-unavailable"
        | "merchant-review-required"
        | "store";
      record?: DueLogicInterventionRecord;
    };

export interface ChooseMovementDeps {
  interventions: DueLogicInterventionRepository;
  choices: MovementChoiceRepository;
  selections: TemporaryOperationSelectionRepository;
  temporaryVerifications: TemporaryVerificationRepository;
  /** The permanent verification read (any record blocks re-choosing). */
  permanentVerificationExists(interventionId: string): Promise<boolean>;
  availability: MovementAvailabilityDeps;
  now(): string;
  hashToken(rawToken: string): string;
}

/**
 * Binds the customer's chosen movement kind server-side. Refused after
 * any verification record exists (permanent or temporary) — the bound
 * operation is immutable once verified, and changing it requires a fresh
 * verification through the existing security model. Choosing a different
 * kind before verification implicitly invalidates the prior journey: all
 * dispatch (date evaluation, OTP, final confirmation) keys off this
 * stored choice, so earlier previews and challenges become unreachable
 * and any stale expectation fails its binding checks.
 *
 * When no movement is available the intervention moves to the existing
 * merchant escalation state with customer-safe review wording.
 */
export async function chooseMovementKind(
  input: { token: string; kind: MovementKind },
  deps: ChooseMovementDeps,
): Promise<ChooseMovementOutcome> {
  const record = await deps.interventions.readByTokenHash(
    deps.hashToken(input.token.trim()),
  );
  if (record === null) {
    return { ok: false, reason: "not-found" };
  }
  const nowIso = deps.now();
  const status = effectiveInterventionStatus(record, nowIso);
  if (
    status === "expired" ||
    status === "declined" ||
    status === "escalated" ||
    status === "executing" ||
    status === "executed" ||
    status === "manual-recovery-required" ||
    record.confirmationId !== null ||
    record.operationId !== null ||
    record.newSubscriptionId !== null
  ) {
    return { ok: false, reason: "not-choosable", record };
  }

  // Immutable after verification: any existing verification record —
  // permanent or temporary — blocks changing the movement.
  let verificationExists = false;
  try {
    verificationExists =
      (await deps.permanentVerificationExists(record.interventionId)) ||
      (await deps.temporaryVerifications.readForIntervention(
        record.interventionId,
      )) !== null;
  } catch {
    return { ok: false, reason: "store", record };
  }
  if (verificationExists) {
    return { ok: false, reason: "verification-active", record };
  }

  const derived = await deriveMovementAvailability(record, deps.availability);
  if (derived.outcome !== "resolved") {
    return { ok: false, reason: "merchant-review-required", record };
  }
  if (derived.availability.reviewRequired) {
    // Nothing is automatically available: move to the existing merchant
    // escalation state so the merchant panel surfaces it.
    const escalated: DueLogicInterventionRecord = {
      ...record,
      status: "escalated",
      updatedAt: nowIso,
    };
    try {
      await deps.interventions.write(escalated);
    } catch {
      return { ok: false, reason: "store", record };
    }
    return { ok: false, reason: "merchant-review-required", record: escalated };
  }
  if (!derived.availability.options.some((option) => option.kind === input.kind)) {
    return { ok: false, reason: "movement-unavailable", record };
  }

  try {
    await deps.choices.setChoice({
      interventionId: record.interventionId,
      kind: input.kind,
      chosenAt: nowIso,
    });
  } catch {
    return { ok: false, reason: "store", record };
  }
  return { ok: true, record };
}

// ---------------------------------------------------------------------------
// Final-confirmation dispatch

/**
 * Resolves the movement kind an execution must dispatch to: the stored
 * server-side choice, defaulting to the permanent current-cycle journey
 * for invitations that predate movement choices. Request data can never
 * supply or override this.
 */
export async function resolveMovementKindForExecution(
  interventionId: string,
  choices: MovementChoiceRepository,
): Promise<MovementKind> {
  const choice = await choices.readChoice(interventionId);
  return choice?.kind ?? "permanent-current-cycle";
}

/**
 * Invokes exactly one protected execution path for the resolved kind.
 * Both permanent modes dispatch to the existing protected permanent
 * confirmation-and-replacement composition; temporary dispatches to the
 * protected temporary execution function. No retry, no fallback, no
 * second invocation on any branch.
 */
export async function dispatchFinalConfirmation<Result>(
  kind: MovementKind,
  executors: {
    temporary(): Promise<Result>;
    permanent(): Promise<Result>;
  },
): Promise<Result> {
  if (kind === "temporary") {
    return executors.temporary();
  }
  return executors.permanent();
}
