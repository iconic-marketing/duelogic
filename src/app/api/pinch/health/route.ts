import { NextResponse } from "next/server";
import {
  PinchApiError,
  PinchAuthError,
  PinchConfigError,
  pinchRequest,
} from "@/lib/pinch/client";

type PinchEnvironment = "test" | "live" | "unknown";

function classifyUrlPart(part: string): PinchEnvironment | null {
  const value = part.toLowerCase();
  if (value.includes("test") || value.includes("sandbox")) {
    return "test";
  }
  if (value.includes("live") || value.includes("prod")) {
    return "live";
  }
  return null;
}

function deriveEnvironment(): PinchEnvironment {
  const baseUrl = process.env.PINCH_API_BASE_URL;
  if (!baseUrl) {
    return "unknown";
  }
  try {
    const url = new URL(baseUrl);
    return (
      classifyUrlPart(url.hostname) ?? classifyUrlPart(url.pathname) ?? "unknown"
    );
  } catch {
    return "unknown";
  }
}

export async function GET() {
  const environment = deriveEnvironment();

  try {
    // Non-mutating GET; the response is discarded — reaching this line at all
    // proves the base URL is reachable and accepted the token.
    await pinchRequest<unknown>("payers");
    return NextResponse.json({ ok: true, environment, apiReachable: true });
  } catch (error) {
    // Classified by error type, after the client's own refresh-and-retry:
    // auth = no token could be obtained (config missing, token endpoint
    // rejected us, or a mid-request refresh failed); api = the token was
    // accepted for issue but the API request itself failed.
    const stage =
      error instanceof PinchAuthError || error instanceof PinchConfigError
        ? "auth"
        : "api";

    const upstreamStatus =
      (error instanceof PinchAuthError || error instanceof PinchApiError) &&
      error.status !== undefined
        ? error.status
        : undefined;

    if (upstreamStatus !== undefined) {
      console.error(
        `Pinch health check failed at stage "${stage}" with upstream HTTP ${upstreamStatus}.`,
      );
    } else {
      console.error(
        `Pinch health check failed at stage "${stage}": ${
          error instanceof Error ? error.name : "UnknownError"
        }.`,
      );
    }

    const httpStatus = error instanceof PinchConfigError ? 500 : 502;
    return NextResponse.json(
      { ok: false, environment, apiReachable: false, stage },
      { status: httpStatus },
    );
  }
}
