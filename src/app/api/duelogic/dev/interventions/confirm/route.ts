import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import { getDevInterventionRepository } from "@/lib/duelogic/dev-intervention-store";
import { toCustomerInterventionProjection } from "@/lib/duelogic/intervention";
import {
  confirmInterventionExecution,
  generateInterventionOperationId,
  hashInterventionToken,
  requireTransactionVerification,
  type InterventionReplacementPathRequest,
  type InterventionReplacementPathResult,
} from "@/lib/duelogic/intervention-service";
import { createEmptyDevTransactionVerificationRepository } from "@/lib/duelogic/transaction-verification";
import { DEV_CUSTOMER_CONFIRMATION_LIFETIME_MINUTES } from "@/lib/pinch/customer-confirmation";
import {
  generateCustomerConfirmationId,
  generateCustomerConfirmationToken,
  hashCustomerConfirmationToken,
} from "@/lib/pinch/customer-confirmation-service";
import { getDevCustomerConfirmationRepository } from "@/lib/pinch/dev-customer-confirmation-store";

/**
 * Stage 2 development endpoint: the customer's final confirmation on the
 * tokenised review page. Wiring only — and GATED: possession of the token
 * alone never reaches execution. The route first requires a valid verified
 * transaction-verification record bound to the exact intervention and
 * schedule (requireTransactionVerification); without one it refuses with
 * "verification-required", creating no confirmation, generating no
 * operation, calling no protected path and no Pinch endpoint, and changing
 * no intervention execution state. No write path for verification records
 * exists yet (the development repository is deliberately empty), so this
 * route currently always refuses; the later OTP stage creates the records
 * that satisfy the gate.
 *
 * Only after the gate passes does confirmInterventionExecution run, and
 * execution itself happens in the existing protected replacement route,
 * invoked over localhost exactly as the merchant panel invokes it,
 * completely unchanged: it performs its own fresh Pinch preflight,
 * confirmation verification and consumption, recovery-record write,
 * cancellation, creation and verification, and never retries a mutation.
 *
 * The browser supplies nothing but the token; every identity, date and
 * amount comes from the server-held intervention record. Responses carry
 * the customer-safe projection only — no merchant, payer, source,
 * subscription, plan or operation IDs, no reason codes and no token
 * material.
 *
 * Answers 404 unless the request arrives directly from localhost in
 * `next dev` — the shared guard in src/lib/dev/localhost-guard.ts.
 */

export const runtime = "nodejs";

/**
 * The protected replacement route's confirmation contract (the same phrase
 * the merchant replacement panel submits). Sending it weakens no
 * server-side check: the route still independently verifies and consumes
 * the server-held customer confirmation record.
 */
const CONFIRMATION_PHRASE = "REPLACE FUTURE SCHEDULE";

