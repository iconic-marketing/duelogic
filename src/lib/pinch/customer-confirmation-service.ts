/**
 * Customer schedule-confirmation service: creation, customer response,
 * replacement-side verification and single-use consumption.
 *
 * Every function takes injected dependencies (repository, clock, token
 * generator, token hasher), so the deterministic validation suite drives
 * these exact code paths with fakes and no network access. The dev routes
 * supply the real implementations exported at the bottom. Nothing here
 * calls Pinch: the confirmation record proves customer consent — it never
 * replaces the replacement route's own fresh Pinch preflight, which remains
 * authoritative for schedule content.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { parseCalendarDate } from "@/lib/duelogic/calendar-date";
import {
  confirmedPaymentsEqual,
  effectiveConfirmationStatus,
  findForbiddenConfirmationRecordKey,
  type ConfirmedSchedulePayment,
  type CustomerConfirmationRepository,
  type CustomerScheduleConfirmationRecord,
} from "./customer-confirmation";

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts: the
// `server-only` package is not installed in this project, so fail at import
// time if this module ever reaches browser code.
if (typeof window !== "undefined") {
  throw new Error(
    "The customer-confirmation service is server-only and must not be imported into browser code.",
  );
}

export interface CustomerConfirmationServiceDeps {
  repository: CustomerConfirmationRepository;
  /** Returns the current ISO timestamp. Injected — never a hidden clock. */
  now(): string;
  generateConfirmationId(): string;
  /** Returns a raw, unguessable link token. Never stored or logged. */
  generateToken(): string;
  /** One-way hash of the raw token; only the hash is stored. */
  hashToken(rawToken: string): string;
  lifetimeMinutes: number;
}

export interface CreateCustomerConfirmationInput {
  merchantId: string;
  payerId: string;
  sourceId: string;
  subscriptionId: string;
  planId: string;
  currentStartDate: string;
  proposedStartDate: string;
  currentPayments: readonly ConfirmedSchedulePayment[];
  proposedPayments: readonly ConfirmedSchedulePayment[];
  currency: string;
}

export type CreateCustomerConfirmationOutcome =
  | {
      ok: true;
      record: CustomerScheduleConfirmationRecord;
      /**
       * The raw link token, returned exactly once here so the creation
       * response can build the customer URL. It is never stored, never
       * logged and never available from any later lookup.
       */
      rawToken: string;
    }
  | { ok: false; reason: "validation" | "store"; detail: string };

function isNonBlankId(value: string): boolean {
  return typeof value === "string" && value.trim() !== "" && value.length <= 100;
}

function isCalendarDate(value: string): boolean {
  return typeof value === "string" && parseCalendarDate(value) !== null;
}

function validPayments(
  payments: readonly ConfirmedSchedulePayment[],
): boolean {
  return (
    Array.isArray(payments) &&
    payments.length === 3 &&
    payments.every(
      (payment) =>
        isCalendarDate(payment.paymentDate) &&
        typeof payment.amountInCents === "number" &&
        Number.isInteger(payment.amountInCents) &&
        payment.amountInCents > 0,
    )
  );
}

function validateCreateInput(
  input: CreateCustomerConfirmationInput,
): string | null {
  const ids: Array<[string, string]> = [
    ["merchantId", input.merchantId],
    ["payerId", input.payerId],
    ["sourceId", input.sourceId],
    ["subscriptionId", input.subscriptionId],
    ["planId", input.planId],
  ];
  for (const [field, value] of ids) {
    if (!isNonBlankId(value)) {
      return `${field} must be a non-blank identifier.`;
    }
  }
  if (!isCalendarDate(input.currentStartDate)) {
    return "currentStartDate must be a valid YYYY-MM-DD calendar date.";
  }
  if (!isCalendarDate(input.proposedStartDate)) {
    return "proposedStartDate must be a valid YYYY-MM-DD calendar date.";
  }
  if (!validPayments(input.currentPayments)) {
    return "currentPayments must be exactly three payments with valid dates and positive integer cents.";
  }
  if (!validPayments(input.proposedPayments)) {
    return "proposedPayments must be exactly three payments with valid dates and positive integer cents.";
  }
  if (confirmedPaymentsEqual(input.currentPayments, input.proposedPayments)) {
    return "proposedPayments must differ from currentPayments.";
  }
  if (input.currency !== "AUD") {
    return "currency must be AUD for the current demonstration.";
  }
  return null;
}

