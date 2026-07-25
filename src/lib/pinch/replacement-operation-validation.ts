/**
 * Deterministic validation of the subscription-replacement audit and
 * recovery flow, following the repository's validation convention: pure
 * synchronous checks run once at module load, and the exported function
 * re-asserts the full scenario table on demand. Because the flow is async
 * (repository and effects return promises), the full table is exported as an
 * async function and awaited by the dev operations route on every request;
 * the module-load pass runs the synchronous pure-helper checks immediately
 * and kicks off one full async pass whose failure is logged loudly.
 *
 * Nothing here calls Pinch or reads a clock: all effects, storage and time
 * are injected fakes over synthetic identifiers. No live merchant, payer,
 * subscription, plan or source IDs appear in the fixtures.
 */

import {
  findForbiddenRecordKey,
  toSafeReplacementOperationProjection,
  type SubscriptionReplacementOperationRecord,
  type SubscriptionReplacementOperationRepository,
  type SubscriptionReplacementRecoverySnapshot,
  type VerifiedReplacementMapping,
} from "./replacement-operation";
import { createInMemoryReplacementOperationRepository } from "./dev-replacement-operation-store";
import {
  executeSubscriptionReplacement,
  extractNewSubscriptionId,
  type ReplacementExecutionEffects,
  type ReplacementExecutionOutcome,
  type ReplacementExecutionRequest,
} from "./replacement-operation-flow";

export interface ReplacementOperationValidationRow {
  scenario: string;
  outcome: string;
}

export interface ReplacementOperationValidationResult {
  scenarioCount: number;
  decisionTable: ReplacementOperationValidationRow[];
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(
      `Replacement-operation validation failed: ${message}`,
    );
  }
}

/** Deterministic injected clock: strictly increasing synthetic ISO stamps. */
function syntheticClock(): () => string {
  let tick = 0;
  return () => {
    tick += 1;
    return `2026-01-01T00:00:00.${String(tick).padStart(3, "0")}Z`;
  };
}

const OLD_SUBSCRIPTION_ID = "sub_demo_original";
const NEW_SUBSCRIPTION_ID = "sub_demo_replacement";

