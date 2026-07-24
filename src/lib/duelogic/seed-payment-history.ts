/**
 * Deterministic 12-month synthetic payment history.
 *
 * Every record below is hard-coded — no randomness, no clock reads, no
 * runtime generation — so analysis logic built later can be tested against a
 * stable, reviewable dataset. Nothing here ever existed in Pinch: all records
 * carry `synthetic: true` and no `pinchPaymentId`.
 *
 * The data seeds patterns for later detection logic to find, without encoding
 * any conclusions, eligibility decisions or impact claims:
 * - payer-01 and payer-02 dishonour repeatedly with insufficient funds on
 *   late-in-month debit dates;
 * - payer-03 and payer-04 each have a single isolated insufficient-funds
 *   event, so a recurring pattern can be distinguished from a one-off;
 * - payer-05, payer-06 and payer-07 cover the other dishonour reasons.
 *
 * Bank-account debits falling on a weekend are processed the next Monday;
 * card payments process on the scheduled date.
 */

import type { Merchant, Payer, PaymentRecord } from "./schema";

const MERCHANT_ID = "merchant-duelogic-01";

export const seedMerchant: Merchant = {
  id: MERCHANT_ID,
  name: "DueLogic Sandbox Merchant",
  pinchMerchantId: "mch_gsz9TbadIKto3N",
  timezone: "Australia/Sydney",
};

// pinchPayerId values are deliberately fake ("pyr_synthetic…") so synthetic
// payers can never be confused with real sandbox records.
export const seedPayers: Payer[] = [
  { id: "payer-01", merchantId: MERCHANT_ID, pinchPayerId: "pyr_synthetic01", displayName: "Alicia Nguyen" },
  { id: "payer-02", merchantId: MERCHANT_ID, pinchPayerId: "pyr_synthetic02", displayName: "Ben Carmichael" },
  { id: "payer-03", merchantId: MERCHANT_ID, pinchPayerId: "pyr_synthetic03", displayName: "Chloe Barrett" },
  { id: "payer-04", merchantId: MERCHANT_ID, pinchPayerId: "pyr_synthetic04", displayName: "Daniel Okafor" },
  { id: "payer-05", merchantId: MERCHANT_ID, pinchPayerId: "pyr_synthetic05", displayName: "Emma Whitford" },
  { id: "payer-06", merchantId: MERCHANT_ID, pinchPayerId: "pyr_synthetic06", displayName: "Frank Della Porta" },
  { id: "payer-07", merchantId: MERCHANT_ID, pinchPayerId: "pyr_synthetic07", displayName: "Grace Lin" },
  { id: "payer-08", merchantId: MERCHANT_ID, pinchPayerId: "pyr_synthetic08", displayName: "Harvey Thompson" },
];

