/**
 * Development-only OTP challenge store for the barebones demo path,
 * following the established dev-store pattern
 * (src/lib/duelogic/dev-transaction-verification-store.ts).
 *
 * NON-DURABLE SANDBOX STORAGE: challenges live in process memory, backed
 * by `globalThis` so `next dev` hot reloads keep them, but they do NOT
 * survive a process restart.
 *
 * Barebones contract (tonight's demo MVP):
 * - one live challenge per intervention: `issue` REPLACES any previous
 *   challenge for the intervention, so a replaced code can never verify
 *   (its digest is domain-separated by the discarded challengeId);
 * - `verify` is atomic within the single-threaded event loop: no await
 *   sits between reading and consuming, a wrong code refuses WITHOUT
 *   marking anything, and a correct code sets verifiedAt exactly once —
 *   a second use refuses as already-used;
 * - the plaintext code is never stored: the record carries only the
 *   HMAC digest, and `issue` refuses any record carrying code/token/
 *   secret material under a forbidden key.
 *
 * Deliberately absent tonight (documented polishing-week work): failed-
 * attempt limits, resend delay, maximum issue counts and durable storage.
 */

import {
  evaluateOtpChallenge,
  otpDigestsEqual,
  type OtpChallengeExpectation,
  type OtpChallengeRecord,
} from "./otp-challenge";

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts.
if (typeof window !== "undefined") {
  throw new Error(
    "The dev OTP challenge store is server-only and must not be imported into browser code.",
  );
}

type ChallengeMap = Map<string, OtpChallengeRecord>;

export type OtpChallengeVerifyOutcome =
  | { ok: true; challenge: OtpChallengeRecord }
  | {
      ok: false;
      reason:
        | "missing"
        | "invalid"
        | "invalidated"
        | "already-used"
        | "expired"
        | "mismatch"
        | "incorrect"
        | "store";
    };

/**
 * Storage boundary for OTP challenges. One live challenge per
 * intervention; `verify` performs the complete atomic read-evaluate-
 * compare-consume operation, taking a synchronous digest callback so the
 * caller's HMAC computation happens inside the atomic section without
 * this store ever seeing the secret or the plaintext code.
 */
export interface OtpChallengeRepository {
  /** Write-and-replace: any previous challenge for the intervention is discarded. */
  issue(record: OtpChallengeRecord): Promise<void>;
  readCurrent(interventionId: string): Promise<OtpChallengeRecord | null>;
  verify(
    interventionId: string,
    expectation: OtpChallengeExpectation,
    nowIso: string,
    digestForChallenge: (challengeId: string) => string,
  ): Promise<OtpChallengeVerifyOutcome>;
}

/** Key names that must never appear in a stored challenge. `codeDigest` is the schema's own digest field and is allowed. */
const FORBIDDEN_CHALLENGE_KEY_PATTERN =
  /^code$|plaintext|token|secret|password|verificationid/i;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Structural validity of a challenge before it may be stored, branched by
 * movement kind (records without a kind are the permanent shape from
 * before the discriminated model).
 */
function challengeDefect(record: OtpChallengeRecord): string | null {
  for (const key of Object.keys(record)) {
    if (key !== "codeDigest" && FORBIDDEN_CHALLENGE_KEY_PATTERN.test(key)) {
      return key;
    }
  }
  const sharedFields: Array<[string, unknown]> = [
    ["challengeId", record.challengeId],
    ["interventionId", record.interventionId],
    ["merchantId", record.merchantId],
    ["payerId", record.payerId],
    ["policyVersion", record.policyVersion],
    ["trustedMobileFingerprint", record.trustedMobileFingerprint],
    ["maskedMobile", record.maskedMobile],
    ["codeDigest", record.codeDigest],
  ];
  for (const [field, value] of sharedFields) {
    if (!nonEmpty(value)) {
      return field;
    }
  }
  const issuedAt = Date.parse(record.issuedAt);
  const expiresAt = Date.parse(record.expiresAt);
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt) || expiresAt <= issuedAt) {
    return "timestamps";
  }
  if (record.verifiedAt !== null || record.invalidatedAt !== null) {
    return "lifecycle";
  }

  if (record.kind === "temporary") {
    if (!nonEmpty(record.paymentId)) {
      return "paymentId";
    }
    if (
      !nonEmpty(record.originalTransactionDate) ||
      !nonEmpty(record.proposedTransactionDate)
    ) {
      return "transactionDates";
    }
    if (!Number.isInteger(record.amountInCents) || record.amountInCents <= 0) {
      return "amountInCents";
    }
    return null;
  }

  if (!nonEmpty(record.subscriptionId) || !nonEmpty(record.selectedDate)) {
    return "subscription";
  }
  const schedulesValid = [record.currentPayments, record.proposedPayments].every(
    (payments) =>
      Array.isArray(payments) &&
      payments.length === 3 &&
      payments.every(
        (payment) =>
          nonEmpty(payment.paymentDate) &&
          Number.isInteger(payment.amountInCents) &&
          payment.amountInCents > 0,
      ),
  );
  return schedulesValid ? null : "payments";
}

