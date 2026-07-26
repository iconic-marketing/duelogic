/**
 * Development-only demo preparation: rebuilds the complete process-local
 * DueLogic presentation state in one call, so the demonstration can be
 * recreated with one click after a development-server restart.
 *
 * Pure orchestration over injected repositories, deletion helpers, clock
 * and token functions — this module NEVER imports the Pinch client and
 * preparation makes zero Pinch calls, including reads. It creates
 * deterministic fixture records only, on synthetic fixture payers that
 * are distinct from the live demonstration payer, so live sandbox
 * evidence, live merchant history and the completed live intervention are
 * never touched. It never issues an OTP and never writes an SMS message.
 *
 * Targeted clearing: every record a preparation run creates is listed in
 * the demo-run manifest, and the next run deletes exactly those records
 * (and journey artefacts keyed to those intervention IDs) before seeding
 * afresh — unrelated interventions, notifications, SMS messages and all
 * live records remain untouched. No clear-all path exists here.
 *
 * The five prepared scenarios:
 * 1. temporary-only        — unmapped plan + fixture payment → only
 *                            "Move this payment only".
 * 2. all-options           — mapped demo plan + fixture payment → all
 *                            three movement choices.
 * 3. permanent-only        — mapped plan + fixture payment + two seeded
 *                            verified temporary operations, so the
 *                            engine's rolling temporary limit genuinely
 *                            hides the temporary option.
 * 4. completed-temporary   — a deterministic development fixture rendered
 *                            as an executed temporary movement.
 * 5. completed-permanent   — a development REPRESENTATION of the
 *                            previously verified live Pinch sandbox
 *                            replacement; it references the known
 *                            replacement subscription ID internally and
 *                            is never presented as a new live execution.
 */

import { addCalendarDays } from "./calendar-date";
import type {
  DemoManifestRepository,
  DemoManifestScenario,
  DemoRunManifest,
  DemoScenarioKey,
} from "./dev-demo-store";
import type { FixturePaymentRepository } from "./dev-movement-store";
import type {
  TemporaryOperationRepository,
  TemporaryOperationSelectionRepository,
} from "./dev-temporary-operation-store";
import type {
  DueLogicInterventionRecord,
  DueLogicInterventionRepository,
  InterventionNotificationRepository,
} from "./intervention";
import { DEV_INTERVENTION_INVITATION_LIFETIME_MINUTES } from "./intervention";
import {
  anchoredDemoPlanCycleContaining,
  INTERVENTION_DEMO_FIXTURE,
} from "./intervention-fixture";
import type { MerchantPolicyRepository } from "./policy/policy-snapshot";
import type { TemporaryPaymentOperationRecord } from "./temporary-operation";

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts.
if (typeof window !== "undefined") {
  throw new Error(
    "The demo preparation service is server-only and must not be imported into browser code.",
  );
}

/**
 * The verified live replacement subscription from the completed sandbox
 * execution. Referenced INTERNALLY by the completed-permanent
 * representation only — never rendered on a customer page, never mutated
 * and never re-read from Pinch during preparation.
 */
export const LIVE_REPLACEMENT_SUBSCRIPTION_ID = "sub_eQMjuw9iGUbjww";

/** Customer-safe display labels — the approved wording, verbatim. */
export const DEMO_SCENARIO_LABELS: Record<DemoScenarioKey, string> = {
  "temporary-only": "Demo 1: Move one payment",
  "all-options": "Demo 2: Choose from all available options",
  "permanent-only": "Demo 3: Permanent schedule correction",
  "completed-temporary": "Completed result: Temporary payment move",
  "completed-permanent": "Completed result: Permanent schedule correction",
};

/** Visible evidence labels — accurate provenance, verbatim. */
export const DEMO_PROVENANCE_LABELS = {
  "development-scenario": "Development scenario",
  "deterministic-development-fixture": "Deterministic development fixture",
  "live-sandbox-representation":
    "Development representation of a previously verified live Pinch sandbox result",
} as const;

/**
 * Injected targeted deletion surface: each function removes only the
 * records named by ID or belonging to the named demo interventions. The
 * development composition binds these to the shared dev-store helpers;
 * validation binds them to its own isolated maps.
 */
