"use client";

import { useEffect, useState } from "react";
import { REPLACEMENT_DEMO_FIXTURE } from "@/lib/dev/replacement-demo-fixture";
import { formatAud, visibleDescription } from "@/lib/duelogic/display";
import { ReplacementAudit } from "./replacement-audit";

/**
 * Live permanent subscription replacement over the existing localhost-only
 * dev routes. The flow is strictly: frozen deterministic policy approval
 * (passed in from the server render — merchant policy approval is
 * automatic, never a manual step here) → fresh Pinch preview → gate checks
 * → server-recorded customer confirmation (a separate customer-facing page
 * accepts or declines the exact dates and amounts) → exactly one call to
 * the protected replacement route. The execute button is an operational
 * action, not a policy approval — customer consent is the server-held
 * confirmation, which the replacement route independently re-verifies and
 * consumes. The demo identifiers come from a fixed fixture and are never
 * editable here; confirmed payments are always the live preview's own
 * dates and amounts, never generated locally; and an execution attempt
 * latches the controls off permanently — no retry is ever issued, whatever
 * the response.
 */

const FIXTURE = REPLACEMENT_DEMO_FIXTURE;

/**
 * The existing backend confirmation contract. Submitted only after the
 * server reports an accepted customer confirmation — the phrase itself is
 * the route's contract, not a UI-invented control, and no server-side check
 * is weakened by the client sending it.
 */
const BACKEND_CONFIRMATION_PHRASE = "REPLACE FUTURE SCHEDULE";

const CONFIRMATION_POLL_INTERVAL_MS = 2000;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface PreviewPayment {
  /** YYYY-MM-DD in the merchant timezone, as normalised by the route. */
  transactionDate: string;
  /** Integer cents. */
  amountCents: number;
  /** Original description; test directives are stripped only at display. */
  description?: string;
}

interface SchedulePreview {
  status: string;
  currentStartDate: string;
  planId: string;
  planName: string | null;
  proposedStartDate: string;
  payments: PreviewPayment[];
}

interface LoadedPreview {
  proposed: SchedulePreview;
  /** Pinch-calculated schedule from the current start date; null if unread. */
  currentPayments: PreviewPayment[] | null;
}

interface PreviewGate {
  ok: boolean;
  label: string;
}

/** The merchant-safe confirmation view returned by the dev routes. */
interface MerchantConfirmationView {
  confirmationId: string;
  status: string;
  proposedStartDate: string;
  proposedPayments: Array<{ paymentDate: string; amountInCents: number }>;
  expiresAt: string;
  acceptedAt: string | null;
  declinedAt: string | null;
  consumedAt: string | null;
}