/**
 * Creates a pending confirmation record bound to the exact IDs, dates and
 * amounts supplied from the already-validated live Pinch preview. Stores
 * only the token hash, verifies the write by read-back and returns the raw
 * token exactly once.
 */
export async function createCustomerConfirmation(
  input: CreateCustomerConfirmationInput,
  deps: CustomerConfirmationServiceDeps,
): Promise<CreateCustomerConfirmationOutcome> {
  const validationError = validateCreateInput(input);
  if (validationError !== null) {
    return { ok: false, reason: "validation", detail: validationError };
  }

  const rawToken = deps.generateToken();
  const createdAt = deps.now();
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) {
    return { ok: false, reason: "store", detail: "clock produced an unreadable timestamp." };
  }
  const record: CustomerScheduleConfirmationRecord = {
    confirmationId: deps.generateConfirmationId(),
    tokenHash: deps.hashToken(rawToken),
    merchantId: input.merchantId,
    payerId: input.payerId,
    sourceId: input.sourceId,
    subscriptionId: input.subscriptionId,
    planId: input.planId,
    currentStartDate: input.currentStartDate,
    proposedStartDate: input.proposedStartDate,
    currentPayments: input.currentPayments.map((payment) => ({ ...payment })),
    proposedPayments: input.proposedPayments.map((payment) => ({ ...payment })),
    currency: "AUD",
    status: "pending",
    createdAt,
    expiresAt: new Date(
      createdMs + deps.lifetimeMinutes * 60_000,
    ).toISOString(),
    acceptedAt: null,
    declinedAt: null,
    consumedAt: null,
    operationId: null,
  };
  if (findForbiddenConfirmationRecordKey(record) !== null) {
    return {
      ok: false,
      reason: "validation",
      detail: "record carried forbidden sensitive material.",
    };
  }

  try {
    await deps.repository.write(record);
    const readBack = await deps.repository.readById(record.confirmationId);
    if (
      readBack === null ||
      JSON.stringify(readBack) !== JSON.stringify(record)
    ) {
      return {
        ok: false,
        reason: "store",
        detail: "confirmation record could not be read back after writing.",
      };
    }
  } catch {
    return {
      ok: false,
      reason: "store",
      detail: "confirmation record could not be written.",
    };
  }

  return { ok: true, record, rawToken };
}

export type CustomerConfirmationResponse = "accept" | "decline";

export type RespondToCustomerConfirmationOutcome =
  | {
      ok: true;
      /** False when an identical repeat response changed nothing. */
      changed: boolean;
      record: CustomerScheduleConfirmationRecord;
    }
  | {
      ok: false;
      reason: "not-found" | "contradictory" | "expired" | "consumed" | "store";
      record?: CustomerScheduleConfirmationRecord;
    };

/**
 * Applies a customer's accept or decline. The token is hashed and looked up
 * — a confirmationId supplied by a customer is never trusted. Transitions:
 * pending → accepted or declined; a repeat of the same response is
 * idempotent; a contradictory repeat is rejected; expired records accept no
 * response; consumed records cannot be reused. Expiry is evaluated here,
 * server-side, against the injected clock.
 */
export async function respondToCustomerConfirmation(
  input: { token: string; response: CustomerConfirmationResponse },
  deps: Pick<CustomerConfirmationServiceDeps, "repository" | "now" | "hashToken">,
): Promise<RespondToCustomerConfirmationOutcome> {
  const record = await deps.repository.readByTokenHash(
    deps.hashToken(input.token.trim()),
  );
  if (record === null) {
    return { ok: false, reason: "not-found" };
  }

  const nowIso = deps.now();
  const status = effectiveConfirmationStatus(record, nowIso);
  if (status === "consumed") {
    return { ok: false, reason: "consumed", record };
  }
  if (status === "expired") {
    return { ok: false, reason: "expired", record };
  }
  if (status === "accepted") {
    return input.response === "accept"
      ? { ok: true, changed: false, record }
      : { ok: false, reason: "contradictory", record };
  }
  if (status === "declined") {
    return input.response === "decline"
      ? { ok: true, changed: false, record }
      : { ok: false, reason: "contradictory", record };
  }

  const updated: CustomerScheduleConfirmationRecord =
    input.response === "accept"
      ? { ...record, status: "accepted", acceptedAt: nowIso }
      : { ...record, status: "declined", declinedAt: nowIso };
  try {
    await deps.repository.write(updated);
    const readBack = await deps.repository.readById(updated.confirmationId);
    if (
      readBack === null ||
      JSON.stringify(readBack) !== JSON.stringify(updated)
    ) {
      return { ok: false, reason: "store", record };
    }
    return { ok: true, changed: true, record: readBack };
  } catch {
    return { ok: false, reason: "store", record };
  }
}

