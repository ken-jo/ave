import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";
import { PermissionManager } from "../permission-manager.js";

it("a scheduled stage session in Allow mode is denied a secret-file read and never asks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unattended-interim-"));
  try {
    const manager = new PermissionManager(join(dir, "permissions.json"));
    manager.setMode("allow");
    const path = join(dir, ".env");
    const context = { paths: [{ lexical: path, canonical: path, effect: "read" as const }] };
    const check = () => manager.checkDetailed("read_file", "builtin", "read", undefined, context);
    expect(check().decision).toBe("allow");
    const request = turnExtensionPolicyContext.run({
      allowExternalHooks: false, unattendedStage: true, withholdSessionAuthority: true,
    }, check);
    expect(request).toMatchObject({ decision: "deny", pipelineRequest: { headless: true, mode: "strict" } });
    expect(request.reason).toContain("do not retry");
    expect(check().decision).toBe("allow");
  } finally {
    await cleanupTmpDir(dir);
  }
});
