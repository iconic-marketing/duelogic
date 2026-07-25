"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type {
  InterventionMonitoringSummary,
  MerchantInterventionProjection,
} from "@/lib/duelogic/intervention";

/**
 * Small additive merchant monitoring section for the Stage 1 customer-led
 * intervention journey, plus the localhost-only development action that
 * stands in for the production scheduled scan. The scan is not merchant
 * approval: ordinary eligible requests need no case-by-case merchant
 * sign-off — the merchant monitors invitations and outcomes and handles
 * escalations. Counts and projections are server-rendered from the
 * process-local development store; the raw customer token is never
 * available here, and the customer link is delivered only through the
 * development inbox.
 */

interface InterventionPanelProps {
  summary: InterventionMonitoringSummary;
  interventions: MerchantInterventionProjection[];
}

interface ScanFeedback {
  kind: "created" | "already-active" | "error";
  detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STATUS_LABELS: Array<{
  key: keyof InterventionMonitoringSummary;
  label: string;
}> = [
  { key: "invitationsGenerated", label: "Invitations generated" },
  { key: "pendingDateSelection", label: "Pending date selection" },
  { key: "previewReady", label: "Preview-ready" },
  { key: "declined", label: "Declined" },
  { key: "escalated", label: "Escalated" },
  { key: "expired", label: "Expired" },
  { key: "executed", label: "Executed" },
  { key: "manualRecoveryRequired", label: "Manual recovery" },
];

export function InterventionPanel({
  summary,
  interventions,
}: InterventionPanelProps) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);

  const runScan = async () => {
    if (running) {
      return;
    }
    setRunning(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/duelogic/dev/interventions/scan", {
        method: "POST",
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(body) && body.ok === true) {
        setFeedback(
          body.created === true
            ? {
                kind: "created",
                detail:
                  "One customer invitation was created and delivered to the development inbox.",
              }
            : {
                kind: "already-active",
                detail:
                  "An active invitation already exists for this subscription; no duplicate was created.",
              },
        );
      } else {
        const stage =
          isRecord(body) && typeof body.stage === "string"
            ? body.stage
            : "unknown";
        setFeedback({
          kind: "error",
          detail: `The scan did not create an invitation (stage: ${stage}). See the server log for the safe failure reason.`,
        });
      }
    } catch {
      setFeedback({
        kind: "error",
        detail: "The scan request failed. Is the development server running?",
      });
    } finally {
      setRunning(false);
      router.refresh();
    }
  };

  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">
          Customer-led schedule corrections
        </h2>
        <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-900 dark:bg-sky-950 dark:text-sky-300">
          Execution gated — customer verification pending
        </span>
      </div>
      <p className="mb-4 text-zinc-600 dark:text-zinc-400">
        Invitations are generated automatically for qualifying timing-linked
        patterns under the configured policy. The customer selects the date;
        deterministic code evaluates it; Pinch calculates the authoritative
        schedule. Ordinary eligible requests need no case-by-case merchant
        approval — escalations and exceptions appear here.
      </p>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {STATUS_LABELS.map(({ key, label }) => (
          <div
            key={key}
            className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
          >
            <dt className="text-xs text-zinc-500 dark:text-zinc-500">
              {label}
            </dt>
            <dd className="mt-1 text-xl font-semibold">{summary[key]}</dd>
          </div>
        ))}
      </dl>

      {interventions.length > 0 ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800">
                <th className="py-1.5 pr-4 font-medium">Intervention</th>
                <th className="py-1.5 pr-4 font-medium">Status</th>
                <th className="py-1.5 pr-4 font-medium">Suggested date</th>
                <th className="py-1.5 pr-4 font-medium">Selected date</th>
                <th className="py-1.5 font-medium">Policy outcome</th>
              </tr>
            </thead>
            <tbody>
              {interventions.map((intervention) => (
                <tr
                  key={intervention.interventionId}
                  className="border-b border-zinc-100 dark:border-zinc-900"
                >
                  <td className="py-1.5 pr-4 font-mono text-xs">
                    {intervention.interventionId}
                  </td>
                  <td className="py-1.5 pr-4 font-medium">
                    {intervention.status}
                  </td>
                  <td className="py-1.5 pr-4">{intervention.suggestedDate}</td>
                  <td className="py-1.5 pr-4">
                    {intervention.selectedDate ?? "—"}
                  </td>
                  <td className="py-1.5">
                    {intervention.policyOutcome ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="rounded bg-zinc-900 px-4 py-1.5 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          onClick={() => {
            void runScan();
          }}
          disabled={running}
        >
          {running ? "Running…" : "Run scheduled intervention scan"}
        </button>
        <Link
          href="/dev/duelogic/inbox"
          className="font-medium underline underline-offset-4"
        >
          Open the development customer inbox
        </Link>
      </div>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
        Development action: this button stands in for the production
        scheduled process. It reads live Pinch data (GET only), never
        mutates Pinch, and never asks for merchant approval of an eligible
        request. Records are kept in memory and are lost when the
        development server restarts.
      </p>

      {feedback !== null ? (
        <p
          className={
            feedback.kind === "error"
              ? "mt-3 rounded-md border border-red-300 bg-red-50 p-3 font-medium text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
              : "mt-3 rounded-md border border-emerald-300 bg-emerald-50 p-3 font-medium text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
          }
          role={feedback.kind === "error" ? "alert" : undefined}
        >
          {feedback.detail}
        </p>
      ) : null}
    </section>
  );
}
