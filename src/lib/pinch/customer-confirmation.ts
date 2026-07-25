/**
 * Types and pure helpers for the customer schedule-confirmation record: the
 * server-held proof that the customer explicitly accepted the exact proposed
 * payment dates and amounts before a permanent subscription replacement may
 * execute. A merchant-controlled checkbox is not customer consent; this
 * record is.
 *
 * Pure data and functions only — no Pinch calls, no clock reads, no storage
 * and no token generation (the service injects those). The repository
 * interface at the bottom is deliberately small so durable storage can
 * replace the process-local sandbox store
 * (src/lib/pinch/dev-customer-confirmation-store.ts) without touching the
 * service or routes. Email and SMS delivery of confirmation links are
 * outside the current Build Weekend scope.
 */

/**
 * Stored event statuses. "expired" is never stored: expiry is derived
 * server-side from expiresAt on every read, so client time is never
 * authoritative and a stored status can never mask a lapsed record.
 */
export const CUSTOMER_CONFIRMATION_EVENT_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "consumed",
] as const;

export type CustomerConfirmationEventStatus =
  (typeof CUSTOMER_CONFIRMATION_EVENT_STATUSES)[number];

/** The externally understandable statuses, including derived expiry. */
export type CustomerConfirmationStatus =
  | CustomerConfirmationEventStatus
  | "expired";

/** One displayed/confirmed schedule payment: date and integer cents only. */
export interface ConfirmedSchedulePayment {
  /** YYYY-MM-DD in the merchant timezone. */
  readonly paymentDate: string;
  /** Positive integer cents. */
  readonly amountInCents: number;
}

/**
 * The server-held customer confirmation record. Binds the customer's
 * response to the exact merchant, payer, source, subscription, plan,
 * proposed start date and the exact payment dates and amounts shown. Stores
 * only the SHA-256 hash of the confirmation token — never the raw token —
 * and never card numbers, bank details, credentials or any inferred
 * financial circumstance.
 */
export interface CustomerScheduleConfirmationRecord {
  confirmationId: string;
  /** SHA-256 hash of the raw link token. The raw token is never stored. */
  tokenHash: string;
  merchantId: string;
  payerId: string;
  sourceId: string;
  subscriptionId: string;
  planId: string;
  /** YYYY-MM-DD. */
  currentStartDate: string;
  /** YYYY-MM-DD. */
  proposedStartDate: string;
  currentPayments: readonly ConfirmedSchedulePayment[];
  proposedPayments: readonly ConfirmedSchedulePayment[];
  /** AUD for the current demonstration. */
  currency: "AUD";
  status: CustomerConfirmationEventStatus;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp; evaluated server-side on every read. */
  expiresAt: string;
  acceptedAt: string | null;
  declinedAt: string | null;
  consumedAt: string | null;
  /** Set when the confirmation is consumed by a replacement operation. */
  operationId: string | null;
}

/**
 * Storage boundary. The development implementation is process-local sandbox
 * memory (records are lost on a development-server restart; no database has
 * been added); a durable implementation replaces this interface's backing,
 * not the service or route contracts.
 */
export interface CustomerConfirmationRepository {
  write(record: CustomerScheduleConfirmationRecord): Promise<void>;
  readById(
    confirmationId: string,
  ): Promise<CustomerScheduleConfirmationRecord | null>;
  readByTokenHash(
    tokenHash: string,
  ): Promise<CustomerScheduleConfirmationRecord | null>;
}

/**
 * Development configuration: how long a customer confirmation link stays
 * usable. Clearly a demonstration value, not a production policy decision.
 */
export const DEV_CUSTOMER_CONFIRMATION_LIFETIME_MINUTES = 30;

/**
 * Key names that must never appear in a stored confirmation record:
 * credentials, tokens and card/bank material. Mirrors the
 * replacement-operation store guard, with one deliberate exception — the
 * exact key `tokenHash` is the schema's own hashed-token field and is
 * allowed; any other token-like key (including a raw token) is refused.
 */
