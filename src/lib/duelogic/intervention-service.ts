/**
 * Customer-led intervention service: the scheduled scan, customer open,
 * deterministic date evaluation with read-only Pinch preview, decline, and
 * (Stage 2) customer-confirmed execution through the existing protected
 * replacement path.
 *
 * Policy binding: the scan resolves the active saved merchant policy
 * snapshot once and stores its policyVersion on the intervention; customer
 * date evaluation resolves that exact stored version through the injected
 * snapshot repository. A later activation never alters a pending
 * invitation, and an unresolvable bound version refuses safely with no
 * preview and no fallback.
 *
 * Every function takes injected dependencies (repositories, clock, token
 * generator, token hasher, read-only subscription/preview effects, and the
 * replacement-path invoker), so the deterministic validation suite drives
 * these exact code paths with fakes and no network access. The dev routes
 * supply the real implementations.
 *
 * Nothing in THIS module mutates Pinch: every injected Pinch effect here is
 * a read, and execution happens only inside the injected
 * executeReplacementPath — the existing protected replacement route/flow,
 * invoked unchanged, which performs its own fresh Pinch preflight,
 * confirmation consumption, recovery-record write, cancellation, creation
 * and verification, and never retries a mutation. The deterministic policy
 * engine decides eligibility; Pinch remains authoritative for schedule
 * content — preview dates are never generated or substituted locally.
 *
 * Execution is gated (CLAUDE.md "Customer transaction verification"):
 * possession of the tokenised review link alone never authorises a
 * mutation. Every customer-facing surface must pass
 * requireTransactionVerification — which demands a valid verified
 * transaction-verification record bound to the exact intervention and
 * schedule — before confirmInterventionExecution may be called. No write
 * path for verification records exists yet, so the gate refuses everywhere
 * today; the later OTP stage adds record creation without changing
 * confirmInterventionExecution.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { addCalendarDays, parseCalendarDate } from "./calendar-date";
import {
  DEV_INTERVENTION_INVITATION_LIFETIME_MINUTES,
  effectiveInterventionStatus,
  findForbiddenInterventionRecordKey,
  transactionVerificationExpectationFor,
  type DueLogicInterventionRecord,
  type DueLogicInterventionRepository,
  type InterventionCustomerNotification,
  type InterventionNotificationRepository,
  type InterventionStatus,
} from "./intervention";
import type { InterventionDemoFixture } from "./intervention-fixture";
import {
  evaluateScheduleChange,
  PolicyValidationError,
  type PermanentPolicyEvaluationRequest,
} from "./policy/engine";
import { resolvePlanScheduleContext } from "./policy/plan-schedule-resolver";
import type {
  MerchantPolicyRepository,
  MerchantPolicySnapshot,
} from "./policy/policy-snapshot";
import { toPriorScheduleChanges } from "./prior-change-history";
import type { PriorScheduleChange } from "./schema";
import { buildSeedPolicyEvaluations } from "./seed-policy-evaluations";
import {
  resolveActiveSubscription,
  type SubscriptionDetailSnapshot,
  type SubscriptionReadEffects,
} from "./subscription-resolver";
import {
  evaluateTransactionVerification,
  type TransactionVerificationRecord,
  type TransactionVerificationRepository,
} from "./transaction-verification";
import type { ConfirmedSchedulePayment } from "@/lib/pinch/customer-confirmation";
import {
  createCustomerConfirmation,
  respondToCustomerConfirmation,
  type CustomerConfirmationServiceDeps,
} from "@/lib/pinch/customer-confirmation-service";

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts: the
// `server-only` package is not installed in this project, so fail at import
// time if this module ever reaches browser code.
if (typeof window !== "undefined") {
  throw new Error(
    "The intervention service is server-only and must not be imported into browser code.",
  );
}

// ---------------------------------------------------------------------------
// Shared dependency types

export interface InterventionTokenDeps {
  generateInterventionId(): string;
  generateNotificationId(): string;
  /** Returns a raw, unguessable link token. Never stored or logged. */
  generateToken(): string;
  /** One-way hash of the raw token; only the hash is stored. */
  hashToken(rawToken: string): string;
}

export interface InterventionScanDeps extends InterventionTokenDeps {
  repository: DueLogicInterventionRepository;
  notifications: InterventionNotificationRepository;
  /** Read-only subscription discovery effects — never a mutation. */
  subscriptionReads: SubscriptionReadEffects;
  /**
   * The saved merchant policy snapshots. The scan resolves the active
   * snapshot once and binds its policyVersion to the created intervention;
   * there is no silent fallback to the frozen default.
   */
  policies: MerchantPolicyRepository;
  /** Returns the current ISO timestamp. Injected — never a hidden clock. */
  now(): string;
  invitationLifetimeMinutes: number;
}

/**
 * Read-only live-preview effects for an approved customer date. Each is
 * strictly GET-shaped; implementations return null when a response cannot
 * be interpreted safely. Payments arrive already ordered by the proven
 * recurringPaymentIndex sequence with merchant-timezone calendar dates.
 */
export interface InterventionPreviewReadEffects {
  readSubscription(
    merchantId: string,
    subscriptionId: string,
  ): Promise<SubscriptionDetailSnapshot | null>;
  readPlan(
    merchantId: string,
    planId: string,
  ): Promise<{ id: string; requiresTotalAmount?: boolean } | null>;
  readCalculatedPayments(
    merchantId: string,
    planId: string,
    startDate: string,
    totalAmountCents?: number,
  ): Promise<ConfirmedSchedulePayment[] | null>;
}

export interface InterventionRespondDeps {
  repository: DueLogicInterventionRepository;
  /**
   * The saved merchant policy snapshots. Customer date evaluation resolves
   * the intervention's stored policyVersion — never the currently active
   * policy and never a frozen-default fallback.
   */
  policies: MerchantPolicyRepository;
  now(): string;
  hashToken(rawToken: string): string;
  previewReads: InterventionPreviewReadEffects;
}

