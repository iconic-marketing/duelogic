import type {
  MerchantOpportunityResult,
  MerchantOpportunityRow,
} from "@/lib/duelogic/merchant-opportunity";
import { formatAud, formatDisplayDate } from "@/lib/duelogic/display";

/**
 * The merchant opportunity headline: four derived metrics and one compact
 * row per qualifying payer. Server component over the pure calculation —
 * every figure comes from the detector and the deterministic policy
 * evaluations already rendered further down the page, and nothing here
 * claims prevented dishonours, recovered revenue or any financial cause.
 */

interface MerchantOpportunityPanelProps {
  result: MerchantOpportunityResult;
}

const OUTCOME_LABELS: Record<MerchantOpportunityRow["policyOutcome"], string> =
  {
    approved: "Approved",
    escalate: "Escalated",
    "shorter-alternative": "Shorter alternative",
    "next-cycle-alternative": "Next-cycle alternative",
  };

function OutcomeCell({ row }: { row: MerchantOpportunityRow }) {
  return (
    <div>
      <span
        className={
          row.approvedForReview
            ? "font-medium text-green-800 dark:text-green-400"
            : "font-medium text-amber-800 dark:text-amber-400"
        }
      >
        {OUTCOME_LABELS[row.policyOutcome]}
      </span>
      <span className="block font-mono text-xs text-zinc-500 dark:text-zinc-500">
        {row.reasonCode}
      </span>
    </div>
  );
}

export function MerchantOpportunityPanel({
  result,
}: MerchantOpportunityPanelProps) {
  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">Merchant opportunity</h2>
        <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-300">
          Synthetic demonstration history
        </span>
      </div>
      <p className="mb-1 text-zinc-600 dark:text-zinc-400">
        These upcoming payments are eligible for schedule review under the
        displayed merchant policy.
      </p>
      <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-500">
        This is not a claim that every future dishonour would have been
        prevented.
      </p>

      {result.outcome === "error" ? (
        <p className="rounded-md border border-red-300 bg-red-50 p-3 font-medium text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          Opportunity calculation error ({result.errorCode}): {result.message}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <dt className="text-xs text-zinc-500 dark:text-zinc-500">
                Qualifying customers
              </dt>
              <dd className="mt-1 text-xl font-semibold">
                {result.metrics.qualifyingPayerCount} of{" "}
                {result.metrics.totalPayerCount}
              </dd>
            </div>
            <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <dt className="text-xs text-zinc-500 dark:text-zinc-500">
                Pattern-linked dishonours
              </dt>
              <dd className="mt-1 text-xl font-semibold">
                {result.metrics.patternDishonourCount}
              </dd>
              <dd className="text-xs text-zinc-500 dark:text-zinc-500">
                insufficient funds only
              </dd>
            </div>
            <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <dt className="text-xs text-zinc-500 dark:text-zinc-500">
                Policy-approved interventions
              </dt>
              <dd className="mt-1 text-xl font-semibold">
                {result.metrics.approvedInterventionCount}
              </dd>
            </div>
            <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <dt className="text-xs text-zinc-500 dark:text-zinc-500">
                Upcoming payments eligible for review
              </dt>
              <dd className="mt-1 text-xl font-semibold">
                {formatAud(result.metrics.eligibleAmountCents)}
              </dd>
            </div>
          </dl>

          <p className="mt-3 rounded bg-zinc-50 p-2.5 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
            DueLogic made 0 decisions using inferred payday, income,
            employment, affordability or financial hardship.
          </p>

          {result.rows.length === 0 ? (
            <p className="mt-4 text-zinc-600 dark:text-zinc-400">
              No qualifying timing-linked patterns were identified in the
              current history.
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[40rem] border-collapse text-left">
                <thead>
                  <tr className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800">
                    <th className="py-1.5 pr-4 font-medium">Customer</th>
                    <th className="py-1.5 pr-4 font-medium">
                      Pattern evidence
                    </th>
                    <th className="py-1.5 pr-4 font-medium">Policy result</th>
                    <th className="py-1.5 pr-4 font-medium">
                      Proposed action
                    </th>
                    <th className="py-1.5 pr-4 font-medium">
                      Upcoming payment
                    </th>
                    <th className="py-1.5 font-medium">Proposed date</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr
                      key={row.payerId}
                      className="border-b border-zinc-100 dark:border-zinc-900"
                    >
                      <td className="py-1.5 pr-4 font-medium">
                        {row.displayName}
                      </td>
                      <td className="py-1.5 pr-4">{row.evidenceSummary}</td>
                      <td className="py-1.5 pr-4">
                        <OutcomeCell row={row} />
                      </td>
                      <td className="py-1.5 pr-4">
                        Move {row.proposedShiftDays}{" "}
                        {row.proposedShiftDays === 1 ? "day" : "days"} later
                      </td>
                      <td className="py-1.5 pr-4">
                        {formatAud(row.upcomingAmountCents)}
                      </td>
                      <td className="py-1.5">
                        {formatDisplayDate(row.proposedDate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
