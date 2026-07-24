import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import {
  PinchApiError,
  PinchAuthError,
  PinchConfigError,
  pinchRequest,
} from "@/lib/pinch/client";

/**
 * Development-only endpoint that moves the transaction date of an existing
 * *scheduled* Pinch payment and reads it back to verify the change.
 * Answers 404 unless the request arrives directly from localhost in
 * `next dev` — the shared guard in src/lib/dev/localhost-guard.ts.
 */

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

interface ValidatedInput {
  paymentId: string;
  transactionDate: string;
  /**
   * Passed only via the pinchRequest option (the Current-Merchant header),
   * never in the JSON body sent to Pinch. Undefined = single-merchant.
   */
  merchantId?: string;
}

function validateInput(input: unknown): ValidatedInput | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const { paymentId, transactionDate, merchantId } = input as Record<
    string,
    unknown
  >;
  if (typeof paymentId !== "string" || paymentId.trim() === "") {
    return null;
  }
  if (typeof transactionDate !== "string" || !isRealCalendarDate(transactionDate)) {
    return null;
  }
  const validated: ValidatedInput = {
    paymentId: paymentId.trim(),
    transactionDate,
  };
  if (merchantId !== undefined) {
    if (typeof merchantId !== "string" || merchantId.trim() === "") {
      return null;
    }
    validated.merchantId = merchantId.trim();
  }
  return validated;
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
  return snapshot;
}

function apiFailure(reason: string): NextResponse {
  console.error(`Pinch dev payment-date update failed at stage "api": ${reason}`);
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

  const paymentPath = `payments/${encodeURIComponent(input.paymentId)}`;

  try {
    const before = extractPayment(
      await pinchRequest<unknown>(paymentPath, {
        merchantId: input.merchantId,
      }),
    );
    if (before === null) {
      return apiFailure("existing payment response did not match the documented shape.");
    }
    if (before.id !== input.paymentId) {
      return apiFailure("existing payment response ID did not match the requested payment.");
    }
    if (before.status.toLowerCase() !== "scheduled") {
      return apiFailure(`payment is not updatable: status is "${before.status}".`);
    }

    const previousTransactionDate = calendarDateOf(before.transactionDate);

    // Documented update contract: POST /payments with the existing id plus
    // the required payerId/amount/transactionDate, preserving everything but
    // the date. Built explicitly — caller fields are never forwarded.
    const updateBody: Record<string, unknown> = {
      id: before.id,
      payerId: before.payerId,
      amount: before.amount,
      transactionDate: input.transactionDate,
    };
    if (before.description !== undefined) {
      updateBody.description = before.description;
    }

    // Issued exactly once. The response shape is deliberately ignored — the
    // read-back GET below is the source of truth, so an unexpected success
    // shape never triggers a second POST.
    await pinchRequest<unknown>("payments", {
      method: "POST",
      body: updateBody,
      merchantId: input.merchantId,
    });

    const after = extractPayment(
      await pinchRequest<unknown>(paymentPath, {
        merchantId: input.merchantId,
      }),
    );
    if (after === null) {
      return apiFailure("read-back response did not match the documented shape.");
    }

    const failedChecks = [
      after.id !== input.paymentId && "payment ID changed",
      calendarDateOf(after.transactionDate) !== input.transactionDate &&
        "transaction date does not match the requested date",
      after.status.toLowerCase() !== "scheduled" && "status is no longer scheduled",
      after.amount !== before.amount && "amount changed",
      after.payerId !== before.payerId && "payer changed",
    ].filter((check): check is string => typeof check === "string");

    if (failedChecks.length > 0) {
      return apiFailure(`read-back verification failed: ${failedChecks.join("; ")}.`);
    }

    return NextResponse.json({
      ok: true,
      paymentId: after.id,
      previousTransactionDate,
      transactionDate: input.transactionDate,
      status: after.status,
    });
  } catch (error) {
    const stage =
      error instanceof PinchAuthError || error instanceof PinchConfigError
        ? "auth"
        : "api";

    // Never log upstream response bodies: Pinch error bodies can carry
    // tokenised source details and payer PII. Log only classification
    // fields and the safe payment identifier already supplied by the caller.
    console.error(`Pinch dev payment-date update failed at stage "${stage}".`, {
      errorClass: error instanceof Error ? error.name : "UnknownError",
      upstreamStatus:
        error instanceof PinchAuthError || error instanceof PinchApiError
          ? (error.status ?? "none")
          : "none",
      paymentId: input.paymentId,
    });

    const httpStatus = error instanceof PinchConfigError ? 500 : 502;
    return NextResponse.json({ ok: false, stage }, { status: httpStatus });
  }
}
