import { appendFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";

export function windowsTestFileMarkers(env = process.env) {
  if (env.AVE_CI_WINDOWS_TEST_FILE_MARKERS !== "1" || !env.RUNNER_TEMP) return undefined;
  const directory = join(env.RUNNER_TEMP, "windows-launch-diagnostic");
  function mark(event, module) {
    try {
      const time = new Date().toISOString();
      const file = relative(module.project.config.root, module.moduleId).replaceAll("\\", "/");
      mkdirSync(directory, { recursive: true });
      appendFileSync(join(directory, "test-files.jsonl"), JSON.stringify({ time, event, file }) + "\n");
    } catch {
      // A diagnostic write must not fail a test or change its result.
    }
  }
  return {
    onTestModuleStart: module => mark("start", module),
    onTestModuleEnd: module => mark("finish", module),
  };
}
