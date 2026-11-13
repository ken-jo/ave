import { afterEach, describe, expect, it, vi } from "vitest";
import { connectedSkillClient, SkillServerTransport } from "../../__tests__/support/mcp-skills-server.js";
import { useTempPaths as registerTempPaths } from "../../__tests__/test-helpers.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { McpClient } from "../../mcp/mcp-client.js";
import { ToolExecutor } from "../executor.js";
import { createMcpResourceReadTool } from "../mcp-resource-tools.js";

const temp = registerTempPaths("resource-identity-", "permissions.json");
const clients: McpClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.disconnect())); });

describe("ordinary resource identity across catalog, admission and transport", () => {
  it.each(["schema", "ScHeMa", "SCHEMA", "git", "Git", "a+B.c"].flatMap((scheme) =>
    [false, true].map((rewritten) => ({ scheme, rewritten }))))("reads the listed $scheme URI verbatim with hook rewrite $rewritten", async ({ scheme, rewritten }) => {
    const uri = `${scheme}://public/ReadMe-한글.md`;
    const server = new SkillServerTransport();
    server.files.set(uri, "ordinary resource data");
    server.response = (method) => method === "resources/list" ? {
      resultType: "complete", ttlMs: 60_000, cacheScope: "private", resources: [{ uri, name: "public" }],
    } : undefined;
    const { client, registry } = await connectedSkillClient(server);
    clients.push(client);
    expect(client.getSkillEntries()).toEqual([]);
    expect(client.getState().resources).toEqual([expect.objectContaining({ uri })]);
    const dispatch = vi.fn((_serverId: string, requestedUri: string) => client.readDeclaredResource(requestedUri));
    registry.register(createMcpResourceReadTool(() => ({ listResources: () => [], readDeclaredResource: dispatch })));
    const executor = new ToolExecutor(registry, undefined, new PermissionManager(temp()));
    const admission = vi.fn((_sessionId: string | undefined, _name: string, _input: Record<string, unknown>) => undefined);
    executor.setSkillAdmissionCheck(admission);
    const requested = { serverId: " docs-server ", uri: `\t${uri}\n` };
    if (rewritten) {
      executor.getHookRunner().registerPreHook("select-listed-resource", () => ({ action: "modify", updatedInput: requested }));
    }
    const [result] = await executor.executeAll([{ id: "listed", name: "mcp_resource_read", input: rewritten
      ? { serverId: "docs-server", uri: "schema://different" } : requested }],
    { sessionId: "resource-chat", permissionContext: { trustOrigin: "user-keyboard" } });
    expect(result.is_error).not.toBe(true);
    expect(result.content).toContain("ordinary resource data");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("docs-server", uri);
    expect(server.requests.filter((request) => request.method === "resources/read")).toEqual([
      { method: "resources/read", params: expect.objectContaining({ uri }) },
    ]);
    expect(admission).toHaveBeenCalled();
    for (const [, , input] of admission.mock.calls) expect(input).toEqual({ serverId: "docs-server", uri });
  });
});