const FORBIDDEN_CONFIRMATION_KEY_PATTERN =
  /token|secret|credential|password|apikey|api_key|card|cvv|cvc|expiry|bank|bsb|account|routing|iban|email|phone|address|payday|income|employment|affordability/i;

/**
 * Depth-first search for a forbidden key anywhere in the value. Returns the
 * first offending key name, or null when the value is safe to store.
 */
export function findForbiddenConfirmationRecordKey(
  value: unknown,
): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findForbiddenConfirmationRecordKey(entry);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      if (key !== "tokenHash" && FORBIDDEN_CONFIRMATION_KEY_PATTERN.test(key)) {
        return key;
      }
      const found = findForbiddenConfirmationRecordKey(nested);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/**
 * The externally reported status: consumed and declined are terminal and
 * survive expiry (they are historical facts); otherwise a record past its
 * expiresAt is expired regardless of its stored status. Expiry is always
 * evaluated here, server-side, against the supplied clock value — client
 * time is never authoritative. An unparseable expiry refuses use by
 * reporting expired.
 */
export function effectiveConfirmationStatus(
  record: CustomerScheduleConfirmationRecord,
  nowIso: string,
): CustomerConfirmationStatus {
  if (record.status === "consumed" || record.consumedAt !== null) {
    return "consumed";
  }
  if (record.status === "declined" || record.declinedAt !== null) {
    return "declined";
  }
  const now = Date.parse(nowIso);
  const expires = Date.parse(record.expiresAt);
  if (Number.isNaN(now) || Number.isNaN(expires) || now >= expires) {
    return "expired";
  }
  return record.status === "accepted" || record.acceptedAt !== null
    ? "accepted"
    : "pending";
}

/** Exact same length, dates and integer amounts in the same order. */
export function confirmedPaymentsEqual(
  a: readonly ConfirmedSchedulePayment[],
  b: readonly ConfirmedSchedulePayment[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (payment, index) =>
        payment.paymentDate === b[index].paymentDate &&
        payment.amountInCents === b[index].amountInCents,
    )
  );
}

/**
 * The merchant-facing status projection: never the token hash, never the
 * raw token, never source credentials and never any Pinch response body.
 */
export interface MerchantConfirmationProjection {
  confirmationId: string;
  status: CustomerConfirmationStatus;
  currentStartDate: string;
  proposedStartDate: string;
  proposedPayments: ConfirmedSchedulePayment[];
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  declinedAt: string | null;
  consumedAt: string | null;
  operationId: string | null;
}

export function toMerchantConfirmationProjection(
  record: CustomerScheduleConfirmationRecord,
  nowIso: string,
): MerchantConfirmationProjection {
  return {
    confirmationId: record.confirmationId,
    status: effectiveConfirmationStatus(record, nowIso),
    currentStartDate: record.currentStartDate,
    proposedStartDate: record.proposedStartDate,
    proposedPayments: record.proposedPayments.map((payment) => ({ ...payment })),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    acceptedAt: record.acceptedAt,
    declinedAt: record.declinedAt,
    consumedAt: record.consumedAt,
    operationId: record.operationId,
  };
}

/**
 * The customer-facing projection: schedule content and lifecycle only. No
 * merchant ID, payer ID, source ID, subscription ID, plan ID, operation ID,
 * internal reason codes or token material of any kind.
 */
export interface CustomerConfirmationProjection {
  status: CustomerConfirmationStatus;
  currentStartDate: string;
  proposedStartDate: string;
  currentPayments: ConfirmedSchedulePayment[];
  proposedPayments: ConfirmedSchedulePayment[];
  currency: "AUD";
  expiresAt: string;
}

export function toCustomerConfirmationProjection(
  record: CustomerScheduleConfirmationRecord,
  nowIso: string,
): CustomerConfirmationProjection {
  return {
    status: effectiveConfirmationStatus(record, nowIso),
    currentStartDate: record.currentStartDate,
    proposedStartDate: record.proposedStartDate,
    currentPayments: record.currentPayments.map((payment) => ({ ...payment })),
    proposedPayments: record.proposedPayments.map((payment) => ({ ...payment })),
    currency: record.currency,
    expiresAt: record.expiresAt,
  };
}
