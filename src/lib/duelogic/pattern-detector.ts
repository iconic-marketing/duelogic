/**
 * Deterministic timing-linked payment-pattern detector.
 *
 * Pure functions over PaymentRecord history: no network, no environment, no
 * Date.now()/Math.random(), no mutation of the supplied records, no external
 * dependency. All date arithmetic works on parsed YYYY-MM-DD components via
 * UTC millisecond maths, so the server timezone can never influence a result.
 *
 * The detector identifies timing-linked payment patterns only. It never
 * infers payday, employment, affordability, income, hardship or any other
 * financial cause, and a proposed shift is a shift worth testing — not a
 * claim that any dishonour would have been prevented.
 */

import type {
  PatternBasis,
  PatternFlag,
  PaymentRecord,
  TimingPatternEvidence,
  TimingPatternSettlementEvidence,
  Weekday,
} from "./schema";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** Monday-first ordering; also the day-of-week final tie-break order. */
const WEEKDAYS: readonly Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** Strictly parses a real YYYY-MM-DD calendar date, else null. */
export function parseCalendarDate(value: string): CalendarDate | null {
  if (!DATE_ONLY_PATTERN.test(value)) {
    return null;
  }
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12) {
    return null;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) {
    return null;
  }
  return { year, month, day };
}

function utcMs(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

function formatCalendarDate(date: CalendarDate): string {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${date.year}-${month}-${day}`;
}

/**
 * Whole calendar days from `from` to `to` (negative when `to` is earlier),
 * or null when either date is invalid. UTC arithmetic only.
 */
export function calendarDaysBetween(from: string, to: string): number | null {
  const a = parseCalendarDate(from);
  const b = parseCalendarDate(to);
  if (a === null || b === null) {
    return null;
  }
  return Math.round((utcMs(b) - utcMs(a)) / MS_PER_DAY);
}

/** Weekday of a YYYY-MM-DD date via UTC arithmetic, or null when invalid. */
export function weekdayOf(value: string): Weekday | null {
  const date = parseCalendarDate(value);
  if (date === null) {
    return null;
  }
  // getUTCDay: 0 = Sunday … 6 = Saturday; rotate to the Monday-first table.
  return WEEKDAYS[(new Date(utcMs(date)).getUTCDay() + 6) % 7];
}

/** Same calendar day `months` earlier, clamped to the target month length. */
function monthsEarlier(date: CalendarDate, months: number): CalendarDate {
  const zeroBasedMonth = date.year * 12 + (date.month - 1) - months;
  const year = Math.floor(zeroBasedMonth / 12);
  const month = ((zeroBasedMonth % 12) + 12) % 12 + 1;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, day: Math.min(date.day, daysInMonth) };
}

export interface DetectTimingLinkedPatternsOptions {
  /** YYYY-MM-DD anchor; defaults to the latest scheduledDate in `records`. */
  asOfDate?: string;
  /** Rolling lookback in calendar months. Default 12. */
  lookbackMonths?: number;
  /** Minimum clustered qualifying dishonours. Default 2, minimum 2. */
  minimumDishonours?: number;
  /** Inclusive day-of-month window width in days. Default 4. */
  dayOfMonthWindowDays?: number;
}

/** A lookback insufficient-funds dishonour with safely parsed dates. */
interface QualifyingDishonour {
  record: PaymentRecord;
  scheduledDay: number;
  scheduledWeekday: Weekday;
  /** Present only when an approved strictly-later retry parses safely. */
  retry?: {
    retryDate: string;
    retryDay: number;
    retryWeekday: Weekday;
    delayDays: number;
  };
}

interface DayOfMonthCluster {
  members: QualifyingDishonour[];
  evidence: TimingPatternSettlementEvidence[];
  /**
   * The full inclusive detection window that selected the cluster — not the
   * observed member-day extremes. Retry exclusion tests against these bounds.
   */
  windowStartDay: number;
  windowEndDay: number;
  /** Span of the observed member days, used only as a tie-break. */
  observedSpan: number;
}

interface DayOfWeekCluster {
  members: QualifyingDishonour[];
  evidence: TimingPatternSettlementEvidence[];
  weekday: Weekday;
}

/**
 * Retry evidence for clustered dishonours: approved, strictly later than
 * processedDate (already established during candidate parsing), and falling
 * outside the cluster per the supplied predicate.
 */
function settlementEvidenceFor(
  members: readonly QualifyingDishonour[],
  retryIsOutsideCluster: (
    retry: NonNullable<QualifyingDishonour["retry"]>,
  ) => boolean,
): TimingPatternSettlementEvidence[] {
  const evidence: TimingPatternSettlementEvidence[] = [];
  for (const member of members) {
    if (member.retry === undefined || !retryIsOutsideCluster(member.retry)) {
      continue;
    }
    evidence.push({
      paymentRecordId: member.record.id,
      scheduledDate: member.record.scheduledDate,
      processedDate: member.record.processedDate,
      retryDate: member.retry.retryDate,
      delayDays: member.retry.delayDays,
    });
  }
  return evidence;
}

/**
 * Densest set of dishonours whose scheduled-day values fit inside one
 * inclusive `windowDays`-wide day-of-month window. Day 31 and day 1 are not
 * adjacent — windows never wrap the month boundary. The selected cluster
 * retains its full detection-window bounds; settlement evidence must fall
 * outside those bounds. Ties break by highest dishonour count, highest
 * retry-evidence count, narrowest observed day span, then earliest window
 * start — and when several windows contain the same member set, the earliest
 * window start is the selected window.
 */
function bestDayOfMonthCluster(
  candidates: readonly QualifyingDishonour[],
  windowDays: number,
  minimumDishonours: number,
): DayOfMonthCluster | null {
  const seenMemberSets = new Set<string>();
  let best: DayOfMonthCluster | null = null;

  for (let start = 1; start + windowDays - 1 <= 31; start++) {
    const end = start + windowDays - 1;
    const members = candidates.filter(
      (candidate) =>
        candidate.scheduledDay >= start && candidate.scheduledDay <= end,
    );
    if (members.length < minimumDishonours) {
      continue;
    }
    // Overlapping window positions often capture the identical member set;
    // the earliest such position is the selected window (and is the one whose
    // bounds retry exclusion tests against), so later duplicates are skipped.
    const signature = members.map((member) => member.record.id).join("|");
    if (seenMemberSets.has(signature)) {
      continue;
    }
    seenMemberSets.add(signature);

    const days = members.map((member) => member.scheduledDay);
    // The retry must fall outside the full selected detection window, not
    // merely outside the observed member days: a retry on day 26 is inside a
    // selected [25, 28] window even when every dishonour fell on day 28.
    // Windows never wrap, so plain day comparison is exact (a day-1 retry is
    // outside a window ending on day 31).
    const evidence = settlementEvidenceFor(
      members,
      (retry) => retry.retryDay < start || retry.retryDay > end,
    );
    const cluster: DayOfMonthCluster = {
      members,
      evidence,
      windowStartDay: start,
      windowEndDay: end,
      observedSpan: Math.max(...days) - Math.min(...days),
    };

    if (best === null) {
      best = cluster;
      continue;
    }
    const better =
      cluster.members.length !== best.members.length
        ? cluster.members.length > best.members.length
        : cluster.evidence.length !== best.evidence.length
          ? cluster.evidence.length > best.evidence.length
          : cluster.observedSpan !== best.observedSpan
            ? cluster.observedSpan < best.observedSpan
            : false; // equal on all: keep the earlier window start (iteration order)
    if (better) {
      best = cluster;
    }
  }
  return best;
}

/**
 * Largest same-weekday group of dishonours. Ties break by highest dishonour
 * count, highest retry-evidence count, then Monday-through-Sunday order
 * (guaranteed by iteration order).
 */
function bestDayOfWeekCluster(
  candidates: readonly QualifyingDishonour[],
  minimumDishonours: number,
): DayOfWeekCluster | null {
  let best: DayOfWeekCluster | null = null;
  for (const weekday of WEEKDAYS) {
    const members = candidates.filter(
      (candidate) => candidate.scheduledWeekday === weekday,
    );
    if (members.length < Math.max(2, minimumDishonours)) {
      continue;
    }
    const evidence = settlementEvidenceFor(
      members,
      (retry) => retry.retryWeekday !== weekday,
    );
    if (
      best === null ||
      members.length > best.members.length ||
      (members.length === best.members.length &&
        evidence.length > best.evidence.length)
    ) {
      best = { members, evidence, weekday };
    }
  }
  return best;
}

/** Lower-median: for an even count, the lower of the two middle values. */
function lowerMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1];
}

/**
 * Detects timing-linked payment patterns: payers whose insufficient-funds
 * dishonours cluster by day of month (inclusive window) or day of week, with
 * at least one approved later retry settling outside the cluster. Returns
 * flags ordered by payerId, with stable IDs derived from payerId and the
 * as-of date; output is invariant to the input record order.
 */
export function detectTimingLinkedPatterns(
  records: readonly PaymentRecord[],
  options: DetectTimingLinkedPatternsOptions = {},
): PatternFlag[] {
  const lookbackMonths = options.lookbackMonths ?? 12;
  const minimumDishonours = options.minimumDishonours ?? 2;
  const dayOfMonthWindowDays = options.dayOfMonthWindowDays ?? 4;

  if (!Number.isInteger(lookbackMonths) || lookbackMonths < 1) {
    throw new RangeError("lookbackMonths must be a positive integer.");
  }
  if (!Number.isInteger(minimumDishonours) || minimumDishonours < 2) {
    throw new RangeError("minimumDishonours must be an integer of at least 2.");
  }
  if (
    !Number.isInteger(dayOfMonthWindowDays) ||
    dayOfMonthWindowDays < 1 ||
    dayOfMonthWindowDays > 31
  ) {
    throw new RangeError(
      "dayOfMonthWindowDays must be an integer between 1 and 31.",
    );
  }

  let asOf: CalendarDate;
  if (options.asOfDate !== undefined) {
    const parsed = parseCalendarDate(options.asOfDate);
    if (parsed === null) {
      throw new RangeError("asOfDate must be a valid YYYY-MM-DD calendar date.");
    }
    asOf = parsed;
  } else {
    let latest: string | null = null;
    for (const record of records) {
      if (
        parseCalendarDate(record.scheduledDate) !== null &&
        (latest === null || record.scheduledDate > latest)
      ) {
        latest = record.scheduledDate;
      }
    }
    if (latest === null) {
      return [];
    }
    // parseCalendarDate already succeeded for `latest` above.
    asOf = parseCalendarDate(latest) as CalendarDate;
  }
  const asOfDate = formatCalendarDate(asOf);
  // Rolling lookback (lookbackStart, asOfDate]: YYYY-MM-DD strings compare
  // lexicographically as dates.
  const lookbackStart = formatCalendarDate(monthsEarlier(asOf, lookbackMonths));

  // Qualifying dishonours per payer. Records whose dates cannot be parsed
  // safely never become candidates or evidence.
  const candidatesByPayer = new Map<string, QualifyingDishonour[]>();
  for (const record of records) {
    if (
      record.outcome !== "dishonoured" ||
      record.dishonourReason !== "insufficient-funds"
    ) {
      continue;
    }
    const scheduled = parseCalendarDate(record.scheduledDate);
    if (
      scheduled === null ||
      parseCalendarDate(record.processedDate) === null ||
      record.scheduledDate <= lookbackStart ||
      record.scheduledDate > asOfDate
    ) {
      continue;
    }
    const scheduledWeekday = weekdayOf(record.scheduledDate);
    if (scheduledWeekday === null) {
      continue;
    }

    const candidate: QualifyingDishonour = {
      record,
      scheduledDay: scheduled.day,
      scheduledWeekday,
    };
    if (record.retryOutcome === "approved" && record.retryDate !== undefined) {
      const retryParsed = parseCalendarDate(record.retryDate);
      const retryWeekday = weekdayOf(record.retryDate);
      const delayDays = calendarDaysBetween(
        record.processedDate,
        record.retryDate,
      );
      if (
        retryParsed !== null &&
        retryWeekday !== null &&
        delayDays !== null &&
        delayDays > 0
      ) {
        candidate.retry = {
          retryDate: record.retryDate,
          retryDay: retryParsed.day,
          retryWeekday,
          delayDays,
        };
      }
    }

    const existing = candidatesByPayer.get(record.payerId);
    if (existing === undefined) {
      candidatesByPayer.set(record.payerId, [candidate]);
    } else {
      existing.push(candidate);
    }
  }

  const flags: PatternFlag[] = [];
  for (const [payerId, unsorted] of candidatesByPayer) {
    if (unsorted.length < minimumDishonours) {
      continue;
    }
    // Deterministic candidate order regardless of input order.
    const candidates = [...unsorted].sort((a, b) => {
      if (a.record.scheduledDate !== b.record.scheduledDate) {
        return a.record.scheduledDate < b.record.scheduledDate ? -1 : 1;
      }
      return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
    });
    // Mixed merchants under one payer cannot be interpreted safely.
    const merchantIds = new Set(
      candidates.map((candidate) => candidate.record.merchantId),
    );
    if (merchantIds.size !== 1) {
      continue;
    }

    const dayOfMonth = bestDayOfMonthCluster(
      candidates,
      dayOfMonthWindowDays,
      minimumDishonours,
    );
    const dayOfWeek = bestDayOfWeekCluster(candidates, minimumDishonours);

    // A basis qualifies only with approved later-settlement evidence outside
    // its cluster. Never combine the two bases into one flag.
    const dayOfMonthQualifies =
      dayOfMonth !== null && dayOfMonth.evidence.length > 0;
    const dayOfWeekQualifies =
      dayOfWeek !== null && dayOfWeek.evidence.length > 0;

    let basis: PatternBasis;
    if (dayOfMonthQualifies && dayOfWeekQualifies) {
      const monthCluster = dayOfMonth as DayOfMonthCluster;
      const weekCluster = dayOfWeek as DayOfWeekCluster;
      if (monthCluster.members.length !== weekCluster.members.length) {
        basis =
          monthCluster.members.length > weekCluster.members.length
            ? "day-of-month"
            : "day-of-week";
      } else if (monthCluster.evidence.length !== weekCluster.evidence.length) {
        basis =
          monthCluster.evidence.length > weekCluster.evidence.length
            ? "day-of-month"
            : "day-of-week";
      } else {
        basis = "day-of-month"; // exact tie
      }
    } else if (dayOfMonthQualifies) {
      basis = "day-of-month";
    } else if (dayOfWeekQualifies) {
      basis = "day-of-week";
    } else {
      continue;
    }

    const cluster =
      basis === "day-of-month"
        ? (dayOfMonth as DayOfMonthCluster)
        : (dayOfWeek as DayOfWeekCluster);

    const evidence: TimingPatternEvidence = {
      basis,
      qualifyingDishonourCount: cluster.members.length,
      qualifyingPaymentRecordIds: cluster.members.map(
        (member) => member.record.id,
      ),
      qualifyingScheduledDates: cluster.members.map(
        (member) => member.record.scheduledDate,
      ),
      settlementEvidence: cluster.evidence,
    };
    if (basis === "day-of-month") {
      const monthCluster = cluster as DayOfMonthCluster;
      evidence.windowStartDay = monthCluster.windowStartDay;
      evidence.windowEndDay = monthCluster.windowEndDay;
    } else {
      evidence.weekday = (cluster as DayOfWeekCluster).weekday;
    }

    flags.push({
      id: `pattern-timing-${payerId}-${asOfDate}`,
      merchantId: candidates[0].record.merchantId,
      payerId,
      patternType: "timing-linked",
      proposedShiftDays: Math.max(
        1,
        lowerMedian(cluster.evidence.map((item) => item.delayDays)),
      ),
      detectedAsOfDate: asOfDate,
      evidence,
    });
  }

  flags.sort((a, b) =>
    a.payerId < b.payerId ? -1 : a.payerId > b.payerId ? 1 : 0,
  );
  return flags;
}
