import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import {
  PinchApiError,
  PinchAuthError,
  PinchConfigError,
  pinchRequest,
} from "@/lib/pinch/client";
import { getDevReplacementOperationRepository } from "@/lib/pinch/dev-replacement-operation-store";
import type {
  SubscriptionReinstatementCreateBody,
  SubscriptionReplacementRecoverySnapshot,
} from "@/lib/pinch/replacement-operation";
import {
  executeSubscriptionReplacement,
  type ReplacementExecutionEffects,
} from "@/lib/pinch/replacement-operation-flow";

/**
 * Development-only endpoint that proves permanent recurring schedule
 * correction: it cancels one active Pinch subscription and recreates it
 * against the same plan, payer and source with a new start date.
 *
 * The two mutations (DELETE then POST) are not atomic. Each is issued at
 * most once per request — never retried after any response or ambiguity —
 * and every failure after the original subscription is cancelled reports a
 * manual-recovery state instead of guessing. Before the DELETE is issued, an
 * audit/recovery operation record (including the exact reinstatement payload)
 * must be written and read back through the replacement-operation store; a
 * failed write aborts with no mutation. The mutation sequence itself runs in
 * src/lib/pinch/replacement-operation-flow.ts. This is localhost-only proof
 * code, not a production transaction coordinator: the backing store is
 * process-local sandbox memory, so production needs a durable
 * SubscriptionReplacementOperationRepository before executing a replacement.
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
    // Phase 2: recovery-snapshot inputs — still read-only.
    // -----------------------------------------------------------------
    // The ORIGINAL schedule (original start date), so the recovery record
    // preserves what a reinstated subscription would look like for human
    // checking. Never computed locally: Pinch recalculates it.
    const originalScheduleParams: Record<string, string | number> = {
      startDate: subscription.startDate,
    };
    if (plan.requiresTotalAmount && subscription.totalAmountCents !== undefined) {
      originalScheduleParams.totalAmount = subscription.totalAmountCents;
    }
    const originalCalculated = extractCalculatedPayments(
      await pinchRequest<unknown>(calculatedPaymentsPath, {
        merchantId: input.merchantId,
        searchParams: originalScheduleParams,
      }),
    );
    if (originalCalculated === null) {
      return apiFailure(
        "original-schedule calculated-payments response could not be interpreted safely.",
        logContext,
      );
    }
    const originalCalculatedPayments = orderCalculatedPayments(originalCalculated)
      .slice(0, 3)
      .map((payment) => ({
        transactionDate: payment.transactionDate,
        amountCents: payment.amountCents,
      }));

    // The exact payload POST /subscriptions would receive to reinstate the
    // original subscription — the same field allowlist as the replacement
    // body, with the original start date.
    const reinstatementCreateBody: SubscriptionReinstatementCreateBody = {
      planId: subscription.planId,
      payerId: input.payerId,
      sourceId: subscription.sourceId ?? input.sourceId,
      startDate: subscription.startDate,
    };
    if (plan.requiresTotalAmount && subscription.totalAmountCents !== undefined) {
      reinstatementCreateBody.totalAmount = subscription.totalAmountCents;
    }

    const recoverySnapshot: SubscriptionReplacementRecoverySnapshot = {
      merchantId: input.merchantId,
      payerId: input.payerId,
      sourceId: reinstatementCreateBody.sourceId,
      planId: subscription.planId,
      originalStartDate: subscription.startDate,
      ...(plan.requiresTotalAmount && subscription.totalAmountCents !== undefined
        ? { totalAmountCents: subscription.totalAmountCents }
        : {}),
      oldSubscriptionId: input.subscriptionId,
      reinstatementCreateBody,
      originalCalculatedPayments,
    };

    // The one and only POST /subscriptions body, built explicitly with only
    // the four (or five) allowed fields. No merchantId, no old subscription
    // ID, no operation metadata, no surcharge — the sandbox subscription
    // has no surcharge selected, so omitting it preserves the proven setup.
    const createBody: Record<string, unknown> = {
      planId: subscription.planId,
      payerId: input.payerId,
      sourceId: input.sourceId,
      startDate: input.proposedStartDate,
    };
    if (plan.requiresTotalAmount && subscription.totalAmountCents !== undefined) {
      createBody.totalAmount = subscription.totalAmountCents;
    }

    const requiredTotalAmountCents =
      plan.requiresTotalAmount && subscription.totalAmountCents !== undefined
        ? subscription.totalAmountCents
        : null;

    // -----------------------------------------------------------------
    // Phases 3-5: write-before-cancel, DELETE, POST and verification all
    // run in the shared replacement-operation flow
    // (src/lib/pinch/replacement-operation-flow.ts), which refuses to
    // issue the DELETE until the operation record — with the recovery
    // snapshot — has been written and read back, and never retries an
    // effect. Each effect below issues its Pinch call at most once.
    // -----------------------------------------------------------------
    const effects: ReplacementExecutionEffects = {
      cancelOriginal: async () => {
        await pinchRequest<unknown>(subscriptionPath, {
          method: "DELETE",
          merchantId: input.merchantId,
        });
      },
      readOriginalStatus: async () =>
        extractSubscriptionStatus(
          await pinchRequest<unknown>(subscriptionPath, {
            merchantId: input.merchantId,
          }),
        ),
      createReplacement: async () =>
        pinchRequest<unknown>("subscriptions", {
          method: "POST",
          body: createBody,
          merchantId: input.merchantId,
        }),
      verifyReplacement: async (newSubscriptionId) => {
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
        if (readBack === null || recalculated === null) {
          return null;
        }
        const ordered = orderCalculatedPayments(recalculated);
        const verified =
          readBack.id === newSubscriptionId &&
          readBack.payerId === input.payerId &&
          readBack.planId === subscription.planId &&
          readBack.status.toLowerCase() === "active" &&
          readBack.startDate === input.proposedStartDate &&
          scheduleMatchesConfirmation(ordered, input.confirmedPayments);
        if (!verified) {
          return null;
        }
        const firstPayments = ordered.slice(0, input.confirmedPayments.length);
        return {
          oldSubscriptionId: input.subscriptionId,
          newSubscriptionId,
          verifiedStartDate: readBack.startDate,
          planId: readBack.planId,
          payerId: readBack.payerId,
          ...(readBack.sourceId !== undefined
            ? { sourceId: readBack.sourceId }
            : {}),
          paymentDates: firstPayments.map((payment) => payment.transactionDate),
          paymentAmountsCents: firstPayments.map(
            (payment) => payment.amountCents,
          ),
        };
      },
    };

    const result = await executeSubscriptionReplacement(
      {
        operationId: input.operationId,
        merchantId: input.merchantId,
        payerId: input.payerId,
        planId: subscription.planId,
        sourceId: input.sourceId,
        oldSubscriptionId: input.subscriptionId,
        previousStartDate: subscription.startDate,
        requestedStartDate: input.proposedStartDate,
        previousTotalAmountCents: requiredTotalAmountCents,
        requestedTotalAmountCents: requiredTotalAmountCents,
        recoverySnapshot,
      },
      getDevReplacementOperationRepository(),
      effects,
      () => new Date().toISOString(),
      (message, context) => console.error(message, context),
    );

    if (result.outcome === "recovery-record-failed") {
      // Nothing was mutated: the flow never issues the DELETE unless the
      // recovery record was written and read back successfully.
      console.error(
        'Pinch dev subscription-replacement refused at stage "recovery-record": the operation record could not be written and read back, so no mutation was issued.',
        logContext,
      );
      return NextResponse.json(
        {
          ok: false,
          stage: "recovery-record",
          operationId: input.operationId,
          oldSubscriptionId: input.subscriptionId,
          originalSubscriptionUntouched: true,
        },
        { status: 500 },
      );
    }
    if (result.outcome === "cancel-verification-failed") {
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
    if (result.outcome === "replacement-create-failed") {
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
    if (result.outcome === "replacement-ambiguous") {
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
    if (result.outcome === "replacement-verification-failed") {
      logContext.newSubscriptionId =
        result.record.newSubscriptionId ?? undefined;
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
          newSubscriptionId: result.record.newSubscriptionId,
          requiresManualReview: true,
        },
        { status: 502 },
      );
    }

    // result.outcome === "replacement-verified": the completed record now
    // holds the permanent old-to-new subscription mapping.
    logContext.newSubscriptionId = result.record.newSubscriptionId ?? undefined;

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
        id: result.record.newSubscriptionId,
        planId: subscription.planId,
        startDate: input.proposedStartDate,
        status: "active",
      },
      confirmedPayments: input.confirmedPayments,
    });
  } catch (error) {
    // The replacement-operation flow contains its own error handling and
    // never rethrows once mutation has begun (its safety net converts an
    // unexpected escape into a manual-recovery outcome), so this catch
    // fires only during read-only preflight.
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