/**
 * The calendar date of an ISO instant in the merchant timezone. The
 * timezone comes from the fixture (development proof value); production
 * must use Merchant.timezone. en-CA renders numeric dates as YYYY-MM-DD.
 */
export function merchantCalendarDateOfIso(
  nowIso: string,
  timezone: string,
): string | null {
  const parsed = Date.parse(nowIso);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(parsed));
}

/** Write followed by verified read-back, the repository convention. */
async function writeAndVerify(
  repository: DueLogicInterventionRepository,
  record: DueLogicInterventionRecord,
): Promise<boolean> {
  try {
    await repository.write(record);
    const readBack = await repository.readById(record.interventionId);
    return (
      readBack !== null && JSON.stringify(readBack) === JSON.stringify(record)
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scheduled intervention scan

export type ScheduledScanOutcome =
  | {
      outcome: "created";
      record: DueLogicInterventionRecord;
      notification: InterventionCustomerNotification;
    }
  | { outcome: "already-active"; record: DueLogicInterventionRecord }
  | {
      outcome: "policy-review-required";
      /**
       * Merchant-safe vocabulary only — never intervention records, policy
       * JSON or reason internals. The decision came from the policy engine
       * under the active saved policy and the payer's derived history.
       */
      reason: "permanent-change-limit-reached";
      detail: string;
    }
  | {
      outcome: "fixture-error";
      /** Safe stage vocabulary only — never response content. */
      reason:
        | "clock-unreadable"
        | "policy-resolution-failed"
        | "no-designated-opportunity"
        | "designated-payer-mismatch"
        | "subscription-resolution-failed"
        | "cycle-resolution-failed"
        | "unsuitable-for-invitation";
      detail: string;
    }
  | { outcome: "store-error"; detail: string };

/**
 * The localhost-only development action representing the production
 * scheduled process — never merchant approval. Runs the existing detector
 * over the frozen demonstration history, selects the designated qualifying
 * opportunity deterministically, verifies the frozen policy result,
 * resolves the current active live subscription read-only, resolves the
 * trusted cycle from the merchant-held plan configuration, verifies
 * suitability, prevents duplicate active invitations for the same
 * subscription, and creates exactly one intervention record plus one
 * customer notification. Infers nothing about payday, income, employment,
 * hardship or affordability.
 */
export async function runScheduledInterventionScan(
  fixture: InterventionDemoFixture,
  deps: InterventionScanDeps,
): Promise<ScheduledScanOutcome> {
  const nowIso = deps.now();
  const scanDate = merchantCalendarDateOfIso(nowIso, fixture.merchantTimezone);
  if (scanDate === null) {
    return {
      outcome: "fixture-error",
      reason: "clock-unreadable",
      detail: "The injected clock produced an unreadable timestamp.",
    };
  }

  // 1a. Resolve the active saved merchant policy — selected once, here at
  // creation time, and authoritative for this intervention's whole life.
  // A missing, unreadable or inconsistent snapshot fails safely with no
  // invitation; there is no silent fallback to the frozen default.
  let activeSnapshot: MerchantPolicySnapshot | null;
  try {
    activeSnapshot = await deps.policies.readActive(fixture.merchantId);
  } catch {
    activeSnapshot = null;
  }
  if (
    activeSnapshot === null ||
    activeSnapshot.policyVersion !== activeSnapshot.policy.version
  ) {
    return {
      outcome: "fixture-error",
      reason: "policy-resolution-failed",
      detail:
        "No consistent active merchant policy snapshot could be resolved for the scan.",
    };
  }
  const scanPolicy = activeSnapshot.policy;

  // 1-3. Synthetic evidence: detector output and the policy evaluations
  // over the seeded history, evaluated under the active saved policy. The
  // designated opportunity is the first approved evaluation in payer-ID
  // order and it must match the fixture's explicit designation.
  const { flags, policyItems } = buildSeedPolicyEvaluations(scanPolicy);
  const designated = [...policyItems]
    .sort((a, b) => a.payer.id.localeCompare(b.payer.id))
    .find((item) => item.decision.outcome === "approved");
  if (designated === undefined) {
    return {
      outcome: "fixture-error",
      reason: "no-designated-opportunity",
      detail:
        "No approved frozen policy evaluation exists in the seeded history.",
    };
  }
  if (designated.payer.id !== fixture.designatedSeedPayerId) {
    return {
      outcome: "fixture-error",
      reason: "designated-payer-mismatch",
      detail:
        "The first approved frozen evaluation does not match the fixture's designated payer.",
    };
  }

  // The designated payer's detector flag carries the pattern evidence ID
  // and the proposed shift worth testing.
  const patternFlag =
    flags.find((entry) => entry.payerId === designated.payer.id) ?? null;
  if (patternFlag === null) {
    return {
      outcome: "fixture-error",
      reason: "no-designated-opportunity",
      detail: "The designated payer has no detector flag.",
    };
  }

  // 4. Read-only resolution of the current active live subscription.
  const resolution = await resolveActiveSubscription(
    {
      merchantId: fixture.merchantId,
      payerId: fixture.payerId,
      planId: fixture.planId,
      sourceId: fixture.sourceId,
      expectedRecurringAmountCents: fixture.expectedRecurringAmountCents,
      scanDate,
    },
    deps.subscriptionReads,
  );
  if (resolution.outcome === "fixture-error") {
    return {
      outcome: "fixture-error",
      reason: "subscription-resolution-failed",
      detail: `Active-subscription resolution failed: ${resolution.reason}.`,
    };
  }
  const subscription = resolution.subscription;

  // 5. Trusted cycle from the merchant-held plan configuration. The next
  // payment date derives from the configured 14-day cycle structure —
  // trusted schedule metadata, never inferred from payment spacing.
  const nextPaymentDate = addCalendarDays(subscription.startDate, 14);
  if (nextPaymentDate === null) {
    return {
      outcome: "fixture-error",
      reason: "cycle-resolution-failed",
      detail: "The resolved start date could not be advanced by one cycle.",
    };
  }
  let cycle;
  try {
    cycle = resolvePlanScheduleContext(
      {
        merchantId: fixture.merchantId,
        planId: fixture.planId,
        currentPaymentDate: subscription.startDate,
        nextPaymentDate,
      },
      fixture.planScheduleConfiguration,
    );
  } catch (error) {
    return {
      outcome: "fixture-error",
      reason: "cycle-resolution-failed",
      detail:
        error instanceof PolicyValidationError
          ? `Plan schedule resolution failed with ${error.code}.`
          : "Plan schedule resolution failed.",
    };
  }
  if (cycle.outcome !== "resolved") {
    return {
      outcome: "fixture-error",
      reason: "cycle-resolution-failed",
      detail: `Plan schedule resolution escalated with ${cycle.reasonCode}.`,
    };
  }
  if (cycle.scheduleCadence !== fixture.scheduleCadence) {
    return {
      outcome: "fixture-error",
      reason: "cycle-resolution-failed",
      detail: "The resolved cadence does not match the fixture cadence.",
    };
  }

  // 6. Suitability for an automatic invitation: the detector-derived
  // suggestion must land inside the assigned cycle on a different day, and
  // the amount must sit within the policy's automatic ceiling.
  const suggestedDate = addCalendarDays(
    subscription.startDate,
    patternFlag.proposedShiftDays,
  );
  if (
    suggestedDate === null ||
    suggestedDate < cycle.currentCycleStartDate ||
    suggestedDate > cycle.currentCycleEndDate ||
    suggestedDate === subscription.startDate
  ) {
    return {
      outcome: "fixture-error",
      reason: "unsuitable-for-invitation",
      detail:
        "The detector-derived suggested date does not fall usably inside the assigned billing cycle.",
    };
  }
  if (fixture.expectedRecurringAmountCents > scanPolicy.amountCeilingCents) {
    return {
      outcome: "fixture-error",
      reason: "unsuitable-for-invitation",
      detail:
        "The payment amount exceeds the active policy's automatic ceiling.",
    };
  }

  // 6b. Verified prior-change history and the candidate policy decision.
  // History is derived from the trusted intervention records and keyed by
  // the payer — a verified correction on a since-replaced (cancelled)
  // subscription still counts, so a new subscription ID can never reset the
  // rolling allowance. The engine is the sole authority for rolling-window
  // counting and escalation: the scan never counts uses or compares dates
  // against the rolling period itself. The listed records also serve the
  // duplicate-prevention check below.
  let existingRecords: DueLogicInterventionRecord[];
  try {
    existingRecords = await deps.repository.list();
  } catch {
    return {
      outcome: "store-error",
      detail: "The intervention store could not be listed.",
    };
  }
  const priorChanges = toPriorScheduleChanges(
    existingRecords,
    fixture.payerId,
    fixture.merchantTimezone,
  );
  let candidateDecision;
  try {
    // The same trusted request construction customer date evaluation uses:
    // merchant-held identity, amount, cadence and cycle metadata, with the
    // detector-derived suggested date as the candidate anchor.
    candidateDecision = evaluateScheduleChange(
      {
        changeType: "permanent",
        payerId: fixture.payerId,
        paymentId: `${subscription.id}-first-payment`,
        amountCents: fixture.expectedRecurringAmountCents,
        evaluationDate: scanDate,
        currentArrearsCents: fixture.currentArrearsCents,
        scheduleCadence: cycle.scheduleCadence,
        effectiveCycle: "current-and-future",
        previousPaymentDate: fixture.demonstrationPreviousSettledDebitDate,
        currentPaymentDate: subscription.startDate,
        nextPaymentDate,
        currentCycleStartDate: cycle.currentCycleStartDate,
        currentCycleEndDate: cycle.currentCycleEndDate,
        nextCycleStartDate: cycle.nextCycleStartDate,
        nextCycleEndDate: cycle.nextCycleEndDate,
        requestedAnchorDate: suggestedDate,
      },
      priorChanges,
      scanPolicy,
    );
  } catch (error) {
    if (error instanceof PolicyValidationError) {
      return {
        outcome: "fixture-error",
        reason: "unsuitable-for-invitation",
        detail: `Candidate policy evaluation failed with ${error.code}.`,
      };
    }
    throw error;
  }
  if (
    candidateDecision.outcome === "escalate" &&
    candidateDecision.reasonCode === "PERMANENT_CHANGE_LIMIT_REACHED"
  ) {
    // The payer's automatic permanent allowance is exhausted: merchant
    // review is required, and no routine invitation, token, notification
    // or preview may be produced. Every other policy outcome preserves the
    // existing invitation behaviour — the customer's own date selection is
    // still evaluated under the intervention-bound snapshot.
    return {
      outcome: "policy-review-required",
      reason: "permanent-change-limit-reached",
      detail:
        "The rolling permanent-change allowance for this customer is exhausted; the opportunity requires merchant review.",
    };
  }

  // 9 (before creation). Duplicate prevention: one active invitation per
  // subscription. Only an expired invitation may be replaced; repeated scan
  // clicks return the existing invitation unchanged.
  const active = existingRecords.find(
    (record) =>
      record.subscriptionId === subscription.id &&
      effectiveInterventionStatus(record, nowIso) !== "expired",
  );
  if (active !== undefined) {
    return { outcome: "already-active", record: active };
  }

  // 7-8. Create the intervention record and its customer notification.
  const createdMs = Date.parse(nowIso);
  if (Number.isNaN(createdMs)) {
    return {
      outcome: "fixture-error",
      reason: "clock-unreadable",
      detail: "The injected clock produced an unreadable timestamp.",
    };
  }
  const rawToken = deps.generateToken();
  const record: DueLogicInterventionRecord = {
    interventionId: deps.generateInterventionId(),
    notificationId: deps.generateNotificationId(),
    tokenHash: deps.hashToken(rawToken),
    merchantId: fixture.merchantId,
    payerId: fixture.payerId,
    sourceId: fixture.sourceId,
    subscriptionId: subscription.id,
    planId: fixture.planId,
    patternFlagId: patternFlag.id,
    // The governing policy is bound at creation; later activations never
    // alter this invitation.
    policyVersion: activeSnapshot.policyVersion,
    scheduleCadence: cycle.scheduleCadence,
    changeMode: "permanent",
    currentStartDate: subscription.startDate,
    currentPaymentAmountInCents: fixture.expectedRecurringAmountCents,
    currentCycleStartDate: cycle.currentCycleStartDate,
    currentCycleEndDate: cycle.currentCycleEndDate,
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
    expiresAt: new Date(
      createdMs + deps.invitationLifetimeMinutes * 60_000,
    ).toISOString(),
    openedAt: null,
    selectedAt: null,
    declinedAt: null,
    updatedAt: nowIso,
  };
  if (findForbiddenInterventionRecordKey(record) !== null) {
    return {
      outcome: "store-error",
      detail: "The intervention record carried forbidden sensitive material.",
    };
  }
  if (!(await writeAndVerify(deps.repository, record))) {
    return {
      outcome: "store-error",
      detail: "The intervention record could not be read back after writing.",
    };
  }

  // The notification is the customer delivery artefact — the single place
  // the raw token may exist after this function returns. It is
  // customer-facing only and never appears in merchant monitoring.
  const notification: InterventionCustomerNotification = {
    notificationId: record.notificationId,
    interventionId: record.interventionId,
    title: "Payment schedule review",
    amountInCents: record.currentPaymentAmountInCents,
    currentScheduledDate: record.currentStartDate,
    expiresAt: record.expiresAt,
    createdAt: nowIso,
    reviewPath: `/review/${rawToken}`,
  };
  try {
    await deps.notifications.write(notification);
  } catch {
    return {
      outcome: "store-error",
      detail: "The customer notification could not be written.",
    };
  }

  return { outcome: "created", record, notification };
}

// ---------------------------------------------------------------------------
// Customer open

/**
 * Resolves an intervention from its raw link token and records the first
 * open. The token is hashed and looked up — an interventionId supplied by a
 * customer is never trusted. Terminal and expired records are returned
 * unchanged so the page can render their state honestly.
 */
export async function openIntervention(
  input: { token: string },
  deps: Pick<InterventionRespondDeps, "repository" | "now" | "hashToken">,
): Promise<DueLogicInterventionRecord | null> {
  const record = await deps.repository.readByTokenHash(
    deps.hashToken(input.token.trim()),
  );
  if (record === null) {
    return null;
  }
  const nowIso = deps.now();
  const status = effectiveInterventionStatus(record, nowIso);
  if (status !== "invitation-created") {
    return record;
  }
  const opened: DueLogicInterventionRecord = {
    ...record,
    status: "opened",
    openedAt: nowIso,
    updatedAt: nowIso,
  };
  return (await writeAndVerify(deps.repository, opened)) ? opened : record;
}

// ---------------------------------------------------------------------------
// Customer date evaluation

export type EvaluateSelectedDateOutcome =
  | { ok: true; record: DueLogicInterventionRecord }
  | {
      ok: false;
      reason:
        | "not-found"
        | "expired"
        | "declined"
        | "escalated"
        | "invalid-date"
        | "outside-window"
        | "not-evaluable"
        | "policy-unresolved"
        | "preview-unavailable"
        | "store";
      record?: DueLogicInterventionRecord;
    };

/** Statuses from which a customer may (re-)check a date. */
const CHECKABLE_STATUSES: ReadonlySet<InterventionStatus> = new Set([
  "invitation-created",
  "opened",
  "awaiting-date-selection",
  "alternative-offered",
  "date-approved",
  "preview-ready",
]);

/**
 * Evaluates one customer-selected date. Every identity, amount, cadence and
 * cycle input comes from the server-held intervention record and fixture —
 * nothing from the browser is trusted beyond the token and the date string.
 * The deterministic policy engine decides; an approved date then obtains
 * the exact read-only Pinch schedule preview through the injected effects,
 * and only then does the record reach preview-ready.
 */
export async function evaluateSelectedDate(
  input: {
    token: string;
    selectedDate: string;
    /**
     * Customer chose the permanent NEXT-CYCLE movement: dates inside the
     * resolved next assigned cycle evaluate with next-cycle-and-future
     * semantics (the engine still decides). Absent = existing behaviour.
     */
    nextCycleIntent?: boolean;
  },
  fixture: InterventionDemoFixture,
  deps: InterventionRespondDeps,
): Promise<EvaluateSelectedDateOutcome> {
  const record = await deps.repository.readByTokenHash(
    deps.hashToken(input.token.trim()),
  );
  if (record === null) {
    return { ok: false, reason: "not-found" };
  }

  const nowIso = deps.now();
  const status = effectiveInterventionStatus(record, nowIso);
  if (status === "expired" || status === "declined" || status === "escalated") {
    return { ok: false, reason: status, record };
  }
  if (!CHECKABLE_STATUSES.has(status)) {
    return { ok: false, reason: "not-evaluable", record };
  }

  // The intervention-bound immutable policy: the version stored at
  // creation is authoritative for every later evaluation on this
  // invitation — a newer activation never alters it. An unresolvable or
  // inconsistent bound version refuses here, before any evaluation or
  // preview read; there is no fallback to the currently active policy or
  // the frozen default.
  let boundSnapshot: MerchantPolicySnapshot | null;
  try {
    boundSnapshot = await deps.policies.readByVersion(
      record.merchantId,
      record.policyVersion,
    );
  } catch {
    boundSnapshot = null;
  }
  if (
    boundSnapshot === null ||
    boundSnapshot.merchantId !== record.merchantId ||
    boundSnapshot.policyVersion !== record.policyVersion ||
    boundSnapshot.policyVersion !== boundSnapshot.policy.version
  ) {
    return { ok: false, reason: "policy-unresolved", record };
  }

  // A refused selection returns the record to awaiting-date-selection so
  // the recorded state says a new selection is required; no policy decision
  // is recorded for it.
  const refuseSelection = async (
    reason: "invalid-date" | "outside-window",
  ): Promise<EvaluateSelectedDateOutcome> => {
    const awaiting: DueLogicInterventionRecord = {
      ...record,
      status: "awaiting-date-selection",
      openedAt: record.openedAt ?? nowIso,
      updatedAt: nowIso,
    };
    const persisted = await writeAndVerify(deps.repository, awaiting);
    return { ok: false, reason, record: persisted ? awaiting : record };
  };

  const selectedDate = input.selectedDate.trim();
  if (parseCalendarDate(selectedDate) === null) {
    return refuseSelection("invalid-date");
  }

  // The permitted window is the assigned current billing cycle; the
  // exceptions are the exact next-cycle date the policy engine itself
  // offered, and — when the customer explicitly chose the next-cycle
  // movement — any date inside the resolved next assigned cycle (checked
  // below once the trusted cycle context is re-derived). The engine
  // remains the deciding authority in every branch.
  let effectiveCycle: PermanentPolicyEvaluationRequest["effectiveCycle"] | null;
  if (
    selectedDate >= record.currentCycleStartDate &&
    selectedDate <= record.currentCycleEndDate
  ) {
    effectiveCycle = "current-and-future";
  } else if (
    record.offeredAlternativeDate !== null &&
    selectedDate === record.offeredAlternativeDate
  ) {
    effectiveCycle = "next-cycle-and-future";
  } else if (input.nextCycleIntent === true) {
    // Deferred: validated against the resolved next-cycle bounds below.
    effectiveCycle = null;
  } else {
    return refuseSelection("outside-window");
  }

  const evaluationDate = merchantCalendarDateOfIso(
    nowIso,
    fixture.merchantTimezone,
  );
  if (evaluationDate === null) {
    return { ok: false, reason: "not-evaluable", record };
  }

  // Re-derive the trusted cycle context from the merchant-held plan
  // configuration and require it to still match the invitation. The next
  // payment date derives from the configured 14-day cycle structure.
  const nextPaymentDate = addCalendarDays(record.currentStartDate, 14);
  if (nextPaymentDate === null) {
    return { ok: false, reason: "not-evaluable", record };
  }
  let cycle;
  try {
    cycle = resolvePlanScheduleContext(
      {
        merchantId: record.merchantId,
        planId: record.planId,
        currentPaymentDate: record.currentStartDate,
        nextPaymentDate,
      },
      fixture.planScheduleConfiguration,
    );
  } catch {
    return { ok: false, reason: "not-evaluable", record };
  }
  if (
    cycle.outcome !== "resolved" ||
    cycle.currentCycleStartDate !== record.currentCycleStartDate ||
    cycle.currentCycleEndDate !== record.currentCycleEndDate
  ) {
    return { ok: false, reason: "not-evaluable", record };
  }

  // Deferred next-cycle window: the explicitly chosen next-cycle movement
  // accepts only dates inside the resolved next assigned cycle.
  if (effectiveCycle === null) {
    if (
      selectedDate >= cycle.nextCycleStartDate &&
      selectedDate <= cycle.nextCycleEndDate
    ) {
      effectiveCycle = "next-cycle-and-future";
    } else {
      return refuseSelection("outside-window");
    }
  }

  const request: PermanentPolicyEvaluationRequest = {
    changeType: "permanent",
    payerId: record.payerId,
    paymentId: `${record.subscriptionId}-first-payment`,
    amountCents: record.currentPaymentAmountInCents,
    evaluationDate,
    currentArrearsCents: fixture.currentArrearsCents,
    scheduleCadence: record.scheduleCadence,
    effectiveCycle,
    previousPaymentDate: fixture.demonstrationPreviousSettledDebitDate,
    currentPaymentDate: record.currentStartDate,
    nextPaymentDate,
    currentCycleStartDate: cycle.currentCycleStartDate,
    currentCycleEndDate: cycle.currentCycleEndDate,
    nextCycleStartDate: cycle.nextCycleStartDate,
    nextCycleEndDate: cycle.nextCycleEndDate,
    requestedAnchorDate: selectedDate,
  };

  // Verified prior-change history for this payer, derived from the trusted
  // server-held intervention records — an executed correction on a
  // since-replaced subscription still counts because history follows the
  // payer, never the subscription ID. The engine (under the
  // intervention-bound snapshot resolved above) remains the sole authority
  // for rolling-window counting; an exhausted permanent allowance escalates
  // here, before any Pinch preview read.
  let priorChanges: readonly PriorScheduleChange[];
  try {
    priorChanges = toPriorScheduleChanges(
      await deps.repository.list(),
      record.payerId,
      fixture.merchantTimezone,
    );
  } catch {
    return { ok: false, reason: "store", record };
  }

  let decision;
  try {
    decision = evaluateScheduleChange(request, priorChanges, boundSnapshot.policy);
  } catch (error) {
    if (error instanceof PolicyValidationError) {
      // e.g. the selected date equals the current payment date. Customer
      // sees a safe "choose a different date"; the code stays server-side.
      return refuseSelection("outside-window");
    }
    throw error;
  }
  if (decision.outcome === "shorter-alternative") {
    // Unreachable for a permanent request; kept as a deterministic guard.
    return { ok: false, reason: "not-evaluable", record };
  }

  const decided: DueLogicInterventionRecord = {
    ...record,
    selectedDate,
    selectedAt: nowIso,
    openedAt: record.openedAt ?? nowIso,
    policyOutcome: decision.outcome,
    policyReasonCode: decision.reasonCode,
    policyRuleFired: decision.ruleFired,
    policyExplanation: decision.explanation,
    policyWarnings: decision.warnings,
    // A fresh decision supersedes any previous preview content.
    currentPayments: null,
    proposedPayments: null,
    updatedAt: nowIso,
    status:
      decision.outcome === "approved"
        ? "date-approved"
        : decision.outcome === "next-cycle-alternative"
          ? "alternative-offered"
          : "escalated",
    offeredAlternativeDate:
      decision.outcome === "next-cycle-alternative"
        ? decision.derivedNextCycleAnchorDate
        : record.offeredAlternativeDate,
  };
  if (!(await writeAndVerify(deps.repository, decided))) {
    return { ok: false, reason: "store", record };
  }
  if (decision.outcome !== "approved") {
    return { ok: true, record: decided };
  }
  if (decision.changeType !== "permanent") {
    // Unreachable for a permanent request; kept as a deterministic guard.
    return { ok: false, reason: "not-evaluable", record: decided };
  }

  // Approved: obtain the exact read-only Pinch preview. All reads; any
  // failure leaves the record at date-approved so the customer can retry a
  // read safely — reads are never a manual-recovery state.
  const subscription = await deps.previewReads.readSubscription(
    record.merchantId,
    record.subscriptionId,
  );
  if (
    subscription === null ||
    subscription.id !== record.subscriptionId ||
    subscription.status.toLowerCase() !== "active" ||
    subscription.payerId !== record.payerId ||
    subscription.planId !== record.planId ||
    (subscription.sourceId !== undefined &&
      subscription.sourceId !== record.sourceId) ||
    subscription.startDate !== record.currentStartDate
  ) {
    return { ok: false, reason: "preview-unavailable", record: decided };
  }

  const plan = await deps.previewReads.readPlan(
    record.merchantId,
    record.planId,
  );
  if (plan === null || plan.id !== record.planId) {
    return { ok: false, reason: "preview-unavailable", record: decided };
  }
  let totalAmountCents: number | undefined;
  if (plan.requiresTotalAmount === true) {
    if (subscription.totalAmountCents === undefined) {
      return { ok: false, reason: "preview-unavailable", record: decided };
    }
    totalAmountCents = subscription.totalAmountCents;
  }

  const currentPayments = await deps.previewReads.readCalculatedPayments(
    record.merchantId,
    record.planId,
    record.currentStartDate,
    totalAmountCents,
  );
  const proposedPayments = await deps.previewReads.readCalculatedPayments(
    record.merchantId,
    record.planId,
    decision.firstRevisedPaymentDate,
    totalAmountCents,
  );
  // Exactly three current and three proposed payments are required; the
  // stored schedules are the exact Pinch-returned dates and amounts.
  if (
    currentPayments === null ||
    proposedPayments === null ||
    currentPayments.length < 3 ||
    proposedPayments.length < 3
  ) {
    return { ok: false, reason: "preview-unavailable", record: decided };
  }
  const exactThree = (
    payments: ConfirmedSchedulePayment[],
  ): ConfirmedSchedulePayment[] =>
    payments.slice(0, 3).map((payment) => ({ ...payment }));

  const previewReady: DueLogicInterventionRecord = {
    ...decided,
    currentPayments: exactThree(currentPayments),
    proposedPayments: exactThree(proposedPayments),
    status: "preview-ready",
    updatedAt: deps.now(),
  };
  if (!(await writeAndVerify(deps.repository, previewReady))) {
    return { ok: false, reason: "store", record: decided };
  }
  return { ok: true, record: previewReady };
}

// ---------------------------------------------------------------------------
// Customer decline

export type DeclineInterventionOutcome =
  | { ok: true; changed: boolean; record: DueLogicInterventionRecord }
  | {
      ok: false;
      reason:
        | "not-found"
        | "expired"
        | "escalated"
        | "executing"
        | "executed"
        | "manual-recovery-required"
        | "store";
      record?: DueLogicInterventionRecord;
    };

/**
 * Applies a customer's decline. Permitted from any pre-execution state;
 * repeats are idempotent; expired invitations accept no response; an
 * escalated case stays with the merchant; once execution has begun
 * (executing, executed or manual-recovery-required) a decline is refused —
 * an executed or in-flight replacement cannot be undone by declining.
 * Declining performs no Pinch call, creates no confirmation record and
 * leaves confirmationId, operationId and newSubscriptionId null.
 */
export async function declineIntervention(
  input: { token: string },
  deps: Pick<InterventionRespondDeps, "repository" | "now" | "hashToken">,
): Promise<DeclineInterventionOutcome> {
  const record = await deps.repository.readByTokenHash(
    deps.hashToken(input.token.trim()),
  );
  if (record === null) {
    return { ok: false, reason: "not-found" };
  }
  const nowIso = deps.now();
  const status = effectiveInterventionStatus(record, nowIso);
  if (status === "declined") {
    return { ok: true, changed: false, record };
  }
  if (
    status === "expired" ||
    status === "escalated" ||
    status === "executing" ||
    status === "executed" ||
    status === "manual-recovery-required"
  ) {
    return { ok: false, reason: status, record };
  }
  const declined: DueLogicInterventionRecord = {
    ...record,
    status: "declined",
    declinedAt: nowIso,
    openedAt: record.openedAt ?? nowIso,
    updatedAt: nowIso,
  };
  if (!(await writeAndVerify(deps.repository, declined))) {
    return { ok: false, reason: "store", record };
  }
  return { ok: true, changed: true, record: declined };
}

// ---------------------------------------------------------------------------
// Stage 2: transaction-verification gate

export interface TransactionVerificationGateDeps {
  repository: DueLogicInterventionRepository;
  /** Read-only; the development implementation always returns null. */
  verifications: TransactionVerificationRepository;
  now(): string;
  hashToken(rawToken: string): string;
}

export type TransactionVerificationGateOutcome =
  | {
      ok: true;
      record: DueLogicInterventionRecord;
      verification: TransactionVerificationRecord;
    }
  | {
      ok: false;
      reason: "not-found" | "verification-required";
      record?: DueLogicInterventionRecord;
    };

/**
 * The mandatory gate in front of confirmInterventionExecution: resolves
 * the intervention from its hashed token and requires a valid verified
 * transaction-verification record bound to the exact intervention,
 * merchant, payer, subscription, selected date, stored schedules and
 * policy version — unexpired and unconsumed. Any missing, mismatched,
 * expired, consumed or unreadable verification refuses; an unreadable
 * store never permits. Token possession alone therefore never reaches the
 * execution entry point. No write path for verification records exists
 * yet, so this gate refuses everywhere today.
 */
export async function requireTransactionVerification(
  input: { token: string },
  deps: TransactionVerificationGateDeps,
): Promise<TransactionVerificationGateOutcome> {
  const record = await deps.repository.readByTokenHash(
    deps.hashToken(input.token.trim()),
  );
  if (record === null) {
    return { ok: false, reason: "not-found" };
  }
  let verification: TransactionVerificationRecord | null = null;
  try {
    verification = await deps.verifications.readVerifiedForIntervention(
      record.interventionId,
    );
  } catch {
    verification = null;
  }
  const evaluation = evaluateTransactionVerification(
    verification,
    transactionVerificationExpectationFor(record),
    deps.now(),
  );
  if (!evaluation.ok) {
    return { ok: false, reason: "verification-required", record };
  }
  return { ok: true, record, verification: evaluation.record };
}

// ---------------------------------------------------------------------------
// Stage 2: customer-confirmed execution

/**
 * The exact values the protected replacement path is invoked with — all
 * taken from the server-held intervention record, never from the browser.
 */
export interface InterventionReplacementPathRequest {
  operationId: string;
  confirmationId: string;
  merchantId: string;
  payerId: string;
  sourceId: string;
  subscriptionId: string;
  /** YYYY-MM-DD: the approved new start date held on the intervention. */
  proposedStartDate: string;
  /** The exact three Pinch-preview payments held on the intervention. */
  confirmedPayments: readonly ConfirmedSchedulePayment[];
}

/**
 * The interpreted result of one protected-path invocation. "refused" means
 * the path stopped before any mutation (original subscription untouched);
 * "manual-recovery" means a failure after mutation began; "unknown" means
 * the outcome could not be read — a mutation may have been issued, so it is
 * treated exactly as conservatively as manual recovery and never
 * resubmitted.
 */
export type InterventionReplacementPathResult =
  | { kind: "verified"; newSubscriptionId: string }
  | { kind: "manual-recovery"; stage: string; newSubscriptionId: string | null }
  | { kind: "refused"; stage: string }
  | { kind: "unknown" };

export interface InterventionExecutionDeps {
  repository: DueLogicInterventionRepository;
  now(): string;
  /** One-way hash of the raw intervention link token. */
  hashToken(rawToken: string): string;
  generateOperationId(): string;
  /** Real confirmation-service deps from the route; fakes in validation. */
  confirmationDeps: CustomerConfirmationServiceDeps;
  /**
   * Invokes the existing protected replacement path exactly once and
   * interprets its response. The path performs its own fresh Pinch
   * preflight, confirmation verification and consumption, recovery-record
   * write, cancellation, creation and verification, and never retries a
   * mutation. Implementations must not retry either.
   */
  executeReplacementPath(
    request: InterventionReplacementPathRequest,
  ): Promise<InterventionReplacementPathResult>;
}

export type ConfirmInterventionExecutionOutcome =
  | { ok: true; record: DueLogicInterventionRecord }
  | {
      ok: false;
      reason:
        | "not-found"
        | "expired"
        | "declined"
        | "escalated"
        | "already-executing"
        | "already-executed"
        | "manual-recovery-required"
        | "not-confirmable"
        | "confirmation-failed"
        | "refused"
        | "store";
      record?: DueLogicInterventionRecord;
    };

/**
 * The single internal Stage 2 entry point: one customer confirmation
 * executes the permanent replacement once. Transaction verification is a
 * PREREQUISITE checked before this function is called — every
 * customer-facing surface must first pass requireTransactionVerification;
 * no OTP or verification logic lives inside this function, so the later
 * OTP stage adds record creation without changing it.
 *
 * Exact ordering:
 *  1. Reload the intervention by hashed token; require an unexpired
 *     preview-ready record with an approved policy outcome, the exact three
 *     stored Pinch-preview schedules, and no prior execution linkage — a
 *     record already executing, executed or in manual recovery refuses.
 *  1b. Write the "executing" latch with a fresh server-generated operation
 *     ID (verified by read-back) so a second submission cannot execute.
 *  2. Create the customer confirmation record bound to the stored merchant,
 *     payer, source, subscription, plan, approved start date and the exact
 *     three preview payments — server-held values only.
 *  3. Record the customer's acceptance. The raw confirmation token is used
 *     server-side exactly once here and is never stored, logged or
 *     returned.
 *  4. Invoke the existing protected replacement path unchanged, exactly
 *     once.
 *  5. Write confirmationId, operationId and newSubscriptionId back to the
 *     intervention and set its status from the result: verified → executed;
 *     failure after mutation began (or an unreadable outcome) →
 *     manual-recovery-required; refused before any mutation → reverted to
 *     preview-ready with the execution linkage cleared (nothing external
 *     changed, so a fresh confirmation may be attempted later).
 *  6. Return the outcome with the final record for the customer page.
 */
export async function confirmInterventionExecution(
  input: { token: string },
  deps: InterventionExecutionDeps,
): Promise<ConfirmInterventionExecutionOutcome> {
  // 1. Reload and gate.
  const record = await deps.repository.readByTokenHash(
    deps.hashToken(input.token.trim()),
  );
  if (record === null) {
    return { ok: false, reason: "not-found" };
  }
  const nowIso = deps.now();
  const status = effectiveInterventionStatus(record, nowIso);
  if (status === "executing") {
    return { ok: false, reason: "already-executing", record };
  }
  if (status === "executed") {
    return { ok: false, reason: "already-executed", record };
  }
  if (status === "manual-recovery-required") {
    return { ok: false, reason: "manual-recovery-required", record };
  }
  if (status === "expired" || status === "declined" || status === "escalated") {
    return { ok: false, reason: status, record };
  }
  if (status !== "preview-ready") {
    return { ok: false, reason: "not-confirmable", record };
  }
  if (
    record.policyOutcome !== "approved" ||
    record.selectedDate === null ||
    record.currentPayments === null ||
    record.currentPayments.length !== 3 ||
    record.proposedPayments === null ||
    record.proposedPayments.length !== 3 ||
    record.proposedPayments[0].paymentDate !== record.selectedDate ||
    record.confirmationId !== null ||
    record.operationId !== null ||
    record.newSubscriptionId !== null
  ) {
    return { ok: false, reason: "not-confirmable", record };
  }

  // 1b. Single-submission latch, before anything else happens.
  const operationId = deps.generateOperationId();
  const executing: DueLogicInterventionRecord = {
    ...record,
    status: "executing",
    operationId,
    updatedAt: nowIso,
  };
  if (!(await writeAndVerify(deps.repository, executing))) {
    return { ok: false, reason: "store", record };
  }

  // Pre-execution failures revert the latch: nothing external has changed,
  // so the record honestly returns to preview-ready with the execution
  // linkage cleared. (Any created confirmation record remains in the
  // confirmation store as audit history and simply expires unused.)
  const revert = async (): Promise<DueLogicInterventionRecord> => {
    const reverted: DueLogicInterventionRecord = {
      ...executing,
      status: "preview-ready",
      confirmationId: null,
      operationId: null,
      updatedAt: deps.now(),
    };
    return (await writeAndVerify(deps.repository, reverted))
      ? reverted
      : executing;
  };

  // 2. The confirmation record, bound to the stored server-held values.
  const created = await createCustomerConfirmation(
    {
      merchantId: record.merchantId,
      payerId: record.payerId,
      sourceId: record.sourceId,
      subscriptionId: record.subscriptionId,
      planId: record.planId,
      currentStartDate: record.currentStartDate,
      proposedStartDate: record.selectedDate,
      currentPayments: record.currentPayments,
      proposedPayments: record.proposedPayments,
      currency: record.currency,
    },
    deps.confirmationDeps,
  );
  if (!created.ok) {
    return { ok: false, reason: "confirmation-failed", record: await revert() };
  }

  // 3. Customer acceptance: the confirm click on the tokenised page is the
  // acceptance being recorded. The raw confirmation token is used exactly
  // once, server-side, and never leaves this function.
  const accepted = await respondToCustomerConfirmation(
    { token: created.rawToken, response: "accept" },
    deps.confirmationDeps,
  );
  if (!accepted.ok) {
    return { ok: false, reason: "confirmation-failed", record: await revert() };
  }

  const bound: DueLogicInterventionRecord = {
    ...executing,
    confirmationId: created.record.confirmationId,
    updatedAt: deps.now(),
  };
  if (!(await writeAndVerify(deps.repository, bound))) {
    return { ok: false, reason: "store", record: await revert() };
  }

  // 4. The one invocation of the existing protected replacement path. A
  // thrown error means the outcome is unreadable — a mutation may have been
  // issued — so it is treated as unknown and never retried.
  let result: InterventionReplacementPathResult;
  try {
    result = await deps.executeReplacementPath({
      operationId,
      confirmationId: created.record.confirmationId,
      merchantId: record.merchantId,
      payerId: record.payerId,
      sourceId: record.sourceId,
      subscriptionId: record.subscriptionId,
      proposedStartDate: record.selectedDate,
      confirmedPayments: record.proposedPayments,
    });
  } catch {
    result = { kind: "unknown" };
  }

  // 5. Result write-back. After the path has been invoked, a store failure
  // must never flip the reported outcome or trigger any retry; the
  // in-memory record is returned regardless.
  if (result.kind === "verified") {
    const executed: DueLogicInterventionRecord = {
      ...bound,
      status: "executed",
      newSubscriptionId: result.newSubscriptionId,
      updatedAt: deps.now(),
    };
    await writeAndVerify(deps.repository, executed);
    return { ok: true, record: executed };
  }
  if (result.kind === "refused") {
    // The path stopped before any mutation; the original subscription is
    // untouched.
    return { ok: false, reason: "refused", record: await revert() };
  }
  const failed: DueLogicInterventionRecord = {
    ...bound,
    status: "manual-recovery-required",
    newSubscriptionId:
      result.kind === "manual-recovery" ? result.newSubscriptionId : null,
    updatedAt: deps.now(),
  };
  await writeAndVerify(deps.repository, failed);
  return { ok: false, reason: "manual-recovery-required", record: failed };
}

// ---------------------------------------------------------------------------
// Real implementations for the dev routes. The validation suite injects
// deterministic fakes instead.

/** At least 256 bits of randomness, URL-safe. Never logged, never stored. */
export function generateInterventionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 hex digest — the only form of the token ever stored. */
export function hashInterventionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function generateInterventionId(): string {
  return `int_${randomUUID()}`;
}

export function generateInterventionNotificationId(): string {
  return `ntf_${randomUUID()}`;
}

/** Server-generated replacement operation ID for one confirmed execution. */
export function generateInterventionOperationId(): string {
  return `duelogic-int-${randomUUID()}`;
}

export { DEV_INTERVENTION_INVITATION_LIFETIME_MINUTES };
