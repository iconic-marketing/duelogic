/**
 * Deterministic validation of the customer schedule-confirmation flow,
 * following the repository's validation convention: the exported async
 * function re-asserts the full scenario table on demand, and one pass is
 * kicked off at module load with loud failure logging.
 *
 * Nothing here calls Pinch or reads a clock: repository, clock, token
 * generator, token hasher and every replacement effect are injected fakes
 * over synthetic identifiers. No live merchant, payer, subscription, plan
 * or source IDs appear in the fixtures, and no real token is ever created.
 *
 * The suite also proves the enforcement ordering the routes rely on:
 * the pure confirmation gate decides before the flow (and therefore before
 * any Pinch effect) can run; consumption precedes recovery-record
 * persistence; persistence precedes cancellation; cancellation precedes
 * replacement creation; and every confirmation refusal invokes nothing.
 * (The route performs its read-only Pinch preflight before invoking the
 * flow, so the flow-level proof that consumption is the first action also
 * places consumption after preflight.)
 */

import {
  effectiveConfirmationStatus,
  findForbiddenConfirmationRecordKey,
  toCustomerConfirmationProjection,
  toMerchantConfirmationProjection,
  type ConfirmedSchedulePayment,
  type CustomerConfirmationRepository,
  type CustomerScheduleConfirmationRecord,
} from "./customer-confirmation";
import {
  consumeAcceptedCustomerConfirmation,
  createCustomerConfirmation,
  evaluateConfirmationForReplacement,
  respondToCustomerConfirmation,
  type CreateCustomerConfirmationInput,
  type CustomerConfirmationServiceDeps,
  type ReplacementConfirmationExpectation,
} from "./customer-confirmation-service";
import { createInMemoryCustomerConfirmationRepository } from "./dev-customer-confirmation-store";
import { createInMemoryReplacementOperationRepository } from "./dev-replacement-operation-store";
import {
  toSafeReplacementOperationProjection,
  type SubscriptionReplacementOperationRepository,
  type SubscriptionReplacementRecoverySnapshot,
} from "./replacement-operation";
import {
  executeSubscriptionReplacement,
  type ReplacementExecutionEffects,
  type ReplacementExecutionOutcome,
  type ReplacementExecutionRequest,
} from "./replacement-operation-flow";

export interface CustomerConfirmationValidationRow {
  scenario: string;
  outcome: string;
}

