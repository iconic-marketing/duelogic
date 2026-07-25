"use client";

import { useState } from "react";
import { REPLACEMENT_DEMO_FIXTURE } from "@/lib/dev/replacement-demo-fixture";
import { formatAud, visibleDescription } from "@/lib/duelogic/display";
import { ReplacementAudit } from "./replacement-audit";

/**
 * Live permanent subscription replacement over the existing localhost-only
 * dev routes. The flow is strictly: fresh Pinch preview → gate checks →
 * explicit human confirmation of the exact dates and amounts → exactly one
 * call to the protected replacement route. The demo identifiers come from a
 * fixed fixture and are never editable here; confirmed payments are always
 * the live preview's own dates and amounts, never generated locally; and an
 * execution attempt latches the controls off permanently — no retry is ever
 * issued, whatever the response.
 */

const FIXTURE = REPLACEMENT_DEMO_FIXTURE;

/**
 * The existing backend confirmation contract. Submitted only after the
 * visible acknowledgement checkbox is selected — the phrase itself is the
 * route's contract, not a UI-invented control.
 */
const BACKEND_CONFIRMATION_PHRASE = "REPLACE FUTURE SCHEDULE";

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
 * The conditions that must all hold before confirmation is offered. The
 * live preview is authoritative; the expected-dates check exists so a
 * drifted sandbox produces an honest warning instead of a surprise
 * mutation.
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

export function ReplacementPanel() {
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<LoadedPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  /** Latched true at the first execution attempt and never reset. */
  const [executionStarted, setExecutionStarted] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [result, setResult] = useState<ExecutionResult | null>(null);

  const gates = preview === null ? [] : computeGates(preview.proposed);
  const executionAllowed = gates.length > 0 && gates.every((gate) => gate.ok);

  const loadPreview = async () => {
    if (previewLoading || executionStarted) {
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(null);
    setAcknowledged(false);
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

  const executeReplacement = async () => {
    // The disabled button already blocks this; the guard covers programmatic
    // re-entry. Once executionStarted latches, no second submission can ever
    // be issued from this page load.
    if (
      executionStarted ||
      executing ||
      !acknowledged ||
      preview === null ||
      !executionAllowed
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
        A permanent correction replaces the subscription: Pinch previews the
        new schedule, the customer confirms the exact dates and amounts, and
        only then is the protected replacement route called — exactly once.
      </p>
      <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-500">
        A customer free-text request alone is never authority to change a
        subscription. Everything below operates on a real Pinch sandbox
        subscription; nothing is simulated.
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
                  The current schedule could not be read; the proposed
                  schedule below is unaffected.
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
            {!executionAllowed ? (
              <p role="alert" className="mt-2 text-red-700 dark:text-red-400">
                The live preview does not satisfy every check above, so
                confirmation and execution stay disabled. The live Pinch
                response is authoritative — the expected values are only
                human-validation aids.
              </p>
            ) : null}
          </div>

          {executionAllowed ? (
            <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <h3 className="font-medium">Explicit customer confirmation</h3>
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
                sent exactly once and is never retried.
              </p>
              <label className="mt-3 flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  disabled={executionStarted}
                />
                <span>
                  I confirm these exact future payment dates and understand
                  that the existing subscription will be replaced.
                </span>
              </label>
              <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-500">
                Rehearsal note: everything up to this point is read-only.
                Pressing the button below executes the real cancel-and-create
                sequence in the Pinch sandbox.
              </p>
              <button
                type="button"
                className="mt-2 rounded bg-red-700 px-4 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-red-500 dark:text-white"
                onClick={() => {
                  void executeReplacement();
                }}
                disabled={!acknowledged || executionStarted || executing}
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
          Executing the permanent replacement — cancel, then create, then
          verify. This is sent once and never retried. Leave this page open.
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
