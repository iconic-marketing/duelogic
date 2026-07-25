import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { areLocalhostRequestHeaders } from "@/lib/dev/localhost-guard";
import { formatAud, formatDisplayDate } from "@/lib/duelogic/display";
import {
  toCustomerConfirmationProjection,
  type ConfirmedSchedulePayment,
} from "@/lib/pinch/customer-confirmation";
import { hashCustomerConfirmationToken } from "@/lib/pinch/customer-confirmation-service";
import { getDevCustomerConfirmationRepository } from "@/lib/pinch/dev-customer-confirmation-store";
import { ConfirmationForm } from "./confirmation-form";

/**
 * Localhost-only customer confirmation page. The URL token is hashed
 * server-side and looked up in the confirmation store; the raw token is
 * never stored or logged. Customers see only their own schedule content in
 * plain language: no merchant, payer, source, subscription, plan or
 * operation IDs, no internal reason codes, no raw JSON and no test
 * directives. Renders notFound() unless running under `next dev` on a
 * direct localhost request — the same header rules as the dev API routes.
 * Real link delivery (email/SMS) is outside the current Build Weekend
 * scope.
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

function ScheduleList({
  title,
  payments,
}: {
  title: string;
  payments: ConfirmedSchedulePayment[];
}) {
  return (
    <div>
      <h2 className="font-medium">{title}</h2>
      <ul className="mt-1 flex flex-col gap-0.5">
        {payments.map((payment) => (
          <li key={payment.paymentDate}>
            <span className="font-medium">
              {formatDisplayDate(payment.paymentDate)}
            </span>{" "}
            — {formatAud(payment.amountInCents)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function CustomerConfirmationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  if (process.env.NODE_ENV !== "development") {
    notFound();
  }
  const requestHeaders = await headers();
  if (!areLocalhostRequestHeaders(requestHeaders)) {
    notFound();
  }

  const { token } = await params;
  // A mangled URL segment must render the generic invalid-link message, not
  // crash; base64url tokens never need decoding, but the segment may arrive
  // percent-encoded.
  let rawToken: string;
  try {
    rawToken = decodeURIComponent(token);
  } catch {
    rawToken = token;
  }
  const record = await getDevCustomerConfirmationRepository().readByTokenHash(
    hashCustomerConfirmationToken(rawToken),
  );

  if (record === null) {
    return (
      <main className="mx-auto w-full max-w-xl px-6 py-10 font-sans text-sm">
        <h1 className="text-2xl font-semibold tracking-tight">
          Confirm your payment schedule
        </h1>
        <p className="mt-4">
          This confirmation link is not valid. Ask the merchant to create a
          new request.
        </p>
      </main>
    );
  }

  const view = toCustomerConfirmationProjection(
    record,
    new Date().toISOString(),
  );

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-10 font-sans text-sm">
      <h1 className="text-2xl font-semibold tracking-tight">
        Confirm your payment schedule
      </h1>

      {view.status === "expired" ? (
        <p className="mt-4" role="alert">
          This confirmation link has expired. Ask the merchant to create a
          new request.
        </p>
      ) : (
        <>
          <p className="mt-4 text-zinc-600 dark:text-zinc-400">
            Your merchant has proposed new payment dates for your recurring
            payments. Please review the exact dates and amounts below.
          </p>
          <p className="mt-2 font-medium">
            By accepting, you confirm the exact payment dates and amounts
            shown below.
          </p>

          <div className="mt-5 flex flex-col gap-5 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <ScheduleList
              title="Your current schedule (next three payments)"
              payments={view.currentPayments}
            />
            <ScheduleList
              title="Your proposed new schedule (next three payments)"
              payments={view.proposedPayments}
            />
            <p>
              <span className="font-medium">
                Proposed new schedule starts:
              </span>{" "}
              {formatDisplayDate(view.proposedStartDate)}
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-500">
              This confirmation expires at {formatExpiry(view.expiresAt)}.
            </p>
          </div>

          <p className="mt-4 text-amber-700 dark:text-amber-400">
            Accepting replaces your existing recurring payment schedule with
            the proposed schedule shown above.
          </p>

          <ConfirmationForm token={rawToken} initialStatus={view.status} />
        </>
      )}
    </main>
  );
}