export interface CustomerConfirmationValidationResult {
  scenarioCount: number;
  decisionTable: CustomerConfirmationValidationRow[];
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Customer-confirmation validation failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Injected deterministic dependencies

/** Strictly increasing synthetic clock; advanceMinutes models waiting. */
function makeClock(startIso = "2026-01-01T00:00:00.000Z") {
  let currentMs = Date.parse(startIso);
  return {
    now: (): string => {
      currentMs += 1_000;
      return new Date(currentMs).toISOString();
    },
    advanceMinutes: (minutes: number): void => {
      currentMs += minutes * 60_000;
    },
  };
}

/**
 * Deterministic token deps. The fake hash reverses the raw token so the
 * stored hash never contains the raw token as a substring — letting
 * scenarios assert the raw token appears nowhere in stored state.
 */
function makeTokenDeps() {
  let idCounter = 0;
  let tokenCounter = 0;
  return {
    generateConfirmationId: (): string => {
      idCounter += 1;
      return `conf_demo_${String(idCounter).padStart(2, "0")}`;
    },
    generateToken: (): string => {
      tokenCounter += 1;
      return `raw-demo-token-${String(tokenCounter).padStart(2, "0")}`;
    },
    hashToken: (raw: string): string =>
      `fakehash:${raw.split("").reverse().join("")}`,
  };
}

function makeDeps(
  repository: CustomerConfirmationRepository,
  clock: ReturnType<typeof makeClock>,
): CustomerConfirmationServiceDeps {
  const tokenDeps = makeTokenDeps();
  return {
    repository,
    now: clock.now,
    ...tokenDeps,
    lifetimeMinutes: 30,
  };
}

// ---------------------------------------------------------------------------
// Synthetic fixtures — no live IDs

const CURRENT_PAYMENTS: ConfirmedSchedulePayment[] = [
  { paymentDate: "2026-01-07", amountInCents: 12500 },
  { paymentDate: "2026-01-14", amountInCents: 12500 },
  { paymentDate: "2026-01-21", amountInCents: 12500 },
];

const PROPOSED_PAYMENTS: ConfirmedSchedulePayment[] = [
  { paymentDate: "2026-01-09", amountInCents: 12500 },
  { paymentDate: "2026-01-16", amountInCents: 12500 },
  { paymentDate: "2026-01-23", amountInCents: 12500 },
];

function demoCreateInput(): CreateCustomerConfirmationInput {
  return {
    merchantId: "mch_demo",
    payerId: "pyr_demo",
    sourceId: "src_demo",
    subscriptionId: "sub_demo_original",
    planId: "pln_demo",
    currentStartDate: "2026-01-07",
    proposedStartDate: "2026-01-09",
    currentPayments: CURRENT_PAYMENTS.map((payment) => ({ ...payment })),
    proposedPayments: PROPOSED_PAYMENTS.map((payment) => ({ ...payment })),
    currency: "AUD",
  };
}

function demoExpectation(): ReplacementConfirmationExpectation {
  return {
    merchantId: "mch_demo",
    payerId: "pyr_demo",
    sourceId: "src_demo",
    subscriptionId: "sub_demo_original",
    proposedStartDate: "2026-01-09",
    planId: "pln_demo",
    confirmedPayments: PROPOSED_PAYMENTS.map((payment) => ({ ...payment })),
  };
}

function demoSnapshot(): SubscriptionReplacementRecoverySnapshot {
  return {
    merchantId: "mch_demo",
    payerId: "pyr_demo",
    sourceId: "src_demo",
    planId: "pln_demo",
    originalStartDate: "2026-01-07",
    oldSubscriptionId: "sub_demo_original",
    reinstatementCreateBody: {
      planId: "pln_demo",
      payerId: "pyr_demo",
      sourceId: "src_demo",
      startDate: "2026-01-07",
    },
    originalCalculatedPayments: [
      { transactionDate: "2026-01-07", amountCents: 12500 },
      { transactionDate: "2026-01-14", amountCents: 12500 },
      { transactionDate: "2026-01-21", amountCents: 12500 },
    ],
  };
}

function demoFlowRequest(confirmationId: string): ReplacementExecutionRequest {
  return {
    operationId: "op-demo-01",
    confirmationId,
    merchantId: "mch_demo",
    payerId: "pyr_demo",
    planId: "pln_demo",
    sourceId: "src_demo",
    oldSubscriptionId: "sub_demo_original",
    previousStartDate: "2026-01-07",
    requestedStartDate: "2026-01-09",
    previousTotalAmountCents: null,
    requestedTotalAmountCents: null,
    recoverySnapshot: demoSnapshot(),
  };
}

const silentLog = (): void => {
  // Failure paths are intentionally exercised; safe logging is not part of
  // the asserted contract.
};

// ---------------------------------------------------------------------------
// Harness pieces

/** Wraps a confirmation repository, logging events for ordering proofs. */
function instrumentedConfirmationRepository(
  events: string[],
): CustomerConfirmationRepository {
  const inner = createInMemoryCustomerConfirmationRepository();
  return {
    async write(record) {
      events.push("confirmation.write");
      await inner.write(record);
    },
    async readById(confirmationId) {
      events.push("confirmation.readById");
      return inner.readById(confirmationId);
    },
    async readByTokenHash(tokenHash) {
      events.push("confirmation.readByTokenHash");
      return inner.readByTokenHash(tokenHash);
    },
  };
}

function instrumentedOperationRepository(
  events: string[],
): SubscriptionReplacementOperationRepository {
  const inner = createInMemoryReplacementOperationRepository();
  return {
    async write(record) {
      events.push("operation.write");
      await inner.write(record);
    },
    async read(operationId) {
      events.push("operation.read");
      return inner.read(operationId);
    },
  };
}

interface FlowHarness {
  events: string[];
  confirmationRepository: CustomerConfirmationRepository;
  operationRepository: SubscriptionReplacementOperationRepository;
  effectCalls: { consume: number; cancel: number; create: number };
  runFlow(confirmationId: string): Promise<ReplacementExecutionOutcome>;
}

/**
 * A flow harness with service-backed consumption over the instrumented
 * confirmation repository and happy-path fake Pinch effects.
 */
function makeFlowHarness(clock: ReturnType<typeof makeClock>): FlowHarness {
  const events: string[] = [];
  const confirmationRepository = instrumentedConfirmationRepository(events);
  const operationRepository = instrumentedOperationRepository(events);
  const effectCalls = { consume: 0, cancel: 0, create: 0 };
  const runFlow = async (
    confirmationId: string,
  ): Promise<ReplacementExecutionOutcome> => {
    const effects: ReplacementExecutionEffects = {
      async consumeCustomerConfirmation() {
        effectCalls.consume += 1;
        return consumeAcceptedCustomerConfirmation(
          { confirmationId, operationId: "op-demo-01" },
          { repository: confirmationRepository, now: clock.now },
        );
      },
      async cancelOriginal() {
        effectCalls.cancel += 1;
        events.push("pinch.cancel");
      },
      async readOriginalStatus() {
        return { id: "sub_demo_original", status: "cancelled" };
      },
      async createReplacement() {
        effectCalls.create += 1;
        events.push("pinch.create");
        return { id: "sub_demo_replacement" };
      },
      async verifyReplacement(newSubscriptionId) {
        return {
          oldSubscriptionId: "sub_demo_original",
          newSubscriptionId,
          verifiedStartDate: "2026-01-09",
          planId: "pln_demo",
          payerId: "pyr_demo",
          sourceId: "src_demo",
          paymentDates: PROPOSED_PAYMENTS.map((payment) => payment.paymentDate),
          paymentAmountsCents: PROPOSED_PAYMENTS.map(
            (payment) => payment.amountInCents,
          ),
        };
      },
    };
    return executeSubscriptionReplacement(
      demoFlowRequest(confirmationId),
      operationRepository,
      effects,
      clock.now,
      silentLog,
    );
  };
  return {
    events,
    confirmationRepository,
    operationRepository,
    effectCalls,
    runFlow,
  };
}

/**
 * Models the route's enforcement order exactly: the pure confirmation gate
 * decides first; only an accepted, matching confirmation lets the flow (and
 * therefore any Pinch effect) run. Used to prove that every refusal invokes
 * nothing.
 */
async function gateThenRunFlow(
  harness: FlowHarness,
  record: CustomerScheduleConfirmationRecord | null,
  expectation: ReplacementConfirmationExpectation,
  nowIso: string,
): Promise<ReturnType<typeof evaluateConfirmationForReplacement>> {
  const evaluation = evaluateConfirmationForReplacement(
    record,
    expectation,
    nowIso,
  );
  if (evaluation.ok) {
    await harness.runFlow(record === null ? "" : record.confirmationId);
  }
  return evaluation;
}

interface AcceptedFixture {
  record: CustomerScheduleConfirmationRecord;
  rawToken: string;
  deps: CustomerConfirmationServiceDeps;
}

/** Creates a confirmation on the supplied repository and accepts it. */
async function createAccepted(
  repository: CustomerConfirmationRepository,
  clock: ReturnType<typeof makeClock>,
): Promise<AcceptedFixture> {
  const deps = makeDeps(repository, clock);
  const created = await createCustomerConfirmation(demoCreateInput(), deps);
  check(created.ok, "fixture: confirmation creation must succeed");
  if (!created.ok) {
    throw new Error("unreachable");
  }
  const accepted = await respondToCustomerConfirmation(
    { token: created.rawToken, response: "accept" },
    deps,
  );
  check(
    accepted.ok && accepted.changed,
    "fixture: pending confirmation must accept",
  );
  if (!accepted.ok) {
    throw new Error("unreachable");
  }
  return { record: accepted.record, rawToken: created.rawToken, deps };
}

// ---------------------------------------------------------------------------
// Scenario table

export async function validateCustomerConfirmationFlow(): Promise<CustomerConfirmationValidationResult> {
  const table: CustomerConfirmationValidationRow[] = [];
  const record = (scenario: string, outcome: string): void => {
    table.push({ scenario, outcome });
  };

  // s01: creation stores only the token hash — the raw token appears
  // nowhere in the stored record.
  {
    const clock = makeClock();
    const repository = createInMemoryCustomerConfirmationRepository();
    const deps = makeDeps(repository, clock);
    const created = await createCustomerConfirmation(demoCreateInput(), deps);
    check(created.ok, "s01: creation must succeed");
    if (created.ok) {
      const stored = await repository.readById(created.record.confirmationId);
      check(stored !== null, "s01: the record must be readable");
      if (stored !== null) {
        check(
          stored.tokenHash === deps.hashToken(created.rawToken),
          "s01: the stored tokenHash must be the injected hasher's output",
        );
        check(
          !JSON.stringify(stored).includes(created.rawToken),
          "s01: the raw token must appear nowhere in the stored record",
        );
      }
    }
    record("s01-creation-stores-only-token-hash", "hash-only");
  }

  // s02: the raw token is returned exactly once, at creation; no later
  // lookup or projection can recover it.
  {
    const clock = makeClock();
    const repository = createInMemoryCustomerConfirmationRepository();
    const deps = makeDeps(repository, clock);
    const created = await createCustomerConfirmation(demoCreateInput(), deps);
    check(
      created.ok && created.rawToken.startsWith("raw-demo-token-"),
      "s02: creation must return the raw token once",
    );
    if (created.ok) {
      const stored = await repository.readById(created.record.confirmationId);
      const merchantView = toMerchantConfirmationProjection(
        created.record,
        clock.now(),
      );
      const customerView = toCustomerConfirmationProjection(
        created.record,
        clock.now(),
      );
      check(
        stored !== null &&
          !JSON.stringify(stored).includes(created.rawToken) &&
          !JSON.stringify(merchantView).includes(created.rawToken) &&
          !JSON.stringify(customerView).includes(created.rawToken),
        "s02: no stored state or projection may carry the raw token",
      );
    }
    record("s02-raw-token-returned-once", "single-exposure");
  }

  // s03: the merchant status projection exposes exactly the documented safe
  // fields — never tokenHash or the raw token.
  {
    const clock = makeClock();
    const repository = createInMemoryCustomerConfirmationRepository();
    const { record: accepted, rawToken } = await createAccepted(
      repository,
      clock,
    );
    const projection = toMerchantConfirmationProjection(accepted, clock.now());
    const expectedKeys = [
      "confirmationId",
      "status",
      "currentStartDate",
      "proposedStartDate",
      "proposedPayments",
      "createdAt",
      "expiresAt",
      "acceptedAt",
      "declinedAt",
      "consumedAt",
      "operationId",
    ];
    check(
      JSON.stringify(Object.keys(projection).sort()) ===
        JSON.stringify([...expectedKeys].sort()),
      "s03: the merchant projection must expose exactly the documented safe fields",
    );
    const serialised = JSON.stringify(projection);
    check(
      !serialised.includes(rawToken) &&
        !serialised.includes(accepted.tokenHash),
      "s03: the merchant projection must expose neither the raw token nor the token hash",
    );
    record("s03-merchant-projection-no-token-material", "safe");
  }

  // s04: the customer projection excludes merchant and Pinch identifiers
  // and the operation ID.
  {
    const clock = makeClock();
    const repository = createInMemoryCustomerConfirmationRepository();
    const { record: accepted } = await createAccepted(repository, clock);
    const projection = toCustomerConfirmationProjection(accepted, clock.now());
    const expectedKeys = [
      "status",
      "currentStartDate",
      "proposedStartDate",
      "currentPayments",
      "proposedPayments",
      "currency",
      "expiresAt",
    ];
    check(
      JSON.stringify(Object.keys(projection).sort()) ===
        JSON.stringify([...expectedKeys].sort()),
      "s04: the customer projection must expose exactly the schedule and lifecycle fields",
    );
    const serialised = JSON.stringify(projection);
    check(
      ["mch_", "pyr_", "src_", "sub_", "pln_", "conf_", "op-demo"].every(
        (marker) => !serialised.includes(marker),
      ),
      "s04: the customer projection must contain no merchant, Pinch, confirmation or operation identifier",
    );
    record("s04-customer-projection-no-ids", "safe");
  }

  // s05: a pending confirmation can be accepted.
  {
    const clock = makeClock();
    const repository = createInMemoryCustomerConfirmationRepository();
    const { record: accepted } = await createAccepted(repository, clock);
    check(
      accepted.status === "accepted" &&
        accepted.acceptedAt !== null &&
        effectiveConfirmationStatus(accepted, clock.now()) === "accepted",
      "s05: acceptance must record acceptedAt and report accepted",
    );
    record("s05-pending-accepts", "accepted");
  }

  // s06: a pending confirmation can be declined.
  {
    const clock = makeClock();
    const repository = createInMemoryCustomerConfirmationRepository();
    const deps = makeDeps(repository, clock);
    const created = await createCustomerConfirmation(demoCreateInput(), deps);
    check(created.ok, "s06: creation must succeed");
    if (created.ok) {
      const declined = await respondToCustomerConfirmation(
        { token: created.rawToken, response: "decline" },
        deps,
      );
      check(
        declined.ok &&
          declined.changed &&
          declined.record.status === "declined" &&
          declined.record.declinedAt !== null,
        "s06: decline must record declinedAt and report declined",
      );
    }
    record("s06-pending-declines", "declined");
  }

  // s07: an accepted confirmation cannot be declined (contradictory).
  {
    const clock = makeClock();
    const repository = createInMemoryCustomerConfirmationRepository();
    const { rawToken, deps, record: accepted } = await createAccepted(
      repository,
      clock,
    );
    const contradiction = await respondToCustomerConfirmation(
      { token: rawToken, response: "decline" },
      deps,
    );
    check(
      !contradiction.ok && contradiction.reason === "contradictory",
      "s07: declining an accepted confirmation must be rejected",
    );
    const stored = await repository.readById(accepted.confirmationId);
    check(
      stored !== null && stored.status === "accepted" && stored.declinedAt === null,
      "s07: the rejected contradiction must not change the record",
    );
    record("s07-accepted-cannot-decline", "rejected");
  }

  // s08: a declined confirmation cannot be accepted.
  {
    const clock = makeClock();
    const repository = createInMemoryCustomerConfirmationRepository();
    const deps = makeDeps(repository, clock);
    const created = await createCustomerConfirmation(demoCreateInput(), deps);
    check(created.ok, "s08: creation must succeed");
    if (created.ok) {
      const declined = await respondToCustomerConfirmation(
        { token: created.rawToken, response: "decline" },
        deps,
      );
      check(declined.ok, "s08: decline must succeed first");
      const contradiction = await respondToCustomerConfirmation(
        { token: created.rawToken, response: "accept" },
        deps,
      );
      check(
        !contradiction.ok && contradiction.reason === "contradictory",
        "s08: accepting a declined confirmation must be rejected",
      );
      const stored = await repository.readById(created.record.confirmationId);
      check(
        stored !== null &&
          stored.status === "declined" &&
          stored.acceptedAt === null,
        "s08: the rejected contradiction must not change the record",
      );
    }
    record("s08-declined-cannot-accept", "rejected");
  }

  // s09: an expired confirmation cannot be accepted; expiry is evaluated
  // server-side from the injected clock.
  {
    const clock = makeClock();
    const repository = createInMemoryCustomerConfirmationRepository();
    const deps = makeDeps(repository, clock);
    const created = await createCustomerConfirmation(demoCreateInput(), deps);
    check(created.ok, "s09: creation must succeed");
    if (created.ok) {
      clock.advanceMinutes(31);
      const late = await respondToCustomerConfirmation(
        { token: created.rawToken, response: "accept" },
        deps,
      );
      check(
        !late.ok && late.reason === "expired",
        "s09: accepting an expired confirmation must be rejected as expired",
      );
      const stored = await repository.readById(created.record.confirmationId);
      check(
        stored !== null &&
          stored.status === "pending" &&
          stored.acceptedAt === null &&
          effectiveConfirmationStatus(stored, clock.now()) === "expired",
        "s09: the expired record must stay unaccepted and report expired",
      );
    }
    record("s09-expired-cannot-accept", "rejected");
  }

  // s10: repeated acceptance is idempotent — same state, no new event.
  {
    const clock = makeClock();
    const repository = createInMemoryCustomerConfirmationRepository();
    const { rawToken, deps, record: accepted } = await createAccepted(
      repository,
      clock,
    );
    const repeat = await respondToCustomerConfirmation(
      { token: rawToken, response: "accept" },
      deps,
    );
    check(
      repeat.ok &&
        !repeat.changed &&
        repeat.record.acceptedAt === accepted.acceptedAt,
      "s10: repeated acceptance must return the existing accepted state unchanged",
    );
    record("s10-repeat-accept-idempotent", "unchanged");
  }

  // s11: an invalid token gets a safe generic not-found.
  {
    const clock = makeClock();
    const repository = createInMemoryCustomerConfirmationRepository();
    const deps = makeDeps(repository, clock);
    await createCustomerConfirmation(demoCreateInput(), deps);
    const unknown = await respondToCustomerConfirmation(
      { token: "raw-demo-token-not-issued", response: "accept" },
      deps,
    );
    check(
      !unknown.ok &&
        unknown.reason === "not-found" &&
        unknown.record === undefined,
      "s11: an invalid token must return not-found with no record content",
    );
    record("s11-invalid-token-safe-not-found", "not-found");
  }

  // s12: an accepted confirmation with matching details permits the
  // replacement preflight to continue.
  {
    const clock = makeClock();
    const repository = createInMemoryCustomerConfirmationRepository();
    const { record: accepted } = await createAccepted(repository, clock);
    const evaluation = evaluateConfirmationForReplacement(
      accepted,
      demoExpectation(),
      clock.now(),
    );
    check(
      evaluation.ok,
      "s12: an accepted, matching confirmation must permit replacement to continue",
    );
    record("s12-accepted-matching-permits", "permitted");
  }

  // s13-s15: pending, declined and expired confirmations block replacement
  // before any Pinch effect.
  {
    const states: Array<{
      label: string;
      prepare: (
        repository: CustomerConfirmationRepository,
        clock: ReturnType<typeof makeClock>,
      ) => Promise<CustomerScheduleConfirmationRecord>;
      expectReason: string;
    }> = [
      {
        label: "s13-pending-blocks",
        expectReason: "pending",
        prepare: async (repository, clock) => {
          const deps = makeDeps(repository, clock);
          const created = await createCustomerConfirmation(
            demoCreateInput(),
            deps,
          );
          check(created.ok, "s13: creation must succeed");
          if (!created.ok) {
            throw new Error("unreachable");
          }
          return created.record;
        },
      },
      {
        label: "s14-declined-blocks",
        expectReason: "declined",
        prepare: async (repository, clock) => {
          const deps = makeDeps(repository, clock);
          const created = await createCustomerConfirmation(
            demoCreateInput(),
            deps,
          );
          check(created.ok, "s14: creation must succeed");
          if (!created.ok) {
            throw new Error("unreachable");
          }
          const declined = await respondToCustomerConfirmation(
            { token: created.rawToken, response: "decline" },
            deps,
          );
          check(declined.ok, "s14: decline must succeed");
          if (!declined.ok) {
            throw new Error("unreachable");
          }
          return declined.record;
        },
      },
      {
        label: "s15-expired-blocks",
        expectReason: "expired",
        prepare: async (repository, clock) => {
          const deps = makeDeps(repository, clock);
          const created = await createCustomerConfirmation(
            demoCreateInput(),
            deps,
          );
          check(created.ok, "s15: creation must succeed");
          if (!created.ok) {
            throw new Error("unreachable");
          }
          clock.advanceMinutes(31);
          return created.record;
        },
      },
    ];
    for (const state of states) {
      const clock = makeClock();
      const repository = createInMemoryCustomerConfirmationRepository();
      const stateRecord = await state.prepare(repository, clock);
      const harness = makeFlowHarness(clock);
      const evaluation = await gateThenRunFlow(
        harness,
        stateRecord,
        demoExpectation(),
        clock.now(),
      );
      check(
        !evaluation.ok && evaluation.reason === state.expectReason,
        `${state.label}: the gate must refuse with ${state.expectReason}`,
      );
      check(
        harness.effectCalls.consume === 0 &&
          harness.effectCalls.cancel === 0 &&
          harness.effectCalls.create === 0 &&
          !harness.events.includes("operation.write"),
        `${state.label}: a refusal must invoke no effect and persist nothing`,
      );
      record(state.label, "blocked-before-any-effect");
    }
  }

  // s16-s23: every binding mismatch blocks replacement with nothing invoked.
  {
    const mismatches: Array<{
      label: string;
      field: string;
      mutate: (
        expectation: ReplacementConfirmationExpectation,
      ) => ReplacementConfirmationExpectation;
    }> = [
      {
        label: "s16-mismatched-merchant-blocks",
        field: "merchantId",
        mutate: (e) => ({ ...e, merchantId: "mch_other" }),
      },
      {
        label: "s17-mismatched-payer-blocks",
        field: "payerId",
        mutate: (e) => ({ ...e, payerId: "pyr_other" }),
      },
      {
        label: "s18-mismatched-source-blocks",
        field: "sourceId",
        mutate: (e) => ({ ...e, sourceId: "src_other" }),
      },
      {
        label: "s19-mismatched-subscription-blocks",
        field: "subscriptionId",
        mutate: (e) => ({ ...e, subscriptionId: "sub_other" }),
      },
      {
        label: "s20-mismatched-plan-blocks",
        field: "planId",
        mutate: (e) => ({ ...e, planId: "pln_other" }),
      },
      {
        label: "s21-mismatched-start-date-blocks",
        field: "proposedStartDate",
        mutate: (e) => ({ ...e, proposedStartDate: "2026-01-10" }),
      },
      {
        label: "s22-mismatched-payment-date-blocks",
        field: "confirmedPayments",
        mutate: (e) => ({
          ...e,
          confirmedPayments: e.confirmedPayments.map((payment, index) =>
            index === 0 ? { ...payment, paymentDate: "2026-01-10" } : payment,
          ),
        }),
      },
      {
        label: "s23-mismatched-amount-blocks",
        field: "confirmedPayments",
        mutate: (e) => ({
          ...e,
          confirmedPayments: e.confirmedPayments.map((payment, index) =>
            index === 0 ? { ...payment, amountInCents: 12501 } : payment,
          ),
        }),
      },
    ];
    for (const mismatch of mismatches) {
      const clock = makeClock();
      const repository = createInMemoryCustomerConfirmationRepository();
      const { record: accepted } = await createAccepted(repository, clock);
      const harness = makeFlowHarness(clock);
      const evaluation = await gateThenRunFlow(
        harness,
        accepted,
        mismatch.mutate(demoExpectation()),
        clock.now(),
      );
      check(
        !evaluation.ok &&
          evaluation.reason === "mismatch" &&
          evaluation.mismatchField === mismatch.field,
        `${mismatch.label}: the gate must refuse with a ${mismatch.field} mismatch`,
      );
      check(
        harness.effectCalls.consume === 0 &&
          harness.effectCalls.cancel === 0 &&
          harness.effectCalls.create === 0 &&
          !harness.events.includes("operation.write"),
        `${mismatch.label}: a mismatch must invoke no effect and persist nothing`,
      );
      record(mismatch.label, "blocked-before-any-effect");
    }
  }

  // s24: successful consumption records operationId and consumedAt.
  {
    const clock = makeClock();
    const repository = createInMemoryCustomerConfirmationRepository();
    const { record: accepted } = await createAccepted(repository, clock);
    const consumed = await consumeAcceptedCustomerConfirmation(
      { confirmationId: accepted.confirmationId, operationId: "op-demo-01" },
      { repository, now: clock.now },
    );
    check(consumed, "s24: consuming an accepted confirmation must succeed");
    const stored = await repository.readById(accepted.confirmationId);
    check(
      stored !== null &&
        stored.status === "consumed" &&
        stored.consumedAt !== null &&
        stored.operationId === "op-demo-01",
      "s24: consumption must record consumedAt and the operation ID",
    );
    record("s24-consumption-records-operation", "consumed");
  }

  // s25: failed consumption aborts the flow before the recovery record is
  // written and before cancellation; the original subscription is untouched.
  {
    const clock = makeClock();
    const harness = makeFlowHarness(clock);
    // A pending confirmation: service-backed consumption must refuse it.
    const deps = makeDeps(harness.confirmationRepository, clock);
    const created = await createCustomerConfirmation(demoCreateInput(), deps);
    check(created.ok, "s25: creation must succeed");
    if (created.ok) {
      const outcome = await harness.runFlow(created.record.confirmationId);
      check(
        outcome.outcome === "confirmation-consumption-failed",
        `s25: expected confirmation-consumption-failed, observed ${outcome.outcome}`,
      );
      check(
        harness.effectCalls.consume === 1 &&
          harness.effectCalls.cancel === 0 &&
          harness.effectCalls.create === 0 &&
          !harness.events.includes("operation.write") &&
          !harness.events.includes("pinch.cancel"),
        "s25: failed consumption must abort before any recovery-record write or Pinch mutation",
      );
      const stored = await harness.confirmationRepository.readById(
        created.record.confirmationId,
      );
      check(
        stored !== null && stored.status === "pending",
        "s25: a refused consumption must not change the confirmation",
      );
    }
    record("s25-failed-consumption-aborts", "aborted-before-mutation");
  }

  // s26: a consumed confirmation cannot be reused — by the gate or by a
  // second consumption.
  {
    const clock = makeClock();
    const repository = createInMemoryCustomerConfirmationRepository();
    const { record: accepted } = await createAccepted(repository, clock);
    const first = await consumeAcceptedCustomerConfirmation(
      { confirmationId: accepted.confirmationId, operationId: "op-demo-01" },
      { repository, now: clock.now },
    );
    check(first, "s26: the first consumption must succeed");
    const stored = await repository.readById(accepted.confirmationId);
    check(stored !== null, "s26: the consumed record must be readable");
    if (stored !== null) {
      const evaluation = evaluateConfirmationForReplacement(
        stored,
        demoExpectation(),
        clock.now(),
      );
      check(
        !evaluation.ok && evaluation.reason === "consumed",
        "s26: the gate must refuse a consumed confirmation",
      );
    }
    const second = await consumeAcceptedCustomerConfirmation(
      { confirmationId: accepted.confirmationId, operationId: "op-demo-02" },
      { repository, now: clock.now },
    );
    check(!second, "s26: a second consumption must fail");
    const after = await repository.readById(accepted.confirmationId);
    check(
      after !== null && after.operationId === "op-demo-01",
      "s26: the consumed record must keep its original operation binding",
    );
    record("s26-consumed-cannot-be-reused", "single-use");
  }

  // s27: a successful replacement records the confirmationId, and the full
  // ordering holds: consumption → recovery-record write → cancellation →
  // replacement creation.
  {
    const clock = makeClock();
    const harness = makeFlowHarness(clock);
    const { record: accepted } = await createAccepted(
      harness.confirmationRepository,
      clock,
    );
    const flowStart = harness.events.length;
    const outcome = await harness.runFlow(accepted.confirmationId);
    check(
      outcome.outcome === "replacement-verified",
      `s27: expected replacement-verified, observed ${outcome.outcome}`,
    );
    if (outcome.outcome === "replacement-verified") {
      check(
        outcome.record.confirmationId === accepted.confirmationId,
        "s27: the operation record must carry the consumed confirmation's ID",
      );
    }
    const flowEvents = harness.events.slice(flowStart);
    const consumeWriteIndex = flowEvents.indexOf("confirmation.write");
    const operationWriteIndex = flowEvents.indexOf("operation.write");
    const cancelIndex = flowEvents.indexOf("pinch.cancel");
    const createIndex = flowEvents.indexOf("pinch.create");
    check(
      consumeWriteIndex !== -1 &&
        operationWriteIndex !== -1 &&
        cancelIndex !== -1 &&
        createIndex !== -1 &&
        consumeWriteIndex < operationWriteIndex &&
        operationWriteIndex < cancelIndex &&
        cancelIndex < createIndex,
      "s27: consumption must precede the recovery-record write, which must precede cancellation, which must precede creation",
    );
    record("s27-operation-records-confirmation-id", "ordered-and-recorded");
  }

  // s28: the replacement audit projection exposes confirmationId but no
  // token material.
  {
    const clock = makeClock();
    const harness = makeFlowHarness(clock);
    const { record: accepted, rawToken } = await createAccepted(
      harness.confirmationRepository,
      clock,
    );
    const outcome = await harness.runFlow(accepted.confirmationId);
    check(
      outcome.outcome === "replacement-verified",
      "s28: projection scenario requires a verified operation",
    );
    if (outcome.outcome === "replacement-verified") {
      const projection = toSafeReplacementOperationProjection(outcome.record);
      const serialised = JSON.stringify(projection);
      check(
        projection.confirmationId === accepted.confirmationId &&
          !serialised.includes(rawToken) &&
          !serialised.includes(accepted.tokenHash),
        "s28: the audit projection must expose the confirmation ID and no token material",
      );
    }
    record("s28-audit-projection-confirmation-id-only", "safe");
  }

  // s29: repeated merchant lookup and projection never mutate the record.
  {
    const clock = makeClock();
    const repository = createInMemoryCustomerConfirmationRepository();
    const { record: accepted } = await createAccepted(repository, clock);
    const first = await repository.readById(accepted.confirmationId);
    check(first !== null, "s29: the record must be readable");
    if (first !== null) {
      const reference = JSON.stringify(first);
      first.status = "pending";
      (first.proposedPayments as ConfirmedSchedulePayment[]).length = 0;
      const projection = toMerchantConfirmationProjection(
        (await repository.readById(
          accepted.confirmationId,
        )) as CustomerScheduleConfirmationRecord,
        clock.now(),
      );
      projection.proposedPayments.push({
        paymentDate: "2099-01-01",
        amountInCents: 1,
      });
      const second = await repository.readById(accepted.confirmationId);
      check(
        second !== null && JSON.stringify(second) === reference,
        "s29: repeated lookup must not mutate the stored record",
      );
    }
    record("s29-repeated-lookup-does-not-mutate", "immutable");
  }

  // s30: the store rejects records carrying forbidden credentials or
  // payment-source material, while accepting the legitimate schema
  // (including its tokenHash field).
  {
    const clock = makeClock();
    const repository = createInMemoryCustomerConfirmationRepository();
    const { record: accepted } = await createAccepted(repository, clock);
    check(
      findForbiddenConfirmationRecordKey(accepted) === null,
      "s30: the legitimate record schema must contain no forbidden key",
    );
    const poisonings: Array<Record<string, unknown>> = [
      { cardNumber: "0000" },
      { apiSecret: "x" },
      { bankAccountNumber: "x" },
      { rawToken: "x" },
    ];
    for (const poison of poisonings) {
      let rejected = false;
      try {
        await repository.write({
          ...accepted,
          confirmationId: "conf_demo_poison",
          ...poison,
        } as CustomerScheduleConfirmationRecord);
      } catch {
        rejected = true;
      }
      check(
        rejected,
        `s30: the store must reject a record carrying ${Object.keys(poison)[0]}`,
      );
    }
    record("s30-forbidden-material-rejected", "rejected");
  }

  return { scenarioCount: table.length, decisionTable: table };
}

// ---------------------------------------------------------------------------
// Module-load kick-off, mirroring the replacement-operation validation: one
// full async pass whose failure is logged loudly; the dev confirmation
// routes re-assert the table on every request.

void validateCustomerConfirmationFlow().catch((error: unknown) => {
  console.error("Customer-confirmation validation failed at module load.", {
    errorClass: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  });
});
