/**
 * OTP challenge model and pure helpers for the barebones DueLogic customer
 * verification demo path (hackathon MVP).
 *
 * BAREBONES SCOPE, BY EXPLICIT DECISION: no failed-attempt limit, no resend
 * delay and no maximum issue count exist tonight — requesting another code
 * simply replaces the intervention's previous challenge, and the replaced
 * code must no longer verify. The full approved OTP control set (attempt
 * limits, resend delay, issue caps, rate limiting, production SMS delivery,
 * durable persistence) remains documented polishing-week work.
 *
 * The plaintext code is NEVER stored: the challenge holds only an
 * HMAC-SHA256 digest keyed by the DUELOGIC_OTP_HMAC_SECRET environment
 * value, domain-separated per challenge, and the trusted mobile appears
 * only as a keyed fingerprint plus a masked display value (at most the
 * last three digits). Digest comparison is timing-safe.
 *
 * Pure data and deterministic functions only — no clock reads, no storage,
 * no Pinch, no randomness and no environment access (the secret is always
 * a parameter, resolved by the caller at request execution time).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  confirmedPaymentsEqual,
  type ConfirmedSchedulePayment,
} from "@/lib/pinch/customer-confirmation";

/** Exactly six numeric digits, leading zeroes preserved. */
export const OTP_CODE_LENGTH = 6;

/** A challenge (and therefore its code) lasts five minutes. */
export const OTP_CHALLENGE_LIFETIME_MINUTES = 5;

/** Domain-separation prefixes: never reuse these HMAC inputs elsewhere. */
const OTP_CODE_DIGEST_CONTEXT = "duelogic-otp-code:v1";
const OTP_MOBILE_FINGERPRINT_CONTEXT = "duelogic-otp-mobile:v1";

/**
 * One immutable OTP challenge, bound to the exact intervention state the
 * customer saw when the code was requested. Deliberately absent: the
 * plaintext code, the complete mobile number, the review token and any
 * verificationId — none of those may ever live here.
 */
export interface OtpChallengeRecord {
  readonly challengeId: string;
  readonly interventionId: string;
  readonly merchantId: string;
  readonly payerId: string;
  readonly subscriptionId: string;
  /** YYYY-MM-DD: the approved selected date this challenge covers. */
  readonly selectedDate: string;
  readonly currentPayments: readonly ConfirmedSchedulePayment[];
  readonly proposedPayments: readonly ConfirmedSchedulePayment[];
  readonly policyVersion: string;
  /** HMAC-SHA256 fingerprint of the normalised trusted mobile. */
  readonly trustedMobileFingerprint: string;
  /** Display value only — at most the last three digits are visible. */
  readonly maskedMobile: string;
  /** HMAC-SHA256 digest of the code; the plaintext is never stored. */
  readonly codeDigest: string;
  /** ISO timestamps. */
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly verifiedAt: string | null;
  readonly invalidatedAt: string | null;
}

/**
 * The server-held values a usable challenge must still bind exactly at
 * verification time — the transaction-verification expectation plus the
 * trusted-mobile fingerprint. Any change to the intervention's selected
 * date, schedules, policy binding or the payer's trusted mobile makes the
 * outstanding challenge unusable.
 */
export interface OtpChallengeExpectation {
  interventionId: string;
  merchantId: string;
  payerId: string;
  subscriptionId: string;
  selectedDate: string;
  currentPayments: readonly ConfirmedSchedulePayment[];
  proposedPayments: readonly ConfirmedSchedulePayment[];
  policyVersion: string;
  trustedMobileFingerprint: string;
}

export type OtpChallengeEvaluation =
  | { ok: true }
  | {
      ok: false;
      reason: "invalid" | "invalidated" | "already-used" | "expired" | "mismatch";
    };

/**
 * Formats a generated code number as exactly six digits, preserving
 * leading zeroes. Returns null for anything outside 0..999999 — the
 * caller must fail closed, never truncate or pad an invalid value.
 */
export function formatOtpCode(codeNumber: number): string | null {
  if (
    !Number.isInteger(codeNumber) ||
    codeNumber < 0 ||
    codeNumber > 999_999
  ) {
    return null;
  }
  return String(codeNumber).padStart(OTP_CODE_LENGTH, "0");
}

