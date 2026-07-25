import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import { getDevInterventionRepository } from "@/lib/duelogic/dev-intervention-store";
import {
  generateTransactionVerificationId,
  getDevTransactionVerificationRepository,
  parseRehearsalVerificationSeedInput,
  seedRehearsalTransactionVerification,
} from "@/lib/duelogic/dev-transaction-verification-store";
import { toCustomerInterventionProjection } from "@/lib/duelogic/intervention";
import { hashInterventionToken } from "@/lib/duelogic/intervention-service";
import { getDevMerchantPolicyRepository } from "@/lib/duelogic/policy/dev-policy-store";

/**
 * Controlled rehearsal seeding endpoint: creates the ONE transaction-
 * verification record for a preview-ready intervention so a later
 * controlled sandbox execution can pass the verification gate. Temporary
 * rehearsal infrastructure only — the final SMS/OTP implementation
 * replaces this creation surface with a verified code-entry path behind
 * the same claim contract.
 *
 * The browser supplies exactly `{ token }` (the existing customer review
 * token); every binding value — identity, selected date, exact schedules,
 * amounts and the bound policyVersion — is constructed server-side from
 * the trusted stored intervention. Records expire 10 minutes after
 * creation, are write-once per intervention, and a second attempt refuses
 * without replacing or extending the first record. Seeding performs no
 * Pinch call and no execution: the confirmation route's atomic claim
 * remains the only path toward execution.
 *
 * The response is safe content only: ok, stage, the verification expiry
 * and the customer-safe projection — never the raw token, verificationId,
 * merchant/payer/subscription IDs, the verification record or policy
 * internals.
 *
 * Answers 404 unless the request arrives directly from localhost in
 * `next dev` — the shared guard in src/lib/dev/localhost-guard.ts.
 */

export const runtime = "nodejs";

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
  const input = parseRehearsalVerificationSeedInput(parsed);
  if (input === null) {
    return NextResponse.json(
      { ok: false, stage: "validation" },
      { status: 400 },
    );
  }

  try {
    const outcome = await seedRehearsalTransactionVerification(input, {
      interventions: getDevInterventionRepository(),
      verifications: getDevTransactionVerificationRepository(),
      policies: await getDevMerchantPolicyRepository(),
      now: () => new Date().toISOString(),
      hashToken: hashInterventionToken,
      generateVerificationId: generateTransactionVerificationId,
    });

    const nowIso = new Date().toISOString();
    if (outcome.ok) {
      return NextResponse.json({
        ok: true,
        stage: "verification-seeded",
        temporaryStore: true,
        verificationExpiresAt: outcome.verification.expiresAt,
        // Projected WITH the just-created record so the response honestly
        // shows the final confirmation is now enabled for the customer.
        intervention: toCustomerInterventionProjection(
          outcome.record,
          nowIso,
          outcome.verification,
        ),
      });
    }
    if (outcome.reason === "not-found") {
      // Generic wording: reveals nothing about other interventions.
      return NextResponse.json(
        { ok: false, stage: "not-found" },
        { status: 404 },
      );
    }
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
      { status: outcome.reason === "store" ? 500 : 409 },
    );
  } catch (error) {
    // Safe classification only — never values, tokens or record content.
    console.error("Dev rehearsal verification seeding failed.", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ ok: false, stage: "api" }, { status: 500 });
  }
}
