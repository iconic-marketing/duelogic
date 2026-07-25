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
 */

import type { DueLogicPolicy } from "../schema";
import {
  createInMemoryMerchantPolicyRepository,
  DEV_POLICY_MERCHANT_ID,
  generateNextDevPolicyVersion,
  installInitialDefaultPolicySnapshot,
} from "./dev-policy-store";
import { PolicyValidationError } from "./engine";
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

  check(table.length === 6, `expected 6 scenarios, produced ${table.length}`);
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
