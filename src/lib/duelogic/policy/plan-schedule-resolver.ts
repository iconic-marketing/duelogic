/**
 * Deterministic plan-to-schedule context resolver.
 *
 * Converts trusted merchant-held plan configuration into the resolved
 * schedule context (cadence plus current and next billing-cycle boundaries)
 * that the policy engine evaluates. Pure and timezone-independent: no clock
 * reads, no locale parsing, no network, no environment access, no mutation
 * of the request or configuration, and deterministic output.
 *
 * Cadence is never inferred: not from payment-date spacing, not from
 * calculated-payment previews, not from the months containing two dates. An
 * unmapped plan is a configuration outcome that escalates for merchant
 * review; malformed configuration is a validation error; a mapped plan whose
 * payment dates contradict its configured cycle sequence is
 * PLAN_SCHEDULE_CONTEXT_MISMATCH.
 *
 * The policy engine stays independent of plan lookup: callers resolve the
 * context here first, then build the permanent policy request from the
 * resolved cadence and cycle boundaries. Live Pinch payment status remains
 * an execution-layer check before any mutation.
 */

import type {
  MerchantPlanScheduleConfiguration,
  PlanScheduleDefinition,
  SupportedScheduleCadence,
} from "../schema";
import {
  addCalendarDays,
  calendarDaysBetween,
  daysInMonth,
  formatCalendarDate,
  parseCalendarDate,
} from "../calendar-date";
import { PolicyValidationError } from "./engine";

// ---------------------------------------------------------------------------
// Resolver input and output

export type ResolvePlanScheduleContextRequest = {
  merchantId: string;
  planId: string;
  /** YYYY-MM-DD. */
  currentPaymentDate: string;
  /** YYYY-MM-DD. */
  nextPaymentDate: string;
};

export type ResolvedPlanScheduleContext = {
  outcome: "resolved";
  merchantId: string;
  planId: string;
  scheduleCadence: SupportedScheduleCadence;
  currentCycleStartDate: string;
  currentCycleEndDate: string;
  nextCycleStartDate: string;
  nextCycleEndDate: string;
};

export type UnmappedPlanScheduleEscalation = {
  outcome: "escalate";
  reasonCode: "PERMANENT_PLAN_SCHEDULE_UNMAPPED";
  ruleFired: "merchantPlanScheduleConfiguration.plans";
  explanation: string;
  merchantId: string;
  planId: string;
};

export type PlanScheduleResolution =
  | ResolvedPlanScheduleContext
  | UnmappedPlanScheduleEscalation;

// ---------------------------------------------------------------------------
// Validation

function invalidConfiguration(message: string): never {
  throw new PolicyValidationError("INVALID_PLAN_SCHEDULE_CONFIGURATION", message);
}

function contextMismatch(message: string): never {
  throw new PolicyValidationError("PLAN_SCHEDULE_CONTEXT_MISMATCH", message);
}

