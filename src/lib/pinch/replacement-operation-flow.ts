/**
 * Pure orchestration of the destructive subscription-replacement mutation
 * sequence, with the audit and recovery record as mandatory execution state.
 *
 * The flow enforces two contracts the route alone could not prove
 * deterministically:
 *
 * 1. Write-before-cancel: the operation record — including the immutable
 *    recovery snapshot and exact reinstatement payload — must be written AND
 *    read back successfully before the original subscription's DELETE is
 *    issued. A failed write or read-back aborts with no mutation of any kind.
 * 2. No automatic retry: every injected effect is invoked at most once. Any
 *    failure or ambiguity after cancellation moves the record to
 *    `manual-recovery-required` with the exact failure stage and returns;
 *    nothing is ever re-issued.
 *
 * All I/O is injected (repository, Pinch effects, clock, safe logger), so
 * the deterministic validation drives this exact code path without any
 * network access. The route supplies real pinchRequest-backed effects.
 */

import type {
  SubscriptionReplacementOperationRecord,
  SubscriptionReplacementOperationRepository,
  SubscriptionReplacementOperationStage,
  SubscriptionReplacementRecoverySnapshot,
  VerifiedReplacementMapping,
} from "./replacement-operation";

/**
 * The Pinch-facing side effects of the mutation sequence. Each is called at
 * most once per execution. Implementations must not retry internally.
 */
export interface ReplacementExecutionEffects {
  /**
   * Atomically transitions the customer schedule confirmation from accepted
   * to consumed for this operation — recording consumedAt and the operation
   * ID — and verifies the transition by read-back. Returns true only for a
   * verified transition. Not a Pinch effect: it touches only the
   * confirmation store. Invoked exactly once, before the operation record
   * is written and before any Pinch mutation; a false return or a throw
   * aborts the flow with nothing persisted and nothing mutated.
   */
  consumeCustomerConfirmation(): Promise<boolean>;
  /** Issues the single DELETE for the original subscription. */
  cancelOriginal(): Promise<void>;
  /**
   * Reads the original subscription's identity and status, used solely to
   * verify cancellation. The DELETE outcome itself is never trusted.
   */
  readOriginalStatus(): Promise<{ id: string; status: string } | null>;
  /** Issues the single POST /subscriptions and returns the raw result. */
  createReplacement(): Promise<unknown>;
  /**
   * Read-only verification of the created replacement. Returns the verified
   * old-to-new mapping, or null when verification did not conclusively pass.
   */
  verifyReplacement(
    newSubscriptionId: string,
  ): Promise<VerifiedReplacementMapping | null>;
}

export interface ReplacementExecutionRequest {
  operationId: string;
  /** The accepted customer confirmation this operation consumes. */
  confirmationId: string;
  merchantId: string;
  payerId: string;
  planId: string;
  sourceId: string;
  oldSubscriptionId: string;
  /** YYYY-MM-DD. */
  previousStartDate: string;
  /** YYYY-MM-DD. */
  requestedStartDate: string;
  previousTotalAmountCents: number | null;
  requestedTotalAmountCents: number | null;
  recoverySnapshot: SubscriptionReplacementRecoverySnapshot;
}

/** Safe logging only: route/operation, stage, error class, upstream HTTP status and safe identifiers. */
export type SafeReplacementLog = (
  message: string,
  context: Record<string, unknown>,
) => void;

export type ReplacementExecutionOutcome =
  /**
   * The customer confirmation could not be verifiably consumed; nothing was
   * persisted and nothing was mutated. Not a manual-recovery state: the
   * original subscription is untouched.
   */
  | { outcome: "confirmation-consumption-failed" }
  /** Record could not be written or read back; nothing was mutated. */
  | { outcome: "recovery-record-failed" }
  | {
      outcome: "cancel-verification-failed";
      record: SubscriptionReplacementOperationRecord;
    }
  | {
      outcome: "replacement-create-failed";
      record: SubscriptionReplacementOperationRecord;
    }
  | {
      outcome: "replacement-ambiguous";
      record: SubscriptionReplacementOperationRecord;
    }
  | {
      outcome: "replacement-verification-failed";
      record: SubscriptionReplacementOperationRecord;
    }
  | {
      outcome: "replacement-verified";
      record: SubscriptionReplacementOperationRecord;
    };

