import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import {
  DEV_CUSTOMER_CONFIRMATION_LIFETIME_MINUTES,
  toMerchantConfirmationProjection,
  type ConfirmedSchedulePayment,
} from "@/lib/pinch/customer-confirmation";
import {
  createCustomerConfirmation,
  generateCustomerConfirmationId,
  generateCustomerConfirmationToken,
  hashCustomerConfirmationToken,
} from "@/lib/pinch/customer-confirmation-service";
import { validateCustomerConfirmationFlow } from "@/lib/pinch/customer-confirmation-validation";
import { getDevCustomerConfirmationRepository } from "@/lib/pinch/dev-customer-confirmation-store";

/**
 * Development-only customer schedule-confirmation endpoints.
 *
 * POST creates a confirmation request from the exact live Pinch preview
 * already shown on the merchant dashboard (it never calls Pinch itself —
 * the replacement route still performs its own fresh preflight before any
 * mutation) and returns the one-time customer link. The raw token appears
 * only inside customerConfirmationUrl on this single creation response; the
 * store keeps a SHA-256 hash, and no later lookup can recover the token.
 *
 * GET is the merchant status lookup by confirmationId: the safe projection
 * only — never tokenHash, the raw token, source credentials or any Pinch
 * response body — and it never mutates the record.
 *
 * The backing store is process-local sandbox memory (lost on dev-server
 * restart; no database). Answers 404 unless the request arrives directly
 * from localhost in `next dev` — the shared guard in
 * src/lib/dev/localhost-guard.ts.
 */

export const runtime = "nodejs";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ALLOWED_INPUT_KEYS = new Set([
  "merchantId",
  "payerId",
  "sourceId",
  "subscriptionId",
  "planId",
  "currentStartDate",
  "proposedStartDate",
  "currentPayments",
  "proposedPayments",
  "currency",
]);

const ALLOWED_PAYMENT_KEYS = new Set(["paymentDate", "amountInCents"]);

function parsePayments(value: unknown): ConfirmedSchedulePayment[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const payments: ConfirmedSchedulePayment[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      return null;
    }
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_PAYMENT_KEYS.has(key)) {
        return null;
      }
    }
    if (
      typeof entry.paymentDate !== "string" ||
      typeof entry.amountInCents !== "number"
    ) {
      return null;
    }
    payments.push({
      paymentDate: entry.paymentDate,
      amountInCents: entry.amountInCents,
    });
  }
  return payments;
}

interface ParsedCreateInput {
  merchantId: string;
  payerId: string;
  sourceId: string;
  subscriptionId: string;
  planId: string;
  currentStartDate: string;
  proposedStartDate: string;
  currentPayments: ConfirmedSchedulePayment[];
  proposedPayments: ConfirmedSchedulePayment[];
  currency: string;
}

/**
 * JSON-shape validation with a strict key allowlist at both levels; the
 * service performs the semantic validation (dates, counts, amounts,
 * currency, difference from the current schedule).
 */
function parseCreateInput(input: unknown): ParsedCreateInput | null {
  if (!isPlainObject(input)) {
    return null;
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      return null;
    }
  }
  const stringFields = [
    "merchantId",
    "payerId",
    "sourceId",
    "subscriptionId",
    "planId",
    "currentStartDate",
    "proposedStartDate",
    "currency",
  ] as const;
  for (const field of stringFields) {
    if (typeof input[field] !== "string") {
      return null;
    }
  }
  const currentPayments = parsePayments(input.currentPayments);
  const proposedPayments = parsePayments(input.proposedPayments);
  if (currentPayments === null || proposedPayments === null) {
    return null;
  }
  return {
    merchantId: input.merchantId as string,
    payerId: input.payerId as string,
    sourceId: input.sourceId as string,
    subscriptionId: input.subscriptionId as string,
    planId: input.planId as string,
    currentStartDate: input.currentStartDate as string,
    proposedStartDate: input.proposedStartDate as string,
    currentPayments,
    proposedPayments,
    currency: input.currency as string,
  };
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
  const input = parseCreateInput(parsed);
  if (input === null) {
    return NextResponse.json(
      { ok: false, stage: "validation" },
      { status: 400 },
    );
  }

  try {
    // Re-asserts the deterministic confirmation scenarios on every request,
    // mirroring the sibling dev routes.
    await validateCustomerConfirmationFlow();

    const outcome = await createCustomerConfirmation(input, {
      repository: getDevCustomerConfirmationRepository(),
      now: () => new Date().toISOString(),
      generateConfirmationId: generateCustomerConfirmationId,
      generateToken: generateCustomerConfirmationToken,
      hashToken: hashCustomerConfirmationToken,
      lifetimeMinutes: DEV_CUSTOMER_CONFIRMATION_LIFETIME_MINUTES,
    });
    if (!outcome.ok) {
      // The detail is service-generated schema vocabulary, never customer
      // data and never token material.
      return NextResponse.json(
        { ok: false, stage: outcome.reason, detail: outcome.detail },
        { status: outcome.reason === "validation" ? 400 : 500 },
      );
    }

    const projection = toMerchantConfirmationProjection(
      outcome.record,
      new Date().toISOString(),
    );
    // The raw token's single appearance: this one creation response.
    return NextResponse.json({
      ok: true,
      temporaryStore: true,
      confirmationId: projection.confirmationId,
      customerConfirmationUrl: `${request.nextUrl.origin}/confirm/${outcome.rawToken}`,
      status: projection.status,
      currentStartDate: projection.currentStartDate,
      proposedStartDate: projection.proposedStartDate,
      proposedPayments: projection.proposedPayments,
      createdAt: projection.createdAt,
      expiresAt: projection.expiresAt,
    });
  } catch (error) {
    console.error("Dev customer-confirmation creation failed.", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  if (!isDirectLocalhostRequest(request)) {
    return new NextResponse(null, { status: 404 });
  }

  const rawConfirmationId = request.nextUrl.searchParams.get("confirmationId");
  const confirmationId =
    typeof rawConfirmationId === "string" ? rawConfirmationId.trim() : "";
  if (confirmationId === "" || confirmationId.length > 100) {
    return NextResponse.json(
      { ok: false, stage: "validation" },
      { status: 400 },
    );
  }

  try {
    const record = await getDevCustomerConfirmationRepository().readById(
      confirmationId,
    );
    if (record === null) {
      return NextResponse.json(
        { ok: false, stage: "not-found", temporaryStore: true },
        { status: 404 },
      );
    }
    return NextResponse.json({
      ok: true,
      temporaryStore: true,
      confirmation: toMerchantConfirmationProjection(
        record,
        new Date().toISOString(),
      ),
    });
  } catch (error) {
    console.error("Dev customer-confirmation lookup failed.", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
