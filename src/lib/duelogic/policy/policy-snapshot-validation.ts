/**
 * Deterministic validation of the merchant policy snapshot foundation,
 * following the repository's validation convention: the exported async
 * function re-asserts the six-scenario table on demand, and one pass is
 * kicked off at module load with loud failure logging.
 *
 * Nothing here calls Pinch or reads a real clock: every scenario runs
 * against a fresh isolated in-memory repository from the dev policy store
 * factory with a controlled deterministic clock — the shared globalThis
 * development store is never touched. DEFAULT_DUELOGIC_POLICY is read
 * only; later-version fixtures derive from it with a changed threshold
 * value, never by redefining any rule.
 *
 * The six foundation scenarios:
 *  s1 a fresh repository installs exactly one initial active snapshot;
 *  s2 the initial snapshot carries duelogic-default-v1, the exact default
 *     policy, matching versions, the initial-default marker and the
 *     controlled clock's activatedAt;
 *  s3 a valid later snapshot activates under the next server-generated
 *     version while the initial snapshot remains in history;
 *  s4 duplicate versions, version mismatches and invalid policies are
 *     rejected without changing the repository;
 *  s5 mutating objects returned from readActive, readByVersion or list
 *     never alters stored state;
 *  s6 multiple activations create distinct sequential versions, retain
 *     all earlier snapshots and leave only the latest active.
 *
 * The dashboard configuration stage adds seven scenarios over the
 * activation request helper (policy-activation.ts):
 *  s7 the merchant-safe view exposes the active projection and ordered
 *     history without the merchant ID or any complete policy data;
 *  s8 a valid ceiling activates the next server-generated immutable
 *     version, changing only policy.version, amountCeilingCents and
 *     snapshot metadata, with the initial default retained in history;
 *  s9 unknown keys and browser-supplied policy identity or fixed rule
 *     fields are rejected without a repository write;
 * s10 invalid ceiling values are rejected without changing history;
 * s11 consecutive request-path activations create sequential versions and
 *     preserve every earlier snapshot;
 * s12 the returned safe view cannot be mutated to change stored state;
 * s13 the frozen seed policy consumers still evaluate under the default
 *     policy version after an activation.
 *
 * The replay/opportunity adoption stage adds seven scenarios:
 * s14 the no-argument replay builder still evaluates under
 *     DEFAULT_DUELOGIC_POLICY and stamps duelogic-default-v1;
 * s15 an activated snapshot's complete policy drives the replay and
 *     stamps every decision with the activated policyVersion;
 * s16 a lower active ceiling changes the relevant replay decisions
 *     through the existing engine, leaving seed and detector unchanged;
 * s17 opportunity figures derive from the same active-policy evaluations
 *     and change consistently with those decisions;
 * s18 the opportunity result and every replay decision carry the one
 *     governing version passed to the dashboard panels;
 * s19 a further activation updates replay and opportunity inputs without
 *     changing the seed, the detector or the aggregation logic;
 * s20 the no-argument path used by the scheduled intervention scan and
 *     customer date evaluation remains frozen-default after activation.
 */

import { calculateMerchantOpportunity } from "../merchant-opportunity";
import type { DueLogicPolicy } from "../schema";
import { seedPayers } from "../seed-payment-history";
import {
  buildSeedPolicyEvaluations,
  type SeedPolicyEvaluations,
} from "../seed-policy-evaluations";
import {
  createInMemoryMerchantPolicyRepository,
  DEV_POLICY_MERCHANT_ID,
  generateNextDevPolicyVersion,
  installInitialDefaultPolicySnapshot,
} from "./dev-policy-store";
import { PolicyValidationError } from "./engine";
import {
  buildMerchantPolicyView,
  processPolicyActivationRequest,
} from "./policy-activation";
import type {
  MerchantPolicyRepository,
  MerchantPolicySnapshot,
} from "./policy-snapshot";
import { DEFAULT_DUELOGIC_POLICY } from "./rules";

export interface PolicySnapshotValidationRow {
  scenario: string;
  outcome: string;
}

