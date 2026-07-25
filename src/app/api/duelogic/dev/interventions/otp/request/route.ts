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
  requestInterventionOtp,
} from "@/lib/duelogic/otp-service";
import { getDevMerchantPolicyRepository } from "@/lib/duelogic/policy/dev-policy-store";
import { pinchRequest } from "@/lib/pinch/client";

/**
 * Barebones OTP request endpoint (hackathon demo path): issues one
 * six-digit challenge for a preview-ready intervention and delivers the
 * code through the SEPARATE simulated SMS channel (/dev/duelogic/sms).
 * The browser supplies exactly `{ token }`; the trusted mobile is read
 * server-side from the Pinch payer record with a GET — the customer can
 * never supply, choose or alter it. The response carries only safe
 * content: stage, masked mobile, challenge expiry and the customer-safe
 * projection — never the code, a digest, a challenge ID, the full mobile
 * or the fingerprint. The HMAC secret is resolved at execution time from
 * DUELOGIC_OTP_HMAC_SECRET and a missing secret fails closed.
 *
 * No confirmation, execution or Pinch mutation can occur here. Answers
 * 404 unless the request arrives directly from localhost in `next dev`.
 */

export const runtime = "nodejs";

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

  try {
    const outcome = await requestInterventionOtp(
      { token: parsed.token },
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
      return NextResponse.json({
        ok: true,
        stage: "otp-sent",
        temporaryStore: true,
        maskedMobile: outcome.maskedMobile,
        expiresAt: outcome.challengeExpiresAt,
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
      outcome.reason === "configuration-error" ||
      outcome.reason === "store-failed" ||
      outcome.reason === "delivery-failed"
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
    console.error("Dev intervention OTP request failed unexpectedly.", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ ok: false, stage: "api" }, { status: 500 });
  }
}
