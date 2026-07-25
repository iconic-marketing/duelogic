import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { areLocalhostRequestHeaders } from "@/lib/dev/localhost-guard";
import { formatAud, formatDisplayDate } from "@/lib/duelogic/display";
import { getDevInterventionNotificationRepository } from "@/lib/duelogic/dev-intervention-store";

/**
 * Localhost-only in-app customer notification inbox: the delivery channel
 * for the Stage 1 prototype. Invitations arrive here automatically after
 * the scheduled scan — the merchant never creates, copies or sends a link.
 * Shows plain customer language only: no merchant, payer, source,
 * subscription or plan IDs, no token values, no policy reason codes and no
 * internal JSON (the review link's URL carries the customer's own access
 * token by design — it is the delivery artefact). Renders notFound()
 * unless running under `next dev` on a direct localhost request. Records
 * live in process-local sandbox memory and are lost when the development
 * server restarts.
 */

const expiryFormatter = new Intl.DateTimeFormat("en-AU", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Australia/Sydney",
});

function formatExpiry(expiresAt: string): string {
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) {
    return expiresAt;
  }
  return `${expiryFormatter.format(new Date(parsed))} (Sydney time)`;
}

export default async function CustomerInboxPage() {
  if (process.env.NODE_ENV !== "development") {
    notFound();
  }
  const requestHeaders = await headers();
  if (!areLocalhostRequestHeaders(requestHeaders)) {
    notFound();
  }

  const notifications = await getDevInterventionNotificationRepository().list();
  const newestFirst = [...notifications].reverse();

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-10 font-sans text-sm">
      <h1 className="text-2xl font-semibold tracking-tight">Your inbox</h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        Messages about your recurring payments appear here.
      </p>

      {newestFirst.length === 0 ? (
        <p className="mt-6 rounded-lg border border-zinc-200 p-4 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          No messages yet.
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-4">
          {newestFirst.map((notification) => (
            <li
              key={notification.notificationId}
              className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
            >
              <h2 className="font-semibold">{notification.title}</h2>
              <dl className="mt-2 flex flex-col gap-0.5 text-zinc-700 dark:text-zinc-300">
                <div className="flex gap-2">
                  <dt className="text-zinc-500 dark:text-zinc-500">
                    Payment amount:
                  </dt>
                  <dd className="font-medium">
                    {formatAud(notification.amountInCents)}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-zinc-500 dark:text-zinc-500">
                    Currently scheduled for:
                  </dt>
                  <dd className="font-medium">
                    {formatDisplayDate(notification.currentScheduledDate)}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
                This invitation expires at {formatExpiry(notification.expiresAt)}
                .
              </p>
              <p className="mt-3">
                <Link
                  href={notification.reviewPath}
                  className="inline-block rounded bg-zinc-900 px-4 py-1.5 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                >
                  Review payment options
                </Link>
              </p>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8 text-xs text-zinc-500 dark:text-zinc-500">
        Development inbox: notifications are kept in memory and are lost when
        the development server restarts.
      </p>
    </main>
  );
}
