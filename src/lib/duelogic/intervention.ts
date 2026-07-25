/**
 * Types and pure helpers for the Stage 1 customer-led intervention record:
 * the server-held state of one automatically generated schedule-review
 * invitation, from the scheduled scan through customer date selection,
 * deterministic policy evaluation and the exact read-only Pinch schedule
 * preview. Stage 1 stops at preview-ready; confirmationId, operationId and
 * newSubscriptionId exist now so Stage 2 can fill them without redesigning
 * the record, and remain null throughout Stage 1.
 *
 * Pure data and functions only — no Pinch calls, no clock reads, no storage
 * and no token generation (the service injects those). The repository
 * interfaces at the bottom mirror the customer-confirmation pattern so
 * durable storage can replace the process-local sandbox store
 * (src/lib/duelogic/dev-intervention-store.ts) without touching the service
 * or routes.
 */

import type { PolicyWarning } from "./policy/engine";
import type { SupportedScheduleCadence } from "./schema";
import type { ConfirmedSchedulePayment } from "@/lib/pinch/customer-confirmation";

/**
 * Stored event statuses. "expired" is never stored: expiry is derived
 * server-side from expiresAt on every read, so client time is never
 * authoritative and a stored status can never mask a lapsed invitation.
 */
export const INTERVENTION_EVENT_STATUSES = [
  "invitation-created",
  "opened",
  "awaiting-date-selection",
  "date-approved",
  "alternative-offered",
  "escalated",
  "preview-ready",
  "declined",
] as const;

export type InterventionEventStatus =
  (typeof INTERVENTION_EVENT_STATUSES)[number];

/** The externally understandable statuses, including derived expiry. */
export type InterventionStatus = InterventionEventStatus | "expired";

/**
 * The server-held intervention record. Binds the invitation to the exact
 * merchant, payer, source, subscription, plan, pattern flag and trusted
 * cycle context resolved by the scheduled scan. Stores only the SHA-256
 * hash of the customer link token — never the raw token — and never
 * credentials, access tokens, raw payment details, payment-source secrets
 * or any financial-circumstance inference.
 */
export interface DueLogicInterventionRecord {
  interventionId: string;
  notificationId: string;
  /** SHA-256 hash of the raw link token. The raw token is never stored here. */
  tokenHash: string;
  merchantId: string;
  payerId: string;
  sourceId: string;
  subscriptionId: string;
  planId: string;
  /** The detector flag that qualified this opportunity. */
  patternFlagId: string;
  policyVersion: string;
  scheduleCadence: SupportedScheduleCadence;
  /** Stage 1 issues permanent-change invitations only. */
  changeMode: "permanent";
  /** YYYY-MM-DD: the live subscription's verified current start date. */
  currentStartDate: string;
  /** Integer cents for one recurring payment. */
  currentPaymentAmountInCents: number;
  /** YYYY-MM-DD: trusted cycle bounds from the merchant-held plan mapping. */
  currentCycleStartDate: string;
  currentCycleEndDate: string;
  /** YYYY-MM-DD: detector-derived suggestion inside the permitted window. */
  suggestedDate: string;
  /** YYYY-MM-DD; null until the customer checks a date. */
  selectedDate: string | null;
  /**
   * YYYY-MM-DD; set when the policy engine offers a next-cycle alternative.
   * Only this exact date is accepted outside the current-cycle window.
   */
  offeredAlternativeDate: string | null;
  /** Null until a deterministic policy decision has been recorded. */
  policyOutcome: "approved" | "next-cycle-alternative" | "escalate" | null;
  policyReasonCode: string | null;
  policyRuleFired: string | null;
  policyExplanation: string | null;
  policyWarnings: readonly PolicyWarning[];
  /** Exact Pinch-returned schedules; null until preview-ready. */
  currentPayments: readonly ConfirmedSchedulePayment[] | null;
  proposedPayments: readonly ConfirmedSchedulePayment[] | null;
  /** AUD for the current demonstration. */
  currency: "AUD";
  /** Stage 2 seam — all three remain null throughout Stage 1. */
  confirmationId: string | null;
  operationId: string | null;
  newSubscriptionId: string | null;
  status: InterventionEventStatus;
  /** ISO timestamps. */
  createdAt: string;
  /** Evaluated server-side on every read. */
  expiresAt: string;
  openedAt: string | null;
  selectedAt: string | null;
  declinedAt: string | null;
  updatedAt: string;
}

