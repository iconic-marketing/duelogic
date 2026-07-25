/**
 * Deterministic validation of the Stage 1 customer-led intervention flow,
 * following the repository's validation convention: the exported async
 * function re-asserts the full scenario table on demand, and one pass is
 * kicked off at module load with loud failure logging.
 *
 * Nothing here calls Pinch or reads a clock: repositories, clock, token
 * generator, token hasher and every subscription/preview read effect are
 * injected fakes over synthetic identifiers. No live merchant, payer,
 * subscription, plan or source IDs appear in the fixtures, and no real
 * token is ever created. The synthetic payment-history seed and the real
 * detector/policy engine are the same frozen deterministic inputs the
 * dashboard renders.
 *
 * The eight Stage 1 scenarios:
 *  s1 scheduled scan creates one invitation for the designated opportunity;
 *  s2 a second scan creates no duplicate active invitation;
 *  s3 an expired invitation cannot select a date;
 *  s4 an approved date obtains the mocked Pinch preview and stores the
 *     exact returned schedule;
 *  s5 an alternative policy result does not execute and requires another
 *     selection;
 *  s6 an ambiguous active-subscription resolution creates no invitation;
 *  s7 decline prevents further preview and leaves confirmationId,
 *     operationId and newSubscriptionId null;
 *  s8 preview-ready leaves those fields null and exposes only a disabled
 *     final confirmation control.
 */

import {
  createInMemoryInterventionNotificationRepository,
  createInMemoryInterventionRepository,
} from "./dev-intervention-store";
import {
  effectiveInterventionStatus,
  toCustomerInterventionProjection,
  toMerchantInterventionProjection,
  type DueLogicInterventionRecord,
  type DueLogicInterventionRepository,
  type InterventionNotificationRepository,
} from "./intervention";
import type { InterventionDemoFixture } from "./intervention-fixture";
import {
  declineIntervention,
  evaluateSelectedDate,
  runScheduledInterventionScan,
  type InterventionPreviewReadEffects,
  type InterventionScanDeps,
} from "./intervention-service";
import { addCalendarDays } from "./calendar-date";
import type {
  SubscriptionDetailSnapshot,
  SubscriptionReadEffects,
} from "./subscription-resolver";
import type { ConfirmedSchedulePayment } from "@/lib/pinch/customer-confirmation";

export interface InterventionValidationRow {
  scenario: string;
  outcome: string;
}

