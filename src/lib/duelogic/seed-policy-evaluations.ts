/**
 * The deterministic pattern flags and policy evaluations the dashboard
 * renders for the seeded history. Extracted from page.tsx so the merchant
 * opportunity calculation and its validation consume the exact same
 * detector output and policy-evaluation pathway the dashboard displays —
 * never a second, potentially contradictory evaluation.
 */

import { addCalendarDays } from "./calendar-date";
import { detectTimingLinkedPatterns } from "./pattern-detector";
import {
  evaluateScheduleChange,
  type PolicyDecision,
  type TemporaryPolicyEvaluationRequest,
} from "./policy/engine";
import { DEFAULT_DUELOGIC_POLICY } from "./policy/rules";
import type { DueLogicPolicy, PatternFlag, Payer } from "./schema";
import {
  seedPayers,
  seedPaymentRecords,
  seedSummary,
} from "./seed-payment-history";

/**
 * The next scheduled debit after the seeded twelve months for each
 * intentionally planted pattern payer — explicit demonstration fixture data
 * (the seed is documented as one debit per payer per month), never inferred
 * at runtime from payment spacing. The requested date is derived from the
 * detector's own proposedShiftDays.
 */
export const NEXT_SEEDED_DEBITS: Readonly<
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

export interface FlaggedSeedPayer {
  payer: Payer;
  flag: PatternFlag;
}

export interface SeedPolicyEvaluationItem {
  payer: Payer;
  request: TemporaryPolicyEvaluationRequest;
  decision: PolicyDecision;
}

export interface SeedPolicyEvaluations {
  flags: PatternFlag[];
  flaggedItems: FlaggedSeedPayer[];
  policyItems: SeedPolicyEvaluationItem[];
}

/**
 * Runs the detector over the frozen seed and evaluates each flagged payer's
 * next seeded debit against the supplied policy. Pure and deterministic:
 * the evaluation date is fixed to the end of the seeded history and arrears
 * are supplied explicitly as zero. The engine stamps every decision with
 * the supplied policy's own version.
 *
 * The default argument is the frozen DEFAULT_DUELOGIC_POLICY: the Stage 1
 * scheduled intervention scan (and any other caller that supplies no
 * policy) continues to evaluate under duelogic-default-v1 until the
 * separate intervention-binding stage. The dashboard passes the active
 * saved merchant policy snapshot's policy.
 */
export function buildSeedPolicyEvaluations(
  policy: DueLogicPolicy = DEFAULT_DUELOGIC_POLICY,
): SeedPolicyEvaluations {
  const flags = detectTimingLinkedPatterns(seedPaymentRecords);
  const payersById = new Map(seedPayers.map((payer) => [payer.id, payer]));

  const flaggedItems = flags.flatMap((flag) => {
    const payer = payersById.get(flag.payerId);
    return payer === undefined ? [] : [{ payer, flag }];
  });

  const policyItems: SeedPolicyEvaluationItem[] = flaggedItems.flatMap(
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
      const decision = evaluateScheduleChange(request, [], policy);
      return [{ payer, request, decision }];
    },
  );

  return { flags, flaggedItems, policyItems };
}
