/**
 * Development-only, in-process store of *safe* Pinch webhook event summaries,
 * keyed by payment ID. Holds only { paymentId, eventId, type, eventDate,
 * receivedAt } — never bodies, signatures, headers, amounts, payer or source
 * data. Backed by `globalThis` so `next dev` hot reloads keep the events, but
 * it does NOT survive a process restart. Recording is a no-op outside
 * development.
 */

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts: the
// `server-only` package is not installed in this project, so fail at import
// time if this module ever reaches browser code.
if (typeof window !== "undefined") {
  throw new Error(
    "The dev outcome store is server-only and must not be imported into browser code.",
  );
}

export const OUTCOME_EVENT_TYPES = ["scheduled-process", "bank-results"] as const;

export type OutcomeEventType = (typeof OUTCOME_EVENT_TYPES)[number];

export function isOutcomeEventType(value: string): value is OutcomeEventType {
  return (OUTCOME_EVENT_TYPES as readonly string[]).includes(value);
}

export interface StoredOutcomeEvent {
  paymentId: string;
  eventId: string;
  type: OutcomeEventType;
  /** Event timestamp from the verified envelope, when it carried one. */
  eventDate?: string;
  /** ISO timestamp of when this summary was recorded locally. */
  receivedAt: string;
}

/**
 * Narrow input: callers pass exactly these fields, never a webhook object.
 */
export interface OutcomeEventSummaryInput {
  eventId: string;
  type: OutcomeEventType;
  eventDate?: string;
}

const MAX_EVENTS_PER_PAYMENT = 10;

type OutcomeStore = Map<string, StoredOutcomeEvent[]>;

interface GlobalWithOutcomeStore {
  __duelogicDevPinchOutcomeStore?: OutcomeStore;
}

function getStore(): OutcomeStore {
  const holder = globalThis as GlobalWithOutcomeStore;
  holder.__duelogicDevPinchOutcomeStore ??= new Map();
  return holder.__duelogicDevPinchOutcomeStore;
}

/** eventDate ascending (absent dates first), then eventId, for stable order. */
function compareEvents(a: StoredOutcomeEvent, b: StoredOutcomeEvent): number {
  const dateA = a.eventDate ?? "";
  const dateB = b.eventDate ?? "";
  if (dateA !== dateB) {
    return dateA < dateB ? -1 : 1;
  }
  if (a.eventId !== b.eventId) {
    return a.eventId < b.eventId ? -1 : 1;
  }
  return 0;
}

/**
 * Records one verified event summary against each referenced payment ID.
 * Callers must only invoke this after webhook signature verification.
 * Duplicate event IDs for a payment are ignored; at most the newest
 * MAX_EVENTS_PER_PAYMENT events are kept per payment.
 */
export function recordOutcomeEvent(
  summary: OutcomeEventSummaryInput,
  paymentIds: readonly string[],
): void {
  if (process.env.NODE_ENV !== "development") {
    return;
  }
  const eventId = summary.eventId.trim();
  if (eventId === "" || !isOutcomeEventType(summary.type)) {
    return;
  }
  const eventDate =
    typeof summary.eventDate === "string" && summary.eventDate.trim() !== ""
      ? summary.eventDate.trim()
      : undefined;
  const receivedAt = new Date().toISOString();
  const store = getStore();

  for (const rawPaymentId of paymentIds) {
    if (typeof rawPaymentId !== "string") {
      continue;
    }
    const paymentId = rawPaymentId.trim();
    if (!paymentId.startsWith("pmt_")) {
      continue;
    }
    const existing = store.get(paymentId) ?? [];
    if (existing.some((event) => event.eventId === eventId)) {
      continue;
    }
    // Built field-by-field: nothing beyond the whitelisted summary is stored.
    const stored: StoredOutcomeEvent = {
      paymentId,
      eventId,
      type: summary.type,
      receivedAt,
    };
    if (eventDate !== undefined) {
      stored.eventDate = eventDate;
    }
    const next = [...existing, stored].sort(compareEvents);
    store.set(paymentId, next.slice(-MAX_EVENTS_PER_PAYMENT));
  }
}

/** Returns copies of the stored summaries for one payment, oldest first. */
export function readOutcomeEvents(paymentId: string): StoredOutcomeEvent[] {
  const events = getStore().get(paymentId.trim());
  return events === undefined ? [] : events.map((event) => ({ ...event }));
}

/** Demo reset helper: drops every stored event for every payment. */
export function clearOutcomeStore(): void {
  getStore().clear();
}
