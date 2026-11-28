import { isCanonicalGitPath } from "../hooks/pre-push-markdown-policy.mjs";

export const MUST_RUN_TESTS_PATH = "config/ci-must-run-tests.json";

// Directory entries expand to collected tests; stale entries selecting nothing fail.
export function expandMustRunTests(document, trackedTests, changedPaths) {
  const groups = document?.groups;
  if (!groups || typeof groups !== "object" || Array.isArray(groups)) {
    throw new Error(`${MUST_RUN_TESTS_PATH} must hold a "groups" object`);
  }
  const triggers = document.triggers ?? {};
  if (!triggers || typeof triggers !== "object" || Array.isArray(triggers)) throw new Error("must-run triggers must be an object");
  for (const [group, paths] of Object.entries(triggers)) {
    if (!Object.hasOwn(groups, group) || !Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string" || !isCanonicalGitPath(path.replace(/\/$/u, "")))) {
      throw new Error(`invalid must-run triggers for ${group}`);
    }
  }
  const selected = new Set();
  for (const [group, entries] of Object.entries(groups)) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`${MUST_RUN_TESTS_PATH} group "${group}" must list at least one path`);
    }
    for (const entry of entries) {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new Error(`${MUST_RUN_TESTS_PATH} group "${group}" holds a non-path entry`);
      }
      const matches = entry.endsWith("/")
        ? trackedTests.filter((test) => test.startsWith(entry))
        : trackedTests.filter((test) => test === entry);
      if (matches.length === 0) {
        throw new Error(`${MUST_RUN_TESTS_PATH} group "${group}" entry ${entry} selects no collected test file`);
      }
      const triggered = changedPaths === undefined || !Object.hasOwn(triggers, group)
        || changedPaths.some((path) => triggers[group].some((prefix) => path.startsWith(prefix)));
      if (triggered) for (const test of matches) selected.add(test);
    }
  }
  if (selected.size === 0) throw new Error(`${MUST_RUN_TESTS_PATH} must select at least one collected test file`);
  return [...selected].sort();
}
