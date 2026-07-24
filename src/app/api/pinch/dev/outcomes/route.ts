import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import { readOutcomeEvents } from "@/lib/pinch/dev-outcome-store";

/**
 * Development-only read of the in-memory webhook outcome store for one
 * payment. Never calls Pinch and exposes only the safe stored summaries.
 * Answers 404 unless the request arrives directly from localhost in
 * `next dev` — the shared guard in src/lib/dev/localhost-guard.ts.
 */

export const runtime = "nodejs";

export function GET(request: NextRequest) {
  if (!isDirectLocalhostRequest(request)) {
    return new NextResponse(null, { status: 404 });
  }

  const rawPaymentId = request.nextUrl.searchParams.get("paymentId");
  const paymentId = typeof rawPaymentId === "string" ? rawPaymentId.trim() : "";
  if (!paymentId.startsWith("pmt_")) {
    return NextResponse.json(
      { ok: false, stage: "validation" },
      { status: 400 },
    );
  }

  // Copied field-by-field so the internal store objects are never exposed.
  const events = readOutcomeEvents(paymentId).map((event) => ({
    eventId: event.eventId,
    type: event.type,
    ...(event.eventDate !== undefined ? { eventDate: event.eventDate } : {}),
    receivedAt: event.receivedAt,
  }));

  return NextResponse.json({ ok: true, paymentId, temporaryStore: true, events });
}
