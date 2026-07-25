/**
 * Deterministic read-only resolver for the current active demonstration
 * subscription.
 *
 * The scheduled intervention scan must never hardcode a subscription ID and
 * must never silently select an arbitrary subscription. This module takes
 * injected read-only subscription effects (the routes supply live Pinch
 * GETs; the validation suite supplies fakes) and applies the trusted
 * server-side fixture criteria: expected merchant scoping, expected payer,
 * expected plan, expected source where the response exposes it, expected
 * recurring amount where exposed, active status, and a valid future
 * schedule. Anything ambiguous or unreadable is a typed development fixture
 * error — it never creates a customer invitation.
 *
 * Pure orchestration over the injected effects: no Pinch import, no clock
 * read, no storage and no mutation of any input.
 */

import { parseCalendarDate } from "./calendar-date";

/** Minimal per-entry read of the payer subscription list. */
export interface SubscriptionListItem {
  id: string;
  status: string;
}

/**
 * The safe subscription-detail fields the resolver may consult. Optional
 * fields are checked only where the live response exposes them.
 */
export interface SubscriptionDetailSnapshot {
  id: string;
  payerId: string;
  planId: string;
  status: string;
  /** Normalised YYYY-MM-DD. */
  startDate: string;
  sourceId?: string;
  recurringAmountCents?: number;
  totalAmountCents?: number;
}

/**
 * Injected read-only effects. Both are strictly GET-shaped: a resolver run
 * must never create, cancel or update anything. Implementations return null
 * when a response cannot be interpreted safely.
 */
export interface SubscriptionReadEffects {
  listPayerSubscriptions(
    merchantId: string,
    payerId: string,
  ): Promise<SubscriptionListItem[] | null>;
  readSubscription(
    merchantId: string,
    subscriptionId: string,
  ): Promise<SubscriptionDetailSnapshot | null>;
}

export interface ResolveActiveSubscriptionRequest {
  merchantId: string;
  payerId: string;
  planId: string;
  sourceId: string;
  expectedRecurringAmountCents: number;
  /** YYYY-MM-DD; a valid future schedule starts strictly after this date. */
  scanDate: string;
}

export type ActiveSubscriptionResolution =
  | { outcome: "resolved"; subscription: SubscriptionDetailSnapshot }
  | {
      outcome: "fixture-error";
      reason:
        | "list-unreadable"
        | "detail-unreadable"
        | "no-qualifying-active-subscription"
        | "ambiguous-active-subscriptions";
      /** Safe identifiers only, so the failure can be inspected. */
      activeSubscriptionIds: string[];
      qualifyingSubscriptionIds: string[];
    };

function fixtureError(
  reason: Extract<
    ActiveSubscriptionResolution,
    { outcome: "fixture-error" }
  >["reason"],
  activeSubscriptionIds: string[] = [],
  qualifyingSubscriptionIds: string[] = [],
): ActiveSubscriptionResolution {
  return {
    outcome: "fixture-error",
    reason,
    activeSubscriptionIds,
    qualifyingSubscriptionIds,
  };
}

/**
 * True only when every checkable identity and schedule criterion matches.
 * Optional fields (source, recurring amount) are enforced where exposed and
 * skipped where the live response omits them — an exposed mismatch always
 * disqualifies.
 */
function isQualifying(
  detail: SubscriptionDetailSnapshot,
  request: ResolveActiveSubscriptionRequest,
): boolean {
  if (detail.payerId !== request.payerId) {
    return false;
  }
  if (detail.planId !== request.planId) {
    return false;
  }
  if (detail.status.toLowerCase() !== "active") {
    return false;
  }
  if (detail.sourceId !== undefined && detail.sourceId !== request.sourceId) {
    return false;
  }
  if (
    detail.recurringAmountCents !== undefined &&
    detail.recurringAmountCents !== request.expectedRecurringAmountCents
  ) {
    return false;
  }
  // A valid future schedule: a real calendar start date strictly after the
  // scan date. Validated YYYY-MM-DD strings compare lexicographically.
  if (
    parseCalendarDate(detail.startDate) === null ||
    detail.startDate <= request.scanDate
  ) {
    return false;
  }
  return true;
}

/**
 * Lists the payer's subscriptions under the managed merchant (the proven
 * merchant-scoped list contract), reads each active subscription's detail,
 * and returns the single qualifying active subscription — or a typed
 * fixture error when none exists, more than one remains equally eligible,
 * or any response cannot be interpreted deterministically.
 */
export async function resolveActiveSubscription(
  request: ResolveActiveSubscriptionRequest,
  effects: SubscriptionReadEffects,
): Promise<ActiveSubscriptionResolution> {
  const list = await effects.listPayerSubscriptions(
    request.merchantId,
    request.payerId,
  );
  if (list === null) {
    return fixtureError("list-unreadable");
  }

  const activeIds = list
    .filter((entry) => entry.status.toLowerCase() === "active")
    .map((entry) => entry.id);
  if (activeIds.length === 0) {
    return fixtureError("no-qualifying-active-subscription");
  }

  const qualifying: SubscriptionDetailSnapshot[] = [];
  for (const subscriptionId of activeIds) {
    const detail = await effects.readSubscription(
      request.merchantId,
      subscriptionId,
    );
    // An unreadable or inconsistent detail leaves eligibility undecidable:
    // fail the whole resolution rather than guessing around it.
    if (detail === null || detail.id !== subscriptionId) {
      return fixtureError("detail-unreadable", activeIds);
    }
    if (isQualifying(detail, request)) {
      qualifying.push(detail);
    }
  }

  if (qualifying.length === 0) {
    return fixtureError("no-qualifying-active-subscription", activeIds);
  }
  if (qualifying.length > 1) {
    return fixtureError(
      "ambiguous-active-subscriptions",
      activeIds,
      qualifying.map((entry) => entry.id),
    );
  }
  return { outcome: "resolved", subscription: qualifying[0] };
}
