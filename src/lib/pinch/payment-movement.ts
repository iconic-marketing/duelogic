/**
 * Reusable, effects-injected temporary payment-movement service: the
 * proven Pinch payment-date mutation contract from the development route
 * (src/app/api/pinch/dev/payment-date/route.ts), expressed as pure
 * orchestration so the protected customer execution path can run it
 * without HTTP and the deterministic validation can drive it with fakes.
 *
 * Proven contract preserved exactly:
 * 1. GET the authoritative payment first.
 * 2. Require live status exactly "scheduled".
 * 3. Require the expected payment ID, current transaction date and
 *    integer-cent amount to match — a refusal here issues NO mutation.
 * 4. POST /payments once with the update body built from the pre-read
 *    (id, payerId, amount, new transactionDate, existing description) —
 *    caller-supplied fields are never forwarded.
 * 5. The mutation is invoked at most once and NEVER retried, even when
 *    its outcome is unreadable.
 * 6. GET the payment again: the read-back is the source of truth.
 * 7. Verified only when the read-back proves the unchanged payment ID,
 *    the exact confirmed transactionDate, status still scheduled, and
 *    the unchanged amount and payer.
 *
 * Ambiguity handling: an unreadable mutation outcome is resolved by the
 * read-back alone — proof of the confirmed date verifies, proof that the
 * original date persists after a DEFINITE upstream rejection is a known
 * unchanged failure, and anything else stays ambiguous for merchant
 * review. No branch ever repeats the POST.
 *
 * This module never imports the Pinch client: the route/service layer
 * injects effects (live pinchRequest adapters later; fakes in
 * validation). No live invocation happens in the current stage.
 */

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts.
if (typeof window !== "undefined") {
  throw new Error(
    "The payment-movement service is server-only and must not be imported into browser code.",
  );
}

/** The safe authoritative payment fields this service consumes. */
export interface AuthoritativePaymentSnapshot {
  id: string;
  payerId: string;
  /** Integer cents — Pinch's payment `amount` passes through unconverted. */
  amountInCents: number;
  /** Normalised YYYY-MM-DD in the merchant context. */
  transactionDate: string;
  status: string;
  description?: string;
}

/** The exact POST /payments update body, built only from the pre-read. */
export interface PaymentDateUpdateBody {
  id: string;
  payerId: string;
  amountInCents: number;
  transactionDate: string;
  description?: string;
}

/**
 * Injected effects. `updatePaymentDate` must resolve "ok" on definite
 * upstream success, resolve "rejected" on a definite upstream refusal,
 * and THROW only when the outcome is unknown (network failure, timeout,
 * unreadable response). It is called at most once per request.
 */
export interface PaymentMovementEffects {
  readPayment(): Promise<AuthoritativePaymentSnapshot | null>;
  updatePaymentDate(body: PaymentDateUpdateBody): Promise<"ok" | "rejected">;
}

export interface VerifiedPaymentMovementRequest {
  paymentId: string;
  /** The bound original date the live payment must still show pre-mutation. */
  expectedTransactionDate: string;
  /** The bound integer-cent amount the live payment must still show. */
  expectedAmountInCents: number;
  /** The customer-confirmed new date. */
  confirmedTransactionDate: string;
}

export type PaymentMovementResult =
  | { outcome: "verified"; verifiedTransactionDate: string }
  | {
      /** Refused before any mutation: the payment is untouched. */
      outcome: "refused";
      stage:
        | "payment-unreadable"
        | "payment-not-scheduled"
        | "payment-identity-mismatch"
        | "payment-date-mismatch"
        | "payment-amount-mismatch";
    }
  | {
      /**
       * The mutation was invoked, definitely rejected upstream, and the
       * read-back proves the original date persists: a known unchanged
       * failure for merchant review — never retried.
       */
      outcome: "mutation-rejected";
    }
  | {
      /** The outcome could not be proven either way. Never retried. */
      outcome: "ambiguous";
      stage: "read-back-unreadable" | "read-back-mismatch" | "mutation-unconfirmed";
    };

export async function executeVerifiedPaymentDateMovement(
  request: VerifiedPaymentMovementRequest,
  effects: PaymentMovementEffects,
): Promise<PaymentMovementResult> {
  // 1-3. Authoritative pre-read and exact binding checks — no mutation on
  // any deviation.
  let before: AuthoritativePaymentSnapshot | null;
  try {
    before = await effects.readPayment();
  } catch {
    before = null;
  }
  if (before === null) {
    return { outcome: "refused", stage: "payment-unreadable" };
  }
  if (before.id !== request.paymentId) {
    return { outcome: "refused", stage: "payment-identity-mismatch" };
  }
  if (before.status.toLowerCase() !== "scheduled") {
    return { outcome: "refused", stage: "payment-not-scheduled" };
  }
  if (before.transactionDate !== request.expectedTransactionDate) {
    return { outcome: "refused", stage: "payment-date-mismatch" };
  }
  if (before.amountInCents !== request.expectedAmountInCents) {
    return { outcome: "refused", stage: "payment-amount-mismatch" };
  }

  // 4-5. One mutation, built strictly from the pre-read. "unknown" means
  // the POST threw: a mutation may or may not have been applied.
  const updateBody: PaymentDateUpdateBody = {
    id: before.id,
    payerId: before.payerId,
    amountInCents: before.amountInCents,
    transactionDate: request.confirmedTransactionDate,
    ...(before.description !== undefined
      ? { description: before.description }
      : {}),
  };
  let mutationOutcome: "ok" | "rejected" | "unknown";
  try {
    mutationOutcome = await effects.updatePaymentDate(updateBody);
  } catch {
    mutationOutcome = "unknown";
  }

  // 6-7. Read-back is the source of truth; it alone resolves ambiguity.
  let after: AuthoritativePaymentSnapshot | null;
  try {
    after = await effects.readPayment();
  } catch {
    after = null;
  }
  if (after === null) {
    return { outcome: "ambiguous", stage: "read-back-unreadable" };
  }

  const identityAndAmountIntact =
    after.id === request.paymentId &&
    after.payerId === before.payerId &&
    after.amountInCents === request.expectedAmountInCents;

  if (
    identityAndAmountIntact &&
    after.transactionDate === request.confirmedTransactionDate &&
    after.status.toLowerCase() === "scheduled"
  ) {
    return {
      outcome: "verified",
      verifiedTransactionDate: after.transactionDate,
    };
  }

  if (
    mutationOutcome === "rejected" &&
    identityAndAmountIntact &&
    after.transactionDate === request.expectedTransactionDate
  ) {
    return { outcome: "mutation-rejected" };
  }

  return {
    outcome: "ambiguous",
    stage:
      mutationOutcome === "unknown" &&
      identityAndAmountIntact &&
      after.transactionDate === request.expectedTransactionDate
        ? // The POST outcome is unknown and the original date still shows;
          // a delayed apply cannot be ruled out, so this stays ambiguous.
          "mutation-unconfirmed"
        : "read-back-mismatch",
  };
}
