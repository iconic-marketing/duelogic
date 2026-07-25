/**
 * Pure derivation of policy prior-change history from trusted server-held
 * intervention records.
 *
 * Converts completed customer-led interventions into the policy engine's
 * PriorScheduleChange entries so the rolling usage allowance is enforced at
 * runtime. Only the engine counts: this module never inspects the rolling
 * window, never compares dates against a policy period and never decides
 * whether an allowance is exhausted — it only states what verifiably
 * happened.
 *
 * History is keyed by the PAYER, never by a subscription ID: a verified
 * permanent correction cancels and replaces the subscription, so the payer's
 * later requests arrive under a new subscription ID. The old-to-new
 * replacement mapping remains the audit trail only — it is not needed here
 * and is never traversed to count prior use.
 *
 * Trusted evidence rules:
 * - "executed" requires the full verified linkage (confirmationId,
 *   operationId, newSubscriptionId) and a readable execution write-back
 *   timestamp; it maps to an "executed-verified" permanent entry. The
 *   executed status is terminal — no later write path modifies an executed
 *   record — so its updatedAt is exactly the successful execution
 *   write-back instant.
 * - "manual-recovery-required" maps to a non-counting "manual-recovery"
 *   entry (audit evidence only): mutation began but success was never
 *   verified, so it must never consume the allowance.
 * - Everything else — pending, preview-ready (including a pre-mutation
 *   refusal that reverted with its linkage cleared), declined, expired,
 *   escalated, still executing, or an "executed" record missing any linkage
 *   field — is not completed evidence and produces no entry at all.
 *
 * Pure module: no clock reads, no storage, no Pinch, no randomness and no
 * input mutation. The merchant timezone is a parameter (the fixture's
 * development proof value today; Merchant.timezone in production), and the
 * calendar date always comes from a timezone-aware formatter — never from
 * slicing a UTC timestamp.
 */

import type { DueLogicInterventionRecord } from "./intervention";
import type { PriorScheduleChange } from "./schema";

/**
 * The calendar date of an ISO instant in the merchant timezone, or null
 * when the instant is unreadable. en-CA renders numeric dates as
 * YYYY-MM-DD. Mirrors the proven conversion used across the Pinch dev
 * routes and the intervention service.
 */
function merchantCalendarDateOfInstant(
  iso: string,
  timezone: string,
): string | null {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(parsed));
}

/**
 * Derives the payer's prior-change history from intervention records.
 *
 * One "executed-verified" permanent entry per verified executed
 * intervention, keyed and deduplicated by operationId; one non-counting
 * "manual-recovery" entry per manual-recovery record with an operation ID.
 * A record that lacks any trusted-evidence requirement is skipped — never
 * guessed into a counting entry. Output is freshly constructed, sorted by
 * entry id for determinism, and independent of input order (an
 * executed-verified entry always wins a duplicate-operationId collision).
 */
export function toPriorScheduleChanges(
  records: readonly DueLogicInterventionRecord[],
  payerId: string,
  merchantTimezone: string,
): readonly PriorScheduleChange[] {
  const byOperationId = new Map<string, PriorScheduleChange>();

  for (const record of records) {
    if (record.payerId !== payerId) {
      continue;
    }
    // A record carrying declinedAt is a decline whatever its stored status
    // says — the same precedence effectiveInterventionStatus applies.
    if (record.declinedAt !== null) {
      continue;
    }

    if (record.status === "executed") {
      // Trusted evidence of a verified permanent correction requires the
      // complete execution linkage; a populated operationId alone is never
      // enough. An unreadable write-back timestamp disqualifies the entry
      // rather than inventing a date.
      if (
        record.confirmationId === null ||
        record.operationId === null ||
        record.newSubscriptionId === null
      ) {
        continue;
      }
      const executedDate = merchantCalendarDateOfInstant(
        record.updatedAt,
        merchantTimezone,
      );
      if (executedDate === null) {
        continue;
      }
      // Duplicate executed evidence for one operation keeps the earliest
      // executed date, so the result never depends on input order.
      const existingExecuted = byOperationId.get(record.operationId);
      if (
        existingExecuted !== undefined &&
        existingExecuted.status === "executed-verified" &&
        existingExecuted.executedDate !== undefined &&
        existingExecuted.executedDate <= executedDate
      ) {
        continue;
      }
      byOperationId.set(record.operationId, {
        id: record.operationId,
        payerId: record.payerId,
        changeType: "permanent",
        status: "executed-verified",
        executedDate,
      });
      continue;
    }

    if (record.status === "manual-recovery-required") {
      if (record.operationId === null) {
        continue;
      }
      // Audit evidence only — the engine never counts manual-recovery.
      // Never displace executed-verified evidence for the same operation.
      const existing = byOperationId.get(record.operationId);
      if (existing !== undefined && existing.status === "executed-verified") {
        continue;
      }
      byOperationId.set(record.operationId, {
        id: record.operationId,
        payerId: record.payerId,
        changeType: "permanent",
        status: "manual-recovery",
      });
    }
    // invitation-created, opened, awaiting-date-selection, date-approved,
    // alternative-offered, escalated, preview-ready and executing produce
    // no entry: nothing has verifiably completed.
  }

  return [...byOperationId.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}
