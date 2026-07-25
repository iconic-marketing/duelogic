/**
 * Shared display-boundary helpers for DueLogic UI components.
 *
 * The one place integer cents become dollars, and the one place Pinch
 * sandbox test directives are stripped from payment descriptions before
 * display. Pure functions only — no mutation of source values, no clock
 * reads, no environment access.
 */

const audFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
});

/** Integer cents to AUD text — the display boundary. */
export function formatAud(amountCents: number): string {
  return audFormatter.format(amountCents / 100);
}

const MONTH_ABBREVIATIONS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * A YYYY-MM-DD string as a short merchant-facing label ("28 Aug 2025").
 * Deterministic string arithmetic only — never Date parsing, so the server
 * timezone can never shift the displayed day. Unrecognised input is
 * returned unchanged rather than guessed at.
 */
export function formatDisplayDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return value;
  }
  const month = MONTH_ABBREVIATIONS[Number(match[2]) - 1];
  if (month === undefined) {
    return value;
  }
  return `${Number(match[3])} ${month} ${match[1]}`;
}

/**
 * The merchant-facing part of a payment description: everything before the
 * first `#`. Pinch sandbox test directives (e.g. `#insufficient-funds`)
 * begin at a hash and are execution instructions, not display content. The
 * source value is never mutated — callers retain the original internally.
 */
export function visibleDescription(description: string): string {
  const hashIndex = description.indexOf("#");
  const visible =
    hashIndex === -1 ? description : description.slice(0, hashIndex);
  return visible.trim();
}