function demoSnapshot(): SubscriptionReplacementRecoverySnapshot {
  return {
    merchantId: "mch_demo",
    payerId: "pyr_demo",
    sourceId: "src_demo",
    planId: "pln_demo",
    originalStartDate: "2026-01-07",
    oldSubscriptionId: OLD_SUBSCRIPTION_ID,
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

function demoRequest(): ReplacementExecutionRequest {
  return {
    operationId: "op-demo-01",
    confirmationId: "conf-demo-01",
    merchantId: "mch_demo",
    payerId: "pyr_demo",
    planId: "pln_demo",
    sourceId: "src_demo",
    oldSubscriptionId: OLD_SUBSCRIPTION_ID,
    previousStartDate: "2026-01-07",
    requestedStartDate: "2026-01-09",
    previousTotalAmountCents: null,
    requestedTotalAmountCents: null,
    recoverySnapshot: demoSnapshot(),
  };
}

function demoMapping(): VerifiedReplacementMapping {
  return {
    oldSubscriptionId: OLD_SUBSCRIPTION_ID,
    newSubscriptionId: NEW_SUBSCRIPTION_ID,
    verifiedStartDate: "2026-01-09",
    planId: "pln_demo",
    payerId: "pyr_demo",
    sourceId: "src_demo",
    paymentDates: ["2026-01-09", "2026-01-16", "2026-01-23"],
    paymentAmountsCents: [12500, 12500, 12500],
  };
}

interface RepositoryInstrumentation {
  /** Chronological event log shared with the effects instrumentation. */
  events: string[];
  repository: SubscriptionReplacementOperationRepository;
  /** Direct access to stored state, bypassing the instrumentation. */
  inner: SubscriptionReplacementOperationRepository;
}

function instrumentedRepository(
  events: string[],
  options: {
    failEveryWrite?: boolean;
    readAlwaysNull?: boolean;
    tamperReadBack?: boolean;
  } = {},
): RepositoryInstrumentation {
  const inner = createInMemoryReplacementOperationRepository();
  const repository: SubscriptionReplacementOperationRepository = {
    async write(record) {
      events.push("repository.write");
      if (options.failEveryWrite === true) {
        throw new Error("synthetic storage write failure");
      }
      await inner.write(record);
    },
    async read(operationId) {
      events.push("repository.read");
      if (options.readAlwaysNull === true) {
        return null;
      }
      const record = await inner.read(operationId);
      if (record !== null && options.tamperReadBack === true) {
        return { ...record, updatedAt: "1999-01-01T00:00:00.000Z" };
      }
      return record;
    },
  };
  return { events, repository, inner };
}

interface EffectsInstrumentation {
  effects: ReplacementExecutionEffects;
  calls: {
    consumeCustomerConfirmation: number;
    cancelOriginal: number;
    readOriginalStatus: number;
    createReplacement: number;
    verifyReplacement: number;
  };
}

function instrumentedEffects(
  events: string[],
  options: {
    consumeReturnsFalse?: boolean;
    cancelThrows?: boolean;
    originalStatusAfterCancel?: string;
    originalStatusReadThrows?: boolean;
    createThrows?: boolean;
    createResult?: unknown;
    verifyThrows?: boolean;
    verifyResult?: VerifiedReplacementMapping | null;
  } = {},
): EffectsInstrumentation {
  const calls = {
    consumeCustomerConfirmation: 0,
    cancelOriginal: 0,
    readOriginalStatus: 0,
    createReplacement: 0,
    verifyReplacement: 0,
  };
  const effects: ReplacementExecutionEffects = {
    // Deliberately not an "effects."-prefixed event: consumption touches
    // only the confirmation store, so the first-Pinch-effect assertions
    // below stay meaningful.
    async consumeCustomerConfirmation() {
      calls.consumeCustomerConfirmation += 1;
      events.push("confirmation.consume");
      return options.consumeReturnsFalse !== true;
    },
    async cancelOriginal() {
      calls.cancelOriginal += 1;
      events.push("effects.cancelOriginal");
      if (options.cancelThrows === true) {
        throw new Error("synthetic DELETE failure");
      }
    },
    async readOriginalStatus() {
      calls.readOriginalStatus += 1;
      events.push("effects.readOriginalStatus");
      if (options.originalStatusReadThrows === true) {
        throw new Error("synthetic status read failure");
      }
      return {
        id: OLD_SUBSCRIPTION_ID,
        status: options.originalStatusAfterCancel ?? "cancelled",
      };
    },
    async createReplacement() {
      calls.createReplacement += 1;
      events.push("effects.createReplacement");
      if (options.createThrows === true) {
        throw new Error("synthetic POST failure");
      }
      return "createResult" in options
        ? options.createResult
        : { id: NEW_SUBSCRIPTION_ID };
    },
    async verifyReplacement() {
      calls.verifyReplacement += 1;
      events.push("effects.verifyReplacement");
      if (options.verifyThrows === true) {
        throw new Error("synthetic verification read failure");
      }
      return "verifyResult" in options
        ? (options.verifyResult ?? null)
        : demoMapping();
    },
  };
  return { effects, calls };
}

const silentLog = (): void => {
  // Validation scenarios intentionally exercise failure paths; the flow's
  // safe logging is not part of the asserted contract.
};

async function run(
  repository: SubscriptionReplacementOperationRepository,
  effects: ReplacementExecutionEffects,
): Promise<ReplacementExecutionOutcome> {
  return executeSubscriptionReplacement(
    demoRequest(),
    repository,
    effects,
    syntheticClock(),
    silentLog,
  );
}

/**
 * Full deterministic scenario table. Never calls Pinch; every effect and
 * storage interaction is an injected fake with call-order instrumentation.
 */
export async function validateReplacementOperationRecovery(): Promise<ReplacementOperationValidationResult> {
  const table: ReplacementOperationValidationRow[] = [];
  const record = (scenario: string, outcome: string): void => {
    table.push({ scenario, outcome });
  };

  // s01: happy path — the recovery record is written and read back before
  // the cancellation effect is invoked, and the completed record carries
  // the old-to-new subscription ID mapping.
  {
    const events: string[] = [];
    const { repository, inner } = instrumentedRepository(events);
    const { effects, calls } = instrumentedEffects(events);
    const outcome = await run(repository, effects);
    check(
      outcome.outcome === "replacement-verified",
      `s01: expected replacement-verified, observed ${outcome.outcome}`,
    );
    const firstEffectIndex = events.findIndex((event) =>
      event.startsWith("effects."),
    );
    const writesBeforeAnyEffect = events
      .slice(0, firstEffectIndex)
      .filter((event) => event === "repository.write").length;
    const readsBeforeAnyEffect = events
      .slice(0, firstEffectIndex)
      .filter((event) => event === "repository.read").length;
    check(
      firstEffectIndex > 0 &&
        events[firstEffectIndex] === "effects.cancelOriginal" &&
        writesBeforeAnyEffect >= 2 &&
        readsBeforeAnyEffect >= 2,
      "s01: the recovery record must be written and read back (twice) before the cancellation effect runs",
    );
    const consumeIndex = events.indexOf("confirmation.consume");
    const firstWriteIndex = events.indexOf("repository.write");
    check(
      consumeIndex !== -1 &&
        firstWriteIndex !== -1 &&
        consumeIndex < firstWriteIndex,
      "s01: the customer confirmation must be consumed before the recovery record is written",
    );
    check(
      calls.consumeCustomerConfirmation === 1 &&
        calls.cancelOriginal === 1 &&
        calls.readOriginalStatus === 1 &&
        calls.createReplacement === 1 &&
        calls.verifyReplacement === 1,
      "s01: every effect must run exactly once on the happy path",
    );
    if (outcome.outcome === "replacement-verified") {
      check(
        outcome.record.status === "replacement-verified" &&
          outcome.record.currentStage === "replacement-verified" &&
          outcome.record.confirmationId === "conf-demo-01" &&
          outcome.record.oldSubscriptionId === OLD_SUBSCRIPTION_ID &&
          outcome.record.newSubscriptionId === NEW_SUBSCRIPTION_ID &&
          outcome.record.verifiedReplacement !== null &&
          outcome.record.verifiedReplacement.oldSubscriptionId ===
            OLD_SUBSCRIPTION_ID &&
          outcome.record.verifiedReplacement.newSubscriptionId ===
            NEW_SUBSCRIPTION_ID,
        "s01: the completed record must map the old subscription ID to the new one",
      );
      check(
        outcome.record.failureCode === null &&
          outcome.record.failureMessage === null,
        "s01: a verified operation must carry no failure information",
      );
      const stored = await inner.read("op-demo-01");
      check(
        stored !== null &&
          JSON.stringify(stored) === JSON.stringify(outcome.record),
        "s01: the stored record must equal the returned record",
      );
      check(
        findForbiddenRecordKey(outcome.record) === null,
        "s01: the stored record must contain no credential or payment-source key",
      );
    }
    record("s01-happy-path-write-before-cancel-and-mapping", "verified");
  }

  // s02: a failed recovery-record write prevents cancellation entirely.
  {
    const events: string[] = [];
    const { repository } = instrumentedRepository(events, {
      failEveryWrite: true,
    });
    const { effects, calls } = instrumentedEffects(events);
    const outcome = await run(repository, effects);
    check(
      outcome.outcome === "recovery-record-failed",
      `s02: expected recovery-record-failed, observed ${outcome.outcome}`,
    );
    check(
      calls.cancelOriginal === 0 &&
        calls.createReplacement === 0 &&
        calls.readOriginalStatus === 0 &&
        calls.verifyReplacement === 0,
      "s02: no effect may run after a failed recovery-record write",
    );
    record("s02-failed-record-write-prevents-cancellation", "aborted");
  }

  // s03: a failed recovery-record read-back prevents cancellation.
  {
    const events: string[] = [];
    const { repository } = instrumentedRepository(events, {
      readAlwaysNull: true,
    });
    const { effects, calls } = instrumentedEffects(events);
    const outcome = await run(repository, effects);
    check(
      outcome.outcome === "recovery-record-failed",
      `s03: expected recovery-record-failed, observed ${outcome.outcome}`,
    );
    check(
      calls.cancelOriginal === 0 && calls.createReplacement === 0,
      "s03: no mutation may run after a failed recovery-record read-back",
    );
    record("s03-failed-record-read-back-prevents-cancellation", "aborted");
  }

  // s04: a read-back that does not match the written record also aborts.
  {
    const events: string[] = [];
    const { repository } = instrumentedRepository(events, {
      tamperReadBack: true,
    });
    const { effects, calls } = instrumentedEffects(events);
    const outcome = await run(repository, effects);
    check(
      outcome.outcome === "recovery-record-failed" &&
        calls.cancelOriginal === 0,
      "s04: a mismatched recovery-record read-back must abort before mutation",
    );
    record("s04-mismatched-read-back-prevents-cancellation", "aborted");
  }

  // s05 + s07: creation failure after verified cancellation produces
  // manual-recovery-required and preserves the reinstatement payload.
  {
    const events: string[] = [];
    const { repository, inner } = instrumentedRepository(events);
    const { effects, calls } = instrumentedEffects(events, {
      createThrows: true,
    });
    const outcome = await run(repository, effects);
    check(
      outcome.outcome === "replacement-create-failed",
      `s05: expected replacement-create-failed, observed ${outcome.outcome}`,
    );
    check(
      calls.cancelOriginal === 1 &&
        calls.createReplacement === 1 &&
        calls.verifyReplacement === 0,
      "s05: creation must run exactly once and never be retried",
    );
    if (outcome.outcome === "replacement-create-failed") {
      check(
        outcome.record.status === "manual-recovery-required" &&
          outcome.record.currentStage === "replacement-create-failed" &&
          outcome.record.failureCode === "REPLACEMENT_CREATE_FAILED" &&
          outcome.record.failureMessage !== null,
        "s05: create failure must record manual-recovery-required at stage replacement-create-failed",
      );
      check(
        JSON.stringify(outcome.record.recoverySnapshot) ===
          JSON.stringify(demoSnapshot()),
        "s07: create failure must preserve the full recovery snapshot including the reinstatement payload",
      );
      const stored = await inner.read("op-demo-01");
      check(
        stored !== null &&
          stored.status === "manual-recovery-required" &&
          JSON.stringify(stored.recoverySnapshot.reinstatementCreateBody) ===
            JSON.stringify(demoSnapshot().reinstatementCreateBody),
        "s07: the stored record must retain the exact original reinstatement payload",
      );
    }
    record("s05-create-failure-manual-recovery", "manual-recovery-required");
    record("s07-create-failure-preserves-reinstatement-payload", "preserved");
  }

  // s06 + s08: verification failure after creation produces
  // manual-recovery-required and preserves both subscription IDs.
  {
    const events: string[] = [];
    const { repository } = instrumentedRepository(events);
    const { effects, calls } = instrumentedEffects(events, {
      verifyResult: null,
    });
    const outcome = await run(repository, effects);
    check(
      outcome.outcome === "replacement-verification-failed",
      `s06: expected replacement-verification-failed, observed ${outcome.outcome}`,
    );
    check(
      calls.createReplacement === 1 && calls.verifyReplacement === 1,
      "s06: verification must run exactly once and never trigger a second creation",
    );
    if (outcome.outcome === "replacement-verification-failed") {
      check(
        outcome.record.status === "manual-recovery-required" &&
          outcome.record.currentStage === "replacement-verification-failed" &&
          outcome.record.failureCode === "REPLACEMENT_VERIFICATION_FAILED",
        "s06: verification failure must record manual-recovery-required at stage replacement-verification-failed",
      );
      check(
        outcome.record.oldSubscriptionId === OLD_SUBSCRIPTION_ID &&
          outcome.record.newSubscriptionId === NEW_SUBSCRIPTION_ID,
        "s08: verification failure must preserve the old ID and the provisional new ID",
      );
      check(
        JSON.stringify(outcome.record.recoverySnapshot) ===
          JSON.stringify(demoSnapshot()),
        "s08: verification failure must retain the recovery snapshot",
      );
    }
    record(
      "s06-verification-failure-manual-recovery",
      "manual-recovery-required",
    );
    record("s08-verification-failure-preserves-both-ids", "preserved");
  }

  // s09: a verification read that throws is handled identically, and no
  // effect is retried after the ambiguous response.
  {
    const events: string[] = [];
    const { repository } = instrumentedRepository(events);
    const { effects, calls } = instrumentedEffects(events, {
      verifyThrows: true,
    });
    const outcome = await run(repository, effects);
    check(
      outcome.outcome === "replacement-verification-failed" &&
        calls.cancelOriginal === 1 &&
        calls.createReplacement === 1 &&
        calls.verifyReplacement === 1,
      "s09: no effect may be retried after an ambiguous verification response",
    );
    record("s09-no-retry-after-ambiguous-verification", "no-retry");
  }

  // s10: an ambiguous creation result (success without an extractable
  // subscription ID) becomes manual-recovery-required without any retry.
  {
    const events: string[] = [];
    const { repository } = instrumentedRepository(events);
    const { effects, calls } = instrumentedEffects(events, {
      createResult: { acknowledged: true },
    });
    const outcome = await run(repository, effects);
    check(
      outcome.outcome === "replacement-ambiguous",
      `s10: expected replacement-ambiguous, observed ${outcome.outcome}`,
    );
    check(
      calls.createReplacement === 1 && calls.verifyReplacement === 0,
      "s10: an ambiguous creation must never be retried or verified as if created",
    );
    if (outcome.outcome === "replacement-ambiguous") {
      check(
        outcome.record.status === "manual-recovery-required" &&
          outcome.record.currentStage === "replacement-ambiguous" &&
          outcome.record.newSubscriptionId === null,
        "s10: an ambiguous creation must record manual-recovery-required with no claimed new subscription ID",
      );
    }
    record("s10-ambiguous-create-manual-recovery", "manual-recovery-required");
  }

  // s11: unverified cancellation stops the flow before creation.
  {
    const events: string[] = [];
    const { repository } = instrumentedRepository(events);
    const { effects, calls } = instrumentedEffects(events, {
      originalStatusAfterCancel: "active",
    });
    const outcome = await run(repository, effects);
    check(
      outcome.outcome === "cancel-verification-failed" &&
        calls.createReplacement === 0,
      "s11: an unverified cancellation must never proceed to creation",
    );
    if (outcome.outcome === "cancel-verification-failed") {
      check(
        outcome.record.status === "manual-recovery-required" &&
          outcome.record.currentStage === "cancel-verification-failed",
        "s11: an unverified cancellation must record manual-recovery-required at stage cancel-verification-failed",
      );
    }
    record(
      "s11-unverified-cancellation-stops-flow",
      "manual-recovery-required",
    );
  }

  // s12: a DELETE that throws is not retried; verification alone decides.
  {
    const events: string[] = [];
    const { repository } = instrumentedRepository(events);
    const { effects, calls } = instrumentedEffects(events, {
      cancelThrows: true,
    });
    const outcome = await run(repository, effects);
    check(
      outcome.outcome === "replacement-verified" &&
        calls.cancelOriginal === 1,
      "s12: a DELETE error must not be retried when verification confirms cancellation",
    );
    record("s12-delete-error-not-retried", "verified");
  }

  // s13: the store rejects records carrying forbidden payment-source or
  // credential material, and the flow then aborts before mutation.
  {
    const repository = createInMemoryReplacementOperationRepository();
    const poisonedSnapshot = {
      ...demoSnapshot(),
      cardNumber: "0000",
    } as unknown as SubscriptionReplacementRecoverySnapshot;
    const events: string[] = [];
    let writeRejected = false;
    try {
      await repository.write({
        ...baseRecordForStoreChecks(),
        recoverySnapshot: poisonedSnapshot,
      });
    } catch {
      writeRejected = true;
    }
    check(
      writeRejected,
      "s13: the store must reject a record carrying forbidden material",
    );
    const { effects, calls } = instrumentedEffects(events);
    const outcome = await executeSubscriptionReplacement(
      { ...demoRequest(), recoverySnapshot: poisonedSnapshot },
      repository,
      effects,
      syntheticClock(),
      silentLog,
    );
    check(
      outcome.outcome === "recovery-record-failed" &&
        calls.cancelOriginal === 0,
      "s13: a rejected recovery record must abort the flow before any mutation",
    );
    record("s13-forbidden-material-rejected", "rejected");
  }

  // s14: the operation lookup projection exposes exactly the safe fields.
  {
    const events: string[] = [];
    const { repository, inner } = instrumentedRepository(events);
    const { effects } = instrumentedEffects(events);
    const outcome = await run(repository, effects);
    check(
      outcome.outcome === "replacement-verified",
      "s14: projection scenario requires a verified operation",
    );
    const stored = await inner.read("op-demo-01");
    check(stored !== null, "s14: the verified operation must be readable");
    if (stored !== null) {
      const projection = toSafeReplacementOperationProjection(stored);
      const expectedKeys = [
        "operationId",
        "confirmationId",
        "status",
        "currentStage",
        "oldSubscriptionId",
        "newSubscriptionId",
        "mapping",
        "recoveryAvailable",
        "failureCode",
        "failureMessage",
        "createdAt",
        "updatedAt",
      ];
      check(
        JSON.stringify(Object.keys(projection).sort()) ===
          JSON.stringify([...expectedKeys].sort()),
        "s14: the projection must expose exactly the documented safe fields",
      );
      check(
        !("recoverySnapshot" in projection),
        "s14: the projection must not expose the recovery snapshot",
      );
      check(
        projection.recoveryAvailable === true &&
          projection.mapping !== null &&
          projection.mapping.oldSubscriptionId === OLD_SUBSCRIPTION_ID &&
          projection.mapping.newSubscriptionId === NEW_SUBSCRIPTION_ID,
        "s14: the projection must carry recovery availability and the old-to-new mapping",
      );
    }
    record("s14-lookup-projection-safe-fields", "projected");
  }

  // s15: repeated reads and projections never mutate the stored record.
  {
    const events: string[] = [];
    const { repository, inner } = instrumentedRepository(events);
    const { effects } = instrumentedEffects(events);
    await run(repository, effects);
    const first = await inner.read("op-demo-01");
    check(first !== null, "s15: the stored record must be readable");
    if (first !== null) {
      const reference = JSON.stringify(first);
      // Mutate everything reachable from the returned copies.
      first.status = "preflight-complete";
      first.recoverySnapshot.originalCalculatedPayments.length = 0;
      first.verifiedReplacement?.paymentDates.push("2099-01-01");
      const projection = toSafeReplacementOperationProjection(
        (await inner.read("op-demo-01")) as SubscriptionReplacementOperationRecord,
      );
      projection.mapping?.paymentAmountsCents.push(1);
      const second = await inner.read("op-demo-01");
      check(
        second !== null && JSON.stringify(second) === reference,
        "s15: repeated lookup must not mutate the stored record",
      );
    }
    record("s15-repeated-lookup-does-not-mutate", "immutable");
  }

  return { scenarioCount: table.length, decisionTable: table };
}

/** A minimal well-formed record for direct store checks. */
function baseRecordForStoreChecks(): SubscriptionReplacementOperationRecord {
  return {
    operationId: "op-demo-store-01",
    confirmationId: "conf-demo-01",
    merchantId: "mch_demo",
    payerId: "pyr_demo",
    planId: "pln_demo",
    sourceId: "src_demo",
    oldSubscriptionId: OLD_SUBSCRIPTION_ID,
    newSubscriptionId: null,
    previousStartDate: "2026-01-07",
    requestedStartDate: "2026-01-09",
    previousTotalAmountCents: null,
    requestedTotalAmountCents: null,
    status: "preflight-complete",
    currentStage: "preflight",
    recoverySnapshot: demoSnapshot(),
    verifiedReplacement: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-01-01T00:00:00.001Z",
    updatedAt: "2026-01-01T00:00:00.001Z",
  };
}

// ---------------------------------------------------------------------------
// Module-load self-check of the pure helpers: cheap, synchronous and
// deterministic, throwing on regression so a broken helper fails fast. The
// full async scenario table is additionally kicked off once here (failure is
// logged loudly) and re-asserted by the dev operations route on every
// request.

(function verifyPureHelpersAtLoad(): void {
  check(
    extractNewSubscriptionId("sub_demo_x") === "sub_demo_x" &&
      extractNewSubscriptionId({ id: "sub_demo_x" }) === "sub_demo_x" &&
      extractNewSubscriptionId({ id: "pmt_demo_x" }) === null &&
      extractNewSubscriptionId(42) === null &&
      extractNewSubscriptionId(null) === null,
    "extractNewSubscriptionId must accept only sub_-prefixed IDs in the two proven shapes",
  );
  check(
    findForbiddenRecordKey(baseRecordForStoreChecks()) === null,
    "the well-formed record schema must contain no forbidden key",
  );
  check(
    findForbiddenRecordKey({ nested: [{ accessToken: "x" }] }) ===
      "accessToken" &&
      findForbiddenRecordKey({ bankAccountNumber: "x" }) ===
        "bankAccountNumber" &&
      findForbiddenRecordKey({ cardNumber: "x" }) === "cardNumber",
    "forbidden credential and payment-source keys must be detected at any depth",
  );
  const projection = toSafeReplacementOperationProjection(
    baseRecordForStoreChecks(),
  );
  check(
    !("recoverySnapshot" in projection) &&
      projection.recoveryAvailable === true &&
      projection.newSubscriptionId === null,
    "the safe projection must omit the recovery snapshot and report availability",
  );
})();

void validateReplacementOperationRecovery().catch((error: unknown) => {
  console.error(
    "Replacement-operation validation failed at module load.",
    { errorClass: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error) },
  );
});
