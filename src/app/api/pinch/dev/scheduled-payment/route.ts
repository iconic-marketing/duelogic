import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import {
  PinchApiError,
  PinchAuthError,
  PinchConfigError,
  pinchRequest,
} from "@/lib/pinch/client";

/**
 * Development-only endpoint that creates a *scheduled* Pinch payment under a
 * managed merchant and reads it back to verify what was created.
 * Answers 404 unless the request arrives directly from localhost in
 * `next dev` — the shared guard in src/lib/dev/localhost-guard.ts.
 */

export const runtime = "nodejs";

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
 * Normalises a Pinch transactionDate to its YYYY-MM-DD calendar date.
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

/** Trimmed non-empty string carrying the expected Pinch ID prefix, else null. */
function prefixedId(value: unknown, prefix: string): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.startsWith(prefix) && trimmed !== "" ? trimmed : null;
}

interface ValidatedInput {
  /**
   * Passed only via the pinchRequest option (the Current-Merchant header),
   * never in the JSON body sent to Pinch. Required here: scheduled-payment
   * creation always operates under a managed merchant.
   */
  merchantId: string;
  payerId: string;
  sourceId: string;
  /** Integer cents — no dollar field exists and no conversion is performed. */
  amountCents: number;
  transactionDate: string;
  /** Caller-supplied replay-protection nonce. Never generated server-side. */
  nonce: string;
  description?: string;
}

/**
 * Builds the validated input by explicit whitelisting: only the seven known
 * fields are ever read, and a brand-new object is constructed, so unexpected
 * caller fields are never forwarded to Pinch. Returns null on any invalid
 * field.
 */
function validateInput(input: unknown): ValidatedInput | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const {
    merchantId,
    payerId,
    sourceId,
    amountCents,
    transactionDate,
    nonce,
    description,
  } = input as Record<string, unknown>;

  const validMerchantId = prefixedId(merchantId, "mch_");
  const validPayerId = prefixedId(payerId, "pyr_");
  const validSourceId = prefixedId(sourceId, "src_");
  if (
    validMerchantId === null ||
    validPayerId === null ||
    validSourceId === null
  ) {
    return null;
  }
  if (
    typeof amountCents !== "number" ||
    !Number.isInteger(amountCents) ||
    amountCents <= 0
  ) {
    return null;
  }
  if (
    typeof transactionDate !== "string" ||
    !isRealCalendarDate(transactionDate)
  ) {
    return null;
  }
  if (typeof nonce !== "string" || nonce.trim() === "") {
    return null;
  }

  const validated: ValidatedInput = {
    merchantId: validMerchantId,
    payerId: validPayerId,
    sourceId: validSourceId,
    amountCents,
    transactionDate,
    nonce: nonce.trim(),
  };
  if (description !== undefined) {
    if (typeof description !== "string") {
      return null;
    }
    // A description that trims to nothing is treated as not supplied.
    if (description.trim() !== "") {
      validated.description = description.trim();
    }
  }
  return validated;
}

/**
 * The creation response may be a full payment object or a bare ID string
 * (the Pinch client already tolerates plain-text success bodies).
 */
function extractPaymentId(result: unknown): string | null {
  if (typeof result === "string") {
    const trimmed = result.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const id = (result as { id?: unknown }).id;
    if (typeof id === "string" && id.trim() !== "") {
      return id.trim();
    }
  }
  return null;
}

/**
 * The documented GET /payments/{id} response fields this route relies on.
 * The payer ID is nested at payer.id — the payment object has no top-level
 * payerId field.
 */
interface PaymentSnapshot {
  id: string;
  payerId: string;
  amount: number;
  transactionDate: string;
  description?: string;
  status: string;
  /**
   * Present only when the read response exposes a source identifier — a
   * top-level `sourceId` string or a nested `source.id`. The documented
   * shape verified elsewhere does not include one, so source identity is
   * checked opportunistically rather than assuming a response shape.
   */
  sourceId?: string;
}

