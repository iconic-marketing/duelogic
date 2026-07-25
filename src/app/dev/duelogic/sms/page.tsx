import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { areLocalhostRequestHeaders } from "@/lib/dev/localhost-guard";
import { getDevSmsStore } from "@/lib/duelogic/dev-sms-store";

/**
 * Localhost-only development SMS inbox: the SEPARATE simulated delivery
 * channel for customer OTP codes. The review link never appears here and
 * the OTP never appears in the invitation inbox or on the review page —
 * the two channels stay apart by design. Messages show a masked
 * recipient (last three digits at most), the sent time and the simulated
 * SMS body; no review links, tokens or internal identifiers are
 * rendered. Renders notFound() unless running under `next dev` on a
 * direct localhost request. Messages live in process-local sandbox
 * memory and are lost when the development server restarts.
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

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-10 font-sans text-sm">
      <h1 className="text-2xl font-semibold tracking-tight">
        Development SMS inbox
      </h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        Simulated SMS delivery channel: verification codes sent by DueLogic
        appear here during development. This is not a real phone.
      </p>

      {newestFirst.length === 0 ? (
        <p className="mt-6 rounded-lg border border-zinc-200 p-4 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          No messages yet.
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-4">
          {newestFirst.map((message) => (
            <li
              key={message.smsId}
              className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
            >
              <p className="text-xs text-zinc-500 dark:text-zinc-500">
                To {message.maskedRecipient} — {formatSentAt(message.sentAt)}
              </p>
              <p className="mt-2 rounded bg-zinc-50 p-3 font-mono dark:bg-zinc-900">
                {message.body}
              </p>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8 text-xs text-zinc-500 dark:text-zinc-500">
        Development SMS inbox: messages are kept in memory and are lost when
        the development server restarts. Codes expire five minutes after
        they are sent.
      </p>
    </main>
  );
}
