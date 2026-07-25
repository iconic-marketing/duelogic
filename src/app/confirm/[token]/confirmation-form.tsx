"use client";

import { useState } from "react";

/**
 * Client half of the customer confirmation page: the explicit Accept and
 * Decline actions. Every state change comes from the server's response —
 * client time is never authoritative, and the server re-evaluates expiry
 * and valid transitions on each request. Shows plain customer language
 * only; no IDs, reason codes or raw JSON.
 */

type ViewStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "expired"
  | "consumed"
  | "error";

interface ConfirmationFormProps {
  token: string;
  initialStatus: "pending" | "accepted" | "declined" | "expired" | "consumed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusFromResponse(body: unknown): ViewStatus | null {
  if (!isRecord(body)) {
    return null;
  }
  const confirmation = isRecord(body.confirmation) ? body.confirmation : null;
  const status = confirmation?.status;
  if (
    status === "pending" ||
    status === "accepted" ||
    status === "declined" ||
    status === "expired" ||
    status === "consumed"
  ) {
    return status;
  }
  return null;
}

export function ConfirmationForm({ token, initialStatus }: ConfirmationFormProps) {
  const [status, setStatus] = useState<ViewStatus>(initialStatus);
  const [submitting, setSubmitting] = useState(false);

  const respond = async (response: "accept" | "decline") => {
    if (submitting || status !== "pending") {
      return;
    }
    setSubmitting(true);
    try {
      const httpResponse = await fetch("/api/duelogic/dev/confirmations/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, response }),
      });
      const body: unknown = await httpResponse.json().catch(() => null);
      if (httpResponse.ok && isRecord(body) && body.ok === true) {
        const confirmed = statusFromResponse(body);
        setStatus(confirmed ?? (response === "accept" ? "accepted" : "declined"));
        return;
      }
      // The server refused the transition; show the server-reported state.
      const reported = statusFromResponse(body);
      if (reported !== null) {
        setStatus(reported);
        return;
      }
      setStatus("error");
    } catch {
      setStatus("error");
    } finally {
      setSubmitting(false);
    }
  };

  if (status === "accepted") {
    return (
      <p className="mt-5 font-medium text-green-800 dark:text-green-400">
        Schedule confirmed. The merchant can now apply the change.
      </p>
    );
  }
  if (status === "declined") {
    return (
      <p className="mt-5 font-medium">
        Schedule change declined. No replacement can be made using this
        confirmation.
      </p>
    );
  }
  if (status === "expired") {
    return (
      <p className="mt-5" role="alert">
        This confirmation link has expired. Ask the merchant to create a new
        request.
      </p>
    );
  }
  if (status === "consumed") {
    return (
      <p className="mt-5 font-medium">
        This confirmation has already been used to apply the schedule change.
      </p>
    );
  }
  if (status === "error") {
    return (
      <p className="mt-5" role="alert">
        Your response could not be recorded. Please reload this page and try
        again, or ask the merchant to create a new request.
      </p>
    );
  }

  return (
    <div className="mt-5 flex flex-wrap gap-3">
      <button
        type="button"
        className="rounded bg-zinc-900 px-4 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        onClick={() => {
          void respond("accept");
        }}
        disabled={submitting}
      >
        {submitting ? "Sending…" : "Accept these dates"}
      </button>
      <button
        type="button"
        className="rounded border border-zinc-300 px-4 py-1.5 font-medium disabled:opacity-50 dark:border-zinc-700"
        onClick={() => {
          void respond("decline");
        }}
        disabled={submitting}
      >
        Decline
      </button>
    </div>
  );
}
