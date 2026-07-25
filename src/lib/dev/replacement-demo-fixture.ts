/**
 * Localhost-only demonstration configuration for the permanent
 * subscription-replacement journey on the DueLogic dashboard.
 *
 * Sandbox identifiers only — never credentials, tokens, webhook secrets or
 * customer identity data. The expected values below exist for human
 * validation of the live preview: the Pinch preview response is always
 * authoritative, and the UI must keep execution disabled when the live
 * preview disagrees with these expectations instead of trusting them.
 *
 * The demo subscription must remain active and untouched until the one real
 * demonstration execution; nothing in this module performs any call.
 */

export interface ReplacementDemoFixture {
  /** Managed sandbox merchant, sent only as the Current-Merchant header. */
  merchantId: string;
  payerId: string;
  sourceId: string;
  /** The active sandbox subscription the demonstration will replace. */
  subscriptionId: string;
  /** The plan the live preview must confirm before execution is enabled. */
  planId: string;
  /** YYYY-MM-DD start date the subscription is expected to hold today. */
  expectedCurrentStartDate: string;
  /** YYYY-MM-DD requested replacement start date. */
  proposedStartDate: string;
  /**
   * Expected first three fortnightly dates, for human validation only. The
   * live Pinch preview is the authority; a mismatch disables execution.
   */
  expectedProposedDates: readonly string[];
}

export const REPLACEMENT_DEMO_FIXTURE: ReplacementDemoFixture = {
  merchantId: "mch_gsz9TbadIKto3N",
  payerId: "pyr_NEoNZK9KQTssSk",
  sourceId: "src_Ak2GaZAGuRs51k",
  subscriptionId: "sub_lxhN81fQHzqLFA",
  planId: "pln_a1KGV4VGe75U5q",
  expectedCurrentStartDate: "2026-08-14",
  proposedStartDate: "2026-08-17",
  expectedProposedDates: ["2026-08-17", "2026-08-31", "2026-09-14"],
};
