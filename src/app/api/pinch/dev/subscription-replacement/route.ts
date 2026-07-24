import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import {
  PinchApiError,
  PinchAuthError,
  PinchConfigError,
  pinchRequest,
} from "@/lib/pinch/client";

/**
 * Development-only endpoint that proves permanent recurring schedule
 * correction: it cancels one active Pinch subscription and recreates it
 * against the same plan, payer and source with a new start date.
 *
 * The two mutations (DELETE then POST) are not atomic. Each is issued at
 * most once per request — never retried after any response or ambiguity —
 * and every failure after the original subscription is cancelled reports a
 * manual-recovery state instead of guessing. This is localhost-only proof
 * code, not a production transaction coordinator: production needs durable
 * operation state before executing a replacement.
 *
 * Answers 404 unless the request arrives directly from localhost in
 * `next dev` — the shared guard in src/lib/dev/localhost-guard.ts.
 */

export const runtime = "nodejs";

/**
 * The exact confirmation phrase and the confirmed three-payment schedule
 * together represent explicit approval of the permanent change. A free-text
 * request alone is insufficient authority to cancel a subscription.
 */
const CONFIRMATION_PHRASE = "REPLACE FUTURE SCHEDULE";

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

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ISO date-time with an explicit zone designator (Z or ±hh[:]mm).
const ZONED_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

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
 * Normalises a Pinch date to its calendar date in the merchant's timezone.
 * Pinch stores merchant-local midnight as a UTC instant (proven:
 * "2026-08-14T14:00:00.0000000Z" is 2026-08-15 in Australia/Sydney), so
 * zoned timestamps go through an explicit timezone-aware formatter; a
 * zoneless value already states its calendar date and is taken literally;
 * anything else is rejected — never silently treated as UTC.
 */