export interface DemoTargetedDeletions {
  interventionsById(interventionIds: readonly string[]): number;
  notificationsById(notificationIds: readonly string[]): number;
  fixturePaymentsById(paymentIds: readonly string[]): number;
  movementChoicesForInterventions(interventionIds: readonly string[]): number;
  temporarySelectionsForInterventions(
    interventionIds: readonly string[],
  ): number;
  temporaryVerificationsForInterventions(
    interventionIds: readonly string[],
  ): number;
  temporaryConfirmationsForInterventions(
    interventionIds: readonly string[],
  ): number;
  temporaryOperationsByIdOrIntervention(
    operationIds: readonly string[],
    interventionIds: readonly string[],
  ): number;
  otpChallengesForInterventions(interventionIds: readonly string[]): number;
  smsMessagesForInterventions(interventionIds: readonly string[]): number;
  transactionVerificationsForInterventions(
    interventionIds: readonly string[],
  ): number;
}

export interface DemoPreparationDeps {
  interventions: DueLogicInterventionRepository;
  notifications: InterventionNotificationRepository;
  fixturePayments: FixturePaymentRepository;
  temporarySelections: TemporaryOperationSelectionRepository;
  temporaryOperations: TemporaryOperationRepository;
  policies: MerchantPolicyRepository;
  manifests: DemoManifestRepository;
  deletions: DemoTargetedDeletions;
  now(): string;
  generateDemoRunId(): string;
  generateToken(): string;
  hashToken(rawToken: string): string;
}

export type PrepareDemoOutcome =
  | { ok: true; manifest: DemoRunManifest }
  | { ok: false; reason: "policy-unresolved" | "configuration" | "store" };

/** Fixture payment amount used by every demo scenario: $125.00. */
const DEMO_AMOUNT_CENTS = 12500;

function merchantCalendarDateOfInstant(iso: string): string | null {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: INTERVENTION_DEMO_FIXTURE.merchantTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(parsed));
}

/**
 * Removes exactly the previous run's records: the manifest-listed IDs plus
 * the journey artefacts keyed to those intervention IDs (choices,
 * selections, verifications, confirmations, operation evidence, OTP
 * challenges and SMS messages the customer journey may have created since
 * that run was prepared). Nothing outside the previous manifest's tracked
 * set is ever touched.
 */
function clearPreviousDemoRun(
  previous: DemoRunManifest,
  deletions: DemoTargetedDeletions,
): void {
  const interventionIds = previous.scenarios.map(
    (scenario) => scenario.interventionId,
  );
  const notificationIds = previous.scenarios
    .map((scenario) => scenario.notificationId)
    .filter((id): id is string => id !== null);
  const paymentIds = previous.scenarios
    .map((scenario) => scenario.fixturePaymentId)
    .filter((id): id is string => id !== null);
  const operationIds = previous.scenarios.flatMap(
    (scenario) => scenario.temporaryOperationIds,
  );
  // Journey and channel artefacts first, then the invitation records.
  deletions.smsMessagesForInterventions(interventionIds);
  deletions.otpChallengesForInterventions(interventionIds);
  deletions.temporaryVerificationsForInterventions(interventionIds);
  deletions.transactionVerificationsForInterventions(interventionIds);
  deletions.temporaryConfirmationsForInterventions(interventionIds);
  deletions.temporaryOperationsByIdOrIntervention(
    operationIds,
    interventionIds,
  );
  deletions.temporarySelectionsForInterventions(interventionIds);
  deletions.movementChoicesForInterventions(interventionIds);
  deletions.fixturePaymentsById(paymentIds);
  deletions.notificationsById(notificationIds);
  deletions.interventionsById(interventionIds);
}

interface JourneyRecordParams {
  interventionId: string;
  notificationId: string;
  tokenHash: string;
  payerId: string;
  sourceId: string;
  subscriptionId: string;
  planId: string;
  patternFlagId: string;
  policyVersion: string;
  startDate: string;
  cycleStart: string;
  cycleEnd: string;
  suggestedDate: string;
  nowIso: string;
  expiresAt: string;
}

