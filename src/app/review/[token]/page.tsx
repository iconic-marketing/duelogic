import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { areLocalhostRequestHeaders } from "@/lib/dev/localhost-guard";
import { getDevInterventionRepository } from "@/lib/duelogic/dev-intervention-store";
import { toCustomerInterventionProjection } from "@/lib/duelogic/intervention";
import {
  hashInterventionToken,
  openIntervention,
} from "@/lib/duelogic/intervention-service";
import { ReviewForm } from "./review-form";

/**
 * Localhost-only tokenised customer intervention page. The URL token is
 * hashed server-side and looked up in the intervention store; the raw
 * token is never stored or logged, and the first open is recorded on the
 * intervention. Customers see only their own schedule content in plain
 * language: no merchant, payer, source, subscription, plan or pattern IDs,
 * no policy reason codes, no raw JSON and no internal detail. Renders
 * notFound() unless running under `next dev` on a direct localhost request
 * — the same header rules as the dev API routes.
 */

export default async function CustomerReviewPage({
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

  const record = await openIntervention(
    { token: rawToken },
    {
      repository: getDevInterventionRepository(),
      now: () => new Date().toISOString(),
      hashToken: hashInterventionToken,
    },
  );

  if (record === null) {
    return (
      <main className="mx-auto w-full max-w-xl px-6 py-10 font-sans text-sm">
        <h1 className="text-2xl font-semibold tracking-tight">
          Review your payment schedule
        </h1>
        <p className="mt-4">
          This link is not valid. If you were expecting a payment schedule
          review, check your inbox for the latest invitation.
        </p>
      </main>
    );
  }

  const view = toCustomerInterventionProjection(
    record,
    new Date().toISOString(),
  );

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-10 font-sans text-sm">
      <h1 className="text-2xl font-semibold tracking-tight">
        Review your payment schedule
      </h1>
      <ReviewForm token={rawToken} initialView={view} />
    </main>
  );
}
