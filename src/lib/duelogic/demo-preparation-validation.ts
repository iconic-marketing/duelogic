/**
 * Deterministic validation of demo preparation: the five prepared
 * scenarios, fresh unique tokens, targeted clearing of exactly the
 * previous demo run, untouched unrelated and live records, accurate
 * evidence labelling, and the no-Pinch / no-OTP / no-SMS preparation
 * guarantees. Follows the repository's validation convention (exported
 * async re-assertion plus a module-load kick-off with loud failure
 * logging).
 *
 * Nothing here calls Pinch or reads a clock. Every repository is an
 * isolated in-memory fake over synthetic identifiers, the clock and
 * token generators are injected, and the first preparation runs with
 * global fetch replaced by a thrower — any attempted network call would
 * fail the suite. Rows d1..d30 map one-to-one onto the approved scenario
 * list for this stage (d25/d26 assert link shape and resolution against
 * the stores; the navigation targets themselves are exercised by the
 * live localhost verification).
 */

import {
  DEMO_PROVENANCE_LABELS,
  LIVE_REPLACEMENT_SUBSCRIPTION_ID,
  prepareDemo,
  toDemoSetupProjection,
  type DemoPreparationDeps,
} from "./demo-preparation";
import {
  createInMemoryDemoManifestRepository,
  type DemoRunManifest,
} from "./dev-demo-store";
import {
  createInMemoryInterventionNotificationRepository,
  createInMemoryInterventionRepository,
  deleteInterventionNotificationsById,
  deleteInterventionRecordsById,
} from "./dev-intervention-store";
import {
  createInMemoryFixturePaymentRepository,
  createInMemoryMovementChoiceRepository,
  deleteFixturePaymentsById,
  deleteMovementChoicesForInterventions,
  type MovementChoiceRecord,
} from "./dev-movement-store";
import {
  createInMemoryOtpChallengeRepository,
  deleteOtpChallengesForInterventions,
} from "./dev-otp-store";
import {
  createInMemoryDevSmsStore,
  deleteSmsMessagesForInterventions,
  type DevSmsMessage,
} from "./dev-sms-store";
import {
  createInMemoryTemporaryConfirmationRepository,
  createInMemoryTemporaryOperationRepository,
  createInMemoryTemporarySelectionRepository,
  createInMemoryTemporaryVerificationRepository,
  deleteTemporaryConfirmationsForInterventions,
  deleteTemporaryOperationsByIdOrIntervention,
  deleteTemporarySelectionsForInterventions,
  deleteTemporaryVerificationsForInterventions,
} from "./dev-temporary-operation-store";
import {
  createInMemoryTransactionVerificationRepository,
  deleteTransactionVerificationsForInterventions,
} from "./dev-transaction-verification-store";
import {
  toCustomerInterventionProjection,
  toMerchantInterventionProjection,
  type DueLogicInterventionRecord,
  type InterventionCustomerNotification,
} from "./intervention";
import { INTERVENTION_DEMO_FIXTURE } from "./intervention-fixture";
import {
  deriveMovementAvailability,
  type MovementAvailabilityDeps,
} from "./movement-availability";
import {
  buildCustomerMovementProjection,
  type MovementProjectionDeps,
} from "./movement-journey";
import type { OtpChallengeRecord } from "./otp-challenge";
import { createInMemoryMerchantPolicyRepository } from "./policy/dev-policy-store";
import { DEFAULT_DUELOGIC_POLICY } from "./policy/rules";
import type {
  TemporaryCustomerConfirmationRecord,
  TemporaryOperationSelection,
  TemporaryPaymentOperationRecord,
  TemporaryTransactionVerificationRecord,
} from "./temporary-operation";
import type { TransactionVerificationRecord } from "./transaction-verification";
import type { AuthoritativePaymentSnapshot } from "@/lib/pinch/payment-movement";

export interface DemoValidationRow {
  scenario: string;
  outcome: string;
}

