// The default project is an ordinary project scope end to end: idle maintenance builds its own overview and its prompt carries it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import {
  MemoryConsolidationService,
  MemoryMaintenanceCoordinator,
  sessionMemoryProject,
} from "../memory-consolidation-service.js";
import { SystemPromptBuilder } from "../../prompts/system-prompt-builder.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createMemoryReviewer } from "./memory-reviewer-test-helpers.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const DEFAULT_ROOT = "C:\\workspace\\default";

let dir: string;
let memoryManager: MemoryManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-default-overview-"));
  memoryManager = new MemoryManager({ aveDir: dir });
});

afterEach(async () => {
  memoryManager.stopPersistentContextWatcher();
  memoryManager.sessions.closeSearchIndex();
  await cleanupTmpDir(dir);
});

describe("default project long-term overview wiring", () => {
  it("builds the default project's overview on idle and puts it in that project's prompt", async () => {
    await memoryManager.saveMemory("Default rule", "Default project uses pnpm.", {
      projectRoot: DEFAULT_ROOT, projectName: "default", kind: "fact",
    }, "user");
    const memoryReviewer = createMemoryReviewer(async () => "DEFAULT-PROJECT-OVERVIEW: pnpm");
    const memoryConsolidationService = new MemoryConsolidationService({
      memoryManager,
      memoryReviewer,
      isIdleConsolidationEnabled: () => true,
    });
    // The same shape the default-project conversation loop reports.
    const loop = {
      getSessionProjectContext: () => ({ projectRoot: DEFAULT_ROOT, projectName: "default" }),
      getSessionProjectIsDefault: () => true,
    };
    const coordinator = new MemoryMaintenanceCoordinator({
      preferenceRefreshService: { runOnIdle: async () => undefined },
      memoryConsolidationService,
      getCurrentProject: () => sessionMemoryProject(loop),
    });

    await coordinator.runOnIdle();

    const snapshot = memoryManager.getConsolidationSnapshot({ projectRoot: DEFAULT_ROOT });
    expect(memoryManager.getConsolidatedMemoryOverview(snapshot)?.content).toContain("DEFAULT-PROJECT-OVERVIEW");

    const builder = new SystemPromptBuilder({ memoryManager, toolRegistry: new ToolRegistry() });
    builder.setProjectContext({ projectRoot: DEFAULT_ROOT, projectName: "default", isDefault: true });
    expect(builder.build()).toContain("DEFAULT-PROJECT-OVERVIEW");
  });
});
