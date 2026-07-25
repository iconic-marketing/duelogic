/**
 * DueLogic policy and eligibility engine.
 *
 * Pure deterministic evaluation of one schedule-change request against a
 * declarative, versioned policy: no Pinch imports, no network, no
 * environment access, no clock reads, no randomness, no mutation of the
 * request, history or policy, and output invariant to history input order.
 * All calendar arithmetic works on parsed YYYY-MM-DD components via UTC
 * millisecond maths, so the server timezone can never influence a decision.
 * Monetary values stay integer cents everywhere except the human-readable
 * explanation boundary.
 *
 * The engine decides calendar and policy eligibility only. Whether a live
 * Pinch payment remains operationally changeable is the execution layer's
 * responsibility: it must read the payment immediately before mutation,
 * confirm its live status is still "scheduled", stop without mutation when
 * it is not, never retry a mutation automatically, and read back and verify
 * any successful change. Policy support for a cadence does not itself prove
 * that live replacement execution has been verified for that cadence.
 */

import type {
  DueLogicPolicy,
  PermanentEffectiveCycle,
  PriorScheduleChange,
  PriorScheduleChangeStatus,
  ScheduleCadence,
  SupportedScheduleCadence,
} from "../schema";
import {
  addCalendarDays,
  addCalendarMonthsSameDay,
  calendarDaysBetween,
  daysInMonth,
  formatCalendarDate,
  monthsEarlier,
  parseCalendarDate,
  type CalendarDate,
} from "../calendar-date";
import { DEFAULT_DUELOGIC_POLICY } from "./rules";

// ---------------------------------------------------------------------------
// Request types

export type PolicyEvaluationCommon = {
  payerId: string;
  paymentId: string;
  /** Integer cents for the single scheduled payment being changed. */
  amountCents: number;
  /** YYYY-MM-DD; explicit and required — the engine never reads a clock. */
  evaluationDate: string;
  /** Integer cents, supplied explicitly — never inferred from history. */
  currentArrearsCents: number;
};

export type TemporaryPolicyEvaluationRequest = PolicyEvaluationCommon & {
  changeType: "temporary";
  currentPaymentDate: string;
  requestedDate: string;
};

export type PermanentPolicyEvaluationRequest = PolicyEvaluationCommon & {
  changeType: "permanent";
  /** From trusted merchant/plan/schedule metadata — never inferred. */
  scheduleCadence: ScheduleCadence;
  effectiveCycle: PermanentEffectiveCycle;
  previousPaymentDate: string;
  currentPaymentDate: string;
  nextPaymentDate: string;
  currentCycleStartDate: string;
  currentCycleEndDate: string;
  nextCycleStartDate: string;
  nextCycleEndDate: string;
  /** Exact YYYY-MM-DD anchor; future dates derive from anchor and cadence. */
  requestedAnchorDate: string;
};

export type PolicyEvaluationRequest =
  | TemporaryPolicyEvaluationRequest
  | PermanentPolicyEvaluationRequest;

// ---------------------------------------------------------------------------
// Warning types

export type PaymentsCloseTogetherWarning = {
  code: "PAYMENTS_CLOSE_TOGETHER";
  ruleFired: "permanentChange.closePaymentWarningDays";
  scheduleCadence: SupportedScheduleCadence;
  earlierPaymentDate: string;
  laterPaymentDate: string;
  gapDays: number;
  thresholdDays: number;
  explanation: string;
};

export type PolicyWarning = PaymentsCloseTogetherWarning;

// ---------------------------------------------------------------------------
// Decision types

export type PolicyUsage = {
  verifiedUsesInPeriod: number;
  permittedUses: number;
};

type PolicyDecisionCommon = {
  explanation: string;
  /** Equals the explicit evaluationDate. */
  evaluatedAt: string;
  policyVersion: string;
  /** The counter relevant to the request's changeType. */
  usage: PolicyUsage;
};

export type ApprovedTemporaryPolicyDecision = PolicyDecisionCommon & {
  outcome: "approved";
  changeType: "temporary";
  reasonCode: "POLICY_APPROVED";
  ruleFired: "all-policy-rules-passed";
  currentPaymentDate: string;
  approvedPaymentDate: string;
  shiftDays: number;
  confirmationRequired: false;
  warnings: PolicyWarning[];
};

export type PermanentCurrentPaymentAction = "move-earlier" | "move-later" | "keep";

export type ApprovedPermanentPolicyDecision = PolicyDecisionCommon & {
  outcome: "approved";
  changeType: "permanent";
  reasonCode: "POLICY_APPROVED";
  ruleFired: "all-policy-rules-passed";
  scheduleCadence: SupportedScheduleCadence;
  effectiveCycle: PermanentEffectiveCycle;
  currentPaymentAction: PermanentCurrentPaymentAction;
  originalCurrentPaymentDate: string;
  resultingCurrentPaymentDate: string;
  firstRevisedPaymentDate: string;
  requestedAnchorDate: string;
  revisedSchedulePreview: [string, string, string];
  confirmationRequired: true;
  warningAcknowledgementRequired: boolean;
  warnings: PolicyWarning[];
};

export type ApprovedPolicyDecision =
  | ApprovedTemporaryPolicyDecision
  | ApprovedPermanentPolicyDecision;

