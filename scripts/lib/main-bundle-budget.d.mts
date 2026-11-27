interface BundleOutput {
  readonly bytes: number;
}

interface AnalyzedBundleOutput extends BundleOutput {
  readonly entryPoint?: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly imports?: readonly { path: string; kind: string; external?: boolean }[];
}

interface BundleBudgetInputs {
  entryBytes: number;
  initialBytes: number;
  lazyAllowanceBytes: number;
}

interface BundleBudgets extends BundleBudgetInputs {
  totalBytes: number;
}

type BudgetCandidates = Partial<Record<keyof BundleBudgets, unknown>> | null | undefined;

interface BundleMeasurement {
  entryBytes: number;
  initialBytes: number;
  totalBytes: number;
  asyncBytes: number;
  initialFiles: number;
  totalFiles: number;
  hasRequiredAsyncBoundary: boolean;
  requiredAsyncEntryIsInitial: boolean;
  legacyInitialReduction: number;
}

export const MAIN_BUNDLE_ROOT_FILES: readonly string[];
export const MAIN_BUNDLE_BUDGETS: Readonly<BundleBudgets>;

export function isMainBundleRootScriptPath(path: unknown): boolean;
export function findUnexpectedMainBundleRootScripts(paths: readonly string[], manifestPaths: Iterable<string>): string[];
export function isSafeMainBundleManifestPath(path: unknown): boolean;

export function createMainBundleBudgets(inputs: BundleBudgetInputs): Readonly<BundleBudgets>;
export function analyzeMainBundleMetafile(
  metafile: { outputs: Readonly<Record<string, AnalyzedBundleOutput>> },
  options: { entryPoint: string; requiredAsyncEntryPoint: string },
): BundleMeasurement;
export function assertMainBundleBudget(measurement: BundleMeasurement, budgets: BudgetCandidates): void;
export function formatMainBundleSummary(measurement: BundleMeasurement, budgets: BudgetCandidates): string;
export function formatMainBundleBudget(measurement: BundleMeasurement): string;

export function createMainBundleManifest(
  metafile: { outputs: Readonly<Record<string, BundleOutput>> },
  options: { outdir: string; absWorkingDir?: string },
): { schemaVersion: 1; entry: "main.js"; files: { path: string; bytes: number }[] };