/** A fresh invitation-created record, mirroring the scan-created shape. */
function journeyRecord(params: JourneyRecordParams): DueLogicInterventionRecord {
  return {
    interventionId: params.interventionId,
    notificationId: params.notificationId,
    tokenHash: params.tokenHash,
    merchantId: INTERVENTION_DEMO_FIXTURE.merchantId,
    payerId: params.payerId,
    sourceId: params.sourceId,
    subscriptionId: params.subscriptionId,
    planId: params.planId,
    patternFlagId: params.patternFlagId,
    policyVersion: params.policyVersion,
    scheduleCadence: "fortnightly",
    changeMode: "permanent",
    currentStartDate: params.startDate,
    currentPaymentAmountInCents: DEMO_AMOUNT_CENTS,
    currentCycleStartDate: params.cycleStart,
    currentCycleEndDate: params.cycleEnd,
    suggestedDate: params.suggestedDate,
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
    createdAt: params.nowIso,
    expiresAt: params.expiresAt,
    openedAt: null,
    selectedAt: null,
    declinedAt: null,
    updatedAt: params.nowIso,
  };
}

/** A seeded verified temporary operation for the rolling-limit history. */
function verifiedTemporaryHistoryOperation(params: {
  operationId: string;
  interventionId: string;
  confirmationId: string;
  payerId: string;
  paymentId: string;
  policyVersion: string;
  verifiedAtIso: string;
}): TemporaryPaymentOperationRecord | null {
  const verifiedDate = merchantCalendarDateOfInstant(params.verifiedAtIso);
  const movedDate =
    verifiedDate === null ? null : addCalendarDays(verifiedDate, 2);
  if (verifiedDate === null || movedDate === null) {
    return null;
  }
  return {
    operationId: params.operationId,
    interventionId: params.interventionId,
    confirmationId: params.confirmationId,
    merchantId: INTERVENTION_DEMO_FIXTURE.merchantId,
    payerId: params.payerId,
    paymentId: params.paymentId,
    originalTransactionDate: verifiedDate,
    proposedTransactionDate: movedDate,
    amountInCents: DEMO_AMOUNT_CENTS,
    policyVersion: params.policyVersion,
    createdAt: params.verifiedAtIso,
    updatedAt: params.verifiedAtIso,
    preflightState: "verified",
    mutationState: "invoked",
    readBackState: "verified",
    status: "temporary-change-verified",
    failureStage: null,
    verifiedAt: params.verifiedAtIso,
    verifiedTransactionDate: movedDate,
  };
}

/**
 * Prepares the complete demo state: clears exactly the previous demo run
 * (when one is recorded), seeds the five scenarios with fresh secure
 * tokens, writes the new manifest and returns it. The manifest is
 * replaced BEFORE the new records are written so every created record is
 * always tracked — a failure mid-seeding leaves a manifest whose next
 * "Prepare demo" run cleans up completely and reseeds.
 */
