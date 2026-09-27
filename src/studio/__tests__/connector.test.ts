import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginStudioStore } from "../store.js";
import { portableStudioConnector, previewStudioConnector } from "../connector.js";
import { studioExportFiles } from "../package.js";
import { parseAgentPluginManifest } from "../../plugins/agent-plugin-manifest.js";
import { listStudioParts, resolveStudioReferences } from "../references.js";
import type { StudioConnectorCopyPreview } from "../../shared/plugin-studio.js";
import { containsStoredCredential } from "../../mcp/studio-credential-guard.js";

const originalHome = process.env.AVE_HOME;
let root: string;
let argValue: string;
const storedKey = "stored-key-sentinel";
const envValue = "VisibleEnvironmentValue123456789";

const manager = {
  getStudioConnectorSource: async () => ({
    spec: { id: "sample", transport: "stdio" as const, command: "uvx", auth: "api-key" as const, apiKeyEnv: "SAMPLE_KEY" },
    args: [argValue], env: { SAMPLE: envValue },
  }),
};

async function currentPreview(): Promise<StudioConnectorCopyPreview> {
  return previewStudioConnector(manager as never, "sample");
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ave-studio-connector-")); process.env.AVE_HOME = join(root, "home"); argValue = "studio-sample==1.0.0"; });
afterEach(async () => { if (originalHome === undefined) delete process.env.AVE_HOME; else process.env.AVE_HOME = originalHome; await rm(root, { recursive: true, force: true }); });

describe("Studio connector copying", () => {
  it("keeps installed connector identities selectable without copying their values during selection", async () => {
    const spec = { id: 'bundled:["agent-plugin","team-kit","sample"]', transport: "stdio" as const,
      command: "uvx", bundled: { kind: "agent-plugin" as const, name: "team-kit", server: "sample" } };
    const sources = { getMcpConfigs: async () => [spec] };
    expect((await listStudioParts(sources)).connectors).toEqual([{ name: spec.id, description: "stdio" }]);
    expect(await resolveStudioReferences({ name: "copy-kit", references: [{ kind: "connector", name: spec.id }] }, sources)).toEqual([]);
  });

  it("refuses connector paths that would point at missing files in the new package", async () => {
    const preview = await currentPreview();
    const spec = preview.spec;
    if (spec.transport !== "stdio") throw new Error("Expected a stdio connector fixture");
    expect(() => portableStudioConnector({ ...preview, spec: { ...spec, command: "./server/run" } }))
      .toThrow("package-local files");
    expect(() => portableStudioConnector({ ...preview,
      args: [{ ...preview.args[0]!, value: "${PLUGIN_ROOT}/server/config.json" }] })).toThrow("package-local files");
  });
  it("records exact-value digests and emits only after every item is confirmed", async () => {
    const store = new PluginStudioStore(async () => ({ digest: (await currentPreview()).specDigest, argsCount: 1, envCount: 1 }), async () => {});
    const pending = await store.writeDraft({ name: "team-kit", version: "1.0.0", description: "A team plugin",
      references: [{ kind: "connector", name: "sample" }] });
    expect(pending.connectorStatuses).toMatchObject([{ status: "needs-confirmation", argsCount: 1, envCount: 1 }]);
    expect(pending.files.map((file) => file.path)).not.toContain("mcp.json");
    const preview = await currentPreview();
    expect(preview.env[0]?.warning).toBe("Possible embedded credential");
    const partial = await store.confirmConnectorCopy("team-kit", "sample", preview, { specDigest: preview.specDigest,
      args: [{ index: 0, digest: preview.args[0]!.digest }], env: [] });
    expect(partial.connectorStatuses).toMatchObject([{ status: "needs-confirmation", confirmedArgs: 1, confirmedEnv: 0 }]);
    expect(partial.files.map((file) => file.path)).not.toContain("mcp.json");
    await expect(store.reviewDraft("team-kit", partial.treeDigest)).rejects.toThrow("confirmation");
    await expect(store.confirmConnectorCopy("team-kit", "sample", preview, { specDigest: preview.specDigest,
      args: [{ index: 0, digest: "0".repeat(64) }], env: preview.env.map(({ name, digest }) => ({ name, digest })) }))
      .rejects.toThrow("stale");
    await expect(store.confirmConnectorCopy("team-kit", "sample", { ...preview,
      args: [{ ...preview.args[0]!, value: "studio-other==1.0.0" }] }, { specDigest: preview.specDigest,
      args: preview.args.map(({ index, digest }) => ({ index, digest })),
      env: preview.env.map(({ name, digest }) => ({ name, digest })) })).rejects.toThrow("preview");
    const complete = await store.confirmConnectorCopy("team-kit", "sample", preview, { specDigest: preview.specDigest,
      args: preview.args.map(({ index, digest }) => ({ index, digest })),
      env: preview.env.map(({ name, digest }) => ({ name, digest })) });
    expect(complete.connectorStatuses).toMatchObject([{ status: "confirmed", confirmedArgs: 1, confirmedEnv: 1 }]);
    expect(complete.errors).toEqual([]);
    const files = await store.packageFiles("team-kit");
    expect(files.find((file) => file.path === "mcp.json")?.data.toString()).toContain(envValue);
    const manifest = parseAgentPluginManifest(files.find((file) => file.path === "plugin.json")!.data);
    expect(manifest.extensions?.["ai.agent-connector.ave"]?.mcpAuth).toEqual({ sample: { auth: "api-key", apiKeyEnv: "SAMPLE_KEY" } });
    expect(studioExportFiles(files, false, [storedKey]).map((file) => file.data.toString("utf8")).join("\n")).not.toContain(storedKey);
    const reviewed = await store.reviewDraft("team-kit", complete.treeDigest);
    expect(reviewed.draft.reviewed).toBeDefined();
    await store.confirmConnectorCopy("team-kit", "sample", preview, { specDigest: preview.specDigest,
      args: preview.args.map(({ index, digest }) => ({ index, digest })),
      env: preview.env.map(({ name, digest }) => ({ name, digest })) });
    expect((await store.readDraft("team-kit")).draft.reviewed).toBeUndefined();
  });

  it("invalidates a confirmed copy when the configured value changes", async () => {
    const store = new PluginStudioStore(async () => ({ digest: (await currentPreview()).specDigest, argsCount: 1, envCount: 1 }), async () => {});
    await store.writeDraft({ name: "team-kit", version: "1.0.0", description: "A team plugin",
      references: [{ kind: "connector", name: "sample" }] });
    const preview = await currentPreview();
    const confirmed = await store.confirmConnectorCopy("team-kit", "sample", preview, { specDigest: preview.specDigest,
      args: preview.args.map(({ index, digest }) => ({ index, digest })),
      env: preview.env.map(({ name, digest }) => ({ name, digest })) });
    await store.reviewDraft("team-kit", confirmed.treeDigest);
    argValue = "studio-sample==1.0.1";
    expect((await store.readDraft("team-kit")).connectorStatuses).toMatchObject([{ status: "stale" }]);
    await expect(store.reviewedFiles("team-kit")).rejects.toThrow("reviewed");
    await expect(store.packageFiles("team-kit")).rejects.toThrow("confirmation");
    await expect(store.confirmConnectorCopy("team-kit", "sample", preview, { specDigest: preview.specDigest,
      args: preview.args.map(({ index, digest }) => ({ index, digest })),
      env: preview.env.map(({ name, digest }) => ({ name, digest })) })).rejects.toThrow("source changed");
    const fresh = await currentPreview();
    await expect(store.confirmConnectorCopy("team-kit", "sample", fresh, { specDigest: preview.specDigest,
      args: preview.args.map(({ index, digest }) => ({ index, digest })), env: preview.env.map(({ name, digest }) => ({ name, digest })) }))
      .rejects.toThrow("changed");
  });

  it("checks the raw stored value again in the writer and decoded export files", async () => {
    const key = "stored-\"-credential";
    argValue = `--token=${key}`;
    const preview = await currentPreview();
    const store = new PluginStudioStore(async () => ({ digest: preview.specDigest, argsCount: 1, envCount: 1 }),
      async (_serverId, value) => {
        if (containsStoredCredential(value, key)) throw new Error("Connector copy contains its stored credential");
      });
    await store.writeDraft({ name: "team-kit", version: "1.0.0", description: "A team plugin",
      references: [{ kind: "connector", name: "sample" }] });
    await expect(store.confirmConnectorCopy("team-kit", "sample", preview, { specDigest: preview.specDigest,
      args: preview.args.map(({ index, digest }) => ({ index, digest })),
      env: preview.env.map(({ name, digest }) => ({ name, digest })) })).rejects.toThrow("stored credential");
    expect((await store.readDraft("team-kit")).files.map((file) => file.path)).not.toContain("mcp.json");

    for (const credential of [key, "stored-\\-credential", "stored-\u2028-credential", "stored-비밀-credential"]) {
      for (const location of ["env", "args"] as const) {
        const files = [
          { path: "plugin.json", data: Buffer.from(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            name: "team-kit", version: "1.0.0", description: "A team plugin" })) },
          { path: "mcp.json", data: Buffer.from(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
            mcpServers: { sample: { type: "stdio", command: "uvx", args: ["studio-sample==1.0.0",
              ...(location === "args" ? [`--token=${credential}`] : [])],
            ...(location === "env" ? { env: { VALUE: `prefix-${credential}` } } : {}) } } })) },
        ];
        if (credential === key) expect(files[1]!.data.toString()).not.toContain(credential);
        expect(() => studioExportFiles(files, false, [credential])).toThrow("stored credential");
      }
    }
  });
});