type ExecutionResult =
  | {
      kind: "verified";
      oldSubscriptionId: string;
      newSubscriptionId: string;
      startDate: string;
      planId: string | null;
      payerId: string | null;
      sourceId: string | null;
      payments: Array<{ transactionDate: string; amountCents: number }>;
    }
  | { kind: "manual-recovery"; stage: string; detail: string; mustNotResubmit: boolean }
  | { kind: "refused"; stage: string; detail: string }
  | { kind: "unknown"; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveIntegerCents(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parsePayments(value: unknown): PreviewPayment[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const payments: PreviewPayment[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.transactionDate !== "string" ||
      !DATE_ONLY_PATTERN.test(entry.transactionDate) ||
      !isPositiveIntegerCents(entry.amountCents)
    ) {
      return null;
    }
    const payment: PreviewPayment = {
      transactionDate: entry.transactionDate,
      amountCents: entry.amountCents,
    };
    if (typeof entry.description === "string" && entry.description !== "") {
      payment.description = entry.description;
    }
    payments.push(payment);
  }
  return payments;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Parses a merchant confirmation view from either the flat creation
 * response or the lookup's nested projection. Lifecycle timestamps are
 * optional in the creation response and default to null.
 */
function parseConfirmationView(
  value: unknown,
): MerchantConfirmationView | null {
  if (
    !isRecord(value) ||
    typeof value.confirmationId !== "string" ||
    typeof value.status !== "string" ||
    typeof value.proposedStartDate !== "string" ||
    typeof value.expiresAt !== "string" ||
    !Array.isArray(value.proposedPayments)
  ) {
    return null;
  }
  const proposedPayments: Array<{ paymentDate: string; amountInCents: number }> =
    [];
  for (const entry of value.proposedPayments) {
    if (
      !isRecord(entry) ||
      typeof entry.paymentDate !== "string" ||
      !isPositiveIntegerCents(entry.amountInCents)
    ) {
      return null;
    }
    proposedPayments.push({
      paymentDate: entry.paymentDate,
      amountInCents: entry.amountInCents,
    });
  }
  return {
    confirmationId: value.confirmationId,
    status: value.status,
    proposedStartDate: value.proposedStartDate,
    proposedPayments,
    expiresAt: value.expiresAt,
    acceptedAt: stringOrNull(value.acceptedAt),
    declinedAt: stringOrNull(value.declinedAt),
    consumedAt: stringOrNull(value.consumedAt),
  };
}

/**
 * One read-only preview call for the fixture subscription with the given
 * start date, parsed strictly. Returns null when the response cannot be
 * interpreted safely.
 */
async function fetchSchedulePreview(
  startDate: string,
): Promise<SchedulePreview | null> {
  const response = await fetch("/api/pinch/dev/subscription-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      merchantId: FIXTURE.merchantId,
      payerId: FIXTURE.payerId,
      subscriptionId: FIXTURE.subscriptionId,
      proposedStartDate: startDate,
    }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (
    !response.ok ||
    !isRecord(body) ||
    body.ok !== true ||
    body.needsSubscriptionSetup !== false ||
    !isRecord(body.subscription) ||
    !isRecord(body.plan) ||
    !isRecord(body.replacement)
  ) {
    return null;
  }
  const { subscription, plan, replacement } = body;
  if (
    typeof subscription.status !== "string" ||
    typeof subscription.currentStartDate !== "string" ||
    typeof plan.id !== "string" ||
    typeof replacement.proposedStartDate !== "string"
  ) {
    return null;
  }
  const payments = parsePayments(replacement.payments);
  if (payments === null) {
    return null;
  }
  return {
    status: subscription.status,
    currentStartDate: subscription.currentStartDate,
    planId: plan.id,
    planName: typeof plan.name === "string" ? plan.name : null,
    proposedStartDate: replacement.proposedStartDate,
    payments,
  };
}

/**
 * The conditions that must all hold before a customer confirmation can be
 * requested. The live preview is authoritative; the expected-dates check
 * exists so a drifted sandbox produces an honest warning instead of a
 * surprise mutation.
 */
function computeGates(preview: SchedulePreview): PreviewGate[] {
  const dates = preview.payments.map((payment) => payment.transactionDate);
  return [
    {
      ok: preview.status.trim().toLowerCase() === "active",
      label: "The subscription is active",
    },
    {
      ok: preview.planId === FIXTURE.planId,
      label: `The plan is ${FIXTURE.planId}`,
    },
    {
      ok: preview.payments.length === 3,
      label: "Pinch returned exactly three proposed payments",
    },
    {
      ok: preview.payments.every((payment) =>
        isPositiveIntegerCents(payment.amountCents),
      ),
      label: "Every amount is a positive whole number of cents",
    },
    {
      ok:
        dates.length === FIXTURE.expectedProposedDates.length &&
        FIXTURE.expectedProposedDates.every(
          (expected, index) => dates[index] === expected,
        ),
      label: `The proposed dates match the expected fortnightly dates (${FIXTURE.expectedProposedDates.join(", ")})`,
    },
  ];
}

function interpretReplacementResponse(body: unknown): ExecutionResult {
  if (isRecord(body) && body.ok === true) {
    const oldSubscription = isRecord(body.oldSubscription)
      ? body.oldSubscription
      : null;
    const newSubscription = isRecord(body.newSubscription)
      ? body.newSubscription
      : null;
    const payments = Array.isArray(body.confirmedPayments)
      ? parsePayments(body.confirmedPayments)
      : null;
    if (
      oldSubscription !== null &&
      newSubscription !== null &&
      payments !== null &&
      typeof oldSubscription.id === "string" &&
      typeof newSubscription.id === "string" &&
      typeof newSubscription.startDate === "string"
    ) {
      return {
        kind: "verified",
        oldSubscriptionId: oldSubscription.id,
        newSubscriptionId: newSubscription.id,
        startDate: newSubscription.startDate,
        planId:
          typeof newSubscription.planId === "string"
            ? newSubscription.planId
            : null,
        payerId: typeof body.payerId === "string" ? body.payerId : null,
        sourceId: typeof body.sourceId === "string" ? body.sourceId : null,
        payments: payments.map((payment) => ({
          transactionDate: payment.transactionDate,
          amountCents: payment.amountCents,
        })),
      };
    }
    return {
      kind: "unknown",
      detail:
        "The response reported success but could not be read safely. Do not submit this operation again; check the audit record below and the dev server log.",
    };
  }

  const stage =
    isRecord(body) && typeof body.stage === "string" ? body.stage : null;
  switch (stage) {
    case "validation":
      return {
        kind: "refused",
        stage,
        detail:
          "The request failed validation before any Pinch call. No mutation was issued.",
      };
    case "subscription-not-active": {
      const status =
        isRecord(body) && typeof body.status === "string"
          ? body.status
          : "not active";
      return {
        kind: "refused",
        stage,
        detail: `Preflight refused: the subscription is ${status}. No mutation was issued — a repeat call never creates another replacement.`,
      };
    }
    case "confirmation-not-found":
      return {
        kind: "refused",
        stage,
        detail:
          "No customer confirmation record was found for this execution, so nothing was mutated. Create a new confirmation request.",
      };
    case "confirmation-pending":
      return {
        kind: "refused",
        stage,
        detail:
          "The customer has not accepted the confirmation yet, so nothing was mutated. Wait for the customer's acceptance.",
      };
    case "confirmation-declined":
      return {
        kind: "refused",
        stage,
        detail:
          "The customer declined this schedule change, so nothing was mutated. A new confirmation request is required for any further attempt.",
      };
    case "confirmation-expired":
      return {
        kind: "refused",
        stage,
        detail:
          "The customer confirmation expired before execution, so nothing was mutated. Create a new confirmation request.",
      };
    case "confirmation-consumed":
      return {
        kind: "refused",
        stage,
        detail:
          "This customer confirmation was already used by an earlier execution, so nothing was mutated now. It cannot be reused; a fresh confirmation is required.",
      };
    case "confirmation-mismatch":
      return {
        kind: "refused",
        stage,
        detail:
          "The customer confirmation does not match this exact replacement (IDs, plan, start date or payments), so nothing was mutated. Create a new confirmation from a fresh preview.",
      };
    case "confirmation-store":
      return {
        kind: "refused",
        stage,
        detail:
          "The confirmation store could not be read, so nothing was mutated. The original subscription is untouched.",
      };
    case "confirmation-consumption":
      return {
        kind: "refused",
        stage,
        detail:
          "The customer confirmation could not be verifiably consumed, so the operation aborted with nothing persisted and nothing mutated. The original subscription is untouched.",
      };
    case "confirmation-stale":
      return {
        kind: "refused",
        stage,
        detail:
          "The recalculated Pinch schedule no longer matches the confirmed schedule, so nothing was mutated. Reload the page, load a fresh preview and confirm the new dates.",
      };
    case "recovery-record":
      return {
        kind: "refused",
        stage,
        detail:
          "The recovery record could not be written and read back, so the operation was aborted before any mutation. The original subscription is untouched.",
      };
    case "auth":
      return {
        kind: "refused",
        stage,
        detail:
          "Pinch authentication failed during read-only preflight. No mutation was issued.",
      };
    case "api":
      return {
        kind: "refused",
        stage,
        detail:
          "A Pinch read failed during preflight. No mutation was issued.",
      };
    case "cancel-verification":
      return {
        kind: "manual-recovery",
        stage,
        detail:
          "The cancellation of the original subscription could not be verified.",
        mustNotResubmit: true,
      };
    case "replacement-create":
      return {
        kind: "manual-recovery",
        stage,
        detail:
          "The original subscription was cancelled and verified, but creating the replacement failed.",
        mustNotResubmit: true,
      };
    case "replacement-ambiguous":
      return {
        kind: "manual-recovery",
        stage,
        detail:
          "Creation reported success but no replacement subscription ID could be extracted, so a replacement may exist.",
        mustNotResubmit: true,
      };
    case "replacement-verification":
      return {
        kind: "manual-recovery",
        stage,
        detail:
          "A replacement was created but its read-back verification failed.",
        mustNotResubmit: true,
      };
    default:
      return {
        kind: "unknown",
        detail:
          "The replacement response could not be interpreted. Do not submit this operation again; check the audit record below and the dev server log.",
      };
  }
}

const expiryFormatter = new Intl.DateTimeFormat("en-AU", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Australia/Sydney",
});

function formatExpiry(expiresAt: string): string {
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) {
    return expiresAt;
  }
  return `${expiryFormatter.format(new Date(parsed))} (Sydney time)`;
}

