// Audited files whose primitive calls cannot read repository content that
// decides a test result. Each entry names the primitive classes it covers
// with a reason and pins the source bytes of the file and its import closure.
// The lock fails when the digest drifts or the primitive class disappears. `forwards` names exported
// functions that pass their argument to an exempted primitive: a caller that
// hands them a non-literal argument counts as using that primitive itself.
// Every other file that uses a primitive makes its tests always-run.
export const UNBOUNDED_INPUT_EXEMPTIONS = {
  "src/__tests__/support/tmp-dir-teardown.ts": {
    digest: "169dc6f3bc53a9edc2bd18602b9bb099b5d536c5334557ded6bee601e9557885",
    read: "lists only the tree it removes; enumerating entries to delete cannot decide a result",
  },
  "src/__tests__/test-helpers.ts": {
    digest: "8684082cd139ee0aa8522bc80a66a0a56c865879fdadf17c74e11ee0da349264",
    read: "readRepoFile and inspectFile read the path their caller passes",
    runtime: "temporarily changes the process platform property for a test",
    forwards: { read: ["inspectFile", "readRepoFile"] },
  },
  "src/plugins/__tests__/test-helpers.ts": {
    digest: "5b6699618e5ef8c66d71b7808edd022816bde2ceea66a8cc1685715698fdaf59",
    read: "operates on the fixture roots or signal files under them, and reads the root readPluginDataFixture is given",
    git: "invokes a fixed host executable to set or clear flags on test fixtures",
    forwards: { read: ["readPluginDataFixture"] },
  },
  "src/__tests__/support/simulated-win32-drive.ts": {
    digest: "215d44ec8cc43472508de22aae8e4b05d14a3d3f87b5075f1f954c87833576d5",
    read: "returns the bytes of a path the code under test queries through the simulated DACL reader",
  },
  "src/work-board/workflow/__tests__/stage-run-harness.ts": {
    digest: "ca4cacfb66eaea16e921487525ef7542944c60a0ef0a8dee9b95f5701b62ab54",
    read: "reads the work board file under the harness's temporary home",
  },
  "src/__tests__/support/terminal-markers.ts": {
    digest: "186e3a3d30a52f5d9f78553d98dbae74a20c4f7cc70b424f619407d7be5f0632",
    read: "checks candidate host shell executables",
    git: "invokes fixed host shell paths with the version flag",
  },
  "scripts/hooks/pre-push-markdown-policy.mjs": {
    digest: "327bb1147c945ac63106d8bb3393bf968fc132a2b8cc477713fc92074fc3fce0",
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
