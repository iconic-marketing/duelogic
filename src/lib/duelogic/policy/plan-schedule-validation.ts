/**
 * Deterministic validation of the plan-schedule resolver, following the
 * repository's validation convention: checks run once at module load and the
 * exported function re-asserts on demand. Fixtures use only the synthetic
 * demonstration configuration — no live merchant IDs, live Pinch plan IDs or
 * customer information — and the exported table carries outcomes and rule
 * identifiers only. Also re-runs the full 78-scenario policy-engine
 * validation to prove the shared calendar-date extraction changed nothing.
 */

import type { MerchantPlanScheduleConfiguration, PlanScheduleDefinition } from "../schema";
import { DEMO_MERCHANT_PLAN_SCHEDULE_CONFIGURATION } from "./plan-schedule-config";
import {
  resolvePlanScheduleContext,
  type PlanScheduleResolution,
  type ResolvedPlanScheduleContext,
  type ResolvePlanScheduleContextRequest,
} from "./plan-schedule-resolver";
import { PolicyValidationError, type PolicyValidationCode } from "./engine";
import { validatePolicyEngine } from "./validation";

export type PlanScheduleValidationTableRow =
  | {
      scenario: string;
      outcome: "resolved";
      scheduleCadence: string;
    }
  | {
      scenario: string;
      outcome: "escalate";
      reasonCode: string;
    }
  | {
      scenario: string;
      outcome: "validation-error";
      validationCode: PolicyValidationCode;
    };

export interface PlanScheduleValidationResult {
  scenarioCount: number;
  policyEngineScenarioCount: number;
  decisionTable: PlanScheduleValidationTableRow[];
}

const DEMO = DEMO_MERCHANT_PLAN_SCHEDULE_CONFIGURATION;

function demoRequest(
  overrides: Partial<ResolvePlanScheduleContextRequest> = {},
): ResolvePlanScheduleContextRequest {
  return {
    merchantId: "merchant-demo",
    planId: "plan-weekly-demo",
    currentPaymentDate: "2026-01-14",
    nextPaymentDate: "2026-01-21",
    ...overrides,
  };
}

