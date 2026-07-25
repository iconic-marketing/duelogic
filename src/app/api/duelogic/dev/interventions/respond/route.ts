import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import { getDevInterventionRepository } from "@/lib/duelogic/dev-intervention-store";
import { getDevMovementChoiceRepository } from "@/lib/duelogic/dev-movement-store";
import {
  buildDevChooseMovementDeps,
  buildDevMovementProjectionDeps,
  buildDevTemporaryJourneyDeps,
} from "@/lib/duelogic/dev-movement-journey";
import { getDevTransactionVerificationRepository } from "@/lib/duelogic/dev-transaction-verification-store";
import {
  toCustomerInterventionProjection,
  type CustomerInterventionProjection,
  type DueLogicInterventionRecord,
} from "@/lib/duelogic/intervention";
import { INTERVENTION_DEMO_FIXTURE } from "@/lib/duelogic/intervention-fixture";
import { createInterventionPinchReadEffects } from "@/lib/duelogic/intervention-pinch-reads";
import {
  declineIntervention,
  evaluateSelectedDate,
  hashInterventionToken,
} from "@/lib/duelogic/intervention-service";
import {
  buildCustomerMovementProjection,
  chooseMovementKind,
  isMovementKind,
  type CustomerMovementProjection,
} from "@/lib/duelogic/movement-journey";
import type { MovementKind } from "@/lib/duelogic/movement-availability";
import { getDevMerchantPolicyRepository } from "@/lib/duelogic/policy/dev-policy-store";
import { evaluateAndBindTemporarySelection } from "@/lib/duelogic/temporary-execution-service";
import {
  PinchApiError,
  PinchAuthError,
  PinchConfigError,
} from "@/lib/pinch/client";

/**
 * Development-only customer response endpoint for the intervention
 * journey:
 *
 * - "choose-movement" binds the customer's movement kind server-side —
 *   availability is derived by the policy engine and cadence resolver
 *   under the intervention's BOUND policy snapshot, and a kind that is
 *   not currently available refuses;
 * - "check-date" evaluates a customer-selected date under the STORED
 *   movement choice: the temporary journey binds the exact one-payment
 *   operation, the permanent journeys evaluate under the current or next
 *   assigned cycle, and the browser can never pick the path itself;
 * - "decline" records an explicit decline exactly as before.
 *
 * Nothing from the browser is trusted beyond the token, the action, the
 * date string, the movement kind name and the explicit
 * accept-alternative flag. Every Pinch call is a GET; this endpoint
 * performs no mutation and stops at preview-ready. Responses carry the
 * customer-safe projection and movement projection only.
 *
 * Answers 404 unless the request arrives directly from localhost in
 * `next dev` — the shared guard in src/lib/dev/localhost-guard.ts.
 */

export const runtime = "nodejs";

async function projectionWithVerification(
  record: DueLogicInterventionRecord,
  nowIso: string,
): Promise<CustomerInterventionProjection> {
  let verification = null;
  try {
    verification =
      await getDevTransactionVerificationRepository().readVerifiedForIntervention(
        record.interventionId,
      );
  } catch {
    verification = null;
  }
  return toCustomerInterventionProjection(record, nowIso, verification);
}

