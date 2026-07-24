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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * Recognises the empirically proven Pinch nonce-replay rejection: repeating
 * POST /payments with an already-used nonce returns HTTP 403 whose JSON body
 * carries `isNonceReplay: true` and the existing payment under `data`, with
 * `data.id` holding the original pmt_ payment ID.
 *
 * Only `data.id` is extracted. The replay body can contain tokenised source
 * details and payer PII, so no other field of it is trusted, kept or logged —
 * the payment fields returned to the caller come solely from the GET
 * read-back that follows.
 *
 * Returns the existing payment ID for a valid replay, else null (in which
 * case the 403 remains an ordinary API failure).
 */
function extractNonceReplayPaymentId(
  upstreamBody: string | undefined,
  nonce: string,
): string | null {
  if (upstreamBody === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(upstreamBody);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || parsed.isNonceReplay !== true) {
    return null;
  }
  const data = parsed.data;
  if (!isPlainObject(data)) {
    return null;
  }
  const paymentId = prefixedId(data.id, "pmt_");
  if (paymentId === null) {
    return null;
  }

  // Every nonce field present in the body must equal the caller-supplied
  // trimmed nonce, and at least one must be present — otherwise the 403 is
  // not proven to be a replay of *this* request.
  const nonceValues = [parsed.stringNonce, parsed.nonce, data.nonce].filter(
    (value) => value !== undefined,
  );
  if (nonceValues.length === 0) {
    return null;
  }
  for (const value of nonceValues) {
    if (typeof value !== "string" || value.trim() !== nonce) {
      return null;
    }
  }
  return paymentId;
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
   * Every source identifier the read response exposes: top-level `sourceId`,
   * nested `source.id`, and `attempts[].source.id` (the location proven by
   * the live sandbox response). Empty when the response exposes none, in
   * which case source verification is skipped rather than inventing a
   * failure. No other shapes are probed.
   */
  sourceIds: string[];
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

  const sourceIds: string[] = [];
  const collectSourceId = (value: unknown): void => {
    if (typeof value === "string" && value.trim() !== "") {
      sourceIds.push(value.trim());
    }
  };
  collectSourceId(record.sourceId);
  if (isPlainObject(record.source)) {
    collectSourceId(record.source.id);
  }
  if (Array.isArray(record.attempts)) {
    for (const attempt of record.attempts) {
      if (isPlainObject(attempt) && isPlainObject(attempt.source)) {
        collectSourceId(attempt.source.id);
      }
    }
  }

  const snapshot: PaymentSnapshot = {
    id,
    payerId,
    amount,
    transactionDate,
    status,
    sourceIds,
  };
  if (typeof description === "string" && description !== "") {
    snapshot.description = description;
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

    // The one and only creation mutation. Never repeated at route level —
    // whatever comes back (success, nonce replay, ambiguity or error), no
    // second POST /payments is ever issued for this request (pinchRequest's
    // single refresh-and-retry after an explicit HTTP 401 is the only
    // permitted retry).
    let paymentId: string;
    let idempotentReplay = false;
    try {
      const created = await pinchRequest<unknown>("payments", {
        method: "POST",
        body: createBody,
        merchantId: input.merchantId,
      });

      const extracted = extractPaymentId(created);
      if (extracted === null) {
        // Upstream reported success, so the payment likely exists; do not
        // retry the POST, as that could schedule a duplicate payment.
        return apiFailure(
          "upstream reported success but no payment ID could be extracted.",
        );
      }
      paymentId = extracted;
    } catch (error) {
      // Proven contract: reusing a nonce returns HTTP 403 with
      // isNonceReplay: true and the existing payment under data. A valid
      // replay resolves to the original payment and flows into the same
      // read-back verification below; a 403 that fails any replay check —
      // and every other error — stays an error via the outer catch.
      const replayPaymentId =
        error instanceof PinchApiError && error.status === 403
          ? extractNonceReplayPaymentId(error.upstreamBody, input.nonce)
          : null;
      if (replayPaymentId === null) {
        throw error;
      }
      paymentId = replayPaymentId;
      idempotentReplay = true;
      console.log(
        "Pinch dev scheduled-payment creation: valid nonce replay detected; verifying the existing payment.",
        { paymentId, merchantId: input.merchantId },
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
      // Verified only when the read response exposed source identifiers:
      // the requested source must then be among them.
      readBack.sourceIds.length > 0 &&
        !readBack.sourceIds.includes(input.sourceId) &&
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
      idempotentReplay,
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

    // Never log upstream response bodies: Pinch error bodies can carry
    // tokenised source details and payer PII. Log only classification
    // fields and safe identifiers already supplied by the caller.
    console.error(
      `Pinch dev scheduled-payment creation failed at stage "${stage}".`,
      {
        errorClass: error instanceof Error ? error.name : "UnknownError",
        upstreamStatus:
          error instanceof PinchAuthError || error instanceof PinchApiError
            ? (error.status ?? "none")
            : "none",
        merchantId: input.merchantId,
        payerId: input.payerId,
      },
    );

    const httpStatus = error instanceof PinchConfigError ? 500 : 502;
    return NextResponse.json({ ok: false, stage }, { status: httpStatus });
  }
}
