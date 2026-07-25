import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import { toCustomerConfirmationProjection } from "@/lib/pinch/customer-confirmation";
import {
  hashCustomerConfirmationToken,
  respondToCustomerConfirmation,
} from "@/lib/pinch/customer-confirmation-service";
import { getDevCustomerConfirmationRepository } from "@/lib/pinch/dev-customer-confirmation-store";

/**
 * Development-only customer response endpoint: applies an explicit accept
 * or decline to the confirmation identified by the supplied link token. The
 * token is hashed and looked up server-side — a customer-supplied
 * confirmationId is never trusted, expiry is evaluated server-side, and an
 * unknown token gets the same generic not-found answer regardless of what
 * else exists, so nothing leaks about other confirmations. Responses carry
 * the customer-safe projection only: no merchant, payer, source,
 * subscription, plan or operation IDs and no token material.
 *
 * Answers 404 unless the request arrives directly from localhost in
 * `next dev` — the shared guard in src/lib/dev/localhost-guard.ts.
 */

export const runtime = "nodejs";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ALLOWED_INPUT_KEYS = new Set(["token", "response"]);

function parseInput(
  input: unknown,
): { token: string; response: "accept" | "decline" } | null {
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
  if (input.response !== "accept" && input.response !== "decline") {
    return null;
  }
  return { token: input.token, response: input.response };
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
    const outcome = await respondToCustomerConfirmation(input, {
      repository: getDevCustomerConfirmationRepository(),
      now: () => new Date().toISOString(),
      hashToken: hashCustomerConfirmationToken,
    });

    if (outcome.ok) {
      return NextResponse.json({
        ok: true,
        changed: outcome.changed,
        confirmation: toCustomerConfirmationProjection(outcome.record, nowIso),
      });
    }
    if (outcome.reason === "not-found") {
      // Generic wording: reveals nothing about other confirmations.
      return NextResponse.json(
        { ok: false, stage: "not-found" },
        { status: 404 },
      );
    }
    if (outcome.reason === "store") {
      return NextResponse.json({ ok: false, stage: "store" }, { status: 500 });
    }
    // contradictory / expired / consumed: the customer-safe projection lets
    // the page show the current state honestly.
    return NextResponse.json(
      {
        ok: false,
        stage: outcome.reason,
        ...(outcome.record !== undefined
          ? {
              confirmation: toCustomerConfirmationProjection(
                outcome.record,
                nowIso,
              ),
            }
          : {}),
      },
      { status: 409 },
    );
  } catch (error) {
    console.error("Dev customer-confirmation response failed.", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
