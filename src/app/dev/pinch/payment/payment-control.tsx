"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from "react";

/**
 * Client half of the localhost-only live payment screen. Reads the payment
 * summary and webhook outcome history from the dev API routes, moves the
 * payment date through the existing POST contract, and polls for verified
 * webhook events. All displayed state comes from those routes — nothing about
 * the payment is hardcoded, and a failed mutation is never repeated
 * automatically.
 */

interface PaymentSummary {
  id: string;
  payerId: string;
  amountCents: number;
  transactionDate: string;
  status: string;
  description?: string;
}

interface OutcomeEvent {
  eventId: string;
  type: string;
  eventDate?: string;
  receivedAt: string;
}

/**
 * Temporary operation feedback for the last verified date change — not
 * current payment state. Cleared as soon as a later webhook event arrives or
 * the refreshed payment is no longer scheduled, so it never competes with the
 * live Pinch status shown in the summary.
 */
interface MoveResult {
  previousTransactionDate: string | null;
  transactionDate: string;
}

const OUTCOME_POLL_INTERVAL_MS = 2000;

/** Neutral labels only — an event's arrival is not an outcome claim. */
const EVENT_LABELS: Record<string, string> = {
  "scheduled-process": "Processing started",
  "bank-results": "Bank result received",
};

const audFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
});

/** The one place cents become dollars: the display boundary. */
function formatAud(amountCents: number): string {
  return audFormatter.format(amountCents / 100);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePaymentSummary(body: unknown): PaymentSummary | null {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.payment)) {
    return null;
  }
  const payment = body.payment;
  if (
    typeof payment.id !== "string" ||
    typeof payment.payerId !== "string" ||
    typeof payment.amountCents !== "number" ||
    typeof payment.transactionDate !== "string" ||
    typeof payment.status !== "string"
  ) {
    return null;
  }
  const summary: PaymentSummary = {
    id: payment.id,
    payerId: payment.payerId,
    amountCents: payment.amountCents,
    transactionDate: payment.transactionDate,
    status: payment.status,
  };
  if (typeof payment.description === "string" && payment.description !== "") {
    summary.description = payment.description;
  }
  return summary;
}

function parseOutcomeEvents(body: unknown): OutcomeEvent[] | null {
  if (!isRecord(body) || body.ok !== true || !Array.isArray(body.events)) {
    return null;
  }
  const events: OutcomeEvent[] = [];
  for (const item of body.events) {
    if (
      !isRecord(item) ||
      typeof item.eventId !== "string" ||
      typeof item.type !== "string" ||
      typeof item.receivedAt !== "string"
    ) {
      return null;
    }
    const event: OutcomeEvent = {
      eventId: item.eventId,
      type: item.type,
      receivedAt: item.receivedAt,
    };
    if (typeof item.eventDate === "string") {
      event.eventDate = item.eventDate;
    }
    events.push(event);
  }
  return events;
}

interface PaymentControlProps {
  initialMerchantId: string;
  initialPaymentId: string;
}

