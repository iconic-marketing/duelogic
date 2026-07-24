import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import {
  PinchApiError,
  PinchAuthError,
  PinchConfigError,
  pinchRequest,
} from "@/lib/pinch/client";

/**
 * Development-only endpoint for creating a sandbox Pinch payer.
 * Answers 404 unless the request arrives directly from localhost in
 * `next dev` (the shared guard in src/lib/dev/localhost-guard.ts) —
 * tunnelled (ngrok), proxied, and deployed requests are all rejected
 * before any Pinch call is made.
 */

interface PayerRequestBody {
  firstName: string;
  lastName?: string;
  emailAddress: string;
  mobileNumber?: string;
}

function buildSyntheticPayer(): PayerRequestBody {
  return {
    firstName: "DueLogic",
    lastName: "Sandbox Payer",
    emailAddress: `duelogic.sandbox.${Date.now()}@example.com`,
  };
}

/**
 * Builds the Pinch payer body from caller input by explicit whitelisting:
 * only the four known fields are ever read, and a brand-new object is
 * constructed. Caller-supplied fields such as id, source, merchantId or
 * metadata are never forwarded. Returns null when required fields are
 * missing or not non-empty strings.
 */
function buildCustomPayer(input: unknown): PayerRequestBody | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const { firstName, lastName, emailAddress, mobileNumber } = input as Record<
    string,
    unknown
  >;

  if (typeof firstName !== "string" || firstName.trim() === "") {
    return null;
  }
  if (typeof emailAddress !== "string" || emailAddress.trim() === "") {
    return null;
  }

  const payer: PayerRequestBody = {
    firstName: firstName.trim(),
    emailAddress: emailAddress.trim(),
  };
  if (typeof lastName === "string" && lastName.trim() !== "") {
    payer.lastName = lastName.trim();
  }
  if (typeof mobileNumber === "string" && mobileNumber.trim() !== "") {
    payer.mobileNumber = mobileNumber.trim();
  }
  return payer;
}

function extractPayerId(result: unknown): string | null {
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

export async function POST(request: NextRequest) {
  if (!isDirectLocalhostRequest(request)) {
    return new NextResponse(null, { status: 404 });
  }

  const rawBody = await request.text();
  let payer: PayerRequestBody;
  // Passed only via the pinchRequest option (the Current-Merchant header),
  // never in the JSON body sent to Pinch. Undefined = single-merchant.
  let merchantId: string | undefined;
  if (rawBody.trim() === "") {
    payer = buildSyntheticPayer();
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { ok: false, stage: "validation" },
        { status: 400 },
      );
    }
    const custom = buildCustomPayer(parsed);
    if (custom === null) {
      return NextResponse.json(
        { ok: false, stage: "validation" },
        { status: 400 },
      );
    }
    payer = custom;

    const rawMerchantId = (parsed as Record<string, unknown>).merchantId;
    if (rawMerchantId !== undefined) {
      if (typeof rawMerchantId !== "string" || rawMerchantId.trim() === "") {
        return NextResponse.json(
          { ok: false, stage: "validation" },
          { status: 400 },
        );
      }
      merchantId = rawMerchantId.trim();
    }
  }

  try {
    const result = await pinchRequest<unknown>("payers", {
      method: "POST",
      body: payer,
      merchantId,
    });

    const payerId = extractPayerId(result);
    if (payerId === null) {
      // Upstream reported success, so the payer may already exist; do not
      // retry the POST, as that could create a duplicate.
      console.error(
        'Pinch dev payer creation failed at stage "api": upstream reported success but no non-empty payer ID could be extracted.',
      );
      return NextResponse.json({ ok: false, stage: "api" }, { status: 502 });
    }

    return NextResponse.json({ ok: true, payerId });
  } catch (error) {
    const stage =
      error instanceof PinchAuthError || error instanceof PinchConfigError
        ? "auth"
        : "api";

    // Never log upstream response bodies: Pinch error bodies can carry
    // tokenised source details and payer PII. The submitted payer body is
    // never logged either — only classification fields.
    console.error(`Pinch dev payer creation failed at stage "${stage}".`, {
      errorClass: error instanceof Error ? error.name : "UnknownError",
      upstreamStatus:
        error instanceof PinchAuthError || error instanceof PinchApiError
          ? (error.status ?? "none")
          : "none",
    });

    const httpStatus = error instanceof PinchConfigError ? 500 : 502;
    return NextResponse.json({ ok: false, stage }, { status: httpStatus });
  }
}
