// Audited files whose primitive calls cannot read repository content that
// decides a test result. Each entry names the primitive classes it covers
// (listing, git, read) with a reason; the lock in run-ci-suite.test.ts fails
// once a class no longer occurs in the file. `forwards` names exported
// functions that pass their argument to an exempted primitive: a caller that
// hands them a non-literal argument counts as using that primitive itself.
// Every other file that uses a primitive makes its tests always-run.
export const UNBOUNDED_INPUT_EXEMPTIONS = {
  "src/__tests__/support/tmp-dir-teardown.ts": {
    read: "lists only the tree it removes; enumerating entries to delete cannot decide a result",
  },
  "src/__tests__/test-helpers.ts": {
    read: "readRepoFile and inspectFile read the path their caller passes",
    runtime: "temporarily changes the process platform property for a test",
    forwards: { read: ["inspectFile", "readRepoFile"] },
  },
  "src/plugins/__tests__/test-helpers.ts": {
    read: "operates on the fixture roots or signal files under them, and reads the root readPluginDataFixture is given",
    git: "invokes a fixed host executable to set or clear flags on test fixtures",
    forwards: { read: ["readPluginDataFixture"] },
  },
  "src/__tests__/support/simulated-win32-drive.ts": {
    read: "returns the bytes of a path the code under test queries through the simulated DACL reader",
  },
  "src/work-board/workflow/__tests__/stage-run-harness.ts": {
    read: "reads the work board file under the harness's temporary home",
  },
  "src/__tests__/support/terminal-markers.ts": {
    read: "checks candidate host shell executables",
    git: "invokes fixed host shell paths with the version flag",
  },
  "test/scripts/gate-script-runner.ts": {
    read: "reads package manifests above the resolved @electron/asar entry in node_modules, which the lockfile owns",
  },
  "scripts/hooks/pre-push-markdown-policy.mjs": {
    read: "reads its adjacent documentation-references.json; a change under scripts/ plans the full suite",
  },
};

// Audited temp factories. A `const maker = factory(...)` call with literal
// arguments returns a maker whose calls return a fresh temporary directory
// ("directory") or a literal file name joined onto one ("path"). The digest
// (tempHelperDigest) pins the helper and the files it covers; the lock in
// run-ci-suite.test.ts fails once any of them changes, which needs a re-audit.
export const UNBOUNDED_INPUT_TEMP_HELPERS = {
  "src/__tests__/test-helpers.ts": {
    digest: "0855c54ee4b9e934b7a120d15edf433c3eb3512cc3110c2ec52cbf9b4af6378a",
    covers: ["src/__tests__/support/tmp-dir-teardown.ts"],
    factories: { useTempDirs: "directory", useTempPaths: "path" },
    reason: "useTempDirs makers return tracker.track(mkdtempSync(join(tmpdir(), prefix))), and track returns its argument; useTempPaths makers join the factory's fileName onto one",
  },
};
