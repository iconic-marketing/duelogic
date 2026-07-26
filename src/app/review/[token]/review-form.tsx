"use client";

import { useState } from "react";
import { formatAud, formatDisplayDate } from "@/lib/duelogic/display";
import type { CustomerInterventionProjection } from "@/lib/duelogic/intervention";
import type { ConfirmedSchedulePayment } from "@/lib/pinch/customer-confirmation";

/**
 * Client half of the customer intervention page: movement choice, date
 * selection under the chosen movement's window, the exact authoritative
 * preview, OTP verification and the single gated final confirmation.
 *
 * Every state change comes from the server's response — availability,
 * windows, previews and enablement are all server-derived, the browser
 * supplies nothing but the token, an action name, a movement-kind name, a
 * date string, the accept-alternative flag and the OTP code, and the
 * server re-evaluates everything on each request. The confirmation
 * dispatch runs entirely server-side off the STORED movement choice: this
 * page never selects an execution path. Shows plain customer language
 * only; no IDs, reason codes or raw JSON.
 */

type MovementKind =
  | "temporary"
  | "permanent-current-cycle"
  | "permanent-next-cycle";

interface MovementOptionView {
  kind: MovementKind;
  label: string;
  copy: string;
  windowStartDate: string;
  windowEndDate: string;
  suggested: boolean;
}

interface MovementView {
  chosenKind: MovementKind | null;
  options: MovementOptionView[];
  reviewRequired: boolean;
  temporaryPreview: {
    currentDate: string;
    newDate: string;
    amountInCents: number;
  } | null;
  temporaryConfirmationEnabled: boolean;
}

interface ReviewFormProps {
  token: string;
  initialView: CustomerInterventionProjection;
  initialMovement: MovementView;
}

type RequestState = "idle" | "submitting" | "error" | "preview-unavailable";
type ConfirmState = "idle" | "submitting" | "submitted";
type OtpPhase = "idle" | "sent";
type OtpBusy = "none" | "requesting" | "verifying";

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
  return intervention as unknown as CustomerInterventionProjection;
}