export async function prepareDemo(
  deps: DemoPreparationDeps,
): Promise<PrepareDemoOutcome> {
  // The active saved merchant policy governs the new invitations' bound
  // version, exactly as the scheduled scan binds it. Missing → refuse
  // safely, create nothing.
  let policyVersion: string;
  try {
    const active = await deps.policies.readActive(
      INTERVENTION_DEMO_FIXTURE.merchantId,
    );
    if (active === null) {
      return { ok: false, reason: "policy-unresolved" };
    }
    policyVersion = active.policyVersion;
  } catch {
    return { ok: false, reason: "store" };
  }

  const nowIso = deps.now();
  const nowMs = Date.parse(nowIso);
  const today = merchantCalendarDateOfInstant(nowIso);
  const startDate = today === null ? null : addCalendarDays(today, 4);
  if (Number.isNaN(nowMs) || today === null || startDate === null) {
    return { ok: false, reason: "configuration" };
  }
  const mappedCycle = anchoredDemoPlanCycleContaining(startDate);
  if (mappedCycle === null) {
    return { ok: false, reason: "configuration" };
  }
  const expiresAt = new Date(
    nowMs + DEV_INTERVENTION_INVITATION_LIFETIME_MINUTES * 60_000,
  ).toISOString();

  // A suggested date inside the assigned cycle, different from the payment
  // date; falls back inside the window when near the boundary.
  const suggestedFor = (cycleEnd: string): string => {
    const forward = addCalendarDays(startDate, 2);
    if (forward !== null && forward <= cycleEnd) {
      return forward;
    }
    return addCalendarDays(startDate, -2) ?? startDate;
  };

  const demoRunId = deps.generateDemoRunId();
  const runSuffix =
    demoRunId.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || "run";
  const id = (prefix: string, key: string): string =>
    `${prefix}_fixture_demo_${runSuffix}_${key}`;

  // Clear ONLY the previous demo run before seeding the new one.
  try {
    const previous = await deps.manifests.read();
    if (previous !== null) {
      clearPreviousDemoRun(previous, deps.deletions);
    }
  } catch {
    return { ok: false, reason: "store" };
  }

  // ---------------------------------------------------------------------
  // Scenario construction (records assembled first, then persisted).

  const scenarios: DemoManifestScenario[] = [];
  const records: DueLogicInterventionRecord[] = [];
  const notifications: Array<{
    record: DueLogicInterventionRecord;
    rawToken: string;
  }> = [];
  const payments: Array<{ payerId: string; paymentId: string; date: string }> =
    [];
  const historyOperations: TemporaryPaymentOperationRecord[] = [];

  const unmappedCycleEnd = addCalendarDays(today, 13);
  if (unmappedCycleEnd === null) {
    return { ok: false, reason: "configuration" };
  }

  const journeyScenario = (
    key: DemoScenarioKey,
    slug: string,
    planId: string,
    cycle: { start: string; end: string },
  ): { record: DueLogicInterventionRecord; rawToken: string } => {
    const rawToken = deps.generateToken();
    const record = journeyRecord({
      interventionId: id("int", slug),
      notificationId: id("ntf", slug),
      tokenHash: deps.hashToken(rawToken),
      payerId: `pyr_fixture_demo_${slug}`,
      sourceId: `src_fixture_demo_${slug}`,
      subscriptionId: `sub_fixture_demo_${slug}`,
      planId,
      patternFlagId: `flag_fixture_demo_${slug}`,
      policyVersion,
      startDate,
      cycleStart: cycle.start,
      cycleEnd: cycle.end,
      suggestedDate: suggestedFor(cycle.end),
      nowIso,
      expiresAt,
    });
    records.push(record);
    notifications.push({ record, rawToken });
    const paymentId = id("pmt", slug);
    payments.push({ payerId: record.payerId, paymentId, date: startDate });
    scenarios.push({
      scenarioKey: key,
      displayLabel: DEMO_SCENARIO_LABELS[key],
      kind: "customer-journey",
      provenance: "development-scenario",
      provenanceLabel: DEMO_PROVENANCE_LABELS["development-scenario"],
      interventionId: record.interventionId,
      notificationId: record.notificationId,
      reviewPath: `/review/${rawToken}`,
      fixturePaymentId: paymentId,
      temporaryOperationIds: [],
      temporarySelectionBound: false,
    });
    return { record, rawToken };
  };

  // Scenario 1 — temporary only: unmapped plan disables both permanent
  // modes; the fixture payment enables the temporary option.
  journeyScenario(
    "temporary-only",
    "demo1",
    "pln_fixture_unmapped",
    { start: today, end: unmappedCycleEnd },
  );

  // Scenario 2 — all options: the mapped demo plan with in-window dates
  // plus a fixture payment offers all three movement choices.
  journeyScenario("all-options", "demo2", INTERVENTION_DEMO_FIXTURE.planId, {
    start: mappedCycle.start,
    end: mappedCycle.end,
  });

  // Scenario 3 — permanent only: same mapped state, but two seeded
  // VERIFIED temporary operations on this scenario's own synthetic payer
  // exhaust the rolling temporary allowance, so the engine itself hides
  // the temporary option. Deterministic development history only — never
  // fabricated on the completed live payer.
  const demo3 = journeyScenario(
    "permanent-only",
    "demo3",
    INTERVENTION_DEMO_FIXTURE.planId,
    { start: mappedCycle.start, end: mappedCycle.end },
  );
  const historyIds: string[] = [];
  for (const [index, daysAgo] of [35, 70].entries()) {
    const operation = verifiedTemporaryHistoryOperation({
      operationId: `duelogic-tmp-fixture-demo-${runSuffix}-h${index + 1}`,
      interventionId: id("int", `demo3hist${index + 1}`),
      confirmationId: id("tconf", `demo3hist${index + 1}`),
      payerId: demo3.record.payerId,
      paymentId: id("pmt", `demo3hist${index + 1}`),
      policyVersion,
      verifiedAtIso: new Date(nowMs - daysAgo * 86_400_000).toISOString(),
    });
    if (operation === null) {
      return { ok: false, reason: "configuration" };
    }
    historyOperations.push(operation);
    historyIds.push(operation.operationId);
  }
  scenarios[scenarios.length - 1] = {
    ...scenarios[scenarios.length - 1],
    temporaryOperationIds: historyIds,
  };

  // Scenario 4 — completed temporary result: a deterministic development
  // fixture. The Pinch payment ID is retained by a temporary movement, so
  // newSubscriptionId stays null; the bound selection carries the original
  // date and amount the completed page renders.
  const demo4Token = deps.generateToken();
  const demo4NewDate = addCalendarDays(startDate, 2);
  if (demo4NewDate === null) {
    return { ok: false, reason: "configuration" };
  }
  const demo4Record: DueLogicInterventionRecord = {
    ...journeyRecord({
      interventionId: id("int", "demo4"),
      notificationId: id("ntf", "demo4"),
      tokenHash: deps.hashToken(demo4Token),
      payerId: "pyr_fixture_demo_demo4",
      sourceId: "src_fixture_demo_demo4",
      subscriptionId: "sub_fixture_demo_demo4",
      planId: "pln_fixture_unmapped",
      patternFlagId: "flag_fixture_demo_demo4",
      policyVersion,
      startDate,
      cycleStart: today,
      cycleEnd: unmappedCycleEnd,
      suggestedDate: demo4NewDate,
      nowIso,
      expiresAt,
    }),
    selectedDate: demo4NewDate,
    selectedAt: nowIso,
    policyOutcome: "approved",
    confirmationId: id("tconf", "demo4"),
    operationId: `duelogic-tmp-fixture-demo-${runSuffix}-d4`,
    newSubscriptionId: null,
    executedMovementKind: "temporary",
    verifiedTemporaryTransactionDate: demo4NewDate,
    status: "executed",
  };
  records.push(demo4Record);
  scenarios.push({
    scenarioKey: "completed-temporary",
    displayLabel: DEMO_SCENARIO_LABELS["completed-temporary"],
    kind: "completed-result",
    provenance: "deterministic-development-fixture",
    provenanceLabel:
      DEMO_PROVENANCE_LABELS["deterministic-development-fixture"],
    interventionId: demo4Record.interventionId,
    notificationId: null,
    reviewPath: `/review/${demo4Token}`,
    fixturePaymentId: null,
    temporaryOperationIds: [],
    temporarySelectionBound: true,
  });

  // Scenario 5 — completed permanent result: a development representation
  // of the previously verified live Pinch sandbox replacement. The known
  // replacement subscription is referenced internally only; nothing is
  // read from or written to Pinch, and no customer page renders the ID.
  const demo5Token = deps.generateToken();
  const demo5NewStart = addCalendarDays(startDate, 2);
  const fortnight = (base: string, cycles: number): string | null =>
    addCalendarDays(base, 14 * cycles);
  const schedule = (base: string | null) => {
    if (base === null) {
      return null;
    }
    const second = fortnight(base, 1);
    const third = fortnight(base, 2);
    if (second === null || third === null) {
      return null;
    }
    return [
      { paymentDate: base, amountInCents: DEMO_AMOUNT_CENTS },
      { paymentDate: second, amountInCents: DEMO_AMOUNT_CENTS },
      { paymentDate: third, amountInCents: DEMO_AMOUNT_CENTS },
    ];
  };
  const demo5Current = schedule(startDate);
  const demo5Proposed = schedule(demo5NewStart);
  if (demo5NewStart === null || demo5Current === null || demo5Proposed === null) {
    return { ok: false, reason: "configuration" };
  }
  const demo5Record: DueLogicInterventionRecord = {
    ...journeyRecord({
      interventionId: id("int", "demo5"),
      notificationId: id("ntf", "demo5"),
      tokenHash: deps.hashToken(demo5Token),
      payerId: "pyr_fixture_demo_demo5",
      sourceId: "src_fixture_demo_demo5",
      subscriptionId: "sub_fixture_demo_demo5",
      planId: INTERVENTION_DEMO_FIXTURE.planId,
      patternFlagId: "flag_fixture_demo_demo5",
      policyVersion,
      startDate,
      cycleStart: mappedCycle.start,
      cycleEnd: mappedCycle.end,
      suggestedDate: demo5NewStart,
      nowIso,
      expiresAt,
    }),
    selectedDate: demo5NewStart,
    selectedAt: nowIso,
    policyOutcome: "approved",
    currentPayments: demo5Current,
    proposedPayments: demo5Proposed,
    confirmationId: id("conf", "demo5"),
    operationId: `duelogic-int-fixture-demo-${runSuffix}-d5`,
    newSubscriptionId: LIVE_REPLACEMENT_SUBSCRIPTION_ID,
    status: "executed",
  };
  records.push(demo5Record);
  scenarios.push({
    scenarioKey: "completed-permanent",
    displayLabel: DEMO_SCENARIO_LABELS["completed-permanent"],
    kind: "completed-result",
    provenance: "live-sandbox-representation",
    provenanceLabel: DEMO_PROVENANCE_LABELS["live-sandbox-representation"],
    interventionId: demo5Record.interventionId,
    notificationId: null,
    reviewPath: `/review/${demo5Token}`,
    fixturePaymentId: null,
    temporaryOperationIds: [],
    temporarySelectionBound: false,
  });

  const manifest: DemoRunManifest = {
    demoRunId,
    preparedAt: nowIso,
    scenarios,
  };

  // ---------------------------------------------------------------------
  // Persist: manifest first (every created record is tracked even if a
  // later write fails — the next run then cleans up completely), then the
  // records, payments, history evidence, selection and notifications.
  try {
    await deps.manifests.replace(manifest);
    for (const record of records) {
      await deps.interventions.write(record);
    }
    for (const payment of payments) {
      await deps.fixturePayments.upsert(payment.payerId, {
        id: payment.paymentId,
        payerId: payment.payerId,
        amountInCents: DEMO_AMOUNT_CENTS,
        transactionDate: payment.date,
        status: "scheduled",
      });
    }
    for (const operation of historyOperations) {
      await deps.temporaryOperations.write(operation);
    }
    await deps.temporarySelections.bind({
      kind: "temporary",
      selectionId: id("tsel", "demo4"),
      interventionId: demo4Record.interventionId,
      merchantId: INTERVENTION_DEMO_FIXTURE.merchantId,
      payerId: demo4Record.payerId,
      paymentId: id("pmt", "demo4"),
      originalTransactionDate: startDate,
      proposedTransactionDate: demo4NewDate,
      amountInCents: DEMO_AMOUNT_CENTS,
      currency: "AUD",
      policyVersion,
      policyReasonCode: "POLICY_APPROVED",
      policyRuleFired: "all-policy-rules-passed",
      requestedDate: demo4NewDate,
      acceptedAlternativeDate: null,
      createdAt: nowIso,
      expiresAt,
    });
    for (const { record, rawToken } of notifications) {
      await deps.notifications.write({
        notificationId: record.notificationId,
        interventionId: record.interventionId,
        title: "Payment schedule review",
        amountInCents: record.currentPaymentAmountInCents,
        currentScheduledDate: record.currentStartDate,
        expiresAt,
        createdAt: nowIso,
        reviewPath: `/review/${rawToken}`,
      });
    }
  } catch {
    return { ok: false, reason: "store" };
  }

  return { ok: true, manifest };
}

