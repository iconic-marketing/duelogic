import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { areLocalhostRequestHeaders } from "@/lib/dev/localhost-guard";
import { toDemoSetupProjection } from "@/lib/duelogic/demo-preparation";
import { validateDemoPreparation } from "@/lib/duelogic/demo-preparation-validation";
import { getDevDemoManifestRepository } from "@/lib/duelogic/dev-demo-store";
import { PrepareDemoButton } from "./prepare-button";

/**
 * Development-only Demo Setup page: one click recreates the complete
 * process-local DueLogic presentation state after a development-server
 * restart, then links every demo screen. Renders notFound() unless
 * running under `next dev` on a direct localhost request — the same
 * header rules as the other development pages.
 *
 * The scenario links use the stored secure reviewPath values as hrefs
 * only; the raw token, full review URLs and every internal identifier
 * (merchant, payer, payment, subscription, plan, source, policy JSON)
 * are never rendered as text. Preparation itself makes zero Pinch
 * requests, issues no OTP and writes no SMS message. The deterministic
 * demo-preparation suite is re-asserted on every render, following the
 * dashboard convention.
 */

const preparedAtFormatter = new Intl.DateTimeFormat("en-AU", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Australia/Sydney",
});

function formatSydneyTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return iso;
  }
  return `${preparedAtFormatter.format(new Date(parsed))} (Sydney time)`;
}

const NAV_LINKS = [
  { label: "Demo setup", href: "/dev/duelogic/demo" },
  { label: "Merchant dashboard", href: "/" },
  { label: "Customer email", href: "/dev/duelogic/inbox" },
  { label: "SMS inbox", href: "/dev/duelogic/sms" },
] as const;

export default async function DemoSetupPage() {
  if (process.env.NODE_ENV !== "development") {
    notFound();
  }
  const requestHeaders = await headers();
  if (!areLocalhostRequestHeaders(requestHeaders)) {
    notFound();
  }

  // Deterministic self-check, re-asserted per render like the dashboard.
  const validation = await validateDemoPreparation();

  const demo = toDemoSetupProjection(
    await getDevDemoManifestRepository().read(),
  );

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
        Demo Setup
      </h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        Prepare demo recreates the complete DueLogic presentation state in
        one click: three tokenised customer journeys with fresh simulated
        invitation emails, plus the two completed-result fixtures. It
        removes only the records created by the previous demo run —
        unrelated records and all live sandbox evidence stay untouched.
      </p>
      <ul className="mt-3 list-disc pl-5 text-zinc-600 dark:text-zinc-400">
        <li>Demo records are process-local.</li>
        <li>Run Prepare demo again after the development server restarts.</li>
        <li>No Pinch requests are made during preparation.</li>
      </ul>

      <div className="mt-5 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <p className="font-medium">
          Status:{" "}
          {demo.prepared ? (
            <span className="text-green-800 dark:text-green-400">
              Demo prepared
            </span>
          ) : (
            <span>Demo not prepared</span>
          )}
        </p>
        {demo.prepared && demo.preparedAt !== null ? (
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Prepared at {formatSydneyTime(demo.preparedAt)}.
          </p>
        ) : null}
        {demo.prepared ? (
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
            Records reset when the development server restarts — run Prepare
            demo again afterwards.
          </p>
        ) : null}
        <div className="mt-3">
          <PrepareDemoButton prepared={demo.prepared} />
        </div>
        {demo.prepared && demo.demoRunId !== null ? (
          <p className="mt-3 font-mono text-[10px] text-zinc-400 dark:text-zinc-600">
            demoRunId: {demo.demoRunId}
          </p>
        ) : null}
      </div>

      {demo.prepared ? (
        <>
          <h2 className="mt-6 text-base font-semibold">Customer journeys</h2>
          <ul className="mt-3 flex flex-col gap-3">
            {demo.scenarios
              .filter((scenario) => scenario.kind === "customer-journey")
              .map((scenario) => (
                <li
                  key={scenario.scenarioKey}
                  className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <p className="font-semibold">{scenario.displayLabel}</p>
                    <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-900 dark:bg-sky-950 dark:text-sky-300">
                      {scenario.provenanceLabel}
                    </span>
                  </div>
                  <p className="mt-2">
                    <Link
                      href={scenario.reviewPath}
                      className="inline-block rounded bg-zinc-900 px-4 py-1.5 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                    >
                      Open customer journey
                    </Link>
                  </p>
                </li>
              ))}
          </ul>

          <h2 className="mt-6 text-base font-semibold">Completed results</h2>
          <ul className="mt-3 flex flex-col gap-3">
            {demo.scenarios
              .filter((scenario) => scenario.kind === "completed-result")
              .map((scenario) => (
                <li
                  key={scenario.scenarioKey}
                  className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <p className="font-semibold">{scenario.displayLabel}</p>
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-300">
                      {scenario.provenanceLabel}
                    </span>
                  </div>
                  <p className="mt-2">
                    <Link
                      href={scenario.reviewPath}
                      className="inline-block rounded bg-zinc-900 px-4 py-1.5 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                    >
                      Open completed result
                    </Link>
                  </p>
                </li>
              ))}
          </ul>
        </>
      ) : null}

      <h2 className="mt-6 text-base font-semibold">Supporting screens</h2>
      <ul className="mt-2 flex flex-col gap-1">
        <li>
          <Link href="/" className="font-medium underline underline-offset-4">
            Open merchant dashboard
          </Link>
        </li>
        <li>
          <Link
            href="/dev/duelogic/inbox"
            className="font-medium underline underline-offset-4"
          >
            Open customer email inbox
          </Link>{" "}
          <span className="text-xs text-zinc-500 dark:text-zinc-500">
            — simulated customer email delivery
          </span>
        </li>
        <li>
          <Link
            href="/dev/duelogic/sms"
            className="font-medium underline underline-offset-4"
          >
            Open SMS inbox
          </Link>{" "}
          <span className="text-xs text-zinc-500 dark:text-zinc-500">
            — simulated SMS delivery; OTP codes are requested during the
            customer journey, never at preparation
          </span>
        </li>
      </ul>

      <p className="mt-8 text-xs text-zinc-500 dark:text-zinc-500">
        Development page: {validation.scenarioCount} demo-preparation
        scenarios re-asserted on this render. Records are kept in memory and
        are lost when the development server restarts.
      </p>
    </main>
  );
}
