import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { areLocalhostRequestHeaders } from "@/lib/dev/localhost-guard";
import { getDevSmsStore, type DevSmsMessage } from "@/lib/duelogic/dev-sms-store";
import { OTP_CHALLENGE_LIFETIME_MINUTES } from "@/lib/duelogic/otp-challenge";

/**
 * Localhost-only development SMS inbox: the SEPARATE simulated delivery
 * channel for customer OTP codes. The review link never appears here and
 * the OTP never appears in the invitation inbox or on the review page —
 * the two channels stay apart by design, which is also why no link back
 * to a customer journey is offered from this page. Messages show a masked
 * recipient (last three digits at most), the sent time and the simulated
 * SMS body; no review links, tokens or internal identifiers are rendered.
 *
 * Presentation order: messages whose five-minute code lifetime has not
 * yet lapsed first (newest first), then older or expired messages. The
 * split is display-only arithmetic over the existing sent time and the
 * existing challenge lifetime constant — OTP validity itself is decided
 * only by the verification path, never by this page.
 *
 * Renders notFound() unless running under `next dev` on a direct
 * localhost request. Messages live in process-local sandbox memory and
 * are lost when the development server restarts.
 */

const sentAtFormatter = new Intl.DateTimeFormat("en-AU", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Australia/Sydney",
});

function formatSentAt(sentAt: string): string {
  const parsed = Date.parse(sentAt);
  if (Number.isNaN(parsed)) {
    return sentAt;
  }
  return `${sentAtFormatter.format(new Date(parsed))} (Sydney time)`;
}

const NAV_LINKS = [
  { label: "Demo setup", href: "/dev/duelogic/demo" },
  { label: "Merchant dashboard", href: "/" },
  { label: "Customer email", href: "/dev/duelogic/inbox" },
  { label: "SMS inbox", href: "/dev/duelogic/sms" },
] as const;

function SmsCard({ message }: { message: DevSmsMessage }) {
  return (
    <li className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <p className="text-xs text-zinc-500 dark:text-zinc-500">
        To {message.maskedRecipient} — {formatSentAt(message.sentAt)}
      </p>
      <p className="mt-2 rounded bg-zinc-50 p-3 font-mono dark:bg-zinc-900">
        {message.body}
      </p>
    </li>
  );
}

export default async function DevSmsInboxPage() {
  if (process.env.NODE_ENV !== "development") {
    notFound();
  }
  const requestHeaders = await headers();
  if (!areLocalhostRequestHeaders(requestHeaders)) {
    notFound();
  }

  const messages = await getDevSmsStore().list();
  const newestFirst = [...messages].reverse();

  // Display-only recency split from the existing code lifetime: a message
  // older than the challenge lifetime cannot carry a still-usable code.
  const nowMs = Date.parse(new Date().toISOString());
  const lifetimeMs = OTP_CHALLENGE_LIFETIME_MINUTES * 60_000;
  const current: DevSmsMessage[] = [];
  const expired: DevSmsMessage[] = [];
  for (const message of newestFirst) {
    const sentMs = Date.parse(message.sentAt);
    const stillCurrent = !Number.isNaN(sentMs) && nowMs - sentMs < lifetimeMs;
    (stillCurrent ? current : expired).push(message);
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
        Development SMS inbox
      </h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        Simulated SMS delivery channel: verification codes sent by DueLogic
        appear here during development. This is not a real phone.
      </p>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        This verification step is separate from the email invitation by
        design: the code arrives only here, and the secure review link
        arrives only in the customer email inbox. Return to the customer
        journey page you already have open to enter the code.
      </p>

      {current.length === 0 && expired.length === 0 ? (
        <p className="mt-6 rounded-lg border border-zinc-200 p-4 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          No messages yet.
        </p>
      ) : (
        <>
          {current.length > 0 ? (
            <>
              <h2 className="mt-6 text-base font-semibold">
                Current messages
              </h2>
              <ul className="mt-3 flex flex-col gap-4">
                {current.map((message) => (
                  <SmsCard key={message.smsId} message={message} />
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-6 rounded-lg border border-zinc-200 p-4 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
              No current messages — codes expire{" "}
              {OTP_CHALLENGE_LIFETIME_MINUTES} minutes after they are sent.
            </p>
          )}
          {expired.length > 0 ? (
            <>
              <h2 className="mt-8 text-base font-semibold text-zinc-500 dark:text-zinc-500">
                Older or expired messages
              </h2>
              <ul className="mt-3 flex flex-col gap-4 opacity-80">
                {expired.map((message) => (
                  <SmsCard key={message.smsId} message={message} />
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}

      <p className="mt-8 text-xs text-zinc-500 dark:text-zinc-500">
        Development SMS inbox: messages are kept in memory and are lost when
        the development server restarts. Codes expire{" "}
        {OTP_CHALLENGE_LIFETIME_MINUTES} minutes after they are sent.
      </p>
    </main>
  );
}