/**
 * The customer notification delivery artefact for the in-app inbox — the
 * prototype's delivery channel (real email/SMS delivery is out of scope).
 * `reviewPath` is the only place the raw link token may exist after
 * creation; the notification is customer-facing only and must never be
 * returned through merchant monitoring.
 */
export interface InterventionCustomerNotification {
  notificationId: string;
  interventionId: string;
  title: "Payment schedule review";
  /** Integer cents, for customer display only. */
  amountInCents: number;
  /** YYYY-MM-DD. */
  currentScheduledDate: string;
  /** ISO timestamp. */
  expiresAt: string;
  createdAt: string;
  /** Relative customer link, e.g. "/review/<raw token>". */
  reviewPath: string;
}

/**
 * Key names that must never appear in a stored intervention record:
 * credentials, tokens, card/bank material, customer identity and
 * financial-circumstance vocabulary. Mirrors the customer-confirmation
 * store guard; the exact key `tokenHash` is the schema's own hashed-token
 * field and is allowed.
 */
const FORBIDDEN_INTERVENTION_KEY_PATTERN =
  /token|secret|credential|password|apikey|api_key|card|cvv|cvc|expiry|bank|bsb|account|routing|iban|email|phone|address|payday|income|employment|affordability|hardship/i;

/**
 * Depth-first search for a forbidden key anywhere in the value. Returns the
 * first offending key name, or null when the value is safe to store.
 */
export function findForbiddenInterventionRecordKey(
  value: unknown,
): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findForbiddenInterventionRecordKey(entry);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      if (key !== "tokenHash" && FORBIDDEN_INTERVENTION_KEY_PATTERN.test(key)) {
        return key;
      }
      const found = findForbiddenInterventionRecordKey(nested);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/**
 * The externally reported status: declined and escalated are terminal
 * historical facts and survive expiry; otherwise a record past its
 * expiresAt is expired regardless of its stored status. Expiry is always
 * evaluated here, server-side, against the supplied clock value — client
 * time is never authoritative. An unparseable expiry refuses use by
 * reporting expired.
 */
export function effectiveInterventionStatus(
  record: DueLogicInterventionRecord,
  nowIso: string,
): InterventionStatus {
  if (record.status === "declined" || record.declinedAt !== null) {
    return "declined";
  }
  if (record.status === "escalated") {
    return "escalated";
  }
  const now = Date.parse(nowIso);
  const expires = Date.parse(record.expiresAt);
  if (Number.isNaN(now) || Number.isNaN(expires) || now >= expires) {
    return "expired";
  }
  return record.status;
}

/**
 * The customer-facing projection: schedule content, permitted window and
 * lifecycle only. No merchant ID, payer ID, source ID, subscription ID,
 * plan ID, pattern flag ID, policy reason codes, rule names, token material
 * or internal JSON of any kind. Policy explanations are the engine's own
 * customer-safe wording.
 */
export interface CustomerInterventionProjection {
  status: InterventionStatus;
  amountInCents: number;
  /** YYYY-MM-DD. */
  currentScheduledDate: string;
  scheduleCadence: SupportedScheduleCadence;
  /** The permitted date-selection window (the assigned billing cycle). */
  windowStartDate: string;
  windowEndDate: string;
  suggestedDate: string;
  selectedDate: string | null;
  offeredAlternativeDate: string | null;
  policyOutcome: "approved" | "next-cycle-alternative" | "escalate" | null;
  /** Customer-safe engine wording only — never reason codes or rule names. */
  policyExplanation: string | null;
  warningExplanations: readonly string[];
  currentPayments: readonly ConfirmedSchedulePayment[] | null;
  proposedPayments: readonly ConfirmedSchedulePayment[] | null;
  currency: "AUD";
  expiresAt: string;
  /** Always false in Stage 1: the final confirmation control stays disabled. */
  finalConfirmationEnabled: false;
}

