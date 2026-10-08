import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { InstalledAgentPlugin } from "../../marketplace/content/service.js";
import { AgentProfileStore } from "../agent-profile-store.js";
import { SkillOverlay } from "../skill-overlay.js";
import { SkillStore } from "../skill-store.js";
import { createSkillReadTool } from "../../tools/skill-read.js";
import type { ToolExecutionContext } from "../../tools/base.js";

function agentPlugin(name: string, version: string, digest: string): InstalledAgentPlugin {
  return {
    name, version,
    content: {
      kind: "agent-plugin",
      components: {
        skills: [{ name: "review", hasScripts: false, digest }],
        mcpServers: {}, prompts: [], agents: [{ name: "review", digest }], routineTemplates: [], hooks: [],
      },
      files: [
        { path: "skills/review/SKILL.md", data: Buffer.from(`---\nname: review\ndescription: Review from ${name}\n---\nSkill from ${name}`) },
        { path: "skills/review/references/guide.md", data: Buffer.from(`Resource from ${name}`) },
        { path: "ai.agent-connector.ave/agents/review/AGENTS.md", data: Buffer.from(`---\nname: review\ndescription: Profile from ${name}\n---\nAgent from ${name}`) },
      ],
    },
  };
}

describe("installed agent plugin instructions", () => {
  it("keeps package skills and profiles separate from user names and one another", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-agent-plugin-instructions-"));
    try {
      writeFileSync(join(dir, "review.md"), "---\nname: review\ndescription: User\n---\nUser body");
      const skills = new SkillStore({ userDir: dir });
      const agents = new AgentProfileStore({ userDir: dir });
      const packages = [agentPlugin("first", "1.0.0", "a".repeat(64)), agentPlugin("second", "1.0.0", "b".repeat(64))];
      skills.setInstalledAgentPlugins(packages);
      agents.setInstalledAgentPlugins(packages);
      expect((await skills.load("review"))?.body).toBe("User body");
      expect((await skills.load("agent-plugin:first:review"))?.body).toBe("Skill from first");
      expect((await skills.load("agent-plugin:second:review"))?.body).toBe("Skill from second");
      expect(skills.listCatalogSync().map((item) => item.name)).toEqual(["review", "agent-plugin:first:review", "agent-plugin:second:review"]);
      expect((await agents.load("agent-plugin:first:review"))?.body).toBe("Agent from first");
      expect((await agents.load("agent-plugin:second:review"))?.body).toBe("Agent from second");
      const first = await skills.load("agent-plugin:first:review");
      expect(first?.resources).toEqual([{ path: "references/guide.md", bytes: 19 }]);
      const overlay = new SkillOverlay();
      overlay.register("session-x", first!);
      const tool = createSkillReadTool({ store: skills, overlay });
      const context = { cwd: dir, extraAllowedDirectories: [], metadata: { sessionId: "session-x" } } as ToolExecutionContext;
      const resource = await tool.execute({ skillName: first!.name, resourcePath: "references/guide.md" }, context);
      expect(resource.isError).toBe(false);
      expect(JSON.parse(resource.output).content).toBe("Resource from first");
      skills.setInstalledAgentPlugins([agentPlugin("first", "2.0.0", "c".repeat(64))]);
      agents.setInstalledAgentPlugins([]);
      const changed = await tool.execute({ skillName: first!.name, resourcePath: "references/guide.md" }, context);
      expect(changed.isError).toBe(true);
      expect(changed.output).toContain("changed since load");
      expect(await skills.load("agent-plugin:second:review")).toBeNull();
      expect(await agents.load("agent-plugin:first:review")).toBeNull();
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});
