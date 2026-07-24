import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import { detectTimingLinkedPatterns } from "@/lib/duelogic/pattern-detector";
import { validateSeedPatternDetection } from "@/lib/duelogic/pattern-detector-validation";
import {
  seedPaymentRecords,
  seedSummary,
} from "@/lib/duelogic/seed-payment-history";

/**
 * Development-only inspection of the timing-linked pattern detector over the
 * synthetic seed history. Never calls Pinch and returns synthetic,
 * non-personal data only: internal record IDs, dates and strict pattern
 * evidence — no Pinch payer or payment IDs, contact details, inferred
 * financial causes, risk scores or prevented-loss claims. Answers 404 unless
 * the request arrives directly from localhost in `next dev` — the shared
 * guard in src/lib/dev/localhost-guard.ts.
 */

export const runtime = "nodejs";

export function GET(request: NextRequest) {
  if (!isDirectLocalhostRequest(request)) {
    return new NextResponse(null, { status: 404 });
  }

  try {
    // Re-asserts the seed expectations on every inspection, in addition to
    // the module-load validation.
    validateSeedPatternDetection();
    const flags = detectTimingLinkedPatterns(seedPaymentRecords);

    return NextResponse.json({
      ok: true,
      synthetic: true,
      // The detector's default anchor: the latest scheduled date in the seed.
      asOfDate: seedSummary.lastScheduledDate,
      paymentCount: seedSummary.paymentCount,
      flaggedPayerCount: flags.length,
      patterns: flags,
    });
  } catch (error) {
    console.error("DueLogic dev pattern inspection failed.", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
