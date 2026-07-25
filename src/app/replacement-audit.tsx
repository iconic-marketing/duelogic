"use client";

import { useCallback, useEffect, useState } from "react";
import { formatAud } from "@/lib/duelogic/display";

/**
 * Audit view of one subscription-replacement operation, read from the
 * existing localhost-only lookup endpoint. Renders only the safe projection
 * that endpoint returns — status, stage, IDs, the verified old-to-new
 * mapping, recovery availability, sanitised failure information and
 * timestamps. The recovery snapshot, reinstatement payload, credentials and
 * payment-source data are never requested and never displayed. Read-only:
 * refreshing re-issues the same GET and mutates nothing.
 */

interface VerifiedMapping {
  oldSubscriptionId: string;
  newSubscriptionId: string;
  verifiedStartDate: string;
  planId: string;
  payerId: string;
  sourceId?: string;
  paymentDates: string[];
  paymentAmountsCents: number[];
}

interface AuditProjection {
  operationId: string;
  /** The consumed customer confirmation's ID — never token material. */
  confirmationId: string | null;
  status: string;
  currentStage: string;
  oldSubscriptionId: string;
  newSubscriptionId: string | null;
  mapping: VerifiedMapping | null;
  recoveryAvailable: boolean;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AuditState {
  scenarioCount: number | null;
  /** Null when the store holds no record for this operation ID. */
  operation: AuditProjection | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseMapping(value: unknown): VerifiedMapping | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.oldSubscriptionId !== "string" ||
    typeof value.newSubscriptionId !== "string" ||
    typeof value.verifiedStartDate !== "string" ||
    typeof value.planId !== "string" ||
    typeof value.payerId !== "string" ||
    !Array.isArray(value.paymentDates) ||
    !Array.isArray(value.paymentAmountsCents) ||
    !value.paymentDates.every((entry) => typeof entry === "string") ||
    !value.paymentAmountsCents.every(
      (entry) => typeof entry === "number" && Number.isInteger(entry),
    )
  ) {
    return null;
  }
  const mapping: VerifiedMapping = {
    oldSubscriptionId: value.oldSubscriptionId,
    newSubscriptionId: value.newSubscriptionId,
    verifiedStartDate: value.verifiedStartDate,
    planId: value.planId,
    payerId: value.payerId,
    paymentDates: value.paymentDates as string[],
    paymentAmountsCents: value.paymentAmountsCents as number[],
  };
  if (typeof value.sourceId === "string") {
    mapping.sourceId = value.sourceId;
  }
  return mapping;
}

function parseProjection(value: unknown): AuditProjection | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.operationId !== "string" ||
    typeof value.status !== "string" ||
    typeof value.currentStage !== "string" ||
    typeof value.oldSubscriptionId !== "string" ||
    typeof value.recoveryAvailable !== "boolean" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    operationId: value.operationId,
    confirmationId: stringOrNull(value.confirmationId),
    status: value.status,
    currentStage: value.currentStage,
    oldSubscriptionId: value.oldSubscriptionId,
    newSubscriptionId: stringOrNull(value.newSubscriptionId),
    mapping: parseMapping(value.mapping),
    recoveryAvailable: value.recoveryAvailable,
    failureCode: stringOrNull(value.failureCode),
    failureMessage: stringOrNull(value.failureMessage),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

interface ReplacementAuditProps {
  operationId: string;
}