/** Route stages that mean mutation began: failure now needs manual recovery. */
const MANUAL_RECOVERY_STAGES = new Set([
  "cancel-verification",
  "replacement-create",
  "replacement-ambiguous",
  "replacement-verification",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Invokes the existing protected replacement route once over localhost and
 * interprets its response. A network failure or unreadable body is
 * "unknown": a mutation may have been issued, so the caller treats it as
 * conservatively as manual recovery and never resubmits.
 */
function buildProtectedPathExecutor(origin: string) {
  return async (
    request: InterventionReplacementPathRequest,
  ): Promise<InterventionReplacementPathResult> => {
    let response: Response;
    let body: unknown;
    try {
      response = await fetch(`${origin}/api/pinch/dev/subscription-replacement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          merchantId: request.merchantId,
          payerId: request.payerId,
          sourceId: request.sourceId,
          subscriptionId: request.subscriptionId,
          proposedStartDate: request.proposedStartDate,
          operationId: request.operationId,
          confirmationId: request.confirmationId,
          confirmation: CONFIRMATION_PHRASE,
          // The exact stored Pinch-preview schedule — never locally derived.
          confirmedPayments: request.confirmedPayments.map((payment) => ({
            transactionDate: payment.paymentDate,
            amountCents: payment.amountInCents,
          })),
        }),
      });
      body = await response.json().catch(() => null);
    } catch {
      return { kind: "unknown" };
    }
    if (response.ok && isRecord(body) && body.ok === true) {
      const newSubscriptionId =
        isRecord(body.newSubscription) &&
        typeof body.newSubscription.id === "string" &&
        body.newSubscription.id.startsWith("sub_")
          ? body.newSubscription.id
          : null;
      // A success response without a readable subscription ID is unknown —
      // the mutation happened but cannot be recorded verifiably.
      return newSubscriptionId === null
        ? { kind: "unknown" }
        : { kind: "verified", newSubscriptionId };
    }
    const stage =
      isRecord(body) && typeof body.stage === "string" ? body.stage : null;
    if (stage === null) {
      return { kind: "unknown" };
    }
    if (MANUAL_RECOVERY_STAGES.has(stage)) {
      return {
        kind: "manual-recovery",
        stage,
        newSubscriptionId:
          isRecord(body) && typeof body.newSubscriptionId === "string"
            ? body.newSubscriptionId
            : null,
      };
    }
    // Every other stage is a pre-mutation refusal: the protected route
    // reports the original subscription untouched.
    return { kind: "refused", stage };
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
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).some((key) => key !== "token") ||
    typeof parsed.token !== "string" ||
    parsed.token.trim() === "" ||
    parsed.token.length > 200
  ) {
    return NextResponse.json(
      { ok: false, stage: "validation" },
      { status: 400 },
    );
  }
  const token = parsed.token;

  try {
    const interventionRepository = getDevInterventionRepository();
    const nowClock = () => new Date().toISOString();

    // The mandatory transaction-verification gate. The development
    // verification repository is deliberately empty (no write path exists
    // anywhere), so this refuses every request today; execution below is
    // reachable only once the later OTP stage creates verified records.
    const gate = await requireTransactionVerification(
      { token },
      {
        repository: interventionRepository,
        verifications: createEmptyDevTransactionVerificationRepository(),
        now: nowClock,
        hashToken: hashInterventionToken,
      },
    );
    if (!gate.ok) {
      if (gate.reason === "not-found") {
        // Generic wording: reveals nothing about other interventions.
        return NextResponse.json(
          { ok: false, stage: "not-found" },
          { status: 404 },
        );
      }
      return NextResponse.json(
        {
          ok: false,
          stage: "verification-required",
          ...(gate.record !== undefined
            ? {
                intervention: toCustomerInterventionProjection(
                  gate.record,
                  nowClock(),
                ),
              }
            : {}),
        },
        { status: 409 },
      );
    }

    const outcome = await confirmInterventionExecution(
      { token },
      {
        repository: interventionRepository,
        now: () => new Date().toISOString(),
        hashToken: hashInterventionToken,
        generateOperationId: generateInterventionOperationId,
        confirmationDeps: {
          repository: getDevCustomerConfirmationRepository(),
          now: () => new Date().toISOString(),
          generateConfirmationId: generateCustomerConfirmationId,
          generateToken: generateCustomerConfirmationToken,
          hashToken: hashCustomerConfirmationToken,
          lifetimeMinutes: DEV_CUSTOMER_CONFIRMATION_LIFETIME_MINUTES,
        },
        executeReplacementPath: buildProtectedPathExecutor(
          request.nextUrl.origin,
        ),
      },
    );

    const nowIso = new Date().toISOString();
    if (outcome.ok) {
      return NextResponse.json({
        ok: true,
        intervention: toCustomerInterventionProjection(outcome.record, nowIso),
      });
    }
    if (outcome.reason === "not-found") {
      // Generic wording: reveals nothing about other interventions.
      return NextResponse.json(
        { ok: false, stage: "not-found" },
        { status: 404 },
      );
    }
    const httpStatus =
      outcome.reason === "store" || outcome.reason === "confirmation-failed"
        ? 500
        : outcome.reason === "manual-recovery-required" ||
            outcome.reason === "refused"
          ? 502
          : 409;
    return NextResponse.json(
      {
        ok: false,
        stage: outcome.reason,
        ...(outcome.record !== undefined
          ? {
              intervention: toCustomerInterventionProjection(
                outcome.record,
                nowIso,
              ),
            }
          : {}),
      },
      { status: httpStatus },
    );
  } catch (error) {
    // Safe classification only — never bodies, tokens or identifiers
    // beyond what the log line names.
    console.error("Dev intervention confirm failed unexpectedly.", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ ok: false, stage: "api" }, { status: 500 });
  }
}
