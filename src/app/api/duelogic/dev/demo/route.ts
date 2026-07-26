import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import {
  prepareDemo,
  toDemoSetupProjection,
} from "@/lib/duelogic/demo-preparation";
import { buildDevDemoPreparationDeps } from "@/lib/duelogic/dev-demo-composition";

/**
 * Development-only demo preparation route: POST rebuilds the complete
 * process-local presentation state (clearing exactly the previous demo
 * run first) and returns the customer-safe Demo Setup projection —
 * labels, provenance and review paths only.
 *
 * The browser supplies NOTHING: the body must be empty (or an empty JSON
 * object) — no customer, payment, subscription, plan or policy
 * identifiers are accepted, and every fixture value is derived
 * server-side. Preparation makes zero Pinch calls, issues no OTP and
 * writes no SMS message. Answers 404 unless the request arrives directly
 * from localhost in `next dev`. Records live in process-local sandbox
 * memory only and are lost when the development server restarts.
 */

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isDirectLocalhostRequest(request)) {
    return new NextResponse(null, { status: 404 });
  }

  // Accept no input at all: an empty body or exactly {}. Anything else —
  // any key, any identifier — is rejected before touching a store.
  const bodyText = (await request.text()).trim();
  if (bodyText !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return NextResponse.json(
        { ok: false, stage: "validation" },
        { status: 400 },
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length > 0
    ) {
      return NextResponse.json(
        { ok: false, stage: "validation" },
        { status: 400 },
      );
    }
  }

  try {
    const outcome = await prepareDemo(await buildDevDemoPreparationDeps());
    if (!outcome.ok) {
      return NextResponse.json(
        { ok: false, stage: outcome.reason },
        { status: outcome.reason === "policy-unresolved" ? 409 : 500 },
      );
    }
    return NextResponse.json({
      ok: true,
      demo: toDemoSetupProjection(outcome.manifest),
    });
  } catch (error) {
    // Safe classification only — never tokens or record content.
    console.error("Dev demo preparation failed.", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ ok: false, stage: "api" }, { status: 500 });
  }
}
