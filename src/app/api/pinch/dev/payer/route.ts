import { type NextRequest, NextResponse } from "next/server";
import {
  PinchApiError,
  PinchAuthError,
  PinchConfigError,
  pinchRequest,
} from "@/lib/pinch/client";

/**
 * Development-only endpoint for creating a sandbox Pinch payer.
 * Answers 404 unless the request arrives directly from localhost in
 * `next dev` — tunnelled (ngrok), proxied, and deployed requests are all
 * rejected before any Pinch call is made.
 */

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function hostHeaderIsLocal(hostHeader: string | null): boolean {
  if (!hostHeader) {
    return false;
  }
  const value = hostHeader.trim().toLowerCase();
  if (value === "::1") {
    // Bracket-less IPv6 loopback without a port cannot be URL-parsed below.
    return true;
  }
  try {
    // Handles ports and the bracketed IPv6 form, e.g. "[::1]:3000".
    const hostname = new URL(`http://${value}`).hostname.replace(
      /^\[|\]$/g,
      "",
    );
    return LOCAL_HOSTNAMES.has(hostname);
  } catch {
    return false;
  }
}

function isLoopbackAddress(value: string): boolean {
  const address = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (address === "::1" || address === "localhost") {
    return true;
  }
  if (address.startsWith("::ffff:")) {
    return isLoopbackAddress(address.slice("::ffff:".length));
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
}

/**
 * The Next dev server stamps x-forwarded-for/host/proto onto every request,
 * including direct localhost ones (verified empirically), so rejecting on
 * header *presence* would reject everything. Instead every forwarded value
 * must itself be loopback/local: tunnels and proxies (ngrok, Vercel) put
 * public hostnames, public client IPs, or https here, and are rejected.
 */
function isDirectLocalhostRequest(request: NextRequest): boolean {
  if (process.env.NODE_ENV !== "development") {
    return false;
  }

  if (!hostHeaderIsLocal(request.headers.get("host"))) {
    return false;
  }

  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost !== null && !hostHeaderIsLocal(forwardedHost)) {
    return false;
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor !== null) {
    const entries = forwardedFor
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (entries.length === 0 || !entries.every(isLoopbackAddress)) {
      return false;
    }
  }

  // `next dev` serves plain http; a forwarded https proto indicates a tunnel.
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto !== null) {
    const firstProto = forwardedProto.split(",")[0]?.trim().toLowerCase();
    if (firstProto !== "http") {
      return false;
    }
  }

  return true;
}

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

    // Dev-only, localhost-only route: log the full upstream error body to
    // the local console for debugging. It never enters the HTTP response,
    // and the submitted payer body is never logged.
    console.error(`Pinch dev payer creation failed at stage "${stage}".`, {
      errorClass: error instanceof Error ? error.name : "UnknownError",
      upstreamStatus:
        error instanceof PinchAuthError || error instanceof PinchApiError
          ? (error.status ?? "none")
          : "none",
      upstreamBody:
        error instanceof PinchApiError ? (error.upstreamBody ?? "none") : "none",
    });

    const httpStatus = error instanceof PinchConfigError ? 500 : 502;
    return NextResponse.json({ ok: false, stage }, { status: httpStatus });
  }
}