/** One payment per payer per month, 2025-07 through 2026-06 inclusive. */
export const seedPaymentRecords: PaymentRecord[] = [
  // payer-01: monthly debit on the 28th; repeated insufficient-funds dishonours
  // (Aug, Oct 2025; Jan, Mar, May 2026), most followed by a retry.
  {
    id: "pay-p01-2025-07", merchantId: MERCHANT_ID, payerId: "payer-01",
    amountCents: 12900, scheduledDate: "2025-07-28", processedDate: "2025-07-28",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p01-2025-08", merchantId: MERCHANT_ID, payerId: "payer-01",
    amountCents: 12900, scheduledDate: "2025-08-28", processedDate: "2025-08-28",
    outcome: "dishonoured", dishonourReason: "insufficient-funds", retryDate: "2025-09-01",
    retryOutcome: "approved", sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p01-2025-09", merchantId: MERCHANT_ID, payerId: "payer-01",
    amountCents: 12900, scheduledDate: "2025-09-28", processedDate: "2025-09-29",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p01-2025-10", merchantId: MERCHANT_ID, payerId: "payer-01",
    amountCents: 12900, scheduledDate: "2025-10-28", processedDate: "2025-10-28",
    outcome: "dishonoured", dishonourReason: "insufficient-funds", retryDate: "2025-11-03",
    retryOutcome: "dishonoured", sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p01-2025-11", merchantId: MERCHANT_ID, payerId: "payer-01",
    amountCents: 12900, scheduledDate: "2025-11-28", processedDate: "2025-11-28",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p01-2025-12", merchantId: MERCHANT_ID, payerId: "payer-01",
    amountCents: 12900, scheduledDate: "2025-12-28", processedDate: "2025-12-29",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p01-2026-01", merchantId: MERCHANT_ID, payerId: "payer-01",
    amountCents: 12900, scheduledDate: "2026-01-28", processedDate: "2026-01-28",
    outcome: "dishonoured", dishonourReason: "insufficient-funds", retryDate: "2026-02-02",
    retryOutcome: "approved", sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p01-2026-02", merchantId: MERCHANT_ID, payerId: "payer-01",
    amountCents: 12900, scheduledDate: "2026-02-28", processedDate: "2026-03-02",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p01-2026-03", merchantId: MERCHANT_ID, payerId: "payer-01",
    amountCents: 12900, scheduledDate: "2026-03-28", processedDate: "2026-03-30",
    outcome: "dishonoured", dishonourReason: "insufficient-funds", retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p01-2026-04", merchantId: MERCHANT_ID, payerId: "payer-01",
    amountCents: 12900, scheduledDate: "2026-04-28", processedDate: "2026-04-28",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p01-2026-05", merchantId: MERCHANT_ID, payerId: "payer-01",
    amountCents: 12900, scheduledDate: "2026-05-28", processedDate: "2026-05-28",
    outcome: "dishonoured", dishonourReason: "insufficient-funds", retryDate: "2026-06-01",
    retryOutcome: "approved", sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p01-2026-06", merchantId: MERCHANT_ID, payerId: "payer-01",
    amountCents: 12900, scheduledDate: "2026-06-28", processedDate: "2026-06-29",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },

  // payer-02: monthly debit on the 27th; repeated insufficient-funds dishonours
  // (Sep, Nov 2025; Feb, Apr 2026), three retried successfully.
  {
    id: "pay-p02-2025-07", merchantId: MERCHANT_ID, payerId: "payer-02",
    amountCents: 24950, scheduledDate: "2025-07-27", processedDate: "2025-07-28",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p02-2025-08", merchantId: MERCHANT_ID, payerId: "payer-02",
    amountCents: 24950, scheduledDate: "2025-08-27", processedDate: "2025-08-27",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p02-2025-09", merchantId: MERCHANT_ID, payerId: "payer-02",
    amountCents: 24950, scheduledDate: "2025-09-27", processedDate: "2025-09-29",
    outcome: "dishonoured", dishonourReason: "insufficient-funds", retryDate: "2025-10-06",
    retryOutcome: "approved", sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p02-2025-10", merchantId: MERCHANT_ID, payerId: "payer-02",
    amountCents: 24950, scheduledDate: "2025-10-27", processedDate: "2025-10-27",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p02-2025-11", merchantId: MERCHANT_ID, payerId: "payer-02",
    amountCents: 24950, scheduledDate: "2025-11-27", processedDate: "2025-11-27",
    outcome: "dishonoured", dishonourReason: "insufficient-funds", retryDate: "2025-12-02",
    retryOutcome: "approved", sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p02-2025-12", merchantId: MERCHANT_ID, payerId: "payer-02",
    amountCents: 24950, scheduledDate: "2025-12-27", processedDate: "2025-12-29",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p02-2026-01", merchantId: MERCHANT_ID, payerId: "payer-02",
    amountCents: 24950, scheduledDate: "2026-01-27", processedDate: "2026-01-27",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p02-2026-02", merchantId: MERCHANT_ID, payerId: "payer-02",
    amountCents: 24950, scheduledDate: "2026-02-27", processedDate: "2026-02-27",
    outcome: "dishonoured", dishonourReason: "insufficient-funds", retryDate: "2026-03-04",
    retryOutcome: "approved", sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p02-2026-03", merchantId: MERCHANT_ID, payerId: "payer-02",
    amountCents: 24950, scheduledDate: "2026-03-27", processedDate: "2026-03-27",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p02-2026-04", merchantId: MERCHANT_ID, payerId: "payer-02",
    amountCents: 24950, scheduledDate: "2026-04-27", processedDate: "2026-04-27",
    outcome: "dishonoured", dishonourReason: "insufficient-funds", retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p02-2026-05", merchantId: MERCHANT_ID, payerId: "payer-02",
    amountCents: 24950, scheduledDate: "2026-05-27", processedDate: "2026-05-27",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p02-2026-06", merchantId: MERCHANT_ID, payerId: "payer-02",
    amountCents: 24950, scheduledDate: "2026-06-27", processedDate: "2026-06-29",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },

  // payer-03: single isolated insufficient-funds dishonour (Dec 2025), retried successfully.
  {
    id: "pay-p03-2025-07", merchantId: MERCHANT_ID, payerId: "payer-03",
    amountCents: 8900, scheduledDate: "2025-07-15", processedDate: "2025-07-15",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p03-2025-08", merchantId: MERCHANT_ID, payerId: "payer-03",
    amountCents: 8900, scheduledDate: "2025-08-15", processedDate: "2025-08-15",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p03-2025-09", merchantId: MERCHANT_ID, payerId: "payer-03",
    amountCents: 8900, scheduledDate: "2025-09-15", processedDate: "2025-09-15",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p03-2025-10", merchantId: MERCHANT_ID, payerId: "payer-03",
    amountCents: 8900, scheduledDate: "2025-10-15", processedDate: "2025-10-15",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p03-2025-11", merchantId: MERCHANT_ID, payerId: "payer-03",
    amountCents: 8900, scheduledDate: "2025-11-15", processedDate: "2025-11-15",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p03-2025-12", merchantId: MERCHANT_ID, payerId: "payer-03",
    amountCents: 8900, scheduledDate: "2025-12-15", processedDate: "2025-12-15",
    outcome: "dishonoured", dishonourReason: "insufficient-funds", retryDate: "2025-12-19",
    retryOutcome: "approved", sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p03-2026-01", merchantId: MERCHANT_ID, payerId: "payer-03",
    amountCents: 8900, scheduledDate: "2026-01-15", processedDate: "2026-01-15",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p03-2026-02", merchantId: MERCHANT_ID, payerId: "payer-03",
    amountCents: 8900, scheduledDate: "2026-02-15", processedDate: "2026-02-15",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p03-2026-03", merchantId: MERCHANT_ID, payerId: "payer-03",
    amountCents: 8900, scheduledDate: "2026-03-15", processedDate: "2026-03-15",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p03-2026-04", merchantId: MERCHANT_ID, payerId: "payer-03",
    amountCents: 8900, scheduledDate: "2026-04-15", processedDate: "2026-04-15",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p03-2026-05", merchantId: MERCHANT_ID, payerId: "payer-03",
    amountCents: 8900, scheduledDate: "2026-05-15", processedDate: "2026-05-15",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p03-2026-06", merchantId: MERCHANT_ID, payerId: "payer-03",
    amountCents: 8900, scheduledDate: "2026-06-15", processedDate: "2026-06-15",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },

  // payer-04: single isolated insufficient-funds dishonour (Feb 2026), no retry recorded.
  {
    id: "pay-p04-2025-07", merchantId: MERCHANT_ID, payerId: "payer-04",
    amountCents: 45000, scheduledDate: "2025-07-01", processedDate: "2025-07-01",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p04-2025-08", merchantId: MERCHANT_ID, payerId: "payer-04",
    amountCents: 45000, scheduledDate: "2025-08-01", processedDate: "2025-08-01",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p04-2025-09", merchantId: MERCHANT_ID, payerId: "payer-04",
    amountCents: 45000, scheduledDate: "2025-09-01", processedDate: "2025-09-01",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p04-2025-10", merchantId: MERCHANT_ID, payerId: "payer-04",
    amountCents: 45000, scheduledDate: "2025-10-01", processedDate: "2025-10-01",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p04-2025-11", merchantId: MERCHANT_ID, payerId: "payer-04",
    amountCents: 45000, scheduledDate: "2025-11-01", processedDate: "2025-11-03",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p04-2025-12", merchantId: MERCHANT_ID, payerId: "payer-04",
    amountCents: 45000, scheduledDate: "2025-12-01", processedDate: "2025-12-01",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p04-2026-01", merchantId: MERCHANT_ID, payerId: "payer-04",
    amountCents: 45000, scheduledDate: "2026-01-01", processedDate: "2026-01-01",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p04-2026-02", merchantId: MERCHANT_ID, payerId: "payer-04",
    amountCents: 45000, scheduledDate: "2026-02-01", processedDate: "2026-02-02",
    outcome: "dishonoured", dishonourReason: "insufficient-funds", retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p04-2026-03", merchantId: MERCHANT_ID, payerId: "payer-04",
    amountCents: 45000, scheduledDate: "2026-03-01", processedDate: "2026-03-02",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p04-2026-04", merchantId: MERCHANT_ID, payerId: "payer-04",
    amountCents: 45000, scheduledDate: "2026-04-01", processedDate: "2026-04-01",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p04-2026-05", merchantId: MERCHANT_ID, payerId: "payer-04",
    amountCents: 45000, scheduledDate: "2026-05-01", processedDate: "2026-05-01",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p04-2026-06", merchantId: MERCHANT_ID, payerId: "payer-04",
    amountCents: 45000, scheduledDate: "2026-06-01", processedDate: "2026-06-01",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },

  // payer-05: one card decline (Nov 2025), otherwise approved.
  {
    id: "pay-p05-2025-07", merchantId: MERCHANT_ID, payerId: "payer-05",
    amountCents: 17525, scheduledDate: "2025-07-10", processedDate: "2025-07-10",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p05-2025-08", merchantId: MERCHANT_ID, payerId: "payer-05",
    amountCents: 17525, scheduledDate: "2025-08-10", processedDate: "2025-08-10",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p05-2025-09", merchantId: MERCHANT_ID, payerId: "payer-05",
    amountCents: 17525, scheduledDate: "2025-09-10", processedDate: "2025-09-10",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p05-2025-10", merchantId: MERCHANT_ID, payerId: "payer-05",
    amountCents: 17525, scheduledDate: "2025-10-10", processedDate: "2025-10-10",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p05-2025-11", merchantId: MERCHANT_ID, payerId: "payer-05",
    amountCents: 17525, scheduledDate: "2025-11-10", processedDate: "2025-11-10",
    outcome: "dishonoured", dishonourReason: "declined", retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p05-2025-12", merchantId: MERCHANT_ID, payerId: "payer-05",
    amountCents: 17525, scheduledDate: "2025-12-10", processedDate: "2025-12-10",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p05-2026-01", merchantId: MERCHANT_ID, payerId: "payer-05",
    amountCents: 17525, scheduledDate: "2026-01-10", processedDate: "2026-01-10",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p05-2026-02", merchantId: MERCHANT_ID, payerId: "payer-05",
    amountCents: 17525, scheduledDate: "2026-02-10", processedDate: "2026-02-10",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p05-2026-03", merchantId: MERCHANT_ID, payerId: "payer-05",
    amountCents: 17525, scheduledDate: "2026-03-10", processedDate: "2026-03-10",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p05-2026-04", merchantId: MERCHANT_ID, payerId: "payer-05",
    amountCents: 17525, scheduledDate: "2026-04-10", processedDate: "2026-04-10",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p05-2026-05", merchantId: MERCHANT_ID, payerId: "payer-05",
    amountCents: 17525, scheduledDate: "2026-05-10", processedDate: "2026-05-10",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p05-2026-06", merchantId: MERCHANT_ID, payerId: "payer-05",
    amountCents: 17525, scheduledDate: "2026-06-10", processedDate: "2026-06-10",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },

  // payer-06: invalid-account dishonour on the first debit (Jul 2025), approved thereafter.
  {
    id: "pay-p06-2025-07", merchantId: MERCHANT_ID, payerId: "payer-06",
    amountCents: 32000, scheduledDate: "2025-07-05", processedDate: "2025-07-07",
    outcome: "dishonoured", dishonourReason: "invalid-account", retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p06-2025-08", merchantId: MERCHANT_ID, payerId: "payer-06",
    amountCents: 32000, scheduledDate: "2025-08-05", processedDate: "2025-08-05",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p06-2025-09", merchantId: MERCHANT_ID, payerId: "payer-06",
    amountCents: 32000, scheduledDate: "2025-09-05", processedDate: "2025-09-05",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p06-2025-10", merchantId: MERCHANT_ID, payerId: "payer-06",
    amountCents: 32000, scheduledDate: "2025-10-05", processedDate: "2025-10-06",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p06-2025-11", merchantId: MERCHANT_ID, payerId: "payer-06",
    amountCents: 32000, scheduledDate: "2025-11-05", processedDate: "2025-11-05",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p06-2025-12", merchantId: MERCHANT_ID, payerId: "payer-06",
    amountCents: 32000, scheduledDate: "2025-12-05", processedDate: "2025-12-05",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p06-2026-01", merchantId: MERCHANT_ID, payerId: "payer-06",
    amountCents: 32000, scheduledDate: "2026-01-05", processedDate: "2026-01-05",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p06-2026-02", merchantId: MERCHANT_ID, payerId: "payer-06",
    amountCents: 32000, scheduledDate: "2026-02-05", processedDate: "2026-02-05",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p06-2026-03", merchantId: MERCHANT_ID, payerId: "payer-06",
    amountCents: 32000, scheduledDate: "2026-03-05", processedDate: "2026-03-05",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p06-2026-04", merchantId: MERCHANT_ID, payerId: "payer-06",
    amountCents: 32000, scheduledDate: "2026-04-05", processedDate: "2026-04-06",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p06-2026-05", merchantId: MERCHANT_ID, payerId: "payer-06",
    amountCents: 32000, scheduledDate: "2026-05-05", processedDate: "2026-05-05",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p06-2026-06", merchantId: MERCHANT_ID, payerId: "payer-06",
    amountCents: 32000, scheduledDate: "2026-06-05", processedDate: "2026-06-05",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },

  // payer-07: one technical-error dishonour (Mar 2026), retried successfully the next day.
  {
    id: "pay-p07-2025-07", merchantId: MERCHANT_ID, payerId: "payer-07",
    amountCents: 9995, scheduledDate: "2025-07-20", processedDate: "2025-07-20",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p07-2025-08", merchantId: MERCHANT_ID, payerId: "payer-07",
    amountCents: 9995, scheduledDate: "2025-08-20", processedDate: "2025-08-20",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p07-2025-09", merchantId: MERCHANT_ID, payerId: "payer-07",
    amountCents: 9995, scheduledDate: "2025-09-20", processedDate: "2025-09-20",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p07-2025-10", merchantId: MERCHANT_ID, payerId: "payer-07",
    amountCents: 9995, scheduledDate: "2025-10-20", processedDate: "2025-10-20",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p07-2025-11", merchantId: MERCHANT_ID, payerId: "payer-07",
    amountCents: 9995, scheduledDate: "2025-11-20", processedDate: "2025-11-20",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p07-2025-12", merchantId: MERCHANT_ID, payerId: "payer-07",
    amountCents: 9995, scheduledDate: "2025-12-20", processedDate: "2025-12-20",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p07-2026-01", merchantId: MERCHANT_ID, payerId: "payer-07",
    amountCents: 9995, scheduledDate: "2026-01-20", processedDate: "2026-01-20",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p07-2026-02", merchantId: MERCHANT_ID, payerId: "payer-07",
    amountCents: 9995, scheduledDate: "2026-02-20", processedDate: "2026-02-20",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p07-2026-03", merchantId: MERCHANT_ID, payerId: "payer-07",
    amountCents: 9995, scheduledDate: "2026-03-20", processedDate: "2026-03-20",
    outcome: "dishonoured", dishonourReason: "technical-error", retryDate: "2026-03-21",
    retryOutcome: "approved", sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p07-2026-04", merchantId: MERCHANT_ID, payerId: "payer-07",
    amountCents: 9995, scheduledDate: "2026-04-20", processedDate: "2026-04-20",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p07-2026-05", merchantId: MERCHANT_ID, payerId: "payer-07",
    amountCents: 9995, scheduledDate: "2026-05-20", processedDate: "2026-05-20",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },
  {
    id: "pay-p07-2026-06", merchantId: MERCHANT_ID, payerId: "payer-07",
    amountCents: 9995, scheduledDate: "2026-06-20", processedDate: "2026-06-20",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "card", synthetic: true,
  },

  // payer-08: fully approved history.
  {
    id: "pay-p08-2025-07", merchantId: MERCHANT_ID, payerId: "payer-08",
    amountCents: 21000, scheduledDate: "2025-07-25", processedDate: "2025-07-25",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p08-2025-08", merchantId: MERCHANT_ID, payerId: "payer-08",
    amountCents: 21000, scheduledDate: "2025-08-25", processedDate: "2025-08-25",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p08-2025-09", merchantId: MERCHANT_ID, payerId: "payer-08",
    amountCents: 21000, scheduledDate: "2025-09-25", processedDate: "2025-09-25",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p08-2025-10", merchantId: MERCHANT_ID, payerId: "payer-08",
    amountCents: 21000, scheduledDate: "2025-10-25", processedDate: "2025-10-27",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p08-2025-11", merchantId: MERCHANT_ID, payerId: "payer-08",
    amountCents: 21000, scheduledDate: "2025-11-25", processedDate: "2025-11-25",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p08-2025-12", merchantId: MERCHANT_ID, payerId: "payer-08",
    amountCents: 21000, scheduledDate: "2025-12-25", processedDate: "2025-12-25",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p08-2026-01", merchantId: MERCHANT_ID, payerId: "payer-08",
    amountCents: 21000, scheduledDate: "2026-01-25", processedDate: "2026-01-26",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p08-2026-02", merchantId: MERCHANT_ID, payerId: "payer-08",
    amountCents: 21000, scheduledDate: "2026-02-25", processedDate: "2026-02-25",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p08-2026-03", merchantId: MERCHANT_ID, payerId: "payer-08",
    amountCents: 21000, scheduledDate: "2026-03-25", processedDate: "2026-03-25",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p08-2026-04", merchantId: MERCHANT_ID, payerId: "payer-08",
    amountCents: 21000, scheduledDate: "2026-04-25", processedDate: "2026-04-27",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p08-2026-05", merchantId: MERCHANT_ID, payerId: "payer-08",
    amountCents: 21000, scheduledDate: "2026-05-25", processedDate: "2026-05-25",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
  {
    id: "pay-p08-2026-06", merchantId: MERCHANT_ID, payerId: "payer-08",
    amountCents: 21000, scheduledDate: "2026-06-25", processedDate: "2026-06-25",
    outcome: "approved", dishonourReason: null, retryOutcome: null,
    sourceType: "bank-account", synthetic: true,
  },
];

export interface SeedSummary {
  paymentCount: number;
  payerCount: number;
  approvedCount: number;
  dishonouredCount: number;
  insufficientFundsCount: number;
  firstScheduledDate: string;
  lastScheduledDate: string;
}

// Derived from the records above rather than duplicated by hand, so the
// summary can never drift from the data.
const sortedScheduledDates = seedPaymentRecords
  .map((record) => record.scheduledDate)
  .sort();

export const seedSummary: SeedSummary = {
  paymentCount: seedPaymentRecords.length,
  payerCount: seedPayers.length,
  approvedCount: seedPaymentRecords.filter(
    (record) => record.outcome === "approved",
  ).length,
  dishonouredCount: seedPaymentRecords.filter(
    (record) => record.outcome === "dishonoured",
  ).length,
  insufficientFundsCount: seedPaymentRecords.filter(
    (record) => record.dishonourReason === "insufficient-funds",
  ).length,
  firstScheduledDate: sortedScheduledDates[0],
  lastScheduledDate: sortedScheduledDates[sortedScheduledDates.length - 1],
};

// ---------------------------------------------------------------------------
// Development-time validation. Runs once at module load — cheap at this size —
// and throws on any inconsistent hand-edit, so bad seed data fails fast
// wherever the module is imported. No runtime dependency required.

function assertSeed(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Invalid DueLogic seed data: ${message}`);
  }
}

function validateSeedPaymentHistory(): void {
  assertSeed(
    seedPaymentRecords.length >= 80 && seedPaymentRecords.length <= 120,
    `payment count ${seedPaymentRecords.length} is outside 80-120`,
  );

  const months = new Set(
    seedPaymentRecords.map((record) => record.scheduledDate.slice(0, 7)),
  );
  assertSeed(
    months.size === 12,
    `expected exactly 12 calendar months, found ${months.size}`,
  );

  const payerIds = new Set(seedPayers.map((payer) => payer.id));
  for (const payer of seedPayers) {
    assertSeed(
      payer.merchantId === seedMerchant.id,
      `${payer.id}: unknown merchant ${payer.merchantId}`,
    );
  }

  for (const record of seedPaymentRecords) {
    assertSeed(
      Number.isInteger(record.amountCents) && record.amountCents > 0,
      `${record.id}: amountCents must be a positive integer`,
    );
    assertSeed(
      record.merchantId === seedMerchant.id,
      `${record.id}: unknown merchant ${record.merchantId}`,
    );
    assertSeed(
      payerIds.has(record.payerId),
      `${record.id}: unknown payer ${record.payerId}`,
    );
    assertSeed(
      record.synthetic === true,
      `${record.id}: seeded records must set synthetic: true`,
    );
    if (record.retryDate !== undefined) {
      // YYYY-MM-DD strings order lexicographically, so > is a date comparison.
      assertSeed(
        record.retryDate > record.processedDate,
        `${record.id}: retryDate must be after processedDate`,
      );
    }
    assertSeed(
      (record.retryDate !== undefined) === (record.retryOutcome !== null),
      `${record.id}: retryDate and retryOutcome must be set together`,
    );
    assertSeed(
      (record.outcome === "dishonoured") === (record.dishonourReason !== null),
      `${record.id}: dishonourReason must be set exactly when dishonoured`,
    );
  }
}

validateSeedPaymentHistory();
