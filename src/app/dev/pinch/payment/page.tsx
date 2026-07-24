import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { areLocalhostRequestHeaders } from "@/lib/dev/localhost-guard";
import { PaymentControl } from "./payment-control";

/**
 * Localhost-only development screen: the minimum visible proof that DueLogic
 * can read a managed scheduled payment, move its date through the proven
 * route and show verified webhook outcome events. Renders notFound() unless
 * running under `next dev` on a direct localhost request — the same header
 * rules as the dev API routes, via the shared guard.
 */

// Opaque sandbox identifiers only — no payment state is hardcoded here.
const SANDBOX_MERCHANT_ID = "mch_gsz9TbadIKto3N";
const SANDBOX_PAYMENT_ID = "pmt_aQfriAy9Jw2fPr";

export default async function LivePaymentControlPage() {
  if (process.env.NODE_ENV !== "development") {
    notFound();
  }
  const requestHeaders = await headers();
  if (!areLocalhostRequestHeaders(requestHeaders)) {
    notFound();
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight">
        DueLogic live payment control
      </h1>
      <PaymentControl
        initialMerchantId={SANDBOX_MERCHANT_ID}
        initialPaymentId={SANDBOX_PAYMENT_ID}
      />
    </main>
  );
}
