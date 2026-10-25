import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The line ceiling is a runaway backstop. Split modules at ownership boundaries, never to meet a line budget. */
const MAX_IMPLEMENTATION_LINES = 20_000;

const scopedModules = [
  // The turn loop owns its meta-tool intercepts and cross-agent gate.
  "src/engine/turn/query-loop.ts",
  // The runtime inheritance chain shares one object and one ownership boundary.
  "src/plugins/runtime/index.ts",
  "src/preload/internal-surface.ts",
  "src/preload/internal-api-surface.ts",
  "src/data/settings-store.ts",
  "src/data/settings-defaults.ts",
  "src/data/settings-normalization.ts",
  "src/ui/renderer/components/ChatSidePanel.tsx",
  "src/ui/renderer/components/ChatSidePanelPreview.tsx",
  "src/ui/renderer/components/ChatSidePanelLayout.tsx",
  "src/ui/renderer/components/ChatSidePanelWorkspaces.tsx",
] as const;

describe("large module ownership boundaries", () => {
  it.each(scopedModules)("keeps %s below the runaway ceiling", (modulePath) => {
    const source = readFileSync(resolve(process.cwd(), modulePath), "utf8");
    const lines = source.split(/\r?\n/).length;
    expect(lines, `${modulePath} has ${lines} lines`).toBeLessThanOrEqual(MAX_IMPLEMENTATION_LINES);
  });
});