export interface ReplacementConfirmationExpectation {
  merchantId: string;
  payerId: string;
  sourceId: string;
  subscriptionId: string;
  proposedStartDate: string;
  /** Checked when supplied — the route learns the plan during preflight. */
  planId?: string;
  confirmedPayments: readonly ConfirmedSchedulePayment[];
}

export type ReplacementConfirmationEvaluation =
  | { ok: true; record: CustomerScheduleConfirmationRecord }
  | {
      ok: false;
      reason:
        | "not-found"
        | "pending"
        | "declined"
        | "expired"
        | "consumed"
        | "mismatch";
      mismatchField?: string;
    };

/**
 * The replacement route's independent verification: the confirmation must
 * exist, be accepted, unexpired and unused, and bind exactly the merchant,
 * payer, source, subscription, proposed start date, payments and (when
 * supplied) plan of the requested replacement. Pure — never calls Pinch.
 */
export function evaluateConfirmationForReplacement(
  record: CustomerScheduleConfirmationRecord | null,
  expected: ReplacementConfirmationExpectation,
  nowIso: string,
): ReplacementConfirmationEvaluation {
  if (record === null) {
    return { ok: false, reason: "not-found" };
  }
  const status = effectiveConfirmationStatus(record, nowIso);
  if (status !== "accepted") {
    return { ok: false, reason: status === "pending" ? "pending" : status };
  }
  const identityFields: Array<[string, string, string]> = [
    ["merchantId", record.merchantId, expected.merchantId],
    ["payerId", record.payerId, expected.payerId],
    ["sourceId", record.sourceId, expected.sourceId],
    ["subscriptionId", record.subscriptionId, expected.subscriptionId],
    ["proposedStartDate", record.proposedStartDate, expected.proposedStartDate],
  ];
  for (const [field, recorded, requested] of identityFields) {
    if (recorded !== requested) {
      return { ok: false, reason: "mismatch", mismatchField: field };
    }
  }
  if (expected.planId !== undefined && record.planId !== expected.planId) {
    return { ok: false, reason: "mismatch", mismatchField: "planId" };
  }
  if (
    !confirmedPaymentsEqual(record.proposedPayments, expected.confirmedPayments)
  ) {
    return { ok: false, reason: "mismatch", mismatchField: "confirmedPayments" };
  }
  return { ok: true, record };
}

/**
 * Single-use consumption: atomically transitions an accepted, unexpired,
 * unused confirmation to consumed, records the operation ID and consumedAt,
 * and verifies the transition by read-back. Returns true only for a
 * verified transition. Called by the replacement flow after all read-only
 * preflight checks and before recovery-record persistence or cancellation.
 * A consumed confirmation is never reset; a later retry needs a new
 * confirmation request.
 */
export async function consumeAcceptedCustomerConfirmation(
  input: { confirmationId: string; operationId: string },
  deps: Pick<CustomerConfirmationServiceDeps, "repository" | "now">,
): Promise<boolean> {
  try {
    const record = await deps.repository.readById(input.confirmationId);
    if (record === null) {
      return false;
    }
    const nowIso = deps.now();
    if (effectiveConfirmationStatus(record, nowIso) !== "accepted") {
      return false;
    }
    const consumed: CustomerScheduleConfirmationRecord = {
      ...record,
      status: "consumed",
      consumedAt: nowIso,
      operationId: input.operationId,
    };
    await deps.repository.write(consumed);
    const readBack = await deps.repository.readById(input.confirmationId);
    return (
      readBack !== null &&
      readBack.status === "consumed" &&
      readBack.consumedAt === nowIso &&
      readBack.operationId === input.operationId
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Real implementations for the dev routes. The validation suite injects
// deterministic fakes instead.

/** At least 256 bits of randomness, URL-safe. Never logged, never stored. */
export function generateCustomerConfirmationToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 hex digest — the only form of the token ever stored. */
export function hashCustomerConfirmationToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function generateCustomerConfirmationId(): string {
  return `conf_${randomUUID()}`;
}
