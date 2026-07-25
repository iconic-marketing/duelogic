"use client";

import { useState } from "react";
import { formatAud, formatDisplayDate } from "@/lib/duelogic/display";
import type { CustomerInterventionProjection } from "@/lib/duelogic/intervention";
import type { ConfirmedSchedulePayment } from "@/lib/pinch/customer-confirmation";

/**
 * Client half of the customer intervention page: date selection, the
 * "Check this date" evaluation, decline, the exact-schedule preview, and
 * the Stage 2 final confirmation. Every state change comes from the
 * server's response — client time is never authoritative, the server
 * re-evaluates expiry, status and policy on each request, and the browser
 * supplies nothing but the token, the action and the chosen date. Shows
 * plain customer language only; no IDs, reason codes or raw JSON.
 *
 * The final confirmation is gated and a single submission: the server
 * computes finalConfirmationEnabled, which additionally requires a valid
 * verified customer transaction-verification record — none can currently
 * be created, so the confirm button renders disabled with wording that
 * verification is required, and this page never calls the confirmation
 * route while the flag is false. When enabled (future verified path), the
 * button disables the moment it is clicked and never re-enables, and no
 * retry control exists. The server holds the only execution authority —
 * one gated handler behind the confirm route, which invokes the existing
 * protected replacement path unchanged. An ambiguous or manual-recovery
 * outcome renders calm neutral wording with no instruction to resubmit.
 */

interface ReviewFormProps {
  token: string;
  initialView: CustomerInterventionProjection;
}

