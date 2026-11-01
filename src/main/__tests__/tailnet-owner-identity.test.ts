import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as ts from "typescript/unstable/ast";
import { parseSourceTexts } from "../../../scripts/lib/ts7-ast.mjs";
import { readTailnetOwnerLogin, tailnetOwnerLoginFromStatus } from "../tailnet-owner-identity.js";

const native = vi.hoisted(() => ({ read: vi.fn(), path: vi.fn(() => "host-cli"), warn: vi.fn() }));
vi.mock("../tailnet-cli.js", () => ({ runTailscaleCommand: native.read, tailscaleCliPath: native.path }));
vi.mock("../../lib/logger.js", () => ({ createLogger: () => ({ warn: native.warn }) }));
afterEach(() => { native.read.mockReset(); native.warn.mockClear(); native.path.mockClear(); });
const status = { BackendState: "Running", Self: { UserID: 7 }, User: { "7": { LoginName: "owner@example.test" }, "8": { LoginName: "peer@example.test" } } };

describe("local node owner identity", () => {
  it("selects only the local node user profile independently of peer identity fields", () => {
    expect(tailnetOwnerLoginFromStatus({ ...status, LoginName: "peer@example.test", headers: { "tailscale-user-login": "peer@example.test" }, Peer: { peer: { UserID: 8 } } })).toBe("owner@example.test");
    expect(tailnetOwnerLoginFromStatus({ ...status, Self: { UserID: "7" } })).toBe("owner@example.test");
  });
  it.each([null, {}, { ...status, BackendState: "NeedsLogin" }, { ...status, Self: { UserID: 0 } }, { ...status, Self: { UserID: 8, Tags: ["tag:server"] } }, { ...status, User: {} }, { ...status, User: { "7": { LoginName: " " } } }])("rejects missing, stopped, tagged or malformed local ownership: %j", value => {
    expect(tailnetOwnerLoginFromStatus(value)).toBeNull();
  });
  it("awaits a fresh shared command runner for every observation", async () => {
    native.read.mockResolvedValueOnce({ kind: "ran", code: 0, stdout: JSON.stringify(status), stderr: "" })
      .mockResolvedValueOnce({ kind: "ran", code: 0, stdout: JSON.stringify({ ...status, Self: { UserID: 8 } }), stderr: "" });
    await expect(readTailnetOwnerLogin()).resolves.toBe("owner@example.test");
    await expect(readTailnetOwnerLogin()).resolves.toBe("peer@example.test");
    expect(native.read).toHaveBeenCalledTimes(2);
    expect(native.path).toHaveBeenCalledWith(process.platform);
    expect(native.read).toHaveBeenCalledWith("host-cli", ["status", "--json"]);
    expect(native.warn).not.toHaveBeenCalled();
  });
  it.each([
    [{ kind: "not-found" }, "ENOENT"],
    [{ kind: "failed", category: "timeout", detail: "private owner@example.test" }, "timeout"],
    [{ kind: "failed", detail: "private owner@example.test" }, "execution-failed"],
    [{ kind: "ran", code: 1, stdout: "private owner@example.test", stderr: "private" }, "nonzero-exit"],
    [{ kind: "ran", code: 0, stdout: "private owner@example.test", stderr: "" }, "invalid-json"],
    [{ kind: "ran", code: 0, stdout: JSON.stringify({ ...status, Self: { UserID: 0 } }), stderr: "" }, "owner-unavailable"],
  ])("refuses unavailable evidence and logs only its category: %j", async (result, category) => {
    native.read.mockResolvedValueOnce(result);
    await expect(readTailnetOwnerLogin()).resolves.toBeNull();
    expect(native.warn).toHaveBeenCalledWith("Owner identity probe unavailable: %s", category);
    expect(JSON.stringify(native.warn.mock.calls)).not.toMatch(/private|owner@example/);
  });
  it("permits only asynchronous process imports throughout the identity probe path", () => {
    const processImports: string[] = [];
    for (const file of ["tailnet-owner-identity.ts", "tailnet-cli.ts"]) {
      const source = readFileSync(new URL("../" + file, import.meta.url), "utf8");
      const syntax = parseSourceTexts(new Map([[file, source]])).get(file) as ts.SourceFile;
      expect(syntax).toBeDefined();
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /^(?:node:)?child_process$/.test(node.moduleSpecifier.text)) {
          const bindings = node.importClause?.namedBindings;
          expect(bindings && ts.isNamedImports(bindings)).toBe(true);
          if (bindings && ts.isNamedImports(bindings)) {
            processImports.push(...bindings.elements.map(element => (element.propertyName ?? element.name).text));
          }
        }
        if (ts.isCallExpression(node) && node.arguments.some(argument => ts.isStringLiteral(argument) && /^(?:node:)?child_process$/.test(argument.text))) {
          throw new Error("Process execution must use reviewed static imports");
        }
        if (ts.isIdentifier(node)) expect(node.text).not.toMatch(/^(?:execFileSync|execSync|spawnSync)$/);
        node.forEachChild(visit);
      };
      visit(syntax);
    }
    expect(processImports).toEqual(["execFile"]);
  });
});
