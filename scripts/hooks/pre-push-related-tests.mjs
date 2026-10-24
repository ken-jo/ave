import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyElectronVitestResult,
  resolveElectronVitestRuntime,
  runVitestUnderElectron,
} from "../run-vitest-under-electron.mjs";

// Discover each source's import coverage without executing tests. A combined
// query would let one covered module hide another with no test importers.
export async function collectRelatedTestFiles(context, sourceFiles, repoRoot) {
  const coverage = [];
  for (const source of sourceFiles) {
    // Vitest matches `related` against its module ids, which use forward
    // slashes on every platform; a Windows backslash path matches nothing.
    context.config.related = [resolve(repoRoot, source).replaceAll("\\", "/")];
    const specifications = await context.getRelevantTestSpecifications();
    coverage.push({
      source,
      tests: [...new Set(specifications.map(({ moduleId }) => relative(repoRoot, moduleId).replaceAll("\\", "/")))].sort(),
    });
  }
  return coverage;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [mode, ...sourceFiles] = process.argv.slice(2);
    if (mode === "--collect") {
      const { createVitest } = await import("vitest/node");
      const context = await createVitest({ watch: false, run: true });
      try {
        const coverage = await collectRelatedTestFiles(context, sourceFiles, process.cwd());
        process.stdout.write(JSON.stringify(coverage));
      } finally {
        await context.close();
      }
    } else {
      const runtime = resolveElectronVitestRuntime();
      const result = await runVitestUnderElectron(["--collect", ...process.argv.slice(2)], {
        ...runtime,
        vitestPath: fileURLToPath(import.meta.url),
      });
      applyElectronVitestResult(result);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