export function toCustomerInterventionProjection(
  record: DueLogicInterventionRecord,
  nowIso: string,
): CustomerInterventionProjection {
  return {
    status: effectiveInterventionStatus(record, nowIso),
    amountInCents: record.currentPaymentAmountInCents,
    currentScheduledDate: record.currentStartDate,
    scheduleCadence: record.scheduleCadence,
    windowStartDate: record.currentCycleStartDate,
    windowEndDate: record.currentCycleEndDate,
    suggestedDate: record.suggestedDate,
    selectedDate: record.selectedDate,
    offeredAlternativeDate: record.offeredAlternativeDate,
    policyOutcome: record.policyOutcome,
    policyExplanation: record.policyExplanation,
    warningExplanations: record.policyWarnings.map(
      (warning) => warning.explanation,
    ),
    currentPayments:
      record.currentPayments === null
        ? null
        : record.currentPayments.map((payment) => ({ ...payment })),
    proposedPayments:
      record.proposedPayments === null
        ? null
        : record.proposedPayments.map((payment) => ({ ...payment })),
    currency: record.currency,
    expiresAt: record.expiresAt,
    finalConfirmationEnabled: false,
  };
}

/**
 * The merchant-facing monitoring projection: lifecycle and decision
 * metadata only. Never the token hash, the raw token, the notification
 * delivery artefact or any Pinch response body.
 */
export interface MerchantInterventionProjection {
  interventionId: string;
  subscriptionId: string;
  planId: string;
  status: InterventionStatus;
  suggestedDate: string;
  selectedDate: string | null;
  policyOutcome: "approved" | "next-cycle-alternative" | "escalate" | null;
  policyReasonCode: string | null;
  createdAt: string;
  expiresAt: string;
  openedAt: string | null;
  selectedAt: string | null;
  declinedAt: string | null;
  confirmationId: string | null;
  operationId: string | null;
  newSubscriptionId: string | null;
}

export function toMerchantInterventionProjection(
  record: DueLogicInterventionRecord,
  nowIso: string,
): MerchantInterventionProjection {
  return {
    interventionId: record.interventionId,
    subscriptionId: record.subscriptionId,
    planId: record.planId,
    status: effectiveInterventionStatus(record, nowIso),
    suggestedDate: record.suggestedDate,
    selectedDate: record.selectedDate,
    policyOutcome: record.policyOutcome,
    policyReasonCode: record.policyReasonCode,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    openedAt: record.openedAt,
    selectedAt: record.selectedAt,
    declinedAt: record.declinedAt,
    confirmationId: record.confirmationId,
    operationId: record.operationId,
    newSubscriptionId: record.newSubscriptionId,
  };
}

/** Monitoring counts for the merchant dashboard section. */
export interface InterventionMonitoringSummary {
  invitationsGenerated: number;
  pendingDateSelection: number;
  previewReady: number;
  declined: number;
  escalated: number;
  expired: number;
}

export function summariseInterventions(
  records: readonly DueLogicInterventionRecord[],
  nowIso: string,
): InterventionMonitoringSummary {
  const summary: InterventionMonitoringSummary = {
    invitationsGenerated: records.length,
    pendingDateSelection: 0,
    previewReady: 0,
    declined: 0,
    escalated: 0,
    expired: 0,
  };
  for (const record of records) {
    const status = effectiveInterventionStatus(record, nowIso);
    if (status === "preview-ready") {
      summary.previewReady += 1;
    } else if (status === "declined") {
      summary.declined += 1;
    } else if (status === "escalated") {
      summary.escalated += 1;
    } else if (status === "expired") {
      summary.expired += 1;
    } else {
      // invitation-created, opened, awaiting-date-selection,
      // alternative-offered and date-approved all still await a usable
      // customer date selection.
      summary.pendingDateSelection += 1;
    }
  }
  return summary;
}

/**
 * Storage boundary. The development implementation is process-local sandbox
 * memory (records are lost on a development-server restart; no database has
 * been added); a durable implementation replaces this interface's backing,
 * not the service or route contracts.
 */
export interface DueLogicInterventionRepository {
  write(record: DueLogicInterventionRecord): Promise<void>;
  readById(interventionId: string): Promise<DueLogicInterventionRecord | null>;
  readByTokenHash(
    tokenHash: string,
  ): Promise<DueLogicInterventionRecord | null>;
  /** Insertion-ordered listing for duplicate prevention and monitoring. */
  list(): Promise<DueLogicInterventionRecord[]>;
}

/** Storage boundary for the customer notification delivery artefacts. */
export interface InterventionNotificationRepository {
  write(notification: InterventionCustomerNotification): Promise<void>;
  list(): Promise<InterventionCustomerNotification[]>;
}

/**
 * Development configuration: how long a customer invitation stays usable.
 * Clearly a demonstration value, not a production policy decision.
 */
export const DEV_INTERVENTION_INVITATION_LIFETIME_MINUTES = 7 * 24 * 60;
