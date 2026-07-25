import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import { getDevInterventionRepository } from "@/lib/duelogic/dev-intervention-store";
import { getDevOtpChallengeRepository } from "@/lib/duelogic/dev-otp-store";
import { getDevSmsStore } from "@/lib/duelogic/dev-sms-store";
import { getDevTransactionVerificationRepository, generateTransactionVerificationId } from "@/lib/duelogic/dev-transaction-verification-store";
import { toCustomerInterventionProjection } from "@/lib/duelogic/intervention";
import { hashInterventionToken } from "@/lib/duelogic/intervention-service";
import {
  generateDevSmsId,
  generateOtpChallengeId,
  generateSecureOtpCodeNumber,
  verifyInterventionOtp,
} from "@/lib/duelogic/otp-service";
import { getDevMerchantPolicyRepository } from "@/lib/duelogic/policy/dev-policy-store";
import { pinchRequest } from "@/lib/pinch/client";

/**
 * Barebones OTP verify endpoint (hackathon demo path): checks the entered
 * six-digit code against the intervention's current challenge and — on
 * success — creates the EXISTING TransactionVerificationRecord, which is
 * what turns finalConfirmationEnabled true. Final confirmation remains a
 * completely separate customer action behind the unchanged atomic claim:
 * this route never invokes confirmation, execution, the protected
 * replacement path or any mutating Pinch endpoint.
 *
 * The browser supplies exactly `{ token, code }` (six numeric digits);
 * the trusted mobile is re-read server-side (Pinch GET) so a changed or
 * removed mobile invalidates the outstanding challenge through its
 * fingerprint binding. Responses carry safe stages and the customer-safe
 * projection only — never the code, digests, challenge IDs or the full
 * mobile. A missing DUELOGIC_OTP_HMAC_SECRET fails closed.
 *
 * Answers 404 unless the request arrives directly from localhost in
 * `next dev` — the shared guard in src/lib/dev/localhost-guard.ts.
 */

export const runtime = "nodejs";

const OTP_CODE_PATTERN = /^\d{6}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read-only Pinch GET: the payer's mobileNumber, or null when absent. */
async function readPayerMobile(
  merchantId: string,
  payerId: string,
): Promise<string | null> {
  const result = await pinchRequest<unknown>(
    `payers/${encodeURIComponent(payerId)}`,
    { merchantId },
  );
  if (!isRecord(result)) {
    return null;
  }
  const mobile = result.mobileNumber;
  return typeof mobile === "string" && mobile.trim() !== ""
    ? mobile.trim()
    : null;
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
    Object.keys(parsed).some((key) => key !== "token" && key !== "code") ||
    typeof parsed.token !== "string" ||
    parsed.token.trim() === "" ||
    parsed.token.length > 200 ||
    typeof parsed.code !== "string" ||
    !OTP_CODE_PATTERN.test(parsed.code)
  ) {
    return NextResponse.json(
      { ok: false, stage: "validation" },
      { status: 400 },
    );
  }

  try {
    const outcome = await verifyInterventionOtp(
      { token: parsed.token, code: parsed.code },
      {
        interventions: getDevInterventionRepository(),
        verifications: getDevTransactionVerificationRepository(),
        policies: await getDevMerchantPolicyRepository(),
        challenges: getDevOtpChallengeRepository(),
        sms: getDevSmsStore(),
        readPayerMobile,
        now: () => new Date().toISOString(),
        hashToken: hashInterventionToken,
        otpHmacSecret: () => process.env.DUELOGIC_OTP_HMAC_SECRET ?? null,
        generateChallengeId: generateOtpChallengeId,
        generateSmsId: generateDevSmsId,
        generateVerificationId: generateTransactionVerificationId,
        generateOtpCodeNumber: generateSecureOtpCodeNumber,
      },
    );

    const nowIso = new Date().toISOString();
    if (outcome.ok) {
      // Projected WITH the just-created verification record so the
      // response honestly shows the final confirmation is now enabled.
      return NextResponse.json({
        ok: true,
        stage: "otp-verified",
        temporaryStore: true,
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
    const httpStatus =
      outcome.reason === "configuration-error" ||
      outcome.reason === "verification-store-failed"
        ? 500
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
    // Safe classification only — never codes, secrets or record content.
    console.error("Dev intervention OTP verify failed unexpectedly.", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ ok: false, stage: "api" }, { status: 500 });
  }
}