// ---------------------------------------------------------------------------
// Customer-safe projection for the Demo Setup page and route response

export interface DemoSetupScenarioLink {
  scenarioKey: DemoScenarioKey;
  displayLabel: string;
  kind: "customer-journey" | "completed-result";
  provenanceLabel: string;
  /** Href use only — never rendered as visible text. */
  reviewPath: string;
}

export interface DemoSetupProjection {
  prepared: boolean;
  demoRunId: string | null;
  preparedAt: string | null;
  scenarios: DemoSetupScenarioLink[];
}

/**
 * The page and route projection: labels, provenance and review paths
 * only. No merchant, payer, payment, subscription, plan or source IDs, no
 * notification or operation IDs and no policy internals.
 */
export function toDemoSetupProjection(
  manifest: DemoRunManifest | null,
): DemoSetupProjection {
  if (manifest === null) {
    return { prepared: false, demoRunId: null, preparedAt: null, scenarios: [] };
  }
  return {
    prepared: true,
    demoRunId: manifest.demoRunId,
    preparedAt: manifest.preparedAt,
    scenarios: manifest.scenarios.map((scenario) => ({
      scenarioKey: scenario.scenarioKey,
      displayLabel: scenario.displayLabel,
      kind: scenario.kind,
      provenanceLabel: scenario.provenanceLabel,
      reviewPath: scenario.reviewPath,
    })),
  };
}
