import { NextResponse } from "next/server";
import {
  PinchConfigError,
  verifyPinchAuthentication,
} from "@/lib/pinch/client";

export async function GET() {
  try {
    await verifyPinchAuthentication();
    return NextResponse.json({ ok: true, environment: "test" });
  } catch (error) {
    // Client errors are written to contain no credentials or tokens, so the
    // message is safe to log server-side; the HTTP response stays generic.
    console.error(
      "Pinch health check failed:",
      error instanceof Error ? error.message : "Unknown error",
    );

    const status = error instanceof PinchConfigError ? 500 : 502;
    return NextResponse.json(
      { ok: false, error: "Unable to authenticate with Pinch." },
      { status },
    );
  }
}
