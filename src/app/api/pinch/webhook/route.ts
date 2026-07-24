import { createHmac, timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Public Pinch webhook receiver.
 *
 * Verifies the `pinch-signature` header (t=<unix seconds>,v2=<hex HMAC>)
 * against the raw request body before any parsing: the signed value is
 * "<timestamp>.<raw body>", HMAC-SHA256 keyed with PINCH_WEBHOOK_SECRET,
 * compared as lowercase hex via a constant-time comparison. Events are
 * acknowledged only; nothing is stored yet.
 */

export const runtime = "nodejs";

const TIMESTAMP_TOLERANCE_SECONDS = 300;

interface ParsedSignatureHeader {
  timestamp: string;
  signatureHex: string;
}

function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: string | null = null;
  let signatureHex: string | null = null;

  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      return null;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (value === "") {
      return null;
    }
    if (key === "t") {
      if (timestamp !== null) {
        // Duplicate values are ambiguous; reject rather than pick one.
        return null;
      }
      timestamp = value;
    } else if (key === "v2") {
      if (signatureHex !== null) {
        return null;
      }
      signatureHex = value;
    }
    // Unknown keys (e.g. older scheme versions) are ignored, not errors.
  }

  if (timestamp === null || signatureHex === null) {
    return null;
  }
  return { timestamp, signatureHex };
}

function isFreshUnixTimestamp(timestamp: string): boolean {
  if (!/^\d{1,12}$/.test(timestamp)) {
    return false;
  }
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) {
    return false;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  return Math.abs(nowSeconds - seconds) <= TIMESTAMP_TOLERANCE_SECONDS;
}

function signatureMatches(
  secret: string,
  timestamp: string,
  rawBody: string,
  providedHex: string,
): boolean {
  const normalized = providedHex.toLowerCase();
  // A SHA-256 hex digest is exactly 64 hex characters; validating length and
  // format first guarantees timingSafeEqual receives equal-length buffers.
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    return false;
  }
  const expectedHex = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  return timingSafeEqual(
    Buffer.from(expectedHex, "hex"),
    Buffer.from(normalized, "hex"),
  );
}

interface VerifiedEvent {
  id: string;
  type: string;
  eventDate?: string;
  paymentIds: string[];
}

function collectPaymentIds(value: unknown, found: Set<string>, depth: number): void {
  if (depth > 8 || found.size >= 25) {
    return;
  }
  if (typeof value === "string") {
    if (value.startsWith("pmt_")) {
      found.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPaymentIds(item, found, depth + 1);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      collectPaymentIds(item, found, depth + 1);
    }
  }
}

/** Accepts PascalCase (documented) or camelCase top-level event fields. */
function parseEventEnvelope(rawBody: string): VerifiedEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const id = record.Id ?? record.id;
  const type = record.Type ?? record.type;
  const eventDate = record.EventDate ?? record.eventDate;

  if (typeof id !== "string" || id.trim() === "") {
    return null;
  }
  if (typeof type !== "string" || type.trim() === "") {
    return null;
  }

  const paymentIds = new Set<string>();
  collectPaymentIds(parsed, paymentIds, 0);

  const event: VerifiedEvent = {
    id: id.trim(),
    type: type.trim(),
    paymentIds: [...paymentIds],
  };
  if (typeof eventDate === "string" && eventDate.trim() !== "") {
    event.eventDate = eventDate.trim();
  }
  return event;
}

export async function POST(request: NextRequest) {
  // Read at request time so the production build never needs the secret.
  const secret = process.env.PINCH_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  // The raw body must be read before any JSON parsing: the signature covers
  // the exact bytes sent, and re-serialised JSON would not round-trip.
  const rawBody = await request.text();

  const signatureHeader = request.headers.get("pinch-signature");
  const parsedHeader =
    signatureHeader === null ? null : parseSignatureHeader(signatureHeader);

  if (
    parsedHeader === null ||
    !isFreshUnixTimestamp(parsedHeader.timestamp) ||
    !signatureMatches(
      secret,
      parsedHeader.timestamp,
      rawBody,
      parsedHeader.signatureHex,
    )
  ) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const event = parseEventEnvelope(rawBody);
  if (event === null) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  console.log("Pinch webhook event verified:", {
    id: event.id,
    type: event.type,
    ...(event.eventDate !== undefined ? { eventDate: event.eventDate } : {}),
    paymentIds: event.paymentIds,
  });

  return NextResponse.json({ ok: true });
}