function movementFromResponse(body: unknown): MovementView | null {
  if (!isRecord(body) || !isRecord(body.movement)) {
    return null;
  }
  const movement = body.movement;
  if (!Array.isArray(movement.options)) {
    return null;
  }
  return movement as unknown as MovementView;
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

export function ReviewForm({
  token,
  initialView,
  initialMovement,
}: ReviewFormProps) {
  const [view, setView] = useState<CustomerInterventionProjection>(initialView);
  const [movement, setMovement] = useState<MovementView>(initialMovement);
  const [selectedKind, setSelectedKind] = useState<MovementKind | null>(
    initialMovement.chosenKind ??
      (initialMovement.options.length === 1
        ? initialMovement.options[0].kind
        : null),
  );
  const [selectedDate, setSelectedDate] = useState<string>(
    initialView.selectedDate ?? initialView.suggestedDate,
  );
  const [requestState, setRequestState] = useState<RequestState>("idle");
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [alternativeDate, setAlternativeDate] = useState<string | null>(null);
  /** Latched away from "idle" on the first confirm click; never reset. */
  const [confirmState, setConfirmState] = useState<ConfirmState>("idle");
  const [confirmNotice, setConfirmNotice] = useState<string | null>(null);
  const [otpPhase, setOtpPhase] = useState<OtpPhase>("idle");
  const [otpBusy, setOtpBusy] = useState<OtpBusy>("none");
  const [otpMaskedMobile, setOtpMaskedMobile] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState("");
  const [otpNotice, setOtpNotice] = useState<string | null>(null);

  const applyResponse = (body: unknown): void => {
    const reportedView = viewFromResponse(body);
    if (reportedView !== null) {
      setView(reportedView);
    }
    const reportedMovement = movementFromResponse(body);
    if (reportedMovement !== null) {
      setMovement(reportedMovement);
    }
  };

  /** Server-derived gate: permanent OR temporary verification present. */
  const confirmEnabled =
    view.finalConfirmationEnabled || movement.temporaryConfirmationEnabled;
  const chosenKind = movement.chosenKind;
  const chosenOption =
    chosenKind === null
      ? null
      : (movement.options.find((option) => option.kind === chosenKind) ?? null);
  const temporaryJourney = chosenKind === "temporary";

  const chooseMovement = async (kind: MovementKind) => {
    if (
      requestState === "submitting" ||
      confirmState !== "idle" ||
      confirmEnabled
    ) {
      return;
    }
    setRequestState("submitting");
    setSelectionNotice(null);
    setAlternativeDate(null);
    try {
      const response = await fetch("/api/duelogic/dev/interventions/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action: "choose-movement", movementKind: kind }),
      });
      const body: unknown = await response.json().catch(() => null);
      applyResponse(body);
      if (response.ok && isRecord(body) && body.ok === true) {
        setSelectedKind(kind);
        setOtpPhase("idle");
        setOtpNotice(null);
        setRequestState("idle");
        return;
      }
      const stage = isRecord(body) ? body.stage : undefined;
      if (stage === "verification-active") {
        setSelectionNotice(
          "Your verification is already in place for the selected option, so the option can no longer be changed.",
        );
      } else if (stage === "movement-unavailable") {
        setSelectionNotice(
          "That option is not currently available. Please choose one of the options shown.",
        );
      }
      setRequestState("idle");
    } catch {
      setRequestState("error");
    }
  };

  const submit = async (
    payload:
      | {
          token: string;
          action: "check-date";
          selectedDate: string;
          acceptOfferedAlternative?: boolean;
        }
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
      applyResponse(body);
      if (response.ok && isRecord(body) && body.ok === true) {
        setAlternativeDate(null);
        setRequestState("idle");
        return;
      }
      const stage = isRecord(body) ? body.stage : undefined;
      if (stage === "alternative-offered" && isRecord(body)) {
        // Temporary journey: the latest permitted date. The customer must
        // actively accept it — nothing is bound until they do.
        setAlternativeDate(
          typeof body.alternativeDate === "string" ? body.alternativeDate : null,
        );
        setSelectionNotice(
          "That date is outside the automatic range for moving this payment.",
        );
        setRequestState("idle");
        return;
      }
      if (stage === "invalid-date" || stage === "outside-window") {
        setSelectionNotice(
          "That date is not available. Please choose a date within the window shown below.",
        );
        setRequestState("idle");
        return;
      }
      if (stage === "payment-not-scheduled" || stage === "payment-unavailable") {
        setSelectionNotice(
          "This payment can no longer be moved automatically. The merchant will review your request.",
        );
        setRequestState("idle");
        return;
      }
      if (stage === "preview-unavailable") {
        setRequestState("preview-unavailable");
        return;
      }
      if (viewFromResponse(body) !== null) {
        setRequestState("idle");
        return;
      }
      setRequestState("error");
    } catch {
      setRequestState("error");
    }
  };

  const requestOtpCode = async () => {
    if (otpBusy !== "none" || confirmState !== "idle") {
      return;
    }
    setOtpBusy("requesting");
    setOtpNotice(null);
    try {
      const response = await fetch(
        "/api/duelogic/dev/interventions/otp/request",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        },
      );
      const body: unknown = await response.json().catch(() => null);
      applyResponse(body);
      if (response.ok && isRecord(body) && body.ok === true) {
        setOtpMaskedMobile(
          typeof body.maskedMobile === "string" ? body.maskedMobile : null,
        );
        setOtpPhase("sent");
        setOtpCode("");
        return;
      }
      const stage = isRecord(body) ? body.stage : undefined;
      if (stage === "mobile-unavailable" || stage === "mobile-invalid") {
        setOtpNotice(
          "A mobile number could not be found for your account, so a code cannot be sent. Please contact the merchant.",
        );
        return;
      }
      setOtpNotice(
        "A verification code could not be sent just now. Please try again shortly.",
      );
    } catch {
      setOtpNotice(
        "A verification code could not be sent just now. Please try again shortly.",
      );
    } finally {
      setOtpBusy("none");
    }
  };

  const verifyOtpCode = async () => {
    if (
      otpBusy !== "none" ||
      confirmState !== "idle" ||
      !/^\d{6}$/.test(otpCode)
    ) {
      return;
    }
    setOtpBusy("verifying");
    setOtpNotice(null);
    try {
      const response = await fetch(
        "/api/duelogic/dev/interventions/otp/verify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, code: otpCode }),
        },
      );
      const body: unknown = await response.json().catch(() => null);
      applyResponse(body);
      if (response.ok && isRecord(body) && body.ok === true) {
        setOtpCode("");
        return;
      }
      const stage = isRecord(body) ? body.stage : undefined;
      if (stage === "otp-incorrect") {
        setOtpNotice(
          "That code is not correct. Please check the latest code and try again.",
        );
        return;
      }
      if (stage === "otp-expired") {
        setOtpNotice("That code has expired. Please send a new code.");
        return;
      }
      setOtpNotice("That code is no longer valid. Please send a new code.");
    } catch {
      setOtpNotice(
        "Your code could not be checked just now. Please try again shortly.",
      );
    } finally {
      setOtpBusy("none");
    }
  };

  const confirmSchedule = async () => {
    if (!confirmEnabled || confirmState !== "idle" || requestState === "submitting") {
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
      applyResponse(body);
      if (response.ok && isRecord(body) && body.ok === true) {
        setConfirmState("submitted");
        return;
      }
      const stage = isRecord(body) ? body.stage : undefined;
      if (stage === "refused") {
        setConfirmNotice(
          "The change could not be completed just now. No changes have been made to your payment schedule.",
        );
      } else if (viewFromResponse(body) === null) {
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

  // ---------------------------------------------------------------------
  // Terminal states

  if (view.status === "executed") {
    if (view.executedMovementKind === "temporary") {
      return (
        <div className="mt-4 flex flex-col gap-4">
          <p className="font-medium text-green-800 dark:text-green-400">
            Your payment date has been updated.
          </p>
          <dl className="flex flex-col gap-0.5">
            {movement.temporaryPreview !== null ? (
              <div className="flex gap-2">
                <dt className="text-zinc-500 dark:text-zinc-500">
                  Original date:
                </dt>
                <dd className="font-medium">
                  {formatDisplayDate(movement.temporaryPreview.currentDate)}
                </dd>
              </div>
            ) : null}
            {view.verifiedTemporaryTransactionDate !== undefined ? (
              <div className="flex gap-2">
                <dt className="text-zinc-500 dark:text-zinc-500">New date:</dt>
                <dd className="font-medium">
                  {formatDisplayDate(view.verifiedTemporaryTransactionDate)}
                </dd>
              </div>
            ) : null}
            <div className="flex gap-2">
              <dt className="text-zinc-500 dark:text-zinc-500">Amount:</dt>
              <dd className="font-medium">
                {formatAud(
                  movement.temporaryPreview?.amountInCents ??
                    view.amountInCents,
                )}
              </dd>
            </div>
          </dl>
          <p className="text-zinc-600 dark:text-zinc-400">
            Only this payment moved. Your regular payments continue as
            scheduled — no further action is needed.
          </p>
        </div>
      );
    }
    return (
      <div className="mt-4 flex flex-col gap-4">
        <p className="font-medium text-green-800 dark:text-green-400">
          Your new payment schedule is confirmed.
        </p>
        <p className="text-zinc-600 dark:text-zinc-400">
          Your recurring schedule has been permanently replaced with the
          exact dates and amounts shown below.
        </p>
        {view.currentPayments !== null ? (
          <ScheduleList
            title="Your previous schedule (before the change)"
            payments={view.currentPayments}
          />
        ) : null}
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
    return (
      <div className="mt-4 flex flex-col gap-3">
        <p className="font-medium">Your confirmation has been received.</p>
        <p className="text-zinc-600 dark:text-zinc-400">
          The update could not be completed automatically just now, or is
          still being finalised. You don&rsquo;t need to do anything further —
          the merchant will review it and contact you if anything needs your
          attention.
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
  if (view.status === "escalated" || movement.reviewRequired) {
    return (
      <div className="mt-4 flex flex-col gap-3">
        <p className="font-medium">
          This request needs a closer look from the merchant.
        </p>
        <p className="text-zinc-600 dark:text-zinc-400">
          Your request has been sent for review. The merchant will contact
          you — no changes have been made to your payment schedule.
        </p>
      </div>
    );
  }

  // ---------------------------------------------------------------------
  // Active journey

  const submitting = requestState === "submitting";
  const previewReady =
    view.status === "preview-ready" &&
    view.currentPayments !== null &&
    view.proposedPayments !== null;
  const temporaryPreviewReady =
    temporaryJourney && movement.temporaryPreview !== null;
  const showOtpSection =
    (temporaryJourney ? temporaryPreviewReady : previewReady) &&
    !confirmEnabled;
  const showConfirmSection = temporaryJourney
    ? temporaryPreviewReady
    : previewReady;
  const dateWindow = chosenOption;

  return (
    <div className="mt-4 flex flex-col gap-5">
      {/* Why the review is available, then the invitation's validity. */}
      <div>
        <p className="text-zinc-600 dark:text-zinc-400">
          An upcoming payment may be eligible for an alternative date. No
          change will be made unless you complete verification and give
          final confirmation.
        </p>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
          This invitation expires at {formatExpiry(view.expiresAt)}.
        </p>
      </div>

      {/* Current upcoming payment details. */}
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
        </dl>
      </div>

      {/* Movement choice: server-derived availability only. */}
      <div className="flex flex-col gap-3">
        <p className="font-medium">How would you like to adjust this payment?</p>
        {movement.options.map((option) => {
          const active = chosenKind === option.kind;
          return (
            <div
              key={option.kind}
              className={
                active
                  ? "rounded-lg border-2 border-zinc-900 p-4 dark:border-zinc-100"
                  : "rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
              }
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <p className="font-semibold">{option.label}</p>
                {option.suggested ? (
                  <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-900 dark:bg-sky-950 dark:text-sky-300">
                    Suggested based on your recent payment changes
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                {option.copy}
              </p>
              {active ? (
                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
                  Selected. You can choose a date between{" "}
                  {formatDisplayDate(option.windowStartDate)} and{" "}
                  {formatDisplayDate(option.windowEndDate)}.
                </p>
              ) : (
                <button
                  type="button"
                  className="mt-3 rounded bg-zinc-900 px-4 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                  onClick={() => {
                    setSelectedKind(option.kind);
                    void chooseMovement(option.kind);
                  }}
                  disabled={submitting || confirmEnabled || confirmState !== "idle"}
                >
                  {selectedKind === option.kind && submitting
                    ? "Selecting…"
                    : "Choose this option"}
                </button>
              )}
            </div>
          );
        })}
        {confirmEnabled ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-500">
            Your verification is in place for the selected option, so the
            option and dates can no longer be changed.
          </p>
        ) : null}
      </div>

      {/* Date selection under the chosen movement's window. */}
      {chosenKind !== null && dateWindow !== null && !confirmEnabled ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
              New payment date
            </span>
            <input
              type="date"
              value={selectedDate}
              min={dateWindow.windowStartDate}
              max={
                view.offeredAlternativeDate ?? dateWindow.windowEndDate
              }
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
          {temporaryJourney && view.scheduleCadence === "monthly" ? (
            <p className="w-full text-xs text-zinc-500 dark:text-zinc-500">
              The revised date must remain within the same calendar month.
            </p>
          ) : null}
        </div>
      ) : null}

      {selectionNotice !== null ? (
        <p className="text-amber-700 dark:text-amber-400" role="alert">
          {selectionNotice}
        </p>
      ) : null}
      {alternativeDate !== null && !confirmEnabled ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium text-amber-900 dark:text-amber-300">
            The latest date available for this payment is{" "}
            {formatDisplayDate(alternativeDate)}.
          </p>
          <button
            type="button"
            className="mt-3 rounded bg-zinc-900 px-4 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            onClick={() => {
              setSelectedDate(alternativeDate);
              void submit({
                token,
                action: "check-date",
                selectedDate: alternativeDate,
                acceptOfferedAlternative: true,
              });
            }}
            disabled={submitting}
          >
            Use {formatDisplayDate(alternativeDate)} instead
          </button>
        </div>
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

      {/* Permanent alternative (engine-offered next-cycle date). */}
      {!temporaryJourney &&
      view.status === "alternative-offered" &&
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

      {/* Temporary preview: the exact bound one-payment movement. */}
      {temporaryPreviewReady && movement.temporaryPreview !== null ? (
        <div className="flex flex-col gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="font-medium text-green-800 dark:text-green-400">
            Your chosen date is available.
          </p>
          <div>
            <h2 className="font-medium">Payment being changed</h2>
            <dl className="mt-1 flex flex-col gap-0.5">
              <div className="flex gap-2">
                <dt className="text-zinc-500 dark:text-zinc-500">
                  Current date:
                </dt>
                <dd className="font-medium">
                  {formatDisplayDate(movement.temporaryPreview.currentDate)}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-zinc-500 dark:text-zinc-500">New date:</dt>
                <dd className="font-medium">
                  {formatDisplayDate(movement.temporaryPreview.newDate)}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-zinc-500 dark:text-zinc-500">Amount:</dt>
                <dd className="font-medium">
                  {formatAud(movement.temporaryPreview.amountInCents)}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-zinc-500 dark:text-zinc-500">
                  Regular schedule:
                </dt>
                <dd>Your later recurring payments will remain unchanged.</dd>
              </div>
            </dl>
          </div>
          <p className="text-zinc-600 dark:text-zinc-400">
            Only this payment will move. Your regular payment schedule will
            continue after it.
          </p>
        </div>
      ) : null}

      {/* Permanent preview: the exact Pinch-calculated schedules. */}
      {!temporaryJourney &&
      previewReady &&
      view.currentPayments !== null &&
      view.proposedPayments !== null ? (
        <div className="flex flex-col gap-5 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="font-medium text-green-800 dark:text-green-400">
            Your chosen date is available.
          </p>
          {chosenKind === "permanent-next-cycle" ? (
            <p className="text-zinc-600 dark:text-zinc-400">
              Your upcoming payment of {formatAud(view.amountInCents)} on{" "}
              {formatDisplayDate(view.currentScheduledDate)} stays exactly as
              it is. Your new regular schedule begins from the next billing
              cycle, as shown below.
            </p>
          ) : (
            <p className="text-zinc-600 dark:text-zinc-400">
              Your upcoming payment moves to the new date, and future
              payments follow the revised schedule shown below.
            </p>
          )}
          {view.policyExplanation !== null ? (
            <p className="text-zinc-600 dark:text-zinc-400">
              {view.policyExplanation}
            </p>
          ) : null}
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
          {/* Close-payment warnings, after the exact dates they concern. */}
          {view.warningExplanations.map((warning) => (
            <p key={warning} className="text-amber-700 dark:text-amber-400">
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      {/* OTP verification, then the single gated final confirmation. */}
      {showOtpSection ? (
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="font-medium">Verify it&rsquo;s you</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            We&rsquo;ll send a verification code to the mobile number held on
            your payer record.
          </p>
          {otpMaskedMobile !== null && otpPhase === "sent" ? (
            <p className="mt-2">
              A code was sent to{" "}
              <span className="font-medium">{otpMaskedMobile}</span>. It
              expires in 5 minutes.
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-end gap-3">
            {otpPhase === "sent" ? (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                    6-digit code
                  </span>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="\d{6}"
                    maxLength={6}
                    value={otpCode}
                    onChange={(event) => {
                      setOtpCode(
                        event.target.value.replace(/\D/g, "").slice(0, 6),
                      );
                    }}
                    className="w-32 rounded border border-zinc-300 px-3 py-1.5 font-mono tracking-widest dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </label>
                <button
                  type="button"
                  className="rounded bg-zinc-900 px-4 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                  onClick={() => {
                    void verifyOtpCode();
                  }}
                  disabled={
                    otpBusy !== "none" ||
                    confirmState !== "idle" ||
                    !/^\d{6}$/.test(otpCode)
                  }
                >
                  {otpBusy === "verifying" ? "Checking…" : "Verify code"}
                </button>
                <button
                  type="button"
                  className="rounded border border-zinc-300 px-4 py-1.5 font-medium disabled:opacity-50 dark:border-zinc-700"
                  onClick={() => {
                    void requestOtpCode();
                  }}
                  disabled={otpBusy !== "none" || confirmState !== "idle"}
                >
                  {otpBusy === "requesting" ? "Sending…" : "Send a new code"}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="rounded bg-zinc-900 px-4 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                onClick={() => {
                  void requestOtpCode();
                }}
                disabled={otpBusy !== "none" || confirmState !== "idle"}
              >
                {otpBusy === "requesting"
                  ? "Sending…"
                  : "Send verification code"}
              </button>
            )}
          </div>
          {otpNotice !== null ? (
            <p role="alert" className="mt-2 text-amber-700 dark:text-amber-400">
              {otpNotice}
            </p>
          ) : null}
          <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-500">
            Development note: simulated SMS messages are delivered to the{" "}
            <a
              href="/dev/duelogic/sms"
              className="underline underline-offset-4"
            >
              development SMS inbox
            </a>
            .
          </p>
        </div>
      ) : null}

      {showConfirmSection ? (
        <div>
          {confirmEnabled ? (
            <p className="mb-2 font-medium text-green-800 dark:text-green-400">
              Mobile verification complete.
            </p>
          ) : null}
          <button
            type="button"
            className="rounded bg-green-700 px-4 py-1.5 font-medium text-white disabled:bg-zinc-300 disabled:text-zinc-500 dark:bg-green-600 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-500"
            onClick={() => {
              void confirmSchedule();
            }}
            disabled={!confirmEnabled || confirmState !== "idle" || submitting}
          >
            {confirmState === "submitting"
              ? "Confirming…"
              : confirmState === "submitted"
                ? "Confirmation submitted"
                : temporaryJourney
                  ? "Confirm and move this payment"
                  : "Confirm and apply this schedule"}
          </button>
          {confirmEnabled ? (
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
              {temporaryJourney
                ? "Confirming moves only this payment to the exact date shown above. Your confirmation is submitted once."
                : "Confirming permanently replaces your recurring schedule with the exact dates and amounts shown above. Your confirmation is submitted once."}
            </p>
          ) : (
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
              Customer verification is required before this change can be
              applied. The confirm button stays disabled until that
              verification step is complete.
            </p>
          )}
          {confirmNotice !== null ? (
            <p role="alert" className="mt-2 text-zinc-700 dark:text-zinc-300">
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
