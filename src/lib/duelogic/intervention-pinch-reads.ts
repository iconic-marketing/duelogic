/**
 * Real read-only Pinch effects for the Stage 1 intervention routes.
 *
 * Strictly GET-shaped: this module can list a payer's subscriptions, read a
 * subscription, read a plan and read Pinch-calculated payments. It contains
 * no mutation of any kind and follows the proven response contracts
 * established by the dev subscription-preview route: list endpoints answer
 * bare or `data`-wrapped arrays, payer identity nests under `payer.id`,
 * amounts are integer cents, and `paymentDate` is a zoned timestamp that
 * must be converted with a timezone-aware formatter in the merchant
 * timezone — never sliced, never interpreted in the server's own timezone.
 *
 * Shape problems return null so callers fail safely; transport, auth and
 * configuration failures throw the Pinch client's typed errors for the
 * routes to classify. Response bodies are never logged or returned — only
 * safe extracted fields leave this module.
 */

import { pinchRequest } from "@/lib/pinch/client";
import type { ConfirmedSchedulePayment } from "@/lib/pinch/customer-confirmation";
import type { InterventionPreviewReadEffects } from "./intervention-service";
import type {
  SubscriptionDetailSnapshot,
  SubscriptionListItem,
  SubscriptionReadEffects,
} from "./subscription-resolver";

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts: the
// `server-only` package is not installed in this project, so fail at import
// time if this module ever reaches browser code.
if (typeof window !== "undefined") {
  throw new Error(
    "The intervention Pinch reads are server-only and must not be imported into browser code.",
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  return value.trim();
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRealCalendarDate(value: string): boolean {
  if (!DATE_ONLY_PATTERN.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

// ISO date-time with an explicit zone designator (Z or ±hh[:]mm).
const ZONED_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Normalises a Pinch date to its calendar date in the merchant timezone.
 * Pinch stores merchant-local midnight as a UTC instant, so a zoned
 * timestamp goes through an explicit timezone-aware formatter; a zoneless
 * value already states its calendar date and is taken literally; anything
 * else is rejected — never silently treated as UTC.
 */
function merchantCalendarDateOf(
  value: string,
  formatter: Intl.DateTimeFormat,
): string | null {
  const trimmed = value.trim();
  if (ZONED_ISO_PATTERN.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return formatter.format(parsed);
  }
  const zoneless =
    /^(\d{4}-\d{2}-\d{2})(?:$|[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$)/.exec(
      trimmed,
    );
  if (zoneless !== null && isRealCalendarDate(zoneless[1])) {
    return zoneless[1];
  }
  return null;
}

/**
 * A list endpoint may answer with a bare array or a `data`-wrapped array;
 * no other container shape is probed.
 */
function unwrapList(result: unknown): unknown[] | null {
  if (Array.isArray(result)) {
    return result;
  }
  if (isPlainObject(result) && Array.isArray(result.data)) {
    return result.data;
  }
  return null;
}

function extractSubscriptionList(
  result: unknown,
): SubscriptionListItem[] | null {
  const entries = unwrapList(result);
  if (entries === null) {
    return null;
  }
  const list: SubscriptionListItem[] = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      return null;
    }
    const id = nonEmptyString(entry.id);
    const status = nonEmptyString(entry.status);
    if (id === null || status === null) {
      return null;
    }
    list.push({ id, status });
  }
  return list;
}

/**
 * The safe fields the intervention flow may read from
 * GET /subscriptions/{id}. Names, addresses, emails, tokens and the
 * untouched remainder of the response are never extracted.
 */
function extractSubscriptionDetail(
  result: unknown,
  formatter: Intl.DateTimeFormat,
): SubscriptionDetailSnapshot | null {
  if (!isPlainObject(result)) {
    return null;
  }
  const id = nonEmptyString(result.id);
  const status = nonEmptyString(result.status);
  if (id === null || status === null) {
    return null;
  }

  // The payer ID nests under payer.id on payment reads (proven); probe the
  // same shape first, then a flat payerId.
  let payerId: string | null = null;
  if (isPlainObject(result.payer)) {
    payerId = nonEmptyString(result.payer.id);
  }
  if (payerId === null) {
    payerId = nonEmptyString(result.payerId);
  }
  if (payerId === null) {
    return null;
  }

  let planId = nonEmptyString(result.planId);
  if (planId === null && isPlainObject(result.plan)) {
    planId = nonEmptyString(result.plan.id);
  }
  if (planId === null) {
    return null;
  }

  const rawStartDate = nonEmptyString(result.startDate);
  const startDate =
    rawStartDate === null
      ? null
      : merchantCalendarDateOf(rawStartDate, formatter);
  if (startDate === null) {
    return null;
  }

  const snapshot: SubscriptionDetailSnapshot = {
    id,
    payerId,
    planId,
    status,
    startDate,
  };
  let sourceId = nonEmptyString(result.sourceId);
  if (sourceId === null && isPlainObject(result.source)) {
    sourceId = nonEmptyString(result.source.id);
  }
  if (sourceId !== null) {
    snapshot.sourceId = sourceId;
  }
  const recurringAmount = positiveInteger(result.recurringAmount);
  if (recurringAmount !== null) {
    snapshot.recurringAmountCents = recurringAmount;
  }
  const totalAmount = positiveInteger(result.totalAmount);
  if (totalAmount !== null) {
    snapshot.totalAmountCents = totalAmount;
  }
  return snapshot;
}

/**
 * Interprets GET /plans/{planId}/calculated-payments against the proven
 * live contract: a bare array whose entries carry `amountInCents`,
 * `paymentDate` and `recurringPaymentIndex`. Entries are ordered by the
 * proven sequence marker when every entry exposes it, otherwise by
 * merchant-local date; only dates and integer cents leave this function.
 */
function extractCalculatedPayments(
  result: unknown,
  formatter: Intl.DateTimeFormat,
): ConfirmedSchedulePayment[] | null {
  if (!Array.isArray(result)) {
    return null;
  }
  const entries: Array<ConfirmedSchedulePayment & { index?: number }> = [];
  for (const entry of result) {
    if (!isPlainObject(entry)) {
      return null;
    }
    const amountInCents = positiveInteger(entry.amountInCents);
    if (amountInCents === null) {
      return null;
    }
    const rawDate = nonEmptyString(entry.paymentDate);
    const paymentDate =
      rawDate === null ? null : merchantCalendarDateOf(rawDate, formatter);
    if (paymentDate === null) {
      return null;
    }
    const payment: ConfirmedSchedulePayment & { index?: number } = {
      paymentDate,
      amountInCents,
    };
    if (entry.recurringPaymentIndex !== undefined) {
      if (
        typeof entry.recurringPaymentIndex !== "number" ||
        !Number.isInteger(entry.recurringPaymentIndex) ||
        entry.recurringPaymentIndex < 0
      ) {
        return null;
      }
      payment.index = entry.recurringPaymentIndex;
    }
    entries.push(payment);
  }
  const allIndexed = entries.every((payment) => payment.index !== undefined);
  entries.sort((a, b) => {
    if (allIndexed) {
      return (a.index ?? 0) - (b.index ?? 0);
    }
    if (a.paymentDate < b.paymentDate) {
      return -1;
    }
    return a.paymentDate > b.paymentDate ? 1 : 0;
  });
  return entries.map(({ paymentDate, amountInCents }) => ({
    paymentDate,
    amountInCents,
  }));
}

/**
 * Builds the live read-only effects for the given merchant timezone (a
 * development proof value from the fixture; production must use
 * Merchant.timezone). merchantId is passed only via the pinchRequest option
 * — the Current-Merchant header — never in a body or query parameter.
 */
export function createInterventionPinchReadEffects(
  merchantTimezone: string,
): SubscriptionReadEffects & InterventionPreviewReadEffects {
  // en-CA renders numeric dates as YYYY-MM-DD.
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: merchantTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return {
    async listPayerSubscriptions(merchantId, payerId) {
      return extractSubscriptionList(
        await pinchRequest<unknown>(
          `subscriptions/payer/${encodeURIComponent(payerId)}`,
          { merchantId },
        ),
      );
    },
    async readSubscription(merchantId, subscriptionId) {
      return extractSubscriptionDetail(
        await pinchRequest<unknown>(
          `subscriptions/${encodeURIComponent(subscriptionId)}`,
          { merchantId },
        ),
        formatter,
      );
    },
    async readPlan(merchantId, planId) {
      const result = await pinchRequest<unknown>(
        `plans/${encodeURIComponent(planId)}`,
        { merchantId },
      );
      if (!isPlainObject(result)) {
        return null;
      }
      const id = nonEmptyString(result.id);
      if (id === null) {
        return null;
      }
      const plan: { id: string; requiresTotalAmount?: boolean } = { id };
      if (typeof result.requiresTotalAmount === "boolean") {
        plan.requiresTotalAmount = result.requiresTotalAmount;
      }
      return plan;
    },
    async readCalculatedPayments(
      merchantId,
      planId,
      startDate,
      totalAmountCents,
    ) {
      return extractCalculatedPayments(
        await pinchRequest<unknown>(
          `plans/${encodeURIComponent(planId)}/calculated-payments`,
          {
            merchantId,
            searchParams: {
              startDate,
              totalAmount: totalAmountCents,
            },
          },
        ),
        formatter,
      );
    },
  };
}