export interface InterventionValidationResult {
  scenarioCount: number;
  decisionTable: InterventionValidationRow[];
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Intervention validation failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Injected deterministic dependencies

/** Strictly increasing synthetic clock; advanceMinutes models waiting. */
function makeClock(startIso: string) {
  let currentMs = Date.parse(startIso);
  return {
    now: (): string => {
      currentMs += 1_000;
      return new Date(currentMs).toISOString();
    },
    advanceMinutes: (minutes: number): void => {
      currentMs += minutes * 60_000;
    },
  };
}

/**
 * Deterministic token deps. The fake hash reverses the raw token so the
 * stored hash never contains the raw token as a substring — letting
 * scenarios assert the raw token appears nowhere in stored intervention
 * state or merchant projections.
 */
function makeTokenDeps() {
  let interventionCounter = 0;
  let notificationCounter = 0;
  let tokenCounter = 0;
  return {
    generateInterventionId: (): string => {
      interventionCounter += 1;
      return `int_demo_${String(interventionCounter).padStart(2, "0")}`;
    },
    generateNotificationId: (): string => {
      notificationCounter += 1;
      return `ntf_demo_${String(notificationCounter).padStart(2, "0")}`;
    },
    generateToken: (): string => {
      tokenCounter += 1;
      return `raw-demo-invitation-${String(tokenCounter).padStart(2, "0")}`;
    },
    hashToken: (raw: string): string =>
      `fakehash:${raw.split("").reverse().join("")}`,
  };
}

// ---------------------------------------------------------------------------
// Synthetic fixtures — no live IDs

const DEMO_FIXTURE: InterventionDemoFixture = {
  merchantId: "mch_demo",
  payerId: "pyr_demo",
  sourceId: "src_demo",
  planId: "pln_demo",
  expectedRecurringAmountCents: 12500,
  scheduleCadence: "fortnightly",
  planScheduleConfiguration: {
    merchantId: "mch_demo",
    plans: {
      pln_demo: {
        cadence: "fortnightly",
        cycleDefinition: "fixed-days",
        cycleLengthDays: 14,
        cycleAnchorDate: "2026-08-11",
      },
    },
  },
  merchantTimezone: "Australia/Sydney",
  designatedSeedPayerId: "payer-01",
  demonstrationPreviousSettledDebitDate: "2026-06-28",
  currentArrearsCents: 0,
  currency: "AUD",
};

/**
 * The synthetic active subscription the fakes serve: starts 2026-08-14
 * inside the anchored cycle 2026-08-11..2026-08-24. With the seed
 * detector's proposedShiftDays of 4 for payer-01, the suggested date is
 * 2026-08-18.
 */
function demoSubscription(): SubscriptionDetailSnapshot {
  return {
    id: "sub_demo_active",
    payerId: "pyr_demo",
    planId: "pln_demo",
    status: "Active",
    startDate: "2026-08-14",
    sourceId: "src_demo",
    recurringAmountCents: 12500,
  };
}

/** Scan clock: before the subscription start, so the schedule is future. */
const SCAN_CLOCK_START = "2026-07-25T00:00:00.000Z";

function makeSubscriptionReads(subscriptions: SubscriptionDetailSnapshot[]) {
  const calls: string[] = [];
  const effects: SubscriptionReadEffects = {
    async listPayerSubscriptions(merchantId, payerId) {
      calls.push(`list:${merchantId}:${payerId}`);
      return subscriptions.map((entry) => ({
        id: entry.id,
        status: entry.status,
      }));
    },
    async readSubscription(merchantId, subscriptionId) {
      calls.push(`read:${subscriptionId}`);
      const found = subscriptions.find(
        (entry) => entry.id === subscriptionId,
      );
      return found === undefined ? null : { ...found };
    },
  };
  return { calls, effects };
}

/** Exactly three fortnightly payments from the requested start date. */
function threePaymentsFrom(startDate: string): ConfirmedSchedulePayment[] {
  return [0, 14, 28].map((days) => ({
    paymentDate: addCalendarDays(startDate, days) as string,
    amountInCents: 12500,
  }));
}

function makePreviewReads(subscription: SubscriptionDetailSnapshot) {
  const calls: string[] = [];
  const effects: InterventionPreviewReadEffects = {
    async readSubscription(merchantId, subscriptionId) {
      calls.push(`subscription:${subscriptionId}`);
      return subscription.id === subscriptionId ? { ...subscription } : null;
    },
    async readPlan(merchantId, planId) {
      calls.push(`plan:${planId}`);
      return { id: planId, requiresTotalAmount: false };
    },
    async readCalculatedPayments(merchantId, planId, startDate) {
      calls.push(`calculated:${startDate}`);
      return threePaymentsFrom(startDate);
    },
  };
  return { calls, effects };
}

interface Harness {
  repository: DueLogicInterventionRepository;
  notifications: InterventionNotificationRepository;
  clock: ReturnType<typeof makeClock>;
  tokenDeps: ReturnType<typeof makeTokenDeps>;
  scanDeps: InterventionScanDeps;
  subscriptionCalls: string[];
}

function makeHarness(
  clockStart: string = SCAN_CLOCK_START,
  subscriptions: SubscriptionDetailSnapshot[] = [demoSubscription()],
): Harness {
  const repository = createInMemoryInterventionRepository();
  const notifications = createInMemoryInterventionNotificationRepository();
  const clock = makeClock(clockStart);
  const tokenDeps = makeTokenDeps();
  const reads = makeSubscriptionReads(subscriptions);
  return {
    repository,
    notifications,
    clock,
    tokenDeps,
    subscriptionCalls: reads.calls,
    scanDeps: {
      repository,
      notifications,
      subscriptionReads: reads.effects,
      now: clock.now,
      ...tokenDeps,
      invitationLifetimeMinutes: 30,
    },
  };
}

/** The raw token issued by the deterministic token deps' first invitation. */
const FIRST_RAW_TOKEN = "raw-demo-invitation-01";

async function scanCreated(
  harness: Harness,
): Promise<DueLogicInterventionRecord> {
  const outcome = await runScheduledInterventionScan(
    DEMO_FIXTURE,
    harness.scanDeps,
  );
  check(
    outcome.outcome === "created",
    `scan must create an invitation (got ${outcome.outcome})`,
  );
  return (outcome as { record: DueLogicInterventionRecord }).record;
}

// ---------------------------------------------------------------------------
// Scenario table

export async function validateInterventionFlow(): Promise<InterventionValidationResult> {
  const table: InterventionValidationRow[] = [];
  const record = (scenario: string, outcome: string): void => {
    table.push({ scenario, outcome });
  };

  // s1: the scheduled scan creates exactly one invitation for the
  // designated eligible opportunity, bound to the resolved subscription and
  // the trusted cycle, holding only the token hash, with the raw token
  // present only in the notification delivery artefact.
  {
    const harness = makeHarness();
    const created = await scanCreated(harness);
    check(
      created.subscriptionId === "sub_demo_active",
      "s1: the invitation must bind the resolved subscription",
    );
    check(
      created.changeMode === "permanent" &&
        created.scheduleCadence === "fortnightly",
      "s1: the invitation must be a permanent fortnightly change",
    );
    check(
      created.currentStartDate === "2026-08-14" &&
        created.currentCycleStartDate === "2026-08-11" &&
        created.currentCycleEndDate === "2026-08-24",
      "s1: the trusted cycle bounds must come from the merchant-held plan mapping",
    );
    check(
      created.suggestedDate === "2026-08-18",
      "s1: the suggested date must be the start date plus the detector's proposed shift",
    );
    check(
      created.patternFlagId.trim() !== "" &&
        created.status === "invitation-created" &&
        created.currentPaymentAmountInCents === 12500,
      "s1: the invitation must carry the pattern flag, status and amount",
    );
    check(
      created.confirmationId === null &&
        created.operationId === null &&
        created.newSubscriptionId === null,
      "s1: Stage 2 fields must start null",
    );
    const stored = await harness.repository.list();
    const notifications = await harness.notifications.list();
    check(
      stored.length === 1 && notifications.length === 1,
      "s1: exactly one intervention and one notification must exist",
    );
    check(
      !JSON.stringify(stored).includes(FIRST_RAW_TOKEN),
      "s1: the raw token must not appear anywhere in stored intervention state",
    );
    check(
      notifications[0].reviewPath === `/review/${FIRST_RAW_TOKEN}` &&
        notifications[0].title === "Payment schedule review" &&
        notifications[0].amountInCents === 12500 &&
        notifications[0].currentScheduledDate === "2026-08-14",
      "s1: the notification delivery artefact must carry the customer link and display fields",
    );
    record("s1-scan-creates-designated-invitation", "created");
  }

  // s2: a second scan run does not create a duplicate active invitation for
  // the same subscription — repeated clicks return the existing invitation.
  {
    const harness = makeHarness();
    const created = await scanCreated(harness);
    const second = await runScheduledInterventionScan(
      DEMO_FIXTURE,
      harness.scanDeps,
    );
    check(
      second.outcome === "already-active",
      "s2: the second scan must report the existing active invitation",
    );
    check(
      second.outcome === "already-active" &&
        second.record.interventionId === created.interventionId,
      "s2: the second scan must reference the same invitation",
    );
    const stored = await harness.repository.list();
    const notifications = await harness.notifications.list();
    check(
      stored.length === 1 && notifications.length === 1,
      "s2: no duplicate intervention or notification may exist",
    );
    record("s2-no-duplicate-active-invitation", "prevented");
  }

  // s3: an expired invitation cannot select a date; the refusal happens
  // before any policy evaluation or preview read.
  {
    const harness = makeHarness();
    const created = await scanCreated(harness);
    harness.clock.advanceMinutes(31);
    const preview = makePreviewReads(demoSubscription());
    const outcome = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: created.suggestedDate },
      DEMO_FIXTURE,
      {
        repository: harness.repository,
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
        previewReads: preview.effects,
      },
    );
    check(
      !outcome.ok && outcome.reason === "expired",
      "s3: an expired invitation must refuse date selection",
    );
    check(
      preview.calls.length === 0,
      "s3: no preview read may run for an expired invitation",
    );
    const stored = await harness.repository.readById(created.interventionId);
    check(
      stored !== null &&
        stored.selectedDate === null &&
        stored.policyOutcome === null &&
        effectiveInterventionStatus(stored, harness.clock.now()) === "expired",
      "s3: the expired invitation must record no selection or decision",
    );
    record("s3-expired-invitation-refuses-selection", "refused");
  }

  // s4: an approved selected date proceeds to the mocked read-only Pinch
  // preview and stores the exact returned current and proposed schedules.
  {
    const harness = makeHarness();
    const created = await scanCreated(harness);
    const preview = makePreviewReads(demoSubscription());
    const outcome = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: "2026-08-18" },
      DEMO_FIXTURE,
      {
        repository: harness.repository,
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
        previewReads: preview.effects,
      },
    );
    check(outcome.ok, "s4: the suggested date must be approved");
    const updated = outcome.ok ? outcome.record : null;
    check(
      updated !== null &&
        updated.status === "preview-ready" &&
        updated.policyOutcome === "approved" &&
        updated.policyReasonCode === "POLICY_APPROVED" &&
        updated.policyRuleFired === "all-policy-rules-passed" &&
        updated.selectedDate === "2026-08-18",
      "s4: the approved decision and rule fired must be persisted",
    );
    check(
      updated !== null &&
        JSON.stringify(updated.currentPayments) ===
          JSON.stringify(threePaymentsFrom("2026-08-14")) &&
        JSON.stringify(updated.proposedPayments) ===
          JSON.stringify(threePaymentsFrom("2026-08-18")),
      "s4: the exact mocked Pinch schedules must be stored unmodified",
    );
    check(
      preview.calls.includes("subscription:sub_demo_active") &&
        preview.calls.includes("plan:pln_demo") &&
        preview.calls.includes("calculated:2026-08-14") &&
        preview.calls.includes("calculated:2026-08-18"),
      "s4: the preview must read the subscription, plan and both schedules",
    );
    check(
      updated !== null && updated.interventionId === created.interventionId,
      "s4: the evaluation must update the created invitation",
    );
    record("s4-approved-date-stores-exact-preview", "preview-ready");
  }

  // s5: an alternative policy result does not execute — no preview read —
  // and requires another selection; selecting the offered next-cycle date
  // then proceeds through a fresh deterministic evaluation to the preview.
  {
    // Later clock: the invitation is created and evaluated on 2026-08-13,
    // so an in-cycle date at or before the evaluation date is unavailable.
    const harness = makeHarness("2026-08-13T00:00:00.000Z");
    await scanCreated(harness);
    const preview = makePreviewReads(demoSubscription());
    const deps = {
      repository: harness.repository,
      now: harness.clock.now,
      hashToken: harness.tokenDeps.hashToken,
      previewReads: preview.effects,
    };
    const alternative = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: "2026-08-12" },
      DEMO_FIXTURE,
      deps,
    );
    check(
      alternative.ok &&
        alternative.record.status === "alternative-offered" &&
        alternative.record.policyOutcome === "next-cycle-alternative" &&
        alternative.record.offeredAlternativeDate === "2026-08-26",
      "s5: the unavailable in-cycle date must yield the derived next-cycle alternative",
    );
    check(
      alternative.ok && alternative.record.proposedPayments === null,
      "s5: an alternative result must store no preview schedule",
    );
    check(
      preview.calls.length === 0,
      "s5: an alternative result must trigger no preview read",
    );
    const outsideWindow = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: "2026-08-27" },
      DEMO_FIXTURE,
      deps,
    );
    check(
      !outsideWindow.ok && outsideWindow.reason === "outside-window",
      "s5: a next-cycle date other than the offered one must be refused",
    );
    const accepted = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: "2026-08-26" },
      DEMO_FIXTURE,
      deps,
    );
    check(
      accepted.ok &&
        accepted.record.status === "preview-ready" &&
        accepted.record.policyOutcome === "approved" &&
        JSON.stringify(accepted.record.proposedPayments) ===
          JSON.stringify(threePaymentsFrom("2026-08-26")),
      "s5: selecting the offered date must re-evaluate deterministically and reach the preview",
    );
    record("s5-alternative-requires-new-selection", "re-evaluated");
  }

  // s6: an ambiguous active-subscription resolution is a development
  // fixture error and creates no invitation and no notification.
  {
    const second: SubscriptionDetailSnapshot = {
      ...demoSubscription(),
      id: "sub_demo_second",
    };
    const harness = makeHarness(SCAN_CLOCK_START, [
      demoSubscription(),
      second,
    ]);
    const outcome = await runScheduledInterventionScan(
      DEMO_FIXTURE,
      harness.scanDeps,
    );
    check(
      outcome.outcome === "fixture-error" &&
        outcome.reason === "subscription-resolution-failed",
      "s6: two equally eligible active subscriptions must be a fixture error",
    );
    const stored = await harness.repository.list();
    const notifications = await harness.notifications.list();
    check(
      stored.length === 0 && notifications.length === 0,
      "s6: an ambiguous resolution must create no invitation or notification",
    );
    record("s6-ambiguous-resolution-creates-nothing", "fixture-error");
  }

  // s7: decline prevents further date selection and preview, is idempotent
  // on repeat, and leaves confirmationId, operationId and
  // newSubscriptionId null.
  {
    const harness = makeHarness();
    const created = await scanCreated(harness);
    const declineDeps = {
      repository: harness.repository,
      now: harness.clock.now,
      hashToken: harness.tokenDeps.hashToken,
    };
    const declined = await declineIntervention(
      { token: FIRST_RAW_TOKEN },
      declineDeps,
    );
    check(
      declined.ok && declined.changed && declined.record.status === "declined",
      "s7: decline must transition the invitation to declined",
    );
    const repeat = await declineIntervention(
      { token: FIRST_RAW_TOKEN },
      declineDeps,
    );
    check(
      repeat.ok && !repeat.changed,
      "s7: a repeated decline must be idempotent",
    );
    const preview = makePreviewReads(demoSubscription());
    const afterDecline = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: created.suggestedDate },
      DEMO_FIXTURE,
      {
        repository: harness.repository,
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
        previewReads: preview.effects,
      },
    );
    check(
      !afterDecline.ok && afterDecline.reason === "declined",
      "s7: a declined invitation must refuse further date selection",
    );
    check(
      preview.calls.length === 0,
      "s7: no preview read may run after decline",
    );
    const stored = await harness.repository.readById(created.interventionId);
    check(
      stored !== null &&
        stored.declinedAt !== null &&
        stored.confirmationId === null &&
        stored.operationId === null &&
        stored.newSubscriptionId === null,
      "s7: decline must leave the Stage 2 fields null",
    );
    record("s7-decline-prevents-preview", "declined");
  }

  // s8: preview-ready leaves confirmationId, operationId and
  // newSubscriptionId null, and the customer projection exposes only a
  // disabled final confirmation control and no internal identifiers; the
  // merchant projection carries no token material.
  {
    const harness = makeHarness();
    const created = await scanCreated(harness);
    const preview = makePreviewReads(demoSubscription());
    const outcome = await evaluateSelectedDate(
      { token: FIRST_RAW_TOKEN, selectedDate: created.suggestedDate },
      DEMO_FIXTURE,
      {
        repository: harness.repository,
        now: harness.clock.now,
        hashToken: harness.tokenDeps.hashToken,
        previewReads: preview.effects,
      },
    );
    check(
      outcome.ok && outcome.record.status === "preview-ready",
      "s8: the approved suggested date must reach preview-ready",
    );
    const stored = await harness.repository.readById(created.interventionId);
    check(
      stored !== null &&
        stored.status === "preview-ready" &&
        stored.confirmationId === null &&
        stored.operationId === null &&
        stored.newSubscriptionId === null,
      "s8: preview-ready must leave the Stage 2 fields null",
    );
    const customerView = toCustomerInterventionProjection(
      stored as DueLogicInterventionRecord,
      harness.clock.now(),
    );
    check(
      customerView.finalConfirmationEnabled === false,
      "s8: the customer projection must keep the final confirmation disabled",
    );
    const customerJson = JSON.stringify(customerView);
    check(
      !customerJson.includes("mch_demo") &&
        !customerJson.includes("pyr_demo") &&
        !customerJson.includes("src_demo") &&
        !customerJson.includes("sub_demo_active") &&
        !customerJson.includes("pln_demo") &&
        !customerJson.includes("tokenHash") &&
        !customerJson.includes(FIRST_RAW_TOKEN),
      "s8: the customer projection must expose no internal IDs or token material",
    );
    const merchantView = toMerchantInterventionProjection(
      stored as DueLogicInterventionRecord,
      harness.clock.now(),
    );
    const merchantJson = JSON.stringify(merchantView);
    check(
      !merchantJson.includes("tokenHash") &&
        !merchantJson.includes(FIRST_RAW_TOKEN) &&
        !merchantJson.includes("/review/"),
      "s8: the merchant projection must expose no token material or customer link",
    );
    record("s8-preview-ready-stage2-seam-disabled", "seam-intact");
  }

  return { scenarioCount: table.length, decisionTable: table };
}

// ---------------------------------------------------------------------------
// Module-load kick-off, mirroring the customer-confirmation validation: one
// full async pass whose failure is logged loudly; the dev intervention scan
// route and the dashboard render re-assert the table on every request.

void validateInterventionFlow().catch((error: unknown) => {
  console.error("Intervention validation failed at module load.", {
    errorClass: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  });
});
