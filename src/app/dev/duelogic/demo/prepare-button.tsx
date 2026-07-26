"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Client half of the Demo Setup page: the one "Prepare demo" action. It
 * sends an empty request — the browser supplies no identifiers and no
 * fixture data — and refreshes the server-rendered page, which re-reads
 * the manifest. Preparing again replaces the previous demo run.
 */

export function PrepareDemoButton({ prepared }: { prepared: boolean }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prepare = async () => {
    if (running) {
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const response = await fetch("/api/duelogic/dev/demo", {
        method: "POST",
      });
      const body: unknown = await response.json().catch(() => null);
      const ok =
        response.ok &&
        typeof body === "object" &&
        body !== null &&
        (body as { ok?: unknown }).ok === true;
      if (!ok) {
        setError(
          "Demo preparation failed. Check the development server log for the safe failure reason, then try again.",
        );
      }
    } catch {
      setError(
        "Demo preparation could not be requested. Is the development server running?",
      );
    } finally {
      setRunning(false);
      router.refresh();
    }
  };

  return (
    <div>
      <button
        type="button"
        className="rounded bg-zinc-900 px-5 py-2 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        onClick={() => {
          void prepare();
        }}
        disabled={running}
      >
        {running ? "Preparing…" : "Prepare demo"}
      </button>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
        {prepared
          ? "Preparing again removes the previous demo run's records and creates a fresh set with new secure links."
          : "Creates the complete demonstration state with fresh secure links."}
      </p>
      {error !== null ? (
        <p role="alert" className="mt-2 text-amber-700 dark:text-amber-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
