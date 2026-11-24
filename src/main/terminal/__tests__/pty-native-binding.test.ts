// Exercise the real ABI-stable native loader under the desktop test runtime; packaged checks use the same resolved binding directory.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const nodeRequire = createRequire(import.meta.url);

// The test runtime removes versions.electron; assert the surviving executable and run-as-node markers to keep native ABI checks meaningful.
function electronRuntimeMarkers(): { executable: string; runAsNode?: string } {
  return {
    executable: basename(process.execPath).toLowerCase(),
    runAsNode: process.env.ELECTRON_RUN_AS_NODE,
  };
}

interface NodePtyUtils {
  loadNativeModule: (name: string) => {
    dir: string;
    module: Record<string, unknown>;
  };
}

// Assert exports used by the installed terminal implementation on this platform; Windows and POSIX bindings have different surfaces.
const REQUIRED_BINDING_EXPORTS = process.platform === "win32"
  ? ["startProcess", "resize", "kill"]
  : ["fork", "open", "process", "resize"];

const utilsPath = nodeRequire.resolve("node-pty/lib/utils.js");
const ptyModuleRoot = resolve(dirname(utilsPath), "..");
const prebuildDir = join(
  ptyModuleRoot,
  "prebuilds",
  `${process.platform}-${process.arch}`,
);

describe("node-pty native binding", () => {
  it("loads through node-pty's own loader under the Electron runtime", () => {
    expect(electronRuntimeMarkers()).toEqual({
      executable: expect.stringMatching(/^electron(\.exe)?$/u),
      runAsNode: "1",
    });

    const utils = nodeRequire(utilsPath) as NodePtyUtils;
    const loaded = utils.loadNativeModule("pty");

    expect(Object.keys(loaded.module)).toEqual(
      expect.arrayContaining(REQUIRED_BINDING_EXPORTS),
    );
  });

  it("resolves the binding from one of node-pty's documented search dirs", () => {
    const utils = nodeRequire(utilsPath) as NodePtyUtils;
    const loaded = utils.loadNativeModule("pty");

    // `loadNativeModule` returns a relative dir ("../build/Release/") resolved against node-pty's `lib`; normalise it to an absolute path so this asserts
    // the same directory `electron-after-pack` reasons about.
    const resolvedDir = resolve(dirname(utilsPath), loaded.dir);
    expect([
      join(ptyModuleRoot, "build", "Release"),
      join(ptyModuleRoot, "build", "Debug"),
      prebuildDir,
    ]).toContain(resolvedDir);
  });

  it.runIf(existsSync(prebuildDir))(
    "dlopens the vendor prebuild itself under Electron (no per-ABI compile)",
    () => {
      // The claim that makes the postinstall `electron-rebuild` unnecessary: the binary Microsoft publishes — built against Node headers, never against
      // Electron's — loads in this Electron process. Loaded directly so a stale `build/Release` shadowing it cannot mask a broken prebuild.
      expect(electronRuntimeMarkers().runAsNode).toBe("1");
      const prebuilt = nodeRequire(join(prebuildDir, "pty.node")) as Record<
        string,
        unknown
      >;

      expect(Object.keys(prebuilt)).toEqual(
        expect.arrayContaining(REQUIRED_BINDING_EXPORTS),
      );
    },
  );
});
