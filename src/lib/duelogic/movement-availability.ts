/**
 * Server-derived customer movement availability: which of the three
 * customer-facing movement choices an intervention currently permits.
 *
 *   temporary                → "Move this payment only"
 *   permanent-current-cycle  → "Change this and future payments"
 *   permanent-next-cycle     → "Keep this payment and change future payments"
 *
 * Availability is decided by the AUTHORITATIVE policy engine and the
 * trusted plan-cadence resolver — never re-implemented here and never in
 * the browser. Each movement kind is probed by evaluating one concrete
 * candidate date through evaluateScheduleChange under the intervention's
 * BOUND policy snapshot, with derived verified permanent AND temporary
 * history, explicit trusted arrears, and the merchant-held plan mapping.
 * The engine's own outcome (approved / alternative / escalate) determines
 * availability; date windows come from the bound policy's values and the
 * resolver's cycle boundaries.
 *
 * The projection is customer-safe: kind, label, copy, permitted window
 * and a deterministic suggested flag only — never payment, subscription,
 * payer, merchant, plan or source IDs, policy JSON or internal reason
 * codes. Pure orchestration over injected effects; no Pinch import.
 */

import { addCalendarDays, addCalendarMonthsSameDay, parseCalendarDate } from "./calendar-date";
import type {
  DueLogicInterventionRecord,
  DueLogicInterventionRepository,
} from "./intervention";
import {
  evaluateScheduleChange,
  PolicyValidationError,
  type PermanentPolicyEvaluationRequest,
  type TemporaryPolicyEvaluationRequest,
} from "./policy/engine";
import { resolvePlanScheduleContext } from "./policy/plan-schedule-resolver";
import type {
  MerchantPolicyRepository,
  MerchantPolicySnapshot,
} from "./policy/policy-snapshot";
import { toPriorScheduleChanges } from "./prior-change-history";
import type {
  MerchantPlanScheduleConfiguration,
  PriorScheduleChange,
} from "./schema";
import {
  combinePriorScheduleChanges,
  toTemporaryPriorScheduleChanges,
} from "./temporary-operation";
import type { TemporaryOperationRepository } from "./dev-temporary-operation-store";
import type { AuthoritativePaymentSnapshot } from "@/lib/pinch/payment-movement";

export type MovementKind =
  | "temporary"
  | "permanent-current-cycle"
  | "permanent-next-cycle";

export const MOVEMENT_KINDS: readonly MovementKind[] = [
  "temporary",
  "permanent-current-cycle",
  "permanent-next-cycle",
];

/** Customer-facing labels and copy — the approved wording, verbatim. */
export const MOVEMENT_OPTION_COPY: Record<
  MovementKind,
  { label: string; copy: string }
> = {
  temporary: {
    label: "Move this payment only",
    copy: "Choose a new date for this upcoming payment. Your regular payment schedule will stay the same.",
  },
  "permanent-current-cycle": {
    label: "Change this and future payments",
    copy: "Move the upcoming payment and use the new date for future payments.",
  },
  "permanent-next-cycle": {
    label: "Keep this payment and change future payments",
    copy: "Leave the upcoming payment unchanged and begin the new regular payment date from the next billing cycle.",
  },
};

/** One customer-safe available movement option. */
export interface CustomerMovementOption {
  kind: MovementKind;
  label: string;
  copy: string;
  /** YYYY-MM-DD inclusive permitted date window for this movement kind. */
  windowStartDate: string;
  windowEndDate: string;
  /** Deterministic detector support: the detector-derived suggestion falls in this window. */
  suggested: boolean;
}

export interface MovementAvailability {
  options: CustomerMovementOption[];
  /** True when no movement is automatically available: merchant review. */
  reviewRequired: boolean;
}

export type MovementAvailabilityResult =
  | { outcome: "resolved"; availability: MovementAvailability }
  | { outcome: "policy-unresolved" }
  | { outcome: "configuration-error" };

export interface MovementAvailabilityDeps {
  policies: MerchantPolicyRepository;
  interventions: DueLogicInterventionRepository;
  temporaryOperations: TemporaryOperationRepository;
  /** Read-only upcoming scheduled payment; null disables temporary movement. */
  readUpcomingScheduledPayment(
    merchantId: string,
    payerId: string,
  ): Promise<AuthoritativePaymentSnapshot | null>;
  planScheduleConfiguration: MerchantPlanScheduleConfiguration;
  merchantTimezone: string;
  /** Explicit trusted arrears input — never inferred. */
  currentArrearsCents(): number;
  now(): string;
}

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

async function resolveBoundSnapshot(
  policies: MerchantPolicyRepository,
  record: DueLogicInterventionRecord,
): Promise<MerchantPolicySnapshot | null> {
  let snapshot: MerchantPolicySnapshot | null;
  try {
    snapshot = await policies.readByVersion(
      record.merchantId,
      record.policyVersion,
    );
  } catch {
    snapshot = null;
  }
  if (
    snapshot === null ||
    snapshot.merchantId !== record.merchantId ||
    snapshot.policyVersion !== record.policyVersion ||
    snapshot.policyVersion !== snapshot.policy.version
  ) {
    return null;
  }
  return snapshot;
}