async function movementProjectionFor(
  record: DueLogicInterventionRecord,
): Promise<CustomerMovementProjection> {
  return buildCustomerMovementProjection(
    record,
    await buildDevMovementProjectionDeps(),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ALLOWED_INPUT_KEYS = new Set([
  "token",
  "action",
  "selectedDate",
  "movementKind",
  "acceptOfferedAlternative",
]);

type ParsedInput =
  | {
      token: string;
      action: "check-date";
      selectedDate: string;
      acceptOfferedAlternative: boolean;
    }
  | { token: string; action: "decline" }
  | { token: string; action: "choose-movement"; movementKind: MovementKind };

function parseInput(input: unknown): ParsedInput | null {
  if (!isPlainObject(input)) {
    return null;
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      return null;
    }
  }
  if (
    typeof input.token !== "string" ||
    input.token.trim() === "" ||
    input.token.length > 200
  ) {
    return null;
  }
  if (input.action === "decline") {
    if (
      input.selectedDate !== undefined ||
      input.movementKind !== undefined ||
      input.acceptOfferedAlternative !== undefined
    ) {
      return null;
    }
    return { token: input.token, action: "decline" };
  }
  if (input.action === "choose-movement") {
    if (
      input.selectedDate !== undefined ||
      input.acceptOfferedAlternative !== undefined ||
      !isMovementKind(input.movementKind)
    ) {
      return null;
    }
    return {
      token: input.token,
      action: "choose-movement",
      movementKind: input.movementKind,
    };
  }
  if (input.action === "check-date") {
    if (
      typeof input.selectedDate !== "string" ||
      input.selectedDate.trim() === "" ||
      input.selectedDate.length > 20 ||
      input.movementKind !== undefined ||
      (input.acceptOfferedAlternative !== undefined &&
        typeof input.acceptOfferedAlternative !== "boolean")
    ) {
      return null;
    }
    return {
      token: input.token,
      action: "check-date",
      selectedDate: input.selectedDate,
      acceptOfferedAlternative: input.acceptOfferedAlternative === true,
    };
  }
  return null;
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
      { status: 400 },
    );
  }
  const input = parseInput(parsed);
  if (input === null) {
    return NextResponse.json(
      { ok: false, stage: "validation" },
      { status: 400 },
    );
  }

  try {
    const nowIso = new Date().toISOString();
    const repository = getDevInterventionRepository();

    if (input.action === "decline") {
      const outcome = await declineIntervention(
        { token: input.token },
        {
          repository,
          now: () => new Date().toISOString(),
          hashToken: hashInterventionToken,
        },
      );
      if (outcome.ok) {
        return NextResponse.json({
          ok: true,
          changed: outcome.changed,
          intervention: await projectionWithVerification(
            outcome.record,
            nowIso,
          ),
        });
      }
      if (outcome.reason === "not-found") {
        // Generic wording: reveals nothing about other interventions.
        return NextResponse.json(
          { ok: false, stage: "not-found" },
          { status: 404 },
        );
      }
      if (outcome.reason === "store") {
        return NextResponse.json(
          { ok: false, stage: "store" },
          { status: 500 },
        );
      }
      return NextResponse.json(
        {
          ok: false,
          stage: outcome.reason,
          ...(outcome.record !== undefined
            ? {
                intervention: await projectionWithVerification(
                  outcome.record,
                  nowIso,
                ),
              }
            : {}),
        },
        { status: 409 },
      );
    }

    if (input.action === "choose-movement") {
      const outcome = await chooseMovementKind(
        { token: input.token, kind: input.movementKind },
        await buildDevChooseMovementDeps(),
      );
      if (outcome.ok) {
        return NextResponse.json({
          ok: true,
          stage: "movement-chosen",
          movement: await movementProjectionFor(outcome.record),
          intervention: await projectionWithVerification(
            outcome.record,
            nowIso,
          ),
        });
      }
      if (outcome.reason === "not-found") {
        return NextResponse.json(
          { ok: false, stage: "not-found" },
          { status: 404 },
        );
      }
      if (outcome.reason === "store") {
        return NextResponse.json(
          { ok: false, stage: "store" },
          { status: 500 },
        );
      }
      return NextResponse.json(
        {
          ok: false,
          stage: outcome.reason,
          ...(outcome.record !== undefined
            ? {
                movement: await movementProjectionFor(outcome.record),
                intervention: await projectionWithVerification(
                  outcome.record,
                  nowIso,
                ),
              }
            : {}),
        },
        { status: 409 },
      );
    }

    // check-date: dispatch under the STORED movement choice. The browser
    // never selects the evaluation path.
    const preRecord = await repository.readByTokenHash(
      hashInterventionToken(input.token.trim()),
    );
    if (preRecord === null) {
      return NextResponse.json(
        { ok: false, stage: "not-found" },
        { status: 404 },
      );
    }
    const choice = await getDevMovementChoiceRepository().readChoice(
      preRecord.interventionId,
    );

    if (choice?.kind === "temporary") {
      const outcome = await evaluateAndBindTemporarySelection(
        {
          token: input.token,
          requestedDate: input.selectedDate,
          acceptOfferedAlternative: input.acceptOfferedAlternative,
        },
        await buildDevTemporaryJourneyDeps(),
      );
      if (outcome.ok) {
        return NextResponse.json({
          ok: true,
          stage: "temporary-approved",
          movement: await movementProjectionFor(preRecord),
          intervention: await projectionWithVerification(preRecord, nowIso),
        });
      }
      if (outcome.reason === "alternative-offered") {
        // The engine's maximum permitted date: the customer must actively
        // accept it before any binding exists.
        return NextResponse.json(
          {
            ok: false,
            stage: "alternative-offered",
            alternativeDate: outcome.alternativeDate,
            movement: await movementProjectionFor(preRecord),
            intervention: await projectionWithVerification(preRecord, nowIso),
          },
          { status: 409 },
        );
      }
      if (outcome.reason === "not-found") {
        return NextResponse.json(
          { ok: false, stage: "not-found" },
          { status: 404 },
        );
      }
      if (outcome.reason === "merchant-review-required") {
        // Route the case to the existing merchant escalation state.
        const escalated: DueLogicInterventionRecord = {
          ...preRecord,
          status: "escalated",
          updatedAt: nowIso,
        };
        try {
          await repository.write(escalated);
        } catch {
          // The refusal outcome stands even if the escalation write fails.
        }
        return NextResponse.json(
          {
            ok: false,
            stage: "merchant-review-required",
            intervention: await projectionWithVerification(escalated, nowIso),
          },
          { status: 409 },
        );
      }
      const httpStatus =
        outcome.reason === "store" || outcome.reason === "validation"
          ? outcome.reason === "store"
            ? 500
            : 400
          : 409;
      return NextResponse.json(
        {
          ok: false,
          stage: outcome.reason,
          movement: await movementProjectionFor(preRecord),
          intervention: await projectionWithVerification(preRecord, nowIso),
        },
        { status: httpStatus },
      );
    }

    // Permanent journeys (or an invitation predating movement choices):
    // the existing deterministic evaluation, with next-cycle semantics
    // only when the stored choice is the next-cycle movement.
    const outcome = await evaluateSelectedDate(
      {
        token: input.token,
        selectedDate: input.selectedDate,
        ...(choice?.kind === "permanent-next-cycle"
          ? { nextCycleIntent: true }
          : {}),
      },
      INTERVENTION_DEMO_FIXTURE,
      {
        repository,
        // The saved policy store: evaluation resolves the intervention's
        // stored policyVersion — never the currently active policy, and
        // never anything browser-supplied.
        policies: await getDevMerchantPolicyRepository(),
        now: () => new Date().toISOString(),
        hashToken: hashInterventionToken,
        previewReads: createInterventionPinchReadEffects(
          INTERVENTION_DEMO_FIXTURE.merchantTimezone,
        ),
      },
    );
    if (outcome.ok) {
      return NextResponse.json({
        ok: true,
        movement: await movementProjectionFor(outcome.record),
        intervention: await projectionWithVerification(outcome.record, nowIso),
      });
    }
    if (outcome.reason === "not-found") {
      return NextResponse.json(
        { ok: false, stage: "not-found" },
        { status: 404 },
      );
    }
    if (outcome.reason === "store") {
      return NextResponse.json({ ok: false, stage: "store" }, { status: 500 });
    }
    // Refusals carry the customer-safe projection so the page can render
    // the current state honestly; the reason stays generic vocabulary.
    return NextResponse.json(
      {
        ok: false,
        stage: outcome.reason,
        ...(outcome.record !== undefined
          ? {
              intervention: await projectionWithVerification(
                outcome.record,
                nowIso,
              ),
            }
          : {}),
      },
      { status: outcome.reason === "preview-unavailable" ? 502 : 409 },
    );
  } catch (error) {
    const stage =
      error instanceof PinchAuthError || error instanceof PinchConfigError
        ? "auth"
        : "api";
    // Never log upstream response bodies: Pinch error bodies can carry
    // tokenised source details and payer PII. Log only classification
    // fields.
    console.error(`Dev intervention response failed at stage "${stage}".`, {
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