function extractPayment(result: unknown): PaymentSnapshot | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return null;
  }
  const record = result as Record<string, unknown>;
  const { id, amount, transactionDate, status, description, payer } = record;

  if (typeof id !== "string" || id.trim() === "") {
    return null;
  }
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return null;
  }
  if (typeof transactionDate !== "string" || calendarDateOf(transactionDate) === null) {
    return null;
  }
  if (typeof status !== "string" || status.trim() === "") {
    return null;
  }
  if (typeof payer !== "object" || payer === null || Array.isArray(payer)) {
    return null;
  }
  const payerId = (payer as Record<string, unknown>).id;
  if (typeof payerId !== "string" || payerId.trim() === "") {
    return null;
  }

  const snapshot: PaymentSnapshot = {
    id,
    payerId,
    amount,
    transactionDate,
    status,
  };
  if (typeof description === "string" && description !== "") {
    snapshot.description = description;
  }

  const rawSourceId = record.sourceId;
  if (typeof rawSourceId === "string" && rawSourceId.trim() !== "") {
    snapshot.sourceId = rawSourceId.trim();
  } else if (
    typeof record.source === "object" &&
    record.source !== null &&
    !Array.isArray(record.source)
  ) {
    const nestedId = (record.source as Record<string, unknown>).id;
    if (typeof nestedId === "string" && nestedId.trim() !== "") {
      snapshot.sourceId = nestedId.trim();
    }
  }
  return snapshot;
}

function apiFailure(reason: string): NextResponse {
  console.error(
    `Pinch dev scheduled-payment creation failed at stage "api": ${reason}`,
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

  try {
    // Built explicitly with the Pinch API field names. merchantId is never
    // placed in this body — it travels only as the Current-Merchant header
    // via the pinchRequest option.
    const createBody: Record<string, unknown> = {
      payerId: input.payerId,
      sourceId: input.sourceId,
      // Pinch amounts are integer cents end-to-end; amountCents is sent as-is.
      amount: input.amountCents,
      transactionDate: input.transactionDate,
      nonce: input.nonce,
    };
    if (input.description !== undefined) {
      createBody.description = input.description;
    }

    // The one and only creation mutation. Never retried at route level — an
    // ambiguous result fails below instead of POSTing again (pinchRequest's
    // single refresh-and-retry after an explicit HTTP 401 is the only
    // permitted retry).
    const created = await pinchRequest<unknown>("payments", {
      method: "POST",
      body: createBody,
      merchantId: input.merchantId,
    });

    const paymentId = extractPaymentId(created);
    if (paymentId === null) {
      // Upstream reported success, so the payment likely exists; do not
      // retry the POST, as that could schedule a duplicate payment.
      return apiFailure(
        "upstream reported success but no payment ID could be extracted.",
      );
    }

    const readBack = extractPayment(
      await pinchRequest<unknown>(
        `payments/${encodeURIComponent(paymentId)}`,
        { merchantId: input.merchantId },
      ),
    );
    if (readBack === null) {
      return apiFailure("read-back response did not match the documented shape.");
    }

    const failedChecks = [
      readBack.id !== paymentId && "payment ID does not match",
      readBack.payerId !== input.payerId && "payer does not match",
      readBack.amount !== input.amountCents && "amount does not match",
      calendarDateOf(readBack.transactionDate) !== input.transactionDate &&
        "transaction date does not match",
      readBack.status.toLowerCase() !== "scheduled" &&
        `status is "${readBack.status}", not scheduled`,
      // Verified only when the read response exposed a source identifier.
      readBack.sourceId !== undefined &&
        readBack.sourceId !== input.sourceId &&
        "source does not match",
    ].filter((check): check is string => typeof check === "string");

    if (failedChecks.length > 0) {
      return apiFailure(
        `read-back verification failed: ${failedChecks.join("; ")}.`,
      );
    }

    const responseBody: Record<string, unknown> = {
      ok: true,
      paymentId,
      merchantId: input.merchantId,
      payerId: input.payerId,
      sourceId: input.sourceId,
      amountCents: input.amountCents,
      transactionDate: input.transactionDate,
      status: readBack.status,
      nonce: input.nonce,
    };
    if (input.description !== undefined) {
      responseBody.description = input.description;
    }
    return NextResponse.json(responseBody);
  } catch (error) {
    const stage =
      error instanceof PinchAuthError || error instanceof PinchConfigError
        ? "auth"
        : "api";

    // Dev-only, localhost-only route: log the full upstream error body to
    // the local console for debugging. It never enters the HTTP response.
    console.error(
      `Pinch dev scheduled-payment creation failed at stage "${stage}".`,
      {
        errorClass: error instanceof Error ? error.name : "UnknownError",
        upstreamStatus:
          error instanceof PinchAuthError || error instanceof PinchApiError
            ? (error.status ?? "none")
            : "none",
        upstreamBody:
          error instanceof PinchApiError
            ? (error.upstreamBody ?? "none")
            : "none",
      },
    );

    const httpStatus = error instanceof PinchConfigError ? 500 : 502;
    return NextResponse.json({ ok: false, stage }, { status: httpStatus });
  }
}
