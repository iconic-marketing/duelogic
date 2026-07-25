import Link from "next/link";
import { addCalendarDays } from "@/lib/duelogic/calendar-date";
import { detectTimingLinkedPatterns } from "@/lib/duelogic/pattern-detector";
import {
  validateDetectionWindowSemantics,
  validateSeedPatternDetection,
} from "@/lib/duelogic/pattern-detector-validation";
import {
  evaluateScheduleChange,
  type PolicyDecision,
  type TemporaryPolicyEvaluationRequest,
} from "@/lib/duelogic/policy/engine";
import { validatePlanScheduleResolver } from "@/lib/duelogic/policy/plan-schedule-validation";
import { DEFAULT_DUELOGIC_POLICY } from "@/lib/duelogic/policy/rules";
import { validatePolicyEngine } from "@/lib/duelogic/policy/validation";
import type { Payer } from "@/lib/duelogic/schema";
import {
  seedMerchant,
  seedPayers,
  seedPaymentRecords,
  seedSummary,
} from "@/lib/duelogic/seed-payment-history";
import { validateReplacementOperationRecovery } from "@/lib/pinch/replacement-operation-validation";
import { MerchantSummary } from "./merchant-summary";
import { PatternPanel } from "./pattern-panel";
import { PaymentHistory } from "./payment-history";
import { PolicyPanel } from "./policy-panel";
import { ReplacementPanel } from "./replacement-panel";

/**
 * The DueLogic merchant dashboard: one page over the frozen deterministic
 * capabilities. Sections 1-5 (summary, history, detected patterns, policy
 * decisions) are server-rendered from the synthetic seed, the detector and
 * the policy engine — no Pinch call, no clock read, no model output. The
 * live permanent-replacement journey is a client panel over the existing
 * localhost-only dev routes and fires nothing until its button is pressed.
 *
 * Following the dev-route convention, the deterministic validation suites
 * are re-asserted on every render; any regression fails the render loudly
 * rather than showing stale claims.
 */

/**
 * The next scheduled debit after the seeded twelve months for each
 * intentionally planted pattern payer — explicit demonstration fixture data
 * (the seed is documented as one debit per payer per month), never inferred
 * at runtime from payment spacing. The requested date is derived from the
 * detector's own proposedShiftDays.
 */
const NEXT_SEEDED_DEBITS: Readonly<
  Record<string, { paymentId: string; currentPaymentDate: string; amountCents: number }>
> = {
  "payer-01": {
    paymentId: "pay-p01-2026-07-upcoming",
    currentPaymentDate: "2026-07-28",
    amountCents: 12900,
  },
  "payer-02": {
    paymentId: "pay-p02-2026-07-upcoming",
    currentPaymentDate: "2026-07-27",
    amountCents: 24950,
  },
};

interface PolicyEvaluationItem {
  payer: Payer;
  request: TemporaryPolicyEvaluationRequest;
  decision: PolicyDecision;
}

export default async function DashboardPage() {
  // Deterministic self-checks, re-asserted per render like the dev routes.
  validateDetectionWindowSemantics();
  const seedValidation = validateSeedPatternDetection();
  const policyValidation = validatePolicyEngine();
  const planScheduleValidation = validatePlanScheduleResolver();
  const recoveryValidation = await validateReplacementOperationRecovery();

  const flags = detectTimingLinkedPatterns(seedPaymentRecords);
  const payersById = new Map(seedPayers.map((payer) => [payer.id, payer]));

  const flaggedItems = flags.flatMap((flag) => {
    const payer = payersById.get(flag.payerId);
    return payer === undefined ? [] : [{ payer, flag }];
  });

  const policyItems: PolicyEvaluationItem[] = flaggedItems.flatMap(
    ({ payer, flag }) => {
      const nextDebit = NEXT_SEEDED_DEBITS[flag.payerId];
      if (nextDebit === undefined) {
        return [];
      }
      const requestedDate = addCalendarDays(
        nextDebit.currentPaymentDate,
        flag.proposedShiftDays,
      );
      if (requestedDate === null) {
        return [];
      }
      const request: TemporaryPolicyEvaluationRequest = {
        changeType: "temporary",
        payerId: flag.payerId,
        paymentId: nextDebit.paymentId,
        amountCents: nextDebit.amountCents,
        evaluationDate: seedSummary.lastScheduledDate,
        currentArrearsCents: 0,
        currentPaymentDate: nextDebit.currentPaymentDate,
        requestedDate,
      };
      const decision = evaluateScheduleChange(
        request,
        [],
        DEFAULT_DUELOGIC_POLICY,
      );
      return [{ payer, request, decision }];
    },
  );

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-10 font-sans text-sm">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">DueLogic</h1>
        <p className="mt-2 max-w-2xl text-zinc-600 dark:text-zinc-400">
          Payment schedule intelligence that identifies recurring timing
          patterns and helps correct future collection dates before the next
          avoidable failure.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-300">
            Synthetic demonstration history
          </span>
          <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-900 dark:bg-sky-950 dark:text-sky-300">
            Deterministic policy evaluation
          </span>
          <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
            Live Pinch sandbox execution
          </span>
        </div>
        <p className="mt-4">
          <Link
            href="/dev/pinch/payment"
            className="font-medium underline underline-offset-4"
          >
            View temporary payment control
          </Link>
        </p>
      </header>

      <MerchantSummary merchant={seedMerchant} summary={seedSummary} />
      <PaymentHistory items={flaggedItems} records={seedPaymentRecords} />
      <PatternPanel
        items={flaggedItems}
        asOfDate={seedSummary.lastScheduledDate}
      />
      <PolicyPanel items={policyItems} policy={DEFAULT_DUELOGIC_POLICY} />
      <ReplacementPanel />

      <details className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <summary className="cursor-pointer font-medium">
          Fallback evidence
        </summary>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          Captured verification evidence is available if the Pinch sandbox is
          unavailable.
        </p>
      </details>

      <footer className="text-xs text-zinc-500 dark:text-zinc-500">
        Deterministic self-checks re-asserted on this render: seed pattern
        detection ({seedValidation.flagCount} flags),{" "}
        {policyValidation.scenarioCount} policy-engine scenarios,{" "}
        {planScheduleValidation.scenarioCount} plan-schedule scenarios,{" "}
        {recoveryValidation.scenarioCount} recovery-operation scenarios.
      </footer>
    </main>
  );
}
