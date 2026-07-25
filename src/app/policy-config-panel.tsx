"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatAud } from "@/lib/duelogic/display";
import type { MerchantPolicySnapshotProjection } from "@/lib/duelogic/policy/policy-snapshot";

/**
 * Merchant policy configuration over the localhost-only dev policy route.
 * The amount ceiling is the only editable policy value in the current MVP:
 * the browser sends `{ amountCeilingCents }` and nothing else — versions,
 * activation timestamps and every fixed rule value are server-generated or
 * server-held, and activation appends a new immutable snapshot while every
 * previous version stays in history. Merchant-safe projections only: no
 * merchant IDs, no full policy JSON, no store internals and no server
 * error content ever render here.
 */

interface PolicyView {
  active: MerchantPolicySnapshotProjection | null;
  history: MerchantPolicySnapshotProjection[];
}

interface PolicyConfigPanelProps {
  initialActive: MerchantPolicySnapshotProjection | null;
  initialHistory: MerchantPolicySnapshotProjection[];
}

/** Whole dollars with optional cents, e.g. "500", "500.00", "$625.50". */
const AUD_INPUT_PATTERN = /^\$?\s*(\d{1,13})(?:\.(\d{1,2}))?$/;

/**
 * Merchant dollars input to integer cents by string arithmetic — never
 * float multiplication. Null for anything that is not a positive amount.
 */
function parseAudInputToCents(raw: string): number | null {
  const match = AUD_INPUT_PATTERN.exec(raw.trim());
  if (match === null) {
    return null;
  }
  const cents =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

const sydneyFormatter = new Intl.DateTimeFormat("en-AU", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Australia/Sydney",
});

function formatSydney(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return iso;
  }
  return `${sydneyFormatter.format(new Date(parsed))} (Sydney time)`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSnapshotProjection(
  value: unknown,
): MerchantPolicySnapshotProjection | null {
  if (
    !isRecord(value) ||
    typeof value.policyVersion !== "string" ||
    typeof value.activatedAt !== "string" ||
    typeof value.installedAsInitialDefault !== "boolean" ||
    typeof value.amountCeilingCents !== "number" ||
    !Number.isInteger(value.amountCeilingCents) ||
    value.amountCeilingCents <= 0
  ) {
    return null;
  }
  return {
    policyVersion: value.policyVersion,
    activatedAt: value.activatedAt,
    installedAsInitialDefault: value.installedAsInitialDefault,
    amountCeilingCents: value.amountCeilingCents,
  };
}

function parseViewResponse(body: unknown): PolicyView | null {
  if (!isRecord(body) || !Array.isArray(body.history)) {
    return null;
  }
  const history: MerchantPolicySnapshotProjection[] = [];
  for (const entry of body.history) {
    const projection = parseSnapshotProjection(entry);
    if (projection === null) {
      return null;
    }
    history.push(projection);
  }
  const active = parseSnapshotProjection(body.active);
  if (active === null || history.length === 0) {
    return null;
  }
  return { active, history };
}