function PaymentScheduleTable({
  payments,
  caption,
}: {
  payments: PreviewPayment[];
  caption: string;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
        {caption}
      </p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {payments.map((payment) => {
          const description =
            payment.description === undefined
              ? ""
              : visibleDescription(payment.description);
          return (
            <li key={payment.transactionDate}>
              <span className="font-medium">{payment.transactionDate}</span> —{" "}
              {formatAud(payment.amountCents)}
              {description !== "" ? (
                <span className="text-zinc-500 dark:text-zinc-500">
                  {" "}
                  · {description}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Narrow view of the frozen deterministic policy decision the dashboard
 * already renders. Passed in from the server render only — the policy
 * engine is never re-run in the client and no second policy pathway
 * exists. Merchant policy approval is automatic: an approved outcome here
 * needs no manual merchant approval.
 */
export interface ReplacementPanelPolicyDecision {
  outcome: string;
  reasonCode: string;
  policyVersion: string;
}

interface ReplacementPanelProps {
  /** Null when no frozen decision exists; execution then stays disabled. */
  policyDecision: ReplacementPanelPolicyDecision | null;
}

export function ReplacementPanel({ policyDecision }: ReplacementPanelProps) {
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<LoadedPreview | null>(null);

  const [confirmation, setConfirmation] =
    useState<MerchantConfirmationView | null>(null);
  const [confirmationUrl, setConfirmationUrl] = useState<string | null>(null);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [confirmationError, setConfirmationError] = useState<string | null>(
    null,
  );
  const [linkCopied, setLinkCopied] = useState(false);

  /** Latched true at the first execution attempt and never reset. */
  const [executionStarted, setExecutionStarted] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [result, setResult] = useState<ExecutionResult | null>(null);

  const gates = preview === null ? [] : computeGates(preview.proposed);
  const previewValid = gates.length > 0 && gates.every((gate) => gate.ok);
  const confirmationStatus = confirmation?.status ?? null;
  const confirmationId = confirmation?.confirmationId ?? null;
  const customerAccepted = confirmationStatus === "accepted";
  const confirmationActive =
    confirmationStatus === "pending" || confirmationStatus === "accepted";
  /** Automatic, deterministic — never a manual merchant step. */
  const policyApproved = policyDecision?.outcome === "approved";
  const readyToExecute =
    policyApproved && previewValid && customerAccepted && !executionStarted;

  const executionSequence: Array<{
    label: string;
    ok: boolean;
    detail: string;
  }> = [
    {
      label: "Policy approved automatically",
      ok: policyApproved,
      detail:
        policyDecision === null
          ? "no frozen policy decision was supplied — execution stays disabled"
          : policyApproved
            ? `${policyDecision.reasonCode} · policy ${policyDecision.policyVersion} — deterministic, no manual merchant approval`
            : `deterministic outcome: ${policyDecision.outcome} (${policyDecision.reasonCode}) — execution stays disabled`,
    },
    {
      label: "Live Pinch preview validated",
      ok: previewValid,
      detail: previewValid
        ? "all pre-confirmation checks passed"
        : "the live preview has not passed every pre-confirmation check",
    },
    {
      label: "Customer confirmation received",
      ok: customerAccepted,
      detail: `server-held status: ${confirmationStatus ?? "none"}`,
    },
    {
      label: "Ready to execute",
      ok: readyToExecute,
      detail: executionStarted
        ? "execution has already been attempted — no retry will be issued"
        : readyToExecute
          ? "the request will be sent exactly once"
          : "waiting on the steps above",
    },
  ];

  const loadPreview = async () => {
    if (previewLoading || executionStarted) {
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(null);
    try {
      const proposed = await fetchSchedulePreview(FIXTURE.proposedStartDate);
      if (proposed === null) {
        setPreviewError(
          "The live Pinch preview could not be loaded or read safely. Check the dev server log.",
        );
        return;
      }
      // Second read-only call: Pinch's calculated schedule from the
      // subscription's own current start date, for side-by-side comparison.
      let currentPayments: PreviewPayment[] | null = null;
      try {
        const current = await fetchSchedulePreview(proposed.currentStartDate);
        currentPayments = current?.payments ?? null;
      } catch {
        currentPayments = null;
      }
      setPreview({ proposed, currentPayments });
    } catch {
      setPreviewError(
        "The preview request failed. Is the dev server running on localhost?",
      );
    } finally {
      setPreviewLoading(false);
    }
  };

  const createConfirmation = async () => {
    // No accidental duplicates: creation is blocked while a pending or
    // accepted confirmation exists, and permanently after execution begins.
    if (
      confirmationBusy ||
      executionStarted ||
      preview === null ||
      preview.currentPayments === null ||
      !previewValid ||
      confirmationActive
    ) {
      return;
    }
    setConfirmationBusy(true);
    setConfirmationError(null);
    setLinkCopied(false);
    try {
      const response = await fetch("/api/duelogic/dev/confirmations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The exact live preview values — never locally derived dates.
        body: JSON.stringify({
          merchantId: FIXTURE.merchantId,
          payerId: FIXTURE.payerId,
          sourceId: FIXTURE.sourceId,
          subscriptionId: FIXTURE.subscriptionId,
          planId: preview.proposed.planId,
          currentStartDate: preview.proposed.currentStartDate,
          proposedStartDate: preview.proposed.proposedStartDate,
          currentPayments: preview.currentPayments.map((payment) => ({
            paymentDate: payment.transactionDate,
            amountInCents: payment.amountCents,
          })),
          proposedPayments: preview.proposed.payments.map((payment) => ({
            paymentDate: payment.transactionDate,
            amountInCents: payment.amountCents,
          })),
          currency: "AUD",
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      const view =
        response.ok && isRecord(body) && body.ok === true
          ? parseConfirmationView(body)
          : null;
      const url =
        isRecord(body) && typeof body.customerConfirmationUrl === "string"
          ? body.customerConfirmationUrl
          : null;
      if (view === null || url === null) {
        setConfirmationError(
          "The confirmation request could not be created. Check the dev server log.",
        );
        return;
      }
      setConfirmation(view);
      setConfirmationUrl(url);
    } catch {
      setConfirmationError(
        "The confirmation request failed. Is the dev server running on localhost?",
      );
    } finally {
      setConfirmationBusy(false);
    }
  };

  const refreshConfirmation = async (id: string) => {
    try {
      const query = new URLSearchParams({ confirmationId: id });
      const response = await fetch(
        `/api/duelogic/dev/confirmations?${query.toString()}`,
        { cache: "no-store" },
      );
      const body: unknown = await response.json().catch(() => null);
      const view =
        response.ok && isRecord(body) && body.ok === true
          ? parseConfirmationView(body.confirmation)
          : null;
      if (view === null) {
        setConfirmationError(
          "The confirmation status could not be read just now.",
        );
        return;
      }
      setConfirmationError(null);
      setConfirmation(view);
    } catch {
      setConfirmationError(
        "The confirmation status could not be read just now.",
      );
    }
  };

  // Poll the server-held confirmation status every two seconds while it is
  // pending. Stops on any terminal or accepted status, once execution has
  // begun, and on unmount. Reads the confirmation store only — never Pinch.
  useEffect(() => {
    if (
      confirmationId === null ||
      confirmationStatus !== "pending" ||
      executionStarted
    ) {
      return;
    }
    let disposed = false;
    let inFlight = false;
    const poll = async () => {
      if (disposed || inFlight || document.hidden) {
        return;
      }
      inFlight = true;
      try {
        const query = new URLSearchParams({ confirmationId });
        const response = await fetch(
          `/api/duelogic/dev/confirmations?${query.toString()}`,
          { cache: "no-store" },
        );
        const body: unknown = await response.json().catch(() => null);
        const view =
          response.ok && isRecord(body) && body.ok === true
            ? parseConfirmationView(body.confirmation)
            : null;
        if (!disposed && view !== null) {
          setConfirmation(view);
        }
      } catch {
        // Transient poll failures are silent; the manual refresh button and
        // the next tick both remain available.
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => {
      void poll();
    }, CONFIRMATION_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [confirmationId, confirmationStatus, executionStarted]);

  const executeReplacement = async () => {
    // The disabled button already blocks this; the guard covers programmatic
    // re-entry. Once executionStarted latches, no second submission can ever
    // be issued from this page load. Server-side, the route re-verifies and
    // consumes the confirmation independently of this client state.
    if (
      executionStarted ||
      executing ||
      !policyApproved ||
      !customerAccepted ||
      confirmationId === null ||
      preview === null ||
      !previewValid
    ) {
      return;
    }
    const newOperationId = `duelogic-demo-${crypto.randomUUID()}`;
    setExecutionStarted(true);
    setExecuting(true);
    setOperationId(newOperationId);
    try {
      const response = await fetch("/api/pinch/dev/subscription-replacement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchantId: FIXTURE.merchantId,
          payerId: FIXTURE.payerId,
          sourceId: FIXTURE.sourceId,
          subscriptionId: FIXTURE.subscriptionId,
          proposedStartDate: FIXTURE.proposedStartDate,
          operationId: newOperationId,
          confirmationId,
          confirmation: BACKEND_CONFIRMATION_PHRASE,
          // Always the live preview's own dates and amounts — never
          // locally generated values.
          confirmedPayments: preview.proposed.payments.map((payment) => ({
            transactionDate: payment.transactionDate,
            amountCents: payment.amountCents,
          })),
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      setResult(interpretReplacementResponse(body));
    } catch {
      setResult({
        kind: "unknown",
        detail:
          "The replacement request did not return a readable result, so its outcome is unknown. It was sent once and must not be submitted again. Check the audit record below.",
      });
    } finally {
      setExecuting(false);
      if (confirmationId !== null) {
        void refreshConfirmation(confirmationId);
      }
    }
  };

  const proposed = preview?.proposed ?? null;

  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">
          Permanent schedule correction
        </h2>
        <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          Live Pinch sandbox execution
        </span>
      </div>
      <p className="mb-1 text-zinc-600 dark:text-zinc-400">
        A permanent correction replaces the subscription: the deterministic
        policy decision approves the change automatically under the
        merchant&apos;s configured policy, Pinch previews the new schedule,
        the customer accepts the exact dates and amounts through their own
        confirmation link, and only then is the protected replacement route
        called — exactly once.
      </p>
      <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-500">
        Merchant policy approval is automatic — no manual merchant approval
        is asked for. A customer free-text request alone is never authority
        to change a subscription; the server-held confirmation record is the
        customer&apos;s consent. Everything below operates on a real Pinch
        sandbox subscription; nothing is simulated.
      </p>

      <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="font-medium">Merchant</dt>
        <dd className="font-mono text-xs">{FIXTURE.merchantId}</dd>
        <dt className="font-medium">Payer</dt>
        <dd className="font-mono text-xs">{FIXTURE.payerId}</dd>
        <dt className="font-medium">Subscription</dt>
        <dd className="font-mono text-xs">{FIXTURE.subscriptionId}</dd>
        <dt className="font-medium">Proposed new start date</dt>
        <dd>{FIXTURE.proposedStartDate}</dd>
      </dl>

      <button
        type="button"
        className="rounded bg-zinc-900 px-4 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        onClick={() => {
          void loadPreview();
        }}
        disabled={previewLoading || executionStarted}
      >
        {previewLoading ? "Loading live Pinch preview…" : "Load live Pinch preview"}
      </button>

      {previewError !== null ? (
        <p role="alert" className="mt-3 text-red-700 dark:text-red-400">
          {previewError}
        </p>
      ) : null}

      {proposed !== null ? (
        <div className="mt-4 flex flex-col gap-4">
          <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="font-medium">Live preview</h3>
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
                Read live from the Pinch sandbox
              </span>
            </div>
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
              <dt className="font-medium">Subscription status</dt>
              <dd>{proposed.status}</dd>
              <dt className="font-medium">Current start date</dt>
              <dd>{proposed.currentStartDate}</dd>
              <dt className="font-medium">Plan</dt>
              <dd className="font-mono text-xs">
                {proposed.planId}
                {proposed.planName !== null ? ` (${proposed.planName})` : ""}
              </dd>
            </dl>
            {proposed.currentStartDate !== FIXTURE.expectedCurrentStartDate ? (
              <p className="mt-2 text-amber-700 dark:text-amber-400">
                Warning: the live current start date differs from the expected{" "}
                {FIXTURE.expectedCurrentStartDate}. The live value above is
                authoritative.
              </p>
            ) : null}
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              {preview?.currentPayments !== null &&
              preview?.currentPayments !== undefined ? (
                <PaymentScheduleTable
                  payments={preview.currentPayments}
                  caption={`Current first three payments (Pinch-calculated from ${proposed.currentStartDate})`}
                />
              ) : (
                <p className="text-xs text-zinc-500 dark:text-zinc-500">
                  The current schedule could not be read; a customer
                  confirmation cannot be created without it. Reload the
                  preview.
                </p>
              )}
              <PaymentScheduleTable
                payments={proposed.payments}
                caption={`Proposed first three payments (Pinch-calculated from ${proposed.proposedStartDate})`}
              />
            </div>
          </div>

          <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <h3 className="font-medium">Pre-confirmation checks</h3>
            <ul className="mt-2 flex flex-col gap-1">
              {gates.map((gate) => (
                <li key={gate.label} className="flex gap-2">
                  <span
                    className={
                      gate.ok
                        ? "text-green-800 dark:text-green-400"
                        : "font-medium text-red-700 dark:text-red-400"
                    }
                  >
                    {gate.ok ? "✓" : "✗"}
                  </span>
                  <span>{gate.label}</span>
                </li>
              ))}
            </ul>
            {!previewValid ? (
              <p role="alert" className="mt-2 text-red-700 dark:text-red-400">
                The live preview does not satisfy every check above, so
                customer confirmation and execution stay disabled. The live
                Pinch response is authoritative — the expected values are
                only human-validation aids.
              </p>
            ) : null}
          </div>

          {previewValid ? (
            <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <h3 className="font-medium">Customer confirmation</h3>
              <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                The customer must accept the exact proposed dates and amounts
                through their own confirmation page before execution unlocks.
                The link is single use and expires 30 minutes after creation.
              </p>
              {confirmation === null ? (
                <button
                  type="button"
                  className="mt-3 rounded bg-zinc-900 px-4 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                  onClick={() => {
                    void createConfirmation();
                  }}
                  disabled={
                    confirmationBusy ||
                    executionStarted ||
                    preview?.currentPayments === null
                  }
                >
                  {confirmationBusy
                    ? "Creating confirmation link…"
                    : "Create customer confirmation link"}
                </button>
              ) : (
                <div className="mt-3 flex flex-col gap-2">
                  <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                    <dt className="font-medium">Status</dt>
                    <dd>
                      <span
                        className={
                          customerAccepted
                            ? "font-medium text-green-800 dark:text-green-400"
                            : confirmationStatus === "pending"
                              ? "text-amber-700 dark:text-amber-400"
                              : "font-medium text-red-700 dark:text-red-400"
                        }
                      >
                        {confirmationStatus}
                      </span>{" "}
                      <span className="text-xs text-zinc-500">
                        (server-held; refreshed every 2 seconds while pending)
                      </span>
                    </dd>
                    <dt className="font-medium">Expires</dt>
                    <dd>{formatExpiry(confirmation.expiresAt)}</dd>
                    {confirmation.acceptedAt !== null ? (
                      <>
                        <dt className="font-medium">Accepted at</dt>
                        <dd className="font-mono text-xs">
                          {confirmation.acceptedAt}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                  {confirmationUrl !== null ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="max-w-full overflow-x-auto rounded bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-900">
                        {confirmationUrl}
                      </code>
                      <button
                        type="button"
                        className="rounded border border-zinc-300 px-2.5 py-0.5 text-xs font-medium dark:border-zinc-700"
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(confirmationUrl)
                            .then(() => setLinkCopied(true))
                            .catch(() => setLinkCopied(false));
                        }}
                      >
                        {linkCopied ? "Copied" : "Copy link"}
                      </button>
                      <a
                        href={confirmationUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded border border-zinc-300 px-2.5 py-0.5 text-xs font-medium dark:border-zinc-700"
                      >
                        Open customer confirmation
                      </a>
                      <button
                        type="button"
                        className="rounded border border-zinc-300 px-2.5 py-0.5 text-xs font-medium dark:border-zinc-700"
                        onClick={() => {
                          if (confirmationId !== null) {
                            void refreshConfirmation(confirmationId);
                          }
                        }}
                      >
                        Refresh confirmation status
                      </button>
                    </div>
                  ) : null}
                  {confirmationStatus === "declined" ||
                  confirmationStatus === "expired" ? (
                    <div>
                      <p role="alert" className="text-red-700 dark:text-red-400">
                        {confirmationStatus === "declined"
                          ? "The customer declined this schedule change. Execution stays disabled; no replacement can be made using this confirmation."
                          : "This confirmation expired before acceptance. Execution stays disabled."}
                      </p>
                      {!executionStarted ? (
                        <button
                          type="button"
                          className="mt-2 rounded bg-zinc-900 px-4 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                          onClick={() => {
                            void createConfirmation();
                          }}
                          disabled={confirmationBusy}
                        >
                          Create new confirmation link
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}
              {confirmationError !== null ? (
                <p role="alert" className="mt-2 text-red-700 dark:text-red-400">
                  {confirmationError}
                </p>
              ) : null}
            </div>
          ) : null}

          {previewValid ? (
            <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <h3 className="font-medium">Execution</h3>
              <p className="mt-2">
                Replacing subscription{" "}
                <span className="font-mono text-xs">
                  {FIXTURE.subscriptionId}
                </span>{" "}
                with a new schedule starting{" "}
                <span className="font-medium">{proposed.proposedStartDate}</span>:
              </p>
              <ul className="mt-2 flex flex-col gap-0.5">
                {proposed.payments.map((payment) => (
                  <li key={payment.transactionDate}>
                    <span className="font-medium">
                      {payment.transactionDate}
                    </span>{" "}
                    — {formatAud(payment.amountCents)}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-amber-700 dark:text-amber-400">
                This permanent change cancels the original subscription and
                creates a replacement. The two steps are not atomic: a failure
                after cancellation requires manual recovery. The request is
                sent exactly once and is never retried, and the customer
                confirmation is consumed by the attempt.
              </p>
              <ul className="mt-3 flex flex-col gap-1">
                {executionSequence.map((step) => (
                  <li key={step.label} className="flex gap-2">
                    <span
                      className={
                        step.ok
                          ? "text-green-800 dark:text-green-400"
                          : "font-medium text-red-700 dark:text-red-400"
                      }
                    >
                      {step.ok ? "✓" : "✗"}
                    </span>
                    <span>
                      {step.label}{" "}
                      <span className="text-xs text-zinc-500 dark:text-zinc-500">
                        — {step.detail}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-500">
                Rehearsal note: everything up to this point is safe — the
                preview is read-only and the confirmation link mutates
                nothing in Pinch. Pressing the button below executes the real
                cancel-and-create sequence in the Pinch sandbox. It is an
                operational action, not a policy approval.
              </p>
              <button
                type="button"
                className="mt-2 rounded bg-green-700 px-4 py-1.5 font-medium text-white disabled:bg-zinc-300 disabled:text-zinc-500 dark:bg-green-600 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-500"
                onClick={() => {
                  void executeReplacement();
                }}
                disabled={!readyToExecute || executing}
              >
                {executing
                  ? "Executing replacement…"
                  : executionStarted
                    ? "Replacement submitted — no retry will be issued"
                    : "Execute permanent replacement"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {executing ? (
        <p className="mt-4">
          Executing the permanent replacement — verify consent, consume the
          confirmation, record recovery, cancel, create, verify. This is sent
          once and never retried. Leave this page open.
        </p>
      ) : null}

      {result !== null ? (
        <div className="mt-4 flex flex-col gap-4">
          {result.kind === "verified" ? (
            <div className="rounded-md border border-green-300 p-3 dark:border-green-900">
              <h3 className="font-medium text-green-800 dark:text-green-400">
                Replacement verified
              </h3>
              <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                <dt className="font-medium">Old subscription</dt>
                <dd className="font-mono text-xs">
                  {result.oldSubscriptionId} (cancelled)
                </dd>
                <dt className="font-medium">New subscription</dt>
                <dd className="font-mono text-xs">
                  {result.newSubscriptionId} (active)
                </dd>
                <dt className="font-medium">Verified start date</dt>
                <dd>{result.startDate}</dd>
                {result.planId !== null ? (
                  <>
                    <dt className="font-medium">Plan retained</dt>
                    <dd className="font-mono text-xs">{result.planId}</dd>
                  </>
                ) : null}
                {result.payerId !== null ? (
                  <>
                    <dt className="font-medium">Payer retained</dt>
                    <dd className="font-mono text-xs">{result.payerId}</dd>
                  </>
                ) : null}
                {result.sourceId !== null ? (
                  <>
                    <dt className="font-medium">Source retained</dt>
                    <dd className="font-mono text-xs">{result.sourceId}</dd>
                  </>
                ) : null}
                {confirmationId !== null ? (
                  <>
                    <dt className="font-medium">Customer confirmation</dt>
                    <dd className="font-mono text-xs">
                      {confirmationId} (consumed)
                    </dd>
                  </>
                ) : null}
                <dt className="font-medium">Verified payments</dt>
                <dd>
                  <ul className="flex flex-col gap-0.5">
                    {result.payments.map((payment) => (
                      <li key={payment.transactionDate}>
                        {payment.transactionDate} —{" "}
                        {formatAud(payment.amountCents)}
                      </li>
                    ))}
                  </ul>
                </dd>
              </dl>
            </div>
          ) : null}

          {result.kind === "manual-recovery" ? (
            <div
              role="alert"
              className="rounded-md border border-red-300 p-3 dark:border-red-900"
            >
              <h3 className="font-medium text-red-700 dark:text-red-400">
                Manual recovery required
              </h3>
              <p className="mt-1">{result.detail}</p>
              <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                <dt className="font-medium">Operation ID</dt>
                <dd className="font-mono text-xs">{operationId}</dd>
                <dt className="font-medium">Failure stage</dt>
                <dd className="font-mono text-xs">{result.stage}</dd>
              </dl>
              <p className="mt-2">
                No automatic retry was performed and none will be.
                {result.mustNotResubmit
                  ? " This operation must not be submitted again."
                  : ""}
              </p>
            </div>
          ) : null}

          {result.kind === "refused" ? (
            <div
              role="alert"
              className="rounded-md border border-amber-300 p-3 dark:border-amber-900"
            >
              <h3 className="font-medium text-amber-700 dark:text-amber-400">
                Replacement refused before mutation
              </h3>
              <p className="mt-1">{result.detail}</p>
              <p className="mt-2 font-mono text-xs">stage: {result.stage}</p>
            </div>
          ) : null}

          {result.kind === "unknown" ? (
            <div
              role="alert"
              className="rounded-md border border-red-300 p-3 dark:border-red-900"
            >
              <h3 className="font-medium text-red-700 dark:text-red-400">
                Result unknown
              </h3>
              <p className="mt-1">{result.detail}</p>
            </div>
          ) : null}

          {operationId !== null ? (
            <ReplacementAudit operationId={operationId} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
