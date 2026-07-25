/**
 * Localhost-only Stage 1 demonstration configuration for the customer-led
 * permanent schedule-correction journey.
 *
 * Sandbox identifiers only — never credentials, tokens, webhook secrets or
 * customer identity data. Deliberately, no subscription ID appears here: the
 * scheduled scan must resolve the current active subscription at runtime
 * through the deterministic read-only resolver, and fail safely when the
 * result is ambiguous.
 *
 * The fixture bridges the two clearly separated evidence domains:
 * - synthetic payment-history evidence (the frozen seed, the detector and
 *   the frozen policy evaluations) designates the demonstration payer;
 * - live Pinch subscription and schedule data is read at runtime under the
 *   managed merchant.
 * The plan-schedule configuration below is trusted merchant-held metadata —
 * cadence and cycle boundaries are never inferred from payment spacing.
 */

import type { MerchantPlanScheduleConfiguration } from "./schema";

export interface InterventionDemoFixture {
  /** Managed sandbox merchant, sent only as the Current-Merchant header. */
  merchantId: string;
  payerId: string;
  sourceId: string;
  planId: string;
  /** Integer cents the resolved subscription must charge per payment. */
  expectedRecurringAmountCents: number;
  scheduleCadence: "fortnightly";
  /**
   * Merchant-held plan-to-schedule mapping for the demonstration plan:
   * fortnightly, 14-day fixed cycles anchored on the trusted anchor date.
   */
  planScheduleConfiguration: MerchantPlanScheduleConfiguration;
  /**
   * Development proof value only. The production implementation must use
   * Merchant.timezone — never a hard-coded constant.
   */
  merchantTimezone: string;
  /**
   * The seed payer whose detected timing pattern designates the
   * demonstration opportunity. The scan verifies this payer is the first
   * approved frozen policy evaluation in payer-ID order.
   */
  designatedSeedPayerId: string;
  /**
   * YYYY-MM-DD: the designated payer's most recent settled demonstration
   * debit — explicit fixture data (like NEXT_SEEDED_DEBITS), supplied as the
   * trusted previousPaymentDate for the permanent policy request. Never
   * inferred at runtime from payment spacing.
   */
  demonstrationPreviousSettledDebitDate: string;
  /**
   * Integer cents of current arrears, supplied explicitly — never inferred
   * from dishonour history. Zero for the demonstration.
   */
  currentArrearsCents: number;
  currency: "AUD";
}

export const INTERVENTION_DEMO_FIXTURE: InterventionDemoFixture = {
  merchantId: "mch_gsz9TbadIKto3N",
  // Clean OTP-rehearsal payer and source (Stage B): a fresh payer with no
  // prior permanent-correction history. The previous demonstration payer
  // consumed its rolling permanent allowance with the verified executed
  // replacement, so it must not receive another routine invitation.
  payerId: "pyr_A71RgcSwgUX6fX",
  sourceId: "src_7TZedAtRpdDQTQ",
  planId: "pln_a1KGV4VGe75U5q",
  expectedRecurringAmountCents: 12500,
  scheduleCadence: "fortnightly",
  planScheduleConfiguration: {
    merchantId: "mch_gsz9TbadIKto3N",
    plans: {
      pln_a1KGV4VGe75U5q: {
        cadence: "fortnightly",
        cycleDefinition: "fixed-days",
        cycleLengthDays: 14,
        cycleAnchorDate: "2026-08-11",
      },
    },
  },
  merchantTimezone: "Australia/Sydney",
  designatedSeedPayerId: "payer-01",
  demonstrationPreviousSettledDebitDate: "2026-06-28",
  currentArrearsCents: 0,
  currency: "AUD",
};
