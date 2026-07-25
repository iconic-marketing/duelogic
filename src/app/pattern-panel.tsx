import type { PatternFlag, Payer } from "@/lib/duelogic/schema";
import { formatDisplayDate } from "@/lib/duelogic/display";

/**
 * The detector's findings, rendered exactly as returned. Server component:
 * every figure below comes from the PatternFlag evidence — no counting,
 * clustering or shift arithmetic is repeated here, and no financial cause is
 * ever suggested.
 */

interface PatternPanelProps {
  items: Array<{ payer: Payer; flag: PatternFlag }>;
  /** YYYY-MM-DD anchor the detection ran against. */
  asOfDate: string;
}

function windowDescription(flag: PatternFlag): string {
  const { evidence } = flag;
  if (
    evidence.basis === "day-of-month" &&
    evidence.windowStartDay !== undefined &&
    evidence.windowEndDay !== undefined
  ) {
    return `Days ${evidence.windowStartDay}–${evidence.windowEndDay} of the month`;
  }
  if (evidence.basis === "day-of-week" && evidence.weekday !== undefined) {
    return `Every ${evidence.weekday}`;
  }
  return evidence.basis;
}

export function PatternPanel({ items, asOfDate }: PatternPanelProps) {
  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">Detected timing patterns</h2>
        <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-300">
          Synthetic demonstration history
        </span>
      </div>
      <p className="mb-1 text-zinc-600 dark:text-zinc-400">
        DueLogic identified a recurring timing-linked pattern for each payer
        below. It has not inferred payday, income, affordability, employment
        or financial hardship.
      </p>
      <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-500">
        Deterministic detection over the seeded history as of{" "}
        {formatDisplayDate(asOfDate)}. Only insufficient-funds dishonours
        qualify as pattern evidence.
      </p>
      <div className="flex flex-col gap-5">
        {items.map(({ payer, flag }) => (
          <div
            key={flag.id}
            className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
          >
            <h3 className="font-medium">{payer.displayName}</h3>
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
              <dt className="font-medium">Insufficient-funds dishonours</dt>
              <dd>{flag.evidence.qualifyingDishonourCount}</dd>
              <dt className="font-medium">Recurring window</dt>
              <dd>{windowDescription(flag)}</dd>
              <dt className="font-medium">Dishonoured debits</dt>
              <dd>
                {flag.evidence.qualifyingScheduledDates
                  .map(formatDisplayDate)
                  .join(", ")}
              </dd>
              <dt className="font-medium">Approved later retries</dt>
              <dd>
                <ul className="flex flex-col gap-0.5">
                  {flag.evidence.settlementEvidence.map((settlement) => (
                    <li key={settlement.paymentRecordId}>
                      {formatDisplayDate(settlement.scheduledDate)} debit
                      settled by an approved retry on{" "}
                      {formatDisplayDate(settlement.retryDate)} (
                      {settlement.delayDays}{" "}
                      {settlement.delayDays === 1 ? "day" : "days"} later)
                    </li>
                  ))}
                </ul>
              </dd>
              <dt className="font-medium">Proposed intervention</dt>
              <dd>
                Test shifting this payer&apos;s debit{" "}
                <span className="font-medium">
                  {flag.proposedShiftDays}{" "}
                  {flag.proposedShiftDays === 1 ? "day" : "days"} later
                </span>
                .
              </dd>
            </dl>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
              This pattern qualifies because at least two insufficient-funds
              dishonours cluster in the same recurring window and later
              approved retries landed outside that window. The proposed shift
              is worth testing — it is not a claim that any dishonour would
              have been prevented.
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
