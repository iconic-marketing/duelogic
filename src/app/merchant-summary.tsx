import type { Merchant } from "@/lib/duelogic/schema";
import type { SeedSummary } from "@/lib/duelogic/seed-payment-history";
import { formatDisplayDate } from "@/lib/duelogic/display";

/**
 * Merchant-level summary of the frozen synthetic payment history. Server
 * component over the existing seed summary — the seed module remains the
 * single source of truth and nothing here recounts or transforms records.
 */

interface MerchantSummaryProps {
  merchant: Merchant;
  summary: SeedSummary;
}

export function MerchantSummary({ merchant, summary }: MerchantSummaryProps) {
  const figures: Array<{ label: string; value: string }> = [
    { label: "Payers", value: String(summary.payerCount) },
    { label: "Payment records", value: String(summary.paymentCount) },
    { label: "Approved", value: String(summary.approvedCount) },
    { label: "Dishonoured", value: String(summary.dishonouredCount) },
    {
      label: "Insufficient funds",
      value: String(summary.insufficientFundsCount),
    },
    {
      label: "History period",
      value: `${formatDisplayDate(summary.firstScheduledDate)} – ${formatDisplayDate(summary.lastScheduledDate)}`,
    },
  ];

  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">Merchant summary</h2>
        <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-300">
          Synthetic demonstration history
        </span>
      </div>
      <p className="mb-3 text-zinc-600 dark:text-zinc-400">
        Recurring payment history for {merchant.name}. Every record below is
        seeded demonstration data — none of it existed in Pinch.
      </p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        {figures.map((figure) => (
          <div key={figure.label}>
            <dt className="text-xs text-zinc-500 dark:text-zinc-500">
              {figure.label}
            </dt>
            <dd className="font-medium">{figure.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