export function PaymentControl({
  initialMerchantId,
  initialPaymentId,
}: PaymentControlProps) {
  const [merchantIdInput, setMerchantIdInput] = useState(initialMerchantId);
  const [paymentIdInput, setPaymentIdInput] = useState(initialPaymentId);
  // The identifiers actually in use. Changed only by the Load button, so
  // typing in the inputs never fires Pinch reads on each keystroke.
  const [active, setActive] = useState({
    merchantId: initialMerchantId,
    paymentId: initialPaymentId,
  });

  const [payment, setPayment] = useState<PaymentSummary | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [loadingPayment, setLoadingPayment] = useState(true);

  const [dateInput, setDateInput] = useState("");
  const [moving, setMoving] = useState(false);
  const [moveResult, setMoveResult] = useState<MoveResult | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  const [events, setEvents] = useState<OutcomeEvent[]>([]);
  const [outcomesError, setOutcomesError] = useState<string | null>(null);

  // Deliberately no synchronous setState before the first await: this runs
  // from effects, where React forbids synchronous state updates. Callers that
  // want a loading indicator set loadingPayment themselves first.
  const loadPayment = useCallback(async () => {
    try {
      const query = new URLSearchParams({
        merchantId: active.merchantId,
        paymentId: active.paymentId,
      });
      const response = await fetch(
        `/api/pinch/dev/payment-date?${query.toString()}`,
        { cache: "no-store" },
      );
      const body: unknown = await response.json().catch(() => null);
      const summary = response.ok ? parsePaymentSummary(body) : null;
      if (summary === null) {
        setPayment(null);
        setPaymentError(
          "The payment could not be read. Check the payment and merchant IDs and the dev server log.",
        );
        return;
      }
      setPayment(summary);
      setPaymentError(null);
      // Once the payment leaves scheduled, the date-change confirmation is
      // stale operation feedback and no further move is possible, so both
      // the confirmation and any selected new date are dropped.
      if (summary.status.trim().toLowerCase() !== "scheduled") {
        setMoveResult(null);
        setDateInput("");
      }
    } catch {
      setPayment(null);
      setPaymentError("The payment read request failed. Is the dev server still running?");
    } finally {
      setLoadingPayment(false);
    }
  }, [active]);

  // Initial load, deferred to a cancellable timer so no state update runs
  // synchronously inside the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPayment();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [loadPayment]);

  // Poll the outcome store roughly every two seconds while the tab is
  // visible; when a new verified event appears, re-read the payment summary
  // so the displayed status stays the source of truth. Timers and listeners
  // are cleaned up on unmount and whenever the active payment changes.
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let knownEventIds: Set<string> | null = null;

    const poll = async () => {
      if (disposed || inFlight || document.hidden) {
        return;
      }
      inFlight = true;
      try {
        const query = new URLSearchParams({ paymentId: active.paymentId });
        const response = await fetch(
          `/api/pinch/dev/outcomes?${query.toString()}`,
          { cache: "no-store" },
        );
        const body: unknown = await response.json().catch(() => null);
        const parsed = response.ok ? parseOutcomeEvents(body) : null;
        if (disposed) {
          return;
        }
        if (parsed === null) {
          setOutcomesError("Webhook events could not be read just now; polling continues.");
          return;
        }
        setOutcomesError(null);
        setEvents(parsed);
        const priorIds = knownEventIds;
        knownEventIds = new Set(parsed.map((event) => event.eventId));
        // A dev-server restart clears the store; a shrunken or empty list is
        // displayed as-is rather than treated as an error.
        if (
          priorIds !== null &&
          parsed.some((event) => !priorIds.has(event.eventId))
        ) {
          // A new lifecycle event supersedes the temporary date-change
          // confirmation, even before the refreshed status lands.
          setMoveResult(null);
          void loadPayment();
        }
      } catch {
        if (!disposed) {
          setOutcomesError("Webhook events could not be read just now; polling continues.");
        }
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, OUTCOME_POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (!document.hidden) {
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active, loadPayment]);

  const handleLoadSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const merchantId = merchantIdInput.trim();
    const paymentId = paymentIdInput.trim();
    if (!merchantId.startsWith("mch_") || !paymentId.startsWith("pmt_")) {
      setPaymentError(
        "The merchant ID must start with mch_ and the payment ID with pmt_.",
      );
      return;
    }
    setMoveResult(null);
    setMoveError(null);
    setEvents([]);
    setLoadingPayment(true);
    setActive({ merchantId, paymentId });
  };

  const handleMoveSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The disabled button already blocks double submission; this guard covers
    // programmatic re-entry as well, and refuses to move a payment that is no
    // longer scheduled. A failed mutation is never re-sent.
    if (
      moving ||
      dateInput === "" ||
      payment === null ||
      payment.status.trim().toLowerCase() !== "scheduled"
    ) {
      return;
    }
    setMoving(true);
    setMoveError(null);
    try {
      const response = await fetch("/api/pinch/dev/payment-date", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchantId: active.merchantId,
          paymentId: active.paymentId,
          transactionDate: dateInput,
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (
        response.ok &&
        isRecord(body) &&
        body.ok === true &&
        typeof body.transactionDate === "string" &&
        typeof body.status === "string"
      ) {
        setMoveResult({
          previousTransactionDate:
            typeof body.previousTransactionDate === "string"
              ? body.previousTransactionDate
              : null,
          transactionDate: body.transactionDate,
        });
        await loadPayment();
      } else {
        setMoveResult(null);
        setMoveError(
          "The date update did not complete and was not retried. Check the dev server log before trying again.",
        );
      }
    } catch {
      setMoveResult(null);
      setMoveError(
        "The date update request failed and was not retried. Check the dev server log before trying again.",
      );
    } finally {
      setMoving(false);
    }
  };

  // The live Pinch status is the source of truth: only a currently scheduled
  // payment may be moved. Processing and terminal statuses (approved,
  // dishonoured, cancelled, failed, …) all disable the controls.
  const isScheduled =
    payment !== null && payment.status.trim().toLowerCase() === "scheduled";

  return (
    <div className="mt-6 flex flex-col gap-6 text-sm">
      <form
        onSubmit={handleLoadSubmit}
        className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
      >
        <label className="flex flex-col gap-1">
          <span className="font-medium">Merchant ID</span>
          <input
            className="rounded border border-zinc-300 px-2 py-1 font-mono dark:border-zinc-700 dark:bg-zinc-900"
            value={merchantIdInput}
            onChange={(event) => setMerchantIdInput(event.target.value)}
            spellCheck={false}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">Payment ID</span>
          <input
            className="rounded border border-zinc-300 px-2 py-1 font-mono dark:border-zinc-700 dark:bg-zinc-900"
            value={paymentIdInput}
            onChange={(event) => setPaymentIdInput(event.target.value)}
            spellCheck={false}
          />
        </label>
        <button
          type="submit"
          className="self-start rounded bg-zinc-900 px-4 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          disabled={loadingPayment}
        >
          Load payment
        </button>
      </form>

      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="mb-2 text-base font-semibold">Payment</h2>
        {loadingPayment ? <p>Loading the payment…</p> : null}
        {!loadingPayment && paymentError !== null ? (
          <p role="alert" className="text-red-700 dark:text-red-400">
            {paymentError}
          </p>
        ) : null}
        {!loadingPayment && paymentError === null && payment !== null ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="font-medium">Payment ID</dt>
            <dd className="font-mono">{payment.id}</dd>
            <dt className="font-medium">Amount</dt>
            <dd>{formatAud(payment.amountCents)}</dd>
            <dt className="font-medium">Transaction date</dt>
            <dd>{payment.transactionDate}</dd>
            <dt className="font-medium">Status</dt>
            <dd>{payment.status}</dd>
            {payment.description !== undefined ? (
              <>
                <dt className="font-medium">Description</dt>
                <dd>{payment.description}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </section>

      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="mb-2 text-base font-semibold">Move payment</h2>
        <form onSubmit={handleMoveSubmit} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-medium">New transaction date</span>
            <input
              type="date"
              className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
              value={dateInput}
              onChange={(event) => setDateInput(event.target.value)}
              disabled={!isScheduled}
            />
          </label>
          <button
            type="submit"
            className="rounded bg-zinc-900 px-4 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            disabled={moving || dateInput === "" || !isScheduled}
          >
            {moving ? "Moving…" : "Move payment"}
          </button>
        </form>
        {payment !== null && !isScheduled ? (
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            This payment can no longer be moved because Pinch has started
            processing it.
          </p>
        ) : null}
        {moveError !== null ? (
          <p role="alert" className="mt-2 text-red-700 dark:text-red-400">
            {moveError}
          </p>
        ) : null}
        {moveResult !== null ? (
          <p className="mt-2 text-green-800 dark:text-green-400">
            Date change verified: Pinch scheduled this payment for{" "}
            {moveResult.transactionDate}
            {moveResult.previousTransactionDate !== null
              ? ` (was ${moveResult.previousTransactionDate})`
              : ""}
            .
          </p>
        ) : null}
      </section>

      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="mb-2 text-base font-semibold">
          Webhook events{" "}
          <span className="text-xs font-normal text-zinc-500">
            (oldest event first)
          </span>
        </h2>
        {outcomesError !== null ? (
          <p role="alert" className="text-red-700 dark:text-red-400">
            {outcomesError}
          </p>
        ) : null}
        {events.length === 0 && outcomesError === null ? (
          <p>No verified webhook events received yet.</p>
        ) : null}
        {events.length > 0 ? (
          <ol className="flex flex-col gap-1">
            {events.map((event) => (
              <li key={event.eventId} className="flex flex-wrap gap-x-3">
                <span className="font-medium">
                  {EVENT_LABELS[event.type] ?? event.type}
                </span>
                <span className="text-zinc-600 dark:text-zinc-400">
                  {event.eventDate ?? `received ${event.receivedAt}`}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
        <p className="mt-3">
          <span className="font-medium">Latest payment status: </span>
          {payment !== null ? payment.status : "unknown (payment not loaded)"}
        </p>
        <p className="mt-1 text-zinc-600 dark:text-zinc-400">
          The current Pinch payment status above is the source of truth for the
          outcome; an event alone does not confirm approval, and the status can
          briefly lag behind a new event.
        </p>
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-500">
          Outcome events are held in temporary local development memory and
          reset when the server process restarts.
        </p>
      </section>
    </div>
  );
}
