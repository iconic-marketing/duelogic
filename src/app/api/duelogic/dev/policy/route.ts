import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import {
  DEV_POLICY_MERCHANT_ID,
  getDevMerchantPolicyRepository,
} from "@/lib/duelogic/policy/dev-policy-store";
import {
  buildMerchantPolicyView,
  processPolicyActivationRequest,
} from "@/lib/duelogic/policy/policy-activation";
import { validatePolicySnapshotFoundation } from "@/lib/duelogic/policy/policy-snapshot-validation";

/**
 * Development-only merchant policy configuration endpoint over the
 * process-local snapshot store.
 *
 * GET returns the merchant-safe view: the active snapshot projection and
 * the full history of projections in activation order — never the merchant
 * ID, a complete policy object, Pinch identifiers or store internals.
 *
 * POST accepts exactly `{ amountCeilingCents }` (a positive safe integer
 * of cents — the only merchant-configurable policy value in this MVP
 * stage). Unknown keys and any browser-supplied policy identity or fixed
 * rule value are rejected before any write. The trusted merchant ID, the
 * next policy version and the activation timestamp are resolved
 * server-side, the complete policy is rebuilt from the fixed default
 * frame, and activation appends a new immutable snapshot — an existing
 * snapshot is never modified. No Pinch call is involved anywhere here.
 *
 * Answers 404 unless the request arrives directly from localhost in
 * `next dev` — the shared guard in src/lib/dev/localhost-guard.ts.
 */

export const runtime = "nodejs";

/** The view is live development state; it must never be cached. */
const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export async function GET(request: NextRequest) {
  if (!isDirectLocalhostRequest(request)) {
    return new NextResponse(null, { status: 404 });
  }
  try {
    // Re-asserts the deterministic scenarios on every request, mirroring
    // the sibling dev routes.
    await validatePolicySnapshotFoundation();

    const repository = await getDevMerchantPolicyRepository();
    const view = await buildMerchantPolicyView(
      repository,
      DEV_POLICY_MERCHANT_ID,
    );
    return NextResponse.json(
      {
        ok: true,
        temporaryStore: true,
        active: view.active,
        history: view.history,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    // Safe classification only — never values, IDs or stack detail.
    console.error("Dev policy read failed.", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { ok: false, stage: "store" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
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
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    await validatePolicySnapshotFoundation();

    const repository = await getDevMerchantPolicyRepository();
    const outcome = await processPolicyActivationRequest(parsed, {
      repository,
      merchantId: DEV_POLICY_MERCHANT_ID,
      now: () => new Date().toISOString(),
    });
    if (!outcome.ok) {
      return NextResponse.json(
        { ok: false, stage: "validation" },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        temporaryStore: true,
        active: outcome.view.active,
        history: outcome.view.history,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    // A refused activation (e.g. a concurrent duplicate version) leaves
    // the append-only history untouched; log classification only.
    console.error("Dev policy activation failed.", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { ok: false, stage: "activation" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