type RequestState = "idle" | "submitting" | "error" | "preview-unavailable";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function viewFromResponse(
  body: unknown,
): CustomerInterventionProjection | null {
  if (!isRecord(body) || !isRecord(body.intervention)) {
    return null;
  }
  const intervention = body.intervention;
  if (typeof intervention.status !== "string") {
    return null;
  }
  // The dev route emits the exact projection shape; the status check above
  // guards against malformed payloads without re-validating every field.
  return intervention as unknown as CustomerInterventionProjection;
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

const CADENCE_LABELS: Record<
  CustomerInterventionProjection["scheduleCadence"],
  string
> = {
  weekly: "weekly",
  fortnightly: "fortnightly",
  monthly: "monthly",
};

function ScheduleList({
  title,
  payments,
}: {
  title: string;
  payments: readonly ConfirmedSchedulePayment[];
}) {
  return (
    <div>
      <h2 className="font-medium">{title}</h2>
      <ul className="mt-1 flex flex-col gap-0.5">
        {payments.map((payment) => (
          <li key={payment.paymentDate}>
            <span className="font-medium">
              {formatDisplayDate(payment.paymentDate)}
            </span>{" "}
            — {formatAud(payment.amountInCents)}
          </li>
        ))}
      </ul>
    </div>
  );
}

type ConfirmState = "idle" | "submitting" | "submitted";

export function ReviewForm({ token, initialView }: ReviewFormProps) {
  const [view, setView] = useState<CustomerInterventionProjection>(initialView);
  const [selectedDate, setSelectedDate] = useState<string>(
    initialView.selectedDate ?? initialView.suggestedDate,
  );
  const [requestState, setRequestState] = useState<RequestState>("idle");
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  /** Latched away from "idle" on the first confirm click; never reset. */
  const [confirmState, setConfirmState] = useState<ConfirmState>("idle");
  const [confirmNotice, setConfirmNotice] = useState<string | null>(null);

  const submit = async (
    payload:
      | { token: string; action: "check-date"; selectedDate: string }
      | { token: string; action: "decline" },
  ) => {
    if (requestState === "submitting" || confirmState !== "idle") {
      return;
    }
    setRequestState("submitting");
    setSelectionNotice(null);
    try {
      const response = await fetch("/api/duelogic/dev/interventions/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body: unknown = await response.json().catch(() => null);
      const reported = viewFromResponse(body);
      if (reported !== null) {
        setView(reported);
      }
      if (response.ok && isRecord(body) && body.ok === true) {
        setRequestState("idle");
        return;
      }
      const stage = isRecord(body) ? body.stage : undefined;
      if (stage === "invalid-date" || stage === "outside-window") {
        setSelectionNotice(
          "That date is not available. Please choose a date within the window shown below.",
        );
        setRequestState("idle");
        return;
      }
      if (stage === "preview-unavailable") {
        setRequestState("preview-unavailable");
        return;
      }
      if (reported !== null) {
        // The server refused the transition and reported the current state
        // (e.g. expired or declined); the rendered view already explains it.
        setRequestState("idle");
        return;
      }
      setRequestState("error");
    } catch {
      setRequestState("error");
    }
  };

  const confirmSchedule = async () => {
    // Never call the confirmation route while the server-computed gate is
    // closed: without a verified transaction-verification record the
    // server would refuse anyway, and this page must not even ask. The
    // remaining guards cover single submission and programmatic re-entry;
    // none ever re-enables.
    if (
      !view.finalConfirmationEnabled ||
      confirmState !== "idle" ||
      requestState === "submitting"
    ) {
      return;
    }
    setConfirmState("submitting");
    setConfirmNotice(null);
    try {
      const response = await fetch("/api/duelogic/dev/interventions/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body: unknown = await response.json().catch(() => null);
      const reported = viewFromResponse(body);
      if (reported !== null) {
        // The reported status ("executed", "executing",
        // "manual-recovery-required" or a reverted "preview-ready") drives
        // what renders below.
        setView(reported);
      }
      if (response.ok && isRecord(body) && body.ok === true) {
        setConfirmState("submitted");
        return;
      }
      const stage = isRecord(body) ? body.stage : undefined;
      if (stage === "refused") {
        setConfirmNotice(
          "The schedule change could not be completed just now. No changes have been made to your payment schedule.",
        );
      } else if (reported === null) {
        // The outcome could not be read. Calm, neutral, no instruction to
        // resubmit: the server never re-executes and the merchant follows
        // up on anything unresolved.
        setConfirmNotice(
          "Your confirmation has been received. The update is being finalised — you don't need to do anything further, and the merchant will contact you if anything needs your attention.",
        );
      }
      setConfirmState("submitted");
    } catch {
      setConfirmNotice(
        "Your confirmation has been received. The update is being finalised — you don't need to do anything further, and the merchant will contact you if anything needs your attention.",
      );
      setConfirmState("submitted");
    }
  };

  if (view.status === "executed") {
    return (
      <div className="mt-4 flex flex-col gap-4">
        <p className="font-medium text-green-800 dark:text-green-400">
          Your new payment schedule is confirmed.
        </p>
        {view.proposedPayments !== null ? (
          <ScheduleList
            title="Your new schedule (verified next three payments)"
            payments={view.proposedPayments}
          />
        ) : null}
        <p className="text-zinc-600 dark:text-zinc-400">
          These dates and amounts have been verified with the payment
          provider. No further action is needed.
        </p>
      </div>
    );
  }
  if (
    view.status === "executing" ||
    view.status === "manual-recovery-required"
  ) {
    // Calm neutral wording for an in-flight or attention-needed outcome:
    // no alarm, no instruction to resubmit — the merchant follows up.
    return (
      <div className="mt-4 flex flex-col gap-3">
        <p className="font-medium">Your confirmation has been received.</p>
        <p className="text-zinc-600 dark:text-zinc-400">
          The schedule update is being finalised. You don&rsquo;t need to do
          anything further — the merchant will contact you if anything needs
          your attention.
        </p>
      </div>
    );
  }
  if (view.status === "expired") {
    return (
      <p className="mt-4" role="alert">
        This invitation has expired. No changes have been made to your
        payment schedule.
      </p>
    );
  }
  if (view.status === "declined") {
    return (
      <p className="mt-4 font-medium">
        You declined this schedule review. No changes have been made to your
        payment schedule.
      </p>
    );
  }
  if (view.status === "escalated") {
    return (
      <div className="mt-4 flex flex-col gap-3">
        <p className="font-medium">
          This request needs a closer look from the merchant.
        </p>
        <p className="text-zinc-600 dark:text-zinc-400">
          The merchant will review your request and contact you. No changes
          have been made to your payment schedule.
        </p>
      </div>
    );
  }

  const submitting = requestState === "submitting";
  const previewReady =
    view.status === "preview-ready" &&
    view.currentPayments !== null &&
    view.proposedPayments !== null;

  return (
    <div className="mt-4 flex flex-col gap-5">
      <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <dl className="flex flex-col gap-0.5">
          <div className="flex gap-2">
            <dt className="text-zinc-500 dark:text-zinc-500">
              Payment amount:
            </dt>
            <dd className="font-medium">{formatAud(view.amountInCents)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-zinc-500 dark:text-zinc-500">
              Current schedule:
            </dt>
            <dd className="font-medium">
              {CADENCE_LABELS[view.scheduleCadence]}, next payment{" "}
              {formatDisplayDate(view.currentScheduledDate)}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-zinc-500 dark:text-zinc-500">
              You can choose a date between:
            </dt>
            <dd className="font-medium">
              {formatDisplayDate(view.windowStartDate)} and{" "}
              {formatDisplayDate(view.windowEndDate)}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-zinc-500 dark:text-zinc-500">
              Suggested date:
            </dt>
            <dd className="font-medium">
              {formatDisplayDate(view.suggestedDate)}
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
          This invitation expires at {formatExpiry(view.expiresAt)}.
        </p>
      </div>

      <p className="text-zinc-600 dark:text-zinc-400">
        Choose a date and DueLogic will check it against the merchant&rsquo;s
        payment flexibility policy.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
            New payment date
          </span>
          <input
            type="date"
            value={selectedDate}
            min={view.windowStartDate}
            max={view.offeredAlternativeDate ?? view.windowEndDate}
            onChange={(event) => {
              setSelectedDate(event.target.value);
            }}
            className="rounded border border-zinc-300 px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <button
          type="button"
          className="rounded bg-zinc-900 px-4 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          onClick={() => {
            void submit({ token, action: "check-date", selectedDate });
          }}
          disabled={submitting || selectedDate === "" || confirmState !== "idle"}
        >
          {submitting ? "Checking…" : "Check this date"}
        </button>
      </div>

      {selectionNotice !== null ? (
        <p className="text-amber-700 dark:text-amber-400" role="alert">
          {selectionNotice}
        </p>
      ) : null}
      {requestState === "error" ? (
        <p role="alert">
          Your request could not be processed. Please reload this page and
          try again.
        </p>
      ) : null}
      {requestState === "preview-unavailable" ? (
        <p role="alert">
          Your date was approved, but the exact schedule preview is not
          available right now. Please try checking the date again shortly.
        </p>
      ) : null}

      {view.status === "alternative-offered" &&
      view.offeredAlternativeDate !== null ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium text-amber-900 dark:text-amber-300">
            That exact date is not available, but a nearby date is.
          </p>
          {view.policyExplanation !== null ? (
            <p className="mt-1 text-amber-900 dark:text-amber-300">
              {view.policyExplanation}
            </p>
          ) : null}
          <button
            type="button"
            className="mt-3 rounded bg-zinc-900 px-4 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            onClick={() => {
              setSelectedDate(view.offeredAlternativeDate ?? selectedDate);
              void submit({
                token,
                action: "check-date",
                selectedDate: view.offeredAlternativeDate ?? selectedDate,
              });
            }}
            disabled={submitting}
          >
            Use {formatDisplayDate(view.offeredAlternativeDate)} instead
          </button>
        </div>
      ) : null}

      {previewReady &&
      view.currentPayments !== null &&
      view.proposedPayments !== null ? (
        <div className="flex flex-col gap-5 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="font-medium text-green-800 dark:text-green-400">
            Your chosen date is available.
          </p>
          {view.policyExplanation !== null ? (
            <p className="text-zinc-600 dark:text-zinc-400">
              {view.policyExplanation}
            </p>
          ) : null}
          {view.warningExplanations.map((warning) => (
            <p key={warning} className="text-amber-700 dark:text-amber-400">
              {warning}
            </p>
          ))}
          <p className="text-amber-700 dark:text-amber-400">
            Confirming will replace your existing recurring payment schedule
            with the proposed schedule shown below.
          </p>
          <p className="font-medium">
            By confirming, you accept the exact payment dates and amounts
            shown below.
          </p>
          <ScheduleList
            title="Your current schedule (next three payments)"
            payments={view.currentPayments}
          />
          <ScheduleList
            title="Your proposed new schedule (next three payments)"
            payments={view.proposedPayments}
          />
          {view.selectedDate !== null ? (
            <p>
              <span className="font-medium">
                Approved new schedule starts:
              </span>{" "}
              {formatDisplayDate(view.selectedDate)}
            </p>
          ) : null}
          <div>
            <button
              type="button"
              className="rounded bg-green-700 px-4 py-1.5 font-medium text-white disabled:bg-zinc-300 disabled:text-zinc-500 dark:bg-green-600 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-500"
              onClick={() => {
                void confirmSchedule();
              }}
              disabled={
                !view.finalConfirmationEnabled ||
                confirmState !== "idle" ||
                submitting
              }
            >
              {confirmState === "submitting"
                ? "Confirming…"
                : confirmState === "submitted"
                  ? "Confirmation submitted"
                  : "Confirm and apply this schedule"}
            </button>
            {view.finalConfirmationEnabled ? (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
                Confirming permanently replaces your recurring schedule with
                the exact dates and amounts shown above. Your confirmation
                is submitted once.
              </p>
            ) : (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
                Customer verification is required before this schedule
                change can be applied. The confirm button stays disabled
                until that verification step is complete.
              </p>
            )}
          </div>
          {confirmNotice !== null ? (
            <p role="alert" className="text-zinc-700 dark:text-zinc-300">
              {confirmNotice}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <button
          type="button"
          className="rounded border border-zinc-300 px-4 py-1.5 font-medium disabled:opacity-50 dark:border-zinc-700"
          onClick={() => {
            void submit({ token, action: "decline" });
          }}
          disabled={submitting || confirmState !== "idle"}
        >
          Decline — keep my current schedule
        </button>
      </div>
    </div>
  );
}
