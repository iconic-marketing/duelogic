/**
 * Development-only simulated SMS delivery channel for the barebones OTP
 * demo path: a separate process-local message store rendered by the
 * localhost-only page /dev/duelogic/sms.
 *
 * CHANNEL SEPARATION IS THE POINT: the review link lives only in the
 * invitation inbox (/dev/duelogic/inbox); the OTP code lives only here.
 * The SMS body may therefore contain the plaintext code — this store IS
 * the simulated second channel — but it must never carry the review
 * token, a review URL, a complete mobile number or any payer, source,
 * subscription or internal identifier. `send` enforces that with a
 * forbidden-content check.
 *
 * NON-DURABLE SANDBOX STORAGE: messages live in process memory, backed by
 * `globalThis` (hot reloads keep them, restarts do not). A production SMS
 * provider later replaces this adapter behind the same interface without
 * changing any OTP verification logic.
 */

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts.
if (typeof window !== "undefined") {
  throw new Error(
    "The dev SMS store is server-only and must not be imported into browser code.",
  );
}

/** Oldest messages are dropped beyond this cap. */
const MAX_MESSAGES = 100;

export interface DevSmsMessage {
  readonly smsId: string;
  readonly interventionId: string;
  /** Display value only — at most the last three digits are visible. */
  readonly maskedRecipient: string;
  /** The simulated SMS text. May contain the plaintext OTP by design. */
  readonly body: string;
  /** ISO timestamp. */
  readonly sentAt: string;
}

/**
 * Delivery boundary the OTP service depends on. The development
 * implementation stores messages for the dev SMS inbox; a production SMS
 * provider implements `send` against a real gateway later.
 */
export interface DevSmsDeliveryAdapter {
  send(message: DevSmsMessage): Promise<void>;
  /** Insertion order; callers render newest first. */
  list(): Promise<DevSmsMessage[]>;
}

/**
 * Content the simulated SMS body must never carry: review links, tokens,
 * internal identifiers, or anything shaped like a complete Australian
 * mobile number (the recipient appears masked only).
 */
const FORBIDDEN_BODY_PATTERN =
  /\/review\/|\/confirm\/|token|pyr_|src_|sub_|mch_|pln_|int_|ntf_|conf_|ver_|otpch_|(?:\+?61|0)4\d{8}/i;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

type SmsMap = Map<string, DevSmsMessage>;

/**
 * Creates a fresh, isolated in-memory SMS adapter. Messages are cloned on
 * write and on read, so stored state can never be mutated through a
 * caller-held object.
 */
export function createInMemoryDevSmsStore(
  messages: SmsMap = new Map(),
): DevSmsDeliveryAdapter {
  return {
    async send(message: DevSmsMessage): Promise<void> {
      if (
        !nonEmpty(message.smsId) ||
        !nonEmpty(message.interventionId) ||
        !nonEmpty(message.maskedRecipient) ||
        !nonEmpty(message.body) ||
        Number.isNaN(Date.parse(message.sentAt))
      ) {
        throw new Error("Dev SMS store refused an incomplete message.");
      }
      if (FORBIDDEN_BODY_PATTERN.test(message.body)) {
        // Never echo the offending content — the class of violation only.
        throw new Error(
          "Dev SMS store refused a message body carrying forbidden link, identifier or unmasked-mobile content.",
        );
      }
      messages.set(message.smsId, structuredClone(message));
      while (messages.size > MAX_MESSAGES) {
        const oldest = messages.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        messages.delete(oldest);
      }
    },
    async list(): Promise<DevSmsMessage[]> {
      return [...messages.values()].map((message) => structuredClone(message));
    },
  };
}

interface GlobalWithSmsStore {
  __duelogicDevSmsStore?: SmsMap;
}

/**
 * The shared development adapter used by the OTP request route and the
 * dev SMS inbox page: one in-memory map per process.
 */
export function getDevSmsStore(): DevSmsDeliveryAdapter {
  const holder = globalThis as GlobalWithSmsStore;
  holder.__duelogicDevSmsStore ??= new Map();
  return createInMemoryDevSmsStore(holder.__duelogicDevSmsStore);
}

/** Reset helper for controlled development or validation use only. */
export function clearDevSmsStore(): void {
  const holder = globalThis as GlobalWithSmsStore;
  holder.__duelogicDevSmsStore?.clear();
}

/**
 * Development-store-only targeted deletion for demo preparation: removes
 * the messages belonging to exactly the named interventions (the safe
 * tracked linkage — the manifest records the demo intervention IDs) and
 * nothing else. Unrelated messages remain untouched. Defaults to the
 * shared development map; validation passes its own isolated map.
 */
export function deleteSmsMessagesForInterventions(
  interventionIds: readonly string[],
  messages?: SmsMap,
): number {
  const holder = globalThis as GlobalWithSmsStore;
  const target = messages ?? (holder.__duelogicDevSmsStore ??= new Map());
  const wanted = new Set(interventionIds);
  let deleted = 0;
  for (const [key, message] of [...target.entries()]) {
    if (wanted.has(message.interventionId)) {
      target.delete(key);
      deleted += 1;
    }
  }
  return deleted;
}
