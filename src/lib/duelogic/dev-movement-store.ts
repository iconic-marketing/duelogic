/**
 * Development-only stores for the customer movement-choice journey:
 *
 * 1. Movement choices — the server-side record of which movement kind the
 *    customer selected for an intervention. The browser is never
 *    authoritative: routes read this record to dispatch date evaluation,
 *    OTP issuance and final confirmation, and request data can never
 *    override it.
 *
 * 2. Fixture payments — deterministic process-local stand-ins for the
 *    payer's upcoming scheduled Pinch payment. Live Pinch payment
 *    DISCOVERY for the temporary journey is a later controlled stage; in
 *    this stage every temporary read AND the temporary mutation effect
 *    operate on this fixture store only, so no live Pinch payment can be
 *    touched by construction.
 *
 * NON-DURABLE SANDBOX STORAGE: records live in process memory, backed by
 * `globalThis` (hot reloads keep them, restarts do not).
 */

import type { MovementKind } from "./movement-availability";
import { MOVEMENT_KINDS } from "./movement-availability";
import type {
  AuthoritativePaymentSnapshot,
  PaymentDateUpdateBody,
} from "@/lib/pinch/payment-movement";

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts.
if (typeof window !== "undefined") {
  throw new Error(
    "The dev movement store is server-only and must not be imported into browser code.",
  );
}

export interface MovementChoiceRecord {
  readonly interventionId: string;
  readonly kind: MovementKind;
  readonly chosenAt: string;
}

export interface MovementChoiceRepository {
  /** Upsert: choosing again replaces the previous choice. */
  setChoice(record: MovementChoiceRecord): Promise<void>;
  readChoice(interventionId: string): Promise<MovementChoiceRecord | null>;
}

type ChoiceMap = Map<string, MovementChoiceRecord>;

