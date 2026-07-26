/**
 * Development-only demo-run manifest store: the process-local record of
 * the one currently prepared presentation state (demoRunId, preparedAt
 * and every record created by the last "Prepare demo" run), following the
 * established dev-store pattern (src/lib/duelogic/dev-intervention-store.ts).
 *
 * NON-DURABLE SANDBOX STORAGE, never persistence: the manifest lives in
 * process memory, backed by `globalThis` (hot reloads keep it, restarts do
 * not) — after a development-server restart the demo reads "not prepared"
 * and must be prepared again.
 *
 * The manifest's reviewPath values carry the raw customer link tokens by
 * design (the same delivery-artefact rule as the notification store): the
 * Demo Setup page uses them only as link hrefs and never renders the raw
 * token as text, and the manifest must never be exposed through merchant
 * monitoring. Everything else in the manifest is fixture identifiers only
 * — never credentials, live Pinch response bodies or customer identity.
 */

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts.
if (typeof window !== "undefined") {
  throw new Error(
    "The dev demo store is server-only and must not be imported into browser code.",
  );
}

export const DEMO_SCENARIO_KEYS = [
  "temporary-only",
  "all-options",
  "permanent-only",
  "completed-temporary",
  "completed-permanent",
] as const;

export type DemoScenarioKey = (typeof DEMO_SCENARIO_KEYS)[number];

/** Result provenance: what the rendered evidence actually is. */
export type DemoScenarioProvenance =
  | "development-scenario"
  | "deterministic-development-fixture"
  | "live-sandbox-representation";

/**
 * One prepared scenario's manifest entry: every record the preparation
 * created for it, so the next preparation can remove exactly those
 * records and nothing else.
 */
export interface DemoManifestScenario {
  readonly scenarioKey: DemoScenarioKey;
  /** Customer-safe display label, e.g. "Demo 1: Move one payment". */
  readonly displayLabel: string;
  readonly kind: "customer-journey" | "completed-result";
  readonly provenance: DemoScenarioProvenance;
  /** The visible evidence label shown beside the scenario. */
  readonly provenanceLabel: string;
  readonly interventionId: string;
  /** Null for completed-result fixtures, which get no invitation email. */
  readonly notificationId: string | null;
  /** "/review/<raw token>" — href use only, never rendered as text. */
  readonly reviewPath: string;
  /** The fixture scheduled payment seeded for this scenario, if any. */
  readonly fixturePaymentId: string | null;
  /** Demo-seeded temporary operation evidence (scenario 3 history). */
  readonly temporaryOperationIds: readonly string[];
  /** True when a bound temporary selection was seeded (scenario 4). */
  readonly temporarySelectionBound: boolean;
}

export interface DemoRunManifest {
  readonly demoRunId: string;
  /** ISO instant of preparation on the server clock. */
  readonly preparedAt: string;
  readonly scenarios: readonly DemoManifestScenario[];
}

/**
 * Storage boundary for the single current manifest. `replace` swaps the
 * whole manifest in one write — there is no partial update — and `read`
 * returns null when no demo has been prepared in this process.
 */
export interface DemoManifestRepository {
  read(): Promise<DemoRunManifest | null>;
  replace(manifest: DemoRunManifest): Promise<void>;
}

/** The one storage slot: a single-key map keeps the factory pattern. */
const MANIFEST_KEY = "current";

type ManifestMap = Map<string, DemoRunManifest>;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Creates a fresh, isolated in-memory manifest repository. Manifests are
 * cloned on write and on read, so stored state can never be mutated
 * through a caller-held object, and `replace` refuses a structurally
 * unusable manifest (a manifest that could not drive targeted clearing).
 */
export function createInMemoryDemoManifestRepository(
  manifests: ManifestMap = new Map(),
): DemoManifestRepository {
  return {
    async read(): Promise<DemoRunManifest | null> {
      const manifest = manifests.get(MANIFEST_KEY);
      return manifest === undefined ? null : structuredClone(manifest);
    },
    async replace(manifest: DemoRunManifest): Promise<void> {
      if (
        !nonEmpty(manifest.demoRunId) ||
        Number.isNaN(Date.parse(manifest.preparedAt)) ||
        !Array.isArray(manifest.scenarios) ||
        manifest.scenarios.some(
          (scenario) =>
            !nonEmpty(scenario.interventionId) ||
            !nonEmpty(scenario.reviewPath) ||
            !nonEmpty(scenario.displayLabel) ||
            !nonEmpty(scenario.provenanceLabel),
        )
      ) {
        throw new Error(
          "Demo manifest store refused a structurally invalid manifest.",
        );
      }
      manifests.set(MANIFEST_KEY, structuredClone(manifest));
      const readBack = manifests.get(MANIFEST_KEY);
      if (
        readBack === undefined ||
        JSON.stringify(readBack) !== JSON.stringify(manifest)
      ) {
        throw new Error(
          "Demo manifest store could not read the manifest back after writing.",
        );
      }
    },
  };
}

interface GlobalWithDemoStore {
  __duelogicDevDemoManifestStore?: ManifestMap;
}

/**
 * The shared development repository used by the demo route and the Demo
 * Setup page: one in-memory map per process, surviving hot reloads but
 * not restarts.
 */
export function getDevDemoManifestRepository(): DemoManifestRepository {
  const holder = globalThis as GlobalWithDemoStore;
  holder.__duelogicDevDemoManifestStore ??= new Map();
  return createInMemoryDemoManifestRepository(
    holder.__duelogicDevDemoManifestStore,
  );
}
