import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import { getDevReplacementOperationRepository } from "@/lib/pinch/dev-replacement-operation-store";
import { toSafeReplacementOperationProjection } from "@/lib/pinch/replacement-operation";
import { validateReplacementOperationRecovery } from "@/lib/pinch/replacement-operation-validation";

/**
 * Development-only read of the subscription-replacement operation store by
 * operation ID. Never calls Pinch and exposes only the safe projection:
 * status, current stage, subscription IDs, the verified old-to-new mapping,
 * recovery availability, sanitised failure information and timestamps —
 * never the recovery snapshot, reinstatement payload or any card or bank
 * source information.
 *
 * The store is process-local sandbox memory (it does not survive restarts),
 * and the deterministic replacement-operation validation is re-asserted on
 * every request, mirroring the dev patterns route. Answers 404 unless the
 * request arrives directly from localhost in `next dev` — the shared guard
 * in src/lib/dev/localhost-guard.ts.
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!isDirectLocalhostRequest(request)) {
    return new NextResponse(null, { status: 404 });
  }

  const rawOperationId = request.nextUrl.searchParams.get("operationId");
  const operationId =
    typeof rawOperationId === "string" ? rawOperationId.trim() : "";
  if (operationId === "" || operationId.length > 100) {
    return NextResponse.json(
      { ok: false, stage: "validation" },
      { status: 400 },
    );
  }

  try {
    // Re-asserts the deterministic recovery-flow scenarios on every
    // inspection, in addition to the module-load validation.
    const validation = await validateReplacementOperationRecovery();

    const record = await getDevReplacementOperationRepository().read(
      operationId,
    );
    if (record === null) {
      return NextResponse.json(
        {
          ok: false,
          stage: "not-found",
          operationId,
          temporaryStore: true,
          validationScenarioCount: validation.scenarioCount,
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      temporaryStore: true,
      validationScenarioCount: validation.scenarioCount,
      operation: toSafeReplacementOperationProjection(record),
    });
  } catch (error) {
    console.error("Pinch dev replacement-operation lookup failed.", {
      operationId,
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