function merchantCalendarDateOf(value: string): string | null {
  const trimmed = value.trim();
  if (ZONED_ISO_PATTERN.test(trimmed)) {
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

interface ConfirmedPayment {
  /** YYYY-MM-DD. */
  transactionDate: string;
  /** Integer cents — no dollar field exists and no conversion is performed. */
  amountCents: number;
}

interface ValidatedInput {
  /**
   * Passed only via the pinchRequest option (the Current-Merchant header),
   * never in a Pinch JSON body or query parameter.
   */
  merchantId: string;
  payerId: string;
  sourceId: string;
  subscriptionId: string;
  proposedStartDate: string;
  operationId: string;
  confirmedPayments: ConfirmedPayment[];
}

const ALLOWED_INPUT_KEYS = new Set([
  "merchantId",
  "payerId",
  "sourceId",
  "subscriptionId",
  "proposedStartDate",
  "operationId",
  "confirmation",
  "confirmedPayments",
]);

const ALLOWED_CONFIRMED_PAYMENT_KEYS = new Set([
  "transactionDate",
  "amountCents",
]);

/**
 * Strict allowlist validation: any unknown key at either level is rejected
 * outright. This route accepts no dollar-valued monetary field and no
 * customer free text of any kind — no explanations, employment details,
 * payday data or financial circumstances. The confirmation phrase must
 * match exactly, untrimmed.
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

  const merchantId = prefixedId(input.merchantId, "mch_");
  const payerId = prefixedId(input.payerId, "pyr_");
  const sourceId = prefixedId(input.sourceId, "src_");
  const subscriptionId = prefixedId(input.subscriptionId, "sub_");
  if (
    merchantId === null ||
    payerId === null ||
    sourceId === null ||
    subscriptionId === null
  ) {
    return null;
  }
  if (
    typeof input.proposedStartDate !== "string" ||
    !isRealCalendarDate(input.proposedStartDate)
  ) {
    return null;
  }
  const operationId = nonEmptyString(input.operationId);
  if (operationId === null || operationId.length > 100) {
    return null;
  }
  if (input.confirmation !== CONFIRMATION_PHRASE) {
    return null;
  }
  if (!Array.isArray(input.confirmedPayments) || input.confirmedPayments.length !== 3) {
    return null;
  }
  const confirmedPayments: ConfirmedPayment[] = [];
  for (const entry of input.confirmedPayments) {
    if (!isPlainObject(entry)) {
      return null;
    }
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_CONFIRMED_PAYMENT_KEYS.has(key)) {
        return null;
      }
    }
    if (
      typeof entry.transactionDate !== "string" ||
      !isRealCalendarDate(entry.transactionDate)
    ) {
      return null;
    }
    const amountCents = positiveInteger(entry.amountCents);
    if (amountCents === null) {
      return null;
    }
    confirmedPayments.push({
      transactionDate: entry.transactionDate,
      amountCents,
    });
  }

  return {
    merchantId,
    payerId,
    sourceId,
    subscriptionId,
    proposedStartDate: input.proposedStartDate,
    operationId,
    confirmedPayments,
  };
}

/**
 * Minimal read used where only identity and status matter (repeat-call
 * detection and post-DELETE cancellation verification) — a cancelled
 * subscription may legitimately expose fewer fields than an active one.
 */
function extractSubscriptionStatus(
  result: unknown,
): { id: string; status: string } | null {
  if (!isPlainObject(result)) {
    return null;
  }
  const id = nonEmptyString(result.id);
  const status = nonEmptyString(result.status);
  if (id === null || status === null) {
    return null;
  }
  return { id, status };
}

/**
 * The safe fields this route may read from GET /subscriptions/{id}. Names,
 * addresses, emails, tokens and the untouched remainder of the response are
 * never extracted.
 */
interface SubscriptionSnapshot {
  id: string;
  payerId: string;
  planId: string;
  status: string;
  /** Normalised YYYY-MM-DD in the merchant timezone. */
  startDate: string;
  totalAmountCents?: number;
  sourceId?: string;
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
    rawStartDate === null ? null : merchantCalendarDateOf(rawStartDate);
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

  return snapshot;
}

interface PlanSnapshot {
  id: string;
  requiresTotalAmount: boolean;
}

/**
 * Only what the replacement needs: the plan's identity and whether the
 * calculated-payments query must carry totalAmount. The plan itself is
 * never modified or recreated — Pinch calculates the replacement schedule.
 */
function extractPlan(result: unknown): PlanSnapshot | null {
  if (!isPlainObject(result)) {
    return null;
  }
  const id = nonEmptyString(result.id);
  if (id === null) {
    return null;
  }
  return {
    id,
    requiresTotalAmount: result.requiresTotalAmount === true,
  };
}

interface CalculatedPaymentEntry {
  /** Normalised YYYY-MM-DD in the merchant timezone. */
  transactionDate: string;
  amountCents: number;
  /** Kept internally for ordering only — never returned to the caller. */
  recurringPaymentIndex?: number;
}

/**
 * Interprets GET /plans/{id}/calculated-payments against the proven live
 * contract: a bare array whose entries carry `amountInCents`, `paymentDate`,
 * `description` and `recurringPaymentIndex`. Any violation anywhere in the
 * array makes the whole response unsafe to use.
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
    if (entry.description !== undefined && typeof entry.description !== "string") {
      return null;
    }
    payments.push(payment);
  }
  return payments;
}

/**
 * Proven sequence order: recurringPaymentIndex when every entry exposes it,
 * otherwise merchant-local date.
 */
function orderCalculatedPayments(
  payments: CalculatedPaymentEntry[],
): CalculatedPaymentEntry[] {
  const allIndexed = payments.every(
    (payment) => payment.recurringPaymentIndex !== undefined,
  );
  return [...payments].sort((a, b) => {
    if (allIndexed) {
      return (a.recurringPaymentIndex ?? 0) - (b.recurringPaymentIndex ?? 0);
    }
    if (a.transactionDate < b.transactionDate) {
      return -1;
    }
    return a.transactionDate > b.transactionDate ? 1 : 0;
  });
}

/**
 * Exact match between the recalculated schedule and the caller-confirmed
 * schedule: same dates, same integer cents, same order, for every confirmed
 * entry.
 */
function scheduleMatchesConfirmation(
  ordered: CalculatedPaymentEntry[],
  confirmed: ConfirmedPayment[],
): boolean {
  if (ordered.length < confirmed.length) {
    return false;
  }
  return confirmed.every(
    (payment, index) =>
      ordered[index].transactionDate === payment.transactionDate &&
      ordered[index].amountCents === payment.amountCents,
  );
}

/**
 * The creation response may be a subscription object carrying `id` or a
 * bare ID string; in either case the ID must carry the sub_ prefix. No
 * other shape is probed — an unrecognisable success is treated as ambiguous
 * and never retried.
 */
function extractNewSubscriptionId(result: unknown): string | null {
  if (typeof result === "string") {
    return prefixedId(result, "sub_");
  }
  if (isPlainObject(result)) {
    return prefixedId(result.id, "sub_");
  }
  return null;
}

interface SafeLogContext {
  operationId: string;
  merchantId: string;
  payerId: string;
  oldSubscriptionId: string;
  planId?: string;
  newSubscriptionId?: string;
}

function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function upstreamStatusOf(error: unknown): number | "none" {
  return (error instanceof PinchAuthError || error instanceof PinchApiError) &&
    error.status !== undefined
    ? error.status
    : "none";
}

function apiFailure(reason: string, context: SafeLogContext): NextResponse {
  // Only the reason text and safe identifiers — never response content.
  console.error(
    `Pinch dev subscription-replacement failed at stage "api": ${reason}`,
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

  const logContext: SafeLogContext = {
    operationId: input.operationId,
    merchantId: input.merchantId,
    payerId: input.payerId,
    oldSubscriptionId: input.subscriptionId,
  };

  const subscriptionPath = `subscriptions/${encodeURIComponent(input.subscriptionId)}`;

  // Set the moment the DELETE is issued. From then on, no code path may
  // answer with a generic error: the caller must always learn that the
  // operation is mid-flight and the original subscription may be gone.
  let mutationStarted = false;
  let newSubscriptionId: string | undefined;

  try {
    // -----------------------------------------------------------------
    // Phase 1: preflight — read-only, before any mutation.
    // -----------------------------------------------------------------
    const preflightRead = await pinchRequest<unknown>(subscriptionPath, {
      merchantId: input.merchantId,
    });

    // Status first, using the minimal read: a repeated call with an
    // already-cancelled (or failed/complete) subscription must stop here
    // and must never create another replacement. The replacement is not
    // located automatically.
    const statusRead = extractSubscriptionStatus(preflightRead);
    if (statusRead === null) {
      return apiFailure(
        "subscription response could not be interpreted safely.",
        logContext,
      );
    }
    if (statusRead.id !== input.subscriptionId) {
      return apiFailure(
        "subscription response ID did not match the requested subscription.",
        logContext,
      );
    }
    if (statusRead.status.toLowerCase() !== "active") {
      console.error(
        'Pinch dev subscription-replacement refused at stage "subscription-not-active".',
        { ...logContext, status: statusRead.status.toLowerCase() },
      );
      return NextResponse.json(
        {
          ok: false,
          stage: "subscription-not-active",
          operationId: input.operationId,
          subscriptionId: input.subscriptionId,
          status: statusRead.status.toLowerCase(),
        },
        { status: 409 },
      );
    }

    const subscription = extractSubscriptionDetail(preflightRead);
    if (subscription === null) {
      return apiFailure(
        "active subscription detail could not be interpreted safely.",
        logContext,
      );
    }
    if (subscription.payerId !== input.payerId) {
      return apiFailure(
        "subscription does not belong to the requested payer.",
        logContext,
      );
    }
    if (!subscription.planId.startsWith("pln_")) {
      return apiFailure(
        "subscription plan ID did not carry the expected pln_ prefix.",
        logContext,
      );
    }
    // Source identity is verified only when the read exposes it at a
    // proven reliable field; absence skips the check rather than failing.
    if (
      subscription.sourceId !== undefined &&
      subscription.sourceId !== input.sourceId
    ) {
      return apiFailure(
        "subscription source does not match the requested source.",
        logContext,
      );
    }
    logContext.planId = subscription.planId;

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
    if (plan.requiresTotalAmount && subscription.totalAmountCents === undefined) {
      return apiFailure(
        "plan requires totalAmount but the subscription did not expose one.",
        logContext,
      );
    }

    // Recalculate the replacement schedule Pinch-side and require it to
    // still match what the customer explicitly confirmed. merchantId stays
    // in the Current-Merchant header; totalAmount joins the query only
    // when the plan requires it.
    const calculatedPaymentsPath = `plans/${encodeURIComponent(subscription.planId)}/calculated-payments`;
    const searchParams: Record<string, string | number> = {
      startDate: input.proposedStartDate,
    };
    if (plan.requiresTotalAmount && subscription.totalAmountCents !== undefined) {
      searchParams.totalAmount = subscription.totalAmountCents;
    }

    const preflightCalculated = extractCalculatedPayments(
      await pinchRequest<unknown>(calculatedPaymentsPath, {
        merchantId: input.merchantId,
        searchParams,
      }),
    );
    if (preflightCalculated === null) {
      return apiFailure(
        "calculated-payments response could not be interpreted safely.",
        logContext,
      );
    }
    if (
      !scheduleMatchesConfirmation(
        orderCalculatedPayments(preflightCalculated),
        input.confirmedPayments,
      )
    ) {
      console.error(
        'Pinch dev subscription-replacement refused at stage "confirmation-stale": recalculated schedule no longer matches the confirmed schedule.',
        logContext,
      );
      return NextResponse.json(
        { ok: false, stage: "confirmation-stale" },
        { status: 409 },
      );
    }

    // -----------------------------------------------------------------
    // Phase 2: cancel the original subscription.
    // -----------------------------------------------------------------
    // The one and only DELETE. Its outcome is deliberately not trusted:
    // the verification GET below is the sole source of truth, and the
    // DELETE is never repeated even if it throws or answers ambiguously.
    mutationStarted = true;
    try {
      await pinchRequest<unknown>(subscriptionPath, {
        method: "DELETE",
        merchantId: input.merchantId,
      });
    } catch (error) {
      console.error(
        "Pinch dev subscription-replacement: DELETE reported an error; proceeding to cancellation verification without retrying.",
        {
          ...logContext,
          errorClass: errorClassOf(error),
          upstreamStatus: upstreamStatusOf(error),
        },
      );
    }

    let cancellationVerified = false;
    try {
      const cancelledRead = extractSubscriptionStatus(
        await pinchRequest<unknown>(subscriptionPath, {
          merchantId: input.merchantId,
        }),
      );
      cancellationVerified =
        cancelledRead !== null &&
        cancelledRead.id === input.subscriptionId &&
        cancelledRead.status.toLowerCase() === "cancelled";
    } catch (error) {
      console.error(
        "Pinch dev subscription-replacement: cancellation verification read failed.",
        {
          ...logContext,
          errorClass: errorClassOf(error),
          upstreamStatus: upstreamStatusOf(error),
        },
      );
    }
    if (!cancellationVerified) {
      console.error(
        'Pinch dev subscription-replacement failed at stage "cancel-verification".',
        { ...logContext, requiresManualReview: true },
      );
      return NextResponse.json(
        {
          ok: false,
          stage: "cancel-verification",
          operationId: input.operationId,
          oldSubscriptionId: input.subscriptionId,
          requiresManualReview: true,
        },
        { status: 502 },
      );
    }

    // -----------------------------------------------------------------
    // Phase 3: create the replacement.
    // -----------------------------------------------------------------
    // The one and only POST /subscriptions, built explicitly with only the
    // four (or five) allowed fields. No merchantId, no old subscription
    // ID, no operation metadata, no surcharge — the sandbox subscription
    // has no surcharge selected, so omitting it preserves the proven
    // setup. Never retried: any failure or ambiguity after this point is a
    // manual-recovery state because the original is already cancelled.
    const createBody: Record<string, unknown> = {
      planId: subscription.planId,
      payerId: input.payerId,
      sourceId: input.sourceId,
      startDate: input.proposedStartDate,
    };
    if (plan.requiresTotalAmount && subscription.totalAmountCents !== undefined) {
      createBody.totalAmount = subscription.totalAmountCents;
    }

    let created: unknown;
    try {
      created = await pinchRequest<unknown>("subscriptions", {
        method: "POST",
        body: createBody,
        merchantId: input.merchantId,
      });
    } catch (error) {
      console.error(
        'Pinch dev subscription-replacement failed at stage "replacement-create": original subscription is cancelled and the replacement was not created.',
        {
          ...logContext,
          errorClass: errorClassOf(error),
          upstreamStatus: upstreamStatusOf(error),
          requiresManualRecovery: true,
        },
      );
      return NextResponse.json(
        {
          ok: false,
          stage: "replacement-create",
          operationId: input.operationId,
          oldSubscriptionId: input.subscriptionId,
          proposedStartDate: input.proposedStartDate,
          requiresManualRecovery: true,
        },
        { status: 502 },
      );
    }

    const extractedId = extractNewSubscriptionId(created);
    if (extractedId === null) {
      // Upstream reported success, so a replacement may exist; repeating
      // the POST could create a duplicate and is forbidden.
      console.error(
        'Pinch dev subscription-replacement failed at stage "replacement-ambiguous": creation reported success but no subscription ID could be extracted.',
        { ...logContext, requiresManualRecovery: true },
      );
      return NextResponse.json(
        {
          ok: false,
          stage: "replacement-ambiguous",
          operationId: input.operationId,
          oldSubscriptionId: input.subscriptionId,
          oldSubscriptionStatus: "cancelled",
          requiresManualRecovery: true,
        },
        { status: 502 },
      );
    }
    newSubscriptionId = extractedId;
    logContext.newSubscriptionId = newSubscriptionId;

    // -----------------------------------------------------------------
    // Phase 4: verify the replacement. Read-only; a failure here performs
    // no further mutation and reports the created-but-unverified state.
    // -----------------------------------------------------------------
    let verified = false;
    let newStatus = "";
    try {
      const readBack = extractSubscriptionDetail(
        await pinchRequest<unknown>(
          `subscriptions/${encodeURIComponent(newSubscriptionId)}`,
          { merchantId: input.merchantId },
        ),
      );
      const recalculated = extractCalculatedPayments(
        await pinchRequest<unknown>(calculatedPaymentsPath, {
          merchantId: input.merchantId,
          searchParams,
        }),
      );
      verified =
        readBack !== null &&
        readBack.id === newSubscriptionId &&
        readBack.payerId === input.payerId &&
        readBack.planId === subscription.planId &&
        readBack.status.toLowerCase() === "active" &&
        readBack.startDate === input.proposedStartDate &&
        recalculated !== null &&
        scheduleMatchesConfirmation(
          orderCalculatedPayments(recalculated),
          input.confirmedPayments,
        );
      if (readBack !== null) {
        newStatus = readBack.status.toLowerCase();
      }
    } catch (error) {
      console.error(
        "Pinch dev subscription-replacement: replacement verification read failed.",
        {
          ...logContext,
          errorClass: errorClassOf(error),
          upstreamStatus: upstreamStatusOf(error),
        },
      );
    }
    if (!verified) {
      console.error(
        'Pinch dev subscription-replacement failed at stage "replacement-verification".',
        { ...logContext, requiresManualReview: true },
      );
      return NextResponse.json(
        {
          ok: false,
          stage: "replacement-verification",
          operationId: input.operationId,
          oldSubscriptionId: input.subscriptionId,
          newSubscriptionId,
          requiresManualReview: true,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      operationId: input.operationId,
      merchantId: input.merchantId,
      payerId: input.payerId,
      sourceId: input.sourceId,
      oldSubscription: {
        id: input.subscriptionId,
        previousStartDate: subscription.startDate,
        status: "cancelled",
      },
      newSubscription: {
        id: newSubscriptionId,
        planId: subscription.planId,
        startDate: input.proposedStartDate,
        status: newStatus,
      },
      confirmedPayments: input.confirmedPayments,
    });
  } catch (error) {
    // Phases 2-4 contain their own error handling and never rethrow, so
    // this catch normally fires only during read-only preflight. The
    // mutationStarted guard is a second net: if an unexpected bug escapes
    // after the DELETE was issued, the caller must still learn that the
    // operation is mid-flight rather than receive a generic error.
    if (mutationStarted) {
      console.error(
        'Pinch dev subscription-replacement failed unexpectedly after mutation began; stage "replacement-create".',
        {
          ...logContext,
          errorClass: errorClassOf(error),
          upstreamStatus: upstreamStatusOf(error),
          requiresManualRecovery: true,
        },
      );
      return NextResponse.json(
        {
          ok: false,
          stage: "replacement-create",
          operationId: input.operationId,
          oldSubscriptionId: input.subscriptionId,
          proposedStartDate: input.proposedStartDate,
          requiresManualRecovery: true,
        },
        { status: 502 },
      );
    }

    const stage =
      error instanceof PinchAuthError || error instanceof PinchConfigError
        ? "auth"
        : "api";

    // Never log upstream response bodies: Pinch error bodies can carry
    // tokenised source details and payer PII. Log only classification
    // fields and safe identifiers.
    console.error(
      `Pinch dev subscription-replacement failed at stage "${stage}".`,
      {
        errorClass: errorClassOf(error),
        upstreamStatus: upstreamStatusOf(error),
        ...logContext,
      },
    );

    const httpStatus = error instanceof PinchConfigError ? 500 : 502;
    return NextResponse.json({ ok: false, stage }, { status: httpStatus });
  }
}
