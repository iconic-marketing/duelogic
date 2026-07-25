import type {
  DishonourReason,
  PatternFlag,
  Payer,
  PaymentRecord,
} from "@/lib/duelogic/schema";
import { formatAud, formatDisplayDate } from "@/lib/duelogic/display";

/**
 * Twelve-month payment history for the payers the detector flagged. Server
 * component over the frozen seed records — rows are filtered and sorted for
 * display only, never transformed into a second dataset. The timing-window
 * caption comes from the detector's own evidence, not from any history
 * analysis performed here.
 */

const DISHONOUR_LABELS: Record<DishonourReason, string> = {
  "insufficient-funds": "Insufficient funds",
  "invalid-account": "Invalid account",
  declined: "Card declined",
  "technical-error": "Technical error",
};

interface PaymentHistoryProps {
  /** The flagged payers, in flag order, with each payer's flag. */
  items: Array<{ payer: Payer; flag: PatternFlag }>;
  /** The complete frozen seed records; filtered per payer for display. */
  records: readonly PaymentRecord[];
}

function windowCaption(flag: PatternFlag): string {
  const { evidence } = flag;
  if (
    evidence.basis === "day-of-month" &&
    evidence.windowStartDay !== undefined &&
    evidence.windowEndDay !== undefined
  ) {
    return `Flagged detection window: days ${evidence.windowStartDay}–${evidence.windowEndDay} of the month.`;
  }
  if (evidence.basis === "day-of-week" && evidence.weekday !== undefined) {
    return `Flagged detection weekday: ${evidence.weekday}.`;
  }
  return "";
}

function RetryCell({ record }: { record: PaymentRecord }) {
  if (record.retryDate === undefined || record.retryOutcome === null) {
    return <span className="text-zinc-400 dark:text-zinc-600">—</span>;
  }
  const approved = record.retryOutcome === "approved";
  return (
    <span className={approved ? "text-green-800 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
      {approved ? "Approved" : "Dishonoured"} on{" "}
      {formatDisplayDate(record.retryDate)}
    </span>
  );
}

export function PaymentHistory({ items, records }: PaymentHistoryProps) {
  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">Recurring payment history</h2>
        <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-300">
          Synthetic demonstration history
        </span>
      </div>
      <p className="mb-4 text-zinc-600 dark:text-zinc-400">
        The twelve-month debit history for the two payers DueLogic flagged.
        Highlighted rows are insufficient-funds dishonours; the retry column
        shows what happened when the debit was attempted again a few days
        later.
      </p>
      <div className="flex flex-col gap-6">
        {items.map(({ payer, flag }) => {
          const payerRecords = [
            ...records.filter((record) => record.payerId === payer.id),
          ].sort((a, b) => (a.scheduledDate < b.scheduledDate ? -1 : 1));
          const amountCents = payerRecords[0]?.amountCents;
          return (
            <div key={payer.id}>
              <h3 className="font-medium">
                {payer.displayName}{" "}
                <span className="text-xs font-normal text-zinc-500">
                  {amountCents !== undefined
                    ? `${formatAud(amountCents)} per month · `
                    : ""}
                  {windowCaption(flag)}
                </span>
              </h3>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[32rem] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800">
                      <th className="py-1.5 pr-4 font-medium">Scheduled debit</th>
                      <th className="py-1.5 pr-4 font-medium">Outcome</th>
                      <th className="py-1.5 pr-4 font-medium">Reason</th>
                      <th className="py-1.5 font-medium">Retry</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payerRecords.map((record) => {
                      const insufficientFunds =
                        record.dishonourReason === "insufficient-funds";
                      return (
                        <tr
                          key={record.id}
                          className={`border-b border-zinc-100 dark:border-zinc-900 ${
                            insufficientFunds
                              ? "bg-red-50 dark:bg-red-950/40"
                              : ""
                          }`}
                        >
                          <td className="py-1.5 pr-4">
                            {formatDisplayDate(record.scheduledDate)}
                          </td>
                          <td className="py-1.5 pr-4">
                            {record.outcome === "approved" ? (
                              <span className="text-green-800 dark:text-green-400">
                                Approved
                              </span>
                            ) : (
                              <span className="font-medium text-red-700 dark:text-red-400">
                                Dishonoured
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 pr-4">
                            {record.dishonourReason === null ? (
                              <span className="text-zinc-400 dark:text-zinc-600">
                                —
                              </span>
                            ) : (
                              DISHONOUR_LABELS[record.dishonourReason]
                            )}
                          </td>
                          <td className="py-1.5">
                            <RetryCell record={record} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
