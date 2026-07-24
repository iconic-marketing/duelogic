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