export interface DemoValidationResult {
  scenarioCount: number;
  decisionTable: DemoValidationRow[];
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Demo-preparation validation failed: ${message}`);
  }
}

function fakeHash(raw: string): string {
  return `fakehash:${raw.split("").reverse().join("")}`;
}

/** Clock fixed so the Sydney evaluation date is 2026-08-01. */
const CLOCK_START = "2026-08-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Harness — isolated maps, injected clock and generators

interface DemoHarness {
  deps: DemoPreparationDeps;
  maps: {
    interventions: Map<string, DueLogicInterventionRecord>;
    notifications: Map<string, InterventionCustomerNotification>;
    payments: Map<
      string,
      { payerId: string; payment: AuthoritativePaymentSnapshot }
    >;
    choices: Map<string, MovementChoiceRecord>;
    selections: Map<string, TemporaryOperationSelection>;
    temporaryVerifications: Map<string, TemporaryTransactionVerificationRecord>;
    temporaryConfirmations: Map<string, TemporaryCustomerConfirmationRecord>;
    operations: Map<string, TemporaryPaymentOperationRecord>;
    challenges: Map<string, OtpChallengeRecord>;
    sms: Map<string, DevSmsMessage>;
    permanentVerifications: Map<string, TransactionVerificationRecord>;
    manifests: Map<string, DemoRunManifest>;
  };
  issuedTokens: string[];
  now(): string;
}

async function makeDemoHarness(): Promise<DemoHarness> {
  const maps: DemoHarness["maps"] = {
    interventions: new Map(),
    notifications: new Map(),
    payments: new Map(),
    choices: new Map(),
    selections: new Map(),
    temporaryVerifications: new Map(),
    temporaryConfirmations: new Map(),
    operations: new Map(),
    challenges: new Map(),
    sms: new Map(),
    permanentVerifications: new Map(),
    manifests: new Map(),
  };
  const policies = createInMemoryMerchantPolicyRepository();
  let currentMs = Date.parse(CLOCK_START);
  const now = (): string => {
    currentMs += 1_000;
    return new Date(currentMs).toISOString();
  };
  await policies.activate({
    policyVersion: DEFAULT_DUELOGIC_POLICY.version,
    merchantId: INTERVENTION_DEMO_FIXTURE.merchantId,
    policy: DEFAULT_DUELOGIC_POLICY,
    activatedAt: now(),
    installedAsInitialDefault: true,
  });
  const issuedTokens: string[] = [];
  let tokenCounter = 0;
  let runCounter = 0;
  return {
    maps,
    issuedTokens,
    now,
    deps: {
      interventions: createInMemoryInterventionRepository(maps.interventions),
      notifications: createInMemoryInterventionNotificationRepository(
        maps.notifications,
      ),
      fixturePayments: createInMemoryFixturePaymentRepository(maps.payments),
      temporarySelections: createInMemoryTemporarySelectionRepository(
        maps.selections,
      ),
      temporaryOperations: createInMemoryTemporaryOperationRepository(
        maps.operations,
      ),
      policies,
      manifests: createInMemoryDemoManifestRepository(maps.manifests),
      deletions: {
        interventionsById: (ids) =>
          deleteInterventionRecordsById(ids, maps.interventions),
        notificationsById: (ids) =>
          deleteInterventionNotificationsById(ids, maps.notifications),
        fixturePaymentsById: (ids) =>
          deleteFixturePaymentsById(ids, maps.payments),
        movementChoicesForInterventions: (ids) =>
          deleteMovementChoicesForInterventions(ids, maps.choices),
        temporarySelectionsForInterventions: (ids) =>
          deleteTemporarySelectionsForInterventions(ids, maps.selections),
        temporaryVerificationsForInterventions: (ids) =>
          deleteTemporaryVerificationsForInterventions(
            ids,
            maps.temporaryVerifications,
          ),
        temporaryConfirmationsForInterventions: (ids) =>
          deleteTemporaryConfirmationsForInterventions(
            ids,
            maps.temporaryConfirmations,
          ),
        temporaryOperationsByIdOrIntervention: (operationIds, interventionIds) =>
          deleteTemporaryOperationsByIdOrIntervention(
            operationIds,
            interventionIds,
            maps.operations,
          ),
        otpChallengesForInterventions: (ids) =>
          deleteOtpChallengesForInterventions(ids, maps.challenges),
        smsMessagesForInterventions: (ids) =>
          deleteSmsMessagesForInterventions(ids, maps.sms),
        transactionVerificationsForInterventions: (ids) =>
          deleteTransactionVerificationsForInterventions(
            ids,
            maps.permanentVerifications,
          ),
      },
      now,
      generateDemoRunId: () => {
        runCounter += 1;
        return `demo-run-${runCounter}`;
      },
      generateToken: () => {
        tokenCounter += 1;
        const token = `demo-token-${tokenCounter}`;
        issuedTokens.push(token);
        return token;
      },
      hashToken: fakeHash,
    },
  };
}

function availabilityDeps(harness: DemoHarness): MovementAvailabilityDeps {
  const payments = createInMemoryFixturePaymentRepository(
    harness.maps.payments,
  );
  return {
    policies: harness.deps.policies,
    interventions: harness.deps.interventions,
    temporaryOperations: harness.deps.temporaryOperations,
    readUpcomingScheduledPayment: (merchantId, payerId) =>
      payments.readUpcomingForPayer(payerId),
    planScheduleConfiguration:
      INTERVENTION_DEMO_FIXTURE.planScheduleConfiguration,
    merchantTimezone: INTERVENTION_DEMO_FIXTURE.merchantTimezone,
    currentArrearsCents: () => 0,
    now: harness.now,
  };
}

function projectionDeps(harness: DemoHarness): MovementProjectionDeps {
  return {
    choices: createInMemoryMovementChoiceRepository(harness.maps.choices),
    selections: createInMemoryTemporarySelectionRepository(
      harness.maps.selections,
    ),
    temporaryVerifications: createInMemoryTemporaryVerificationRepository(
      harness.maps.temporaryVerifications,
    ),
    availability: availabilityDeps(harness),
    now: harness.now,
  };
}

/** An unrelated (non-demo) intervention the preparation must never touch. */
function unrelatedIntervention(
  overrides: Partial<DueLogicInterventionRecord> & { interventionId: string },
): DueLogicInterventionRecord {
  return {
    notificationId: `ntf_${overrides.interventionId}`,
    tokenHash: fakeHash(`raw-${overrides.interventionId}`),
    merchantId: INTERVENTION_DEMO_FIXTURE.merchantId,
    payerId: "pyr_live_unrelated",
    sourceId: "src_live_unrelated",
    subscriptionId: "sub_live_unrelated",
    planId: INTERVENTION_DEMO_FIXTURE.planId,
    patternFlagId: "flag_live_unrelated",
    policyVersion: DEFAULT_DUELOGIC_POLICY.version,
    scheduleCadence: "fortnightly",
    changeMode: "permanent",
    currentStartDate: "2026-08-05",
    currentPaymentAmountInCents: 12500,
    currentCycleStartDate: "2026-07-28",
    currentCycleEndDate: "2026-08-10",
    suggestedDate: "2026-08-07",
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
    status: "opened",
    createdAt: CLOCK_START,
    expiresAt: "2026-09-01T00:00:00.000Z",
    openedAt: CLOCK_START,
    selectedAt: null,
    declinedAt: null,
    updatedAt: CLOCK_START,
    ...overrides,
  };
}

function manifestScenario(manifest: DemoRunManifest, key: string) {
  const scenario = manifest.scenarios.find((s) => s.scenarioKey === key);
  check(scenario !== undefined, `fixture: scenario "${key}" must exist`);
  return scenario as DemoRunManifest["scenarios"][number];
}

function optionKinds(
  result: Awaited<ReturnType<typeof deriveMovementAvailability>>,
): string[] {
  return result.outcome === "resolved"
    ? result.availability.options.map((option) => option.kind)
    : [];
}

// ---------------------------------------------------------------------------
// Scenario table

export async function validateDemoPreparation(): Promise<DemoValidationResult> {
  const table: DemoValidationRow[] = [];
  const record = (scenario: string, outcome: string): void => {
    table.push({ scenario, outcome });
  };

  const harness = await makeDemoHarness();
  const { deps, maps } = harness;

  // Unrelated records seeded BEFORE any preparation: an active non-demo
  // invitation with its notification and an SMS message, an unrelated
  // fixture payment, and the completed live intervention with the active
  // replacement subscription linkage.
  const unrelatedActive = unrelatedIntervention({
    interventionId: "int_live_unrelated",
  });
  const liveCompleted = unrelatedIntervention({
    interventionId: "int_live_completed",
    payerId: "pyr_live_completed",
    subscriptionId: "sub_live_old",
    selectedDate: "2026-08-07",
    policyOutcome: "approved",
    confirmationId: "conf_live_done",
    operationId: "duelogic-int-live-done",
    newSubscriptionId: LIVE_REPLACEMENT_SUBSCRIPTION_ID,
    status: "executed",
  });
  await deps.interventions.write(unrelatedActive);
  await deps.interventions.write(liveCompleted);
  await deps.notifications.write({
    notificationId: "ntf_live_unrelated",
    interventionId: "int_live_unrelated",
    title: "Payment schedule review",
    amountInCents: 12500,
    currentScheduledDate: "2026-08-05",
    expiresAt: "2026-09-01T00:00:00.000Z",
    createdAt: CLOCK_START,
    reviewPath: "/review/raw-int_live_unrelated",
  });
  await createInMemoryDevSmsStore(maps.sms).send({
    smsId: "sms_live_unrelated",
    interventionId: "int_live_unrelated",
    maskedRecipient: "•••• ••• 156",
    body: "Your DueLogic verification code is 654321. It expires in 5 minutes.",
    sentAt: CLOCK_START,
  });
  await deps.fixturePayments.upsert("pyr_live_unrelated", {
    id: "pmt_live_unrelated",
    payerId: "pyr_live_unrelated",
    amountInCents: 12500,
    transactionDate: "2026-08-05",
    status: "scheduled",
  });
  const unrelatedActiveBefore = JSON.stringify(unrelatedActive);
  const liveCompletedBefore = JSON.stringify(liveCompleted);

  // -----------------------------------------------------------------
  // d14 + d1: the first preparation runs with global fetch replaced by a
  // thrower — any Pinch (or other network) call would fail the suite —
  // and creates all five scenarios.
  const originalFetch = globalThis.fetch;
  let firstOutcome: Awaited<ReturnType<typeof prepareDemo>>;
  globalThis.fetch = (() => {
    throw new Error("Demo preparation attempted a network call.");
  }) as typeof fetch;
  try {
    firstOutcome = await prepareDemo(deps);
  } finally {
    globalThis.fetch = originalFetch;
  }
  check(firstOutcome.ok, "d1: the first preparation must succeed");
  const manifest1 = (firstOutcome as { ok: true; manifest: DemoRunManifest })
    .manifest;
  check(
    manifest1.scenarios.length === 5 &&
      JSON.stringify(manifest1.scenarios.map((s) => s.scenarioKey)) ===
        JSON.stringify([
          "temporary-only",
          "all-options",
          "permanent-only",
          "completed-temporary",
          "completed-permanent",
        ]),
    "d1: the first preparation must create all five scenarios",
  );
  for (const scenario of manifest1.scenarios) {
    check(
      maps.interventions.has(scenario.interventionId),
      "d1: every scenario's intervention record must exist",
    );
  }
  record("d1-first-preparation-creates-five", "created");
  record("d14-preparation-makes-no-network-call", "fetch-blocked");

  // d2: exactly three active journey invitations with notifications.
  const journeyScenarios = manifest1.scenarios.filter(
    (s) => s.kind === "customer-journey",
  );
  check(
    journeyScenarios.length === 3 &&
      journeyScenarios.every(
        (s) =>
          s.notificationId !== null &&
          maps.notifications.has(s.notificationId) &&
          maps.interventions.get(s.interventionId)?.status ===
            "invitation-created",
      ),
    "d2: three active journey invitations with notifications must exist",
  );
  record("d2-three-journey-invitations", "created");

  // d3: all review tokens fresh and unique.
  const run1Tokens = manifest1.scenarios.map((s) =>
    s.reviewPath.replace("/review/", ""),
  );
  check(
    run1Tokens.length === 5 &&
      new Set(run1Tokens).size === 5 &&
      run1Tokens.every((token) => harness.issuedTokens.includes(token)),
    "d3: five fresh unique review tokens must be issued",
  );
  record("d3-tokens-fresh-and-unique", "unique");

  // d4: raw tokens exist only inside reviewPath values — never as
  // rendered text in the projection and never in a stored intervention.
  const projection1 = toDemoSetupProjection(manifest1);
  const projectionWithoutPaths = JSON.stringify({
    ...projection1,
    scenarios: projection1.scenarios.map((scenario) => ({
      scenarioKey: scenario.scenarioKey,
      displayLabel: scenario.displayLabel,
      kind: scenario.kind,
      provenanceLabel: scenario.provenanceLabel,
    })),
  });
  const storedInterventions = JSON.stringify([...maps.interventions.values()]);
  check(
    run1Tokens.every(
      (token) =>
        !projectionWithoutPaths.includes(token) &&
        !storedInterventions.includes(token),
    ),
    "d4: raw tokens must appear only inside reviewPath hrefs",
  );
  record("d4-raw-tokens-not-rendered", "href-only");

  // d5-d7: availability per scenario — the policy engine and cadence
  // resolver decide, using the seeded state only.
  const demo1Record = maps.interventions.get(
    manifestScenario(manifest1, "temporary-only").interventionId,
  ) as DueLogicInterventionRecord;
  const demo2Record = maps.interventions.get(
    manifestScenario(manifest1, "all-options").interventionId,
  ) as DueLogicInterventionRecord;
  const demo3Record = maps.interventions.get(
    manifestScenario(manifest1, "permanent-only").interventionId,
  ) as DueLogicInterventionRecord;
  const derived1 = await deriveMovementAvailability(
    demo1Record,
    availabilityDeps(harness),
  );
  check(
    JSON.stringify(optionKinds(derived1)) === JSON.stringify(["temporary"]),
    "d5: the temporary-only scenario must expose only temporary movement",
  );
  record("d5-temporary-only-exposes-temporary", "temporary-only");
  const derived2 = await deriveMovementAvailability(
    demo2Record,
    availabilityDeps(harness),
  );
  const kinds2 = optionKinds(derived2);
  check(
    kinds2.length === 3 &&
      kinds2.includes("temporary") &&
      kinds2.includes("permanent-current-cycle") &&
      kinds2.includes("permanent-next-cycle"),
    "d6: the all-options scenario must expose all three movement kinds",
  );
  record("d6-all-options-exposes-three", "all");
  const derived3 = await deriveMovementAvailability(
    demo3Record,
    availabilityDeps(harness),
  );
  const kinds3 = optionKinds(derived3);
  check(
    !kinds3.includes("temporary") &&
      kinds3.includes("permanent-current-cycle") &&
      kinds3.includes("permanent-next-cycle"),
    "d7: the exhausted temporary limit must hide temporary movement only",
  );
  record("d7-permanent-only-hides-temporary", "hidden-by-limit");

  // d8: the completed temporary result renders correctly.
  const demo4Scenario = manifestScenario(manifest1, "completed-temporary");
  const demo4Record = maps.interventions.get(
    demo4Scenario.interventionId,
  ) as DueLogicInterventionRecord;
  const demo4View = toCustomerInterventionProjection(
    demo4Record,
    harness.now(),
  );
  const demo4Movement = await buildCustomerMovementProjection(
    demo4Record,
    projectionDeps(harness),
  );
  check(
    demo4View.status === "executed" &&
      demo4View.executedMovementKind === "temporary" &&
      demo4View.verifiedTemporaryTransactionDate !== undefined &&
      demo4View.finalConfirmationEnabled === false &&
      demo4Record.confirmationId !== null &&
      demo4Record.operationId !== null &&
      demo4Record.newSubscriptionId === null &&
      demo4Movement.options.length === 0 &&
      demo4Movement.temporaryPreview !== null &&
      demo4Movement.temporaryPreview.currentDate ===
        demo4Record.currentStartDate &&
      demo4Movement.temporaryPreview.newDate ===
        demo4View.verifiedTemporaryTransactionDate &&
      demo4Movement.temporaryPreview.amountInCents === 12500 &&
      demo4Movement.temporaryConfirmationEnabled === false,
    "d8: the completed temporary result must render dates, amount and no controls",
  );
  record("d8-completed-temporary-renders", "executed-no-controls");

  // d9: the completed permanent result renders correctly, with the
  // old-to-new subscription mapping available in the merchant projection.
  const demo5Scenario = manifestScenario(manifest1, "completed-permanent");
  const demo5Record = maps.interventions.get(
    demo5Scenario.interventionId,
  ) as DueLogicInterventionRecord;
  const demo5View = toCustomerInterventionProjection(
    demo5Record,
    harness.now(),
  );
  const demo5Merchant = toMerchantInterventionProjection(
    demo5Record,
    harness.now(),
  );
  check(
    demo5View.status === "executed" &&
      demo5View.executedMovementKind === undefined &&
      demo5View.proposedPayments !== null &&
      demo5View.proposedPayments.length === 3 &&
      demo5View.finalConfirmationEnabled === false &&
      demo5Record.confirmationId !== null &&
      demo5Record.operationId !== null &&
      demo5Merchant.subscriptionId === demo5Record.subscriptionId &&
      demo5Merchant.newSubscriptionId === LIVE_REPLACEMENT_SUBSCRIPTION_ID,
    "d9: the completed permanent result must render the verified schedule with the mapping",
  );
  record("d9-completed-permanent-renders", "executed-with-mapping");

  // d10 + d11: accurate evidence labels, verbatim.
  check(
    demo5Scenario.provenanceLabel ===
      DEMO_PROVENANCE_LABELS["live-sandbox-representation"] &&
      demo5Scenario.provenanceLabel.includes(
        "previously verified live Pinch sandbox result",
      ),
    "d10: the completed permanent result must be labelled as previously verified live evidence",
  );
  record("d10-permanent-labelled-live-evidence", "labelled");
  check(
    demo4Scenario.provenanceLabel === "Deterministic development fixture",
    "d11: the completed temporary result must be labelled as a deterministic fixture",
  );
  record("d11-temporary-labelled-deterministic", "labelled");

  // d12 + d13: preparation issues no OTP and creates no SMS.
  check(
    maps.challenges.size === 0,
    "d12: preparation must issue no OTP challenge",
  );
  record("d12-no-otp-issued", "none");
  const smsAfterPrep = [...maps.sms.values()];
  check(
    smsAfterPrep.length === 1 &&
      smsAfterPrep[0].smsId === "sms_live_unrelated",
    "d13: preparation must create no SMS message",
  );
  record("d13-no-sms-created", "none");

  // -----------------------------------------------------------------
  // Journey artefacts created against run 1 (as a customer walking the
  // demo would), so the second preparation can prove targeted clearing.
  const demo1Id = demo1Record.interventionId;
  const nowIso = harness.now();
  const in5Minutes = new Date(Date.parse(nowIso) + 300_000).toISOString();
  await createInMemoryMovementChoiceRepository(maps.choices).setChoice({
    interventionId: demo1Id,
    kind: "temporary",
    chosenAt: nowIso,
  });
  await deps.temporarySelections.bind({
    kind: "temporary",
    selectionId: "tsel_journey_run1",
    interventionId: demo1Id,
    merchantId: INTERVENTION_DEMO_FIXTURE.merchantId,
    payerId: demo1Record.payerId,
    paymentId: "pmt_journey_run1",
    originalTransactionDate: demo1Record.currentStartDate,
    proposedTransactionDate: demo1Record.suggestedDate,
    amountInCents: 12500,
    currency: "AUD",
    policyVersion: demo1Record.policyVersion,
    policyReasonCode: "POLICY_APPROVED",
    policyRuleFired: "all-policy-rules-passed",
    requestedDate: demo1Record.suggestedDate,
    acceptedAlternativeDate: null,
    createdAt: nowIso,
    expiresAt: in5Minutes,
  });
  await createInMemoryOtpChallengeRepository(maps.challenges).issue({
    kind: "temporary",
    challengeId: "otpch_journey_run1",
    interventionId: demo1Id,
    merchantId: INTERVENTION_DEMO_FIXTURE.merchantId,
    payerId: demo1Record.payerId,
    policyVersion: demo1Record.policyVersion,
    trustedMobileFingerprint: "fp_journey_run1",
    maskedMobile: "•••• ••• 156",
    codeDigest: "digest_journey_run1",
    issuedAt: nowIso,
    expiresAt: in5Minutes,
    verifiedAt: null,
    invalidatedAt: null,
    paymentId: "pmt_journey_run1",
    originalTransactionDate: demo1Record.currentStartDate,
    proposedTransactionDate: demo1Record.suggestedDate,
    amountInCents: 12500,
  });
  await createInMemoryDevSmsStore(maps.sms).send({
    smsId: "sms_journey_run1",
    interventionId: demo1Id,
    maskedRecipient: "•••• ••• 156",
    body: "Your DueLogic verification code is 111222. It expires in 5 minutes.",
    sentAt: nowIso,
  });
  await createInMemoryTemporaryVerificationRepository(
    maps.temporaryVerifications,
  ).create({
    verificationId: "tver_journey_run1",
    kind: "temporary",
    interventionId: demo1Id,
    merchantId: INTERVENTION_DEMO_FIXTURE.merchantId,
    payerId: demo1Record.payerId,
    paymentId: "pmt_journey_run1",
    originalTransactionDate: demo1Record.currentStartDate,
    proposedTransactionDate: demo1Record.suggestedDate,
    amountInCents: 12500,
    policyVersion: demo1Record.policyVersion,
    trustedMobileFingerprint: "fp_journey_run1",
    verifiedAt: nowIso,
    expiresAt: in5Minutes,
    consumedAt: null,
  });
  await createInMemoryTemporaryConfirmationRepository(
    maps.temporaryConfirmations,
  ).create({
    confirmationId: "tconf_journey_run1",
    interventionId: demo1Id,
    merchantId: INTERVENTION_DEMO_FIXTURE.merchantId,
    payerId: demo1Record.payerId,
    paymentId: "pmt_journey_run1",
    originalTransactionDate: demo1Record.currentStartDate,
    confirmedTransactionDate: demo1Record.suggestedDate,
    amountInCents: 12500,
    policyVersion: demo1Record.policyVersion,
    acceptedAt: nowIso,
    consumedAt: null,
    operationId: null,
    status: "accepted",
  });
  await deps.temporaryOperations.write({
    operationId: "top_journey_run1",
    interventionId: demo1Id,
    confirmationId: "tconf_journey_run1",
    merchantId: INTERVENTION_DEMO_FIXTURE.merchantId,
    payerId: demo1Record.payerId,
    paymentId: "pmt_journey_run1",
    originalTransactionDate: demo1Record.currentStartDate,
    proposedTransactionDate: demo1Record.suggestedDate,
    amountInCents: 12500,
    policyVersion: demo1Record.policyVersion,
    createdAt: nowIso,
    updatedAt: nowIso,
    preflightState: "verified",
    mutationState: "not-invoked",
    readBackState: "not-read",
    status: "pending",
    failureStage: null,
    verifiedAt: null,
    verifiedTransactionDate: null,
  });
  const demo2Id = demo2Record.interventionId;
  await createInMemoryTransactionVerificationRepository(
    maps.permanentVerifications,
  ).create({
    verificationId: "ver_journey_run1",
    interventionId: demo2Id,
    merchantId: INTERVENTION_DEMO_FIXTURE.merchantId,
    payerId: demo2Record.payerId,
    subscriptionId: demo2Record.subscriptionId,
    selectedDate: demo2Record.suggestedDate,
    currentPayments: [
      { paymentDate: "2026-08-05", amountInCents: 12500 },
      { paymentDate: "2026-08-19", amountInCents: 12500 },
      { paymentDate: "2026-09-02", amountInCents: 12500 },
    ],
    proposedPayments: [
      { paymentDate: "2026-08-07", amountInCents: 12500 },
      { paymentDate: "2026-08-21", amountInCents: 12500 },
      { paymentDate: "2026-09-04", amountInCents: 12500 },
    ],
    policyVersion: demo2Record.policyVersion,
    verifiedAt: nowIso,
    expiresAt: in5Minutes,
    consumedAt: null,
  });

  const run1HistoryOperationIds = manifestScenario(
    manifest1,
    "permanent-only",
  ).temporaryOperationIds;
  check(
    run1HistoryOperationIds.length === 2 &&
      run1HistoryOperationIds.every((id) => maps.operations.has(id)),
    "fixture: run 1 must have seeded two verified temporary history operations",
  );

  // -----------------------------------------------------------------
  // d15-d22: the second preparation removes only the first demo run.
  const secondOutcome = await prepareDemo(deps);
  check(secondOutcome.ok, "d15: the second preparation must succeed");
  const manifest2 = (secondOutcome as { ok: true; manifest: DemoRunManifest })
    .manifest;
  const run1InterventionIds = manifest1.scenarios.map((s) => s.interventionId);
  check(
    run1InterventionIds.every((id) => !maps.interventions.has(id)) &&
      manifest1.scenarios.every(
        (s) =>
          s.notificationId === null || !maps.notifications.has(s.notificationId),
      ) &&
      manifest1.scenarios.every(
        (s) =>
          s.fixturePaymentId === null || !maps.payments.has(s.fixturePaymentId),
      ) &&
      run1HistoryOperationIds.every((id) => !maps.operations.has(id)) &&
      !maps.choices.has(demo1Id) &&
      !maps.selections.has(demo1Id) &&
      !maps.challenges.has(demo1Id) &&
      !maps.temporaryVerifications.has(demo1Id) &&
      !maps.temporaryConfirmations.has("tconf_journey_run1") &&
      !maps.operations.has("top_journey_run1") &&
      !maps.sms.has("sms_journey_run1") &&
      !maps.permanentVerifications.has(demo2Id),
    "d15: the second preparation must remove every run-1 record and journey artefact",
  );
  check(
    manifest2.scenarios.length === 5 &&
      manifest2.scenarios.every((s) => maps.interventions.has(s.interventionId)),
    "d15: the second preparation must seed one clean set of scenarios",
  );
  record("d15-second-run-clears-first-only", "targeted");

  // d16: fresh tokens on the second preparation.
  const run2Tokens = manifest2.scenarios.map((s) =>
    s.reviewPath.replace("/review/", ""),
  );
  check(
    new Set(run2Tokens).size === 5 &&
      run2Tokens.every((token) => !run1Tokens.includes(token)),
    "d16: the second preparation must issue fresh tokens",
  );
  record("d16-second-run-fresh-tokens", "fresh");

  // d17: old demo links no longer resolve as active demo invitations.
  for (const token of run1Tokens) {
    check(
      (await deps.interventions.readByTokenHash(fakeHash(token))) === null,
      "d17: a run-1 review token must no longer resolve",
    );
  }
  record("d17-old-links-invalidated", "invalid");

  // d18-d22: unrelated and live records remain untouched, including the
  // active replacement subscription reference.
  const unrelatedAfter = await deps.interventions.readById(
    "int_live_unrelated",
  );
  const liveCompletedAfter = await deps.interventions.readById(
    "int_live_completed",
  );
  check(
    unrelatedAfter !== null &&
      JSON.stringify(unrelatedAfter) === unrelatedActiveBefore,
    "d18: unrelated intervention records must remain untouched",
  );
  record("d18-unrelated-interventions-remain", "untouched");
  check(
    maps.notifications.has("ntf_live_unrelated") &&
      maps.payments.has("pmt_live_unrelated"),
    "d19: unrelated notification records must remain untouched",
  );
  record("d19-unrelated-notifications-remain", "untouched");
  check(
    maps.sms.has("sms_live_unrelated"),
    "d20: unrelated SMS records must remain untouched",
  );
  record("d20-unrelated-sms-remains", "untouched");
  check(
    liveCompletedAfter !== null &&
      JSON.stringify(liveCompletedAfter) === liveCompletedBefore,
    "d21: the completed live intervention must remain untouched",
  );
  record("d21-completed-live-intervention-remains", "untouched");
  check(
    liveCompletedAfter !== null &&
      liveCompletedAfter.newSubscriptionId ===
        LIVE_REPLACEMENT_SUBSCRIPTION_ID,
    "d22: the active replacement subscription reference must remain untouched",
  );
  record("d22-replacement-subscription-untouched", "untouched");

  // d23: a browser refresh re-reads the same manifest and creates nothing.
  const interventionCountBefore = maps.interventions.size;
  const refreshRead1 = toDemoSetupProjection(await deps.manifests.read());
  const refreshRead2 = toDemoSetupProjection(await deps.manifests.read());
  check(
    refreshRead1.prepared &&
      refreshRead1.demoRunId === manifest2.demoRunId &&
      JSON.stringify(refreshRead1) === JSON.stringify(refreshRead2) &&
      maps.interventions.size === interventionCountBefore,
    "d23: a browser refresh must not duplicate preparation",
  );
  record("d23-refresh-does-not-duplicate", "read-only");

  // d24: a server restart (fresh process-local stores) reads not prepared.
  const restarted = toDemoSetupProjection(
    await createInMemoryDemoManifestRepository().read(),
  );
  check(
    restarted.prepared === false && restarted.scenarios.length === 0,
    "d24: a server restart must read Demo not prepared",
  );
  record("d24-restart-reads-not-prepared", "not-prepared");

  // d25 + d26: every scenario link is a /review/<token> path whose token
  // resolves to its own stored intervention. (The static navigation
  // targets are exercised by the live localhost verification.)
  for (const scenario of manifest2.scenarios) {
    const token = scenario.reviewPath.replace("/review/", "");
    check(
      scenario.reviewPath === `/review/${token}` && token.length > 0,
      "d25: every scenario link must be a tokenised review path",
    );
    const resolved = await deps.interventions.readByTokenHash(fakeHash(token));
    check(
      resolved !== null && resolved.interventionId === scenario.interventionId,
      "d26: every customer journey link must resolve to its own intervention",
    );
  }
  record("d25-links-are-tokenised-paths", "well-formed");
  record("d26-links-resolve-to-interventions", "resolve");

  // d27: the simulated email source records carry no OTP-like content.
  const demoNotifications = manifest2.scenarios
    .map((s) => s.notificationId)
    .filter((id): id is string => id !== null)
    .map((id) => maps.notifications.get(id));
  check(
    demoNotifications.every(
      (notification) =>
        notification !== undefined &&
        !/\d{6}/.test(JSON.stringify(notification)),
    ),
    "d27: the simulated email records must contain no OTP",
  );
  record("d27-email-inbox-contains-no-otp", "clean");

  // d28: the SMS channel structurally refuses review-link content.
  let smsRefusedReviewLink = false;
  try {
    await createInMemoryDevSmsStore(maps.sms).send({
      smsId: "sms_demo_bad",
      interventionId: manifest2.scenarios[0].interventionId,
      maskedRecipient: "•••• ••• 156",
      body: `Open ${manifest2.scenarios[0].reviewPath} to continue`,
      sentAt: harness.now(),
    });
  } catch {
    smsRefusedReviewLink = true;
  }
  check(
    smsRefusedReviewLink &&
      [...maps.sms.values()].every((message) => !message.body.includes("/review/")),
    "d28: the SMS inbox must never carry a review link",
  );
  record("d28-sms-contains-no-review-link", "structurally-enforced");

  // d29: no internal Pinch identifiers or tokens in any customer-facing
  // projection of the prepared scenarios.
  for (const scenario of manifest2.scenarios) {
    const stored = maps.interventions.get(
      scenario.interventionId,
    ) as DueLogicInterventionRecord;
    const serialised =
      JSON.stringify(toCustomerInterventionProjection(stored, harness.now())) +
      JSON.stringify(
        await buildCustomerMovementProjection(stored, projectionDeps(harness)),
      );
    check(
      !/pyr_|src_|sub_|mch_|pln_|pmt_|int_|ntf_|flag_|conf_|tconf_|tokenHash/.test(
        serialised,
      ) &&
        !serialised.includes(LIVE_REPLACEMENT_SUBSCRIPTION_ID) &&
        run2Tokens.every((token) => !serialised.includes(token)),
      "d29: customer projections must carry no internal identifier or token",
    );
  }
  record("d29-no-identifier-on-customer-pages", "clean");

  // d30: the preparation dependency surface has no execution or Pinch
  // capability — no payment mutation, no replacement invocation, no OTP
  // issuance. (Protected execution files are additionally proven
  // unchanged by the stage's git verification.)
  const depKeys = new Set([
    ...Object.keys(deps),
    ...Object.keys(deps.deletions),
  ]);
  check(
    !depKeys.has("updatePaymentDate") &&
      !depKeys.has("readPayment") &&
      !depKeys.has("readPayerMobile") &&
      !depKeys.has("invokeReplacementRoute") &&
      !depKeys.has("generateOtpCodeNumber") &&
      !depKeys.has("sms") &&
      !depKeys.has("challenges"),
    "d30: the preparation surface must carry no execution, OTP or Pinch capability",
  );
  record("d30-no-execution-capability", "structural");

  return { scenarioCount: table.length, decisionTable: table };
}

// ---------------------------------------------------------------------------
// Module-load kick-off, mirroring the sibling validation modules.

void validateDemoPreparation().catch((error: unknown) => {
  console.error("Demo-preparation validation failed at module load.", {
    errorClass: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  });
});