/**
 * Creates a fresh, isolated in-memory challenge repository. Every read
 * and write passes through structuredClone, so no caller ever holds a
 * mutable reference to stored state.
 */
export function createInMemoryOtpChallengeRepository(
  challenges: ChallengeMap = new Map(),
): OtpChallengeRepository {
  return {
    async issue(record: OtpChallengeRecord): Promise<void> {
      const defect = challengeDefect(record);
      if (defect !== null) {
        // The defect name is generic schema vocabulary, never a value.
        throw new Error(
          `OTP challenge store refused an invalid record (field "${defect}").`,
        );
      }
      // Replace-on-issue: the previous challenge for this intervention is
      // discarded, so its code can never verify again (barebones stand-in
      // for explicit invalidation bookkeeping).
      challenges.set(record.interventionId, structuredClone(record));
      const readBack = challenges.get(record.interventionId);
      if (
        readBack === undefined ||
        JSON.stringify(readBack) !== JSON.stringify(record)
      ) {
        throw new Error(
          "OTP challenge store could not read the challenge back after writing.",
        );
      }
    },

    async readCurrent(
      interventionId: string,
    ): Promise<OtpChallengeRecord | null> {
      const record = challenges.get(interventionId.trim());
      return record === undefined ? null : structuredClone(record);
    },

    // Atomic within the single-threaded event loop: NO await may ever
    // appear between the read and the consuming write below. A wrong code
    // refuses without changing state; a correct code sets verifiedAt
    // exactly once and a second use refuses as already-used.
    async verify(interventionId, expectation, nowIso, digestForChallenge) {
      const stored = challenges.get(interventionId.trim());
      if (stored === undefined) {
        return { ok: false, reason: "missing" };
      }
      const evaluation = evaluateOtpChallenge(
        structuredClone(stored),
        expectation,
        nowIso,
      );
      if (!evaluation.ok) {
        return { ok: false, reason: evaluation.reason };
      }
      const suppliedDigest = digestForChallenge(stored.challengeId);
      if (!otpDigestsEqual(stored.codeDigest, suppliedDigest)) {
        return { ok: false, reason: "incorrect" };
      }
      const verified: OtpChallengeRecord = {
        ...structuredClone(stored),
        verifiedAt: nowIso,
      };
      challenges.set(verified.interventionId, structuredClone(verified));
      const readBack = challenges.get(verified.interventionId);
      if (readBack === undefined || readBack.verifiedAt !== nowIso) {
        return { ok: false, reason: "store" };
      }
      return { ok: true, challenge: structuredClone(verified) };
    },
  };
}

interface GlobalWithOtpStore {
  __duelogicDevOtpChallengeStore?: ChallengeMap;
}

/**
 * The shared development repository used by the OTP routes: one in-memory
 * map per process, surviving hot reloads but not restarts.
 */
export function getDevOtpChallengeRepository(): OtpChallengeRepository {
  const holder = globalThis as GlobalWithOtpStore;
  holder.__duelogicDevOtpChallengeStore ??= new Map();
  return createInMemoryOtpChallengeRepository(
    holder.__duelogicDevOtpChallengeStore,
  );
}

/** Reset helper for controlled development or validation use only. */
export function clearDevOtpChallengeStore(): void {
  const holder = globalThis as GlobalWithOtpStore;
  holder.__duelogicDevOtpChallengeStore?.clear();
}
