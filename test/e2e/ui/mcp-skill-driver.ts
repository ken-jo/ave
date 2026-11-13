import { connectedSkillClient, skillBundle, SkillServerTransport } from "../../../src/__tests__/support/mcp-skills-server.js";
import { mcpSkillSelector } from "../../../src/shared/mcp-skill-selector.js";
import type { AppServices } from "../../../src/boot/types.js";
import type { McpClient } from "../../../src/mcp/mcp-client.js";

export async function installSkillDriver(services: AppServices, sessionId: string) {
  const server = new SkillServerTransport();
  const bundle = skillBundle(); server.publish(bundle);
  const { client } = await connectedSkillClient(server);
  // A fixture transport replaces remote I/O; the app's real catalog, loader and approval gate remain in use.
  (services.mcpManager as unknown as { clients: Map<string, McpClient> }).clients.set("docs-server", client);
  const load = services.toolRegistry.findByName("skill_load");
  if (!load) throw new Error("Skill loader is unavailable");
  const state = { complete: false, output: "", isError: false, reads: 0 };
  return {
    state,
    async stop() {
      services.approvalGate?.disposeAll();
      await client.disconnect();
      (services.mcpManager as unknown as { clients: Map<string, McpClient> }).clients.delete("docs-server");
    },
    start() {
      state.complete = false;
      void load.execute({ skillName: mcpSkillSelector("docs-server", bundle.skill.uri) }, {
        cwd: process.cwd(), extraAllowedDirectories: [], metadata: { sessionId },
      }).then((result) => {
        state.output = result.output; state.isError = result.isError === true;
        state.reads = server.requests.filter((request) => request.method === "resources/read").length;
        state.complete = true;
      }).catch((error: unknown) => { state.output = String(error); state.isError = true; state.complete = true; });
    },
  };
}
