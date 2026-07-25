/**
 * DueLogic domain schema.
 *
 * Plain typed records only — no persistence, API, or analysis logic lives
 * here. All monetary values are integer cents; dollar conversion happens only
 * at the display boundary. Date-only fields are `YYYY-MM-DD` strings and
 * timestamp fields are ISO 8601 strings.
 */

export type PaymentOutcome = "approved" | "dishonoured";

export type DishonourReason =
  | "insufficient-funds"
  | "invalid-account"
  | "declined"
  | "technical-error";

export type PaymentSourceType = "card" | "bank-account";

/** The two proven Pinch payment lifecycle event types. */
export type PaymentOutcomeEventType = "scheduled-process" | "bank-results";

export interface Merchant {
  id: string;
  name: string;
  /** Pinch merchant ID, e.g. the managed merchant sent as `Current-Merchant`. */
  pinchMerchantId: string;
  /** IANA timezone name, e.g. "Australia/Sydney". */
  timezone: string;
}

export interface Payer {
  id: string;
  merchantId: string;
  pinchPayerId: string;
  displayName: string;
}

export interface PaymentRecord {
  id: string;
  merchantId: string;
  payerId: string;
  /** Absent for records that never existed in Pinch (e.g. synthetic history). */
  pinchPaymentId?: string;
  /** Integer cents. */
  amountCents: number;
  /** YYYY-MM-DD. */
  scheduledDate: string;
  /** YYYY-MM-DD; may trail scheduledDate (e.g. weekend bank settlement). */
  processedDate: string;
  outcome: PaymentOutcome;
  /** Null when the payment was approved. */
  dishonourReason: DishonourReason | null;
  /** YYYY-MM-DD; must be after processedDate. Present only when a retry occurred. */
  retryDate?: string;
  /** Null when no retry occurred. */
  retryOutcome: PaymentOutcome | null;
  sourceType: PaymentSourceType;
  /** True for seeded history that never touched Pinch. */
  synthetic: boolean;
}

export interface PaymentOutcomeEvent {
  id: string;
  paymentId: string;
  pinchEventId?: string;
  type: PaymentOutcomeEventType;
  /** ISO 8601 timestamp. */
  eventDate: string;
  /** Null when the event does not carry a final outcome (e.g. scheduled-process). */
  outcome: PaymentOutcome | null;
}

/** Clustering basis for a detected timing-linked payment pattern. */
export type PatternBasis = "day-of-month" | "day-of-week";

export type Weekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

/**
 * One clustered insufficient-funds dishonour that later settled through an
 * approved retry outside the cluster. Observed history only — never a claim
 * about what a different schedule would have prevented.
 */
export interface TimingPatternSettlementEvidence {
  paymentRecordId: string;
  /** YYYY-MM-DD. */
  scheduledDate: string;
  /** YYYY-MM-DD. */
  processedDate: string;
  /** YYYY-MM-DD; strictly after processedDate. */
  retryDate: string;
  /** Positive whole calendar days from processedDate to retryDate. */
  delayDays: number;
}

/**
 * Why a payer was flagged: the clustered dishonours and their approved
 * later-settlement evidence. Strictly typed — no free-form JSON. Identifies a
 * payment-timing pattern only; it never encodes payday, employment,
 * affordability, income, hardship or any other financial cause.
 */
export interface TimingPatternEvidence {
  basis: PatternBasis;
  /**
   * First day of the full inclusive detection window that selected the
   * cluster; present only for the day-of-month basis.
   */
  windowStartDay?: number;
  /**
   * Last day of that inclusive detection window; settlement evidence must
   * fall outside [windowStartDay, windowEndDay]. Day-of-month basis only.
   */
  windowEndDay?: number;
  /** Present only for the day-of-week basis. */
  weekday?: Weekday;
  qualifyingDishonourCount: number;
  qualifyingPaymentRecordIds: string[];
  /** YYYY-MM-DD, ascending. */
  qualifyingScheduledDates: string[];
  settlementEvidence: TimingPatternSettlementEvidence[];
}

export interface PatternFlag {
  id: string;
  merchantId: string;
  payerId: string;
  patternType: "timing-linked";
  /**
   * Lower-median of the observed approved-retry delays, minimum 1. A shift
   * worth testing — not a claim that any dishonour would have been prevented.
   */
  proposedShiftDays: number;
  /** YYYY-MM-DD anchor the detection ran against. */
  detectedAsOfDate: string;
  evidence: TimingPatternEvidence;
}

/**
 * Schedule cadence supplied by trusted merchant, plan or schedule metadata.
 * Never inferred from payment-date spacing, descriptions, dishonours, retry
 * dates or detector output. "four-weekly" and "custom" are known but not
 * supported by the default policy; an unknown string is invalid input.
 */