export function validatePlanScheduleResolver(): PlanScheduleValidationResult {
  const table: PlanScheduleValidationTableRow[] = [];

  const check = (condition: boolean, message: string): void => {
    if (!condition) {
      throw new Error(
        `DueLogic plan-schedule resolver validation failed: ${message}`,
      );
    }
  };

  const resolve = (
    scenario: string,
    request: ResolvePlanScheduleContextRequest,
    configuration: MerchantPlanScheduleConfiguration = DEMO,
  ): PlanScheduleResolution => {
    const resolution = resolvePlanScheduleContext(request, configuration);
    if (resolution.outcome === "resolved") {
      table.push({
        scenario,
        outcome: "resolved",
        scheduleCadence: resolution.scheduleCadence,
      });
    } else {
      table.push({
        scenario,
        outcome: "escalate",
        reasonCode: resolution.reasonCode,
      });
    }
    return resolution;
  };

  const asResolved = (
    scenario: string,
    resolution: PlanScheduleResolution,
  ): ResolvedPlanScheduleContext => {
    check(
      resolution.outcome === "resolved",
      `${scenario}: expected a resolved schedule context, observed ${resolution.outcome}`,
    );
    return resolution as ResolvedPlanScheduleContext;
  };

  const expectError = (
    scenario: string,
    expectedCode: PolicyValidationCode,
    run: () => void,
  ): void => {
    let observed: PolicyValidationCode | null = null;
    try {
      run();
    } catch (error) {
      if (!(error instanceof PolicyValidationError)) {
        throw error;
      }
      observed = error.code;
    }
    check(
      observed === expectedCode,
      `${scenario}: expected validation error ${expectedCode}, observed ${observed ?? "no error"}`,
    );
    table.push({ scenario, outcome: "validation-error", validationCode: expectedCode });
  };

  const sameCycles = (
    scenario: string,
    resolved: ResolvedPlanScheduleContext,
    expected: [string, string, string, string],
  ): void => {
    check(
      resolved.currentCycleStartDate === expected[0] &&
        resolved.currentCycleEndDate === expected[1] &&
        resolved.nextCycleStartDate === expected[2] &&
        resolved.nextCycleEndDate === expected[3],
      `${scenario}: expected cycles ${expected.join(", ")}, observed ` +
        `${resolved.currentCycleStartDate}, ${resolved.currentCycleEndDate}, ` +
        `${resolved.nextCycleStartDate}, ${resolved.nextCycleEndDate}`,
    );
  };

  // 1. Weekly mapped plan resolves a 7-day current cycle and contiguous next.
  {
    const resolved = asResolved(
      "r01-weekly-resolves-cycles",
      resolve("r01-weekly-resolves-cycles", demoRequest()),
    );
    check(
      resolved.scheduleCadence === "weekly",
      "r01: cadence must come from the plan map",
    );
    sameCycles("r01-weekly-resolves-cycles", resolved, [
      "2026-01-12",
      "2026-01-18",
      "2026-01-19",
      "2026-01-25",
    ]);
  }

  // 2. Weekly payment dates fit the resolved cycles.
  {
    const request = demoRequest();
    const resolved = asResolved(
      "r02-weekly-payments-fit-cycles",
      resolve("r02-weekly-payments-fit-cycles", request),
    );
    check(
      request.currentPaymentDate >= resolved.currentCycleStartDate &&
        request.currentPaymentDate <= resolved.currentCycleEndDate &&
        request.nextPaymentDate >= resolved.nextCycleStartDate &&
        request.nextPaymentDate <= resolved.nextCycleEndDate,
      "r02: both payment dates must fall inside their resolved cycles",
    );
  }

  // 3. Weekly current payment on the first day of a cycle.
  {
    const resolved = asResolved(
      "r03-weekly-first-cycle-day",
      resolve(
        "r03-weekly-first-cycle-day",
        demoRequest({ currentPaymentDate: "2026-01-12", nextPaymentDate: "2026-01-19" }),
      ),
    );
    sameCycles("r03-weekly-first-cycle-day", resolved, [
      "2026-01-12",
      "2026-01-18",
      "2026-01-19",
      "2026-01-25",
    ]);
  }

  // 4. Weekly current payment on the last day of a cycle.
  {
    const resolved = asResolved(
      "r04-weekly-last-cycle-day",
      resolve(
        "r04-weekly-last-cycle-day",
        demoRequest({ currentPaymentDate: "2026-01-18", nextPaymentDate: "2026-01-20" }),
      ),
    );
    sameCycles("r04-weekly-last-cycle-day", resolved, [
      "2026-01-12",
      "2026-01-18",
      "2026-01-19",
      "2026-01-25",
    ]);
  }

  // 5. Weekly next payment outside the next cycle.
  expectError(
    "r05-weekly-next-payment-mismatch",
    "PLAN_SCHEDULE_CONTEXT_MISMATCH",
    () =>
      resolvePlanScheduleContext(
        demoRequest({ nextPaymentDate: "2026-01-28" }),
        DEMO,
      ),
  );

  // 6. Fortnightly mapped plan resolves a 14-day current and next cycle.
  {
    const resolved = asResolved(
      "r06-fortnightly-resolves-cycles",
      resolve(
        "r06-fortnightly-resolves-cycles",
        demoRequest({
          planId: "plan-fortnightly-demo",
          currentPaymentDate: "2026-01-20",
          nextPaymentDate: "2026-02-03",
        }),
      ),
    );
    check(
      resolved.scheduleCadence === "fortnightly",
      "r06: cadence must come from the plan map",
    );
    sameCycles("r06-fortnightly-resolves-cycles", resolved, [
      "2026-01-15",
      "2026-01-28",
      "2026-01-29",
      "2026-02-11",
    ]);
  }

  // 7. Fortnightly current payment on the first cycle day.
  {
    const resolved = asResolved(
      "r07-fortnightly-first-cycle-day",
      resolve(
        "r07-fortnightly-first-cycle-day",
        demoRequest({
          planId: "plan-fortnightly-demo",
          currentPaymentDate: "2026-01-15",
          nextPaymentDate: "2026-01-29",
        }),
      ),
    );
    sameCycles("r07-fortnightly-first-cycle-day", resolved, [
      "2026-01-15",
      "2026-01-28",
      "2026-01-29",
      "2026-02-11",
    ]);
  }

  // 8. Fortnightly current payment on the last cycle day.
  {
    const resolved = asResolved(
      "r08-fortnightly-last-cycle-day",
      resolve(
        "r08-fortnightly-last-cycle-day",
        demoRequest({
          planId: "plan-fortnightly-demo",
          currentPaymentDate: "2026-01-28",
          nextPaymentDate: "2026-02-01",
        }),
      ),
    );
    sameCycles("r08-fortnightly-last-cycle-day", resolved, [
      "2026-01-15",
      "2026-01-28",
      "2026-01-29",
      "2026-02-11",
    ]);
  }

  // 9. Fortnightly next payment outside the next cycle.
  expectError(
    "r09-fortnightly-next-payment-mismatch",
    "PLAN_SCHEDULE_CONTEXT_MISMATCH",
    () =>
      resolvePlanScheduleContext(
        demoRequest({
          planId: "plan-fortnightly-demo",
          currentPaymentDate: "2026-01-20",
          nextPaymentDate: "2026-02-15",
        }),
        DEMO,
      ),
  );

  // 10. Monthly January and February boundaries.
  {
    const resolved = asResolved(
      "r10-monthly-jan-feb-boundaries",
      resolve(
        "r10-monthly-jan-feb-boundaries",
        demoRequest({
          planId: "plan-monthly-demo",
          currentPaymentDate: "2026-01-31",
          nextPaymentDate: "2026-02-28",
        }),
      ),
    );
    check(
      resolved.scheduleCadence === "monthly",
      "r10: cadence must come from the plan map",
    );
    sameCycles("r10-monthly-jan-feb-boundaries", resolved, [
      "2026-01-01",
      "2026-01-31",
      "2026-02-01",
      "2026-02-28",
    ]);
  }

  // 11. Monthly February in a leap year.
  {
    const resolved = asResolved(
      "r11-monthly-leap-february",
      resolve(
        "r11-monthly-leap-february",
        demoRequest({
          planId: "plan-monthly-demo",
          currentPaymentDate: "2028-02-15",
          nextPaymentDate: "2028-03-10",
        }),
      ),
    );
    sameCycles("r11-monthly-leap-february", resolved, [
      "2028-02-01",
      "2028-02-29",
      "2028-03-01",
      "2028-03-31",
    ]);
  }

  // 12. Monthly next payment in the wrong month.
  expectError(
    "r12-monthly-next-payment-wrong-month",
    "PLAN_SCHEDULE_CONTEXT_MISMATCH",
    () =>
      resolvePlanScheduleContext(
        demoRequest({
          planId: "plan-monthly-demo",
          currentPaymentDate: "2026-01-15",
          nextPaymentDate: "2026-03-15",
        }),
        DEMO,
      ),
  );

  // 13-14. Unmapped plan escalates and returns no cadence or cycle fields.
  {
    const resolution = resolve(
      "r13-unmapped-plan-escalates",
      demoRequest({ planId: "plan-unknown" }),
    );
    check(
      resolution.outcome === "escalate" &&
        resolution.reasonCode === "PERMANENT_PLAN_SCHEDULE_UNMAPPED" &&
        resolution.ruleFired === "merchantPlanScheduleConfiguration.plans" &&
        resolution.explanation ===
          "Automatic permanent date changes are not configured for this payment plan. The request requires merchant review.",
      "r13: an unmapped plan must escalate with the neutral explanation",
    );
    check(
      !("scheduleCadence" in resolution) &&
        !("currentCycleStartDate" in resolution) &&
        !("currentCycleEndDate" in resolution) &&
        !("nextCycleStartDate" in resolution) &&
        !("nextCycleEndDate" in resolution),
      "r14: an unmapped-plan escalation must carry no cadence or cycle boundaries",
    );
    table.push({
      scenario: "r14-unmapped-plan-no-cadence-or-cycles",
      outcome: "escalate",
      reasonCode: "PERMANENT_PLAN_SCHEDULE_UNMAPPED",
    });
  }

  // 15. Blank merchant ID in the configuration.
  expectError(
    "r15-blank-merchant-id",
    "INVALID_PLAN_SCHEDULE_CONFIGURATION",
    () =>
      resolvePlanScheduleContext(demoRequest({ merchantId: "   " }), {
        ...DEMO,
        merchantId: "   ",
      }),
  );

  // 16. Configuration merchant mismatch.
  expectError(
    "r16-configuration-merchant-mismatch",
    "INVALID_PLAN_SCHEDULE_CONFIGURATION",
    () => resolvePlanScheduleContext(demoRequest({ merchantId: "merchant-other" }), DEMO),
  );

  // 17. Blank plan key.
  expectError(
    "r17-blank-plan-key",
    "INVALID_PLAN_SCHEDULE_CONFIGURATION",
    () =>
      resolvePlanScheduleContext(demoRequest(), {
        ...DEMO,
        plans: {
          ...DEMO.plans,
          "   ": {
            cadence: "monthly",
            cycleDefinition: "calendar-month",
          },
        },
      }),
  );

  // 18. Invalid weekly cycle length.
  expectError(
    "r18-invalid-weekly-cycle-length",
    "INVALID_PLAN_SCHEDULE_CONFIGURATION",
    () =>
      resolvePlanScheduleContext(demoRequest(), {
        merchantId: "merchant-demo",
        plans: {
          "plan-weekly-demo": {
            cadence: "weekly",
            cycleDefinition: "fixed-days",
            cycleLengthDays: 6,
            cycleAnchorDate: "2026-01-05",
          } as unknown as PlanScheduleDefinition,
        },
      }),
  );

  // 19. Invalid fortnightly cycle length.
  expectError(
    "r19-invalid-fortnightly-cycle-length",
    "INVALID_PLAN_SCHEDULE_CONFIGURATION",
    () =>
      resolvePlanScheduleContext(
        demoRequest({ planId: "plan-fortnightly-demo" }),
        {
          merchantId: "merchant-demo",
          plans: {
            "plan-fortnightly-demo": {
              cadence: "fortnightly",
              cycleDefinition: "fixed-days",
              cycleLengthDays: 13,
              cycleAnchorDate: "2026-01-01",
            } as unknown as PlanScheduleDefinition,
          },
        },
      ),
  );

  // 20. Invalid cycleAnchorDate.
  expectError(
    "r20-invalid-cycle-anchor-date",
    "INVALID_PLAN_SCHEDULE_CONFIGURATION",
    () =>
      resolvePlanScheduleContext(demoRequest(), {
        merchantId: "merchant-demo",
        plans: {
          "plan-weekly-demo": {
            cadence: "weekly",
            cycleDefinition: "fixed-days",
            cycleLengthDays: 7,
            cycleAnchorDate: "2026-02-30",
          },
        },
      }),
  );

  // 21. Repeated resolution returns deeply equal output.
  {
    const first = resolvePlanScheduleContext(demoRequest(), DEMO);
    const second = resolvePlanScheduleContext(demoRequest(), DEMO);
    check(
      JSON.stringify(first) === JSON.stringify(second),
      "r21: repeated resolution differed",
    );
    table.push({
      scenario: "r21-repeated-resolution-deterministic",
      outcome: "resolved",
      scheduleCadence: "weekly",
    });
  }

  // 22. Reordered plan-map keys produce deeply equal output.
  {
    const reordered: MerchantPlanScheduleConfiguration = {
      merchantId: "merchant-demo",
      plans: {
        "plan-monthly-demo": DEMO.plans["plan-monthly-demo"],
        "plan-fortnightly-demo": DEMO.plans["plan-fortnightly-demo"],
        "plan-weekly-demo": DEMO.plans["plan-weekly-demo"],
      },
    };
    const original = resolvePlanScheduleContext(demoRequest(), DEMO);
    const viaReordered = resolvePlanScheduleContext(demoRequest(), reordered);
    check(
      JSON.stringify(viaReordered) === JSON.stringify(original),
      "r22: reordered plan-map keys changed the output",
    );
    table.push({
      scenario: "r22-plan-map-order-invariant",
      outcome: "resolved",
      scheduleCadence: "weekly",
    });
  }

  // 23. No cadence inference: dates exactly seven days apart still escalate
  // when the plan is unmapped.
  {
    const resolution = resolve(
      "r23-no-inference-from-seven-day-spacing",
      demoRequest({
        planId: "plan-unknown",
        currentPaymentDate: "2026-03-03",
        nextPaymentDate: "2026-03-10",
      }),
    );
    check(
      resolution.outcome === "escalate" &&
        !("scheduleCadence" in resolution),
      "r23: seven-day spacing must not produce an inferred weekly cadence",
    );
  }

  // 24. All 78 existing policy-engine scenarios still pass unchanged.
  const policyResult = validatePolicyEngine();
  check(
    policyResult.scenarioCount === 78,
    `r24: expected the existing 78 policy scenarios to pass, observed ${policyResult.scenarioCount}`,
  );

  return {
    scenarioCount: table.length,
    policyEngineScenarioCount: policyResult.scenarioCount,
    decisionTable: table,
  };
}

validatePlanScheduleResolver();
