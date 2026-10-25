import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { stageLocalAgentPlugin } from "../../marketplace/content/store.js";
import { deriveAgentPluginComponents } from "../../marketplace/content/agent-plugin-components.js";
import { compareSemver } from "../../shared/semver-compare.js";
import { isPluginWorkerConfinementActive } from "../../permissions/asrt-sandbox.js";
import type { ComponentConsent } from "../../shared/git-marketplace.js";
import type { StudioConnectorConfirmation, StudioLocalPreview, StudioResult, StudioWriteRequest } from "../../shared/plugin-studio.js";
import { PluginStudioStore } from "../../studio/store.js";
import { readLocalAgentPlugin, studioExportFiles, studioFileText, studioZip } from "../../studio/package.js";
import { listStudioParts, resolveStudioReferences } from "../../studio/references.js";
import { previewStudioConnector } from "../../studio/connector.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { IpcDeps } from "../types.js";
import type { InstalledContentRuntime } from "./marketplace-content.js";

type Files = Awaited<ReturnType<typeof readLocalAgentPlugin>>["files"];
interface PendingInstall { files: Files; digest: string; expires: number }
const PREVIEW_LIFETIME_MS = 5 * 60_000;

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 256) throw new Error(`${label} is invalid`);
  return value;
}

function writeRequest(value: unknown): StudioWriteRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Draft request is invalid");
  const input = value as StudioWriteRequest;
  string(input.name, "name");
  if (input.version !== undefined) string(input.version, "version");
  if (input.description !== undefined) string(input.description, "description");
  if (input.files !== undefined && (!Array.isArray(input.files) || input.files.length > 256
    || input.files.some((file) => !file || typeof file.path !== "string" || typeof file.text !== "string" || file.text.length > 64 * 1024))) throw new Error("Draft files are invalid");
  if (input.removePaths !== undefined && (!Array.isArray(input.removePaths) || input.removePaths.some((path) => typeof path !== "string"))) throw new Error("Draft removed paths are invalid");
  return input;
}

function result<T>(run: () => Promise<T>): Promise<StudioResult<T>> {
  return run().then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const,
    code: error instanceof Error && /Connector (?:source|preview) changed before confirmation/u.test(error.message) ? "connector-changed" as const
      : error instanceof Error && /invalid|must|missing|changed|review|exceed|unsupported|cannot|needs|does not|conflict/i.test(error.message) ? "invalid-request" as const : "unavailable" as const,
    message: error instanceof Error ? error.message : "Studio operation failed" }));
}