export type TemporaryShorterAlternativeDecision = PolicyDecisionCommon & {
  outcome: "shorter-alternative";
  changeType: "temporary";
  reasonCode: "TEMPORARY_SHIFT_EXCEEDS_MAXIMUM";
  ruleFired: "temporaryChange.maxShiftDays";
  requestedShiftDays: number;
  maximumShiftDays: number;
  alternativeDate: string;
  confirmationRequired: true;
  warnings: PolicyWarning[];
};

export type PermanentNextCycleAlternativeDecision = PolicyDecisionCommon & {
  outcome: "next-cycle-alternative";
  changeType: "permanent";
  reasonCode: "PERMANENT_CURRENT_CYCLE_DATE_UNAVAILABLE";
  ruleFired: "permanentChange.currentCycleAvailability";
  scheduleCadence: SupportedScheduleCadence;
  suggestedEffectiveCycle: "next-cycle-and-future";
  currentPaymentAction: "keep";
  originalCurrentPaymentDate: string;
  resultingCurrentPaymentDate: string;
  firstRevisedPaymentDate: string;
  requestedAnchorDate: string;
  derivedNextCycleAnchorDate: string;
  revisedSchedulePreview: [string, string, string];
  confirmationRequired: true;
  warningAcknowledgementRequired: boolean;
  warnings: PolicyWarning[];
};

export type EscalationReasonCode =
  | "CURRENT_ARREARS_PRESENT"
  | "AMOUNT_CEILING_EXCEEDED"
  | "TEMPORARY_CHANGE_LIMIT_REACHED"
  | "PERMANENT_CHANGE_LIMIT_REACHED"
  | "PERMANENT_SCHEDULE_CADENCE_UNSUPPORTED";

export type EscalatePolicyDecision = PolicyDecisionCommon & {
  outcome: "escalate";
  changeType: "temporary" | "permanent";
  reasonCode: EscalationReasonCode;
  ruleFired: string;
  confirmationRequired: false;
  warnings: PolicyWarning[];
};

export type PolicyDecision =
  | ApprovedPolicyDecision
  | TemporaryShorterAlternativeDecision
  | PermanentNextCycleAlternativeDecision
  | EscalatePolicyDecision;

// ---------------------------------------------------------------------------
// Validation errors

export type PolicyValidationCode =
  | "INVALID_IDENTIFIER"
  | "INVALID_AMOUNT_CENTS"
  | "INVALID_ARREARS_CENTS"
  | "INVALID_DATE"
  | "INVALID_DATE_SEQUENCE"
  | "INVALID_CADENCE"
  | "INVALID_CYCLE_METADATA"
  | "INVALID_MONTHLY_ANCHOR_DAY"
  | "TEMPORARY_DATE_NOT_LATER"
  | "PERMANENT_DATE_UNCHANGED"
  | "PERMANENT_TRANSITION_NOT_POSITIVE"
  | "EXECUTED_CHANGE_DATE_REQUIRED"
  | "INVALID_POLICY_VALUE"
  | "INVALID_CHANGE_TYPE"
  | "INVALID_HISTORY_STATUS"
  | "INVALID_PLAN_SCHEDULE_CONFIGURATION"
  | "PLAN_SCHEDULE_CONTEXT_MISMATCH";

/**
 * Invalid input is not a policy decision. Messages are safe by construction:
 * they name the failed constraint and field only — never input values, stack
 * detail, secrets or upstream bodies.
 */
export class PolicyValidationError extends Error {
  readonly code: PolicyValidationCode;

  constructor(code: PolicyValidationCode, message: string) {
    super(message);
    this.name = "PolicyValidationError";
    this.code = code;
  }
}

function invalid(code: PolicyValidationCode, message: string): never {
  throw new PolicyValidationError(code, message);
}

// ---------------------------------------------------------------------------
// Calendar helpers: shared pure implementations live in ../calendar-date;
// these thin wrappers convert a null result into the engine's INVALID_DATE
// validation error, preserving the original engine behaviour exactly.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** Whole calendar days from `from` to `to`; both must be pre-validated. */
function daysBetween(from: string, to: string): number {
  const days = calendarDaysBetween(from, to);
  return days === null
    ? invalid("INVALID_DATE", "A date was not a valid YYYY-MM-DD calendar date.")
    : days;
}

/** The pre-validated date plus whole calendar days. */
function addDays(value: string, days: number): string {
  const result = addCalendarDays(value, days);
  return result === null
    ? invalid("INVALID_DATE", "A date was not a valid YYYY-MM-DD calendar date.")
    : result;
}

/**
 * The same day of month `months` calendar months later. Callers only pass
 * days that exist in every month (1-28), so no clamping ever applies —
 * never 30-day or average-month arithmetic.
 */
function addMonthsSameDay(value: string, months: number): string {
  const result = addCalendarMonthsSameDay(value, months);
  return result === null
    ? invalid("INVALID_DATE", "A date was not a valid YYYY-MM-DD calendar date.")
    : result;
}

// ---------------------------------------------------------------------------
// Explanation formatting boundary

/** Deterministic Australian-style day-and-month wording, e.g. "31 January". */
function formatDayMonth(value: string): string {
  const date = parseCalendarDate(value);
  if (date === null) {
    return invalid("INVALID_DATE", "A date was not a valid YYYY-MM-DD calendar date.");
  }
  return `${date.day} ${MONTH_NAMES[date.month - 1]}`;
}