export interface PolicySnapshotValidationResult {
  scenarioCount: number;
  decisionTable: PolicySnapshotValidationRow[];
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Policy snapshot validation failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Injected deterministic dependencies and fixtures

const CONTROLLED_CLOCK_START = "2026-07-25T00:00:00.000Z";

/** Strictly increasing controlled clock; the first reading is the start. */
function makeClock(startIso: string = CONTROLLED_CLOCK_START): () => string {
  let tick = 0;
  return (): string => {
    const reading = new Date(Date.parse(startIso) + tick * 1_000);
    tick += 1;
    return reading.toISOString();
  };
}

/**
 * A later-version policy fixture: the default policy with a new version
 * and a changed threshold value — never a second definition of the
 * default and never a changed rule in policy/rules.ts.
 */
function laterPolicy(
  version: string,
  amountCeilingCents: number = 60_000,
): DueLogicPolicy {
  return { ...DEFAULT_DUELOGIC_POLICY, version, amountCeilingCents };
}

function laterSnapshot(
  policyVersion: string,
  activatedAt: string,
  policy: DueLogicPolicy = laterPolicy(policyVersion),
): MerchantPolicySnapshot {
  return {
    policyVersion,
    merchantId: DEV_POLICY_MERCHANT_ID,
    policy,
    activatedAt,
    installedAsInitialDefault: false,
  };
}

/** A fresh isolated repository with the initial default installed. */
async function installedRepository(
  clock: () => string,
): Promise<MerchantPolicyRepository> {
  const repository = createInMemoryMerchantPolicyRepository();
  await installInitialDefaultPolicySnapshot(repository, clock);
  return repository;
}

async function expectRejection(
  message: string,
  run: () => Promise<void>,
): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error(`Policy snapshot validation failed: ${message}`);
}

/** The exact evaluation set the dashboard passes to the opportunity calc. */
function toOpportunityEvaluations(evaluations: SeedPolicyEvaluations) {
  return evaluations.policyItems.map(({ request, decision }) => ({
    request,
    decision,
  }));
}

// ---------------------------------------------------------------------------
// Scenario table