/**
 * Normalises an Australian mobile to E.164. Accepts the 04xxxxxxxx local
 * form (and an already-normalised +614xxxxxxxx / 614xxxxxxxx), stripping
 * spaces, hyphens and parentheses. Anything else is rejected — never
 * guessed into a deliverable number.
 */
export function normaliseAustralianMobile(raw: string): string | null {
  const compact = raw.replace(/[\s()-]/g, "");
  if (/^04\d{8}$/.test(compact)) {
    return `+61${compact.slice(1)}`;
  }
  if (/^\+614\d{8}$/.test(compact)) {
    return compact;
  }
  if (/^614\d{8}$/.test(compact)) {
    return `+${compact}`;
  }
  return null;
}

/** Customer-facing mask: at most the last three digits are visible. */
export function maskNormalisedMobile(normalisedMobile: string): string {
  return `•••• ••• ${normalisedMobile.slice(-3)}`;
}

/** HMAC-SHA256 hex digest of one code, domain-separated per challenge. */
export function computeOtpCodeDigest(
  secret: string,
  challengeId: string,
  code: string,
): string {
  return createHmac("sha256", secret)
    .update(`${OTP_CODE_DIGEST_CONTEXT}:${challengeId}:${code}`, "utf8")
    .digest("hex");
}

/** HMAC-SHA256 hex fingerprint of the normalised trusted mobile. */
export function computeTrustedMobileFingerprint(
  secret: string,
  normalisedMobile: string,
): string {
  return createHmac("sha256", secret)
    .update(`${OTP_MOBILE_FINGERPRINT_CONTEXT}:${normalisedMobile}`, "utf8")
    .digest("hex");
}

/** Timing-safe comparison of two hex digests; length mismatch refuses. */
export function otpDigestsEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Pure usability evaluation of a stored challenge against the current
 * server-held expectation: not invalidated, not already used, unexpired
 * (against the supplied clock value — client time is never authoritative)
 * and bound exactly to the current intervention state and trusted-mobile
 * fingerprint. Any deviation refuses. Never reads a clock, never compares
 * code digests — the repository performs the timing-safe code comparison.
 */
export function evaluateOtpChallenge(
  challenge: OtpChallengeRecord,
  expected: OtpChallengeExpectation,
  nowIso: string,
): OtpChallengeEvaluation {
  if (challenge.invalidatedAt !== null) {
    return { ok: false, reason: "invalidated" };
  }
  if (challenge.verifiedAt !== null) {
    return { ok: false, reason: "already-used" };
  }
  const now = Date.parse(nowIso);
  const issuedAt = Date.parse(challenge.issuedAt);
  const expiresAt = Date.parse(challenge.expiresAt);
  if (
    Number.isNaN(now) ||
    Number.isNaN(issuedAt) ||
    Number.isNaN(expiresAt) ||
    challenge.challengeId.trim() === "" ||
    challenge.codeDigest.trim() === ""
  ) {
    return { ok: false, reason: "invalid" };
  }
  if (now >= expiresAt) {
    return { ok: false, reason: "expired" };
  }
  const identityBindings: Array<[string, string]> = [
    [challenge.interventionId, expected.interventionId],
    [challenge.merchantId, expected.merchantId],
    [challenge.payerId, expected.payerId],
    [challenge.subscriptionId, expected.subscriptionId],
    [challenge.selectedDate, expected.selectedDate],
    [challenge.policyVersion, expected.policyVersion],
    [challenge.trustedMobileFingerprint, expected.trustedMobileFingerprint],
  ];
  for (const [recorded, required] of identityBindings) {
    if (recorded !== required || required.trim() === "") {
      return { ok: false, reason: "mismatch" };
    }
  }
  if (
    expected.currentPayments.length === 0 ||
    expected.proposedPayments.length === 0 ||
    !confirmedPaymentsEqual(challenge.currentPayments, expected.currentPayments) ||
    !confirmedPaymentsEqual(challenge.proposedPayments, expected.proposedPayments)
  ) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}
