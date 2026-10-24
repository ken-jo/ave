import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import type { ConversationLoop } from "../../conversation-loop.js";
import { handlePermissionCommand } from "../commands.js";

it.each(["active", "disabled"] as const)("shows matcher refusal reasons in the %s hook list", async (state) => {
  const root = mkdtempSync(join(tmpdir(), "ave-hook-list-"));
  const hooksDir = join(root, "hooks");
  const disabledDir = join(hooksDir, ".disabled");
  const dir = state === "active" ? hooksDir : disabledDir;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pre-invalid.sh"), "#!/bin/sh\n# ave-hook-matcher: *danger*\nexit 0\n");
    writeFileSync(join(dir, "hooks.json"), JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: "*danger*", hooks: [{ type: "command", command: "./guard.sh" }] }],
    } }));
    const self = { deps: { hookTrustCommandOptions: {
      hooksDir, disabledDir, lockfilePath: join(hooksDir, ".lockfile.json"),
    } } } as ConversationLoop;
    const text = await handlePermissionCommand(self, "hooks list", "user-keyboard");
    expect(text).toContain(`- ${state} pre-invalid.sh`);
    expect(text).toContain(`- ${state} hooks.json`);
    expect(text).toMatch(/Matcher "\*danger\*".*not a valid regular expression.*hook not loaded/);
    expect(text).toMatch(/PreToolUse\[0\].matcher.*not a valid regular expression.*rejected/);
  } finally {
    await cleanupTmpDir(root);
  }
});
