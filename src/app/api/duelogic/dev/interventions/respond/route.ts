import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import { getDevInterventionRepository } from "@/lib/duelogic/dev-intervention-store";
import { toCustomerInterventionProjection } from "@/lib/duelogic/intervention";
import { INTERVENTION_DEMO_FIXTURE } from "@/lib/duelogic/intervention-fixture";
import { createInterventionPinchReadEffects } from "@/lib/duelogic/intervention-pinch-reads";
import {
  declineIntervention,
  evaluateSelectedDate,
  hashInterventionToken,
} from "@/lib/duelogic/intervention-service";
import {
  PinchApiError,
  PinchAuthError,
  PinchConfigError,
} from "@/lib/pinch/client";

/**
 * Development-only customer response endpoint for the Stage 1 intervention
 * journey: "check-date" evaluates a customer-selected date and, when the
 * deterministic policy engine approves it, obtains the exact read-only
 * Pinch schedule preview; "decline" records an explicit decline. The token
 * is hashed and looked up server-side — a customer-supplied intervention ID
 * is never trusted, expiry is evaluated server-side, and an unknown token
 * gets the same generic not-found answer regardless of what else exists.
 *
 * Every identity, amount, cadence and cycle input comes from the
 * server-held intervention record and fixture — nothing from the browser is
 * trusted beyond the token, the action and the date string. Every Pinch
 * call is a GET; Stage 1 performs no mutation and stops at preview-ready.
 * Responses carry the customer-safe projection only: no merchant, payer,
 * source, subscription, plan or pattern IDs, no reason codes and no token
 * material.
 *
 * Answers 404 unless the request arrives directly from localhost in
 * `next dev` — the shared guard in src/lib/dev/localhost-guard.ts.
 */

export const runtime = "nodejs";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ALLOWED_INPUT_KEYS = new Set(["token", "action", "selectedDate"]);

type ParsedInput =
  | { token: string; action: "check-date"; selectedDate: string }
  | { token: string; action: "decline" };

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
    if (input.selectedDate !== undefined) {
      return null;
    }
    return { token: input.token, action: "decline" };
  }
  if (input.action === "check-date") {
    if (
      typeof input.selectedDate !== "string" ||
      input.selectedDate.trim() === "" ||
      input.selectedDate.length > 20
    ) {
      return null;
    }
    return {
      token: input.token,
      action: "check-date",
      selectedDate: input.selectedDate,
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
          intervention: toCustomerInterventionProjection(
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
                intervention: toCustomerInterventionProjection(
                  outcome.record,
                  nowIso,
                ),
              }
            : {}),
        },
        { status: 409 },
      );
    }

    const outcome = await evaluateSelectedDate(
      { token: input.token, selectedDate: input.selectedDate },
      INTERVENTION_DEMO_FIXTURE,
      {
        repository,
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
        intervention: toCustomerInterventionProjection(outcome.record, nowIso),
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
              intervention: toCustomerInterventionProjection(
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