/**
 * The creation response may be a subscription object carrying `id` or a bare
 * ID string; in either case the ID must carry the sub_ prefix. No other
 * shape is probed — an unrecognisable success is treated as ambiguous and
 * never retried.
 */
export function extractNewSubscriptionId(result: unknown): string | null {
  const candidate =
    typeof result === "string"
      ? result
      : typeof result === "object" && result !== null && !Array.isArray(result)
        ? (result as Record<string, unknown>).id
        : null;
  if (typeof candidate !== "string") {
    return null;
  }
  const trimmed = candidate.trim();
  return trimmed.startsWith("sub_") && trimmed !== "" ? trimmed : null;
}

function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function upstreamStatusOf(error: unknown): number | "none" {
  if (error instanceof Error && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") {
      return status;
    }
  }
  return "none";
}

/**
 * Sanitised failure detail: error class and upstream HTTP status only —
 * never upstream response content, which can carry tokenised source data and
 * payer personally identifiable information.
 */
function failureDetailOf(error: unknown): string {
  if (error === undefined) {
    return "";
  }
  return ` (${errorClassOf(error)}, upstream HTTP ${upstreamStatusOf(error)})`;
}

export async function executeSubscriptionReplacement(
  request: ReplacementExecutionRequest,
  repository: SubscriptionReplacementOperationRepository,
  effects: ReplacementExecutionEffects,
  now: () => string,
  logSafe: SafeReplacementLog,
): Promise<ReplacementExecutionOutcome> {
  const safeContext: Record<string, unknown> = {
    operationId: request.operationId,
    merchantId: request.merchantId,
    payerId: request.payerId,
    planId: request.planId,
    oldSubscriptionId: request.oldSubscriptionId,
  };

  /**
   * Writes the record and confirms it can be read back identically. Any
   * storage error or mismatched read-back returns false — the caller decides
   * whether that aborts (pre-mutation) or is tolerated (post-mutation).
   */
  const writeAndConfirm = async (
    record: SubscriptionReplacementOperationRecord,
  ): Promise<boolean> => {
    try {
      await repository.write(record);
      const readBack = await repository.read(record.operationId);
      return (
        readBack !== null &&
        JSON.stringify(readBack) === JSON.stringify(record)
      );
    } catch (error) {
      logSafe(
        "Subscription-replacement flow: operation record write or read-back failed.",
        { ...safeContext, errorClass: errorClassOf(error) },
      );
      return false;
    }
  };

  /**
   * Post-mutation record updates are best-effort: once the DELETE has been
   * issued, a storage failure must never halt the flow mid-flight (stopping
   * before the create would strand a verified cancellation), and must never
   * trigger a Pinch retry. The recovery-recorded state is already stored.
   */
  const bestEffortWrite = async (
    record: SubscriptionReplacementOperationRecord,
  ): Promise<void> => {
    try {
      await repository.write(record);
    } catch (error) {
      logSafe(
        "Subscription-replacement flow: post-mutation record update failed; continuing without retry.",
        {
          ...safeContext,
          stage: record.currentStage,
          errorClass: errorClassOf(error),
        },
      );
    }
  };

  const failRecord = (
    record: SubscriptionReplacementOperationRecord,
    stage: SubscriptionReplacementOperationStage,
    failureCode: string,
    failureMessage: string,
  ): SubscriptionReplacementOperationRecord => ({
    ...record,
    status: "manual-recovery-required",
    currentStage: stage,
    failureCode,
    failureMessage,
    updatedAt: now(),
  });

  // -------------------------------------------------------------------
  // Customer-consent gate first. The route has already completed every
  // read-only Pinch preflight check before invoking this flow; the
  // accepted confirmation must now be verifiably consumed (single-use,
  // bound to this operation ID) before anything is persisted or mutated.
  // A consumed confirmation is never reset automatically.
  // -------------------------------------------------------------------
  let confirmationConsumed = false;
  try {
    confirmationConsumed = await effects.consumeCustomerConfirmation();
  } catch (error) {
    logSafe(
      "Subscription-replacement flow: customer-confirmation consumption threw.",
      { ...safeContext, errorClass: errorClassOf(error) },
    );
  }
  if (!confirmationConsumed) {
    return { outcome: "confirmation-consumption-failed" };
  }

  // -------------------------------------------------------------------
  // Recovery record next. The original subscription must stay untouched
  // unless the record — with its recovery snapshot — is durably* written
  // and read back. (*durably within the configured repository's own
  // guarantees; the dev store is process-local sandbox storage.)
  // -------------------------------------------------------------------
  const createdAt = now();
  let record: SubscriptionReplacementOperationRecord = {
    operationId: request.operationId,
    confirmationId: request.confirmationId,
    merchantId: request.merchantId,
    payerId: request.payerId,
    planId: request.planId,
    sourceId: request.sourceId,
    oldSubscriptionId: request.oldSubscriptionId,
    newSubscriptionId: null,
    previousStartDate: request.previousStartDate,
    requestedStartDate: request.requestedStartDate,
    previousTotalAmountCents: request.previousTotalAmountCents,
    requestedTotalAmountCents: request.requestedTotalAmountCents,
    status: "preflight-complete",
    currentStage: "preflight",
    recoverySnapshot: request.recoverySnapshot,
    verifiedReplacement: null,
    failureCode: null,
    failureMessage: null,
    createdAt,
    updatedAt: createdAt,
  };
  if (!(await writeAndConfirm(record))) {
    return { outcome: "recovery-record-failed" };
  }

  record = {
    ...record,
    status: "recovery-recorded",
    currentStage: "recovery-recorded",
    updatedAt: now(),
  };
  if (!(await writeAndConfirm(record))) {
    return { outcome: "recovery-record-failed" };
  }

  try {
    // -----------------------------------------------------------------
    // The one and only DELETE. Its outcome is deliberately not trusted:
    // the verification read below is the sole source of truth, and the
    // DELETE is never repeated even if it throws or answers ambiguously.
    // -----------------------------------------------------------------
    try {
      await effects.cancelOriginal();
    } catch (error) {
      logSafe(
        "Subscription-replacement flow: DELETE reported an error; proceeding to cancellation verification without retrying.",
        {
          ...safeContext,
          errorClass: errorClassOf(error),
          upstreamStatus: upstreamStatusOf(error),
        },
      );
    }

    let cancellationVerified = false;
    let cancelReadError: unknown;
    try {
      const originalRead = await effects.readOriginalStatus();
      cancellationVerified =
        originalRead !== null &&
        originalRead.id === request.oldSubscriptionId &&
        originalRead.status.toLowerCase() === "cancelled";
    } catch (error) {
      cancelReadError = error;
      logSafe(
        "Subscription-replacement flow: cancellation verification read failed.",
        {
          ...safeContext,
          errorClass: errorClassOf(error),
          upstreamStatus: upstreamStatusOf(error),
        },
      );
    }
    if (!cancellationVerified) {
      record = failRecord(
        record,
        "cancel-verification-failed",
        "CANCEL_VERIFICATION_FAILED",
        `Cancellation of the original subscription could not be verified${failureDetailOf(cancelReadError)}; no automatic retry was attempted and manual review is required.`,
      );
      await bestEffortWrite(record);
      return { outcome: "cancel-verification-failed", record };
    }

    record = {
      ...record,
      status: "original-cancelled",
      currentStage: "original-cancelled",
      updatedAt: now(),
    };
    await bestEffortWrite(record);

    // -----------------------------------------------------------------
    // The one and only POST /subscriptions. Never retried: any failure or
    // ambiguity from here on is a manual-recovery state because the
    // original subscription is already verified cancelled.
    // -----------------------------------------------------------------
    let created: unknown;
    try {
      created = await effects.createReplacement();
    } catch (error) {
      logSafe(
        'Subscription-replacement flow failed at stage "replacement-create-failed": original subscription is cancelled and the replacement was not created.',
        {
          ...safeContext,
          errorClass: errorClassOf(error),
          upstreamStatus: upstreamStatusOf(error),
          requiresManualRecovery: true,
        },
      );
      record = failRecord(
        record,
        "replacement-create-failed",
        "REPLACEMENT_CREATE_FAILED",
        `Replacement creation failed after verified cancellation${failureDetailOf(error)}; no automatic retry was attempted and manual recovery is required.`,
      );
      await bestEffortWrite(record);
      return { outcome: "replacement-create-failed", record };
    }

    const newSubscriptionId = extractNewSubscriptionId(created);
    if (newSubscriptionId === null) {
      // Upstream reported success, so a replacement may exist; repeating
      // the POST could create a duplicate and is forbidden.
      logSafe(
        'Subscription-replacement flow failed at stage "replacement-ambiguous": creation reported success but no subscription ID could be extracted.',
        { ...safeContext, requiresManualRecovery: true },
      );
      record = failRecord(
        record,
        "replacement-ambiguous",
        "REPLACEMENT_RESULT_AMBIGUOUS",
        "Replacement creation reported success but no subscription ID could be extracted; a replacement may exist, so the POST must not be repeated and manual recovery is required.",
      );
      await bestEffortWrite(record);
      return { outcome: "replacement-ambiguous", record };
    }

    record = {
      ...record,
      newSubscriptionId,
      status: "replacement-created",
      currentStage: "replacement-created",
      updatedAt: now(),
    };
    await bestEffortWrite(record);

    // -----------------------------------------------------------------
    // Read-only verification. A failure here performs no further mutation
    // and reports the created-but-unverified state; the payer may well
    // have an active replacement, so no claim to the contrary is made.
    // -----------------------------------------------------------------
    let mapping: VerifiedReplacementMapping | null = null;
    let verifyError: unknown;
    try {
      mapping = await effects.verifyReplacement(newSubscriptionId);
    } catch (error) {
      verifyError = error;
      logSafe(
        "Subscription-replacement flow: replacement verification read failed.",
        {
          ...safeContext,
          newSubscriptionId,
          errorClass: errorClassOf(error),
          upstreamStatus: upstreamStatusOf(error),
        },
      );
    }
    if (
      mapping === null ||
      mapping.oldSubscriptionId !== request.oldSubscriptionId ||
      mapping.newSubscriptionId !== newSubscriptionId
    ) {
      record = failRecord(
        record,
        "replacement-verification-failed",
        "REPLACEMENT_VERIFICATION_FAILED",
        `Replacement was created but read-back verification did not conclusively pass${failureDetailOf(verifyError)}; the replacement may be active, so nothing was retried and manual review is required.`,
      );
      await bestEffortWrite(record);
      return { outcome: "replacement-verification-failed", record };
    }

    record = {
      ...record,
      status: "replacement-verified",
      currentStage: "replacement-verified",
      verifiedReplacement: mapping,
      updatedAt: now(),
    };
    await bestEffortWrite(record);
    return { outcome: "replacement-verified", record };
  } catch (error) {
    // Safety net: no code path above is expected to rethrow, but if an
    // unexpected bug escapes after the DELETE was issued, the caller must
    // still learn that the operation is mid-flight rather than receive a
    // generic error, and the record must reach manual-recovery-required.
    logSafe(
      "Subscription-replacement flow failed unexpectedly after mutation began.",
      {
        ...safeContext,
        errorClass: errorClassOf(error),
        upstreamStatus: upstreamStatusOf(error),
        requiresManualRecovery: true,
      },
    );
    record = failRecord(
      record,
      "replacement-create-failed",
      "REPLACEMENT_UNEXPECTED_FAILURE",
      `The replacement flow failed unexpectedly after mutation began${failureDetailOf(error)}; no automatic retry was attempted and manual recovery is required.`,
    );
    await bestEffortWrite(record);
    return { outcome: "replacement-create-failed", record };
  }
}
