import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import {
  PinchApiError,
  PinchAuthError,
  PinchConfigError,
  pinchRequest,
} from "@/lib/pinch/client";

/**
 * Development-only, strictly read-only endpoint that discovers a managed
 * payer's Pinch subscriptions and previews the payment schedule that would
 * result from recreating one with a different start date. Every Pinch call
 * is a GET — no plan, subscription, payment, payer or source is ever
 * created, cancelled or updated here.
 *
 * Answers 404 unless the request arrives directly from localhost in
 * `next dev` — the shared guard in src/lib/dev/localhost-guard.ts.
 */

export const runtime = "nodejs";

/**
 * Assumed Pinch subscription ID prefix, consistent with the proven pyr_/
 * src_/pmt_/mch_ convention. To be confirmed against the live list response
 * before the contract is recorded in CLAUDE.md.
 */
const SUBSCRIPTION_ID_PREFIX = "sub_";

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

/**
 * Normalises a Pinch date to its YYYY-MM-DD calendar date.
 * Pinch may return a bare date, a zoneless datetime, or a UTC/offset
 * timestamp (e.g. "2021-04-25T14:00:00.0000000Z"). For zoned timestamps the
 * instant is converted to this machine's local timezone — the merchant's own
 * timezone in local development — so midnight-in-Australia stored as UTC
 * still resolves to the intended calendar day.
 */
