import { appendFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";

export function windowsTestFileMarkers(env = process.env, platform = process.platform) {
  if (platform !== "win32" || env.GITHUB_ACTIONS !== "true" ||
      env.AVE_CI_WINDOWS_TEST_FILE_MARKERS !== "1" || !env.RUNNER_TEMP) return undefined;
  const directory = join(env.RUNNER_TEMP, "windows-launch-diagnostic");
  function mark(phase, module, ordering) {
    try {
      const time = new Date().toISOString();
      const file = relative(module.project.config.root, module.moduleId).replaceAll("\\", "/");
      mkdirSync(directory, { recursive: true });
      appendFileSync(join(directory, "test-files.jsonl"), JSON.stringify({ time, phase, file, ordering }) + "\n");
    } catch {
      // A diagnostic write must not fail a test or change its result.
    }
  }
  return {
    onTestModuleQueued: module => mark("queued-host-receipt", module,
      "Host receipt may follow module import and top-level execution"),
    onTestModuleStart: module => mark("execution-start", module),
    onTestModuleEnd: module => mark("execution-finish", module),
  };
}