export function ReplacementAudit({ operationId }: ReplacementAuditProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditState | null>(null);

  // Mirrors the payment-control pattern: no synchronous setState before the
  // first await when called from an effect.
  const loadAudit = useCallback(async () => {
    try {
      const query = new URLSearchParams({ operationId });
      const response = await fetch(
        `/api/pinch/dev/replacement-operations?${query.toString()}`,
        { cache: "no-store" },
      );
      const body: unknown = await response.json().catch(() => null);
      if (!isRecord(body)) {
        setAudit(null);
        setError("The audit record could not be read. Check the dev server log.");
        return;
      }
      const scenarioCount =
        typeof body.validationScenarioCount === "number"
          ? body.validationScenarioCount
          : null;
      if (response.status === 404 && body.stage === "not-found") {
        setAudit({ scenarioCount, operation: null });
        setError(null);
        return;
      }
      const operation = body.ok === true ? parseProjection(body.operation) : null;
      if (operation === null) {
        setAudit(null);
        setError("The audit record could not be read. Check the dev server log.");
        return;
      }
      setAudit({ scenarioCount, operation });
      setError(null);
    } catch {
      setAudit(null);
      setError("The audit lookup request failed. Is the dev server still running?");
    } finally {
      setLoading(false);
    }
  }, [operationId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAudit();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [loadAudit]);

  const operation = audit?.operation ?? null;

  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold">
          Replacement operation audit record
        </h3>
        <button
          type="button"
          className="rounded border border-zinc-300 px-2.5 py-0.5 text-xs font-medium disabled:opacity-50 dark:border-zinc-700"
          onClick={() => {
            setLoading(true);
            void loadAudit();
          }}
          disabled={loading}
        >
          Refresh
        </button>
      </div>
      {loading ? <p>Reading the audit record…</p> : null}
      {!loading && error !== null ? (
        <p role="alert" className="text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
      {!loading && error === null && audit !== null && operation === null ? (
        <p>
          No audit record was found for operation{" "}
          <span className="font-mono">{operationId}</span> in the temporary
          development store.
        </p>
      ) : null}
      {!loading && error === null && operation !== null ? (
        <>
          {operation.status === "replacement-verified" ? (
            <p className="mb-3 text-green-800 dark:text-green-400">
              Recovery details were recorded and verified before the original
              subscription was cancelled.
            </p>
          ) : null}
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="font-medium">Operation ID</dt>
            <dd className="font-mono text-xs">{operation.operationId}</dd>
            {operation.confirmationId !== null ? (
              <>
                <dt className="font-medium">Customer confirmation</dt>
                <dd className="font-mono text-xs">
                  {operation.confirmationId}
                </dd>
              </>
            ) : null}
            <dt className="font-medium">Status</dt>
            <dd className="font-mono text-xs">{operation.status}</dd>
            <dt className="font-medium">Current stage</dt>
            <dd className="font-mono text-xs">{operation.currentStage}</dd>
            <dt className="font-medium">Old subscription</dt>
            <dd className="font-mono text-xs">{operation.oldSubscriptionId}</dd>
            <dt className="font-medium">New subscription</dt>
            <dd className="font-mono text-xs">
              {operation.newSubscriptionId ?? "not yet known"}
            </dd>
            <dt className="font-medium">Recovery available</dt>
            <dd>{operation.recoveryAvailable ? "Yes" : "No"}</dd>
            {operation.failureCode !== null ? (
              <>
                <dt className="font-medium">Failure code</dt>
                <dd className="font-mono text-xs">{operation.failureCode}</dd>
              </>
            ) : null}
            {operation.failureMessage !== null ? (
              <>
                <dt className="font-medium">Failure detail</dt>
                <dd>{operation.failureMessage}</dd>
              </>
            ) : null}
            <dt className="font-medium">Created</dt>
            <dd className="font-mono text-xs">{operation.createdAt}</dd>
            <dt className="font-medium">Updated</dt>
            <dd className="font-mono text-xs">{operation.updatedAt}</dd>
          </dl>
          {operation.mapping !== null ? (
            <div className="mt-3">
              <p className="font-medium">Verified old-to-new mapping</p>
              <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                <dt className="font-medium">Mapping</dt>
                <dd className="font-mono text-xs">
                  {operation.mapping.oldSubscriptionId} →{" "}
                  {operation.mapping.newSubscriptionId}
                </dd>
                <dt className="font-medium">Verified start date</dt>
                <dd>{operation.mapping.verifiedStartDate}</dd>
                <dt className="font-medium">Plan</dt>
                <dd className="font-mono text-xs">{operation.mapping.planId}</dd>
                <dt className="font-medium">Payer</dt>
                <dd className="font-mono text-xs">{operation.mapping.payerId}</dd>
                {operation.mapping.sourceId !== undefined ? (
                  <>
                    <dt className="font-medium">Source</dt>
                    <dd className="font-mono text-xs">
                      {operation.mapping.sourceId}
                    </dd>
                  </>
                ) : null}
                <dt className="font-medium">Verified payments</dt>
                <dd>
                  <ul className="flex flex-col gap-0.5">
                    {operation.mapping.paymentDates.map((date, index) => (
                      <li key={date}>
                        {date}
                        {operation.mapping !== null &&
                        operation.mapping.paymentAmountsCents[index] !==
                          undefined
                          ? ` — ${formatAud(operation.mapping.paymentAmountsCents[index])}`
                          : ""}
                      </li>
                    ))}
                  </ul>
                </dd>
              </dl>
            </div>
          ) : null}
        </>
      ) : null}
      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-500">
        This sandbox audit record is stored in process memory and will not
        survive a development-server restart.
        {audit?.scenarioCount != null
          ? ` ${audit.scenarioCount} deterministic recovery scenarios were re-asserted by this lookup.`
          : ""}
      </p>
    </section>
  );
}