function calendarDateOf(value: string): string | null {
  const trimmed = value.trim();
  const leading = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(trimmed);
  if (!leading) {
    return null;
  }
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  if (!hasZone) {
    return leading[1];
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return leading[1];
  }
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Merchant timezone for this development proof route only. The production
 * implementation must obtain it from Merchant.timezone — never hard-code it
 * and never rely on the server machine's own timezone.
 */
const MERCHANT_TIMEZONE = "Australia/Sydney";

// en-CA renders numeric dates as YYYY-MM-DD.
const merchantDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: MERCHANT_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// ISO date-time with an explicit zone designator (Z or ±hh[:]mm).
const ZONED_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Normalises a proven Pinch paymentDate to its calendar date in the
 * merchant's timezone. Pinch stores merchant-local midnight as a UTC
 * instant, so the proven example "2026-08-14T14:00:00.0000000Z" is
 * 2026-08-15 in Australia/Sydney — slicing the timestamp (or converting in
 * the server's own timezone) would yield the wrong day. Zoned timestamps go
 * through an explicit timezone-aware formatter; a zoneless value already
 * states its calendar date and is taken literally; anything else is
 * rejected — never silently treated as UTC.
 */
function merchantCalendarDateOf(value: string): string | null {
  const trimmed = value.trim();
  if (ZONED_ISO_PATTERN.test(trimmed)) {
    // V8 parses ISO strings with over-long fractional seconds (the proven
    // seven-digit form included), returning NaN only for real garbage.
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return merchantDateFormatter.format(parsed);
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

/** Trimmed non-empty string carrying the expected Pinch ID prefix, else null. */
function prefixedId(value: unknown, prefix: string): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.startsWith(prefix) && trimmed !== "" ? trimmed : null;
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

interface ValidatedInput {
  /**
   * Passed only via the pinchRequest option (the Current-Merchant header),
   * never in a Pinch JSON body or query parameter.
   */
  merchantId: string;
  payerId: string;
  proposedStartDate: string;
  subscriptionId?: string;
}

const ALLOWED_INPUT_KEYS = new Set([
  "merchantId",
  "payerId",
  "proposedStartDate",
  "subscriptionId",
]);

/**
 * Strict allowlist validation. Unlike the mutation routes, *any* unknown key
 * is rejected outright — this route accepts no monetary or dollar-valued
 * input of any kind, so an unexpected field means the caller misunderstands
 * the contract and must not be silently ignored.
 */
function validateInput(input: unknown): ValidatedInput | null {
  if (!isPlainObject(input)) {
    return null;
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      return null;
    }
  }

  const validMerchantId = prefixedId(input.merchantId, "mch_");
  const validPayerId = prefixedId(input.payerId, "pyr_");
  if (validMerchantId === null || validPayerId === null) {
    return null;
  }
  if (
    typeof input.proposedStartDate !== "string" ||
    !isRealCalendarDate(input.proposedStartDate)
  ) {
    return null;
  }

  const validated: ValidatedInput = {
    merchantId: validMerchantId,
    payerId: validPayerId,
    proposedStartDate: input.proposedStartDate,
  };
  if (input.subscriptionId !== undefined) {
    const validSubscriptionId = prefixedId(
      input.subscriptionId,
      SUBSCRIPTION_ID_PREFIX,
    );
    if (validSubscriptionId === null) {
      return null;
    }
    validated.subscriptionId = validSubscriptionId;
  }
  return validated;
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

/**
 * Minimal per-entry read of the payer subscription list: only `id` and
 * `status` are needed to select a subscription (everything else comes from
 * the detail read). Every entry must expose both, otherwise active
 * subscriptions cannot be identified safely.
 */
interface SubscriptionListEntry {
  id: string;
  status: string;
}

function extractSubscriptionList(
  result: unknown,
): SubscriptionListEntry[] | null {
  const entries = unwrapList(result);
  if (entries === null) {
    return null;
  }
  const list: SubscriptionListEntry[] = [];
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
 * The safe fields this route may read from GET /subscriptions/{id}. Names,
 * addresses, emails, tokens and the untouched remainder of the response are
 * never extracted. Optional fields are probed under their expected camelCase
 * names and simply omitted when the live response does not expose them —
 * the exact contract is unproven until the live sandbox test.
 */
interface SubscriptionSnapshot {
  id: string;
  payerId: string;
  planId: string;
  status: string;
  /** Normalised YYYY-MM-DD. */
  startDate: string;
  totalAmountCents?: number;
  sourceId?: string;
  recurringAmountCents?: number;
  frequencyInterval?: string;
  frequencyOffset?: number;
}

function extractSubscriptionDetail(
  result: unknown,
): SubscriptionSnapshot | null {
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
  const startDate = rawStartDate === null ? null : calendarDateOf(rawStartDate);
  if (startDate === null) {
    return null;
  }

  const snapshot: SubscriptionSnapshot = {
    id,
    payerId,
    planId,
    status,
    startDate,
  };

  const totalAmount = positiveInteger(result.totalAmount);
  if (totalAmount !== null) {
    snapshot.totalAmountCents = totalAmount;
  }

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
  const frequencyInterval = nonEmptyString(result.frequencyInterval);
  if (frequencyInterval !== null) {
    snapshot.frequencyInterval = frequencyInterval;
  }
  if (
    typeof result.frequencyOffset === "number" &&
    Number.isInteger(result.frequencyOffset) &&
    result.frequencyOffset >= 0
  ) {
    snapshot.frequencyOffset = result.frequencyOffset;
  }

  return snapshot;
}

/**
 * The safe fields this route may read from GET /plans/{id}. Only `id` is
 * required; the rest are probed under their expected camelCase names and
 * omitted when absent, pending live confirmation of the plan contract.
 */
interface PlanSnapshot {
  id: string;
  name?: string;
  requiresTotalAmount?: boolean;
  recurringAmountCents?: number;
  frequencyInterval?: string;
  frequencyOffset?: number;
  startDateOffset?: number;
  endCondition?: string;
  fixedPaymentCount?: number;
}

function extractPlan(result: unknown): PlanSnapshot | null {
  if (!isPlainObject(result)) {
    return null;
  }
  const id = nonEmptyString(result.id);
  if (id === null) {
    return null;
  }

  const snapshot: PlanSnapshot = { id };

  const name = nonEmptyString(result.name);
  if (name !== null) {
    snapshot.name = name;
  }
  if (typeof result.requiresTotalAmount === "boolean") {
    snapshot.requiresTotalAmount = result.requiresTotalAmount;
  }
  const amount = positiveInteger(result.amount);
  if (amount !== null) {
    snapshot.recurringAmountCents = amount;
  }
  const frequencyInterval = nonEmptyString(result.frequencyInterval);
  if (frequencyInterval !== null) {
    snapshot.frequencyInterval = frequencyInterval;
  }
  if (
    typeof result.frequencyOffset === "number" &&
    Number.isInteger(result.frequencyOffset) &&
    result.frequencyOffset >= 0
  ) {
    snapshot.frequencyOffset = result.frequencyOffset;
  }
  if (
    typeof result.startDateOffset === "number" &&
    Number.isInteger(result.startDateOffset)
  ) {
    snapshot.startDateOffset = result.startDateOffset;
  }
  const endCondition = nonEmptyString(result.endCondition);
  if (endCondition !== null) {
    snapshot.endCondition = endCondition;
  }
  const fixedPaymentCount = positiveInteger(result.fixedPaymentCount);
  if (fixedPaymentCount !== null) {
    snapshot.fixedPaymentCount = fixedPaymentCount;
  }

  return snapshot;
}

interface CalculatedPaymentEntry {
  /** Normalised YYYY-MM-DD in the merchant timezone. */
  transactionDate: string;
  amountCents: number;
  description?: string;
  /** Kept internally for ordering only — never returned to the caller. */
  recurringPaymentIndex?: number;
}

/**
 * Interprets GET /plans/{id}/calculated-payments against the proven live
 * contract: a bare array whose entries carry `amountInCents`,
 * `paymentDate`, `description` and `recurringPaymentIndex`. Every entry
 * must expose a positive-integer amount and a paymentDate that normalises
 * in the merchant timezone, otherwise the whole response is treated as
 * unsafe to use.
 */
function extractCalculatedPayments(
  result: unknown,
): CalculatedPaymentEntry[] | null {
  if (!Array.isArray(result)) {
    return null;
  }
  const payments: CalculatedPaymentEntry[] = [];
  for (const entry of result) {
    if (!isPlainObject(entry)) {
      return null;
    }
    const amountCents = positiveInteger(entry.amountInCents);
    if (amountCents === null) {
      return null;
    }
    const rawDate = nonEmptyString(entry.paymentDate);
    const transactionDate =
      rawDate === null ? null : merchantCalendarDateOf(rawDate);
    if (transactionDate === null) {
      return null;
    }
    const payment: CalculatedPaymentEntry = { transactionDate, amountCents };
    if (entry.recurringPaymentIndex !== undefined) {
      if (
        typeof entry.recurringPaymentIndex !== "number" ||
        !Number.isInteger(entry.recurringPaymentIndex) ||
        entry.recurringPaymentIndex < 0
      ) {
        return null;
      }
      payment.recurringPaymentIndex = entry.recurringPaymentIndex;
    }
    if (entry.description !== undefined) {
      if (typeof entry.description !== "string") {
        return null;
      }
      if (entry.description.trim() !== "") {
        payment.description = entry.description.trim();
      }
    }
    payments.push(payment);
  }
  return payments;
}

// ---------------------------------------------------------------------------
// Development-time self-check of the proven live calculated-payments
// contract. Runs once at module load — cheap, deterministic, and requiring
// no dependency — and throws on regression so a broken parser fails fast.

function assertPreviewContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(
      `subscription-preview contract check failed: ${message}`,
    );
  }
}

(function verifyProvenCalculatedPaymentsContract(): void {
  assertPreviewContract(
    merchantCalendarDateOf("2026-08-14T14:00:00.0000000Z") === "2026-08-15",
    "merchant-local midnight stored as UTC must resolve to the Sydney calendar day",
  );
  assertPreviewContract(
    merchantCalendarDateOf("not-a-timestamp") === null,
    "invalid timestamps must be rejected, not treated as UTC",
  );
  assertPreviewContract(
    positiveInteger(12500) === 12500,
    "integer cents must pass through unchanged",
  );
  assertPreviewContract(
    positiveInteger(0) === null && positiveInteger(-12500) === null,
    "zero and negative amounts must be rejected",
  );
  assertPreviewContract(
    positiveInteger(125.5) === null && positiveInteger("12500") === null,
    "fractional and non-numeric amounts must be rejected",
  );
})();

interface SafeLogContext {
  merchantId: string;
  payerId: string;
  subscriptionId?: string;
  planId?: string;
}

function apiFailure(reason: string, context: SafeLogContext): NextResponse {
  // Only the reason text and safe identifiers — never response content.
  console.error(
    `Pinch dev subscription-preview failed at stage "api": ${reason}`,
    context,
  );
  return NextResponse.json({ ok: false, stage: "api" }, { status: 502 });
}

export async function POST(request: NextRequest) {
  if (!isDirectLocalhostRequest(request)) {
    return new NextResponse(null, { status: 404 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await request.text());
  } catch {
    return NextResponse.json(
      { ok: false, stage: "validation" },
      { status: 400 },
    );
  }
  const input = validateInput(parsed);
  if (input === null) {
    return NextResponse.json(
      { ok: false, stage: "validation" },
      { status: 400 },
    );
  }

  // Kept current as the flow advances so the catch block can log safe
  // identifiers without touching any response content.
  const logContext: SafeLogContext = {
    merchantId: input.merchantId,
    payerId: input.payerId,
    subscriptionId: input.subscriptionId,
  };

  try {
    // 1. Discovery: every call in this route is a scoped, read-only GET.
    const list = extractSubscriptionList(
      await pinchRequest<unknown>(
        `subscriptions/payer/${encodeURIComponent(input.payerId)}`,
        { merchantId: input.merchantId },
      ),
    );
    if (list === null) {
      return apiFailure(
        "subscription list response could not be interpreted safely.",
        logContext,
      );
    }

    // 2. Selection. Never guesses: an explicit subscriptionId must belong to
    // this payer under this merchant (it came from the scoped payer list);
    // otherwise exactly one active subscription must exist.
    let selectedId: string;
    if (input.subscriptionId !== undefined) {
      if (!list.some((entry) => entry.id === input.subscriptionId)) {
        console.error(
          "Pinch dev subscription-preview: requested subscription does not belong to the payer under this merchant.",
          logContext,
        );
        return NextResponse.json(
          { ok: false, stage: "not-found" },
          { status: 404 },
        );
      }
      selectedId = input.subscriptionId;
    } else {
      const active = list.filter(
        (entry) => entry.status.toLowerCase() === "active",
      );
      if (active.length === 0) {
        return NextResponse.json({
          ok: true,
          needsSubscriptionSetup: true,
          activeSubscriptionCount: 0,
          merchantId: input.merchantId,
          payerId: input.payerId,
        });
      }
      if (active.length > 1) {
        // Safe conflict: IDs only, so the caller can resubmit with an
        // explicit subscriptionId.
        return NextResponse.json(
          {
            ok: false,
            stage: "conflict",
            activeSubscriptionCount: active.length,
            activeSubscriptionIds: active.map((entry) => entry.id),
          },
          { status: 409 },
        );
      }
      selectedId = active[0].id;
    }
    logContext.subscriptionId = selectedId;

    // 3. Complete subscription read.
    const subscription = extractSubscriptionDetail(
      await pinchRequest<unknown>(
        `subscriptions/${encodeURIComponent(selectedId)}`,
        { merchantId: input.merchantId },
      ),
    );
    if (subscription === null) {
      return apiFailure(
        "subscription detail response could not be interpreted safely.",
        logContext,
      );
    }
    if (subscription.id !== selectedId) {
      return apiFailure(
        "subscription detail ID did not match the selected subscription.",
        logContext,
      );
    }
    if (subscription.payerId !== input.payerId) {
      return apiFailure(
        "subscription does not belong to the requested payer.",
        logContext,
      );
    }
    if (subscription.status.toLowerCase() !== "active") {
      return apiFailure(
        "subscription is not active, so a replacement cannot be previewed.",
        logContext,
      );
    }
    logContext.planId = subscription.planId;

    // 4. Plan read.
    const plan = extractPlan(
      await pinchRequest<unknown>(
        `plans/${encodeURIComponent(subscription.planId)}`,
        { merchantId: input.merchantId },
      ),
    );
    if (plan === null) {
      return apiFailure(
        "plan response could not be interpreted safely.",
        logContext,
      );
    }
    if (plan.id !== subscription.planId) {
      return apiFailure(
        "plan response ID did not match the subscription's plan.",
        logContext,
      );
    }

    // 5. Replacement preview via Pinch's own calculation — dates are never
    // computed locally. totalAmount joins the query only when the plan
    // requires it; merchantId stays in the Current-Merchant header.
    const searchParams: Record<string, string | number> = {
      startDate: input.proposedStartDate,
    };
    if (plan.requiresTotalAmount === true) {
      if (subscription.totalAmountCents === undefined) {
        return apiFailure(
          "plan requires totalAmount but the subscription did not expose one.",
          logContext,
        );
      }
      searchParams.totalAmount = subscription.totalAmountCents;
    }

    const calculated = extractCalculatedPayments(
      await pinchRequest<unknown>(
        `plans/${encodeURIComponent(subscription.planId)}/calculated-payments`,
        { merchantId: input.merchantId, searchParams },
      ),
    );
    if (calculated === null) {
      return apiFailure(
        "calculated-payments response could not be interpreted safely.",
        logContext,
      );
    }
    if (calculated.length === 0) {
      return apiFailure(
        "calculated-payments returned no payments for the proposed start date.",
        logContext,
      );
    }

    // Order by recurringPaymentIndex when every entry exposes it (the
    // proven sequence marker), otherwise by merchant-local date. Only the
    // first three are returned, and the index never leaves the route.
    const allIndexed = calculated.every(
      (payment) => payment.recurringPaymentIndex !== undefined,
    );
    const previewPayments = [...calculated]
      .sort((a, b) => {
        if (allIndexed) {
          return (
            (a.recurringPaymentIndex ?? 0) - (b.recurringPaymentIndex ?? 0)
          );
        }
        if (a.transactionDate < b.transactionDate) {
          return -1;
        }
        return a.transactionDate > b.transactionDate ? 1 : 0;
      })
      .slice(0, 3)
      .map((payment) => {
        const entry: Record<string, unknown> = {
          transactionDate: payment.transactionDate,
          amountCents: payment.amountCents,
        };
        if (payment.description !== undefined) {
          entry.description = payment.description;
        }
        return entry;
      });

    // 6. Limited response: primitives and safe identifiers only. Optional
    // fields appear only when the live response exposed them.
    const subscriptionBody: Record<string, unknown> = {
      id: subscription.id,
      planId: subscription.planId,
      status: subscription.status,
      currentStartDate: subscription.startDate,
    };
    if (subscription.totalAmountCents !== undefined) {
      subscriptionBody.totalAmountCents = subscription.totalAmountCents;
    }
    if (subscription.sourceId !== undefined) {
      subscriptionBody.sourceId = subscription.sourceId;
    }
    if (subscription.recurringAmountCents !== undefined) {
      subscriptionBody.recurringAmountCents = subscription.recurringAmountCents;
    }
    if (subscription.frequencyInterval !== undefined) {
      subscriptionBody.frequencyInterval = subscription.frequencyInterval;
    }
    if (subscription.frequencyOffset !== undefined) {
      subscriptionBody.frequencyOffset = subscription.frequencyOffset;
    }

    const planBody: Record<string, unknown> = { id: plan.id };
    if (plan.name !== undefined) {
      planBody.name = plan.name;
    }
    if (plan.requiresTotalAmount !== undefined) {
      planBody.requiresTotalAmount = plan.requiresTotalAmount;
    }
    if (plan.recurringAmountCents !== undefined) {
      planBody.recurringAmountCents = plan.recurringAmountCents;
    }
    if (plan.frequencyInterval !== undefined) {
      planBody.frequencyInterval = plan.frequencyInterval;
    }
    if (plan.frequencyOffset !== undefined) {
      planBody.frequencyOffset = plan.frequencyOffset;
    }
    if (plan.startDateOffset !== undefined) {
      planBody.startDateOffset = plan.startDateOffset;
    }
    if (plan.endCondition !== undefined) {
      planBody.endCondition = plan.endCondition;
    }
    if (plan.fixedPaymentCount !== undefined) {
      planBody.fixedPaymentCount = plan.fixedPaymentCount;
    }

    return NextResponse.json({
      ok: true,
      needsSubscriptionSetup: false,
      merchantId: input.merchantId,
      payerId: input.payerId,
      subscription: subscriptionBody,
      plan: planBody,
      replacement: {
        proposedStartDate: input.proposedStartDate,
        payments: previewPayments,
      },
    });
  } catch (error) {
    const stage =
      error instanceof PinchAuthError || error instanceof PinchConfigError
        ? "auth"
        : "api";

    // Never log upstream response bodies: Pinch error bodies can carry
    // tokenised source details and payer PII. Log only classification
    // fields and safe identifiers.
    console.error(
      `Pinch dev subscription-preview failed at stage "${stage}".`,
      {
        errorClass: error instanceof Error ? error.name : "UnknownError",
        upstreamStatus:
          error instanceof PinchAuthError || error instanceof PinchApiError
            ? (error.status ?? "none")
            : "none",
        ...logContext,
      },
    );

    const httpStatus = error instanceof PinchConfigError ? 500 : 502;
    return NextResponse.json({ ok: false, stage }, { status: httpStatus });
  }
}