/** Deterministic cents-to-dollar formatting, e.g. 50000 -> "$500.00". */
function formatCentsAsDollars(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const remainder = String(cents % 100).padStart(2, "0");
  return `$${dollars}.${remainder}`;
}

function dayWord(count: number): string {
  return count === 1 ? "day" : "days";
}

function changeWord(count: number): string {
  return count === 1 ? "change" : "changes";
}

// ---------------------------------------------------------------------------
// Policy validation

const KNOWN_CADENCES: readonly ScheduleCadence[] = [
  "weekly",
  "fortnightly",
  "monthly",
  "four-weekly",
  "custom",
];

const HISTORY_STATUSES: readonly PriorScheduleChangeStatus[] = [
  "executed-verified",
  "refused",
  "abandoned",
  "execution-failed",
  "manual-recovery",
];

/** Exclusive upper bound for each cadence's close-payment threshold. */
const WARNING_THRESHOLD_BOUNDS: Readonly<Record<SupportedScheduleCadence, number>> = {
  weekly: 7,
  fortnightly: 14,
  monthly: 28,
};

function isEngineCadence(value: ScheduleCadence): value is SupportedScheduleCadence {
  return value === "weekly" || value === "fortnightly" || value === "monthly";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function assertValidPolicy(policy: DueLogicPolicy): void {
  const fail = (field: string): never =>
    invalid("INVALID_POLICY_VALUE", `Policy value ${field} is invalid.`);

  if (typeof policy.version !== "string" || policy.version.trim() === "") {
    fail("version");
  }
  if (!isPositiveInteger(policy.amountCeilingCents)) {
    fail("amountCeilingCents");
  }

  const temporary = policy.temporaryChange;
  if (!isNonNegativeInteger(temporary.maxVerifiedUses)) {
    fail("temporaryChange.maxVerifiedUses");
  }
  if (!isPositiveInteger(temporary.rollingPeriodMonths)) {
    fail("temporaryChange.rollingPeriodMonths");
  }
  if (!isPositiveInteger(temporary.maxShiftDays)) {
    fail("temporaryChange.maxShiftDays");
  }

  const permanent = policy.permanentChange;
  if (!isNonNegativeInteger(permanent.maxVerifiedUses)) {
    fail("permanentChange.maxVerifiedUses");
  }
  if (!isPositiveInteger(permanent.rollingPeriodMonths)) {
    fail("permanentChange.rollingPeriodMonths");
  }
  if (
    !Array.isArray(permanent.supportedCadences) ||
    permanent.supportedCadences.length === 0
  ) {
    fail("permanentChange.supportedCadences");
  }
  if (
    new Set(permanent.supportedCadences).size !== permanent.supportedCadences.length
  ) {
    fail("permanentChange.supportedCadences");
  }
  for (const cadence of permanent.supportedCadences) {
    if (!KNOWN_CADENCES.includes(cadence)) {
      fail("permanentChange.supportedCadences");
    }
  }
  if (permanent.keepPaymentWithinAssignedCycle !== true) {
    fail("permanentChange.keepPaymentWithinAssignedCycle");
  }
  if (permanent.cycleLengthDays.weekly !== 7) {
    fail("permanentChange.cycleLengthDays.weekly");
  }
  if (permanent.cycleLengthDays.fortnightly !== 14) {
    fail("permanentChange.cycleLengthDays.fortnightly");
  }
  const anchorDay = permanent.monthlyAnchorDay;
  if (!isPositiveInteger(anchorDay.minimum) || !isPositiveInteger(anchorDay.maximum)) {
    fail("permanentChange.monthlyAnchorDay");
  }
  if (anchorDay.minimum > anchorDay.maximum || anchorDay.maximum > 28) {
    fail("permanentChange.monthlyAnchorDay");
  }
  if (permanent.allowSameDayCurrentCycleChange !== false) {
    fail("permanentChange.allowSameDayCurrentCycleChange");
  }
  // Any supplied threshold must be a positive integer materially below its
  // cadence length; every supported engine cadence must have one.
  for (const cadence of ["weekly", "fortnightly", "monthly"] as const) {
    const threshold = permanent.closePaymentWarningDays[cadence];
    if (threshold === undefined) {
      continue;
    }
    if (!isPositiveInteger(threshold) || threshold >= WARNING_THRESHOLD_BOUNDS[cadence]) {
      fail(`permanentChange.closePaymentWarningDays.${cadence}`);
    }
  }
  for (const cadence of permanent.supportedCadences) {
    if (!isEngineCadence(cadence)) {
      // Known but non-executable cadences cannot be declared supported: the
      // engine has no cycle rules or warning threshold for them.
      fail("permanentChange.supportedCadences");
    } else if (permanent.closePaymentWarningDays[cadence] === undefined) {
      fail(`permanentChange.closePaymentWarningDays.${cadence}`);
    }
  }
  if (permanent.closePaymentAction !== "warn-and-confirm") {
    fail("permanentChange.closePaymentAction");
  }
  if (permanent.unsupportedCadenceAction !== "escalate") {
    fail("permanentChange.unsupportedCadenceAction");
  }
  if (permanent.overLimitAction !== "escalate") {
    fail("permanentChange.overLimitAction");
  }
  if (!isNonNegativeInteger(policy.arrears.disqualifyWhenCurrentArrearsCentsAbove)) {
    fail("arrears.disqualifyWhenCurrentArrearsCentsAbove");
  }
  if (policy.arrears.action !== "escalate") {
    fail("arrears.action");
  }
}

// ---------------------------------------------------------------------------
// Request validation

/** Non-empty after trimming; the caller's string is never mutated. */
function assertIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    invalid("INVALID_IDENTIFIER", `${field} must be a non-empty identifier.`);
  }
}