function invalidDate(field: string): never {
  throw new PolicyValidationError(
    "INVALID_DATE",
    `${field} must be a valid YYYY-MM-DD calendar date.`,
  );
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

/**
 * Malformed configuration is a validation error — never converted into a
 * manual-review decision, and never repaired.
 */
function assertValidConfiguration(
  configuration: MerchantPlanScheduleConfiguration,
): void {
  if (isBlank(configuration.merchantId)) {
    invalidConfiguration("Configuration merchantId must be a non-empty identifier.");
  }
  if (
    typeof configuration.plans !== "object" ||
    configuration.plans === null ||
    Array.isArray(configuration.plans)
  ) {
    invalidConfiguration("Configuration plans must be a plan-ID-keyed record.");
  }
  for (const [planId, definition] of Object.entries(configuration.plans)) {
    if (planId.trim() === "") {
      invalidConfiguration("A configuration plan key must be a non-empty plan ID.");
    }
    assertValidDefinition(definition);
  }
}

function assertValidDefinition(definition: PlanScheduleDefinition): void {
  // Malformed configuration arrives as runtime data, so the checks read an
  // untyped view — the declared literal types would otherwise make the
  // failure branches unrepresentable.
  const supplied = definition as {
    cadence?: unknown;
    cycleDefinition?: unknown;
    cycleLengthDays?: unknown;
    cycleAnchorDate?: unknown;
  };
  const cadence = supplied.cadence;
  if (cadence === "weekly" || cadence === "fortnightly") {
    const expectedLength = cadence === "weekly" ? 7 : 14;
    if (supplied.cycleDefinition !== "fixed-days") {
      invalidConfiguration(
        `A ${cadence} plan definition must use the fixed-days cycle definition.`,
      );
    }
    if (supplied.cycleLengthDays !== expectedLength) {
      invalidConfiguration(
        `A ${cadence} plan definition must have a cycle length of exactly ${expectedLength} days.`,
      );
    }
    if (
      typeof supplied.cycleAnchorDate !== "string" ||
      parseCalendarDate(supplied.cycleAnchorDate) === null
    ) {
      invalidConfiguration(
        `A ${cadence} plan definition cycleAnchorDate must be a valid YYYY-MM-DD calendar date.`,
      );
    }
    return;
  }
  if (cadence === "monthly") {
    if (supplied.cycleDefinition !== "calendar-month") {
      invalidConfiguration(
        "A monthly plan definition must use the calendar-month cycle definition.",
      );
    }
    // A monthly plan carries no fixed-days fields; their presence is
    // contradictory configuration, not something to ignore.
    if (supplied.cycleLengthDays !== undefined || supplied.cycleAnchorDate !== undefined) {
      invalidConfiguration(
        "A monthly plan definition must not carry fixed-days cycle fields.",
      );
    }
    return;
  }
  invalidConfiguration("A plan definition cadence is not a known cadence value.");
}

// ---------------------------------------------------------------------------
// Cycle resolution

/**
 * The unique fixed-length cycle in the anchor-defined sequence containing
 * `currentPaymentDate`, plus the contiguous next cycle. The anchor is
 * authoritative merchant configuration — never inferred from the payment
 * dates — and floor division locates cycles before the anchor as well.
 */
function resolveFixedDaysCycles(
  anchorDate: string,
  cycleLengthDays: number,
  currentPaymentDate: string,
  nextPaymentDate: string,
  cadence: "weekly" | "fortnightly",
): Omit<ResolvedPlanScheduleContext, "outcome" | "merchantId" | "planId" | "scheduleCadence"> {
  const offset = calendarDaysBetween(anchorDate, currentPaymentDate);
  if (offset === null) {
    invalidDate("currentPaymentDate");
  }
  const cycleIndex = Math.floor(offset / cycleLengthDays);

  const currentCycleStartDate = addCalendarDays(
    anchorDate,
    cycleIndex * cycleLengthDays,
  );
  if (currentCycleStartDate === null) {
    invalidDate("cycleAnchorDate");
  }
  const currentCycleEndDate = addCalendarDays(
    currentCycleStartDate,
    cycleLengthDays - 1,
  ) as string;
  const nextCycleStartDate = addCalendarDays(currentCycleEndDate, 1) as string;
  const nextCycleEndDate = addCalendarDays(
    nextCycleStartDate,
    cycleLengthDays - 1,
  ) as string;

  if (
    nextPaymentDate < nextCycleStartDate ||
    nextPaymentDate > nextCycleEndDate
  ) {
    contextMismatch(
      `nextPaymentDate does not fall inside the next ${cadence} cycle defined by the plan's configured anchor.`,
    );
  }

  return {
    currentCycleStartDate,
    currentCycleEndDate,
    nextCycleStartDate,
    nextCycleEndDate,
  };
}

/**
 * Full calendar months: the month containing `currentPaymentDate` and the
 * immediately following month. The monthly cadence comes from the plan map —
 * never from the fact that two dates appear in adjacent months.
 */
function resolveCalendarMonthCycles(
  currentPaymentDate: string,
  nextPaymentDate: string,
): Omit<ResolvedPlanScheduleContext, "outcome" | "merchantId" | "planId" | "scheduleCadence"> {
  const current = parseCalendarDate(currentPaymentDate);
  if (current === null) {
    invalidDate("currentPaymentDate");
  }
  const currentCycleStartDate = formatCalendarDate({
    year: current.year,
    month: current.month,
    day: 1,
  });
  const currentCycleEndDate = formatCalendarDate({
    year: current.year,
    month: current.month,
    day: daysInMonth(current.year, current.month),
  });
  const nextCycleStartDate = addCalendarDays(currentCycleEndDate, 1) as string;
  const following = parseCalendarDate(nextCycleStartDate) as NonNullable<
    ReturnType<typeof parseCalendarDate>
  >;
  const nextCycleEndDate = formatCalendarDate({
    year: following.year,
    month: following.month,
    day: daysInMonth(following.year, following.month),
  });

  if (
    nextPaymentDate < nextCycleStartDate ||
    nextPaymentDate > nextCycleEndDate
  ) {
    contextMismatch(
      "nextPaymentDate does not fall inside the calendar month immediately following currentPaymentDate.",
    );
  }

  return {
    currentCycleStartDate,
    currentCycleEndDate,
    nextCycleStartDate,
    nextCycleEndDate,
  };
}

// ---------------------------------------------------------------------------
// Resolver entry point

export function resolvePlanScheduleContext(
  request: ResolvePlanScheduleContextRequest,
  configuration: MerchantPlanScheduleConfiguration,
): PlanScheduleResolution {
  assertValidConfiguration(configuration);

  if (isBlank(request.merchantId)) {
    invalidConfiguration("Request merchantId must be a non-empty identifier.");
  }
  if (isBlank(request.planId)) {
    invalidConfiguration("Request planId must be a non-empty identifier.");
  }
  if (request.merchantId !== configuration.merchantId) {
    invalidConfiguration(
      "The supplied configuration does not belong to the requested merchant.",
    );
  }
  if (parseCalendarDate(request.currentPaymentDate) === null) {
    invalidDate("currentPaymentDate");
  }
  if (parseCalendarDate(request.nextPaymentDate) === null) {
    invalidDate("nextPaymentDate");
  }

  // An unmapped plan is a configuration outcome, not malformed input: no
  // cadence guess, no calculated-payment inspection, no monthly fallback and
  // no cycle boundaries — only an escalation for merchant review.
  if (!Object.prototype.hasOwnProperty.call(configuration.plans, request.planId)) {
    return {
      outcome: "escalate",
      reasonCode: "PERMANENT_PLAN_SCHEDULE_UNMAPPED",
      ruleFired: "merchantPlanScheduleConfiguration.plans",
      explanation:
        "Automatic permanent date changes are not configured for this payment plan. The request requires merchant review.",
      merchantId: request.merchantId,
      planId: request.planId,
    };
  }

  const definition = configuration.plans[request.planId];
  const cycles =
    definition.cadence === "monthly"
      ? resolveCalendarMonthCycles(
          request.currentPaymentDate,
          request.nextPaymentDate,
        )
      : resolveFixedDaysCycles(
          definition.cycleAnchorDate,
          definition.cycleLengthDays,
          request.currentPaymentDate,
          request.nextPaymentDate,
          definition.cadence,
        );

  return {
    outcome: "resolved",
    merchantId: request.merchantId,
    planId: request.planId,
    scheduleCadence: definition.cadence,
    ...cycles,
  };
}