/** The next payment date implied by the TRUSTED plan cadence mapping. */
function nextPaymentDateForCadence(
  cadence: "weekly" | "fortnightly" | "monthly",
  currentPaymentDate: string,
): string | null {
  if (cadence === "weekly") {
    return addCalendarDays(currentPaymentDate, 7);
  }
  if (cadence === "fortnightly") {
    return addCalendarDays(currentPaymentDate, 14);
  }
  return addCalendarMonthsSameDay(currentPaymentDate, 1);
}

/** Inclusive day iteration, bounded to one month of candidates. */
function* daysBetween(start: string, end: string): Generator<string> {
  let cursor: string | null = start;
  for (let i = 0; i < 31 && cursor !== null && cursor <= end; i += 1) {
    yield cursor;
    cursor = addCalendarDays(cursor, 1);
  }
}

/** First engine-plausible probe candidate inside a permanent window. */
function permanentProbeCandidate(
  windowStart: string,
  windowEnd: string,
  cadence: "weekly" | "fortnightly" | "monthly",
  excludedDate: string,
  preferredDate: string | null,
): string | null {
  const usable = (day: string): boolean => {
    if (day === excludedDate) {
      return false;
    }
    if (cadence === "monthly") {
      const parsed = parseCalendarDate(day);
      if (parsed === null || parsed.day > 28) {
        return false;
      }
    }
    return true;
  };
  if (
    preferredDate !== null &&
    preferredDate >= windowStart &&
    preferredDate <= windowEnd &&
    usable(preferredDate)
  ) {
    return preferredDate;
  }
  for (const day of daysBetween(windowStart, windowEnd)) {
    if (usable(day)) {
      return day;
    }
  }
  return null;
}

/**
 * Derives the customer's movement availability for one intervention. The
 * engine and resolver decide everything: temporary availability probes the
 * minimal later date; each permanent mode probes one concrete in-window
 * candidate under the correct effective cycle. Escalation outcomes make a
 * kind unavailable (the customer sees merchant-review wording only when
 * nothing at all is available); a malformed plan configuration is a
 * configuration error, never a customer-policy refusal.
 */