function assertCalendarDate(value: string, field: string): void {
  if (parseCalendarDate(value) === null) {
    invalid("INVALID_DATE", `${field} must be a valid YYYY-MM-DD calendar date.`);
  }
}

function assertCommonFields(request: PolicyEvaluationRequest): void {
  assertIdentifier(request.payerId, "payerId");
  assertIdentifier(request.paymentId, "paymentId");
  if (!isPositiveInteger(request.amountCents)) {
    invalid("INVALID_AMOUNT_CENTS", "amountCents must be a positive integer of cents.");
  }
  if (!isNonNegativeInteger(request.currentArrearsCents)) {
    invalid(
      "INVALID_ARREARS_CENTS",
      "currentArrearsCents must be a non-negative integer of cents.",
    );
  }
  assertCalendarDate(request.evaluationDate, "evaluationDate");
}

function assertTemporaryRequest(request: TemporaryPolicyEvaluationRequest): void {
  assertCalendarDate(request.currentPaymentDate, "currentPaymentDate");
  assertCalendarDate(request.requestedDate, "requestedDate");
  // Validated YYYY-MM-DD strings compare lexicographically as dates.
  if (request.requestedDate <= request.currentPaymentDate) {
    invalid(
      "TEMPORARY_DATE_NOT_LATER",
      "requestedDate must be strictly later than currentPaymentDate.",
    );
  }
}

const PERMANENT_CYCLE_DATE_FIELDS = [
  "previousPaymentDate",
  "currentPaymentDate",
  "nextPaymentDate",
  "currentCycleStartDate",
  "currentCycleEndDate",
  "nextCycleStartDate",
  "nextCycleEndDate",
  "requestedAnchorDate",
] as const;

function invalidCycle(message: string): never {
  return invalid("INVALID_CYCLE_METADATA", message);
}

/**
 * Steps 3-5 of the precedence order: request-specific dates, generic cycle
 * metadata, then cadence-specific cycle metadata. Malformed or contradictory
 * cycle metadata is a validation error — never repaired, inferred or
 * escalated as a policy outcome.
 */
