import { type NextRequest, NextResponse } from "next/server";
import { isDirectLocalhostRequest } from "@/lib/dev/localhost-guard";
import { addCalendarDays, calendarDaysBetween } from "@/lib/duelogic/calendar-date";
import {
  getDevInterventionNotificationRepository,
  getDevInterventionRepository,
} from "@/lib/duelogic/dev-intervention-store";
import { getDevFixturePaymentRepository } from "@/lib/duelogic/dev-movement-store";
import type { DueLogicInterventionRecord } from "@/lib/duelogic/intervention";
import { INTERVENTION_DEMO_FIXTURE } from "@/lib/duelogic/intervention-fixture";
import {
  generateInterventionToken,
  hashInterventionToken,
} from "@/lib/duelogic/intervention-service";
import { getDevMerchantPolicyRepository } from "@/lib/duelogic/policy/dev-policy-store";

/**
 * Development-only movement-journey FIXTURE seeding: creates deterministic
 * process-local demonstration invitations (plus fixture payments) so the
 * customer movement-choice states can be inspected on real pages without
 * any Pinch call or mutation. Fixture payers are synthetic and distinct
 * from the live demonstration payer, so live history and the completed
 * intervention are never affected.
 *
 * Scenarios:
 * - "temporary-only":   unmapped plan (permanent unavailable) + a fixture
 *                       scheduled payment → only the temporary option;
 * - "all-options":      the mapped demo plan with in-window dates + a
 *                       fixture payment → all three options;
 * - "review-required":  unmapped plan and no payment → nothing available,
 *                       merchant-review wording.
 *
 * Answers 404 unless the request arrives directly from localhost in
 * `next dev`. Records live in process-local sandbox memory only.
 */

export const runtime = "nodejs";

const SCENARIOS = ["temporary-only", "all-options", "review-required"] as const;
type FixtureScenario = (typeof SCENARIOS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Today's calendar date in the demo merchant timezone. */
function merchantToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: INTERVENTION_DEMO_FIXTURE.merchantTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** The anchored fixed-day cycle containing `date` for the demo plan. */
function anchoredCycleFor(date: string): { start: string; end: string } | null {
  const mapping =
    INTERVENTION_DEMO_FIXTURE.planScheduleConfiguration.plans[
      INTERVENTION_DEMO_FIXTURE.planId
    ];
  if (mapping === undefined || mapping.cycleDefinition !== "fixed-days") {
    return null;
  }
  const offset = calendarDaysBetween(mapping.cycleAnchorDate, date);
  if (offset === null) {
    return null;
  }
  const cycleIndex = Math.floor(offset / mapping.cycleLengthDays);
  const start = addCalendarDays(
    mapping.cycleAnchorDate,
    cycleIndex * mapping.cycleLengthDays,
  );
  const end = start === null
    ? null
    : addCalendarDays(start, mapping.cycleLengthDays - 1);
  return start === null || end === null ? null : { start, end };
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
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).some((key) => key !== "scenario") ||
    typeof parsed.scenario !== "string" ||
    !SCENARIOS.includes(parsed.scenario as FixtureScenario)
  ) {
    return NextResponse.json(
      { ok: false, stage: "validation" },
      { status: 400 },
    );
  }
  const scenario = parsed.scenario as FixtureScenario;

  try {
    const policies = await getDevMerchantPolicyRepository();
    const active = await policies.readActive(
      INTERVENTION_DEMO_FIXTURE.merchantId,
    );
    if (active === null) {
      return NextResponse.json(
        { ok: false, stage: "policy-unresolved" },
        { status: 409 },
      );
    }

    const today = merchantToday();
    const startDate = addCalendarDays(today, 4);
    if (startDate === null) {
      return NextResponse.json({ ok: false, stage: "api" }, { status: 500 });
    }

    const mapped = scenario === "all-options";
    const cycle = mapped ? anchoredCycleFor(startDate) : null;
    if (mapped && cycle === null) {
      return NextResponse.json(
        { ok: false, stage: "configuration" },
        { status: 500 },
      );
    }
    const cycleStart = cycle?.start ?? today;
    const cycleEnd = cycle?.end ?? (addCalendarDays(today, 13) as string);
    // A suggested date inside the assigned cycle, different from the
    // payment date; falls back inside the window when near the boundary.
    let suggestedDate = addCalendarDays(startDate, 2);
    if (suggestedDate === null || suggestedDate > cycleEnd) {
      suggestedDate = addCalendarDays(startDate, -2) ?? startDate;
    }

    const slug = scenario.replace(/[^a-z]/g, "");
    const interventionId = `int_fixture_${slug}`;
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
    const payerId = `pyr_fixture_${slug}`;
    const rawToken = generateInterventionToken();

    const record: DueLogicInterventionRecord = {
      interventionId,
      notificationId: `ntf_fixture_${slug}`,
      tokenHash: hashInterventionToken(rawToken),
      merchantId: INTERVENTION_DEMO_FIXTURE.merchantId,
      payerId,
      sourceId: `src_fixture_${slug}`,
      subscriptionId: `sub_fixture_${slug}`,
      planId: mapped ? INTERVENTION_DEMO_FIXTURE.planId : "pln_fixture_unmapped",
      patternFlagId: `flag_fixture_${slug}`,
      policyVersion: active.policyVersion,
      scheduleCadence: "fortnightly",
      changeMode: "permanent",
      currentStartDate: startDate,
      currentPaymentAmountInCents: 12500,
      currentCycleStartDate: cycleStart,
      currentCycleEndDate: cycleEnd,
      suggestedDate,
      selectedDate: null,
      offeredAlternativeDate: null,
      policyOutcome: null,
      policyReasonCode: null,
      policyRuleFired: null,
      policyExplanation: null,
      policyWarnings: [],
      currentPayments: null,
      proposedPayments: null,
      currency: "AUD",
      confirmationId: null,
      operationId: null,
      newSubscriptionId: null,
      status: "invitation-created",
      createdAt: nowIso,
      expiresAt,
      openedAt: null,
      selectedAt: null,
      declinedAt: null,
      updatedAt: nowIso,
    };
    await getDevInterventionRepository().write(record);
    await getDevInterventionNotificationRepository().write({
      notificationId: record.notificationId,
      interventionId,
      title: "Payment schedule review",
      amountInCents: record.currentPaymentAmountInCents,
      currentScheduledDate: record.currentStartDate,
      expiresAt,
      createdAt: nowIso,
      reviewPath: `/review/${rawToken}`,
    });

    if (scenario !== "review-required") {
      await getDevFixturePaymentRepository().upsert(payerId, {
        id: `pmt_fixture_${slug}`,
        payerId,
        amountInCents: 12500,
        transactionDate: startDate,
        status: "scheduled",
      });
    }

    return NextResponse.json({
      ok: true,
      temporaryStore: true,
      scenario,
      interventionId,
      inboxPath: "/dev/duelogic/inbox",
    });
  } catch (error) {
    // Safe classification only — never tokens or record content.
    console.error("Dev movement-fixture seeding failed.", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ ok: false, stage: "api" }, { status: 500 });
  }
}