export function registerPluginStudioHandlers(deps: IpcDeps, content: () => Promise<InstalledContentRuntime | null>): void {
  const store = new PluginStudioStore((serverId) => {
    if (!deps.mcpManager) throw new Error("Connector manager is unavailable");
    return deps.mcpManager.getStudioConnectorSummary(serverId);
  }, (serverId, preview) => {
    if (!deps.mcpManager) throw new Error("Connector manager is unavailable");
    return deps.mcpManager.assertStudioConnectorWriteSafe(serverId, preview);
  });
  const storedCredentials = (): Promise<string[]> => {
    if (!deps.mcpManager) throw new Error("Connector manager is unavailable");
    return deps.mcpManager.getStudioStoredCredentialValues();
  };
  const pending = new Map<string, PendingInstall>();
  const channels = CHANNELS.pluginStudio;
  const sources = { skillStore: deps.skillStore, agentProfileStore: deps.agentProfileStore,
    personaPromptStore: deps.personaPromptStore, routinesStore: deps.routinesStore, mcpManager: deps.mcpManager };
  const handle = <T>(channel: string, run: (...args: unknown[]) => Promise<T>): void => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!validateHostRendererSender(event)) {
        auditUnauthorized(deps.auditLogger, channel, event);
        return UNAUTHORIZED_FRAME;
      }
      return result(() => run(...args));
    });
  };
  const preview = (files: Files): StudioLocalPreview => {
    const staged = stageLocalAgentPlugin(files);
    const manifest = JSON.parse(files.find((file) => file.path === "plugin.json")!.data.toString("utf8")) as { description: string };
    const previewId = randomUUID();
    const expires = Date.now() + PREVIEW_LIFETIME_MS;
    pending.set(previewId, { files, digest: staged.contentSha256, expires });
    return { previewId, name: staged.plan.name, version: staged.plan.version, description: manifest.description,
      files: files.map(({ path, data }) => ({ path, text: studioFileText(data) })),
      components: deriveAgentPluginComponents(files),
      hookConfinement: isPluginWorkerConfinementActive()
        ? process.platform === "win32" ? "unavailable" : "sandboxed" : "user-permissions",
      treeDigest: staged.contentSha256, expiresAt: new Date(expires).toISOString() };
  };
  const saveExport = async (files: Files): Promise<string | null> => {
    const manifest = JSON.parse(files.find((file) => file.path === "plugin.json")!.data.toString("utf8")) as { name: string; version: string };
    const selection = await dialog.showSaveDialog({ defaultPath: `${manifest.name}-${manifest.version}.zip`, filters: [{ name: "Plugin package", extensions: ["zip"] }] });
    if (selection.canceled || !selection.filePath) return null;
    await writeFile(selection.filePath, studioZip(files), { flag: "wx" });
    return selection.filePath;
  };
  handle(channels.listDrafts, () => store.listDrafts());
  handle(channels.availableParts, () => listStudioParts(sources));
  handle(channels.readDraft, (name) => store.readDraft(string(name, "name")));
  handle(channels.writeDraft, async (input) => {
    const request = writeRequest(input);
    return store.writeDraft(request, undefined, await resolveStudioReferences(request, sources));
  });
  handle(channels.validateDraft, (name) => store.readDraft(string(name, "name")));
  handle(channels.connectorCopyPreview, (serverId) => {
    if (!deps.mcpManager) throw new Error("Connector manager is unavailable");
    return previewStudioConnector(deps.mcpManager, string(serverId, "serverId"));
  });
  handle(channels.confirmConnectorCopy, async (name, serverId, rawConfirmation) => {
    if (!deps.mcpManager) throw new Error("Connector manager is unavailable");
    if (!rawConfirmation || typeof rawConfirmation !== "object" || Array.isArray(rawConfirmation)) {
      throw new Error("Connector confirmation is invalid");
    }
    const confirmation = rawConfirmation as StudioConnectorConfirmation;
    const id = string(serverId, "serverId");
    return store.confirmConnectorCopy(string(name, "name"), id, await previewStudioConnector(deps.mcpManager, id), confirmation);
  });
  handle(channels.importPackage, async () => {
    const selection = await dialog.showOpenDialog({ properties: ["openFile", "openDirectory"], filters: [{ name: "Plugin package", extensions: ["zip"] }] });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return store.importPackage(selection.filePaths[0]);
  });
  handle(channels.reviewDraft, (name, digest) => store.reviewDraft(string(name, "name"), string(digest, "digest")));
  handle(channels.exportDraft, async (name, legacyProjection) => {
    if (typeof legacyProjection !== "boolean") throw new Error("Projection choice is invalid");
    const path = await saveExport(studioExportFiles(await store.reviewedFiles(string(name, "name")), legacyProjection,
      await storedCredentials()));
    if (!path) return null;
    await store.markShared(string(name, "name"));
    return path;
  });
  handle(channels.exportInstalled, async (name, legacyProjection) => {
    const installedName = string(name, "name");
    if (typeof legacyProjection !== "boolean") throw new Error("Projection choice is invalid");
    const runtime = await content();
    if (!runtime) throw new Error("Installed content is unavailable");
    const loaded = await runtime.store.load();
    const item = loaded.loaded.find(({ entry, content: entryContent }) => entry.kind === "agent-plugin"
      && entry.name === installedName && entryContent.kind === "agent-plugin");
    if (!item || item.content.kind !== "agent-plugin") throw new Error(`Installed plugin ${installedName} is unavailable`);
    return saveExport(studioExportFiles(item.content.files, legacyProjection, await storedCredentials()));
  });
  handle(channels.exportToCheckout, async (name) => {
    const draftName = string(name, "name");
    const files = studioExportFiles(await store.reviewedFiles(draftName), false, await storedCredentials());
    const selection = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Choose a marketplace checkout" });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const root = selection.filePaths[0];
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !(await lstat(join(root, ".git")).then(() => true, () => false))) {
      throw new Error("Select a git checkout root");
    }
    const parent = join(root, "agent-plugins");
    const existingParent = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existingParent?.isSymbolicLink() || (existingParent && !existingParent.isDirectory())) throw new Error("Package destination is not a directory");
    const target = join(parent, draftName);
    if (await lstat(target).then(() => true, () => false)) throw new Error("Package destination already exists");
    await mkdir(parent, { recursive: true });
    await mkdir(target);
    for (const file of files) {
      const path = join(target, ...file.path.split("/"));
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, file.data, { flag: "wx" });
    }
    await store.markShared(draftName);
    return { path: target, steps: ["Run the repository checker", "Review and commit the package", "Open a pull request"] };
  });
  handle(channels.previewInstallFromFile, async () => {
    const selection = await dialog.showOpenDialog({ properties: ["openFile", "openDirectory"], filters: [{ name: "Plugin package", extensions: ["zip"] }] });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const local = await readLocalAgentPlugin(selection.filePaths[0]);
    return preview(local.files);
  });
  handle(channels.previewInstallDraft, async (name) => preview(await store.installableFiles(string(name, "name"))));
  handle(channels.installFromFile, async (rawId, rawApprovals) => {
    const previewId = string(rawId, "previewId");
    const selected = pending.get(previewId);
    pending.delete(previewId);
    if (!selected || selected.expires < Date.now()) throw new Error("Install preview expired; review the package again");
    if (!Array.isArray(rawApprovals)) throw new Error("Component approvals are invalid");
    const staged = stageLocalAgentPlugin(selected.files);
    if (staged.contentSha256 !== selected.digest) throw new Error("Package changed since install preview");
    const runtime = await content();
    if (!runtime) throw new Error("Installed content is unavailable");
    const installed = runtime.store.installed("agent-plugin", staged.plan.name);
    if (installed?.sourceId === null && installed.version && compareSemver(staged.plan.version, installed.version) <= 0) {
      throw new Error("A local plugin update needs a higher version");
    }
    if (staged.content.kind !== "agent-plugin") throw new Error("Local install is not an agent plugin");
    const components = staged.content.components;
    const seenMcp = new Set<string>();
    const seenHooks = new Set<number>();
    const componentConsents: ComponentConsent[] = rawApprovals.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Component approval is invalid");
      if ("kind" in item) {
        if (item.kind !== "hook" || !Number.isInteger(item.index) || typeof item.digest !== "string"
          || components.hooks[item.index]?.digest !== item.digest || seenHooks.has(item.index)
          || (isPluginWorkerConfinementActive() && process.platform === "win32")) {
          throw new Error("Hook approval does not match the reviewed package or available confinement");
        }
        seenHooks.add(item.index);
        return { kind: "hook", index: item.index, digest: item.digest };
      }
      if (typeof item.name !== "string" || typeof item.digest !== "string"
        || components.mcpServers[item.name]?.digest !== item.digest || seenMcp.has(item.name)) {
        throw new Error("MCP approval does not match the reviewed package");
      }
      seenMcp.add(item.name);
      return { name: item.name, digest: item.digest };
    });
    await runtime.store.install(staged, { componentConsents });
    await runtime.reload();
    return { name: staged.plan.name, version: staged.plan.version, sourceId: null };
  });
}