export async function validatePolicySnapshotFoundation(): Promise<PolicySnapshotValidationResult> {
  const table: PolicySnapshotValidationRow[] = [];
  const record = (scenario: string, outcome: string): void => {
    table.push({ scenario, outcome });
  };

  // s1: a fresh repository installs exactly one initial active snapshot;
  // a repeated installation never overwrites or recreates it.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    const history = await repository.list(DEV_POLICY_MERCHANT_ID);
    const active = await repository.readActive(DEV_POLICY_MERCHANT_ID);
    check(
      history.length === 1,
      "s1: exactly one snapshot must exist after installation",
    );
    check(
      active !== null && active.policyVersion === history[0].policyVersion,
      "s1: the installed snapshot must be the active snapshot",
    );
    await installInitialDefaultPolicySnapshot(repository, clock);
    check(
      (await repository.list(DEV_POLICY_MERCHANT_ID)).length === 1,
      "s1: repeated installation must not recreate the initial snapshot",
    );
    record("s1-fresh-repository-installs-one-initial-snapshot", "installed");
  }

  // s2: the initial snapshot is duelogic-default-v1, deeply equal to
  // DEFAULT_DUELOGIC_POLICY, version-consistent, marked as the installed
  // initial default and stamped with the controlled clock's reading.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    const active = await repository.readActive(DEV_POLICY_MERCHANT_ID);
    check(active !== null, "s2: the initial snapshot must be readable");
    const snapshot = active as MerchantPolicySnapshot;
    check(
      snapshot.policyVersion === "duelogic-default-v1",
      "s2: the initial version must be duelogic-default-v1",
    );
    check(
      JSON.stringify(snapshot.policy) ===
        JSON.stringify(DEFAULT_DUELOGIC_POLICY),
      "s2: the initial policy must deeply equal DEFAULT_DUELOGIC_POLICY",
    );
    check(
      snapshot.policyVersion === snapshot.policy.version,
      "s2: policyVersion must equal policy.version",
    );
    check(
      snapshot.installedAsInitialDefault === true,
      "s2: the initial snapshot must be marked installedAsInitialDefault",
    );
    check(
      snapshot.activatedAt === CONTROLLED_CLOCK_START,
      "s2: activatedAt must be the controlled clock's value",
    );
    check(
      snapshot.merchantId === DEV_POLICY_MERCHANT_ID,
      "s2: the snapshot must bind the development-context merchant",
    );
    record("s2-initial-snapshot-content", "verified");
  }

  // s3: a valid later snapshot activates under the next server-generated
  // version, becomes active, and leaves the initial snapshot in history.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    const version = await generateNextDevPolicyVersion(repository);
    check(
      version === "duelogic-policy-v2",
      "s3: the first later snapshot must receive duelogic-policy-v2",
    );
    await repository.activate(laterSnapshot(version, clock()));
    const active = await repository.readActive(DEV_POLICY_MERCHANT_ID);
    check(
      active !== null &&
        active.policyVersion === "duelogic-policy-v2" &&
        active.installedAsInitialDefault === false &&
        active.policy.amountCeilingCents === 60_000,
      "s3: the later snapshot must become active with its own values",
    );
    const initial = await repository.readByVersion(
      DEV_POLICY_MERCHANT_ID,
      "duelogic-default-v1",
    );
    check(
      initial !== null && initial.installedAsInitialDefault === true,
      "s3: the initial snapshot must remain in history",
    );
    check(
      (await repository.list(DEV_POLICY_MERCHANT_ID)).length === 2,
      "s3: history must hold both snapshots",
    );
    record("s3-later-snapshot-activates", "activated");
  }

  // s4: invalid activation attempts are rejected without changing the
  // repository: a duplicate policyVersion (later or initial), a
  // policyVersion/policy.version mismatch, and a policy the existing
  // engine validation refuses.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    await repository.activate(laterSnapshot("duelogic-policy-v2", clock()));
    const before = JSON.stringify(await repository.list(DEV_POLICY_MERCHANT_ID));

    await expectRejection(
      "s4: a duplicate later policyVersion must be rejected",
      () => repository.activate(laterSnapshot("duelogic-policy-v2", clock())),
    );
    await expectRejection(
      "s4: a duplicate of the initial policyVersion must be rejected",
      () =>
        repository.activate(laterSnapshot("duelogic-default-v1", clock())),
    );
    await expectRejection(
      "s4: a policyVersion/policy.version mismatch must be rejected",
      () =>
        repository.activate(
          laterSnapshot(
            "duelogic-policy-v3",
            clock(),
            laterPolicy("duelogic-policy-v9"),
          ),
        ),
    );
    const invalidPolicyError = await expectRejection(
      "s4: an invalid policy object must be rejected",
      () =>
        repository.activate(
          laterSnapshot(
            "duelogic-policy-v3",
            clock(),
            laterPolicy("duelogic-policy-v3", 0),
          ),
        ),
    );
    check(
      invalidPolicyError instanceof PolicyValidationError &&
        invalidPolicyError.code === "INVALID_POLICY_VALUE",
      "s4: the invalid policy must be refused by the existing engine validation",
    );

    check(
      JSON.stringify(await repository.list(DEV_POLICY_MERCHANT_ID)) === before,
      "s4: rejected activations must leave stored history unchanged",
    );
    const active = await repository.readActive(DEV_POLICY_MERCHANT_ID);
    check(
      active !== null && active.policyVersion === "duelogic-policy-v2",
      "s4: the active snapshot must be unchanged after rejections",
    );
    record("s4-invalid-activation-rejected", "rejected-unchanged");
  }

  // s5: stored snapshots are immutable — mutating the caller's activated
  // snapshot or any object returned from readActive, readByVersion or
  // list never alters stored state.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    const submitted = laterSnapshot("duelogic-policy-v2", clock());
    await repository.activate(submitted);
    const before = JSON.stringify(await repository.list(DEV_POLICY_MERCHANT_ID));

    (submitted.policy as { amountCeilingCents: number }).amountCeilingCents = 1;

    const active = await repository.readActive(DEV_POLICY_MERCHANT_ID);
    check(active !== null, "s5: the active snapshot must be readable");
    const activeSnapshot = active as MerchantPolicySnapshot;
    (activeSnapshot as { policyVersion: string }).policyVersion = "tampered";
    (activeSnapshot.policy as { amountCeilingCents: number }).amountCeilingCents = 2;

    const byVersion = await repository.readByVersion(
      DEV_POLICY_MERCHANT_ID,
      "duelogic-default-v1",
    );
    check(byVersion !== null, "s5: the initial snapshot must be readable by version");
    const byVersionSnapshot = byVersion as MerchantPolicySnapshot;
    (byVersionSnapshot.policy.temporaryChange as { maxShiftDays: number }).maxShiftDays = 99;

    const listed = await repository.list(DEV_POLICY_MERCHANT_ID);
    listed.pop();
    (listed[0] as { installedAsInitialDefault: boolean }).installedAsInitialDefault = false;

    check(
      JSON.stringify(await repository.list(DEV_POLICY_MERCHANT_ID)) === before,
      "s5: no caller-side mutation may alter stored state",
    );
    const reread = await repository.readActive(DEV_POLICY_MERCHANT_ID);
    check(
      reread !== null &&
        reread.policyVersion === "duelogic-policy-v2" &&
        reread.policy.amountCeilingCents === 60_000,
      "s5: the active snapshot must retain its stored values",
    );
    record("s5-stored-snapshots-immutable", "immutable");
  }

  // s6: multiple activations create distinct sequential server-generated
  // versions, retain every earlier snapshot in order and leave only the
  // latest snapshot active.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    const activatedVersions: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const version = await generateNextDevPolicyVersion(repository);
      await repository.activate(
        laterSnapshot(
          version,
          clock(),
          laterPolicy(version, 60_000 + index * 1_000),
        ),
      );
      activatedVersions.push(version);
    }
    check(
      JSON.stringify(activatedVersions) ===
        JSON.stringify([
          "duelogic-policy-v2",
          "duelogic-policy-v3",
          "duelogic-policy-v4",
        ]),
      "s6: generated versions must be distinct and sequential",
    );
    const history = await repository.list(DEV_POLICY_MERCHANT_ID);
    check(history.length === 4, "s6: every earlier snapshot must be retained");
    check(
      JSON.stringify(history.map((entry) => entry.policyVersion)) ===
        JSON.stringify(["duelogic-default-v1", ...activatedVersions]),
      "s6: history must preserve activation order",
    );
    const active = await repository.readActive(DEV_POLICY_MERCHANT_ID);
    check(
      active !== null &&
        active.policyVersion === "duelogic-policy-v4" &&
        active.policy.amountCeilingCents === 62_000,
      "s6: only the latest activation may be active",
    );
    for (const version of ["duelogic-default-v1", ...activatedVersions]) {
      check(
        (await repository.readByVersion(DEV_POLICY_MERCHANT_ID, version)) !==
          null,
        `s6: snapshot ${version} must remain readable by version`,
      );
    }
    record("s6-multiple-activations-sequential", "append-only");
  }

  // s7: the merchant-safe view exposes the active projection and the full
  // ordered history, with no merchant ID, no complete policy object, no
  // fixed rule internals and no repository detail.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    await repository.activate(laterSnapshot("duelogic-policy-v2", clock()));
    const view = await buildMerchantPolicyView(
      repository,
      DEV_POLICY_MERCHANT_ID,
    );
    check(
      view.active !== null &&
        view.active.policyVersion === "duelogic-policy-v2" &&
        view.active.amountCeilingCents === 60_000,
      "s7: the view must expose the active snapshot projection",
    );
    check(
      view.history.length === 2 &&
        view.history[0].policyVersion === "duelogic-default-v1" &&
        view.history[1].policyVersion === "duelogic-policy-v2",
      "s7: the view history must preserve activation order",
    );
    const json = JSON.stringify(view);
    check(
      !json.includes(DEV_POLICY_MERCHANT_ID),
      "s7: the view must not contain the merchant ID",
    );
    check(
      !json.includes("temporaryChange") &&
        !json.includes("permanentChange") &&
        !json.includes("supportedCadences") &&
        !json.includes("arrears") &&
        !json.includes("\"policy\""),
      "s7: the view must not contain the complete policy object or fixed rule internals",
    );
    check(
      view.history.every((entry) => Object.keys(entry).length === 4),
      "s7: projections must carry exactly the four merchant-safe fields",
    );
    record("s7-merchant-safe-view", "safe");
  }

  // s8: a valid ceiling through the request path activates the next
  // server-generated immutable version; only policy.version,
  // amountCeilingCents and snapshot metadata differ from the fixed default
  // frame, and the initial default remains in history.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    const outcome = await processPolicyActivationRequest(
      { amountCeilingCents: 75_000 },
      { repository, merchantId: DEV_POLICY_MERCHANT_ID, now: clock },
    );
    check(outcome.ok, "s8: a valid ceiling must activate");
    const view = outcome.ok ? outcome.view : null;
    check(
      view !== null &&
        view.active !== null &&
        view.active.policyVersion === "duelogic-policy-v2" &&
        view.active.amountCeilingCents === 75_000 &&
        view.active.installedAsInitialDefault === false,
      "s8: the next server-generated version must become active",
    );
    const active = await repository.readActive(DEV_POLICY_MERCHANT_ID);
    check(
      active !== null &&
        JSON.stringify({
          ...active.policy,
          version: DEFAULT_DUELOGIC_POLICY.version,
          amountCeilingCents: DEFAULT_DUELOGIC_POLICY.amountCeilingCents,
        }) === JSON.stringify(DEFAULT_DUELOGIC_POLICY),
      "s8: only policy.version and amountCeilingCents may differ from the fixed default frame",
    );
    check(
      active !== null && active.policyVersion === active.policy.version,
      "s8: the snapshot metadata must stay version-consistent",
    );
    check(
      (await repository.readByVersion(
        DEV_POLICY_MERCHANT_ID,
        "duelogic-default-v1",
      )) !== null,
      "s8: the initial default must remain in history after activation",
    );
    record("s8-activation-request-creates-next-version", "activated");
  }

  // s9: unknown keys — including browser-supplied policyVersion, version,
  // merchantId, activatedAt, installedAsInitialDefault and fixed policy
  // fields — and non-object bodies are rejected without a repository write.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    const before = JSON.stringify(await repository.list(DEV_POLICY_MERCHANT_ID));
    const rejectedInputs: unknown[] = [
      { amountCeilingCents: 75_000, policyVersion: "duelogic-policy-v9" },
      { amountCeilingCents: 75_000, version: "duelogic-policy-v9" },
      { amountCeilingCents: 75_000, merchantId: "mch_other" },
      { amountCeilingCents: 75_000, activatedAt: "2026-01-01T00:00:00.000Z" },
      { amountCeilingCents: 75_000, installedAsInitialDefault: true },
      { amountCeilingCents: 75_000, temporaryChange: { maxShiftDays: 30 } },
      { amountCeilingCents: 75_000, arrears: { action: "approve" } },
      {},
      "75000",
      75_000,
      null,
      [75_000],
    ];
    for (const input of rejectedInputs) {
      const outcome = await processPolicyActivationRequest(input, {
        repository,
        merchantId: DEV_POLICY_MERCHANT_ID,
        now: clock,
      });
      check(
        !outcome.ok && outcome.stage === "validation",
        "s9: browser-supplied identity, fixed fields and unknown keys must be rejected",
      );
    }
    check(
      JSON.stringify(await repository.list(DEV_POLICY_MERCHANT_ID)) === before,
      "s9: rejected inputs must not change the repository",
    );
    record("s9-browser-identity-and-unknown-keys-rejected", "rejected");
  }

  // s10: invalid ceiling values — missing, boolean, string, decimal, zero,
  // negative and unsafe numbers — are rejected without changing history.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    const before = JSON.stringify(await repository.list(DEV_POLICY_MERCHANT_ID));
    const invalidCeilings: unknown[] = [
      undefined,
      true,
      false,
      "50000",
      500.5,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      null,
    ];
    for (const value of invalidCeilings) {
      const outcome = await processPolicyActivationRequest(
        { amountCeilingCents: value },
        { repository, merchantId: DEV_POLICY_MERCHANT_ID, now: clock },
      );
      check(
        !outcome.ok && outcome.stage === "validation",
        "s10: an invalid ceiling value must be rejected",
      );
    }
    check(
      JSON.stringify(await repository.list(DEV_POLICY_MERCHANT_ID)) === before,
      "s10: rejected ceiling values must not change the repository",
    );
    record("s10-invalid-ceilings-rejected", "rejected-unchanged");
  }

  // s11: consecutive request-path activations create sequential
  // server-generated versions and preserve every earlier snapshot.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    const versions: string[] = [];
    for (const ceiling of [60_000, 70_000, 80_000]) {
      const outcome = await processPolicyActivationRequest(
        { amountCeilingCents: ceiling },
        { repository, merchantId: DEV_POLICY_MERCHANT_ID, now: clock },
      );
      check(outcome.ok, "s11: each valid activation must succeed");
      if (outcome.ok && outcome.view.active !== null) {
        versions.push(outcome.view.active.policyVersion);
      }
    }
    check(
      JSON.stringify(versions) ===
        JSON.stringify([
          "duelogic-policy-v2",
          "duelogic-policy-v3",
          "duelogic-policy-v4",
        ]),
      "s11: consecutive activations must create sequential versions",
    );
    const history = await repository.list(DEV_POLICY_MERCHANT_ID);
    check(
      history.length === 4 &&
        JSON.stringify(history.map((entry) => entry.policy.amountCeilingCents)) ===
          JSON.stringify([
            DEFAULT_DUELOGIC_POLICY.amountCeilingCents,
            60_000,
            70_000,
            80_000,
          ]),
      "s11: every earlier snapshot must be preserved with its own ceiling",
    );
    record("s11-consecutive-activations-sequential", "sequential");
  }

  // s12: mutating the returned safe view never changes stored state.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    const outcome = await processPolicyActivationRequest(
      { amountCeilingCents: 75_000 },
      { repository, merchantId: DEV_POLICY_MERCHANT_ID, now: clock },
    );
    check(outcome.ok, "s12: the fixture activation must succeed");
    const storedBefore = JSON.stringify(
      await repository.list(DEV_POLICY_MERCHANT_ID),
    );
    const view = await buildMerchantPolicyView(
      repository,
      DEV_POLICY_MERCHANT_ID,
    );
    check(view.active !== null, "s12: the view must expose an active snapshot");
    (view.active as { amountCeilingCents: number }).amountCeilingCents = 1;
    (view.history[0] as { policyVersion: string }).policyVersion = "tampered";
    view.history.pop();
    check(
      JSON.stringify(await repository.list(DEV_POLICY_MERCHANT_ID)) ===
        storedBefore,
      "s12: mutating the returned view must not alter stored state",
    );
    const reread = await buildMerchantPolicyView(
      repository,
      DEV_POLICY_MERCHANT_ID,
    );
    check(
      reread.active !== null &&
        reread.active.policyVersion === "duelogic-policy-v2" &&
        reread.active.amountCeilingCents === 75_000 &&
        reread.history.length === 2 &&
        reread.history[0].policyVersion === "duelogic-default-v1",
      "s12: a fresh view must show the untouched stored state",
    );
    record("s12-safe-view-immutable", "immutable");
  }

  // s13: no policy consumer changed in this stage — after an activation,
  // the frozen seed policy evaluations (the source of the replay,
  // opportunity and intervention figures) still carry the default policy
  // version.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    const outcome = await processPolicyActivationRequest(
      { amountCeilingCents: 90_000 },
      { repository, merchantId: DEV_POLICY_MERCHANT_ID, now: clock },
    );
    check(outcome.ok, "s13: the fixture activation must succeed");
    const { policyItems } = buildSeedPolicyEvaluations();
    check(
      policyItems.length > 0 &&
        policyItems.every(
          (item) =>
            item.decision.policyVersion === DEFAULT_DUELOGIC_POLICY.version,
        ),
      "s13: the frozen policy consumers must still evaluate under the default policy version",
    );
    record("s13-consumers-remain-frozen", "frozen");
  }

  // s14: the no-argument replay builder still evaluates under
  // DEFAULT_DUELOGIC_POLICY, stamps duelogic-default-v1, and behaves
  // exactly as an explicit frozen-default call.
  {
    const noArg = buildSeedPolicyEvaluations();
    check(
      noArg.policyItems.length > 0 &&
        noArg.policyItems.every(
          (item) =>
            item.decision.policyVersion === DEFAULT_DUELOGIC_POLICY.version,
        ),
      "s14: the no-argument builder must stamp duelogic-default-v1",
    );
    const explicit = buildSeedPolicyEvaluations(DEFAULT_DUELOGIC_POLICY);
    check(
      JSON.stringify(noArg) === JSON.stringify(explicit),
      "s14: the no-argument builder must equal the explicit frozen-default call",
    );
    record("s14-no-argument-builder-frozen-default", "frozen-default");
  }

  // s15: an activated snapshot's complete policy drives the replay, and
  // every returned decision is stamped with the activated policyVersion.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    const outcome = await processPolicyActivationRequest(
      { amountCeilingCents: 20_000 },
      { repository, merchantId: DEV_POLICY_MERCHANT_ID, now: clock },
    );
    check(outcome.ok, "s15: the fixture activation must succeed");
    const active = await repository.readActive(DEV_POLICY_MERCHANT_ID);
    check(active !== null, "s15: the activated snapshot must be readable");
    const evaluations = buildSeedPolicyEvaluations(
      (active as MerchantPolicySnapshot).policy,
    );
    check(
      evaluations.policyItems.length > 0 &&
        evaluations.policyItems.every(
          (item) => item.decision.policyVersion === "duelogic-policy-v2",
        ),
      "s15: every replay decision must be stamped with the activated policyVersion",
    );
    record("s15-replay-uses-activated-policy", "adopted");
  }

  // s16: a lower active ceiling ($200.00) changes the relevant replay
  // decision through the existing deterministic engine — payer-02's
  // $249.50 case escalates, the designated payer-01 opportunity stays
  // approved — while the detector output and seed requests are unchanged.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    await processPolicyActivationRequest(
      { amountCeilingCents: 20_000 },
      { repository, merchantId: DEV_POLICY_MERCHANT_ID, now: clock },
    );
    const active = await repository.readActive(DEV_POLICY_MERCHANT_ID);
    const defaults = buildSeedPolicyEvaluations();
    const lowered = buildSeedPolicyEvaluations(
      (active as MerchantPolicySnapshot).policy,
    );
    check(
      JSON.stringify(lowered.flags) === JSON.stringify(defaults.flags),
      "s16: the detector output must be identical under both policies",
    );
    check(
      JSON.stringify(lowered.policyItems.map((item) => item.request)) ===
        JSON.stringify(defaults.policyItems.map((item) => item.request)),
      "s16: the evaluated seed requests must be unchanged",
    );
    const defaultPayer02 = defaults.policyItems.find(
      (item) => item.request.payerId === "payer-02",
    );
    const loweredPayer02 = lowered.policyItems.find(
      (item) => item.request.payerId === "payer-02",
    );
    const loweredPayer01 = lowered.policyItems.find(
      (item) => item.request.payerId === "payer-01",
    );
    check(
      defaultPayer02 !== undefined &&
        defaultPayer02.decision.outcome === "approved",
      "s16: payer-02 must be approved under the default ceiling",
    );
    check(
      loweredPayer02 !== undefined &&
        loweredPayer02.decision.outcome === "escalate" &&
        loweredPayer02.decision.reasonCode === "AMOUNT_CEILING_EXCEEDED" &&
        loweredPayer02.decision.ruleFired === "amountCeilingCents",
      "s16: the $200.00 ceiling must escalate payer-02 through the existing engine rule",
    );
    check(
      loweredPayer01 !== undefined &&
        loweredPayer01.decision.outcome === "approved",
      "s16: the designated payer-01 opportunity must remain approved",
    );
    record("s16-lower-ceiling-changes-decisions", "recalculated");
  }

  // s17: merchant opportunity figures derive from the same active-policy
  // replay evaluations and change consistently with those decisions.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    await processPolicyActivationRequest(
      { amountCeilingCents: 20_000 },
      { repository, merchantId: DEV_POLICY_MERCHANT_ID, now: clock },
    );
    const active = await repository.readActive(DEV_POLICY_MERCHANT_ID);
    const defaults = buildSeedPolicyEvaluations();
    const lowered = buildSeedPolicyEvaluations(
      (active as MerchantPolicySnapshot).policy,
    );
    const defaultOpportunity = calculateMerchantOpportunity({
      payers: seedPayers,
      flags: defaults.flags,
      evaluations: toOpportunityEvaluations(defaults),
    });
    const loweredOpportunity = calculateMerchantOpportunity({
      payers: seedPayers,
      flags: lowered.flags,
      evaluations: toOpportunityEvaluations(lowered),
    });
    check(
      defaultOpportunity.outcome === "calculated" &&
        defaultOpportunity.metrics.approvedInterventionCount === 2 &&
        defaultOpportunity.metrics.eligibleAmountCents === 37_850,
      "s17: the frozen-default figures must be 2 approved and 37850 cents",
    );
    check(
      loweredOpportunity.outcome === "calculated" &&
        loweredOpportunity.metrics.approvedInterventionCount === 1 &&
        loweredOpportunity.metrics.eligibleAmountCents === 12_900 &&
        loweredOpportunity.rows.length === 2,
      "s17: the $200.00 figures must drop to 1 approved and 12900 cents with both rows visible",
    );
    const escalatedRow =
      loweredOpportunity.outcome === "calculated"
        ? loweredOpportunity.rows.find((row) => row.payerId === "payer-02")
        : undefined;
    const approvedRow =
      loweredOpportunity.outcome === "calculated"
        ? loweredOpportunity.rows.find((row) => row.payerId === "payer-01")
        : undefined;
    check(
      escalatedRow !== undefined &&
        escalatedRow.policyOutcome === "escalate" &&
        !escalatedRow.approvedForReview &&
        approvedRow !== undefined &&
        approvedRow.approvedForReview,
      "s17: the rows must restate the recalculated decisions consistently",
    );
    record("s17-opportunity-follows-replay", "consistent");
  }

  // s18: the opportunity result and every replay decision identify the
  // same governing policy version through the data passed to the panels
  // (the safe view's active projection and the decisions themselves).
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    await processPolicyActivationRequest(
      { amountCeilingCents: 20_000 },
      { repository, merchantId: DEV_POLICY_MERCHANT_ID, now: clock },
    );
    const view = await buildMerchantPolicyView(
      repository,
      DEV_POLICY_MERCHANT_ID,
    );
    const active = await repository.readActive(DEV_POLICY_MERCHANT_ID);
    check(
      view.active !== null &&
        active !== null &&
        view.active.policyVersion === "duelogic-policy-v2",
      "s18: the panel projection must carry the activated version",
    );
    const governingVersion = view.active === null ? "" : view.active.policyVersion;
    const evaluations = buildSeedPolicyEvaluations(
      (active as MerchantPolicySnapshot).policy,
    );
    check(
      evaluations.policyItems.every(
        (item) => item.decision.policyVersion === governingVersion,
      ),
      "s18: every replay decision must carry the version passed to the panels",
    );
    const opportunity = calculateMerchantOpportunity({
      payers: seedPayers,
      flags: evaluations.flags,
      evaluations: toOpportunityEvaluations(evaluations),
    });
    check(
      opportunity.outcome === "calculated" &&
        evaluations.policyItems.every((item) => {
          const row = opportunity.rows.find(
            (candidate) => candidate.payerId === item.request.payerId,
          );
          return (
            row !== undefined &&
            row.policyOutcome === item.decision.outcome &&
            row.reasonCode === item.decision.reasonCode
          );
        }),
      "s18: the opportunity rows must restate the same governed decisions",
    );
    record("s18-one-governing-version", "aligned");
  }

  // s19: activating a further policy updates the replay and opportunity
  // inputs while the seed, the detector and the aggregation logic stay
  // unchanged — a $300.00 ceiling restores both approvals.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    const deps = {
      repository,
      merchantId: DEV_POLICY_MERCHANT_ID,
      now: clock,
    };
    await processPolicyActivationRequest({ amountCeilingCents: 20_000 }, deps);
    const second = await processPolicyActivationRequest(
      { amountCeilingCents: 30_000 },
      deps,
    );
    check(second.ok, "s19: the second activation must succeed");
    const active = await repository.readActive(DEV_POLICY_MERCHANT_ID);
    const defaults = buildSeedPolicyEvaluations();
    const latest = buildSeedPolicyEvaluations(
      (active as MerchantPolicySnapshot).policy,
    );
    check(
      JSON.stringify(latest.flags) === JSON.stringify(defaults.flags) &&
        JSON.stringify(latest.policyItems.map((item) => item.request)) ===
          JSON.stringify(defaults.policyItems.map((item) => item.request)),
      "s19: the seed and detector inputs must be unchanged across activations",
    );
    check(
      latest.policyItems.every(
        (item) => item.decision.policyVersion === "duelogic-policy-v3",
      ),
      "s19: the replay must follow the newest activated version",
    );
    const first = calculateMerchantOpportunity({
      payers: seedPayers,
      flags: latest.flags,
      evaluations: toOpportunityEvaluations(latest),
    });
    const repeat = calculateMerchantOpportunity({
      payers: seedPayers,
      flags: latest.flags,
      evaluations: toOpportunityEvaluations(latest),
    });
    check(
      JSON.stringify(first) === JSON.stringify(repeat),
      "s19: the opportunity aggregation must be deterministic and unchanged",
    );
    check(
      first.outcome === "calculated" &&
        first.metrics.approvedInterventionCount === 2 &&
        first.metrics.eligibleAmountCents === 37_850,
      "s19: the $300.00 ceiling must restore both approvals through the same aggregation",
    );
    record("s19-new-activation-updates-inputs-only", "updated");
  }

  // s20: no scheduled intervention or customer evaluation consumer is
  // switched in this stage — the no-argument builder path those flows use
  // still produces frozen-default approved decisions after an activation.
  {
    const clock = makeClock();
    const repository = await installedRepository(clock);
    await processPolicyActivationRequest(
      { amountCeilingCents: 20_000 },
      { repository, merchantId: DEV_POLICY_MERCHANT_ID, now: clock },
    );
    const frozen = buildSeedPolicyEvaluations();
    check(
      frozen.policyItems.length > 0 &&
        frozen.policyItems.every(
          (item) =>
            item.decision.policyVersion === DEFAULT_DUELOGIC_POLICY.version &&
            item.decision.outcome === "approved",
        ),
      "s20: the no-argument path used by the scan and customer evaluation must stay frozen-default",
    );
    record("s20-intervention-and-customer-paths-frozen", "frozen");
  }

  check(table.length === 20, `expected 20 scenarios, produced ${table.length}`);
  return { scenarioCount: table.length, decisionTable: table };
}

// ---------------------------------------------------------------------------
// Module-load kick-off, mirroring the intervention validation: one full
// async pass whose failure is logged loudly; the dashboard render
// re-asserts the table on every request.

void validatePolicySnapshotFoundation().catch((error: unknown) => {
  console.error("Policy snapshot validation failed at module load.", {
    errorClass: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  });
});