export function createInMemoryMovementChoiceRepository(
  choices: ChoiceMap = new Map(),
): MovementChoiceRepository {
  return {
    async setChoice(record: MovementChoiceRecord): Promise<void> {
      if (
        typeof record.interventionId !== "string" ||
        record.interventionId.trim() === "" ||
        !MOVEMENT_KINDS.includes(record.kind) ||
        Number.isNaN(Date.parse(record.chosenAt))
      ) {
        throw new Error(
          "Movement choice store refused a structurally invalid record.",
        );
      }
      choices.set(record.interventionId, structuredClone(record));
      const readBack = choices.get(record.interventionId);
      if (
        readBack === undefined ||
        JSON.stringify(readBack) !== JSON.stringify(record)
      ) {
        throw new Error(
          "Movement choice store could not read the choice back after writing.",
        );
      }
    },
    async readChoice(
      interventionId: string,
    ): Promise<MovementChoiceRecord | null> {
      const record = choices.get(interventionId.trim());
      return record === undefined ? null : structuredClone(record);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture payments

/** One fixture upcoming payment, keyed by payer. */
export interface FixturePaymentRepository {
  /** The payer's upcoming scheduled payment, or null. */
  readUpcomingForPayer(
    payerId: string,
  ): Promise<AuthoritativePaymentSnapshot | null>;
  readById(paymentId: string): Promise<AuthoritativePaymentSnapshot | null>;
  /** Seeds or replaces the payer's fixture payment. */
  upsert(
    payerId: string,
    payment: AuthoritativePaymentSnapshot,
  ): Promise<void>;
  /**
   * The fixture-side mutation adapter: applies the update body to the
   * fixture payment (never Pinch) and resolves "ok"; a missing payment
   * resolves "rejected". Used as the temporary journey's updatePaymentDate
   * effect in this stage.
   */
  applyDateUpdate(body: PaymentDateUpdateBody): Promise<"ok" | "rejected">;
}

interface FixturePaymentEntry {
  payerId: string;
  payment: AuthoritativePaymentSnapshot;
}

type FixturePaymentMap = Map<string, FixturePaymentEntry>;

export function createInMemoryFixturePaymentRepository(
  payments: FixturePaymentMap = new Map(),
): FixturePaymentRepository {
  return {
    async readUpcomingForPayer(
      payerId: string,
    ): Promise<AuthoritativePaymentSnapshot | null> {
      for (const entry of payments.values()) {
        if (entry.payerId === payerId.trim()) {
          return structuredClone(entry.payment);
        }
      }
      return null;
    },
    async readById(
      paymentId: string,
    ): Promise<AuthoritativePaymentSnapshot | null> {
      const entry = payments.get(paymentId.trim());
      return entry === undefined ? null : structuredClone(entry.payment);
    },
    async upsert(
      payerId: string,
      payment: AuthoritativePaymentSnapshot,
    ): Promise<void> {
      if (
        typeof payerId !== "string" ||
        payerId.trim() === "" ||
        typeof payment.id !== "string" ||
        payment.id.trim() === "" ||
        !Number.isInteger(payment.amountInCents) ||
        payment.amountInCents <= 0
      ) {
        throw new Error(
          "Fixture payment store refused a structurally invalid payment.",
        );
      }
      // One fixture payment per payer: drop any previous entry first.
      for (const [key, entry] of payments.entries()) {
        if (entry.payerId === payerId) {
          payments.delete(key);
        }
      }
      payments.set(payment.id, {
        payerId,
        payment: structuredClone(payment),
      });
    },
    async applyDateUpdate(
      body: PaymentDateUpdateBody,
    ): Promise<"ok" | "rejected"> {
      const entry = payments.get(body.id.trim());
      if (entry === undefined) {
        return "rejected";
      }
      entry.payment = {
        ...structuredClone(entry.payment),
        transactionDate: body.transactionDate,
      };
      return "ok";
    },
  };
}

// ---------------------------------------------------------------------------
// Shared development repositories (globalThis-backed, per process)

interface GlobalWithMovementStores {
  __duelogicDevMovementChoiceStore?: ChoiceMap;
  __duelogicDevFixturePaymentStore?: FixturePaymentMap;
}

export function getDevMovementChoiceRepository(): MovementChoiceRepository {
  const holder = globalThis as GlobalWithMovementStores;
  holder.__duelogicDevMovementChoiceStore ??= new Map();
  return createInMemoryMovementChoiceRepository(
    holder.__duelogicDevMovementChoiceStore,
  );
}

export function getDevFixturePaymentRepository(): FixturePaymentRepository {
  const holder = globalThis as GlobalWithMovementStores;
  holder.__duelogicDevFixturePaymentStore ??= new Map();
  return createInMemoryFixturePaymentRepository(
    holder.__duelogicDevFixturePaymentStore,
  );
}

/**
 * Development-store-only targeted deletion for demo preparation: removes
 * the movement choices belonging to exactly the named interventions.
 * Returns the number removed; missing IDs are ignored. Defaults to the
 * shared development map; validation passes its own isolated map.
 */
export function deleteMovementChoicesForInterventions(
  interventionIds: readonly string[],
  choices?: ChoiceMap,
): number {
  const holder = globalThis as GlobalWithMovementStores;
  const target =
    choices ?? (holder.__duelogicDevMovementChoiceStore ??= new Map());
  let deleted = 0;
  for (const id of interventionIds) {
    if (target.delete(id)) {
      deleted += 1;
    }
  }
  return deleted;
}

/** Targeted deletion of exactly the named fixture payments (by payment ID). */
export function deleteFixturePaymentsById(
  paymentIds: readonly string[],
  payments?: FixturePaymentMap,
): number {
  const holder = globalThis as GlobalWithMovementStores;
  const target =
    payments ?? (holder.__duelogicDevFixturePaymentStore ??= new Map());
  let deleted = 0;
  for (const id of paymentIds) {
    if (target.delete(id)) {
      deleted += 1;
    }
  }
  return deleted;
}