export async function deriveMovementAvailability(
  record: DueLogicInterventionRecord,
  deps: MovementAvailabilityDeps,
): Promise<MovementAvailabilityResult> {
  const snapshot = await resolveBoundSnapshot(deps.policies, record);
  if (snapshot === null) {
    return { outcome: "policy-unresolved" };
  }
  const nowIso = deps.now();
  const evaluationDate = merchantCalendarDateOfInstant(
    nowIso,
    deps.merchantTimezone,
  );
  if (evaluationDate === null) {
    return { outcome: "configuration-error" };
  }

  let history: readonly PriorScheduleChange[];
  try {
    history = combinePriorScheduleChanges(
      toPriorScheduleChanges(
        await deps.interventions.list(),
        record.payerId,
        deps.merchantTimezone,
      ),
      toTemporaryPriorScheduleChanges(
        await deps.temporaryOperations.list(),
        record.payerId,
        record.merchantId,
        deps.merchantTimezone,
      ),
    );
  } catch {
    return { outcome: "configuration-error" };
  }

  const options: CustomerMovementOption[] = [];

  // ------------------------------------------------------------------
  // Temporary movement: requires a live scheduled payment; the engine
  // probe uses the minimal later date, and the window is one day after
  // the payment through the bound policy's maximum shift.
  let payment: AuthoritativePaymentSnapshot | null;
  try {
    payment = await deps.readUpcomingScheduledPayment(
      record.merchantId,
      record.payerId,
    );
  } catch {
    payment = null;
  }
  if (
    payment !== null &&
    payment.payerId === record.payerId &&
    payment.status.toLowerCase() === "scheduled"
  ) {
    const probeDate = addCalendarDays(payment.transactionDate, 1);
    const windowEnd = addCalendarDays(
      payment.transactionDate,
      snapshot.policy.temporaryChange.maxShiftDays,
    );
    if (probeDate !== null && windowEnd !== null) {
      const probe: TemporaryPolicyEvaluationRequest = {
        changeType: "temporary",
        payerId: record.payerId,
        paymentId: payment.id,
        amountCents: payment.amountInCents,
        evaluationDate,
        currentArrearsCents: deps.currentArrearsCents(),
        currentPaymentDate: payment.transactionDate,
        requestedDate: probeDate,
      };
      try {
        const decision = evaluateScheduleChange(
          probe,
          history,
          snapshot.policy,
        );
        if (
          decision.outcome === "approved" ||
          decision.outcome === "shorter-alternative"
        ) {
          options.push({
            kind: "temporary",
            ...MOVEMENT_OPTION_COPY.temporary,
            windowStartDate: probeDate,
            windowEndDate: windowEnd,
            suggested: false,
          });
        }
      } catch (error) {
        if (!(error instanceof PolicyValidationError)) {
          throw error;
        }
        // e.g. the payment date is not evaluable today: not available.
      }
    }
  }

  // ------------------------------------------------------------------
  // Permanent movement: trusted cadence and cycle boundaries from the
  // merchant-held plan mapping. An unmapped plan disables both permanent
  // modes (merchant review); a malformed configuration is a
  // configuration error.
  const planMapping = deps.planScheduleConfiguration.plans[record.planId];
  if (planMapping !== undefined) {
    const nextPaymentDate = nextPaymentDateForCadence(
      planMapping.cadence,
      record.currentStartDate,
    );
    if (nextPaymentDate === null) {
      return { outcome: "configuration-error" };
    }
    let cycle;
    try {
      cycle = resolvePlanScheduleContext(
        {
          merchantId: record.merchantId,
          planId: record.planId,
          currentPaymentDate: record.currentStartDate,
          nextPaymentDate,
        },
        deps.planScheduleConfiguration,
      );
    } catch (error) {
      if (error instanceof PolicyValidationError) {
        return { outcome: "configuration-error" };
      }
      throw error;
    }
    if (cycle.outcome === "resolved") {
      const probeOutcome = (
        effectiveCycle: PermanentPolicyEvaluationRequest["effectiveCycle"],
        candidate: string,
        previousPaymentDate: string,
      ): "available" | "unavailable" => {
        const request: PermanentPolicyEvaluationRequest = {
          changeType: "permanent",
          payerId: record.payerId,
          paymentId: `${record.subscriptionId}-first-payment`,
          amountCents: record.currentPaymentAmountInCents,
          evaluationDate,
          currentArrearsCents: deps.currentArrearsCents(),
          scheduleCadence: cycle.scheduleCadence,
          effectiveCycle,
          previousPaymentDate,
          currentPaymentDate: record.currentStartDate,
          nextPaymentDate,
          currentCycleStartDate: cycle.currentCycleStartDate,
          currentCycleEndDate: cycle.currentCycleEndDate,
          nextCycleStartDate: cycle.nextCycleStartDate,
          nextCycleEndDate: cycle.nextCycleEndDate,
          requestedAnchorDate: candidate,
        };
        try {
          const decision = evaluateScheduleChange(
            request,
            history,
            snapshot.policy,
          );
          return decision.outcome === "approved" ? "available" : "unavailable";
        } catch (error) {
          if (error instanceof PolicyValidationError) {
            return "unavailable";
          }
          throw error;
        }
      };

      // A previous settled payment strictly before the evaluation date
      // (and therefore before the future current payment) keeps the
      // engine's date-sequence validation satisfied for probing; the real
      // customer evaluation continues to use the fixture-supplied trusted
      // value through the existing evaluateSelectedDate path.
      const probePreviousDate =
        addCalendarDays(evaluationDate, -1) ?? evaluationDate;

      // Current-cycle window: inside the assigned cycle, strictly after
      // the evaluation date.
      const currentWindowStart =
        addCalendarDays(evaluationDate, 1) ?? evaluationDate;
      const effectiveCurrentStart =
        currentWindowStart > cycle.currentCycleStartDate
          ? currentWindowStart
          : cycle.currentCycleStartDate;
      if (effectiveCurrentStart <= cycle.currentCycleEndDate) {
        const candidate = permanentProbeCandidate(
          effectiveCurrentStart,
          cycle.currentCycleEndDate,
          planMapping.cadence,
          record.currentStartDate,
          record.suggestedDate,
        );
        if (
          candidate !== null &&
          probeOutcome("current-and-future", candidate, probePreviousDate) ===
            "available"
        ) {
          options.push({
            kind: "permanent-current-cycle",
            ...MOVEMENT_OPTION_COPY["permanent-current-cycle"],
            windowStartDate: effectiveCurrentStart,
            windowEndDate: cycle.currentCycleEndDate,
            suggested:
              record.suggestedDate >= effectiveCurrentStart &&
              record.suggestedDate <= cycle.currentCycleEndDate,
          });
        }
      }

      // Next-cycle window: inside the next assigned cycle.
      const nextCandidate = permanentProbeCandidate(
        cycle.nextCycleStartDate,
        cycle.nextCycleEndDate,
        planMapping.cadence,
        nextPaymentDate,
        null,
      );
      if (
        nextCandidate !== null &&
        probeOutcome("next-cycle-and-future", nextCandidate, probePreviousDate) ===
          "available"
      ) {
        options.push({
          kind: "permanent-next-cycle",
          ...MOVEMENT_OPTION_COPY["permanent-next-cycle"],
          windowStartDate: cycle.nextCycleStartDate,
          windowEndDate: cycle.nextCycleEndDate,
          suggested:
            record.suggestedDate >= cycle.nextCycleStartDate &&
            record.suggestedDate <= cycle.nextCycleEndDate,
        });
      }
    }
  }

  return {
    outcome: "resolved",
    availability: { options, reviewRequired: options.length === 0 },
  };
}