export type ScheduleCadence =
  | "weekly"
  | "fortnightly"
  | "monthly"
  | "four-weekly"
  | "custom";

/** The cadences the policy engine can evaluate permanent changes for. */
export type SupportedScheduleCadence = "weekly" | "fortnightly" | "monthly";

/**
 * Which assigned billing cycle a permanent change anchors in: move the
 * current payment within its own cycle, or keep it and anchor inside the
 * next payment's cycle.
 */
export type PermanentEffectiveCycle =
  | "current-and-future"
  | "next-cycle-and-future";

export type PriorScheduleChangeStatus =
  | "executed-verified"
  | "refused"
  | "abandoned"
  | "execution-failed"
  | "manual-recovery";

/**
 * One prior schedule-change record. Only "executed-verified" entries consume
 * rolling usage allowances; that status requires executedDate.
 */
export interface PriorScheduleChange {
  id: string;
  payerId: string;
  changeType: "temporary" | "permanent";
  status: PriorScheduleChangeStatus;
  /** YYYY-MM-DD; required when status is "executed-verified". */
  executedDate?: string;
}

/**
 * Declarative, versioned DueLogic policy. Values only — every threshold the
 * engine evaluates lives here, so a merchant-specific policy can override any
 * value (including amountCeilingCents) without changing engine code.
 */
export interface DueLogicPolicy {
  readonly version: string;
  /** Ceiling for one scheduled payment, integer cents. */
  readonly amountCeilingCents: number;
  readonly temporaryChange: {
    readonly maxVerifiedUses: number;
    readonly rollingPeriodMonths: number;
    readonly maxShiftDays: number;
  };
  readonly permanentChange: {
    readonly maxVerifiedUses: number;
    readonly rollingPeriodMonths: number;
    readonly supportedCadences: readonly ScheduleCadence[];
    readonly keepPaymentWithinAssignedCycle: boolean;
    readonly cycleLengthDays: {
      readonly weekly: number;
      readonly fortnightly: number;
    };
    readonly monthlyAnchorDay: {
      readonly minimum: number;
      readonly maximum: number;
    };
    readonly allowSameDayCurrentCycleChange: boolean;
    readonly closePaymentWarningDays: {
      readonly weekly?: number;
      readonly fortnightly?: number;
      readonly monthly?: number;
    };
    readonly closePaymentAction: "warn-and-confirm";
    readonly unsupportedCadenceAction: "escalate";
    readonly overLimitAction: "escalate";
  };
  readonly arrears: {
    readonly disqualifyWhenCurrentArrearsCentsAbove: number;
    readonly action: "escalate";
  };
}

/**
 * Merchant-held plan-to-schedule configuration. Pinch Plan and Subscription
 * responses used by DueLogic do not currently provide a trusted cadence
 * field, so cadence and billing-cycle convention come from this explicit
 * per-plan mapping — never from payment spacing or calculated-payment dates.
 * Plan mappings are merchant configuration and stay separate from
 * DEFAULT_DUELOGIC_POLICY, which is reusable across merchants.
 */
export interface WeeklyPlanScheduleDefinition {
  cadence: "weekly";
  cycleDefinition: "fixed-days";
  cycleLengthDays: 7;
  /**
   * YYYY-MM-DD first day of one authoritative 7-day cycle. Need not be the
   * first payment date and need not be a Monday.
   */
  cycleAnchorDate: string;
}

export interface FortnightlyPlanScheduleDefinition {
  cadence: "fortnightly";
  cycleDefinition: "fixed-days";
  cycleLengthDays: 14;
  /** YYYY-MM-DD first day of one authoritative 14-day cycle. */
  cycleAnchorDate: string;
}

/** Monthly plans use full calendar months and require no anchor date. */
export interface MonthlyPlanScheduleDefinition {
  cadence: "monthly";
  cycleDefinition: "calendar-month";
}

export type PlanScheduleDefinition =
  | WeeklyPlanScheduleDefinition
  | FortnightlyPlanScheduleDefinition
  | MonthlyPlanScheduleDefinition;

export interface MerchantPlanScheduleConfiguration {
  /** The internal or Pinch merchant reference used by the caller. */
  merchantId: string;
  /** Keyed by the exact merchant-scoped plan ID. */
  plans: Readonly<Record<string, PlanScheduleDefinition>>;
}

/**
 * Deterministic record of a payment-date change decision. Eligibility and
 * execution are decided by code against a versioned policy — never by model
 * output — so every decision carries its code and policy version.
 */
export interface ScheduleChangeDecision {
  id: string;
  paymentId: string;
  /** YYYY-MM-DD. */
  requestedDate: string;
  /** YYYY-MM-DD; present only when a change was approved. */
  approvedDate?: string;
  eligible: boolean;
  decisionCode: string;
  policyVersion: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
}
