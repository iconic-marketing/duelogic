import type {
  PolicyDecision,
  TemporaryPolicyEvaluationRequest,
} from "@/lib/duelogic/policy/engine";
import type { DueLogicPolicy, Payer } from "@/lib/duelogic/schema";
import { formatAud, formatDisplayDate } from "@/lib/duelogic/display";

/**
 * Deterministic policy decisions, rendered exactly as the engine returned
 * them. Server component: the explanation, reason code, rule and warnings
 * are the engine's own output — nothing is reworded — and the governing
 * assumptions are displayed beside the result, not in a footnote.
 */

interface PolicyEvaluationItem {
  payer: Payer;
  request: TemporaryPolicyEvaluationRequest;
  decision: PolicyDecision;
}

interface PolicyPanelProps {
  items: PolicyEvaluationItem[];
  policy: DueLogicPolicy;
}

function outcomeBadge(decision: PolicyDecision) {
  if (decision.outcome === "approved") {
    return (
      <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-900 dark:bg-green-950 dark:text-green-300">
        Approved
      </span>
    );
  }
  return (
    <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-300">
      {decision.outcome}
    </span>
  );
}

export function PolicyPanel({ items, policy }: PolicyPanelProps) {
  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">Policy evaluation</h2>
        <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-900 dark:bg-sky-950 dark:text-sky-300">
          Deterministic policy evaluation
        </span>
      </div>
      <p className="mb-4 text-zinc-600 dark:text-zinc-400">
        Eligibility is decided by deterministic, versioned policy code. No AI
        model participates in these decisions, and every field below is the
        engine&apos;s exact output.
      </p>
      <div className="flex flex-col gap-5">
        {items.map(({ payer, request, decision }) => (
          <div
            key={request.paymentId}
            className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="font-medium">{payer.displayName}</h3>
              {outcomeBadge(decision)}
            </div>
            <p className="mt-2 border-l-2 border-zinc-300 pl-3 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
              {decision.explanation}
            </p>
            <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
              <dt className="font-medium">Outcome</dt>
              <dd>{decision.outcome}</dd>
              <dt className="font-medium">Reason code</dt>
              <dd className="font-mono text-xs">{decision.reasonCode}</dd>
              <dt className="font-medium">Rule fired</dt>
              <dd className="font-mono text-xs">{decision.ruleFired}</dd>
              <dt className="font-medium">Current payment date</dt>
              <dd>{formatDisplayDate(request.currentPaymentDate)}</dd>
              <dt className="font-medium">Requested date</dt>
              <dd>{formatDisplayDate(request.requestedDate)}</dd>
              {"approvedPaymentDate" in decision ? (
                <>
                  <dt className="font-medium">Approved date</dt>
                  <dd>
                    {formatDisplayDate(decision.approvedPaymentDate)} (
                    {decision.shiftDays}{" "}
                    {decision.shiftDays === 1 ? "day" : "days"} later)
                  </dd>
                </>
              ) : null}
              {"alternativeDate" in decision ? (
                <>
                  <dt className="font-medium">Alternative date</dt>
                  <dd>{formatDisplayDate(decision.alternativeDate)}</dd>
                </>
              ) : null}
              <dt className="font-medium">Payment amount</dt>
              <dd>{formatAud(request.amountCents)}</dd>
              <dt className="font-medium">Usage</dt>
              <dd>
                {decision.usage.verifiedUsesInPeriod} of{" "}
                {decision.usage.permittedUses} automatic temporary changes
                used in the rolling period
              </dd>
              <dt className="font-medium">Warnings</dt>
              <dd>
                {decision.warnings.length === 0
                  ? "None"
                  : decision.warnings
                      .map((warning) => warning.explanation)
                      .join(" ")}
              </dd>
              <dt className="font-medium">Policy version</dt>
              <dd className="font-mono text-xs">{decision.policyVersion}</dd>
              <dt className="font-medium">Evaluated at</dt>
              <dd>{formatDisplayDate(decision.evaluatedAt)}</dd>
            </dl>
            <div className="mt-3 rounded bg-zinc-50 p-2.5 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
              <p className="font-medium text-zinc-700 dark:text-zinc-300">
                Active assumptions
              </p>
              <ul className="mt-1 list-inside list-disc">
                <li>
                  Evaluation date fixed to the end of the seeded history (
                  {formatDisplayDate(request.evaluationDate)}) — the engine
                  never reads a clock.
                </li>
                <li>
                  The evaluated payment is this payer&apos;s next seeded
                  monthly debit, stated explicitly as fixture data.
                </li>
                <li>
                  Current arrears supplied explicitly as{" "}
                  {formatAud(request.currentArrearsCents)} — never inferred
                  from dishonour history.
                </li>
                <li>No prior verified schedule changes were supplied.</li>
                <li>
                  Amounts evaluated in integer cents against the policy
                  ceiling of {formatAud(policy.amountCeilingCents)}; temporary
                  shifts are limited to{" "}
                  {policy.temporaryChange.maxShiftDays} calendar days.
                </li>
              </ul>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
