import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error standalone build utilities have no declaration output
import { assertMxcVerificationPayload, assertMxcVerificationPublish, mxcVerificationBuild, mxcVerificationEntries } from "../../scripts/lib/mxc-verification-build.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function output(enabled: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), "ave-verification-build-")); roots.push(root);
  writeFileSync(path.join(root, "bundle-manifest.json"), JSON.stringify({ mxcVerificationBuild: enabled, files: enabled ? [{ path: "mxc-packaged-probe.js" }] : [] }));
  if (enabled) writeFileSync(path.join(root, "mxc-packaged-probe.js"), "diagnostic entry bytes");
  return root;
}

describe("explicit native verification build", () => {
  it("allows verification artifacts only when publishing is disabled", () => {
    const environment = { AVE_MXC_VERIFICATION_BUILD: "1" };
    expect(() => assertMxcVerificationPublish("never", environment)).not.toThrow();
    for (const mode of ["always", "onTag", "onTagOrDraft", ""]) {
      expect(() => assertMxcVerificationPublish(mode, environment)).toThrow("Native verification builds require --publish=never");
    }
    expect(() => assertMxcVerificationPublish("always", {})).not.toThrow();
    expect(() => assertMxcVerificationPublish("always", { AVE_MXC_VERIFICATION_BUILD: "0" })).not.toThrow();
  });

  it.each([["--publish=always"], ["--publish", "onTag"]])("rejects publishing at the installer entry point before build or mutation: %s", (...publishArgs) => {
    const root = mkdtempSync(path.join(tmpdir(), "ave-verification-cli-"));
    roots.push(root);
    const guard = path.join(root, "guard.mjs");
    writeFileSync(guard, `
      import { registerHooks } from "node:module";
      registerHooks({ load(url, context, nextLoad) {
        if (url.endsWith("/scripts/hooks/spawn-command.mjs")) return {
          format: "module", shortCircuit: true,
          source: 'export function runCommand() { throw new Error("Unexpected build command"); }',
        };
        if (url.endsWith("/scripts/lib/document-consumer-guard.mjs")) return {
          format: "module", shortCircuit: true,
          source: 'export function assertPackagedDocumentInputs() { throw new Error("Unexpected packaging preflight"); }',
        };
        return nextLoad(url, context);
      }});
    `);
    const result = spawnSync(process.execPath, ["--import", guard, path.resolve("scripts/build-installers.mjs"), ...publishArgs], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AVE_MXC_VERIFICATION_BUILD: "1" },
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("[installer] FAILED: Native verification builds require --publish=never\n");
  });

  it("omits diagnostic entries by default and requires the exact explicit flag", () => {
    const root = path.resolve(".");
    expect(mxcVerificationEntries(root, {})).toEqual({});
    expect(mxcVerificationEntries(root, { AVE_MXC_VERIFICATION_BUILD: "0" })).toEqual({});
    expect(mxcVerificationEntries(root, { AVE_MXC_VERIFICATION_BUILD: "1" })).toEqual({ "mxc-packaged-probe": path.join(root, "tools/mxc-probes/packaged-main.ts") });
    expect(() => mxcVerificationBuild({ AVE_MXC_VERIFICATION_BUILD: "true" })).toThrow(/Invalid/);
  });

  it("refuses to package a prior verification build as an ordinary release", () => {
    const root = output(true);
    expect(() => assertMxcVerificationPayload(root, {})).toThrow(/record mismatch/);
    expect(() => assertMxcVerificationPayload(root, { AVE_MXC_VERIFICATION_BUILD: "1" })).not.toThrow();
    rmSync(path.join(root, "mxc-packaged-probe.js"));
    expect(() => assertMxcVerificationPayload(root, { AVE_MXC_VERIFICATION_BUILD: "1" })).toThrow(/entry/);
  });

  it("rejects an unrecorded stale diagnostic file in ordinary output", () => {
    const root = output(false);
    expect(() => assertMxcVerificationPayload(root, {})).not.toThrow();
    writeFileSync(path.join(root, "mxc-packaged-probe.js"), "stale diagnostic");
    expect(() => assertMxcVerificationPayload(root, {})).toThrow(/entry/);
  });

  it("removes stale diagnostic output and checks the flag before packaging every platform", () => {
    const build = readFileSync("scripts/build-main-esbuild.mjs", "utf8");
    expect(build).toContain('if (!mxcVerificationBuild()) rmSync(resolve(outdir, "mxc-packaged-probe.js"), { force: true });');
    const hook = readFileSync("scripts/electron-before-pack.cjs", "utf8");
    expect(hook.indexOf("assertMxcVerificationPayload(join(")).toBeLessThan(hook.indexOf('if (context.electronPlatformName !== "win32") return;'));
  });
});