function assertPermanentRequest(
  request: PermanentPolicyEvaluationRequest,
  policy: DueLogicPolicy,
): void {
  if (!KNOWN_CADENCES.includes(request.scheduleCadence)) {
    invalid("INVALID_CADENCE", "scheduleCadence is not a known cadence value.");
  }
  if (
    request.effectiveCycle !== "current-and-future" &&
    request.effectiveCycle !== "next-cycle-and-future"
  ) {
    invalidCycle("effectiveCycle must be current-and-future or next-cycle-and-future.");
  }

  // Generic check 1: every supplied cycle-related date must be valid.
  for (const field of PERMANENT_CYCLE_DATE_FIELDS) {
    if (parseCalendarDate(request[field]) === null) {
      invalidCycle(`${field} must be a valid YYYY-MM-DD calendar date.`);
    }
  }

  // Ordering against the explicit evaluation date.
  if (request.previousPaymentDate > request.evaluationDate) {
    invalid(
      "INVALID_DATE_SEQUENCE",
      "previousPaymentDate must be on or before evaluationDate.",
    );
  }
  if (request.evaluationDate > request.currentPaymentDate) {
    invalid(
      "INVALID_DATE_SEQUENCE",
      "evaluationDate must be on or before currentPaymentDate.",
    );
  }

  // Generic checks 2-8.
  if (request.previousPaymentDate >= request.currentPaymentDate) {
    invalidCycle("previousPaymentDate must be strictly earlier than currentPaymentDate.");
  }
  if (request.currentPaymentDate >= request.nextPaymentDate) {
    invalidCycle("currentPaymentDate must be strictly earlier than nextPaymentDate.");
  }
  if (request.currentCycleStartDate > request.currentCycleEndDate) {
    invalidCycle("currentCycleStartDate must be on or before currentCycleEndDate.");
  }
  if (request.nextCycleStartDate > request.nextCycleEndDate) {
    invalidCycle("nextCycleStartDate must be on or before nextCycleEndDate.");
  }
  if (request.nextCycleStartDate !== addDays(request.currentCycleEndDate, 1)) {
    invalidCycle(
      "nextCycleStartDate must be exactly one calendar day after currentCycleEndDate.",
    );
  }
  if (
    request.currentPaymentDate < request.currentCycleStartDate ||
    request.currentPaymentDate > request.currentCycleEndDate
  ) {
    invalidCycle("currentPaymentDate must fall inside the supplied current cycle.");
  }
  if (
    request.nextPaymentDate < request.nextCycleStartDate ||
    request.nextPaymentDate > request.nextCycleEndDate
  ) {
    invalidCycle("nextPaymentDate must fall inside the supplied next cycle.");
  }
  const selectedCycleStart =
    request.effectiveCycle === "current-and-future"
      ? request.currentCycleStartDate
      : request.nextCycleStartDate;
  const selectedCycleEnd =
    request.effectiveCycle === "current-and-future"
      ? request.currentCycleEndDate
      : request.nextCycleEndDate;
  if (
    request.requestedAnchorDate < selectedCycleStart ||
    request.requestedAnchorDate > selectedCycleEnd
  ) {
    invalidCycle(
      "requestedAnchorDate must fall inside the cycle selected by effectiveCycle.",
    );
  }

  // Cadence-specific cycle metadata for the engine-known cadences. A valid
  // but policy-unsupported cadence skips this and later receives the
  // unsupported-cadence policy escalation instead.
  if (request.scheduleCadence === "weekly" || request.scheduleCadence === "fortnightly") {
    const cycleLength =
      request.scheduleCadence === "weekly"
        ? policy.permanentChange.cycleLengthDays.weekly
        : policy.permanentChange.cycleLengthDays.fortnightly;
    const currentLength =
      daysBetween(request.currentCycleStartDate, request.currentCycleEndDate) + 1;
    const nextLength =
      daysBetween(request.nextCycleStartDate, request.nextCycleEndDate) + 1;
    if (currentLength !== cycleLength || nextLength !== cycleLength) {
      invalidCycle(
        `A ${request.scheduleCadence} cycle must contain exactly ${cycleLength} inclusive calendar days.`,
      );
    }
  } else if (request.scheduleCadence === "monthly") {
    const current = parseCalendarDate(request.currentPaymentDate) as CalendarDate;
    const monthStart = formatCalendarDate({ year: current.year, month: current.month, day: 1 });
    const monthEnd = formatCalendarDate({
      year: current.year,
      month: current.month,
      day: daysInMonth(current.year, current.month),
    });
    if (
      request.currentCycleStartDate !== monthStart ||
      request.currentCycleEndDate !== monthEnd
    ) {
      invalidCycle(
        "A monthly current cycle must be the complete calendar month containing currentPaymentDate.",
      );
    }
    const followingStart = addDays(monthEnd, 1);
    const following = parseCalendarDate(followingStart) as CalendarDate;
    const followingEnd = formatCalendarDate({
      year: following.year,
      month: following.month,
      day: daysInMonth(following.year, following.month),
    });
    if (
      request.nextCycleStartDate !== followingStart ||
      request.nextCycleEndDate !== followingEnd
    ) {
      invalidCycle(
        "A monthly next cycle must be the complete calendar month following the current cycle.",
      );
    }
    const anchor = parseCalendarDate(request.requestedAnchorDate) as CalendarDate;
    const { minimum, maximum } = policy.permanentChange.monthlyAnchorDay;
    if (anchor.day < minimum || anchor.day > maximum) {
      invalid(
        "INVALID_MONTHLY_ANCHOR_DAY",
        `A monthly anchor day must be between ${minimum} and ${maximum} inclusive.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// History validation and usage counting

function assertValidHistory(history: readonly PriorScheduleChange[]): void {
  for (const entry of history) {
    assertIdentifier(entry.id, "A history entry id");
    assertIdentifier(entry.payerId, "A history entry payerId");
    if (entry.changeType !== "temporary" && entry.changeType !== "permanent") {
      invalid(
        "INVALID_CHANGE_TYPE",
        "A history entry changeType must be temporary or permanent.",
      );
    }
    if (!HISTORY_STATUSES.includes(entry.status)) {
      invalid("INVALID_HISTORY_STATUS", "A history entry status is not a known status.");
    }
    if (entry.executedDate !== undefined) {
      assertCalendarDate(entry.executedDate, "A history entry executedDate");
    }
    if (entry.status === "executed-verified" && entry.executedDate === undefined) {
      invalid(
        "EXECUTED_CHANGE_DATE_REQUIRED",
        "An executed-verified history entry requires executedDate.",
      );
    }
  }
}

/**
 * Rolling window [evaluationDate minus rollingPeriodMonths, evaluationDate):
 * inclusive start, exclusive evaluation date. Only executed-verified entries
 * for the same payer and the same change type count; counting never reorders
 * or mutates the supplied history and is invariant to its order.
 */
function countVerifiedUses(
  history: readonly PriorScheduleChange[],
  payerId: string,
  changeType: "temporary" | "permanent",
  evaluationDate: string,
  rollingPeriodMonths: number,
): number {
  const evaluation = parseCalendarDate(evaluationDate) as CalendarDate;
  const windowStart = formatCalendarDate(monthsEarlier(evaluation, rollingPeriodMonths));
  let count = 0;
  for (const entry of history) {
    if (
      entry.payerId !== payerId ||
      entry.changeType !== changeType ||
      entry.status !== "executed-verified" ||
      entry.executedDate === undefined
    ) {
      continue;
    }
    if (entry.executedDate >= windowStart && entry.executedDate < evaluationDate) {
      count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Decision builders

function buildEscalation(
  request: PolicyEvaluationRequest,
  policy: DueLogicPolicy,
  usage: PolicyUsage,
  reasonCode: EscalationReasonCode,
  ruleFired: string,
  explanation: string,
): EscalatePolicyDecision {
  return {
    outcome: "escalate",
    changeType: request.changeType,
    reasonCode,
    ruleFired,
    explanation,
    evaluatedAt: request.evaluationDate,
    policyVersion: policy.version,
    usage,
    confirmationRequired: false,
    warnings: [],
  };
}

/** Exactly three preview dates advancing by the cadence — never 30-day maths. */
function buildSchedulePreview(
  firstRevisedPaymentDate: string,
  cadence: SupportedScheduleCadence,
): [string, string, string] {
  if (cadence === "weekly") {
    return [
      firstRevisedPaymentDate,
      addDays(firstRevisedPaymentDate, 7),
      addDays(firstRevisedPaymentDate, 14),
    ];
  }
  if (cadence === "fortnightly") {
    return [
      firstRevisedPaymentDate,
      addDays(firstRevisedPaymentDate, 14),
      addDays(firstRevisedPaymentDate, 28),
    ];
  }
  return [
    firstRevisedPaymentDate,
    addMonthsSameDay(firstRevisedPaymentDate, 1),
    addMonthsSameDay(firstRevisedPaymentDate, 2),
  ];
}

/**
 * Cadence-specific transition-spacing warning. A gap at or above the
 * threshold produces no warning; a close gap is a warning and
 * acknowledgement requirement only — never a rejection or escalation.
 */
function buildCloseTogetherWarning(
  earlierPaymentDate: string,
  laterPaymentDate: string,
  earlierDescription: "current" | "previous",
  cadence: SupportedScheduleCadence,
  policy: DueLogicPolicy,
): PolicyWarning | null {
  const thresholdDays = policy.permanentChange.closePaymentWarningDays[cadence];
  if (thresholdDays === undefined) {
    // Unreachable after policy validation; kept as a deterministic guard.
    return invalid(
      "INVALID_POLICY_VALUE",
      `Policy value permanentChange.closePaymentWarningDays.${cadence} is invalid.`,
    );
  }
  const gapDays = daysBetween(earlierPaymentDate, laterPaymentDate);
  if (gapDays <= 0 || gapDays >= thresholdDays) {
    return null;
  }
  const earlierWording =
    earlierDescription === "current"
      ? `The current payment will be processed on ${formatDayMonth(earlierPaymentDate)}.`
      : `The previous payment was processed on ${formatDayMonth(earlierPaymentDate)}.`;
  return {
    code: "PAYMENTS_CLOSE_TOGETHER",
    ruleFired: "permanentChange.closePaymentWarningDays",
    scheduleCadence: cadence,
    earlierPaymentDate,
    laterPaymentDate,
    gapDays,
    thresholdDays,
    explanation:
      `${earlierWording} The first payment on the new schedule will be processed on ` +
      `${formatDayMonth(laterPaymentDate)}, ${gapDays} ${dayWord(gapDays)} later.`,
  };
}

/**
 * The equivalent anchor inside the next assigned cycle: same offset from the
 * cycle start for weekly and fortnightly, same day of month for monthly.
 */
function deriveNextCycleAnchor(
  request: PermanentPolicyEvaluationRequest,
  cadence: SupportedScheduleCadence,
): string {
  if (cadence === "monthly") {
    const anchor = parseCalendarDate(request.requestedAnchorDate) as CalendarDate;
    const nextStart = parseCalendarDate(request.nextCycleStartDate) as CalendarDate;
    return formatCalendarDate({
      year: nextStart.year,
      month: nextStart.month,
      day: anchor.day,
    });
  }
  const anchorOffsetDays = daysBetween(
    request.currentCycleStartDate,
    request.requestedAnchorDate,
  );
  return addDays(request.nextCycleStartDate, anchorOffsetDays);
}

function buildApprovedPermanent(
  request: PermanentPolicyEvaluationRequest,
  cadence: SupportedScheduleCadence,
  policy: DueLogicPolicy,
  usage: PolicyUsage,
  currentPaymentAction: PermanentCurrentPaymentAction,
  resultingCurrentPaymentDate: string,
  firstRevisedPaymentDate: string,
  warnings: PolicyWarning[],
): ApprovedPermanentPolicyDecision {
  return {
    outcome: "approved",
    changeType: "permanent",
    reasonCode: "POLICY_APPROVED",
    ruleFired: "all-policy-rules-passed",
    explanation:
      "The payment remains within its assigned billing cycle. The revised schedule " +
      `begins on ${formatDayMonth(firstRevisedPaymentDate)} and continues at the same ` +
      `${cadence} position.`,
    evaluatedAt: request.evaluationDate,
    policyVersion: policy.version,
    usage,
    scheduleCadence: cadence,
    effectiveCycle: request.effectiveCycle,
    currentPaymentAction,
    originalCurrentPaymentDate: request.currentPaymentDate,
    resultingCurrentPaymentDate,
    firstRevisedPaymentDate,
    requestedAnchorDate: request.requestedAnchorDate,
    revisedSchedulePreview: buildSchedulePreview(firstRevisedPaymentDate, cadence),
    confirmationRequired: true,
    warningAcknowledgementRequired: warnings.length > 0,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Schedule rules

function evaluateTemporarySchedule(
  request: TemporaryPolicyEvaluationRequest,
  policy: DueLogicPolicy,
  usage: PolicyUsage,
): PolicyDecision {
  const maxShiftDays = policy.temporaryChange.maxShiftDays;
  const shiftDays = daysBetween(request.currentPaymentDate, request.requestedDate);

  if (shiftDays > maxShiftDays) {
    const alternativeDate = addDays(request.currentPaymentDate, maxShiftDays);
    return {
      outcome: "shorter-alternative",
      changeType: "temporary",
      reasonCode: "TEMPORARY_SHIFT_EXCEEDS_MAXIMUM",
      ruleFired: "temporaryChange.maxShiftDays",
      explanation:
        `The requested payment date is ${shiftDays} ${dayWord(shiftDays)} later than ` +
        `the current date. The merchant's automatic limit is ${maxShiftDays} ` +
        `${dayWord(maxShiftDays)}, so ${formatDayMonth(alternativeDate)} is the latest ` +
        "date available automatically.",
      evaluatedAt: request.evaluationDate,
      policyVersion: policy.version,
      requestedShiftDays: shiftDays,
      maximumShiftDays: maxShiftDays,
      alternativeDate,
      usage,
      confirmationRequired: true,
      warnings: [],
    };
  }

  return {
    outcome: "approved",
    changeType: "temporary",
    reasonCode: "POLICY_APPROVED",
    ruleFired: "all-policy-rules-passed",
    explanation:
      `The requested payment date is ${shiftDays} ${dayWord(shiftDays)} later than ` +
      `the current date, within the merchant's automatic limit of ${maxShiftDays} ` +
      `${dayWord(maxShiftDays)}.`,
    evaluatedAt: request.evaluationDate,
    policyVersion: policy.version,
    usage,
    currentPaymentDate: request.currentPaymentDate,
    approvedPaymentDate: request.requestedDate,
    shiftDays,
    confirmationRequired: false,
    warnings: [],
  };
}

function evaluatePermanentSchedule(
  request: PermanentPolicyEvaluationRequest,
  cadence: SupportedScheduleCadence,
  policy: DueLogicPolicy,
  usage: PolicyUsage,
): PolicyDecision {
  const anchor = request.requestedAnchorDate;

  if (request.effectiveCycle === "next-cycle-and-future") {
    if (anchor <= request.currentPaymentDate) {
      // Unreachable with validated contiguous cycles; kept explicit.
      invalid(
        "PERMANENT_TRANSITION_NOT_POSITIVE",
        "The next-cycle anchor must be strictly later than currentPaymentDate.",
      );
    }
    if (anchor === request.nextPaymentDate) {
      invalid(
        "PERMANENT_DATE_UNCHANGED",
        "Keeping the current payment and using the existing next payment date creates no schedule change.",
      );
    }
    const warning = buildCloseTogetherWarning(
      request.currentPaymentDate,
      anchor,
      "current",
      cadence,
      policy,
    );
    return buildApprovedPermanent(
      request,
      cadence,
      policy,
      usage,
      "keep",
      request.currentPaymentDate,
      anchor,
      warning === null ? [] : [warning],
    );
  }

  // current-and-future: the anchor is inside the current cycle (validated).
  // Availability, in order: strictly after evaluationDate, then strictly
  // later than previousPaymentDate. Either failure leads to one attempt at a
  // next-cycle alternative — never different results by which check failed.
  const anchorAvailable =
    anchor > request.evaluationDate && anchor > request.previousPaymentDate;

  if (!anchorAvailable) {
    const derived = deriveNextCycleAnchor(request, cadence);
    const derivedIsUsable =
      derived >= request.nextCycleStartDate &&
      derived <= request.nextCycleEndDate &&
      derived > request.currentPaymentDate;
    if (!derivedIsUsable) {
      invalid(
        "PERMANENT_TRANSITION_NOT_POSITIVE",
        "The requested current-cycle date is unavailable and no valid next-cycle alternative exists.",
      );
    }
    if (derived === request.nextPaymentDate) {
      invalid(
        "PERMANENT_DATE_UNCHANGED",
        "The derived next-cycle date equals the existing next payment date, so no schedule change results.",
      );
    }
    const warning = buildCloseTogetherWarning(
      request.currentPaymentDate,
      derived,
      "current",
      cadence,
      policy,
    );
    const warnings = warning === null ? [] : [warning];
    const cycleWording =
      cadence === "monthly"
        ? "The requested date is no longer available in the current payment month."
        : `The requested date is no longer available in the current ${cadence} billing cycle.`;
    return {
      outcome: "next-cycle-alternative",
      changeType: "permanent",
      reasonCode: "PERMANENT_CURRENT_CYCLE_DATE_UNAVAILABLE",
      ruleFired: "permanentChange.currentCycleAvailability",
      explanation:
        `${cycleWording} The payment scheduled for ` +
        `${formatDayMonth(request.currentPaymentDate)} can remain unchanged and the ` +
        `new anchor can begin inside the next assigned cycle, with the first revised ` +
        `payment on ${formatDayMonth(derived)}.`,
      evaluatedAt: request.evaluationDate,
      policyVersion: policy.version,
      scheduleCadence: cadence,
      suggestedEffectiveCycle: "next-cycle-and-future",
      currentPaymentAction: "keep",
      originalCurrentPaymentDate: request.currentPaymentDate,
      resultingCurrentPaymentDate: request.currentPaymentDate,
      firstRevisedPaymentDate: derived,
      requestedAnchorDate: anchor,
      derivedNextCycleAnchorDate: derived,
      revisedSchedulePreview: buildSchedulePreview(derived, cadence),
      usage,
      confirmationRequired: true,
      warningAcknowledgementRequired: warnings.length > 0,
      warnings,
    };
  }

  if (anchor === request.currentPaymentDate) {
    invalid(
      "PERMANENT_DATE_UNCHANGED",
      "The requested anchor equals the current payment date, so no schedule change results.",
    );
  }

  const warning = buildCloseTogetherWarning(
    request.previousPaymentDate,
    anchor,
    "previous",
    cadence,
    policy,
  );
  return buildApprovedPermanent(
    request,
    cadence,
    policy,
    usage,
    anchor < request.currentPaymentDate ? "move-earlier" : "move-later",
    anchor,
    anchor,
    warning === null ? [] : [warning],
  );
}

// ---------------------------------------------------------------------------
// Engine entry point

/**
 * Evaluates one schedule-change request against the supplied policy in the
 * fixed precedence order: policy validity, request validity, cycle metadata,
 * history validity, rolling usage, arrears, amount ceiling, usage limit,
 * cadence support, then schedule rules and warnings. Throws
 * PolicyValidationError for invalid input; every returned decision names the
 * exact rule that fired.
 */
export function evaluateScheduleChange(
  request: PolicyEvaluationRequest,
  history: readonly PriorScheduleChange[],
  policy: DueLogicPolicy = DEFAULT_DUELOGIC_POLICY,
): PolicyDecision {
  // 1. Policy.
  assertValidPolicy(policy);

  // 2-3. Common fields, then request-specific validation.
  if (request.changeType !== "temporary" && request.changeType !== "permanent") {
    invalid("INVALID_CHANGE_TYPE", "changeType must be temporary or permanent.");
  }
  assertCommonFields(request);
  if (request.changeType === "temporary") {
    assertTemporaryRequest(request);
  } else {
    // 4-5. Generic then cadence-specific cycle metadata.
    assertPermanentRequest(request, policy);
  }

  // 6. Prior history validity (never silently discarded).
  assertValidHistory(history);

  // 7. Rolling usage for the relevant, separate counter.
  const limits =
    request.changeType === "temporary" ? policy.temporaryChange : policy.permanentChange;
  const usage: PolicyUsage = {
    verifiedUsesInPeriod: countVerifiedUses(
      history,
      request.payerId,
      request.changeType,
      request.evaluationDate,
      limits.rollingPeriodMonths,
    ),
    permittedUses: limits.maxVerifiedUses,
  };

  // 8. Current arrears.
  if (request.currentArrearsCents > policy.arrears.disqualifyWhenCurrentArrearsCentsAbove) {
    return buildEscalation(
      request,
      policy,
      usage,
      "CURRENT_ARREARS_PRESENT",
      "arrears.disqualifyWhenCurrentArrearsCentsAbove",
      "This request requires manual review because the account currently has an outstanding amount.",
    );
  }

  // 9. Amount ceiling — always the active policy value, never a constant.
  if (request.amountCents > policy.amountCeilingCents) {
    return buildEscalation(
      request,
      policy,
      usage,
      "AMOUNT_CEILING_EXCEEDED",
      "amountCeilingCents",
      `This payment is above the merchant's automatic change limit of ` +
        `${formatCentsAsDollars(policy.amountCeilingCents)} and requires manual review.`,
    );
  }

  // 10. Relevant rolling usage limit.
  if (usage.verifiedUsesInPeriod >= usage.permittedUses) {
    if (request.changeType === "temporary") {
      return buildEscalation(
        request,
        policy,
        usage,
        "TEMPORARY_CHANGE_LIMIT_REACHED",
        "temporaryChange.maxVerifiedUses",
        `The automatic allowance of ${usage.permittedUses} temporary payment-date ` +
          `${changeWord(usage.permittedUses)} in a rolling ` +
          `${limits.rollingPeriodMonths}-month period has been reached. This request ` +
          "requires manual review.",
      );
    }
    return buildEscalation(
      request,
      policy,
      usage,
      "PERMANENT_CHANGE_LIMIT_REACHED",
      "permanentChange.maxVerifiedUses",
      `The automatic allowance of ${usage.permittedUses} permanent payment-date ` +
        `${changeWord(usage.permittedUses)} in a rolling ` +
        `${limits.rollingPeriodMonths}-month period has been reached. This request ` +
        "requires manual review.",
    );
  }

  // 11-14. Schedule rules, warnings and the final decision.
  if (request.changeType === "temporary") {
    return evaluateTemporarySchedule(request, policy, usage);
  }

  if (!policy.permanentChange.supportedCadences.includes(request.scheduleCadence)) {
    return buildEscalation(
      request,
      policy,
      usage,
      "PERMANENT_SCHEDULE_CADENCE_UNSUPPORTED",
      "permanentChange.supportedCadences",
      `Automatic permanent date changes are not enabled for this ` +
        `${request.scheduleCadence} schedule. The request requires merchant review.`,
    );
  }
  if (!isEngineCadence(request.scheduleCadence)) {
    // Unreachable: policy validation restricts supported cadences to the
    // engine cadences. Kept as a deterministic guard.
    invalid("INVALID_CADENCE", "scheduleCadence is not an engine-supported cadence.");
  }
  return evaluatePermanentSchedule(request, request.scheduleCadence, policy, usage);
}
