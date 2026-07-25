/**
 * Merchant plan-to-schedule configuration values.
 *
 * Values only: no date calculations, branching, Pinch calls, fetch,
 * environment access or explanation builders. The demonstration
 * configuration below exists for resolver validation only and uses clearly
 * synthetic IDs — never live sandbox merchant or plan IDs. The live
 * merchant's actual plan IDs will later be supplied through merchant
 * configuration or persistence.
 */

import type { MerchantPlanScheduleConfiguration } from "../schema";

export const DEMO_MERCHANT_PLAN_SCHEDULE_CONFIGURATION: MerchantPlanScheduleConfiguration =
  {
    merchantId: "merchant-demo",
    plans: {
      "plan-weekly-demo": {
        cadence: "weekly",
        cycleDefinition: "fixed-days",
        cycleLengthDays: 7,
        cycleAnchorDate: "2026-01-05",
      },
      "plan-fortnightly-demo": {
        cadence: "fortnightly",
        cycleDefinition: "fixed-days",
        cycleLengthDays: 14,
        cycleAnchorDate: "2026-01-01",
      },
      "plan-monthly-demo": {
        cadence: "monthly",
        cycleDefinition: "calendar-month",
      },
    },
  };