export function PolicyConfigPanel({
  initialActive,
  initialHistory,
}: PolicyConfigPanelProps) {
  const router = useRouter();
  const [view, setView] = useState<PolicyView>({
    active: initialActive,
    history: initialHistory,
  });
  const [ceilingInput, setCeilingInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const activate = async () => {
    // Blocks duplicate submissions while a request is running; the
    // disabled button already prevents this — the guard covers
    // programmatic re-entry.
    if (busy) {
      return;
    }
    const amountCeilingCents = parseAudInputToCents(ceilingInput);
    if (amountCeilingCents === null) {
      setError(
        "Enter a positive amount in dollars and cents, for example 500.00.",
      );
      setSuccess(null);
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/duelogic/dev/policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The only value the browser may supply. Version, activation time
        // and every fixed rule value are server-held.
        body: JSON.stringify({ amountCeilingCents }),
      });
      const body: unknown = await response.json().catch(() => null);
      const nextView =
        response.ok && isRecord(body) && body.ok === true
          ? parseViewResponse(body)
          : null;
      if (nextView === null || nextView.active === null) {
        setError(
          response.status === 400
            ? "The amount was not accepted. Enter a positive whole-cent amount in dollars, for example 500.00."
            : "The activation could not be confirmed. Refresh the dashboard to see the current active policy.",
        );
        return;
      }
      setView(nextView);
      setCeilingInput("");
      setSuccess(
        `Policy ${nextView.active.policyVersion} is now active with an amount ceiling of ` +
          `${formatAud(nextView.active.amountCeilingCents)}. Previous versions remain in ` +
          "history, and the replay and opportunity figures on this page now reflect the new version.",
      );
      router.refresh();
    } catch {
      setError(
        "The activation request failed. Is the dev server running on localhost?",
      );
    } finally {
      setBusy(false);
    }
  };

  const active = view.active;
  // Most recent activation first for display; the server keeps history in
  // activation order.
  const historyNewestFirst = [...view.history].reverse();

  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">Policy configuration</h2>
        <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-900 dark:bg-sky-950 dark:text-sky-300">
          Immutable versioned snapshots
        </span>
        <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-300">
          Development store
        </span>
      </div>
      <p className="mb-1 text-zinc-600 dark:text-zinc-400">
        Activating saves a new immutable policy version; previous versions
        are never changed and remain in the history below. The payment
        amount ceiling is the only editable policy value in the current
        MVP — every other rule stays fixed.
      </p>
      <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-500">
        Development note: the replay results and opportunity figures on
        this dashboard now evaluate under the active saved policy and
        update after activation. Scheduled interventions and customer date
        evaluation still use the frozen default policy until the next
        controlled policy-binding stage.
      </p>

      {active === null ? (
        <p role="alert" className="text-red-700 dark:text-red-400">
          The active policy could not be read from the development store.
        </p>
      ) : (
        <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="font-medium">Active version</dt>
          <dd className="font-mono text-xs">{active.policyVersion}</dd>
          <dt className="font-medium">Activated</dt>
          <dd>{formatSydney(active.activatedAt)}</dd>
          <dt className="font-medium">Amount ceiling</dt>
          <dd>
            {formatAud(active.amountCeilingCents)}{" "}
            <span className="text-xs text-zinc-500 dark:text-zinc-500">
              — payments above this are escalated for manual review
            </span>
          </dd>
          <dt className="font-medium">Initial default</dt>
          <dd>
            {active.installedAsInitialDefault
              ? "Yes — installed automatically as the starting policy"
              : "No — activated from this panel"}
          </dd>
        </dl>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
            New amount ceiling (AUD)
          </span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="500.00"
            value={ceilingInput}
            onChange={(event) => {
              setCeilingInput(event.target.value);
            }}
            disabled={busy}
            className="w-40 rounded border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700"
          />
        </label>
        <button
          type="button"
          className="rounded bg-zinc-900 px-4 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          onClick={() => {
            void activate();
          }}
          disabled={busy}
        >
          {busy ? "Activating policy…" : "Activate policy"}
        </button>
      </div>

      {success !== null ? (
        <p role="status" className="mt-3 text-green-800 dark:text-green-400">
          {success}
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="mt-3 text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {historyNewestFirst.length > 0 ? (
        <div className="mt-4">
          <h3 className="font-medium">Policy history</h3>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
            Every activated version, most recent first. Versions are
            immutable; the newest is the active policy. This store is
            process-local development memory and resets when the dev server
            restarts.
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
                  <th className="py-1.5 pr-4 font-medium">Version</th>
                  <th className="py-1.5 pr-4 font-medium">Activated</th>
                  <th className="py-1.5 pr-4 font-medium">Amount ceiling</th>
                  <th className="py-1.5 font-medium">Origin</th>
                </tr>
              </thead>
              <tbody>
                {historyNewestFirst.map((snapshot, index) => (
                  <tr
                    key={snapshot.policyVersion}
                    className="border-b border-zinc-100 dark:border-zinc-900"
                  >
                    <td className="py-1.5 pr-4 font-mono text-xs">
                      {snapshot.policyVersion}
                      {index === 0 ? (
                        <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-900 dark:bg-green-950 dark:text-green-300">
                          Active
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-4">
                      {formatSydney(snapshot.activatedAt)}
                    </td>
                    <td className="py-1.5 pr-4">
                      {formatAud(snapshot.amountCeilingCents)}
                    </td>
                    <td className="py-1.5">
                      {snapshot.installedAsInitialDefault
                        ? "Initial default"
                        : "Merchant activation"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
