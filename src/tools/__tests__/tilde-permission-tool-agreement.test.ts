vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));
import { vi } from "vitest";

import { describe, expect, it, afterEach } from "vitest";
import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";

import { extractTargetFilePaths } from "../pipeline/path-extraction.js";
import { DeleteFileTool, EditFileTool, WriteFileTool } from "../file-tools.js";
import { expandLeadingTilde } from "../../shared/home-tilde.js";
import { setProcessPlatform as setPlatform } from "../../__tests__/test-helpers.js";

// Drive permission extraction and approval-key resolution from the same real tool and input to verify path agreement.

const CWD = pathResolve(process.cwd());

type PathTool = WriteFileTool | EditFileTool | DeleteFileTool;

function permissionTarget(tool: PathTool, input: object): string | undefined {
  return extractTargetFilePaths(tool, input, CWD)[0];
}

function toolTarget(tool: PathTool, input: object): string {
  return tool.approvalCacheKey(input, { cwd: CWD }).replace(/^path:/, "");
}

const realPlatform = process.platform;
afterEach(() => setPlatform(realPlatform));

describe("tilde expansion — the permission target and the tool target are one string", () => {
  // Mutating file tools expose approval keys; read_file shares their base path expansion without declaring a key.
  for (const [label, tool] of [
    ["write_file", new WriteFileTool()],
    ["edit_file", new EditFileTool()],
    ["delete_file", new DeleteFileTool()],
  ] as [string, PathTool][]) {
    describe(label, () => {
      it("declares a `path` field, so the permission extraction is not vacuous", () => {
        expect(tool.pathFields).toContain("path");
        expect(permissionTarget(tool, { path: "~/Documents/x" })).toBeDefined();
      });

      it("agrees on bare `~`", () => {
        const input = { path: "~" };
        expect(permissionTarget(tool, input)).toBe(toolTarget(tool, input));
        expect(toolTarget(tool, input)).toBe(pathResolve(homedir()));
      });

      it("agrees on `~/` (separator on every platform)", () => {
        const input = { path: "~/Documents/x" };
        expect(permissionTarget(tool, input)).toBe(toolTarget(tool, input));
        expect(toolTarget(tool, input)).toBe(pathResolve(homedir(), "Documents/x"));
      });

      it("agrees on `~\\` — the regression this consolidation closes", () => {
        const input = { path: "~\\Documents\\x" };
        expect(permissionTarget(tool, input)).toBe(toolTarget(tool, input));
      });

      it("agrees on `~\\.ssh\\id_rsa` — a sensitive-table target", () => {
        const input = { path: "~\\.ssh\\id_rsa" };
        expect(permissionTarget(tool, input)).toBe(toolTarget(tool, input));
      });

      it("agrees on a non-tilde relative path (no behaviour change)", () => {
        const input = { path: "src/index.ts" };
        expect(permissionTarget(tool, input)).toBe(toolTarget(tool, input));
        expect(toolTarget(tool, input)).toBe(pathResolve(CWD, "src/index.ts"));
      });

      // Check both Windows and POSIX so platform-specific tilde expansion cannot drift.
      for (const platform of ["win32", "linux"] as const) {
        it(`agrees on \`~\\\` with platform=${platform}`, () => {
          setPlatform(platform);
          const input = { path: "~\\Documents\\x" };
          expect(permissionTarget(tool, input)).toBe(toolTarget(tool, input));
        });

        it(`agrees on \`~/\` with platform=${platform}`, () => {
          setPlatform(platform);
          const input = { path: "~/Documents/x" };
          expect(permissionTarget(tool, input)).toBe(toolTarget(tool, input));
        });
      }

      it("agrees on a literal `~` that is not a home reference", () => {
        const input = { path: "~notahome/x" };
        expect(permissionTarget(tool, input)).toBe(toolTarget(tool, input));
        expect(toolTarget(tool, input)).toBe(pathResolve(CWD, "~notahome/x"));
      });
    });
  }
});

describe("expandLeadingTilde — `~\\` is guarded on the platform that owns the separator", () => {
  it("expands `~\\` on win32, where `\\` IS a path separator", () => {
    setPlatform("win32");
    expect(expandLeadingTilde("~\\Documents\\x")).toBe(
      pathResolve(homedir(), "Documents\\x"),
    );
  });

  it("leaves `~\\` alone on POSIX, where `\\` is an ordinary filename character", () => {
    setPlatform("linux");
    // On POSIX, backslashes are filename data; this path stays cwd-relative.
    expect(expandLeadingTilde("~\\Documents\\x")).toBe("~\\Documents\\x");
  });

  it("expands `~` and `~/` on BOTH platforms", () => {
    for (const platform of ["win32", "linux"] as const) {
      setPlatform(platform);
      expect(expandLeadingTilde("~")).toBe(homedir());
      expect(expandLeadingTilde("~/a/b")).toBe(pathResolve(homedir(), "a/b"));
    }
  });

  it("does not touch `~user` style or a bare relative path", () => {
    for (const platform of ["win32", "linux"] as const) {
      setPlatform(platform);
      expect(expandLeadingTilde("~root/x")).toBe("~root/x");
      expect(expandLeadingTilde("src/a.ts")).toBe("src/a.ts");
    }
  });
});
