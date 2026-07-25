import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import {
  getDevInterventionNotificationRepository,
  getDevInterventionRepository,
} from "@/lib/duelogic/dev-intervention-store";
import { toMerchantInterventionProjection } from "@/lib/duelogic/intervention";
import { INTERVENTION_DEMO_FIXTURE } from "@/lib/duelogic/intervention-fixture";
import { createInterventionPinchReadEffects } from "@/lib/duelogic/intervention-pinch-reads";
import {
  DEV_INTERVENTION_INVITATION_LIFETIME_MINUTES,
  generateInterventionId,
  generateInterventionNotificationId,
  generateInterventionToken,
  hashInterventionToken,
  runScheduledInterventionScan,
} from "@/lib/duelogic/intervention-service";
import { validateInterventionFlow } from "@/lib/duelogic/intervention-validation";
import { getDevMerchantPolicyRepository } from "@/lib/duelogic/policy/dev-policy-store";
import {
  PinchApiError,
  PinchAuthError,
  PinchConfigError,
} from "@/lib/pinch/client";

/**
 * Development-only trigger for the scheduled intervention scan — the
 * localhost stand-in for the production scheduled process, never merchant
 * approval. POST runs the scan: frozen detector evidence, the frozen policy
 * result, read-only live subscription resolution, trusted cycle resolution,
 * duplicate prevention, then one intervention record and one customer
 * notification. Every Pinch call is a GET; nothing is created, cancelled or
 * updated in Pinch.
 *
 * The response is a merchant-safe summary only: never the raw token, never
 * the token hash and never the notification delivery artefact — the
 * customer link exists solely in the development inbox at
 * /dev/duelogic/inbox.
 *
 * Answers 404 unless the request arrives directly from localhost in
 * `next dev` — the shared guard in src/lib/dev/localhost-guard.ts.
 */

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isDirectLocalhostRequest(request)) {
    return new NextResponse(null, { status: 404 });
  }

  try {
    // Re-asserts the deterministic Stage 1 scenarios on every request,
    // mirroring the sibling dev routes.
    await validateInterventionFlow();

    const nowIso = new Date().toISOString();
    const outcome = await runScheduledInterventionScan(
      INTERVENTION_DEMO_FIXTURE,
      {
        repository: getDevInterventionRepository(),
        notifications: getDevInterventionNotificationRepository(),
        subscriptionReads: createInterventionPinchReadEffects(
          INTERVENTION_DEMO_FIXTURE.merchantTimezone,
        ),
        // The saved merchant policy store: the scan binds the active
        // snapshot's version to the created intervention. Server-held only
        // — the browser can never supply policy identity.
        policies: await getDevMerchantPolicyRepository(),
        now: () => new Date().toISOString(),
        generateInterventionId,
        generateNotificationId: generateInterventionNotificationId,
        generateToken: generateInterventionToken,
        hashToken: hashInterventionToken,
        invitationLifetimeMinutes: DEV_INTERVENTION_INVITATION_LIFETIME_MINUTES,
      },
    );

    if (outcome.outcome === "created") {
      return NextResponse.json({
        ok: true,
        created: true,
        temporaryStore: true,
        intervention: toMerchantInterventionProjection(outcome.record, nowIso),
        inboxPath: "/dev/duelogic/inbox",
      });
    }
    if (outcome.outcome === "already-active") {
      return NextResponse.json({
        ok: true,
        created: false,
        temporaryStore: true,
        alreadyActive: true,
        intervention: toMerchantInterventionProjection(outcome.record, nowIso),
        inboxPath: "/dev/duelogic/inbox",
      });
    }
    if (outcome.outcome === "policy-review-required") {
      // The policy engine, evaluating the candidate under the active saved
      // policy with the payer's derived prior-change history, reports the
      // rolling permanent allowance as exhausted: no invitation, token,
      // notification or preview exists. Merchant-safe vocabulary only.
      console.error("Dev intervention scan requires merchant policy review.", {
        reason: outcome.reason,
      });
      return NextResponse.json(
        {
          ok: false,
          stage: "policy-review-required",
          reason: outcome.reason,
        },
        { status: 409 },
      );
    }
    if (outcome.outcome === "fixture-error") {
      // Safe stage vocabulary only — never Pinch response content. An
      // ambiguous or failed resolution is a development fixture error and
      // creates no invitation.
      console.error("Dev intervention scan fixture error.", {
        reason: outcome.reason,
        detail: outcome.detail,
      });
      return NextResponse.json(
        { ok: false, stage: "fixture", reason: outcome.reason },
        { status: 409 },
      );
    }
    console.error("Dev intervention scan store error.", {
      detail: outcome.detail,
    });
    return NextResponse.json({ ok: false, stage: "store" }, { status: 500 });
  } catch (error) {
    const stage =
      error instanceof PinchAuthError || error instanceof PinchConfigError
        ? "auth"
        : "api";
    // Never log upstream response bodies: Pinch error bodies can carry
    // tokenised source details and payer PII. Log only classification
    // fields.
    console.error(`Dev intervention scan failed at stage "${stage}".`, {
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
