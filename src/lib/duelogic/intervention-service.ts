/**
 * Stage 1 customer-led intervention service: the scheduled scan, customer
 * open, deterministic date evaluation with read-only Pinch preview, and
 * decline.
 *
 * Every function takes injected dependencies (repositories, clock, token
 * generator, token hasher, read-only subscription/preview effects), so the
 * deterministic validation suite drives these exact code paths with fakes
 * and no network access. The dev routes supply the real implementations.
 *
 * Nothing here mutates Pinch: every injected Pinch effect is a read, Stage
 * 1 stops at preview-ready, and confirmationId, operationId and
 * newSubscriptionId remain null throughout. The deterministic policy engine
 * decides eligibility; Pinch remains authoritative for schedule content —
 * preview dates are never generated or substituted locally.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { addCalendarDays, parseCalendarDate } from "./calendar-date";
import {
  DEV_INTERVENTION_INVITATION_LIFETIME_MINUTES,
  effectiveInterventionStatus,
  findForbiddenInterventionRecordKey,
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
import { DEFAULT_DUELOGIC_POLICY } from "./policy/rules";
import { buildSeedPolicyEvaluations } from "./seed-policy-evaluations";
import {
  resolveActiveSubscription,
  type SubscriptionDetailSnapshot,
  type SubscriptionReadEffects,
} from "./subscription-resolver";
import type { ConfirmedSchedulePayment } from "@/lib/pinch/customer-confirmation";

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
      outcome: "fixture-error";
      /** Safe stage vocabulary only — never response content. */
      reason:
        | "clock-unreadable"
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

  // 1-3. Frozen synthetic evidence: detector output and the frozen policy
  // evaluations over the seeded history. The designated opportunity is the
  // first approved frozen evaluation in payer-ID order — the same frozen
  // decision the dashboard already renders — and it must match the
  // fixture's explicit designation.
  const { flags, policyItems } = buildSeedPolicyEvaluations();
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
  if (
    fixture.expectedRecurringAmountCents >
    DEFAULT_DUELOGIC_POLICY.amountCeilingCents
  ) {
    return {
      outcome: "fixture-error",
      reason: "unsuitable-for-invitation",
      detail: "The payment amount exceeds the policy's automatic ceiling.",
    };
  }

  // 9 (before creation). Duplicate prevention: one active invitation per
  // subscription. Only an expired invitation may be replaced; repeated scan
  // clicks return the existing invitation unchanged.
  let existingRecords: DueLogicInterventionRecord[];
  try {
    existingRecords = await deps.repository.list();
  } catch {
    return {
      outcome: "store-error",
      detail: "The intervention store could not be listed.",
    };
  }
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
    policyVersion: DEFAULT_DUELOGIC_POLICY.version,
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
  input: { token: string; selectedDate: string },
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

  // The permitted window is the assigned current billing cycle; the one
  // exception is the exact next-cycle date the policy engine itself offered.
  let effectiveCycle: PermanentPolicyEvaluationRequest["effectiveCycle"];
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

  let decision;
  try {
    // No executed-verified prior schedule changes exist for the
    // demonstration payer; the empty history is explicit, not inferred.
    decision = evaluateScheduleChange(request, [], DEFAULT_DUELOGIC_POLICY);
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
      reason: "not-found" | "expired" | "escalated" | "store";
      record?: DueLogicInterventionRecord;
    };

/**
 * Applies a customer's decline. Permitted from any pre-execution state;
 * repeats are idempotent; expired invitations accept no response; an
 * escalated case stays with the merchant. Declining performs no Pinch call,
 * creates no confirmation record and leaves confirmationId, operationId
 * and newSubscriptionId null.
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
  if (status === "expired" || status === "escalated") {
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

export { DEV_INTERVENTION_INVITATION_LIFETIME_MINUTES };
