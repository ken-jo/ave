import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { cleanupAsrtSandboxAfterCommand, resetAsrtSandbox, wrapToolCommand } from "../../permissions/asrt-sandbox.js";
import { openEgressInvocation } from "../../permissions/egress-invocations.js";
import { parseTableDocument } from "../table-document-reader.js";

describe.skipIf(shouldSkipNativeSandboxTests())("sandbox XLSX editing", () => {
  it("edits a workbook using only its admitted project directory", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "ave-xlsx-sandbox-")));
    const path = join(directory, "budget.xlsx");
    const request = join(directory, "edits.json");
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Budget", 12]]), "Sheet");
    writeFileSync(path, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer);
    writeFileSync(request, JSON.stringify({ sheet: 0, edits: [{ cell: "B1", value: 84 }] }));
    const invocation = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: undefined,
      context: { sessionId: undefined, workspaceRoot: directory, approvalSurface: "unavailable" } });
    try {
      await initializeRequiredSandbox({ allowedDomains: [] });
      const command = ["python3", resolve("resources/skills/xlsx-edit/scripts/edit-xlsx.py"), path, request].map(shellQuote).join(" ");
      const wrapped = await wrapToolCommand(command, { commandId: invocation.token, denyUnixSockets: true,
        filesystem: { allowWrite: [directory], denyWrite: [] } });
      const result = spawnSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
        cwd: directory, env: { ...process.env, ...wrapped.env }, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
      });
      expect(result.status, result.stderr).toBe(0);
      const document = await parseTableDocument(readFileSync(path), "xlsx", 0);
      expect(document.sheet.rows).toEqual([["Budget", "84"]]);
      expect(document.needsRecalculation).toBe(true);
    } finally {
      invocation.release();
      await cleanupAsrtSandboxAfterCommand();
      await resetAsrtSandbox();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
