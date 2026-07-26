import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { areLocalhostRequestHeaders } from "@/lib/dev/localhost-guard";
import { formatAud, formatDisplayDate } from "@/lib/duelogic/display";
import {
  getDevInterventionNotificationRepository,
  getDevInterventionRepository,
} from "@/lib/duelogic/dev-intervention-store";
import {
  effectiveInterventionStatus,
  type InterventionCustomerNotification,
} from "@/lib/duelogic/intervention";

/**
 * Development Customer Email Inbox: the localhost-only page that presents
 * the existing invitation notifications as a SIMULATED customer email
 * channel for the hackathon demo. Presentation only — invitations arrive
 * here automatically after the scheduled scan exactly as before, the
 * notification records, token generation, hashing and expiry are
 * untouched, and rendering regenerates nothing and calls no Pinch
 * endpoint.
 *
 * Presentation order: active invitations first (newest first), then older
 * or no-longer-active messages. Activity is derived server-side from the
 * existing intervention records and expiry evaluation — nothing here
 * re-implements lifecycle rules, and a message whose intervention cannot
 * be found renders in the older section rather than being hidden.
 *
 * Channel separation: the secure review link exists only here (inside the
 * button's href — the raw token is the delivery artefact by design and is
 * never printed as visible text), while OTP codes are delivered only
 * through the separate development SMS inbox at /dev/duelogic/sms. No
 * merchant, payer, source, subscription, plan or intervention IDs and no
 * policy internals are rendered. Production delivery will use a real
 * email provider or the merchant's communications system — polishing-week
 * integration work. Renders notFound() unless running under `next dev` on
 * a direct localhost request. Records live in process-local sandbox
 * memory and are lost when the development server restarts.
 */

const sentAtFormatter = new Intl.DateTimeFormat("en-AU", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Australia/Sydney",
});

function formatSydneyTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return iso;
  }
  return `${sentAtFormatter.format(new Date(parsed))} (Sydney time)`;
}

const NAV_LINKS = [
  { label: "Demo setup", href: "/dev/duelogic/demo" },
  { label: "Merchant dashboard", href: "/" },
  { label: "Customer email", href: "/dev/duelogic/inbox" },
  { label: "SMS inbox", href: "/dev/duelogic/sms" },
] as const;

/** Lifecycle states in which the invitation is still actionable. */
const ACTIVE_STATUSES = new Set([
  "invitation-created",
  "opened",
  "awaiting-date-selection",
  "date-approved",
  "alternative-offered",
  "preview-ready",
]);

function EmailCard({
  notification,
}: {
  notification: InterventionCustomerNotification;
}) {
  return (
    <li className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <p className="border-b border-zinc-200 px-4 py-1.5 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
        Development simulation — not a real email
      </p>
      <div className="p-4">
        <dl className="flex flex-col gap-0.5 text-zinc-700 dark:text-zinc-300">
          <div className="flex gap-2">
            <dt className="w-14 text-zinc-500 dark:text-zinc-500">From:</dt>
            <dd className="font-medium">DueLogic</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-14 text-zinc-500 dark:text-zinc-500">To:</dt>
            <dd className="font-medium">Customer email on file</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-14 text-zinc-500 dark:text-zinc-500">Subject:</dt>
            <dd className="font-semibold">
              Review an alternative payment date
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-14 text-zinc-500 dark:text-zinc-500">Sent:</dt>
            <dd>{formatSydneyTime(notification.createdAt)}</dd>
          </div>
        </dl>

        <div className="mt-4 flex flex-col gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <p>An upcoming payment may be eligible for an alternative date.</p>
          <p>
            Your payment of{" "}
            <span className="font-medium">
              {formatAud(notification.amountInCents)}
            </span>{" "}
            is currently scheduled for{" "}
            <span className="font-medium">
              {formatDisplayDate(notification.currentScheduledDate)}
            </span>
            .
          </p>
          <p>
            Review the available option and the exact payment dates and
            amounts before making your decision. No change will be made
            unless you complete verification and give final confirmation.
          </p>
          <p>
            <Link
              href={notification.reviewPath}
              className="inline-block rounded bg-zinc-900 px-5 py-2 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
            >
              Review payment schedule
            </Link>
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-500">
            This secure link expires at{" "}
            {formatSydneyTime(notification.expiresAt)}.
          </p>
        </div>
      </div>
    </li>
  );
}

export default async function CustomerEmailInboxPage() {
  if (process.env.NODE_ENV !== "development") {
    notFound();
  }
  const requestHeaders = await headers();
  if (!areLocalhostRequestHeaders(requestHeaders)) {
    notFound();
  }

  const notifications = await getDevInterventionNotificationRepository().list();
  const newestFirst = [...notifications].reverse();

  // Active/older partition from the existing intervention records and the
  // existing server-side expiry evaluation — presentation only.
  const interventions = getDevInterventionRepository();
  const nowIso = new Date().toISOString();
  const active: InterventionCustomerNotification[] = [];
  const older: InterventionCustomerNotification[] = [];
  for (const notification of newestFirst) {
    const record = await interventions.readById(notification.interventionId);
    const isActive =
      record !== null &&
      ACTIVE_STATUSES.has(effectiveInterventionStatus(record, nowIso));
    (isActive ? active : older).push(notification);
  }

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-10 font-sans text-sm">
      <nav className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium">
        {NAV_LINKS.map((link, index) => (
          <span key={link.href} className="flex items-center gap-3">
            {index > 0 ? (
              <span aria-hidden className="text-zinc-300 dark:text-zinc-700">
                |
              </span>
            ) : null}
            <Link href={link.href} className="underline underline-offset-4">
              {link.label}
            </Link>
          </span>
        ))}
      </nav>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight">
        Development Customer Email Inbox
      </h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        This page simulates customer email delivery for the hackathon demo.
        In production these invitations would be sent through an email
        provider or the merchant&rsquo;s communications system. Verification
        codes are never sent here — OTP codes arrive through the separate
        development SMS inbox.
      </p>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        Each customer invitation below was generated by DueLogic after a
        payment timing pattern was identified and the merchant policy
        evaluated the opportunity — no invitation is sent without a policy
        result.
      </p>
      <p className="mt-3">
        <Link
          href="/dev/duelogic/sms"
          className="font-medium underline underline-offset-4"
        >
          Open development SMS inbox
        </Link>
      </p>

      {active.length === 0 && older.length === 0 ? (
        <p className="mt-6 rounded-lg border border-zinc-200 p-4 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          No emails yet.
        </p>
      ) : (
        <>
          {active.length > 0 ? (
            <>
              <h2 className="mt-6 text-base font-semibold">
                Active invitations
              </h2>
              <ul className="mt-3 flex flex-col gap-5">
                {active.map((notification) => (
                  <EmailCard
                    key={notification.notificationId}
                    notification={notification}
                  />
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-6 rounded-lg border border-zinc-200 p-4 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
              No active invitations right now.
            </p>
          )}
          {older.length > 0 ? (
            <>
              <h2 className="mt-8 text-base font-semibold text-zinc-500 dark:text-zinc-500">
                Older messages
              </h2>
              <ul className="mt-3 flex flex-col gap-5 opacity-80">
                {older.map((notification) => (
                  <EmailCard
                    key={notification.notificationId}
                    notification={notification}
                  />
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}

      <p className="mt-8 text-xs text-zinc-500 dark:text-zinc-500">
        Development inbox: simulated emails are kept in memory and are lost
        when the development server restarts.
      </p>
    </main>
  );
}
