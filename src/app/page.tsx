import Link from "next/link";
import { getDevInterventionRepository } from "@/lib/duelogic/dev-intervention-store";
import {
  summariseInterventions,
  toMerchantInterventionProjection,
} from "@/lib/duelogic/intervention";
import { validateInterventionFlow } from "@/lib/duelogic/intervention-validation";
import { calculateMerchantOpportunity } from "@/lib/duelogic/merchant-opportunity";
import { validateMerchantOpportunity } from "@/lib/duelogic/merchant-opportunity-validation";
import {
  validateDetectionWindowSemantics,
  validateSeedPatternDetection,
} from "@/lib/duelogic/pattern-detector-validation";
import {
  DEV_POLICY_MERCHANT_ID,
  getDevMerchantPolicyRepository,
} from "@/lib/duelogic/policy/dev-policy-store";
import { validatePlanScheduleResolver } from "@/lib/duelogic/policy/plan-schedule-validation";
import { buildMerchantPolicyView } from "@/lib/duelogic/policy/policy-activation";
import { validatePolicySnapshotFoundation } from "@/lib/duelogic/policy/policy-snapshot-validation";
import { DEFAULT_DUELOGIC_POLICY } from "@/lib/duelogic/policy/rules";
import { validatePolicyEngine } from "@/lib/duelogic/policy/validation";
import { buildSeedPolicyEvaluations } from "@/lib/duelogic/seed-policy-evaluations";
import {
  seedMerchant,
  seedPayers,
  seedPaymentRecords,
  seedSummary,
} from "@/lib/duelogic/seed-payment-history";
import { validateCustomerConfirmationFlow } from "@/lib/pinch/customer-confirmation-validation";
import { validateReplacementOperationRecovery } from "@/lib/pinch/replacement-operation-validation";
import { InterventionPanel } from "./intervention-panel";
import { MerchantOpportunityPanel } from "./merchant-opportunity-panel";
import { MerchantSummary } from "./merchant-summary";
import { PatternPanel } from "./pattern-panel";
import { PaymentHistory } from "./payment-history";
import { PolicyConfigPanel } from "./policy-config-panel";
import { PolicyPanel } from "./policy-panel";
import { ReplacementPanel } from "./replacement-panel";

/**
 * The DueLogic merchant dashboard: one page over the deterministic
 * capabilities. Sections 1-6 (summary, opportunity, history, detected
 * patterns, policy decisions) are server-rendered from the synthetic seed,
 * the detector and the policy engine — no Pinch call, no model output.
 * The pattern flags and policy evaluations come from the shared
 * seed-policy-evaluations builder evaluated under the active saved
 * merchant policy snapshot, and the merchant opportunity panel aggregates
 * those exact results — never a second evaluation pathway. Scheduled
 * interventions and customer date evaluation still use the frozen default
 * policy until the next controlled binding stage. The live
 * permanent-replacement journey is a client panel over the existing
 * localhost-only dev routes and fires nothing until its button is pressed.
 *
 * Following the dev-route convention, the deterministic validation suites
 * are re-asserted on every render; any regression fails the render loudly
 * rather than showing stale claims.
 */

// Render per request so the page always reads the current process-local
// active policy snapshot: activating a policy then router.refresh() must
// update the replay decisions, opportunity figures and displayed governing
// version — never a build-time static snapshot. This does not change the
// documented process-local persistence limitation.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // Deterministic self-checks, re-asserted per render like the dev routes.
  validateDetectionWindowSemantics();
  const seedValidation = validateSeedPatternDetection();
  const policyValidation = validatePolicyEngine();
  const planScheduleValidation = validatePlanScheduleResolver();
  const opportunityValidation = validateMerchantOpportunity();
  const recoveryValidation = await validateReplacementOperationRecovery();
  const confirmationValidation = await validateCustomerConfirmationFlow();
  const interventionValidation = await validateInterventionFlow();
  const policySnapshotValidation = await validatePolicySnapshotFoundation();

  // Merchant policy state from the process-local development store:
  // merchant-safe projections only reach the client panel. The active
  // snapshot's complete policy governs the replay evaluations and the
  // opportunity figures below — one evaluation pathway, stamped with the
  // active version. Scheduled interventions and customer date evaluation
  // still use the frozen DEFAULT_DUELOGIC_POLICY until the next controlled
  // binding stage.
  const policyRepository = await getDevMerchantPolicyRepository();
  const policyView = await buildMerchantPolicyView(
    policyRepository,
    DEV_POLICY_MERCHANT_ID,
  );
  const activeSnapshot = await policyRepository.readActive(
    DEV_POLICY_MERCHANT_ID,
  );
  const governingPolicy = activeSnapshot?.policy ?? DEFAULT_DUELOGIC_POLICY;

  // Stage 1 monitoring data from the process-local development store:
  // merchant-safe projections only — never token material and never the
  // customer notification delivery artefacts.
  const interventionNowIso = new Date().toISOString();
  const interventionRecords = await getDevInterventionRepository().list();
  const interventionSummary = summariseInterventions(
    interventionRecords,
    interventionNowIso,
  );
  const interventionProjections = interventionRecords.map((record) =>
    toMerchantInterventionProjection(record, interventionNowIso),
  );

  const { flags, flaggedItems, policyItems } =
    buildSeedPolicyEvaluations(governingPolicy);
  const opportunity = calculateMerchantOpportunity({
    payers: seedPayers,
    flags,
    evaluations: policyItems.map(({ request, decision }) => ({
      request,
      decision,
    })),
  });

  // The frozen deterministic decision that governs the demonstrated
  // permanent correction: the first approved evaluation in payer-ID order.
  // Passed to the replacement panel as a narrow summary — the engine is
  // never re-run in the client and no second policy pathway exists.
  const approvedPolicyItem =
    policyItems.find((item) => item.decision.outcome === "approved") ?? null;
  const replacementPolicyDecision =
    approvedPolicyItem === null
      ? null
      : {
          outcome: approvedPolicyItem.decision.outcome,
          reasonCode: approvedPolicyItem.decision.reasonCode,
          policyVersion: approvedPolicyItem.decision.policyVersion,
        };

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
      <MerchantOpportunityPanel
        result={opportunity}
        governingPolicyVersion={governingPolicy.version}
      />
      <PaymentHistory items={flaggedItems} records={seedPaymentRecords} />
      <PatternPanel
        items={flaggedItems}
        asOfDate={seedSummary.lastScheduledDate}
      />
      <PolicyPanel
        items={policyItems}
        policy={governingPolicy}
        activeSnapshot={policyView.active}
      />
      <PolicyConfigPanel
        initialActive={policyView.active}
        initialHistory={policyView.history}
      />
      <ReplacementPanel policyDecision={replacementPolicyDecision} />
      <InterventionPanel
        summary={interventionSummary}
        interventions={interventionProjections}
      />

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
        {opportunityValidation.scenarioCount} merchant-opportunity scenarios,{" "}
        {recoveryValidation.scenarioCount} recovery-operation scenarios,{" "}
        {confirmationValidation.scenarioCount} customer-confirmation
        scenarios, {interventionValidation.scenarioCount} customer-led
        intervention scenarios, {policySnapshotValidation.scenarioCount}{" "}
        policy-snapshot scenarios.
      </footer>
    </main>
  );
}
